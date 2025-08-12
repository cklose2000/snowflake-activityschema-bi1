/**
 * HTTP Wrapper for MCP Server with Real Snowflake
 * 
 * Provides HTTP endpoints connected to actual Snowflake database.
 * Used for real load testing and production-like performance validation.
 */

import express from 'express';
import { performance } from 'perf_hooks';
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.join(__dirname, '../../.env') });

import { loadConfig } from './config.js';
import { NDJSONQueue } from './queue/ndjson-queue.js';
import { ContextCache } from './cache/context-cache.js';
import { TicketManager } from './query/ticket-manager.js';
import { generateQueryTag } from './utils/query-tag.js';
import { SnowflakeClient } from './db/snowflake-client.js';
import { TEMPLATE_NAMES } from './sql/safe-templates.js';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

const logger = pino.default({
  name: 'http-wrapper-real',
  level: process.env.LOG_LEVEL || 'info',
});

// Initialize components
const config = loadConfig();
let snowflakeClient: SnowflakeClient;
let queue: NDJSONQueue;
let cache: ContextCache;
let ticketManager: TicketManager;

// Performance tracking
const metrics = {
  log_event: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
  get_context: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
  submit_query: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
  log_insight: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
};

// Initialize everything
async function initialize() {
  try {
    // Initialize queue
    queue = new NDJSONQueue(
      './data/events.ndjson',
      16 * 1024 * 1024,  // 16MB
      60000,             // 60s
      100000             // max events
    );
    await queue.initialize();
    logger.info('Queue initialized');
    
    // Initialize cache
    cache = new ContextCache(
      config.cache.maxSize,
      config.cache.ttl,
      config.redis.host ? {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        keyPrefix: config.redis.keyPrefix,
      } : undefined
    );
    logger.info('Cache initialized');
    
    // Initialize ticket manager
    ticketManager = new TicketManager();
    logger.info('Ticket manager initialized');
    
    // Initialize Snowflake client with connection pool
    snowflakeClient = new SnowflakeClient(config, 20); // 20 connections for better concurrency
    await snowflakeClient.initialize();
    logger.info('Snowflake client initialized');
    
    // Test Snowflake connection
    const health = await snowflakeClient.executeTemplate(
      TEMPLATE_NAMES.CHECK_HEALTH,
      [],
      { timeout: 5000 }
    );
    logger.info({ health }, 'Snowflake health check passed');
    
  } catch (error) {
    logger.error({ error }, 'Failed to initialize');
    throw error;
  }
}

// Helper to record metrics
function recordMetric(tool: string, startTime: number): void {
  const latency = performance.now() - startTime;
  const metric = metrics[tool as keyof typeof metrics];
  
  if (metric) {
    metric.count++;
    metric.totalMs += latency;
    metric.p95.push(latency);
    
    // Keep only last 1000 for p95 calculation
    if (metric.p95.length > 1000) {
      metric.p95.shift();
    }
    
    // Warn if exceeding targets
    if (tool === 'get_context' && latency > 25) {
      logger.warn({ tool, latency }, 'Exceeded p95 target of 25ms');
    } else if (tool === 'log_event' && latency > 10) {
      logger.warn({ tool, latency }, 'Exceeded target of 10ms');
    }
  }
}

// Health check endpoint
app.get('/health', async (_req, res) => {
  try {
    const sfHealth = await snowflakeClient.executeTemplate(
      TEMPLATE_NAMES.CHECK_HEALTH,
      [],
      { timeout: 1000 }
    );
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      snowflake: sfHealth.rows[0],
      connections: snowflakeClient.getStats(),
    });
  } catch (error: any) {
    res.status(503).json({ 
      status: 'unhealthy', 
      error: error.message 
    });
  }
});

