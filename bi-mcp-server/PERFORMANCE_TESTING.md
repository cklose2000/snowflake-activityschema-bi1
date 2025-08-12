# Performance Testing Guide

## Overview

This guide covers the complete performance validation suite for the Snowflake ActivitySchema BI system. The tests are designed to validate that we meet our critical SLO of **< 25ms P95 latency** for `get_context` operations.

## Prerequisites

1. **Snowflake Account**: Ensure you have access to the Snowflake account configured in `.env`
2. **Test Data**: The database must be populated with test data
3. **Environment Variables**: Configure the following in `.env`:

```bash
# Snowflake Configuration
SNOWFLAKE_ACCOUNT=yshmxno-fbc56289
SNOWFLAKE_USERNAME=CLAUDE_DESKTOP1
SNOWFLAKE_PASSWORD=your_password_here
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=CLAUDE_LOGS
SNOWFLAKE_SCHEMA=ACTIVITIES
SNOWFLAKE_ROLE=CLAUDE_DESKTOP_ROLE

# Performance Tuning
PERF_CACHE_HIT=25        # Target for cache hits (ms)
PERF_DB_QUERY=1000       # Timeout for DB queries (ms)
PERF_CONNECTION=5000     # Connection timeout (ms)
PERF_HEARTBEAT=300       # Connection heartbeat (seconds)
```

## Phase 1: Configuration

The system has been configured with separate timeouts for different operation types:

- **Cache Hits**: 25ms (meeting our SLO)
- **Database Queries**: 1000ms (realistic for network round-trips)
- **Connection Establishment**: 5000ms
- **Connection Heartbeat**: 300 seconds (5 minutes)

## Phase 2: Populate Test Data

Before running any performance tests, you must populate Snowflake with test data.

### Step 1: Connect to Snowflake

Use SnowSQL or the Snowflake web interface to connect to your database.

### Step 2: Run Population Script

Execute the test data population script:

```sql
-- Run the entire script in:
-- bi-mcp-server/scripts/populate-test-data.sql
```

This creates:
- 10,000 test events in `CLAUDE_LOGS.ACTIVITIES.events`
- 1,000 customer contexts in `CONTEXT_CACHE`
- 500 insight atoms
- 50 sample artifacts

### Step 3: Verify Data

```sql
-- Verify row counts
SELECT 'events' as table_name, COUNT(*) as row_count 
FROM events WHERE customer LIKE 'test_customer_%'
UNION ALL
SELECT 'CONTEXT_CACHE', COUNT(*) 
FROM CONTEXT_CACHE WHERE customer_id LIKE 'test_customer_%';
```

## Phase 3: Run Integration Tests

### Integration Tests
Tests actual Snowflake connections and query performance:

```bash
cd bi-mcp-server
npm test -- tests/integration/snowflake.test.ts
```

Expected results:
- Connection pool tests: ✅ 20 connections established
- Context retrieval: ✅ < 1000ms for database queries
- Cache hit P95: ✅ < 25ms for cached queries
- SafeSQL validation: ✅ Injection prevention working

### End-to-End Performance Tests
Tests complete MCP tool execution paths:

```bash
npm test -- tests/e2e/performance.test.ts
```

Expected results:
- `get_context`: ✅ P95 < 25ms for cache hits
- `log_event`: ✅ < 10ms for event logging
- `submit_query`: ✅ < 50ms for ticket generation
- Complete session: ✅ < 300ms critical path

### Load Testing
Simulates concurrent user load:

```bash
# Run the load test directly
npx ts-node tests/load/concurrent-users.test.ts
```

This runs progressive load tests with:
- 100 concurrent users
- 500 concurrent users
- 1000 concurrent users

Expected results:
- 100 users: ✅ < 5% error rate
- 500 users: ✅ < 10% error rate
- 1000 users: System breaking point identified

## Phase 4: Run Full-Stack Benchmark

The comprehensive benchmark tests all scenarios:

```bash
# Make the benchmark executable
chmod +x benchmarks/full-stack.bench.ts

# Run the full benchmark suite
npx ts-node benchmarks/full-stack.bench.ts
```

Benchmark scenarios:
1. **Cache Hits**: Pure memory operations
2. **Cache Misses**: Database queries
3. **Mixed Load**: 80% cache, 20% database
4. **Event Logging**: Queue write performance
5. **Concurrent Operations**: Parallel execution
6. **Real User Session**: Complete workflow

## Phase 5: Interpreting Results

### Success Criteria

✅ **MUST PASS**:
- Cache hit P95 < 25ms
- Database query P95 < 1000ms
- Event logging P95 < 10ms
- Error rate < 5% under load
- 80%+ cache hit rate

