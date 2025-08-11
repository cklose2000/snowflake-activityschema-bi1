import { ContextCache } from '../cache/context-cache.js';
import pino from 'pino';

const logger = pino({ 
  name: 'context-benchmark',
  level: 'info',
  transport: {
    target: 'pino-pretty',
  }
});

// Benchmark configuration
const NUM_CUSTOMERS = 1000;
const NUM_REQUESTS = 10000;
const CONCURRENT_REQUESTS = 100;
const TARGET_P95_MS = 25; // Critical SLO

interface BenchmarkResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  minLatencyMs: number;
  requestsPerSecond: number;
  passedSLO: boolean;
}

async function runBenchmark(): Promise<BenchmarkResult> {
  logger.info('Starting context cache benchmark...');
  
  // Initialize cache
  const cache = new ContextCache(
    NUM_CUSTOMERS, // Max size
    60000, // TTL: 1 minute
    undefined // No Redis for pure memory benchmark
  );
  
  // Pre-populate cache with test data
  logger.info(`Pre-populating cache with ${NUM_CUSTOMERS} customers...`);
  for (let i = 0; i < NUM_CUSTOMERS; i++) {
    await cache.set(`customer_${i}`, {
      context: {
        id: `customer_${i}`,
        preferences: { theme: 'dark', language: 'en' },
        metadata: { created: new Date().toISOString() },
        history: Array(10).fill(null).map((_, j) => ({
          action: `action_${j}`,
          timestamp: new Date().toISOString(),
        })),
      },
      updated_at: new Date().toISOString(),
      version: 1,
    });
  }
  
  // Prepare test workload
  const customerIds = Array(NUM_REQUESTS).fill(null).map(() => 
    `customer_${Math.floor(Math.random() * NUM_CUSTOMERS)}`
  );
  
  const latencies: number[] = [];
  let successCount = 0;
  let failureCount = 0;
  
  logger.info(`Running ${NUM_REQUESTS} requests with ${CONCURRENT_REQUESTS} concurrent...`);
  
  const startTime = process.hrtime.bigint();
  
  // Run requests in batches for concurrency
  for (let i = 0; i < NUM_REQUESTS; i += CONCURRENT_REQUESTS) {
    const batch = customerIds.slice(i, i + CONCURRENT_REQUESTS);
    
    const batchPromises = batch.map(async (customerId) => {
      const requestStart = process.hrtime.bigint();
      
      try {
        const result = await cache.get(customerId);
        
        const requestEnd = process.hrtime.bigint();
        const latencyNs = Number(requestEnd - requestStart);
        const latencyMs = latencyNs / 1_000_000;
        
        latencies.push(latencyMs);
        
        if (result) {
          successCount++;
        } else {
          failureCount++;
        }
        
        // Log slow requests
        if (latencyMs > TARGET_P95_MS) {
          logger.debug({ customerId, latencyMs }, 'Slow request detected');
        }
        
      } catch (error) {
        failureCount++;
        logger.error({ error, customerId }, 'Request failed');
      }
    });
    
    await Promise.all(batchPromises);
    
    // Progress update
    if ((i + CONCURRENT_REQUESTS) % 1000 === 0) {
      const progress = Math.min(100, ((i + CONCURRENT_REQUESTS) / NUM_REQUESTS) * 100);
      logger.info(`Progress: ${progress.toFixed(1)}%`);
    }
  }
  
  const endTime = process.hrtime.bigint();
  const totalTimeMs = Number(endTime - startTime) / 1_000_000;
  
  // Calculate statistics
  latencies.sort((a, b) => a - b);
  
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = sum / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.50)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const max = latencies[latencies.length - 1];
  const min = latencies[0];
  const rps = NUM_REQUESTS / (totalTimeMs / 1000);
  
  // Check if we passed the SLO
  const passedSLO = p95 <= TARGET_P95_MS;
  
  const result: BenchmarkResult = {
    totalRequests: NUM_REQUESTS,
    successfulRequests: successCount,
    failedRequests: failureCount,
    averageLatencyMs: avg,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    maxLatencyMs: max,
    minLatencyMs: min,
    requestsPerSecond: rps,
    passedSLO,
  };
  
  // Clean up
  await cache.close();
  
  return result;
}

