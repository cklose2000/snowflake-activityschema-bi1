-- populate-test-data.sql
-- Populates Snowflake with realistic test data for performance validation
-- 
-- This script creates:
-- - 10,000 test events in the events table
-- - 1,000 customer contexts in CONTEXT_CACHE
-- - 500 insight atoms
-- - Sample artifacts
--
-- Run this script in Snowflake to prepare for performance testing

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- Clear existing test data (optional - comment out to preserve)
-- DELETE FROM EVENTS WHERE customer LIKE 'test_customer_%';
-- DELETE FROM CONTEXT_CACHE WHERE customer_id LIKE 'test_customer_%';
-- DELETE FROM INSIGHT_ATOMS WHERE customer_id LIKE 'test_customer_%';

-- ============================================
-- 1. Populate EVENTS table with test data
-- ============================================

-- Generate 10,000 test events over the last 30 days
INSERT INTO EVENTS (
    activity,
    customer,
    ts,
    activity_repeated_at,
    activity_occurrence,
    link,
    revenue_impact,
    _feature_json,
    _source_system,
    _source_version,
    _session_id,
    _query_tag
)
SELECT
    -- Activity names using cdesk.* namespace
    CASE (seq4() % 10)
        WHEN 0 THEN 'cdesk.session_started'
        WHEN 1 THEN 'cdesk.user_asked'
        WHEN 2 THEN 'cdesk.claude_responded'
        WHEN 3 THEN 'cdesk.tool_called'
        WHEN 4 THEN 'cdesk.sql_executed'
        WHEN 5 THEN 'cdesk.sql_completed'
        WHEN 6 THEN 'cdesk.insight_recorded'
        WHEN 7 THEN 'cdesk.context_refreshed'
        WHEN 8 THEN 'cdesk.artifact_created'
        ELSE 'cdesk.error_encountered'
    END as activity,
    
    -- Customer IDs (1000 unique customers)
    'test_customer_' || LPAD((seq4() % 1000)::STRING, 4, '0') as customer,
    
    -- Timestamp distributed over last 30 days
    DATEADD(
        'second',
        -ABS(MOD(RANDOM(), 30 * 24 * 60 * 60)),
        CURRENT_TIMESTAMP()
    ) as ts,
    
    -- activity_repeated_at (50% null, 50% with previous timestamp)
    CASE 
        WHEN seq4() % 2 = 0 THEN NULL
        ELSE DATEADD('hour', -ABS(MOD(RANDOM(), 24)), CURRENT_TIMESTAMP())
    END as activity_repeated_at,
    
    -- activity_occurrence (1-100)
    ABS(MOD(RANDOM(), 100)) + 1 as activity_occurrence,
    
    -- Link (30% have links)
    CASE 
        WHEN seq4() % 3 = 0 THEN 'https://app.example.com/session/' || UUID_STRING()
        ELSE NULL
    END as link,
    
    -- Revenue impact (20% have revenue)
    CASE 
        WHEN seq4() % 5 = 0 THEN ROUND(ABS(MOD(RANDOM(), 10000)) / 100.0, 2)
        ELSE NULL
    END as revenue_impact,
    
    -- Feature JSON with realistic metadata
    OBJECT_CONSTRUCT(
        'model', CASE (seq4() % 3)
            WHEN 0 THEN 'claude-3-opus'
            WHEN 1 THEN 'claude-3-sonnet'
            ELSE 'claude-3-haiku'
        END,
        'prompt_tokens', ABS(MOD(RANDOM(), 1000)) + 100,
        'completion_tokens', ABS(MOD(RANDOM(), 500)) + 50,
        'latency_ms', ABS(MOD(RANDOM(), 500)) + 50,
        'warehouse', CASE (seq4() % 3)
            WHEN 0 THEN 'COMPUTE_XS'
            WHEN 1 THEN 'COMPUTE_S'
            ELSE 'COMPUTE_M'
        END,
        'rows_returned', ABS(MOD(RANDOM(), 1000)),
        'bytes_scanned', ABS(MOD(RANDOM(), 1000000)),
        'cache_hit', seq4() % 5 > 0, -- 80% cache hits
        'session_duration_ms', ABS(MOD(RANDOM(), 60000)) + 1000
    ) as _feature_json,
    
    'claude_desktop' as _source_system,
    '2.0' as _source_version,
    
    -- Session ID
    'session_' || LPAD((seq4() % 5000)::STRING, 5, '0') as _session_id,
    
    -- Query tag (cdesk_[8-char-uuid])
    'cdesk_' || SUBSTR(REPLACE(UUID_STRING(), '-', ''), 1, 8) as _query_tag
