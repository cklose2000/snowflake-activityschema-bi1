#!/usr/bin/env node

/**
 * Simple HTTP test server for load testing
 * Simulates MCP tool endpoints with controlled latency
 */

const express = require('express');
const { performance } = require('perf_hooks');

const app = express();
app.use(express.json());

// Simulate context cache
const contextCache = new Map();

// Performance tracking
const latencies = {
  log_event: [],
  get_context: [],
  submit_query: [],
  log_insight: [],
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// log_event - Target: < 10ms
app.post('/tools/log_event', async (req, res) => {
  const start = performance.now();
  
  // Simulate queue write (1-3ms)
  await new Promise(resolve => setTimeout(resolve, Math.random() * 2 + 1));
  
  const latency = performance.now() - start;
  latencies.log_event.push(latency);
  
  res.json({
    success: true,
    query_tag: `cdesk_${Math.random().toString(36).substring(2, 18)}`,
    latency_ms: latency.toFixed(2)
  });
});

// get_context - Target: < 25ms p95
app.post('/tools/get_context', async (req, res) => {
  const start = performance.now();
  const { customer_id } = req.body;
  
  // Simulate cache lookup (0.5-20ms, occasionally slow)
  const delay = Math.random() < 0.95 ? Math.random() * 10 : Math.random() * 30;
  await new Promise(resolve => setTimeout(resolve, delay));
  
  const context = contextCache.get(customer_id) || { initialized: Date.now() };
  contextCache.set(customer_id, context);
  
  const latency = performance.now() - start;
  latencies.get_context.push(latency);
  
  res.json({
    context,
    cached: true,
    latency_ms: latency.toFixed(2)
  });
});

// submit_query - Target: < 50ms
app.post('/tools/submit_query', async (req, res) => {
  const start = performance.now();
  
  // Simulate ticket generation (5-15ms)
  await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 5));
  
  const latency = performance.now() - start;
  latencies.submit_query.push(latency);
  
  res.json({
    ticket_id: `ticket_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    status: 'pending',
    latency_ms: latency.toFixed(2)
  });
});

// log_insight - Target: < 10ms
app.post('/tools/log_insight', async (req, res) => {
  const start = performance.now();
  
  // Simulate queue write (1-3ms)
  await new Promise(resolve => setTimeout(resolve, Math.random() * 2 + 1));
  
  const latency = performance.now() - start;
  latencies.log_insight.push(latency);
  
  res.json({
    success: true,
    latency_ms: latency.toFixed(2)
  });
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const calculateP95 = (arr) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, index)];
  };
  
  res.json({
    log_event: {
      count: latencies.log_event.length,
      p50: calculateP95(latencies.log_event) * 0.5,
      p95: calculateP95(latencies.log_event),
    },
    get_context: {
      count: latencies.get_context.length,
      p50: calculateP95(latencies.get_context) * 0.5,
      p95: calculateP95(latencies.get_context),
    },
    submit_query: {
      count: latencies.submit_query.length,
      p50: calculateP95(latencies.submit_query) * 0.5,
      p95: calculateP95(latencies.submit_query),
    },
    log_insight: {
      count: latencies.log_insight.length,
      p50: calculateP95(latencies.log_insight) * 0.5,
      p95: calculateP95(latencies.log_insight),
    },
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Test server listening on port ${PORT}`);
  console.log(`📊 Metrics available at http://localhost:${PORT}/metrics`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n📊 Final metrics:');
  
  const calculateStats = (arr, name) => {
    if (arr.length === 0) return;
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    
    console.log(`  ${name}:`);
    console.log(`    Count: ${arr.length}`);
    console.log(`    P50: ${p50.toFixed(2)}ms`);
    console.log(`    P95: ${p95.toFixed(2)}ms`);
    console.log(`    P99: ${p99.toFixed(2)}ms`);
  };
  
  calculateStats(latencies.log_event, 'log_event');
  calculateStats(latencies.get_context, 'get_context');
  calculateStats(latencies.submit_query, 'submit_query');
  calculateStats(latencies.log_insight, 'log_insight');
  
  process.exit(0);
});