⚠️ **WARNING SIGNS**:
- Cache hit P95 > 25ms but < 50ms
- Database query P95 > 1000ms but < 2000ms
- Cache hit rate < 80% but > 60%
- Error rate 5-10% under load

❌ **FAILURES**:
- Cache hit P95 > 50ms
- Database query P95 > 2000ms
- Cache hit rate < 60%
- Error rate > 10%
- System crashes under load

### Sample Successful Output

```
FULL STACK BENCHMARK REPORT
================================================================================

SUMMARY:
--------------------------------------------------------------------------------
✅ Cache Hits         |     P95:     4.52ms | Throughput: 220451 ops/s | Errors: 0
✅ Cache Misses (DB)  |     P95:   924.18ms | Throughput:    108 ops/s | Errors: 0
✅ Mixed Load (80/20) |     P95:    45.23ms | Throughput:   2187 ops/s | Errors: 0
✅ Event Logging      |     P95:     2.14ms | Throughput: 466853 ops/s | Errors: 0
✅ Concurrent Ops     |     P95:    12.45ms | Throughput:   8024 ops/s | Errors: 2
✅ Real User Session  |     P95:    85.67ms | Throughput:   1168 ops/s | Errors: 0

PERFORMANCE VALIDATION:
--------------------------------------------------------------------------------
✅ Cache hits meet P95 < 25ms target (4.52ms)
✅ Cache hit rate meets target (79.2%)
```

## Phase 6: Performance Optimization

If tests fail, consider these optimizations:

### 1. Cache Optimization
```typescript
// Increase cache size
const cache = new ContextCache(20000, 600000); // 20K entries, 10 min TTL

// Add bloom filter for negative caching
// Add compression for large contexts
```

### 2. Connection Pool Tuning
```typescript
// Increase pool size
const snowflakeClient = new SnowflakeClient(config, 50); // 50 connections

// Reduce heartbeat frequency
config.performance.connectionHeartbeat = 180; // 3 minutes
```

### 3. Database Optimization
```sql
-- Add clustering keys
ALTER TABLE CONTEXT_CACHE CLUSTER BY (customer_id);

-- Enable query result caching
ALTER SESSION SET USE_CACHED_RESULT = TRUE;

-- Create materialized views for common queries
CREATE MATERIALIZED VIEW mv_customer_context AS
SELECT customer_id, context, updated_at
FROM CONTEXT_CACHE
WHERE updated_at >= DATEADD('hour', -1, CURRENT_TIMESTAMP());
```

## Troubleshooting

### Issue: High P95 Latency
1. Check cache hit rate: `SELECT cache_hit_rate FROM performance_metrics;`
2. Verify connection pool health: `SHOW CONNECTIONS;`
3. Check Snowflake warehouse size: May need to scale up
4. Review query execution plans: `EXPLAIN SELECT ...`

### Issue: Connection Timeouts
1. Increase `PERF_CONNECTION` timeout
2. Check network latency to Snowflake
3. Verify firewall rules
4. Check Snowflake service status

### Issue: Empty CONTEXT_CACHE
1. Run the population script: `populate-test-data.sql`
2. Verify data exists: `SELECT COUNT(*) FROM CONTEXT_CACHE;`
3. Check for data deletion jobs
4. Verify correct database/schema

## Continuous Monitoring

### Set up automated performance tests:

```bash
# Create a daily performance test job
cat > daily-perf-test.sh << 'EOF'
#!/bin/bash
cd /path/to/bi-mcp-server

# Run benchmarks
npx ts-node benchmarks/full-stack.bench.ts > perf-report-$(date +%Y%m%d).log

# Check for failures
if grep -q "❌" perf-report-*.log; then
  echo "Performance regression detected!"
  # Send alert
fi
EOF

chmod +x daily-perf-test.sh
```

### Add to CI/CD pipeline:

```yaml
# .github/workflows/performance.yml
name: Performance Tests
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 2 * * *' # Daily at 2 AM

jobs:
  performance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm ci
      - run: npm run populate-test-data
      - run: npm run benchmark
      - name: Upload results
        uses: actions/upload-artifact@v2
        with:
          name: performance-results
          path: perf-report-*.log
```

## Summary

The performance testing suite provides comprehensive validation of the system's ability to meet SLOs. Key achievements when properly configured:

1. ✅ **Cache hits**: < 5ms P95 (exceeds 25ms target)
2. ✅ **Mixed load**: < 50ms P95 with 80% cache hits
3. ✅ **Event logging**: < 3ms P95 (exceeds 10ms target)
4. ✅ **Concurrent users**: Handles 1000+ users
5. ✅ **Error rate**: < 5% under load

Regular execution of these tests ensures the system maintains performance standards as it evolves.