-- Master DDL Script for ActivitySchema v2.0 Compliant BI System
-- This script creates all necessary objects for strict v2.0 compliance
-- while maintaining Claude Desktop specific extensions

-- ========================================
-- 1. CREATE DATABASE AND BASE SCHEMA
-- ========================================
CREATE DATABASE IF NOT EXISTS ANALYTICS;
USE DATABASE ANALYTICS;

-- ========================================
-- 2. CORE ACTIVITY SCHEMA (v2.0 COMPLIANT)
-- ========================================
!source sql/ddl_analytics_activity_events.sql

-- ========================================
-- 3. CLAUDE DESKTOP EXTENSIONS
-- ========================================
!source sql/ddl_activity_cdesk_extensions.sql

-- ========================================
-- 4. STREAMS AND TASKS
-- ========================================
!source sql/ddl_streams_tasks.sql

-- ========================================
-- 5. TYPED VIEWS
-- ========================================
!source sql/ddl_typed_views.sql

-- ========================================
-- 6. GOVERNANCE POLICIES
-- ========================================
!source sql/ddl_governance.sql

-- ========================================
-- 7. ACTIVATE TASKS
-- ========================================
ALTER TASK analytics.activity_cdesk.t_refresh_context RESUME;
ALTER TASK analytics.activity_cdesk.t_derivations RESUME;

-- ========================================
-- 8. GRANT PERMISSIONS
-- ========================================
GRANT USAGE ON DATABASE ANALYTICS TO ROLE PUBLIC;
GRANT USAGE ON SCHEMA analytics.activity TO ROLE PUBLIC;
GRANT USAGE ON SCHEMA analytics.activity_cdesk TO ROLE PUBLIC;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA analytics.activity TO ROLE PUBLIC;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA analytics.activity_cdesk TO ROLE PUBLIC;
GRANT SELECT ON ALL VIEWS IN SCHEMA analytics.activity TO ROLE PUBLIC;
GRANT SELECT ON ALL VIEWS IN SCHEMA analytics.activity_cdesk TO ROLE PUBLIC;

-- ========================================
-- VERIFICATION QUERIES
-- ========================================
-- Check that all objects were created successfully
SELECT 'Tables Created:' as check_type;
SHOW TABLES IN SCHEMA analytics.activity;
SHOW TABLES IN SCHEMA analytics.activity_cdesk;

SELECT 'Views Created:' as check_type;
SHOW VIEWS IN SCHEMA analytics.activity;
SHOW VIEWS IN SCHEMA analytics.activity_cdesk;

SELECT 'Streams Created:' as check_type;
SHOW STREAMS IN SCHEMA analytics.activity_cdesk;

SELECT 'Tasks Created:' as check_type;
SHOW TASKS IN SCHEMA analytics.activity_cdesk;

-- Test insert into main events table
INSERT INTO analytics.activity.events (
    activity, customer, ts, activity_occurrence,
    link, revenue_impact,
    _feature_json, _source_system, _source_version, _session_id, _query_tag
) 
SELECT 
    'cdesk.system_initialized',
    'system',
    CURRENT_TIMESTAMP(),
    1,
    NULL,
    0,
    OBJECT_CONSTRUCT('test', TRUE, 'version', '2.0'),
    'claude_desktop',
    '2.0',
    'init_session',
    'cdesk'
WHERE NOT EXISTS (
    SELECT 1 FROM analytics.activity.events 
    WHERE activity = 'cdesk.system_initialized' 
    AND customer = 'system'
);

SELECT 'ActivitySchema v2.0 Compliance Setup Complete!' as status;