FROM TABLE(GENERATOR(ROWCOUNT => 1000)); -- Reduced for testing

-- ============================================
-- 2. Populate CONTEXT_CACHE with test data
-- ============================================

-- CONTEXT_CACHE table already exists with different schema
-- Columns: CUSTOMER, CONTEXT_BLOB, CONTEXT_TYPE, UPDATED_AT

-- Insert 1000 customer contexts
MERGE INTO CONTEXT_CACHE AS target
USING (
    SELECT 
        'test_customer_' || LPAD(seq4()::STRING, 4, '0') as customer,
        OBJECT_CONSTRUCT(
            'id', 'test_customer_' || LPAD(seq4()::STRING, 4, '0'),
            'preferences', OBJECT_CONSTRUCT(
                'theme', CASE seq4() % 2 WHEN 0 THEN 'dark' ELSE 'light' END,
                'language', CASE seq4() % 3 WHEN 0 THEN 'en' WHEN 1 THEN 'fr' ELSE 'es' END,
                'timezone', CASE seq4() % 4 
                    WHEN 0 THEN 'America/New_York'
                    WHEN 1 THEN 'Europe/London'
                    WHEN 2 THEN 'Asia/Tokyo'
                    ELSE 'America/Los_Angeles'
                END
            ),
            'metadata', OBJECT_CONSTRUCT(
                'created', DATEADD('day', -seq4() % 365, CURRENT_TIMESTAMP()),
                'last_login', DATEADD('hour', -seq4() % 168, CURRENT_TIMESTAMP()),
                'total_sessions', FLOOR(RANDOM() * 1000) + 1,
                'total_queries', FLOOR(RANDOM() * 5000) + 10
            ),
            'recent_activities', ARRAY_CONSTRUCT(
                'cdesk.user_asked',
                'cdesk.sql_executed',
                'cdesk.claude_responded'
            ),
            'insights', OBJECT_CONSTRUCT(
                'total_revenue', ROUND(RANDOM() * 10000, 2),
                'avg_session_duration', FLOOR(RANDOM() * 3600) + 60,
                'favorite_tools', ARRAY_CONSTRUCT('sql', 'chart', 'export')
            ),
            'filters', OBJECT_CONSTRUCT(
                'date_range', '30d',
                'product_category', CASE seq4() % 3
                    WHEN 0 THEN 'electronics'
                    WHEN 1 THEN 'clothing'
                    ELSE 'books'
                END,
                'region', CASE seq4() % 4
                    WHEN 0 THEN 'north'
                    WHEN 1 THEN 'south'
                    WHEN 2 THEN 'east'
                    ELSE 'west'
                END
            )
        ) as context_blob,
        'test_data' as context_type,
        CURRENT_TIMESTAMP() as updated_at
    FROM TABLE(GENERATOR(ROWCOUNT => 100))
) AS source
ON target.customer = source.customer
WHEN MATCHED THEN UPDATE SET
    context_blob = source.context_blob,
    context_type = source.context_type,
    updated_at = source.updated_at
WHEN NOT MATCHED THEN INSERT
    (customer, context_blob, context_type, updated_at)
    VALUES (source.customer, source.context_blob, source.context_type, source.updated_at);

-- ============================================
-- 3. Populate INSIGHT_ATOMS with test data
-- ============================================

-- Create INSIGHT_ATOMS table if it doesn't exist
CREATE TABLE IF NOT EXISTS INSIGHT_ATOMS (
    atom_id STRING NOT NULL PRIMARY KEY,
    customer_id STRING NOT NULL,
    subject STRING NOT NULL,
    metric STRING NOT NULL,
    value VARIANT NOT NULL,
    provenance_query_hash STRING,
    ts TIMESTAMP_NTZ NOT NULL,
    ttl INT
) CLUSTER BY (subject, metric, ts);

