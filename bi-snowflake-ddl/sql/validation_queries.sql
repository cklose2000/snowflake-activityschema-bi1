-- ========================================
-- ActivitySchema v2.0 Compliance Validation Queries
-- ========================================
-- These queries validate that data in the analytics.activity.events table
-- strictly adheres to ActivitySchema v2.0 requirements

-- ========================================
-- 1. REQUIRED FIELDS VALIDATION
-- ========================================

-- Check for NULL values in required fields (should return 0 rows)
SELECT 'Required fields with NULLs' as check_type,
       COUNT(*) as violation_count
FROM analytics.activity.events
WHERE activity IS NULL
   OR customer IS NULL
   OR ts IS NULL
   OR activity_occurrence IS NULL;

-- Verify activity_occurrence is computed correctly
WITH occurrence_check AS (
  SELECT activity, customer, ts,
         activity_occurrence,
         ROW_NUMBER() OVER (PARTITION BY customer, activity ORDER BY ts) AS expected_occurrence
  FROM analytics.activity.events
)
SELECT 'Incorrect activity_occurrence' as check_type,
       COUNT(*) as violation_count
FROM occurrence_check
WHERE activity_occurrence != expected_occurrence;

-- Verify activity_repeated_at is computed correctly
WITH repeat_check AS (
  SELECT activity, customer, ts,
         activity_repeated_at,
         LEAD(ts) OVER (PARTITION BY customer, activity ORDER BY ts) AS expected_repeated_at
  FROM analytics.activity.events
)
SELECT 'Incorrect activity_repeated_at' as check_type,
       COUNT(*) as violation_count
FROM repeat_check
WHERE COALESCE(activity_repeated_at, '9999-12-31'::TIMESTAMP_NTZ) != 
      COALESCE(expected_repeated_at, '9999-12-31'::TIMESTAMP_NTZ);

-- ========================================
-- 2. ACTIVITY NAMESPACE VALIDATION
-- ========================================

-- Check that all activities use cdesk.* namespace (should return 0 rows)
SELECT 'Non-cdesk namespace activities' as check_type,
       activity,
       COUNT(*) as count
FROM analytics.activity.events
WHERE NOT activity LIKE 'cdesk.%'
GROUP BY activity;

-- Validate activity naming convention (lowercase, underscore separated)
SELECT 'Invalid activity format' as check_type,
       activity,
       COUNT(*) as count
FROM analytics.activity.events
WHERE activity != LOWER(activity)
   OR activity LIKE '% %'  -- No spaces allowed
   OR activity LIKE '%-%'  -- No dashes allowed
   OR activity NOT REGEXP '^cdesk\\.[a-z]+(_[a-z]+)*$'
GROUP BY activity;

-- List all unique activities for review
SELECT 'Activity Catalog' as report_type,
       activity,
       COUNT(*) as event_count,
       MIN(ts) as first_seen,
       MAX(ts) as last_seen
FROM analytics.activity.events
GROUP BY activity
ORDER BY event_count DESC;

-- ========================================
-- 3. EXTENSION FIELDS VALIDATION
-- ========================================

-- Ensure no non-standard fields without underscore prefix
-- This would need to be adjusted based on actual table columns
SELECT 'Check extension field prefixes' as check_type,
       LISTAGG(COLUMN_NAME, ', ') as non_compliant_columns
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'ACTIVITY'
  AND TABLE_NAME = 'EVENTS'
  AND COLUMN_NAME NOT IN (
    -- Required by spec
    'ACTIVITY', 'CUSTOMER', 'TS', 'ACTIVITY_REPEATED_AT', 'ACTIVITY_OCCURRENCE',
    -- Optional by spec
    'LINK', 'REVENUE_IMPACT'
  )
  AND COLUMN_NAME NOT LIKE '\\_%' ESCAPE '\\';

-- ========================================
-- 4. QUERY TAG VALIDATION
-- ========================================

-- Check query tag format (should be cdesk_[8-char-uuid])
SELECT 'Invalid query tag format' as check_type,
       _query_tag,
       COUNT(*) as count
FROM analytics.activity.events
WHERE _query_tag IS NOT NULL
  AND NOT REGEXP_LIKE(_query_tag, '^cdesk_[0-9a-f]{8}$')
GROUP BY _query_tag;

-- Find queries without tags
SELECT 'Missing query tags' as check_type,
       activity,
       COUNT(*) as count
FROM analytics.activity.events
WHERE activity IN ('cdesk.sql_executed', 'cdesk.sql_completed')
  AND _query_tag IS NULL
GROUP BY activity;

-- ========================================
-- 5. SOURCE SYSTEM VALIDATION
-- ========================================

-- Verify only Claude Desktop events (no Claude Code)
SELECT 'Non-Claude-Desktop sources' as check_type,
       _source_system,
       COUNT(*) as count
FROM analytics.activity.events
WHERE _source_system != 'claude_desktop'
GROUP BY _source_system;

-- Check source version
SELECT 'Source version distribution' as report_type,
       _source_version,
       COUNT(*) as count,
       MIN(ts) as first_seen,
       MAX(ts) as last_seen
FROM analytics.activity.events
GROUP BY _source_version
ORDER BY MAX(ts) DESC;

-- ========================================
-- 6. TEMPORAL CONSISTENCY
-- ========================================