// MCP tool endpoints
app.post('/tools/log_event', async (req, res) => {
  const start = performance.now();
  
  try {
    const { activity, feature_json, link } = req.body;
    
    // Generate IDs
    const activityId = uuidv4();
    const queryTag = generateQueryTag();
    const customerId = req.headers['x-customer-id'] as string || 'test_user';
    const sessionId = req.headers['x-session-id'] as string || 'test_session';
    
    // Write to Snowflake via template
    await snowflakeClient.executeTemplate(
      TEMPLATE_NAMES.LOG_EVENT,
      [
        activity.startsWith('cdesk.') ? activity : `cdesk.${activity}`,
        customerId,
        link || null,
        0, // revenue_impact
        feature_json || {},
        sessionId,
        queryTag,
      ],
      { timeout: 100 } // 100ms for log_event (fire-and-forget to queue)
    );
    
    // Also write to NDJSON queue for backup
    await queue.write({
      activity_id: activityId,
      activity: activity.startsWith('cdesk.') ? activity : `cdesk.${activity}`,
      customer: customerId,
      ts: new Date().toISOString(),
      feature_json: feature_json || {},
      query_tag: queryTag,
      session_id: sessionId,
      link,
    });
    
    recordMetric('log_event', start);
    
    res.json({ 
      success: true, 
      activity_id: activityId,
      query_tag: queryTag,
      latency_ms: (performance.now() - start).toFixed(2)
    });
  } catch (error: any) {
    metrics.log_event.errors++;
    logger.error({ error: error.message }, 'log_event error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/tools/get_context', async (req, res) => {
  const start = performance.now();
  
  try {
    const { customer_id } = req.body;
    
    // First try memory cache (sub-microsecond)
    let context = await cache.get(customer_id);
    
    // If miss, get from Snowflake (with strict 25ms timeout)
    if (!context) {
      const sfContext = await snowflakeClient.getContextFromCache(customer_id);
      if (sfContext) {
        context = {
          context: sfContext,
          updated_at: new Date().toISOString(),
        };
        // Warm cache for next time
        await cache.set(customer_id, context);
      }
    }
    
    recordMetric('get_context', start);
    
    res.json({
      context: context?.context || {},
      cached: context !== null,
      latency_ms: (performance.now() - start).toFixed(2)
    });
  } catch (error: any) {
    metrics.get_context.errors++;
    logger.error({ error: error.message }, 'get_context error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/tools/submit_query', async (req, res) => {
  const start = performance.now();
  
  try {
    const { template, params, byte_cap } = req.body;
    
    // Create ticket
    const ticket = ticketManager.createTicket({
      template,
      params,
      byte_cap,
    });
    
    // Execute async in background
    snowflakeClient.executeTemplate(
      template,
      params,
      { 
        timeout: 30000,
        queryTag: generateQueryTag(),
      }
    ).then(result => {
      ticketManager.updateStatus(ticket.id, 'completed', result);
    }).catch(error => {
      ticketManager.updateStatus(ticket.id, 'failed', { error: error.message });
    });
    
    recordMetric('submit_query', start);
    
    res.json({
      ticket_id: ticket.id,
      status: ticket.status,
      latency_ms: (performance.now() - start).toFixed(2)
    });
  } catch (error: any) {
    metrics.submit_query.errors++;
    logger.error({ error: error.message }, 'submit_query error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/tools/log_insight', async (req, res) => {
  const start = performance.now();
  
  try {
    const { subject, metric, value, provenance_query_hash } = req.body;
    const customerId = req.headers['x-customer-id'] as string || 'test_user';
    const atomId = uuidv4();
    
    // Write to Snowflake
    await snowflakeClient.executeTemplate(
      TEMPLATE_NAMES.LOG_INSIGHT,
      [
        atomId,
        customerId,
        subject,
        metric,
        value,
        provenance_query_hash || generateQueryTag().substring(6, 22), // 16 chars
      ],
      { timeout: 100 } // 100ms for log_insight
    );
    
    // Also log to queue
    await queue.write({
      activity: 'cdesk.insight_logged',
      customer: customerId,
      ts: new Date().toISOString(),
      feature_json: {
        atom_id: atomId,
        subject,
        metric,
        value,
        provenance_query_hash,
      },
      query_tag: generateQueryTag(),
    });
    
    recordMetric('log_insight', start);
    
    res.json({
      success: true,
      atom_id: atomId,
      latency_ms: (performance.now() - start).toFixed(2)
    });
  } catch (error: any) {
    metrics.log_insight.errors++;
    logger.error({ error: error.message }, 'log_insight error');
    res.status(500).json({ error: error.message });
  }
});

// Ticket status endpoint
app.get('/tickets/:id', (req, res) => {
  const ticket = ticketManager.getTicket(req.params.id);
  if (ticket) {
    res.json(ticket);
  } else {
    res.status(404).json({ error: 'Ticket not found' });
  }
});

// Metrics endpoint
app.get('/metrics', (_req, res) => {
  const calculateP95 = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, index)];
  };
  
  const calculateP50 = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.5);
    return sorted[index] || 0;
  };
  
  const result: any = {};
  
  for (const [tool, data] of Object.entries(metrics)) {
    result[tool] = {
      count: data.count,
      errors: data.errors,
      errorRate: data.count > 0 ? (data.errors / data.count * 100).toFixed(2) + '%' : '0%',
      avgLatency: data.count > 0 ? (data.totalMs / data.count).toFixed(2) : 0,
      p50: calculateP50(data.p95).toFixed(2),
      p95: calculateP95(data.p95).toFixed(2),
      meetsSLO: tool === 'get_context' ? calculateP95(data.p95) < 25 : 
                tool === 'log_event' ? calculateP95(data.p95) < 10 :
                tool === 'log_insight' ? calculateP95(data.p95) < 10 :
                tool === 'submit_query' ? calculateP95(data.p95) < 50 : true,
    };
  }
  
  result.snowflake = snowflakeClient.getStats();
  result.queue = queue.getStats();
  result.cache = cache.getStats();
  result.tickets = ticketManager.getStats();
  
  res.json(result);
});

const PORT = process.env.HTTP_PORT || 3000;

// Initialize and start server
initialize().then(() => {
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Real Snowflake HTTP wrapper started');
    console.log(`🚀 Real Snowflake HTTP wrapper listening on port ${PORT}`);
    console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
  });
}).catch(error => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  
  try {
    await queue.close();
    await cache.close();
    await snowflakeClient.close();
    
    // Log final metrics
    console.log('\n📊 Final metrics:');
    const calculateP95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)] || 0;
    };
    
    for (const [tool, data] of Object.entries(metrics)) {
      console.log(`  ${tool}:`);
      console.log(`    Count: ${data.count}`);
      console.log(`    Errors: ${data.errors}`);
      console.log(`    P95: ${calculateP95(data.p95).toFixed(2)}ms`);
    }
    
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
});

export default app;