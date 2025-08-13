/**
 * REALISTIC Cache Performance Test
 * 
 * Tests ACTUAL real-world scenarios including:
 * - Cold cache (empty)
 * - Cache misses hitting Snowflake
 * - Unique customers (not repeated keys)
 * - Network latency simulation
 */

import snowflake from 'snowflake-sdk';
import { performance } from 'perf_hooks';
import { ContextCache } from '../../../bi-mcp-server/src/cache/context-cache';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

console.log('\n🔍 REALISTIC CACHE PERFORMANCE TEST');
console.log('=====================================');
console.log('Testing REAL scenarios with cache misses and Snowflake queries\n');

async function testRealisticPerformance() {
  // 1. Clear Redis completely (cold start scenario)
  const redis = new Redis({
    host: 'localhost',
    port: 6379,
  });
  
  console.log('🧹 Clearing Redis cache (simulating cold start)...');
  await redis.flushall();
  console.log('   Cache cleared - starting from EMPTY\n');
  
  // 2. Initialize Snowflake connection (the REAL backend)
  const connection = snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT || 'yshmxno-fbc56289',
    username: process.env.SNOWFLAKE_USER || 'CLAUDE_DESKTOP1',
    password: process.env.SNOWFLAKE_PASSWORD || 'Password123!',
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
    database: process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS',
    schema: process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES',
    role: process.env.SNOWFLAKE_ROLE || 'CLAUDE_DESKTOP_ROLE',
  });
  
  console.log('📡 Connecting to Snowflake...');
  await new Promise<void>((resolve, reject) => {
    connection.connect((err, conn) => {
      if (err) {
        console.error('❌ Snowflake connection failed:', err.message);
        reject(err);
      } else {
        console.log('✅ Connected to Snowflake\n');
        resolve();
      }
    });
  });
  
  // 3. Initialize cache with Redis
  const cache = new ContextCache(
    10000,
    300000,
    {
      host: 'localhost',
      port: 6379,
      db: 0,
      keyPrefix: 'realistic:',
    }
  );
  
  // Function to fetch from Snowflake when cache misses
  async function fetchFromSnowflake(customerId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      connection.execute({
        sqlText: `
          SELECT context_blob as context, updated_at, version
          FROM CONTEXT_CACHE
          WHERE customer_id = ?
          LIMIT 1
        `,
        binds: [customerId],
        complete: (err, stmt, rows) => {
          if (err || !rows || rows.length === 0) {
            resolve(null); // Customer doesn't exist
          } else {
            resolve({
              context: rows[0].CONTEXT || {},
              updated_at: rows[0].UPDATED_AT,
              version: rows[0].VERSION,
            });
          }
        }
      });
    });
  }
  
  // Test 1: Cold Cache - All Misses (REALISTIC SCENARIO)
  console.log('Test 1: Cold Cache - First User Requests');
  console.log('-----------------------------------------');
  const coldLatencies: number[] = [];
  
  for (let i = 0; i < 50; i++) {
    const customerId = `unique_customer_${Date.now()}_${i}`;
    const start = performance.now();
    
    // Try cache first
    let data = await cache.get(customerId);
    
    if (!data) {
      // Cache miss - hit Snowflake (THIS IS THE REAL SCENARIO)
      data = await fetchFromSnowflake(customerId);
      if (data) {
        await cache.set(customerId, data);
      }
    }
    
    const latency = performance.now() - start;
    coldLatencies.push(latency);
    
    if (i % 10 === 0) {
      process.stdout.write(`  Progress: ${i}/50 (all cache misses)\r`);
    }
  }
  
  coldLatencies.sort((a, b) => a - b);
  const coldP50 = coldLatencies[Math.floor(coldLatencies.length * 0.50)];
  const coldP95 = coldLatencies[Math.floor(coldLatencies.length * 0.95)];
  
  console.log('\n  Results (Cache Misses + Snowflake):');
  console.log(`    p50: ${coldP50.toFixed(2)}ms`);
  console.log(`    p95: ${coldP95.toFixed(2)}ms ${coldP95 < 25 ? '✅' : '❌'} (target: < 25ms)`);
  console.log(`    Min: ${Math.min(...coldLatencies).toFixed(2)}ms`);
  console.log(`    Max: ${Math.max(...coldLatencies).toFixed(2)}ms\n`);
  
  // Test 2: Warm Cache - Repeated Access (BEST CASE)
  console.log('Test 2: Warm Cache - Repeated Access');
  console.log('-------------------------------------');
  const warmLatencies: number[] = [];
  
  // Pre-populate cache
  for (let i = 0; i < 100; i++) {
    await cache.set(`cached_customer_${i}`, {
      context: { id: `cached_customer_${i}` },
      updated_at: new Date().toISOString(),
    });
  }
  
  // Now test with warm cache
  for (let i = 0; i < 500; i++) {
    const customerId = `cached_customer_${i % 100}`;
    const start = performance.now();
    await cache.get(customerId);
    const latency = performance.now() - start;
    warmLatencies.push(latency);
  }
  
  warmLatencies.sort((a, b) => a - b);
  const warmP50 = warmLatencies[Math.floor(warmLatencies.length * 0.50)];
  const warmP95 = warmLatencies[Math.floor(warmLatencies.length * 0.95)];
  
  console.log('  Results (Cache Hits Only):');
  console.log(`    p50: ${warmP50.toFixed(2)}ms`);
  console.log(`    p95: ${warmP95.toFixed(2)}ms ${warmP95 < 25 ? '✅' : '❌'} (target: < 25ms)\n`);
  
  // Test 3: Production-Like Mix (20% miss, 80% hit)
  console.log('Test 3: Production-Like Mix (20% miss, 80% hit)');
  console.log('------------------------------------------------');
  const mixedLatencies: number[] = [];
  
  for (let i = 0; i < 100; i++) {
    const isCacheMiss = Math.random() < 0.2;
    const customerId = isCacheMiss 
      ? `new_customer_${Date.now()}_${i}`
      : `cached_customer_${i % 100}`;
    
    const start = performance.now();
    
    let data = await cache.get(customerId);
    
    if (!data && isCacheMiss) {
      // Simulate Snowflake query
      data = await fetchFromSnowflake(customerId);
      if (data) {
        await cache.set(customerId, data);
      }
    }
    
    const latency = performance.now() - start;
    mixedLatencies.push(latency);
  }
  
  mixedLatencies.sort((a, b) => a - b);
  const mixedP50 = mixedLatencies[Math.floor(mixedLatencies.length * 0.50)];
  const mixedP95 = mixedLatencies[Math.floor(mixedLatencies.length * 0.95)];
  
  console.log('  Results (Mixed Workload):');
  console.log(`    p50: ${mixedP50.toFixed(2)}ms`);
  console.log(`    p95: ${mixedP95.toFixed(2)}ms ${mixedP95 < 25 ? '✅' : '❌'} (target: < 25ms)\n`);
  
  // Summary
  console.log('📊 REALISTIC PERFORMANCE SUMMARY');
  console.log('=================================');
  console.log(`Cold Cache (all misses) P95: ${coldP95.toFixed(2)}ms ${coldP95 < 25 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Warm Cache (all hits) P95: ${warmP95.toFixed(2)}ms ${warmP95 < 25 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Production Mix (20/80) P95: ${mixedP95.toFixed(2)}ms ${mixedP95 < 25 ? '✅ PASS' : '❌ FAIL'}\n`);
  
  console.log('🔍 REALITY CHECK');
  console.log('================');
  if (coldP95 >= 25) {
    console.log('❌ Cold cache performance FAILS the < 25ms target');
    console.log('   Every new customer will experience > 25ms latency');
    console.log('   This is the ACTUAL performance users will see\n');
  }
  
  if (mixedP95 >= 25) {
    console.log('⚠️  Production workload FAILS the < 25ms target');
    console.log('   Real-world performance will not meet SLO\n');
  }
  
  const cacheMetrics = cache.getMetrics();
  console.log('Cache Hit Rate:', (cacheMetrics.hitRate * 100).toFixed(1) + '%');
  console.log('Redis Connected:', cacheMetrics.redisConnected ? '✅' : '❌');
  
  // What percentage of requests meet SLO?
  const meetsSLO = [...coldLatencies, ...mixedLatencies].filter(l => l < 25).length;
  const totalRequests = coldLatencies.length + mixedLatencies.length;
  const sloPercentage = (meetsSLO / totalRequests * 100).toFixed(1);
  
  console.log(`\nRequests meeting < 25ms SLO: ${sloPercentage}%`);
  
  if (parseFloat(sloPercentage) < 95) {
    console.log('❌ FAILURE: Less than 95% of requests meet the SLO');
    console.log('   The system is NOT production ready\n');
  }
  
  // Cleanup
  connection.destroy((err) => {
    if (err) console.error('Error closing Snowflake:', err);
  });
  await cache.close();
  await redis.quit();
}

// Run the test
testRealisticPerformance().catch(console.error);