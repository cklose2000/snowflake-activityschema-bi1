#!/usr/bin/env node
/**
 * Component Validation Script
 * 
 * Validates core components work without external dependencies
 */

import { EventQueue } from './src/queue/event-queue.ts';
import { ContextCache } from './src/cache/context-cache.ts';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

console.log('🔍 Validating BI MCP Server Components...\n');

// Test configuration
const TEST_CONFIG = {
  tempDir: './test-validation',
  iterations: 100,
  targetLatency: 25, // ms
};

async function validateEventQueue() {
  console.log('📝 Testing EventQueue...');
  
  // Setup
  await fs.mkdir(TEST_CONFIG.tempDir, { recursive: true });
  
  const queue = new EventQueue({
    path: path.join(TEST_CONFIG.tempDir, 'test-events.ndjson'),
    maxSize: 1024 * 1024, // 1MB
    maxAge: 60000, // 1 minute
    maxEvents: 10000,
    enableDeduplication: true,
    syncWrites: false // Faster for testing
  });
  
  await queue.initialize();
  
  // Test event logging performance
  const latencies = [];
  
  for (let i = 0; i < TEST_CONFIG.iterations; i++) {
    const start = performance.now();
    
    await queue.push({
      activity: 'cdesk.test_event',
      customer: `test_customer_${i % 10}`,
      feature_json: {
        iteration: i,
        timestamp: new Date().toISOString()
      }
    });
    
    const latency = performance.now() - start;
    latencies.push(latency);
  }
  
  // Calculate statistics
  latencies.sort((a, b) => a - b);
  const stats = {
    min: latencies[0],
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p95: latencies[Math.floor(latencies.length * 0.95)],
    max: latencies[latencies.length - 1]
  };
  
  // Check health
  const health = queue.getHealthStatus();
  const queueStats = queue.getStats();
  
  console.log(`   ✓ Logged ${TEST_CONFIG.iterations} events`);
  console.log(`   ✓ Avg latency: ${stats.avg.toFixed(2)}ms`);
  console.log(`   ✓ P95 latency: ${stats.p95.toFixed(2)}ms`);
  console.log(`   ✓ Queue healthy: ${health.healthy}`);
  console.log(`   ✓ Total events: ${queueStats.totalEvents}`);
  
  // Cleanup
  await queue.close();
  
  return {
    component: 'EventQueue',
    passed: health.healthy && stats.p95 < 50, // Lenient for file I/O
    stats
  };
}

async function validateContextCache() {
  console.log('\n💾 Testing ContextCache...');
  
  const cache = new ContextCache(1000, 300000); // 1K entries, 5 min TTL
  
  // Test cache performance
  const latencies = [];
  
  // Populate cache
  for (let i = 0; i < 50; i++) {
    await cache.set(`test_customer_${i}`, {
      context: { id: `test_customer_${i}`, data: `test_data_${i}` },
      updated_at: new Date().toISOString()
    });
  }
  
  // Test cache hit performance
  for (let i = 0; i < TEST_CONFIG.iterations; i++) {
    const customerId = `test_customer_${i % 50}`;
    const start = performance.now();
    
    const result = await cache.get(customerId);
    
    const latency = performance.now() - start;
    latencies.push(latency);
    
    if (!result && i < 50) {
      throw new Error(`Cache miss for existing customer: ${customerId}`);
    }
  }
  
  // Calculate statistics
  latencies.sort((a, b) => a - b);
  const stats = {
    min: latencies[0],
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p95: latencies[Math.floor(latencies.length * 0.95)],
    max: latencies[latencies.length - 1]
  };
  
  const cacheStats = cache.getStats();
  
  console.log(`   ✓ Cache hits: ${TEST_CONFIG.iterations}`);
  console.log(`   ✓ Avg latency: ${stats.avg.toFixed(2)}ms`);
  console.log(`   ✓ P95 latency: ${stats.p95.toFixed(2)}ms`);
  console.log(`   ✓ Hit rate: ${cacheStats.hitRate.toFixed(1)}%`);
  console.log(`   ✓ Cache size: ${cacheStats.size}`);
  
  await cache.close();
  
  return {
    component: 'ContextCache',
    passed: stats.p95 < TEST_CONFIG.targetLatency,
    stats
  };
}

async function cleanup() {
  try {
    await fs.rm(TEST_CONFIG.tempDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
}

// Main execution
async function main() {
  const results = [];
  
  try {
    // Run validations
    results.push(await validateEventQueue());
    results.push(await validateContextCache());
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 VALIDATION SUMMARY');
    console.log('='.repeat(50));
    
    let allPassed = true;
    
    for (const result of results) {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} ${result.component}`);
      
      if (result.stats) {
        console.log(`     P95: ${result.stats.p95.toFixed(2)}ms`);
        console.log(`     Avg: ${result.stats.avg.toFixed(2)}ms`);
      }
      
      if (!result.passed) allPassed = false;
    }
    
    console.log('\n' + '='.repeat(50));
    console.log(`Overall Status: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
    console.log('='.repeat(50));
    
    // SLO Analysis
    console.log('\n🎯 SLO Analysis:');
    console.log(`Target: < ${TEST_CONFIG.targetLatency}ms P95 for cache operations`);
    
    const cacheResult = results.find(r => r.component === 'ContextCache');
    if (cacheResult && cacheResult.stats) {
      const met = cacheResult.stats.p95 < TEST_CONFIG.targetLatency;
      console.log(`ContextCache P95: ${cacheResult.stats.p95.toFixed(2)}ms ${met ? '✅' : '❌'}`);
    }
    
    console.log('\n💡 Next Steps:');
    if (allPassed) {
      console.log('✓ Core components validated successfully');
      console.log('✓ Ready for Snowflake integration testing');
      console.log('✓ Performance meets local SLO targets');
    } else {
      console.log('❌ Fix failing components before integration testing');
    }
    
    process.exit(allPassed ? 0 : 1);
    
  } finally {
    await cleanup();
  }
}

// Handle errors
process.on('uncaughtException', async (error) => {
  console.error('\n💥 Uncaught Exception:', error);
  await cleanup();
  process.exit(1);
});

process.on('unhandledRejection', async (error) => {
  console.error('\n💥 Unhandled Rejection:', error);
  await cleanup();
  process.exit(1);
});

main().catch(async (error) => {
  console.error('\n💥 Validation Error:', error);
  await cleanup();
  process.exit(1);
});