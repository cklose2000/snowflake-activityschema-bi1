-- Create the actual tables needed for the BI system
-- Run this with: snowsql -f bi-snowflake-ddl/create_tables_real.sql

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- Core ActivitySchema v2.0 compliant events table
CREATE TABLE IF NOT EXISTS events (
    activity_id STRING PRIMARY KEY,
    ts TIMESTAMP_NTZ NOT NULL,
    activity STRING NOT NULL,
    customer STRING,
    anonymous_customer_id STRING,
    activity_occurrence INT DEFAULT 1,
    activity_repeated_at TIMESTAMP_NTZ,
    link STRING,
    revenue_impact FLOAT,
    
    -- Extension columns (underscore prefix per v2.0 spec)
    _feature_json VARIANT,
    _source_system STRING DEFAULT 'claude_desktop',
    _source_version STRING DEFAULT '2.0',
    _session_id STRING,
    _query_tag STRING,
    _created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
) CLUSTER BY (activity, ts);

-- Context cache for ultra-fast retrieval
CREATE TABLE IF NOT EXISTS context_cache (
    customer STRING PRIMARY KEY,
    context_blob VARIANT NOT NULL,
    updated_at TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- Insight atoms for persistent memory
CREATE TABLE IF NOT EXISTS insight_atoms (
    id STRING PRIMARY KEY,
    customer STRING NOT NULL,
    subject STRING NOT NULL,
    metric STRING NOT NULL,
    value VARIANT NOT NULL,
    provenance_query_hash STRING,
    ts TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
) CLUSTER BY (subject, metric, ts);

-- Deduplication tracking
CREATE TABLE IF NOT EXISTS _ingest_ids (
    id STRING PRIMARY KEY,
    ingested_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Populate some test context data
INSERT INTO context_cache (customer, context_blob, updated_at)
SELECT 
    'test_user',
    OBJECT_CONSTRUCT(
        'user_id', 'test_user',
        'preferences', OBJECT_CONSTRUCT(
            'theme', 'dark',
            'language', 'en',
            'timezone', 'UTC'
        ),
        'stats', OBJECT_CONSTRUCT(
            'total_queries', 1000,
            'last_login', CURRENT_TIMESTAMP()::STRING
        )
    ),
    CURRENT_TIMESTAMP()
WHERE NOT EXISTS (
    SELECT 1 FROM context_cache WHERE customer = 'test_user'
);

-- Create more test users for load testing
INSERT INTO context_cache (customer, context_blob, updated_at)
SELECT 
    'user_' || SEQ4() as customer,
    OBJECT_CONSTRUCT(
        'user_id', 'user_' || SEQ4(),
        'preferences', OBJECT_CONSTRUCT(
            'theme', IFF(UNIFORM(1, 2, RANDOM()) = 1, 'dark', 'light'),
            'language', 'en',
            'timezone', 'UTC'
        ),
        'stats', OBJECT_CONSTRUCT(
            'total_queries', UNIFORM(1, 10000, RANDOM()),
            'last_login', CURRENT_TIMESTAMP()::STRING
        )
    ),
    CURRENT_TIMESTAMP()
FROM TABLE(GENERATOR(ROWCOUNT => 100))
WHERE NOT EXISTS (
    SELECT 1 FROM context_cache WHERE customer = 'user_' || SEQ4()
);

-- Verify tables
SHOW TABLES;

-- Check context cache
SELECT COUNT(*) as context_entries FROM context_cache;
SELECT * FROM context_cache LIMIT 5;