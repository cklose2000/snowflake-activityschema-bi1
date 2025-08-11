-- ============================================
-- POC SETUP FOR CLAUDE_LOGS DATABASE
-- ============================================
-- This file sets up the POC environment using the CLAUDE_LOGS database
-- Run this FIRST before other DDL files

-- Use the POC database
USE DATABASE CLAUDE_LOGS;
USE WAREHOUSE COMPUTE_WH;
USE ROLE CLAUDE_DESKTOP_ROLE;

-- Create the ACTIVITIES schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS ACTIVITIES;
USE SCHEMA ACTIVITIES;

-- ============================================
-- CORE EVENTS TABLE (ActivitySchema v2.0)
-- ============================================
CREATE TABLE IF NOT EXISTS EVENTS (
  -- REQUIRED BY SPEC
  activity                 STRING           NOT NULL,   -- e.g., 'cdesk.user_asked'
  customer                 STRING           NOT NULL,   -- org-wide user/entity id
  ts                       TIMESTAMP_NTZ    NOT NULL,   -- event time
  activity_repeated_at     TIMESTAMP_NTZ,               -- LEAD(ts) over (customer, activity)
  activity_occurrence      NUMBER           NOT NULL DEFAULT 1,   -- ROW_NUMBER() over (customer, activity)

  -- OPTIONAL BY SPEC
  link                     STRING,                      -- artifact id or URL to renderer
  revenue_impact           NUMBER,                      -- USD

  -- EXTENSIONS (underscore prefix)
  _feature_json            VARIANT,                     -- tokens/latency/rows/bytes/etc.
  _source_system           STRING DEFAULT 'claude_desktop',
  _source_version          STRING DEFAULT '2.0',
  _session_id              STRING,
  _query_tag               STRING,
  _ingested_at             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY (customer, ts);

-- ============================================
-- INSIGHT ATOMS (Structured Memory)
-- ============================================
CREATE TABLE IF NOT EXISTS INSIGHT_ATOMS (
  atom_id                  STRING           PRIMARY KEY,
  customer_id              STRING           NOT NULL,
  subject                  STRING           NOT NULL,    -- entity being measured
  metric                   STRING           NOT NULL,    -- metric name  
  value                    VARIANT          NOT NULL,    -- metric value
  provenance_query_hash    STRING,                       -- source query hash
  ts                       TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP(),
  ttl_seconds              NUMBER,                       -- optional time-to-live
  _ingested_at             TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY (subject, metric, ts);

-- ============================================
-- CONTEXT CACHE (Read Optimization)
-- ============================================
CREATE TABLE IF NOT EXISTS CONTEXT_CACHE (
  customer_id              STRING           PRIMARY KEY,
  context                  VARIANT          NOT NULL,    -- aggregated state blob
  updated_at               TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP(),
  version                  NUMBER           DEFAULT 1
);

-- ============================================
-- ARTIFACTS (Large Results)
-- ============================================
CREATE TABLE IF NOT EXISTS ARTIFACTS (
  artifact_id              STRING           PRIMARY KEY,
  customer_id              STRING           NOT NULL,
  s3_url                   STRING,                       -- S3 location
  preview                  VARIANT,                      -- first 10 rows
  metadata                 VARIANT,                      -- row_count, columns, etc.
  size_bytes               NUMBER,
  content_type             STRING,
  created_at               TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP(),
  expires_at               TIMESTAMP_NTZ
)
CLUSTER BY (customer_id, created_at);

-- ============================================
-- INGEST TRACKING (Deduplication)
-- ============================================
CREATE TABLE IF NOT EXISTS INGEST_IDS (
  activity_id              STRING           PRIMARY KEY,
  ingested_at              TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP()
);

-- ============================================
-- HELPER VIEWS
-- ============================================

-- Base view without extensions
CREATE OR REPLACE VIEW VW_EVENTS_BASE AS
SELECT 
  activity, 
  customer, 
  ts, 
  activity_repeated_at, 
  activity_occurrence, 
  link, 
  revenue_impact
FROM EVENTS;

-- LLM events view
CREATE OR REPLACE VIEW VW_LLM_EVENTS AS
SELECT 
  activity,
  customer,
  ts,
  _feature_json:model::STRING as model,
  _feature_json:prompt_tokens::NUMBER as prompt_tokens,
  _feature_json:completion_tokens::NUMBER as completion_tokens,
  _feature_json:latency_ms::NUMBER as latency_ms,
  _feature_json:cost_usd::NUMBER as cost_usd,
  _session_id as session_id
FROM EVENTS
WHERE activity IN ('cdesk.user_asked', 'cdesk.claude_responded');

-- SQL events view
CREATE OR REPLACE VIEW VW_SQL_EVENTS AS
SELECT 
  activity,
  customer,
  ts,
  _query_tag as query_tag,
  _feature_json:template::STRING as template,
  _feature_json:warehouse::STRING as warehouse,
  _feature_json:rows_returned::NUMBER as rows_returned,
  _feature_json:bytes_scanned::NUMBER as bytes_scanned,
  _feature_json:duration_ms::NUMBER as duration_ms,
  _session_id as session_id
FROM EVENTS
WHERE activity LIKE 'cdesk.sql_%';

-- Recent activity view
CREATE OR REPLACE VIEW VW_RECENT_ACTIVITY AS
SELECT * FROM EVENTS
WHERE ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
ORDER BY ts DESC;

-- ============================================
-- STREAMS FOR REAL-TIME PROCESSING
-- ============================================
CREATE OR REPLACE STREAM EVENTS_STREAM ON TABLE EVENTS;

-- ============================================
-- TASKS FOR SCHEDULED PROCESSING
-- ============================================

-- Task to compute temporal fields (runs every 5 minutes)
CREATE OR REPLACE TASK COMPUTE_TEMPORAL_FIELDS
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = '5 MINUTE'
AS
  MERGE INTO EVENTS t
  USING (
    SELECT 
      activity,
      customer,
      ts,
      ROW_NUMBER() OVER (PARTITION BY customer, activity ORDER BY ts) as occurrence,
      LEAD(ts) OVER (PARTITION BY customer, activity ORDER BY ts) as repeated_at
    FROM EVENTS
    WHERE ts >= DATEADD(hour, -1, CURRENT_TIMESTAMP())
  ) s
  ON t.activity = s.activity 
    AND t.customer = s.customer 
    AND t.ts = s.ts
  WHEN MATCHED THEN UPDATE SET
    t.activity_occurrence = s.occurrence,
    t.activity_repeated_at = s.repeated_at;

-- Task to refresh context cache (runs every 5 minutes)
CREATE OR REPLACE TASK REFRESH_CONTEXT_CACHE
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = '5 MINUTE'
AS
  MERGE INTO CONTEXT_CACHE t
  USING (
    SELECT 
      customer_id,
      OBJECT_AGG(
        subject || ':' || metric,
        value
      ) as context
    FROM INSIGHT_ATOMS
    WHERE ts >= DATEADD(day, -7, CURRENT_TIMESTAMP())
    GROUP BY customer_id
  ) s
  ON t.customer_id = s.customer_id
  WHEN MATCHED THEN UPDATE SET
    t.context = s.context,
    t.updated_at = CURRENT_TIMESTAMP(),
    t.version = t.version + 1
  WHEN NOT MATCHED THEN INSERT
    (customer_id, context, updated_at, version)
    VALUES (s.customer_id, s.context, CURRENT_TIMESTAMP(), 1);

-- Enable tasks (must be done by ACCOUNTADMIN)
-- ALTER TASK COMPUTE_TEMPORAL_FIELDS RESUME;
-- ALTER TASK REFRESH_CONTEXT_CACHE RESUME;

-- ============================================
-- GRANTS (Adjust based on your role setup)
-- ============================================
-- These grants assume CLAUDE_DESKTOP_ROLE exists
-- Adjust based on your actual role configuration

GRANT USAGE ON SCHEMA ACTIVITIES TO ROLE CLAUDE_DESKTOP_ROLE;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ACTIVITIES TO ROLE CLAUDE_DESKTOP_ROLE;
GRANT SELECT ON ALL VIEWS IN SCHEMA ACTIVITIES TO ROLE CLAUDE_DESKTOP_ROLE;
GRANT MONITOR, OPERATE ON ALL TASKS IN SCHEMA ACTIVITIES TO ROLE CLAUDE_DESKTOP_ROLE;

-- ============================================
-- TEST DATA (Optional - for validation)
-- ============================================
-- Insert a test event to verify setup
INSERT INTO EVENTS (
  activity,
  customer,
  ts,
  _feature_json,
  _query_tag,
  _session_id
) 
SELECT
  'cdesk.poc_test',
  'test_user',
  CURRENT_TIMESTAMP(),
  OBJECT_CONSTRUCT(
    'test', TRUE,
    'setup_complete', TRUE,
    'timestamp', CURRENT_TIMESTAMP()
  ),
  'cdesk_poc_test',
  'session_poc_001'
WHERE NOT EXISTS (
  SELECT 1 FROM EVENTS WHERE activity = 'cdesk.poc_test'
);

-- Verify the test
SELECT 
  'POC Setup Complete' as status,
  COUNT(*) as test_events_count,
  MAX(ts) as last_event_time
FROM EVENTS
WHERE activity = 'cdesk.poc_test';

-- ============================================
-- VALIDATION QUERIES
-- ============================================

-- Check table creation
SELECT 
  TABLE_NAME,
  ROW_COUNT,
  BYTES,
  CREATED
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'ACTIVITIES'
ORDER BY CREATED DESC;

-- Check view creation
SELECT 
  TABLE_NAME as VIEW_NAME,
  CREATED
FROM INFORMATION_SCHEMA.VIEWS
WHERE TABLE_SCHEMA = 'ACTIVITIES'
ORDER BY CREATED DESC;

-- Show current user and role
SELECT 
  CURRENT_USER() as username,
  CURRENT_ROLE() as role,
  CURRENT_DATABASE() as database,
  CURRENT_SCHEMA() as schema,
  CURRENT_WAREHOUSE() as warehouse;