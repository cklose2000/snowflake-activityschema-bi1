#!/usr/bin/env node

/**
 * Performance Benchmark Script
 * Tests the latency improvements for get_context operations
 */

import { ContextCache } from '../dist/cache/context-cache.js';
import { performance } from 'perf_hooks';

console.log('🚀 Performance Benchmark for BI MCP Server');
console.log('==========================================\n');

// Test configuration
const ITERATIONS = 1000;
const USERS = ['test_user', 'user_1', 'user_2', 'user_3', 'user_4', 'user_5'];

// Initialize cache with production settings
const cache = new ContextCache(
  10000,  // 10K entries (increased from 1K)
  300000  // 5 minute TTL (increased from 1 minute)
);

// Warm up cache
console.log('📊 Warming up cache...');
const testData = {
  context: {
    user_id: 'test_user',
    preferences: { theme: 'dark', language: 'en' },
    recent_activities: ['view_dashboard', 'export_report', 'update_settings'],
    metadata: { created_at: new Date().toISOString() }
  },
  updated_at: new Date().toISOString()
};

// Pre-populate cache
for (const user of USERS) {
  await cache.set(user, {
    ...testData,
    context: { ...testData.context, user_id: user }
  });
}

// Test 1: Cache Hit Performance
console.log('\n📈 Test 1: Cache Hit Performance');
console.log('--------------------------------');

const hitLatencies = [];
for (let i = 0; i < ITERATIONS; i++) {
  const user = USERS[i % USERS.length];
  const start = performance.now();
  await cache.get(user);
  const latency = performance.now() - start;
  hitLatencies.push(latency);
}

// Calculate statistics
hitLatencies.sort((a, b) => a - b);
const p50Hit = hitLatencies[Math.floor(hitLatencies.length * 0.5)];
const p95Hit = hitLatencies[Math.floor(hitLatencies.length * 0.95)];
const p99Hit = hitLatencies[Math.floor(hitLatencies.length * 0.99)];
const avgHit = hitLatencies.reduce((a, b) => a + b, 0) / hitLatencies.length;

console.log(`✅ Cache Hits (${ITERATIONS} requests):`);
console.log(`   Average: ${avgHit.toFixed(3)}ms`);
console.log(`   P50: ${p50Hit.toFixed(3)}ms`);
console.log(`   P95: ${p95Hit.toFixed(3)}ms ${p95Hit < 25 ? '✅ MEETS SLO' : '❌ EXCEEDS SLO'}`);
console.log(`   P99: ${p99Hit.toFixed(3)}ms`);

// Test 2: Cache Miss Performance (Bloom Filter)
console.log('\n📈 Test 2: Cache Miss Performance (Bloom Filter)');
console.log('------------------------------------------------');

const missLatencies = [];
for (let i = 0; i < ITERATIONS; i++) {
  const nonExistentUser = `non_existent_user_${i}`;
  const start = performance.now();
  await cache.get(nonExistentUser);
  const latency = performance.now() - start;
  missLatencies.push(latency);
}

missLatencies.sort((a, b) => a - b);
const p50Miss = missLatencies[Math.floor(missLatencies.length * 0.5)];
const p95Miss = missLatencies[Math.floor(missLatencies.length * 0.95)];
const p99Miss = missLatencies[Math.floor(missLatencies.length * 0.99)];
const avgMiss = missLatencies.reduce((a, b) => a + b, 0) / missLatencies.length;

console.log(`❌ Cache Misses (${ITERATIONS} requests):`);
console.log(`   Average: ${avgMiss.toFixed(3)}ms`);
console.log(`   P50: ${p50Miss.toFixed(3)}ms`);
console.log(`   P95: ${p95Miss.toFixed(3)}ms ${p95Miss < 25 ? '✅ MEETS SLO' : '❌ EXCEEDS SLO'}`);
console.log(`   P99: ${p99Miss.toFixed(3)}ms`);

// Test 3: Access Pattern Tracking
console.log('\n📈 Test 3: Access Pattern Tracking');
console.log('-----------------------------------');

// Simulate realistic access pattern
const accessPattern = [
  'test_user', 'test_user', 'test_user',  // Hot user
  'user_1', 'user_1',  // Warm user
  'user_2',  // Cold user
  'test_user', 'test_user',  // Hot user again
];

for (let i = 0; i < 100; i++) {
  const user = accessPattern[i % accessPattern.length];
  await cache.get(user);
}

const hotUsers = cache.getMostAccessedUsers(3);
console.log(`🔥 Top 3 Most Accessed Users: ${hotUsers.join(', ')}`);

// Get final metrics
const metrics = cache.getMetrics();
console.log('\n📊 Final Cache Metrics');
console.log('----------------------');
console.log(`   Total Hits: ${metrics.hits}`);
console.log(`   Total Misses: ${metrics.misses}`);
console.log(`   Negative Hits (Bloom Filter): ${metrics.negativeHits}`);
console.log(`   Hit Rate: ${(metrics.hitRate * 100).toFixed(2)}%`);
console.log(`   Negative Hit Rate: ${(metrics.negativeHitRate * 100).toFixed(2)}%`);
console.log(`   Memory Cache Size: ${metrics.memoryCacheSize}`);

// Summary
console.log('\n🎯 Performance Summary');
console.log('======================');
console.log(`✅ Target P95 Latency: < 25ms`);
console.log(`📊 Achieved P95 (Cache Hit): ${p95Hit.toFixed(3)}ms ${p95Hit < 25 ? '✅' : '❌'}`);
console.log(`📊 Achieved P95 (Cache Miss): ${p95Miss.toFixed(3)}ms ${p95Miss < 25 ? '✅' : '❌'}`);

const overallSuccess = p95Hit < 25 && p95Miss < 25;
console.log(`\n${overallSuccess ? '🎉 SUCCESS: All latency targets met!' : '⚠️  WARNING: Some latency targets not met'}`);

// Recommendations
if (!overallSuccess) {
  console.log('\n💡 Recommendations:');
  if (p95Hit >= 25) {
    console.log('   - Consider using Redis with Unix socket connection');
    console.log('   - Increase memory cache size further');
    console.log('   - Profile code for bottlenecks');
  }
  if (p95Miss >= 25) {
    console.log('   - Implement more aggressive pre-warming');
    console.log('   - Consider using negative cache TTL');
    console.log('   - Check Snowflake connection latency');
  }
}

// Clean up
await cache.close();
console.log('\n✅ Benchmark complete');
process.exit(0);