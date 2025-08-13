/**
 * SIMULATED Realistic Performance Test
 * 
 * Simulates real-world cache + Snowflake scenarios
 * with accurate latency modeling
 */

import { performance } from 'perf_hooks';
import { ContextCache } from '../../../bi-mcp-server/src/cache/context-cache';
import Redis from 'ioredis';

console.log('\n🔍 SIMULATED REALISTIC PERFORMANCE TEST');
console.log('========================================');
console.log('Simulating cache misses with 120ms Snowflake latency\n');

// Simulate Snowflake query latency (based on our measured 120ms P95)
async function simulateSnowflakeQuery(): Promise<void> {
  // Add realistic variance: 80-150ms range
  const latency = 80 + Math.random() * 70;
  await new Promise(resolve => setTimeout(resolve, latency));
}

async function runTest() {
  // Clear Redis
  const redis = new Redis({ host: 'localhost', port: 6379 });
  await redis.flushall();
  console.log('✅ Redis cache cleared (cold start)\n');
  
  // Initialize cache
  const cache = new ContextCache(10000, 300000, {
    host: 'localhost',
    port: 6379,
    db: 0,
    keyPrefix: 'sim:',
  });
  
  // Test 1: Cold Cache - All Cache Misses
  console.log('Test 1: Cold Cache (100% cache misses)');
  console.log('---------------------------------------');
  const coldLatencies: number[] = [];
  
  for (let i = 0; i < 100; i++) {
    const customerId = `customer_${Date.now()}_${i}`;
    const start = performance.now();
    
    // Try cache
    let data = await cache.get(customerId);
    
    if (!data) {
      // Cache miss - simulate Snowflake query
      await simulateSnowflakeQuery();
      
      // Store in cache for next time
      await cache.set(customerId, {
        context: { id: customerId, data: 'from_snowflake' },
        updated_at: new Date().toISOString(),
      });
    }
    
    const latency = performance.now() - start;
    coldLatencies.push(latency);
    
    if (i % 20 === 0) {
      process.stdout.write(`  Progress: ${i}/100\r`);
    }
  }
  
  coldLatencies.sort((a, b) => a - b);
  console.log('\n  Results:');
  console.log(`    p50: ${coldLatencies[50].toFixed(2)}ms`);
  console.log(`    p95: ${coldLatencies[95].toFixed(2)}ms ${coldLatencies[95] < 25 ? '✅' : '❌'} (target: < 25ms)`);
  console.log(`    Min: ${coldLatencies[0].toFixed(2)}ms`);
  console.log(`    Max: ${coldLatencies[99].toFixed(2)}ms\n`);
  
  // Test 2: Warm Cache (100% cache hits)
  console.log('Test 2: Warm Cache (100% cache hits)');
  console.log('-------------------------------------');
  const warmLatencies: number[] = [];
  
  // Pre-populate cache
  for (let i = 0; i < 100; i++) {
    await cache.set(`warm_${i}`, {
      context: { id: `warm_${i}` },
      updated_at: new Date().toISOString(),
    });
  }
  
  for (let i = 0; i < 100; i++) {
    const customerId = `warm_${i}`;
    const start = performance.now();
    await cache.get(customerId);
    const latency = performance.now() - start;
    warmLatencies.push(latency);
  }
  
  warmLatencies.sort((a, b) => a - b);
  console.log('  Results:');
  console.log(`    p50: ${warmLatencies[50].toFixed(2)}ms`);
  console.log(`    p95: ${warmLatencies[95].toFixed(2)}ms ${warmLatencies[95] < 25 ? '✅' : '❌'} (target: < 25ms)\n`);
  
  // Test 3: Realistic Mix (20% miss, 80% hit)
  console.log('Test 3: Realistic Mix (20% miss, 80% hit)');
  console.log('------------------------------------------');
  const mixedLatencies: number[] = [];
  
  // Pre-populate some cache entries
  for (let i = 0; i < 80; i++) {
    await cache.set(`mixed_${i}`, {
      context: { id: `mixed_${i}` },
      updated_at: new Date().toISOString(),
    });
  }
  
  for (let i = 0; i < 100; i++) {
    const isMiss = Math.random() < 0.2;
    const customerId = isMiss ? `new_${Date.now()}_${i}` : `mixed_${i % 80}`;
    
    const start = performance.now();
    
    let data = await cache.get(customerId);
    
    if (!data && isMiss) {
      // Simulate Snowflake query
      await simulateSnowflakeQuery();
      await cache.set(customerId, {
        context: { id: customerId },
        updated_at: new Date().toISOString(),
      });
    }
    
    const latency = performance.now() - start;
    mixedLatencies.push(latency);
  }
  
  mixedLatencies.sort((a, b) => a - b);
  console.log('  Results:');
  console.log(`    p50: ${mixedLatencies[50].toFixed(2)}ms`);
  console.log(`    p95: ${mixedLatencies[95].toFixed(2)}ms ${mixedLatencies[95] < 25 ? '✅' : '❌'} (target: < 25ms)\n`);
  
  // Test 4: Burst Traffic (sudden influx of new users)
  console.log('Test 4: Burst Traffic (100 new users simultaneously)');
  console.log('-----------------------------------------------------');
  const burstLatencies: number[] = [];
  
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push((async () => {
      const customerId = `burst_${Date.now()}_${i}`;
      const start = performance.now();
      
      let data = await cache.get(customerId);
      if (!data) {
        await simulateSnowflakeQuery();
        await cache.set(customerId, {
          context: { id: customerId },
          updated_at: new Date().toISOString(),
        });
      }
      
      return performance.now() - start;
    })());
  }
  
  const results = await Promise.all(promises);
  burstLatencies.push(...results);
  burstLatencies.sort((a, b) => a - b);
  
  console.log('  Results:');
  console.log(`    p50: ${burstLatencies[50].toFixed(2)}ms`);
  console.log(`    p95: ${burstLatencies[95].toFixed(2)}ms ${burstLatencies[95] < 25 ? '✅' : '❌'} (target: < 25ms)\n`);
  
  // SUMMARY
  console.log('📊 PERFORMANCE REALITY CHECK');
  console.log('============================');
  console.log(`Cold Cache P95: ${coldLatencies[95].toFixed(2)}ms ${coldLatencies[95] < 25 ? '✅' : '❌'}`);
  console.log(`Warm Cache P95: ${warmLatencies[95].toFixed(2)}ms ${warmLatencies[95] < 25 ? '✅' : '❌'}`);
  console.log(`Mixed Load P95: ${mixedLatencies[95].toFixed(2)}ms ${mixedLatencies[95] < 25 ? '✅' : '❌'}`);
  console.log(`Burst Load P95: ${burstLatencies[95].toFixed(2)}ms ${burstLatencies[95] < 25 ? '✅' : '❌'}\n`);
  
  // Calculate overall SLO compliance
  const allLatencies = [...coldLatencies, ...mixedLatencies, ...burstLatencies];
  const meetingSLO = allLatencies.filter(l => l < 25).length;
  const sloCompliance = (meetingSLO / allLatencies.length * 100).toFixed(1);
  
  console.log(`📈 SLO COMPLIANCE: ${sloCompliance}% of requests < 25ms\n`);
  
  if (parseFloat(sloCompliance) < 95) {
    console.log('❌ FAILURE: System does NOT meet 95% SLO compliance');
    console.log('   Cold cache and burst scenarios kill performance');
    console.log('   Users will experience > 25ms latency frequently\n');
  } else {
    console.log('✅ SUCCESS: System meets 95% SLO compliance\n');
  }
  
  // The hard truth
  console.log('🔍 THE HARD TRUTH');
  console.log('=================');
  console.log('• Cache hits are fast (~0.01ms) ✅');
  console.log('• Cache misses are slow (~120ms) ❌');
  console.log('• Every new user = cache miss = SLO violation');
  console.log('• Burst traffic = many misses = major SLO failure');
  console.log('• Redis helps ONLY for returning users\n');
  
  console.log('📝 WHAT\'S STILL NEEDED:');
  console.log('1. Cache pre-warming strategy');
  console.log('2. Predictive cache loading');
  console.log('3. Query optimization in Snowflake');
  console.log('4. Connection pooling to reduce auth overhead');
  console.log('5. Regional deployment closer to Snowflake\n');
  
  // Cleanup
  await cache.close();
  await redis.quit();
}

runTest().catch(console.error);