-- Insert 500 insight atoms
INSERT INTO INSIGHT_ATOMS (
    atom_id,
    customer_id,
    subject,
    metric,
    value,
    provenance_query_hash,
    ts,
    ttl
)
SELECT
    UUID_STRING() as atom_id,
    'test_customer_' || LPAD((seq4() % 100)::STRING, 4, '0') as customer_id,
    
    CASE (seq4() % 5)
        WHEN 0 THEN 'revenue'
        WHEN 1 THEN 'users'
        WHEN 2 THEN 'performance'
        WHEN 3 THEN 'errors'
        ELSE 'sessions'
    END as subject,
    
    CASE (seq4() % 5)
        WHEN 0 THEN 'daily_total'
        WHEN 1 THEN 'weekly_average'
        WHEN 2 THEN 'monthly_trend'
        WHEN 3 THEN 'p95_latency'
        ELSE 'error_rate'
    END as metric,
    
    CASE (seq4() % 3)
        WHEN 0 THEN TO_VARIANT(ROUND(RANDOM() * 10000, 2))
        WHEN 1 THEN TO_VARIANT(FLOOR(RANDOM() * 1000))
        ELSE TO_VARIANT(ARRAY_CONSTRUCT(
            ROUND(RANDOM() * 100, 2),
            ROUND(RANDOM() * 100, 2),
            ROUND(RANDOM() * 100, 2)
        ))
    END as value,
    
    -- Generate 16-character hash
    SUBSTR(MD5(UUID_STRING()), 1, 16) as provenance_query_hash,
    
    DATEADD('hour', -seq4() % 720, CURRENT_TIMESTAMP()) as ts,
    
    86400 as ttl -- 24 hour TTL
FROM TABLE(GENERATOR(ROWCOUNT => 500));

-- ============================================
-- 4. Create sample artifacts
-- ============================================

-- Create ARTIFACTS table if it doesn't exist
CREATE TABLE IF NOT EXISTS ARTIFACTS (
    artifact_id STRING PRIMARY KEY,
    customer_id STRING NOT NULL,
    s3_url STRING NOT NULL,
    size_bytes INT NOT NULL,
    content_type STRING,
    created_at TIMESTAMP_NTZ NOT NULL,
    expires_at TIMESTAMP_NTZ
);

-- Insert sample artifacts
INSERT INTO ARTIFACTS (
    artifact_id,
    customer_id,
    s3_url,
    size_bytes,
    content_type,
    created_at,
    expires_at
)
SELECT
    UUID_STRING() as artifact_id,
    'test_customer_' || LPAD((seq4() % 100)::STRING, 4, '0') as customer_id,
    's3://bi-artifacts/results/' || UUID_STRING() || '.json' as s3_url,
    FLOOR(RANDOM() * 1000000) + 1000 as size_bytes,
    CASE (seq4() % 3)
        WHEN 0 THEN 'application/json'
        WHEN 1 THEN 'text/csv'
        ELSE 'application/octet-stream'
    END as content_type,
    DATEADD('hour', -seq4() % 168, CURRENT_TIMESTAMP()) as created_at,
    DATEADD('day', 7, CURRENT_TIMESTAMP()) as expires_at
FROM TABLE(GENERATOR(ROWCOUNT => 50));

-- ============================================
-- 5. Verify data population
-- ============================================

-- Show row counts for verification
SELECT 'EVENTS' as table_name, COUNT(*) as row_count 
FROM EVENTS 
WHERE customer LIKE 'test_customer_%'
UNION ALL
SELECT 'CONTEXT_CACHE', COUNT(*) 
FROM CONTEXT_CACHE 
WHERE customer LIKE 'test_customer_%'
UNION ALL
SELECT 'INSIGHT_ATOMS', COUNT(*) 
FROM INSIGHT_ATOMS 
WHERE customer_id LIKE 'test_customer_%'
UNION ALL
SELECT 'ARTIFACTS', COUNT(*) 
FROM ARTIFACTS 
WHERE customer_id LIKE 'test_customer_%'
ORDER BY table_name;

-- Sample queries to verify data quality
SELECT 
    activity,
    COUNT(*) as count,
    AVG(revenue_impact) as avg_revenue,
    MAX(ts) as latest_event
FROM EVENTS
WHERE customer LIKE 'test_customer_%'
GROUP BY activity
ORDER BY count DESC
LIMIT 10;

-- Verify CONTEXT_CACHE has proper structure
SELECT 
    customer,
    context_blob:preferences:theme::STRING as theme,
    context_blob:metadata:total_sessions::INT as total_sessions,
    updated_at
FROM CONTEXT_CACHE
WHERE customer LIKE 'test_customer_%'
LIMIT 5;

-- Success message
SELECT 'Test data population complete!' as status,
       'Run performance tests with test_customer_* IDs' as next_step;