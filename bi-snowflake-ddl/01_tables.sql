-- 01_tables.sql [DEPRECATED - Use 00_master_v2_compliant.sql instead]
-- This file has been replaced with strict ActivitySchema v2.0 compliant DDL
-- See sql/ddl_analytics_activity_events.sql for the new structure
-- 
-- IMPORTANT: The new structure separates spec-compliant fields from extensions:
-- - analytics.activity.events: Core v2.0 fields only
-- - analytics.activity_cdesk.*: Claude Desktop specific extensions
-- 
-- To migrate, run: 00_master_v2_compliant.sql

-- Use the CLAUDE_LOGS database
CREATE DATABASE IF NOT EXISTS CLAUDE_LOGS;
USE DATABASE CLAUDE_LOGS;

CREATE SCHEMA IF NOT EXISTS ACTIVITIES;
USE SCHEMA ACTIVITIES;

-- Main activity stream table
CREATE TABLE IF NOT EXISTS CLAUDE_STREAM (
    -- Core ActivitySchema columns
    activity_id STRING NOT NULL,
    ts TIMESTAMP_NTZ NOT NULL,
    activity STRING NOT NULL,
    customer STRING,
    anonymous_customer_id STRING,
    feature_json VARIANT,
    revenue_impact FLOAT,
    link STRING,
    
    -- Helper columns for temporal analysis
    activity_occurrence INT,
    activity_repeated_at TIMESTAMP_NTZ,
    
    -- Constraints
    PRIMARY KEY (activity_id),
    UNIQUE (activity, ts, customer)
) CLUSTER BY (activity, ts);

-- Insight atoms for structured memory
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

-- Context cache for fast retrieval
CREATE TABLE IF NOT EXISTS CONTEXT_CACHE (
    customer_id STRING NOT NULL PRIMARY KEY,
    context VARIANT NOT NULL,
    updated_at TIMESTAMP_NTZ NOT NULL,
    version INT NOT NULL DEFAULT 1
);

-- Artifacts for large results
CREATE TABLE IF NOT EXISTS ARTIFACTS (
    artifact_id STRING NOT NULL PRIMARY KEY,
    customer_id STRING NOT NULL,
    s3_url STRING NOT NULL,
    size_bytes INT NOT NULL,
    content_type STRING,
    created_at TIMESTAMP_NTZ NOT NULL,
    expires_at TIMESTAMP_NTZ
);

-- Query audit log
CREATE TABLE IF NOT EXISTS QUERY_AUDIT_LOG (
    query_id STRING NOT NULL PRIMARY KEY,
    template_name STRING NOT NULL,
    parameters VARIANT,
    customer_id STRING,
    executed_at TIMESTAMP_NTZ NOT NULL,
    execution_time_ms INT,
    rows_affected INT,
    error_message STRING
);

-- Provenance chain for tracking query lineage
CREATE TABLE IF NOT EXISTS PROVENANCE_CHAIN (
    query_hash STRING NOT NULL PRIMARY KEY,
    template_name STRING,
    query_text STRING,
    parameters VARIANT,
    created_at TIMESTAMP_NTZ NOT NULL,
    created_by STRING
);

-- Security audit log
CREATE TABLE IF NOT EXISTS SECURITY_AUDIT_LOG (
    audit_id STRING NOT NULL PRIMARY KEY,
    ts TIMESTAMP_NTZ NOT NULL,
    event_type STRING NOT NULL,
    customer_id STRING,
    ip_address STRING,
    user_agent STRING,
    action STRING,
    result STRING,
    threat_level STRING,
    details VARIANT
);

-- Enable auto-clustering for large tables
ALTER TABLE CLAUDE_STREAM SET AUTO_RECLUSTERING = TRUE;
ALTER TABLE INSIGHT_ATOMS SET AUTO_RECLUSTERING = TRUE;

-- Set data retention (90 days for main stream, adjust as needed)
ALTER TABLE CLAUDE_STREAM SET DATA_RETENTION_TIME_IN_DAYS = 90;
ALTER TABLE INSIGHT_ATOMS SET DATA_RETENTION_TIME_IN_DAYS = 180;
ALTER TABLE QUERY_AUDIT_LOG SET DATA_RETENTION_TIME_IN_DAYS = 30;

-- Grant basic permissions
GRANT USAGE ON DATABASE CLAUDE_LOGS TO ROLE PUBLIC;
GRANT USAGE ON SCHEMA ACTIVITIES TO ROLE PUBLIC;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ACTIVITIES TO ROLE PUBLIC;