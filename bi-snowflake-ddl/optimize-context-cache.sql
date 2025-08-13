-- =====================================================
-- CONTEXT_CACHE Performance Optimization Script
-- 
-- Purpose: Reduce query latency from 120ms to < 25ms
-- Expected improvement: 60-80% reduction in query time
-- =====================================================

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;
USE WAREHOUSE COMPUTE_WH;

-- =====================================================
-- 1. ENABLE QUERY RESULT CACHING (Immediate impact)
-- =====================================================
-- Enable result caching for the session
ALTER SESSION SET USE_CACHED_RESULT = TRUE;

-- Configure warehouse for optimal caching
ALTER WAREHOUSE COMPUTE_WH SET 
  WAREHOUSE_SIZE = 'XSMALL'
  MAX_CLUSTER_COUNT = 2
  MIN_CLUSTER_COUNT = 1
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  ENABLE_QUERY_ACCELERATION = TRUE
  COMMENT = 'Optimized for < 25ms P95 latency';

-- =====================================================
-- 2. ADD CLUSTERING KEY (30-50% improvement)
-- =====================================================
-- Add clustering on customer_id for fast point lookups
ALTER TABLE CONTEXT_CACHE CLUSTER BY (customer_id);

-- Enable automatic re-clustering to maintain performance
ALTER TABLE CONTEXT_CACHE SET AUTO_RECLUSTERING = TRUE;

-- Check clustering status
SELECT SYSTEM$CLUSTERING_INFORMATION('CONTEXT_CACHE');

-- =====================================================
-- 3. ADD SEARCH OPTIMIZATION (20-40% improvement)
-- =====================================================
-- Enable search optimization for equality predicates
ALTER TABLE CONTEXT_CACHE ADD SEARCH OPTIMIZATION ON EQUALITY(customer_id);

-- Monitor search optimization progress
SELECT * FROM TABLE(INFORMATION_SCHEMA.SEARCH_OPTIMIZATION_HISTORY(
  TABLE_NAME => 'CONTEXT_CACHE',
  DATABASE_NAME => 'CLAUDE_LOGS',
  SCHEMA_NAME => 'ACTIVITIES'
));

-- =====================================================
-- 4. CREATE MATERIALIZED VIEW FOR HOT DATA
-- =====================================================
-- Create a materialized view for recently accessed contexts
CREATE OR REPLACE MATERIALIZED VIEW MV_CONTEXT_CACHE_RECENT AS
SELECT 
  customer_id,
  context,
  updated_at,
  version
FROM CONTEXT_CACHE
WHERE updated_at >= DATEADD(hour, -24, CURRENT_TIMESTAMP());

-- =====================================================
-- 5. ANALYZE TABLE STATISTICS
-- =====================================================
-- Update table statistics for query optimizer
ALTER TABLE CONTEXT_CACHE SET STATISTICS SAMPLING_RATIO = 10;

-- =====================================================
-- 6. PERFORMANCE VALIDATION QUERIES
-- =====================================================

-- Test 1: Simple point lookup (should use clustering + search opt)
EXPLAIN USING TEXT
SELECT context, updated_at, version
FROM CONTEXT_CACHE
WHERE customer_id = 'test_customer_1'
LIMIT 1;

-- Test 2: Verify query result caching
-- Run this twice - second run should be near-instant
SELECT context, updated_at, version
FROM CONTEXT_CACHE
WHERE customer_id = 'test_customer_1'
LIMIT 1;

-- Check if result was cached (look for USE_CACHED_RESULT = true)
SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())
WHERE QUERY_TEXT LIKE '%test_customer_1%'
ORDER BY START_TIME DESC
LIMIT 2;

-- =====================================================
-- 7. MONITOR IMPROVEMENTS
-- =====================================================

-- Check average query time before/after optimizations
WITH recent_queries AS (
  SELECT 
    QUERY_ID,
    QUERY_TEXT,
    EXECUTION_TIME,
    QUEUED_PROVISIONING_TIME,
    QUEUED_REPAIR_TIME,
    QUEUED_OVERLOAD_TIME,
    TRANSACTION_BLOCKED_TIME,
    COMPILATION_TIME,
    BYTES_SCANNED,
    ROWS_PRODUCED,
    START_TIME
  FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())
  WHERE QUERY_TEXT LIKE '%CONTEXT_CACHE%'
    AND QUERY_TEXT LIKE '%customer_id%'
    AND START_TIME >= DATEADD(hour, -1, CURRENT_TIMESTAMP())
)
SELECT 
  COUNT(*) as query_count,
  AVG(EXECUTION_TIME) as avg_execution_ms,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXECUTION_TIME) as p50_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXECUTION_TIME) as p95_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXECUTION_TIME) as p99_ms,
  MIN(EXECUTION_TIME) as min_ms,
  MAX(EXECUTION_TIME) as max_ms
FROM recent_queries;

-- =====================================================
-- 8. COST MONITORING
-- =====================================================

-- Check credit usage for optimizations
SELECT 
  DATE(START_TIME) as query_date,
  SUM(CREDITS_USED) as daily_credits,
  COUNT(*) as query_count,
  AVG(EXECUTION_TIME) as avg_time_ms
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())
WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
GROUP BY DATE(START_TIME)
ORDER BY query_date DESC;

-- Check search optimization costs
SELECT 
  TABLE_NAME,
  SEARCH_OPTIMIZATION_BYTES,
  SEARCH_OPTIMIZATION_CREDITS
FROM TABLE(INFORMATION_SCHEMA.SEARCH_OPTIMIZATION_HISTORY())
WHERE TABLE_NAME = 'CONTEXT_CACHE';

-- =====================================================
-- ROLLBACK COMMANDS (if needed)
-- =====================================================
-- ALTER TABLE CONTEXT_CACHE DROP CLUSTERING KEY;
-- ALTER TABLE CONTEXT_CACHE SET AUTO_RECLUSTERING = FALSE;
-- ALTER TABLE CONTEXT_CACHE DROP SEARCH OPTIMIZATION;
-- DROP MATERIALIZED VIEW MV_CONTEXT_CACHE_RECENT;
-- ALTER SESSION SET USE_CACHED_RESULT = FALSE;