// Stress test with increasing load
async function stressTest(): Promise<void> {
  logger.info('Starting stress test with increasing load...');
  
  const loads = [100, 500, 1000, 5000, 10000];
  
  for (const load of loads) {
    logger.info(`\nTesting with ${load} concurrent requests...`);
    
    const cache = new ContextCache(1000, 60000);
    
    // Pre-populate
    for (let i = 0; i < 1000; i++) {
      await cache.set(`customer_${i}`, {
        context: { id: `customer_${i}` },
        updated_at: new Date().toISOString(),
        version: 1,
      });
    }
    
    const latencies: number[] = [];
    const promises: Promise<void>[] = [];
    
    const startTime = process.hrtime.bigint();
    
    // Fire all requests concurrently
    for (let i = 0; i < load; i++) {
      promises.push(
        (async () => {
          const customerId = `customer_${Math.floor(Math.random() * 1000)}`;
          const requestStart = process.hrtime.bigint();
          
          await cache.get(customerId);
          
          const requestEnd = process.hrtime.bigint();
          const latencyMs = Number(requestEnd - requestStart) / 1_000_000;
          latencies.push(latencyMs);
        })()
      );
    }
    
    await Promise.all(promises);
    
    const endTime = process.hrtime.bigint();
    const totalTimeMs = Number(endTime - startTime) / 1_000_000;
    
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    
    logger.info({
      load,
      p95LatencyMs: p95.toFixed(2),
      totalTimeMs: totalTimeMs.toFixed(2),
      requestsPerSecond: (load / (totalTimeMs / 1000)).toFixed(0),
      passedSLO: p95 <= TARGET_P95_MS,
    }, 'Load test result');
    
    await cache.close();
    
    // Stop if we fail SLO
    if (p95 > TARGET_P95_MS) {
      logger.error(`Failed SLO at ${load} concurrent requests. P95: ${p95.toFixed(2)}ms > ${TARGET_P95_MS}ms`);
      break;
    }
  }
}

// Main execution
async function main() {
  try {
    logger.info('='.repeat(60));
    logger.info('Context Cache Performance Benchmark');
    logger.info(`Target P95 Latency: ${TARGET_P95_MS}ms`);
    logger.info('='.repeat(60));
    
    // Run main benchmark
    const result = await runBenchmark();
    
    // Display results
    logger.info('\n' + '='.repeat(60));
    logger.info('BENCHMARK RESULTS');
    logger.info('='.repeat(60));
    
    logger.info({
      'Total Requests': result.totalRequests,
      'Successful': result.successfulRequests,
      'Failed': result.failedRequests,
      'Success Rate': `${((result.successfulRequests / result.totalRequests) * 100).toFixed(2)}%`,
    }, 'Request Statistics');
    
    logger.info({
      'Average': `${result.averageLatencyMs.toFixed(3)}ms`,
      'P50': `${result.p50LatencyMs.toFixed(3)}ms`,
      'P95': `${result.p95LatencyMs.toFixed(3)}ms`,
      'P99': `${result.p99LatencyMs.toFixed(3)}ms`,
      'Min': `${result.minLatencyMs.toFixed(3)}ms`,
      'Max': `${result.maxLatencyMs.toFixed(3)}ms`,
    }, 'Latency Statistics');
    
    logger.info({
      'Requests/Second': result.requestsPerSecond.toFixed(0),
    }, 'Throughput');
    
    // Final verdict
    logger.info('\n' + '='.repeat(60));
    if (result.passedSLO) {
      logger.info(`✅ PASSED: P95 latency ${result.p95LatencyMs.toFixed(2)}ms <= ${TARGET_P95_MS}ms target`);
    } else {
      logger.error(`❌ FAILED: P95 latency ${result.p95LatencyMs.toFixed(2)}ms > ${TARGET_P95_MS}ms target`);
    }
    logger.info('='.repeat(60));
    
    // Run stress test
    logger.info('\nRunning stress test...');
    await stressTest();
    
  } catch (error) {
    logger.error({ error }, 'Benchmark failed');
    process.exit(1);
  }
}

// Run benchmark
main();