#!/usr/bin/env ts-node
/**
 * Full Stack Performance Benchmark
 * 
 * Measures real-world performance with actual Snowflake database
 * Includes network round-trip time and realistic data volumes
 */

import { SnowflakeClient } from '../src/db/snowflake-client.js';
import { ContextCache } from '../src/cache/context-cache.js';
import { EventQueue } from '../src/queue/event-queue.js';
import { loadConfig } from '../src/config.js';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import fs from 'fs/promises';
import path from 'path';

const logger = pino({ 
  name: 'full-stack-benchmark',
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

// Benchmark configuration
const BENCHMARK_CONFIG = {
  warmupIterations: 50,
  testIterations: 1000,
  concurrentOps: 20,
  customerCount: 100,
  cacheSize: 10000,
  cacheTTL: 300000, // 5 minutes
  targetP95: 25, // ms
};

interface BenchmarkResult {
  scenario: string;
  iterations: number;
  duration: number;
  throughput: number;
  latencies: {
    min: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  cacheHitRate?: number;
  errors: number;
  passedSLO: boolean;
}

class FullStackBenchmark {
  private snowflakeClient!: SnowflakeClient;
  private contextCache!: ContextCache;
  private eventQueue!: EventQueue;
  private config: any;
  private results: BenchmarkResult[] = [];
  
  async initialize(): Promise<void> {
    logger.info('Initializing full-stack benchmark environment...');
    
    // Load configuration
    this.config = loadConfig();
    
    // Initialize Snowflake client
    this.snowflakeClient = new SnowflakeClient(this.config, 20);
    await this.snowflakeClient.initialize();
    
    // Initialize context cache
    this.contextCache = new ContextCache(
      BENCHMARK_CONFIG.cacheSize,
      BENCHMARK_CONFIG.cacheTTL
    );
    
    // Initialize event queue
    const tempDir = path.join(process.cwd(), 'benchmark-temp');
    await fs.mkdir(tempDir, { recursive: true });
    
    this.eventQueue = new EventQueue({
      path: path.join(tempDir, 'benchmark-events.ndjson'),
      maxSize: 16 * 1024 * 1024,
      maxAge: 60000,
      maxEvents: 100000
    });
    
    await this.eventQueue.initialize();
    
    logger.info('Environment initialized successfully');
  }
  
  async cleanup(): Promise<void> {
    logger.info('Cleaning up benchmark environment...');
    
    if (this.snowflakeClient) await this.snowflakeClient.close();
    if (this.contextCache) await this.contextCache.close();
    if (this.eventQueue) await this.eventQueue.close();
    
    // Clean up temp directory
    const tempDir = path.join(process.cwd(), 'benchmark-temp');
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  
  async warmup(): Promise<void> {
    logger.info(`Running warmup with ${BENCHMARK_CONFIG.warmupIterations} iterations...`);
    
    // Populate cache with test data
    for (let i = 0; i < BENCHMARK_CONFIG.customerCount; i++) {
      const customerId = `test_customer_${String(i).padStart(4, '0')}`;
      
      // Try to get from database first
      const context = await this.snowflakeClient.getContextFromCache(customerId);
      
      if (context) {
        // Store in memory cache
        await this.contextCache.set(customerId, {
          context: context,
          updated_at: new Date().toISOString()
        });
      }
    }
    
    // Run warmup queries
    for (let i = 0; i < BENCHMARK_CONFIG.warmupIterations; i++) {
      const customerId = `test_customer_${String(i % BENCHMARK_CONFIG.customerCount).padStart(4, '0')}`;
      await this.contextCache.get(customerId);
    }
    
    logger.info('Warmup complete');
  }
  
  async benchmarkCacheHits(): Promise<BenchmarkResult> {
    logger.info('\\nBenchmarking cache hits...');
    
    const latencies: number[] = [];
    let errors = 0;
    const startTime = performance.now();
    
    // Ensure cache is populated
    for (let i = 0; i < 20; i++) {
      const customerId = `test_customer_${String(i).padStart(4, '0')}`;
      await this.contextCache.set(customerId, {
        context: { id: customerId, test: true },
        updated_at: new Date().toISOString()
      });
    }
    
    // Measure cache hits
    for (let i = 0; i < BENCHMARK_CONFIG.testIterations; i++) {
      const customerId = `test_customer_${String(i % 20).padStart(4, '0')}`;
      const opStart = performance.now();
      
      try {
        const result = await this.contextCache.get(customerId);
        if (!result) errors++;
        
        const latency = performance.now() - opStart;
        latencies.push(latency);
      } catch (error) {
        errors++;
        logger.debug({ error }, 'Cache hit failed');
      }
    }
    
    const duration = performance.now() - startTime;
    
    return this.calculateResults('Cache Hits', latencies, duration, errors, 100);
  }
  
  async benchmarkCacheMisses(): Promise<BenchmarkResult> {
    logger.info('\\nBenchmarking cache misses (database queries)...');
    
    const latencies: number[] = [];
    let errors = 0;
    const startTime = performance.now();
    
    // Clear cache to force database queries
    await this.contextCache.clear();
    
    // Measure database queries
    for (let i = 0; i < Math.min(100, BENCHMARK_CONFIG.testIterations); i++) {
      const customerId = `test_customer_${String(i % BENCHMARK_CONFIG.customerCount).padStart(4, '0')}`;
      const opStart = performance.now();
      
      try {
        const result = await this.snowflakeClient.getContextFromCache(customerId);
        
        const latency = performance.now() - opStart;
        latencies.push(latency);
        
        if (!result) {
          // Not an error, just no data
          logger.debug({ customerId }, 'No context found');
        }
      } catch (error) {
        errors++;
        logger.debug({ error }, 'Database query failed');
      }
    }
    
    const duration = performance.now() - startTime;
    
    return this.calculateResults('Cache Misses (DB)', latencies, duration, errors, 0);
  }
  
  async benchmarkMixedLoad(): Promise<BenchmarkResult> {
    logger.info('\\nBenchmarking mixed load (80% cache, 20% database)...');
    
    const latencies: number[] = [];
    let errors = 0;
    let cacheHits = 0;
    const startTime = performance.now();
    
    // Pre-populate cache for 80% hit rate
    const cachedCount = Math.floor(BENCHMARK_CONFIG.customerCount * 0.8);
    for (let i = 0; i < cachedCount; i++) {
      const customerId = `test_customer_${String(i).padStart(4, '0')}`;
      await this.contextCache.set(customerId, {
        context: { id: customerId, cached: true },
        updated_at: new Date().toISOString()
      });
    }
    
    // Run mixed workload
    for (let i = 0; i < BENCHMARK_CONFIG.testIterations; i++) {
      const customerId = `test_customer_${String(i % BENCHMARK_CONFIG.customerCount).padStart(4, '0')}`;
      const opStart = performance.now();
      
      try {
        // Try cache first
        let result = await this.contextCache.get(customerId);
        
        if (result) {
          cacheHits++;
        } else {
          // Fallback to database
          result = await this.snowflakeClient.getContextFromCache(customerId);
        }
        
        const latency = performance.now() - opStart;
        latencies.push(latency);
      } catch (error) {
        errors++;
        logger.debug({ error }, 'Mixed load operation failed');
      }
    }
    
    const duration = performance.now() - startTime;
    const cacheHitRate = (cacheHits / BENCHMARK_CONFIG.testIterations) * 100;
    
    return this.calculateResults('Mixed Load (80/20)', latencies, duration, errors, cacheHitRate);
  }
  
  async benchmarkEventLogging(): Promise<BenchmarkResult> {
    logger.info('\\nBenchmarking event logging...');
    
    const latencies: number[] = [];
    let errors = 0;
    const startTime = performance.now();
    
    for (let i = 0; i < BENCHMARK_CONFIG.testIterations; i++) {
      const opStart = performance.now();
      
      try {
        await this.eventQueue.push({
          activity: 'cdesk.benchmark_test',
          customer: `test_customer_${i % 100}`,
          feature_json: {
            iteration: i,
            timestamp: new Date().toISOString()
          }
        });
        
        const latency = performance.now() - opStart;
        latencies.push(latency);
      } catch (error) {
        errors++;
        logger.debug({ error }, 'Event logging failed');
      }
    }
    
    const duration = performance.now() - startTime;
    
    return this.calculateResults('Event Logging', latencies, duration, errors);
  }
  
  async benchmarkConcurrentOperations(): Promise<BenchmarkResult> {
    logger.info('\\nBenchmarking concurrent operations...');
    
    const latencies: number[] = [];
    let errors = 0;
    const startTime = performance.now();
    
    // Process in batches for concurrency
    const batchSize = BENCHMARK_CONFIG.concurrentOps;
    const numBatches = Math.floor(BENCHMARK_CONFIG.testIterations / batchSize);
    
    for (let batch = 0; batch < numBatches; batch++) {
      const promises: Promise<number>[] = [];
      
      for (let i = 0; i < batchSize; i++) {
        const index = batch * batchSize + i;
        const customerId = `test_customer_${String(index % BENCHMARK_CONFIG.customerCount).padStart(4, '0')}`;
        
        promises.push(
          (async () => {
            const opStart = performance.now();
            
            try {
              // Mix of operations
              const op = index % 3;
              
              switch (op) {
                case 0:
                  await this.contextCache.get(customerId);
                  break;
                case 1:
                  await this.eventQueue.push({
                    activity: 'cdesk.concurrent_test',
                    customer: customerId,
                    feature_json: { index }
                  });
                  break;
                case 2:
                  await this.snowflakeClient.executeTemplate(
                    'CHECK_HEALTH',
                    [],
                    { timeout: 1000 }
                  );
                  break;
              }
              
              return performance.now() - opStart;
            } catch (error) {
              errors++;
              return -1;
            }
          })()
        );
      }
      
      const batchLatencies = await Promise.all(promises);
      latencies.push(...batchLatencies.filter(l => l > 0));
    }
    
    const duration = performance.now() - startTime;
    
    return this.calculateResults('Concurrent Ops', latencies, duration, errors);
  }
  
  async benchmarkRealUserSession(): Promise<BenchmarkResult> {
    logger.info('\\nBenchmarking realistic user session...');
    
    const latencies: number[] = [];
    let errors = 0;
    const startTime = performance.now();
    
    // Simulate 100 user sessions
    for (let session = 0; session < 100; session++) {
      const customerId = `test_customer_${String(session % BENCHMARK_CONFIG.customerCount).padStart(4, '0')}`;
      const sessionId = uuidv4();
      
      // Session flow
      const operations = [
        // 1. Session start
        async () => {
          const start = performance.now();
          await this.eventQueue.push({
            activity: 'cdesk.session_started',
            customer: customerId,
            feature_json: { session_id: sessionId }
          });
          return performance.now() - start;
        },
        
        // 2. Get context
        async () => {
          const start = performance.now();
          const cached = await this.contextCache.get(customerId);
          if (!cached) {
            await this.snowflakeClient.getContextFromCache(customerId);
          }
          return performance.now() - start;
        },
        
        // 3. User asks question
        async () => {
          const start = performance.now();
          await this.eventQueue.push({
            activity: 'cdesk.user_asked',
            customer: customerId,
            feature_json: { 
              question: 'What is my revenue?',
              session_id: sessionId 
            }
          });
          return performance.now() - start;
        },
        
        // 4. Execute query (simulated with health check)
        async () => {
          const start = performance.now();
          await this.snowflakeClient.executeTemplate(
            'CHECK_HEALTH',
            [],
            { timeout: 1000 }
          );
          return performance.now() - start;
        },
        
        // 5. Log insight
        async () => {
          const start = performance.now();
          await this.eventQueue.push({
            activity: 'cdesk.insight_recorded',
            customer: customerId,
            feature_json: {
              subject: 'revenue',
              metric: 'total',
              value: Math.random() * 10000
            }
          });
          return performance.now() - start;
        },
        
        // 6. Session end
        async () => {
          const start = performance.now();
          await this.eventQueue.push({
            activity: 'cdesk.session_ended',
            customer: customerId,
            feature_json: { session_id: sessionId }
          });
          return performance.now() - start;
        }
      ];
      
      // Execute session operations
      for (const op of operations) {
        try {
          const latency = await op();
          latencies.push(latency);
        } catch (error) {
          errors++;
          logger.debug({ error }, 'Session operation failed');
        }
      }
    }
    
    const duration = performance.now() - startTime;
    
    return this.calculateResults('Real User Session', latencies, duration, errors);
  }
  
  private calculateResults(
    scenario: string,
    latencies: number[],
    duration: number,
    errors: number,
    cacheHitRate?: number
  ): BenchmarkResult {
    latencies.sort((a, b) => a - b);
    
    const stats = {
      min: latencies[0] || 0,
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
      p50: latencies[Math.floor(latencies.length * 0.50)] || 0,
      p95: latencies[Math.floor(latencies.length * 0.95)] || 0,
      p99: latencies[Math.floor(latencies.length * 0.99)] || 0,
      max: latencies[latencies.length - 1] || 0
    };
    
    const throughput = latencies.length / (duration / 1000);
    const passedSLO = stats.p95 < (scenario.includes('Cache Hit') ? BENCHMARK_CONFIG.targetP95 : 1000);
    
    const result: BenchmarkResult = {
      scenario,
      iterations: latencies.length,
      duration,
      throughput,
      latencies: stats,
      cacheHitRate,
      errors,
      passedSLO
    };
    
    this.results.push(result);
    this.logResult(result);
    
    return result;
  }
  
  private logResult(result: BenchmarkResult): void {
    const status = result.passedSLO ? '✅ PASS' : '❌ FAIL';
    
    logger.info({
      scenario: result.scenario,
      status,
      throughput: `${result.throughput.toFixed(0)} ops/sec`,
      p95: `${result.latencies.p95.toFixed(2)}ms`,
      errors: result.errors,
      cacheHitRate: result.cacheHitRate ? `${result.cacheHitRate.toFixed(1)}%` : undefined
    }, 'Benchmark result');
  }
  
  private generateReport(): void {
    logger.info('\\n' + '='.repeat(80));
    logger.info('FULL STACK BENCHMARK REPORT');
    logger.info('='.repeat(80));
    
    logger.info('\\nSUMMARY:');
    logger.info('-'.repeat(80));
    
    for (const result of this.results) {
      const status = result.passedSLO ? '✅' : '❌';
      logger.info(
        `${status} ${result.scenario.padEnd(20)} | ` +
        `P95: ${result.latencies.p95.toFixed(2).padStart(8)}ms | ` +
        `Throughput: ${result.throughput.toFixed(0).padStart(6)} ops/s | ` +
        `Errors: ${result.errors}`
      );
    }
    
    logger.info('\\nDETAILED STATISTICS:');
    logger.info('-'.repeat(80));
    
    for (const result of this.results) {
      logger.info(`\\n${result.scenario}:`);
      logger.info(`  Iterations: ${result.iterations}`);
      logger.info(`  Duration: ${(result.duration / 1000).toFixed(1)}s`);
      logger.info(`  Latencies:`);
      logger.info(`    Min: ${result.latencies.min.toFixed(2)}ms`);
      logger.info(`    Avg: ${result.latencies.avg.toFixed(2)}ms`);
      logger.info(`    P50: ${result.latencies.p50.toFixed(2)}ms`);
      logger.info(`    P95: ${result.latencies.p95.toFixed(2)}ms`);
      logger.info(`    P99: ${result.latencies.p99.toFixed(2)}ms`);
      logger.info(`    Max: ${result.latencies.max.toFixed(2)}ms`);
      
      if (result.cacheHitRate !== undefined) {
        logger.info(`  Cache Hit Rate: ${result.cacheHitRate.toFixed(1)}%`);
      }
    }
    
    logger.info('\\nPERFORMANCE VALIDATION:');
    logger.info('-'.repeat(80));
    
    const cacheHitResult = this.results.find(r => r.scenario.includes('Cache Hit'));
    if (cacheHitResult) {
      if (cacheHitResult.latencies.p95 < BENCHMARK_CONFIG.targetP95) {
        logger.info(`✅ Cache hits meet P95 < ${BENCHMARK_CONFIG.targetP95}ms target (${cacheHitResult.latencies.p95.toFixed(2)}ms)`);
      } else {
        logger.error(`❌ Cache hits FAIL P95 < ${BENCHMARK_CONFIG.targetP95}ms target (${cacheHitResult.latencies.p95.toFixed(2)}ms)`);
      }
    }
    
    const mixedResult = this.results.find(r => r.scenario.includes('Mixed'));
    if (mixedResult && mixedResult.cacheHitRate) {
      if (mixedResult.cacheHitRate >= 75) {
        logger.info(`✅ Cache hit rate meets target (${mixedResult.cacheHitRate.toFixed(1)}%)`);
      } else {
        logger.warn(`⚠️  Cache hit rate below target (${mixedResult.cacheHitRate.toFixed(1)}% < 75%)`);
      }
    }
    
    logger.info('\\n' + '='.repeat(80));
  }
  
  async run(): Promise<void> {
    try {
      await this.initialize();
      await this.warmup();
      
      // Run all benchmark scenarios
      await this.benchmarkCacheHits();
      await this.benchmarkCacheMisses();
      await this.benchmarkMixedLoad();
      await this.benchmarkEventLogging();
      await this.benchmarkConcurrentOperations();
      await this.benchmarkRealUserSession();
      
      // Generate final report
      this.generateReport();
      
    } finally {
      await this.cleanup();
    }
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmark = new FullStackBenchmark();
  
  benchmark.run()
    .then(() => {
      logger.info('Benchmark complete');
      process.exit(0);
    })
    .catch(error => {
      logger.error({ error }, 'Benchmark failed');
      process.exit(1);
    });
}

export { FullStackBenchmark, BenchmarkResult };