-- Check for future timestamps
SELECT 'Future timestamps' as check_type,
       COUNT(*) as count
FROM analytics.activity.events
WHERE ts > CURRENT_TIMESTAMP();

-- Check for very old timestamps (potential bad data)
SELECT 'Suspiciously old timestamps' as check_type,
       COUNT(*) as count
FROM analytics.activity.events
WHERE ts < DATEADD(year, -2, CURRENT_TIMESTAMP());

-- ========================================
-- 7. REVENUE IMPACT VALIDATION
-- ========================================

-- Check revenue_impact is using consistent units (USD)
SELECT 'Revenue impact range' as report_type,
       MIN(revenue_impact) as min_revenue,
       MAX(revenue_impact) as max_revenue,
       AVG(revenue_impact) as avg_revenue,
       STDDEV(revenue_impact) as stddev_revenue
FROM analytics.activity.events
WHERE revenue_impact IS NOT NULL;

-- Find suspicious revenue values
SELECT 'Suspicious revenue values' as check_type,
       activity,
       revenue_impact,
       COUNT(*) as count
FROM analytics.activity.events
WHERE revenue_impact IS NOT NULL
  AND (revenue_impact > 1000  -- Over $1000 per event seems high
    OR revenue_impact < -100) -- Large refunds
GROUP BY activity, revenue_impact
ORDER BY ABS(revenue_impact) DESC;

-- ========================================
-- 8. FEATURE JSON VALIDATION
-- ========================================

-- Check that _feature_json contains expected fields for specific activities
SELECT 'LLM events missing model' as check_type,
       COUNT(*) as count
FROM analytics.activity.events
WHERE activity IN ('cdesk.user_asked', 'cdesk.claude_responded')
  AND (_feature_json IS NULL OR _feature_json:model IS NULL);

SELECT 'SQL events missing template' as check_type,
       COUNT(*) as count
FROM analytics.activity.events
WHERE activity = 'cdesk.sql_executed'
  AND (_feature_json IS NULL OR _feature_json:template IS NULL);

-- ========================================
-- 9. DATA QUALITY METRICS
-- ========================================

-- Overall compliance score
WITH compliance_checks AS (
  SELECT 
    (SELECT COUNT(*) FROM analytics.activity.events WHERE activity IS NULL) as null_activities,
    (SELECT COUNT(*) FROM analytics.activity.events WHERE NOT activity LIKE 'cdesk.%') as bad_namespace,
    (SELECT COUNT(*) FROM analytics.activity.events WHERE _query_tag IS NOT NULL AND NOT REGEXP_LIKE(_query_tag, '^cdesk_[0-9a-f]{8}$')) as bad_query_tags,
    (SELECT COUNT(*) FROM analytics.activity.events WHERE _source_system != 'claude_desktop') as bad_source,
    (SELECT COUNT(*) FROM analytics.activity.events) as total_events
)
SELECT 'Overall Compliance Score' as metric,
       CASE 
         WHEN total_events = 0 THEN 100
         ELSE ROUND(100.0 * (total_events - null_activities - bad_namespace - bad_query_tags - bad_source) / total_events, 2)
       END as compliance_percentage,
       total_events,
       null_activities,
       bad_namespace,
       bad_query_tags,
       bad_source
FROM compliance_checks;

-- ========================================
-- 10. DBT COMPATIBLE TESTS
-- ========================================

-- These can be used as dbt tests with minor modifications

-- Test: required_fields_not_null
SELECT * FROM analytics.activity.events
WHERE activity IS NULL
   OR customer IS NULL
   OR ts IS NULL
   OR activity_occurrence IS NULL
LIMIT 1;  -- dbt test fails if any row returned

-- Test: activity_namespace_compliance  
SELECT * FROM analytics.activity.events
WHERE NOT activity LIKE 'cdesk.%'
LIMIT 1;  -- dbt test fails if any row returned

-- Test: query_tag_format
SELECT * FROM analytics.activity.events
WHERE _query_tag IS NOT NULL
  AND NOT REGEXP_LIKE(_query_tag, '^cdesk_[0-9a-f]{8}$')
LIMIT 1;  -- dbt test fails if any row returned

-- Test: source_system_restriction
SELECT * FROM analytics.activity.events
WHERE _source_system IS NOT NULL
  AND _source_system != 'claude_desktop'
LIMIT 1;  -- dbt test fails if any row returned

-- ========================================
-- MONITORING QUERIES
-- ========================================

-- Activity volume by hour
SELECT DATE_TRUNC('hour', ts) as hour,
       COUNT(*) as event_count,
       COUNT(DISTINCT customer) as unique_customers,
       COUNT(DISTINCT activity) as unique_activities
FROM analytics.activity.events
WHERE ts >= DATEADD(day, -7, CURRENT_TIMESTAMP())
GROUP BY DATE_TRUNC('hour', ts)
ORDER BY hour DESC;

-- Top activities by volume
SELECT activity,
       COUNT(*) as count,
       COUNT(DISTINCT customer) as unique_customers,
       AVG(DATEDIFF('millisecond', ts, COALESCE(activity_repeated_at, CURRENT_TIMESTAMP()))) as avg_time_to_repeat_ms
FROM analytics.activity.events
WHERE ts >= DATEADD(day, -1, CURRENT_TIMESTAMP())
GROUP BY activity
ORDER BY count DESC
LIMIT 20;