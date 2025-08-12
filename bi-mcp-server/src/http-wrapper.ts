/**
 * HTTP Wrapper for MCP Server
 * 
 * Provides HTTP endpoints for load testing the MCP tools.
 * This is for testing only - production uses StdioServerTransport.
 */

import express from 'express';
import { performance } from 'perf_hooks';
import { loadConfig } from './config.js';
import { NDJSONQueue } from './queue/ndjson-queue.js';
import { ContextCache } from './cache/context-cache.js';
import { TicketManager } from './query/ticket-manager.js';
import { generateQueryTag } from './utils/query-tag.js';
import pino from 'pino';

const app = express();
app.use(express.json());

const logger = pino.default({
  name: 'http-wrapper',
  level: process.env.LOG_LEVEL || 'info',
});

// Initialize components
const config = loadConfig();
const queue = new NDJSONQueue(
  './data/events.ndjson',
  16 * 1024 * 1024,  // 16MB
  60000,             // 60s
  100000             // max events
);
const cache = new ContextCache(
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
const ticketManager = new TicketManager();

// Initialize queue
queue.initialize().catch(err => {
  logger.error({ err }, 'Failed to initialize queue');
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// MCP tool endpoints
app.post('/tools/log_event', async (req, res) => {
  const start = performance.now();
  
  try {
    const { activity, feature_json, link } = req.body;
    
    // Fire-and-forget to queue
    const queryTag = generateQueryTag();
    await queue.write({
      activity: activity.startsWith('cdesk.') ? activity : `cdesk.${activity}`,
      customer: 'test_user',
      ts: new Date().toISOString(),
      feature_json: feature_json || {},
      query_tag: queryTag,
      session_id: (req.headers['x-session-id'] as string) || 'test_session',
      link,
    });
    
    const latency = performance.now() - start;
    res.json({ 
      success: true, 
      query_tag: queryTag,
      latency_ms: latency.toFixed(2)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tools/get_context', async (req, res) => {
  const start = performance.now();
  
  try {
    const { customer_id } = req.body;
    
    // Get from cache
    const context = await cache.get(customer_id);
    
    const latency = performance.now() - start;
    
    // Ensure we meet < 25ms p95
    if (latency > 25) {
      logger.warn({ latency, customer_id }, 'Context retrieval exceeded 25ms');
    }
    
    res.json({
      context: context || {},
      cached: context !== null,
      latency_ms: latency.toFixed(2)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tools/submit_query', async (req, res) => {
  const start = performance.now();
  
  try {
    const { template, params, byte_cap } = req.body;
    
    // Generate ticket
    const ticket = ticketManager.createTicket({
      template,
      params,
      byte_cap,
    });
    
    // Simulate async execution
    setTimeout(() => {
      ticketManager.updateStatus(ticket.id, 'completed', {
        rows: [],
        rowCount: 0,
      });
    }, Math.random() * 1000);
    
    const latency = performance.now() - start;
    res.json({
      ticket_id: ticket.id,
      status: ticket.status,
      latency_ms: latency.toFixed(2)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tools/log_insight', async (req, res) => {
  const start = performance.now();
  
  try {
    const { subject, metric, value, provenance_query_hash } = req.body;
    
    // Log to queue
    await queue.write({
      activity: 'cdesk.insight_logged',
      customer: 'test_user',
      ts: new Date().toISOString(),
      feature_json: {
        subject,
        metric,
        value,
        provenance_query_hash,
      },
      query_tag: generateQueryTag(),
    });
    
    const latency = performance.now() - start;
    res.json({
      success: true,
      latency_ms: latency.toFixed(2)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Metrics endpoint
app.get('/metrics', (_req, res) => {
  res.json({
    queue: queue.getStats(),
    cache: cache.getStats(),
    tickets: ticketManager.getStats(),
  });
});

const PORT = process.env.HTTP_PORT || 3000;

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'HTTP wrapper started');
  console.log(`🚀 HTTP wrapper listening on port ${PORT}`);
});

export default app;