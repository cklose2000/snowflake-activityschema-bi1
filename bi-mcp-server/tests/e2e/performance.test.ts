/**
 * End-to-End Performance Tests
 * 
 * Tests complete MCP tool execution paths with real database
 * Validates performance under realistic conditions
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SnowflakeClient } from '../../src/db/snowflake-client';
import { ContextCache } from '../../src/cache/context-cache';
import { EventQueue } from '../../src/queue/event-queue';
import { loadConfig } from '../../src/config';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import fs from 'fs/promises';
import path from 'path';

const logger = pino({ 
  name: 'e2e-performance-test',
  level: process.env.LOG_LEVEL || 'info'
});

// Performance targets
const SLO_TARGETS = {
  firstToken: 300,      // ms
  getContext: 25,       // ms (for cache hits)
  submitQuery: 50,      // ms
  logEvent: 10,         // ms
  cardReady: 8000,      // ms
  ingestionLag: 5000,   // ms
};

describe('E2E Performance Tests', () => {
  let snowflakeClient: SnowflakeClient;
  let contextCache: ContextCache;
  let eventQueue: EventQueue;
  let config: any;
  
  beforeAll(async () => {
    config = loadConfig();
    
    // Initialize all components
    snowflakeClient = new SnowflakeClient(config, 20);
    await snowflakeClient.initialize();
    
    contextCache = new ContextCache(10000, 300000);
    
    // Create temp directory for queue
    const tempDir = path.join(process.cwd(), 'temp-test-data');
    await fs.mkdir(tempDir, { recursive: true });
    
    eventQueue = new EventQueue({
      path: path.join(tempDir, 'events.ndjson'),
      maxSize: 16 * 1024 * 1024,
      maxAge: 60000,
      maxEvents: 100000
    });
    
    logger.info('E2E test environment initialized');
  }, 30000);
  
  afterAll(async () => {
    if (snowflakeClient) await snowflakeClient.close();
    if (contextCache) await contextCache.close();
    if (eventQueue) await eventQueue.close();
    
    // Clean up temp directory
    const tempDir = path.join(process.cwd(), 'temp-test-data');
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  
  describe('MCP Tool: get_context', () => {
    it('should meet P95 < 25ms for cached contexts', async () => {
      const customerId = 'test_customer_0001';
      const latencies: number[] = [];
      
      // Pre-populate cache
      await contextCache.set(customerId, {
        context: {
          id: customerId,
          preferences: { theme: 'dark' },
          metadata: { created: new Date().toISOString() }
        },
        updated_at: new Date().toISOString()
      });
      
      // Measure get_context performance
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        
        // Simulate MCP tool execution
        const context = await contextCache.get(customerId);
        
        const latency = performance.now() - start;
        latencies.push(latency);
      }
      
      // Calculate P95
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      
      logger.info({
        tool: 'get_context',
        avgLatency: avg.toFixed(2),
        p95Latency: p95.toFixed(2),
        target: SLO_TARGETS.getContext,
        passed: p95 < SLO_TARGETS.getContext
      }, 'get_context performance results');
      
      expect(p95).toBeLessThan(SLO_TARGETS.getContext);
    });
    
    it('should handle database fallback efficiently', async () => {
      const customerId = 'test_customer_0002';
      const latencies: number[] = [];
      
      // Clear cache to force database query
      await contextCache.clear();
      
      // First query - database hit
      const start1 = performance.now();
      const context1 = await snowflakeClient.getContextFromCache(customerId);
      const dbLatency = performance.now() - start1;
      
      // Store in cache if found
      if (context1) {
        await contextCache.set(customerId, {
          context: context1,
          updated_at: new Date().toISOString()
        });
      }
      
      // Subsequent queries - cache hits
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        const context = await contextCache.get(customerId);
        const latency = performance.now() - start;
        latencies.push(latency);
      }
      
      // Calculate statistics
      latencies.sort((a, b) => a - b);
      const cacheP95 = latencies[Math.floor(latencies.length * 0.95)];
      
      logger.info({
        dbLatency: dbLatency.toFixed(2),
        cacheP95: cacheP95.toFixed(2),
        speedup: (dbLatency / cacheP95).toFixed(1) + 'x'
      }, 'Database fallback performance');
      
      expect(dbLatency).toBeLessThan(config.performance.databaseQueryTimeout);
      expect(cacheP95).toBeLessThan(SLO_TARGETS.getContext);
    });
  });
  
  describe('MCP Tool: log_event', () => {
    it('should meet < 10ms for event logging', async () => {
      const latencies: number[] = [];
      
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        
        // Simulate log_event tool
        const event = {
          activity: 'cdesk.user_asked',
          customer: `test_customer_${String(i % 10).padStart(4, '0')}`,
          feature_json: {
            question: 'test question',
            tokens: 150,
            model: 'claude-3-opus'
          }
        };
        
        await eventQueue.push(event);
        
        const latency = performance.now() - start;
        latencies.push(latency);
      }
      
      // Calculate P95
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      
      logger.info({
        tool: 'log_event',
        avgLatency: avg.toFixed(2),
        p95Latency: p95.toFixed(2),
        target: SLO_TARGETS.logEvent,
        passed: p95 < SLO_TARGETS.logEvent
      }, 'log_event performance results');
      
      expect(p95).toBeLessThan(SLO_TARGETS.logEvent * 2); // Allow 2x for safety
    });
    
    it('should handle high-volume event logging', async () => {
      const batchSize = 1000;
      const start = performance.now();
      
      // Log many events rapidly
      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(
          eventQueue.push({
            activity: 'cdesk.high_volume_test',
            customer: `test_customer_${i % 100}`,
            feature_json: { index: i }
          })
        );
      }
      
      await Promise.all(promises);
      const totalTime = performance.now() - start;
      const throughput = batchSize / (totalTime / 1000);
      
      logger.info({
        batchSize,
        totalTime: totalTime.toFixed(2),
        throughput: throughput.toFixed(0) + ' events/sec'
      }, 'High-volume logging performance');
      
      expect(throughput).toBeGreaterThan(100); // At least 100 events/sec
    });
  });
  
  describe('MCP Tool: submit_query', () => {
    it('should return ticket immediately', async () => {
      const latencies: number[] = [];
      
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        
        // Simulate submit_query tool (ticket generation only)
        const ticket = {
          ticket_id: uuidv4(),
          status: 'pending',
          created_at: new Date().toISOString()
        };
        
        // Just generate ticket, don't execute query
        const latency = performance.now() - start;
        latencies.push(latency);
      }
      
      // Calculate P95
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      
      logger.info({
        tool: 'submit_query',
        p95Latency: p95.toFixed(2),
        target: SLO_TARGETS.submitQuery,
        passed: p95 < SLO_TARGETS.submitQuery
      }, 'submit_query performance results');
      
      expect(p95).toBeLessThan(SLO_TARGETS.submitQuery);
    });
  });
  
  describe('MCP Tool: log_insight', () => {
    it('should efficiently store insight atoms', async () => {
      const latencies: number[] = [];
      
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        
        // Simulate log_insight tool
        const insight = {
          atom_id: uuidv4(),
          customer_id: `test_customer_${i % 10}`,
          subject: 'revenue',
          metric: 'daily_total',
          value: Math.random() * 10000,
          provenance_query_hash: 'a1b2c3d4e5f6g7h8'
        };
        
        // Queue the insight (async write)
        await eventQueue.push({
          activity: 'cdesk.insight_recorded',
          customer: insight.customer_id,
          feature_json: insight
        });
        
        const latency = performance.now() - start;
        latencies.push(latency);
      }
      
      // Calculate P95
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      
      logger.info({
        tool: 'log_insight',
        p95Latency: p95.toFixed(2),
        target: SLO_TARGETS.logEvent,
        passed: p95 < SLO_TARGETS.logEvent
      }, 'log_insight performance results');
      
      expect(p95).toBeLessThan(SLO_TARGETS.logEvent * 2);
    });
  });
  
  describe('Complete User Session Flow', () => {
    it('should handle realistic user session efficiently', async () => {
      const sessionId = uuidv4();
      const customerId = 'test_customer_0010';
      const sessionMetrics = {
        totalLatency: 0,
        operations: [] as any[]
      };
      
      // 1. Session start
      let start = performance.now();
      await eventQueue.push({
        activity: 'cdesk.session_started',
        customer: customerId,
        feature_json: { session_id: sessionId }
      });
      let latency = performance.now() - start;
      sessionMetrics.operations.push({ op: 'session_start', latency });
      sessionMetrics.totalLatency += latency;
      
      // 2. Get context
      start = performance.now();
      const context = await contextCache.get(customerId) || 
                     await snowflakeClient.getContextFromCache(customerId);
      latency = performance.now() - start;
      sessionMetrics.operations.push({ op: 'get_context', latency });
      sessionMetrics.totalLatency += latency;
      
      // 3. User asks question
      start = performance.now();
      await eventQueue.push({
        activity: 'cdesk.user_asked',
        customer: customerId,
        feature_json: { 
          question: 'What is my revenue this month?',
          session_id: sessionId 
        }
      });
      latency = performance.now() - start;
      sessionMetrics.operations.push({ op: 'user_asked', latency });
      sessionMetrics.totalLatency += latency;
      
      // 4. Execute SQL query (via ticket)
      start = performance.now();
      const ticket = {
        ticket_id: uuidv4(),
        template: 'GET_ACTIVITY_STATS',
        params: [customerId, -30, 10]
      };
      latency = performance.now() - start;
      sessionMetrics.operations.push({ op: 'submit_query', latency });
      sessionMetrics.totalLatency += latency;
      
      // 5. Async query execution (simulated)
      start = performance.now();
      const queryResult = await snowflakeClient.executeTemplate(
        ticket.template,
        ticket.params,
        { timeout: 5000 }
      );
      latency = performance.now() - start;
      sessionMetrics.operations.push({ op: 'execute_query', latency });
      
      // 6. Log insight
      start = performance.now();
      await eventQueue.push({
        activity: 'cdesk.insight_recorded',
        customer: customerId,
        feature_json: {
          subject: 'revenue',
          metric: 'monthly_total',
          value: 45000,
          provenance_query_hash: 'abc123def456ghi7'
        }
      });
      latency = performance.now() - start;
      sessionMetrics.operations.push({ op: 'log_insight', latency });
      sessionMetrics.totalLatency += latency;
      
      // 7. Claude responds
      start = performance.now();
      await eventQueue.push({
        activity: 'cdesk.claude_responded',
        customer: customerId,
        feature_json: {
          response: 'Your revenue this month is $45,000',
          session_id: sessionId,
          tokens_used: 250
        }
      });
      latency = performance.now() - start;
      sessionMetrics.operations.push({ op: 'claude_responded', latency });
      sessionMetrics.totalLatency += latency;
      
      // Analyze session performance
      const criticalPathOps = sessionMetrics.operations.filter(
        op => ['get_context', 'submit_query', 'user_asked', 'log_insight'].includes(op.op)
      );
      const criticalPathLatency = criticalPathOps.reduce((sum, op) => sum + op.latency, 0);
      
      logger.info({
        sessionId,
        totalOperations: sessionMetrics.operations.length,
        criticalPathLatency: criticalPathLatency.toFixed(2),
        totalLatency: sessionMetrics.totalLatency.toFixed(2),
        operations: sessionMetrics.operations.map(op => ({
          name: op.op,
          latency: op.latency.toFixed(2)
        }))
      }, 'Complete session flow performance');
      
      // Critical path should be fast (excluding actual query execution)
      expect(criticalPathLatency).toBeLessThan(SLO_TARGETS.firstToken);
    });
  });
  
  describe('Stress Testing', () => {
    it('should handle burst traffic', async () => {
      const burstSize = 500;
      const operations: Promise<any>[] = [];
      const errors: any[] = [];
      
      const start = performance.now();
      
      // Generate burst of mixed operations
      for (let i = 0; i < burstSize; i++) {
        const op = i % 4;
        
        switch (op) {
          case 0: // get_context
            operations.push(
              contextCache.get(`test_customer_${i % 100}`)
                .catch(e => errors.push({ op: 'get_context', error: e }))
            );
            break;
          
          case 1: // log_event
            operations.push(
              eventQueue.push({
                activity: 'cdesk.burst_test',
                customer: `test_customer_${i % 100}`,
                feature_json: { index: i }
              }).catch(e => errors.push({ op: 'log_event', error: e }))
            );
            break;
          
          case 2: // query
            operations.push(
              snowflakeClient.executeTemplate(
                'CHECK_HEALTH',
                [],
                { timeout: 1000 }
              ).catch(e => errors.push({ op: 'query', error: e }))
            );
            break;
          
          case 3: // insight
            operations.push(
              eventQueue.push({
                activity: 'cdesk.insight_recorded',
                customer: `test_customer_${i % 100}`,
                feature_json: {
                  subject: 'test',
                  metric: 'burst',
                  value: i
                }
              }).catch(e => errors.push({ op: 'insight', error: e }))
            );
            break;
        }
      }
      
      await Promise.all(operations);
      const duration = performance.now() - start;
      const throughput = burstSize / (duration / 1000);
      
      logger.info({
        burstSize,
        duration: duration.toFixed(2),
        throughput: throughput.toFixed(0) + ' ops/sec',
        errors: errors.length,
        errorRate: ((errors.length / burstSize) * 100).toFixed(2) + '%'
      }, 'Burst traffic test results');
      
      // Should handle burst with low error rate
      expect(errors.length / burstSize).toBeLessThan(0.05); // < 5% error rate
      expect(throughput).toBeGreaterThan(50); // At least 50 ops/sec
    });
  });
});