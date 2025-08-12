#!/usr/bin/env node

/**
 * Load Testing Script for MCP Server
 * 
 * Tests the < 25ms p95 latency requirement under realistic load conditions.
 * Simulates 1000+ concurrent users making MCP tool calls.
 */

const autocannon = require('autocannon');
const http = require('http');
const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');

// Load test configuration
const CONFIG = {
  baseUrl: process.env.MCP_URL || 'http://localhost:3000',
  duration: parseInt(process.env.TEST_DURATION || '60'), // seconds
  connections: parseInt(process.env.CONCURRENT_USERS || '100'),
  pipelining: parseInt(process.env.PIPELINE_FACTOR || '10'),
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'), // ms
  
  // SLO targets
  slo: {
    p95Latency: 25, // ms
    p99Latency: 100, // ms
    errorRate: 0.01, // 1%
    minThroughput: 100, // requests/sec
  }
};

// Test scenarios for different MCP tools
const SCENARIOS = [
  {
    name: 'log_event',
    method: 'POST',
    path: '/tools/log_event',
    body: JSON.stringify({
      activity: 'cdesk.load_test',
      customer: 'test_user',
      feature_json: {
        test: true,
        timestamp: new Date().toISOString(),
        scenario: 'load_test',
      },
      query_tag: 'cdesk_load_001',
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    weight: 40, // 40% of traffic
  },
  {
    name: 'get_context',
    method: 'POST',
    path: '/tools/get_context',
    body: JSON.stringify({
      customer_id: 'test_user',
      max_bytes: 10000,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    weight: 40, // 40% of traffic - critical for p95 requirement
  },
  {
    name: 'submit_query',
    method: 'POST',
    path: '/tools/submit_query',
    body: JSON.stringify({
      template: 'GET_RECENT_ACTIVITIES',
      params: {
        customer: 'test_user',
        hours_back: 1,
        limit: 10,
      },
      byte_cap: 10000,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    weight: 15, // 15% of traffic
  },
  {
    name: 'log_insight',
    method: 'POST',
    path: '/tools/log_insight',
    body: JSON.stringify({
      subject: 'load_test',
      metric: 'response_time',
      value: 0,
      provenance_query_hash: 'abc123def456',
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    weight: 5, // 5% of traffic
  },
];

// Track detailed metrics
class MetricsCollector {
  constructor() {
    this.latencies = [];
    this.errors = [];
    this.throughput = [];
    this.scenarioMetrics = {};
    
    SCENARIOS.forEach(s => {
      this.scenarioMetrics[s.name] = {
        latencies: [],
        errors: 0,
        count: 0,
      };
    });
  }

  recordLatency(scenario, latency) {
    this.latencies.push(latency);
    this.scenarioMetrics[scenario].latencies.push(latency);
    this.scenarioMetrics[scenario].count++;
  }

  recordError(scenario, error) {
    this.errors.push({ scenario, error, timestamp: Date.now() });
    this.scenarioMetrics[scenario].errors++;
  }

  calculatePercentile(arr, percentile) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * percentile / 100) - 1;
    return sorted[Math.max(0, index)];
  }

  getSummary() {
    const summary = {
      overall: {
        totalRequests: this.latencies.length,
        totalErrors: this.errors.length,
        errorRate: this.errors.length / Math.max(1, this.latencies.length),
        p50: this.calculatePercentile(this.latencies, 50),
        p95: this.calculatePercentile(this.latencies, 95),
        p99: this.calculatePercentile(this.latencies, 99),
        min: Math.min(...this.latencies),
        max: Math.max(...this.latencies),
        mean: this.latencies.reduce((a, b) => a + b, 0) / Math.max(1, this.latencies.length),
      },
      byScenario: {},
    };

    for (const [name, metrics] of Object.entries(this.scenarioMetrics)) {
      if (metrics.count > 0) {
        summary.byScenario[name] = {
          count: metrics.count,
          errors: metrics.errors,
          errorRate: metrics.errors / metrics.count,
          p50: this.calculatePercentile(metrics.latencies, 50),
          p95: this.calculatePercentile(metrics.latencies, 95),
          p99: this.calculatePercentile(metrics.latencies, 99),
        };
      }
    }

    return summary;
  }
}

// Custom request generator for mixed scenarios
function setupRequests(client) {
  const metrics = new MetricsCollector();
  let requestCount = 0;

  client.on('response', (statusCode, resBytes, responseTime) => {
    const scenario = SCENARIOS[requestCount % SCENARIOS.length];
    
    if (statusCode >= 200 && statusCode < 300) {
      metrics.recordLatency(scenario.name, responseTime);
    } else {
      metrics.recordError(scenario.name, `HTTP ${statusCode}`);
    }
    
    requestCount++;
  });

  client.on('error', (err) => {
    const scenario = SCENARIOS[requestCount % SCENARIOS.length];
    metrics.recordError(scenario.name, err.message);
  });

  return metrics;
}

// Run load test
async function runLoadTest() {
  console.log('🚀 Starting Load Test');
  console.log('═══════════════════════════════════════');
  console.log(`Target: ${CONFIG.baseUrl}`);
  console.log(`Duration: ${CONFIG.duration}s`);
  console.log(`Concurrent Users: ${CONFIG.connections}`);
  console.log(`Pipeline Factor: ${CONFIG.pipelining}`);
  console.log('');

  // Check if server is running
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${CONFIG.baseUrl}/health`, { timeout: 2000 }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Server not responding'));
      });
    });
  } catch (error) {
    console.error('❌ MCP Server is not running!');
    console.error('Please start the server with: cd bi-mcp-server && npm run start:dev');
    process.exit(1);
  }

  const metrics = new MetricsCollector();

  // Create weighted scenario selector
  const selectScenario = () => {
    const rand = Math.random() * 100;
    let cumulative = 0;
    
    for (const scenario of SCENARIOS) {
      cumulative += scenario.weight;
      if (rand <= cumulative) {
        return scenario;
      }
    }
    
    return SCENARIOS[0]; // Fallback
  };

  // Run autocannon with custom requests
  const instance = autocannon({
    url: CONFIG.baseUrl,
    duration: CONFIG.duration,
    connections: CONFIG.connections,
    pipelining: CONFIG.pipelining,
    timeout: CONFIG.timeout,
    
    // Custom request generator
    requests: Array(1000).fill(null).map(() => {
      const scenario = selectScenario();
      return {
        method: scenario.method,
        path: scenario.path,
        body: scenario.body,
        headers: scenario.headers,
      };
    }),
    
    // Setup hooks
    setupClient: (client) => {
      client.on('response', (statusCode, resBytes, responseTime) => {
        const scenario = selectScenario();
        
        if (statusCode >= 200 && statusCode < 300) {
          metrics.recordLatency(scenario.name, responseTime);
        } else {
          metrics.recordError(scenario.name, `HTTP ${statusCode}`);
        }
      });

      client.on('error', (err) => {
        const scenario = selectScenario();
        metrics.recordError(scenario.name, err.message);
      });
    },
  });

  // Track progress
  autocannon.track(instance, {
    renderProgressBar: true,
    renderResultsTable: true,
  });

  return new Promise((resolve) => {
    instance.on('done', (results) => {
      const summary = metrics.getSummary();
      
      // Combine autocannon results with custom metrics
      const finalResults = {
        ...results,
        customMetrics: summary,
        timestamp: new Date().toISOString(),
        config: CONFIG,
      };
      
      resolve(finalResults);
    });
  });
}

// Analyze results against SLOs
function analyzeResults(results) {
  console.log('\n📊 Load Test Results');
  console.log('═══════════════════════════════════════');
  
  const { latency, requests, errors, throughput } = results;
  const custom = results.customMetrics;
  
  // Overall metrics
  console.log('\n📈 Overall Performance:');
  console.log(`  Total Requests: ${requests.total}`);
  console.log(`  Total Errors: ${errors}`);
  console.log(`  Error Rate: ${((errors / requests.total) * 100).toFixed(2)}%`);
  console.log(`  Throughput: ${throughput.mean.toFixed(0)} req/sec`);
  console.log('');
  
  console.log('⏱️  Latency Distribution:');
  console.log(`  P50: ${latency.p50.toFixed(2)}ms`);
  console.log(`  P75: ${latency.p75.toFixed(2)}ms`);
  console.log(`  P90: ${latency.p90.toFixed(2)}ms`);
  console.log(`  P95: ${latency.p95.toFixed(2)}ms`);
  console.log(`  P99: ${latency.p99.toFixed(2)}ms`);
  console.log(`  P99.9: ${latency.p999.toFixed(2)}ms`);
  console.log(`  Max: ${latency.max.toFixed(2)}ms`);
  console.log('');
  
  // Scenario breakdown
  if (custom && custom.byScenario) {
    console.log('🎯 Performance by Scenario:');
    for (const [name, metrics] of Object.entries(custom.byScenario)) {
      console.log(`  ${name}:`);
      console.log(`    Requests: ${metrics.count}`);
      console.log(`    P95: ${metrics.p95.toFixed(2)}ms`);
      console.log(`    Errors: ${metrics.errors} (${(metrics.errorRate * 100).toFixed(2)}%)`);
    }
    console.log('');
  }
  
  // SLO validation
  console.log('🎯 SLO Validation:');
  const sloResults = {
    p95Latency: latency.p95 <= CONFIG.slo.p95Latency,
    p99Latency: latency.p99 <= CONFIG.slo.p99Latency,
    errorRate: (errors / requests.total) <= CONFIG.slo.errorRate,
    throughput: throughput.mean >= CONFIG.slo.minThroughput,
  };
  
  console.log(`  P95 < ${CONFIG.slo.p95Latency}ms: ${sloResults.p95Latency ? '✅ PASS' : '❌ FAIL'} (${latency.p95.toFixed(2)}ms)`);
  console.log(`  P99 < ${CONFIG.slo.p99Latency}ms: ${sloResults.p99Latency ? '✅ PASS' : '❌ FAIL'} (${latency.p99.toFixed(2)}ms)`);
  console.log(`  Error Rate < ${CONFIG.slo.errorRate * 100}%: ${sloResults.errorRate ? '✅ PASS' : '❌ FAIL'} (${((errors / requests.total) * 100).toFixed(2)}%)`);
  console.log(`  Throughput > ${CONFIG.slo.minThroughput} req/s: ${sloResults.throughput ? '✅ PASS' : '❌ FAIL'} (${throughput.mean.toFixed(0)} req/s)`);
  
  // Overall verdict
  const allPassed = Object.values(sloResults).every(v => v);
  console.log('');
  console.log('═══════════════════════════════════════');
  if (allPassed) {
    console.log('✅ ALL SLOs PASSED - System ready for production load');
  } else {
    console.log('❌ SLO VIOLATIONS DETECTED - Performance optimization required');
  }
  
  // Save results to file
  const resultsDir = path.join(__dirname, '..', 'test-results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  
  const resultsFile = path.join(resultsDir, `load-test-${Date.now()}.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\n📁 Full results saved to: ${resultsFile}`);
  
  return allPassed;
}

// Main execution
async function main() {
  try {
    const results = await runLoadTest();
    const passed = analyzeResults(results);
    
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error('❌ Load test failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { runLoadTest, analyzeResults };