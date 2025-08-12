-- ============================================
-- MULTI-ACCOUNT AUTHENTICATION SETUP
-- ============================================
-- This script creates backup service accounts to prevent lockouts
-- Run this with ACCOUNTADMIN or USERADMIN privileges

-- Switch to appropriate role
USE ROLE ACCOUNTADMIN;

-- ============================================
-- CREATE BACKUP SERVICE ACCOUNTS
-- ============================================

-- Primary account (already exists): CLAUDE_DESKTOP1
-- Create backup accounts for failover

-- Backup account #1
CREATE USER IF NOT EXISTS CLAUDE_DESKTOP2
  PASSWORD = 'Password123!' -- Use same password for consistency
  DEFAULT_ROLE = 'CLAUDE_DESKTOP_ROLE'
  DEFAULT_WAREHOUSE = 'COMPUTE_WH'
  DEFAULT_NAMESPACE = 'CLAUDE_LOGS.ACTIVITIES'
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'Claude Desktop Backup Account #1 - Auto-failover';

-- Test account for isolated testing
CREATE USER IF NOT EXISTS CLAUDE_DESKTOP_TEST
  PASSWORD = 'Password123!'
  DEFAULT_ROLE = 'CLAUDE_DESKTOP_ROLE'
  DEFAULT_WAREHOUSE = 'COMPUTE_WH'
  DEFAULT_NAMESPACE = 'CLAUDE_LOGS.ACTIVITIES'
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'Claude Desktop Test Account - Isolated testing environment';

-- Admin account for unlocking operations
CREATE USER IF NOT EXISTS CLAUDE_DESKTOP_ADMIN
  PASSWORD = 'Password123!'
  DEFAULT_ROLE = 'CLAUDE_DESKTOP_ROLE'
  DEFAULT_WAREHOUSE = 'COMPUTE_WH'
  DEFAULT_NAMESPACE = 'CLAUDE_LOGS.ACTIVITIES'
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'Claude Desktop Admin Account - Account unlock capabilities';

-- ============================================
-- GRANT SAME PERMISSIONS TO ALL ACCOUNTS
-- ============================================

-- Grant role to all accounts
GRANT ROLE CLAUDE_DESKTOP_ROLE TO USER CLAUDE_DESKTOP1;
GRANT ROLE CLAUDE_DESKTOP_ROLE TO USER CLAUDE_DESKTOP2;
GRANT ROLE CLAUDE_DESKTOP_ROLE TO USER CLAUDE_DESKTOP_TEST;
GRANT ROLE CLAUDE_DESKTOP_ROLE TO USER CLAUDE_DESKTOP_ADMIN;

-- Grant additional admin privileges to admin account
GRANT ROLE USERADMIN TO USER CLAUDE_DESKTOP_ADMIN;

-- ============================================
-- CREATE AUTHENTICATION MONITORING TABLE
-- ============================================

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- Table to track authentication events and lockouts
CREATE TABLE IF NOT EXISTS AUTH_EVENTS (
  event_id                 STRING           PRIMARY KEY,
  account_name             STRING           NOT NULL,
  event_type               STRING           NOT NULL,    -- 'success', 'failure', 'lockout', 'unlock'
  source_ip                STRING,
  user_agent               STRING,
  error_message            STRING,
  connection_id            STRING,
  ts                       TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP(),
  _ingested_at             TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY (account_name, ts);

-- Account health status table
CREATE TABLE IF NOT EXISTS ACCOUNT_HEALTH (
  account_name             STRING           PRIMARY KEY,
  is_locked                BOOLEAN          DEFAULT FALSE,
  failure_count            NUMBER           DEFAULT 0,
  last_failure_at          TIMESTAMP_NTZ,
  last_success_at          TIMESTAMP_NTZ,
  consecutive_failures     NUMBER           DEFAULT 0,
  last_health_check        TIMESTAMP_NTZ,
  priority                 NUMBER           DEFAULT 1,    -- 1=primary, 2=backup, etc.
  status                   STRING           DEFAULT 'active', -- 'active', 'cooldown', 'disabled'
  updated_at               TIMESTAMP_NTZ    DEFAULT CURRENT_TIMESTAMP()
);

-- Initialize account health records
INSERT INTO ACCOUNT_HEALTH (account_name, priority, status)
SELECT * FROM VALUES
  ('CLAUDE_DESKTOP1', 1, 'active'),
  ('CLAUDE_DESKTOP2', 2, 'active'),
  ('CLAUDE_DESKTOP_TEST', 3, 'active'),
  ('CLAUDE_DESKTOP_ADMIN', 4, 'active')
AS t(account_name, priority, status)
WHERE NOT EXISTS (
  SELECT 1 FROM ACCOUNT_HEALTH WHERE account_name = t.account_name
);

-- ============================================
-- VIEWS FOR MONITORING
-- ============================================

-- Active account status view
CREATE OR REPLACE VIEW VW_ACCOUNT_STATUS AS
SELECT 
  account_name,
  is_locked,
  consecutive_failures,
  CASE 
    WHEN is_locked THEN 'LOCKED'
    WHEN consecutive_failures >= 3 THEN 'CRITICAL'
    WHEN consecutive_failures >= 1 THEN 'WARNING'
    ELSE 'HEALTHY'
  END as health_status,
  last_success_at,
  last_failure_at,
  priority,
  status,
  updated_at
FROM ACCOUNT_HEALTH
ORDER BY priority;

-- Recent authentication events view
CREATE OR REPLACE VIEW VW_AUTH_EVENTS_RECENT AS
SELECT 
  account_name,
  event_type,
  error_message,
  source_ip,
  ts
FROM AUTH_EVENTS
WHERE ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
ORDER BY ts DESC;

-- Account failure summary
CREATE OR REPLACE VIEW VW_ACCOUNT_FAILURES AS
SELECT 
  account_name,
  COUNT(*) as total_failures,
  COUNT(CASE WHEN ts >= DATEADD(hour, -1, CURRENT_TIMESTAMP()) THEN 1 END) as failures_last_hour,
  COUNT(CASE WHEN ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP()) THEN 1 END) as failures_last_24h,
  MAX(ts) as last_failure
FROM AUTH_EVENTS
WHERE event_type = 'failure'
GROUP BY account_name
ORDER BY total_failures DESC;

-- ============================================
-- STORED PROCEDURES FOR ACCOUNT MANAGEMENT
-- ============================================

-- Procedure to unlock an account
CREATE OR REPLACE PROCEDURE SP_UNLOCK_ACCOUNT(ACCOUNT_NAME STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
BEGIN
  -- Update account health status
  UPDATE ACCOUNT_HEALTH 
  SET 
    is_locked = FALSE,
    consecutive_failures = 0,
    status = 'active',
    updated_at = CURRENT_TIMESTAMP()
  WHERE account_name = :ACCOUNT_NAME;
  
  -- Log unlock event
  INSERT INTO AUTH_EVENTS (
    event_id, account_name, event_type, ts
  ) VALUES (
    UUID_STRING(), :ACCOUNT_NAME, 'unlock', CURRENT_TIMESTAMP()
  );
  
  RETURN 'Account ' || :ACCOUNT_NAME || ' unlocked successfully';
END;
$$;

-- Procedure to mark account as locked
CREATE OR REPLACE PROCEDURE SP_LOCK_ACCOUNT(ACCOUNT_NAME STRING, ERROR_MSG STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
BEGIN
  -- Update account health status
  UPDATE ACCOUNT_HEALTH 
  SET 
    is_locked = TRUE,
    last_failure_at = CURRENT_TIMESTAMP(),
    consecutive_failures = consecutive_failures + 1,
    status = 'locked',
    updated_at = CURRENT_TIMESTAMP()
  WHERE account_name = :ACCOUNT_NAME;
  
  -- Log lockout event
  INSERT INTO AUTH_EVENTS (
    event_id, account_name, event_type, error_message, ts
  ) VALUES (
    UUID_STRING(), :ACCOUNT_NAME, 'lockout', :ERROR_MSG, CURRENT_TIMESTAMP()
  );
  
  RETURN 'Account ' || :ACCOUNT_NAME || ' marked as locked';
END;
$$;

-- Procedure to record successful authentication
CREATE OR REPLACE PROCEDURE SP_AUTH_SUCCESS(ACCOUNT_NAME STRING, CONNECTION_ID STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
BEGIN
  -- Update account health status
  UPDATE ACCOUNT_HEALTH 
  SET 
    is_locked = FALSE,
    failure_count = 0,
    consecutive_failures = 0,
    last_success_at = CURRENT_TIMESTAMP(),
    last_health_check = CURRENT_TIMESTAMP(),
    status = 'active',
    updated_at = CURRENT_TIMESTAMP()
  WHERE account_name = :ACCOUNT_NAME;
  
  -- Log success event
  INSERT INTO AUTH_EVENTS (
    event_id, account_name, event_type, connection_id, ts
  ) VALUES (
    UUID_STRING(), :ACCOUNT_NAME, 'success', :CONNECTION_ID, CURRENT_TIMESTAMP()
  );
  
  RETURN 'Authentication success recorded for ' || :ACCOUNT_NAME;
END;
$$;

-- Procedure to record authentication failure
CREATE OR REPLACE PROCEDURE SP_AUTH_FAILURE(ACCOUNT_NAME STRING, ERROR_MSG STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
BEGIN
  -- Update account health status
  UPDATE ACCOUNT_HEALTH 
  SET 
    failure_count = failure_count + 1,
    consecutive_failures = consecutive_failures + 1,
    last_failure_at = CURRENT_TIMESTAMP(),
    last_health_check = CURRENT_TIMESTAMP(),
    -- Lock if too many consecutive failures
    is_locked = CASE WHEN consecutive_failures >= 2 THEN TRUE ELSE is_locked END,
    status = CASE WHEN consecutive_failures >= 2 THEN 'locked' ELSE 'active' END,
    updated_at = CURRENT_TIMESTAMP()
  WHERE account_name = :ACCOUNT_NAME;
  
  -- Log failure event
  INSERT INTO AUTH_EVENTS (
    event_id, account_name, event_type, error_message, ts
  ) VALUES (
    UUID_STRING(), :ACCOUNT_NAME, 'failure', :ERROR_MSG, CURRENT_TIMESTAMP()
  );
  
  RETURN 'Authentication failure recorded for ' || :ACCOUNT_NAME;
END;
$$;

-- ============================================
-- GRANTS FOR AUTH MONITORING
-- ============================================

GRANT SELECT, INSERT, UPDATE ON TABLE AUTH_EVENTS TO ROLE CLAUDE_DESKTOP_ROLE;
GRANT SELECT, UPDATE ON TABLE ACCOUNT_HEALTH TO ROLE CLAUDE_DESKTOP_ROLE;
GRANT SELECT ON ALL VIEWS IN SCHEMA ACTIVITIES TO ROLE CLAUDE_DESKTOP_ROLE;
GRANT USAGE ON ALL PROCEDURES IN SCHEMA ACTIVITIES TO ROLE CLAUDE_DESKTOP_ROLE;

-- ============================================
-- VALIDATION
-- ============================================

-- Check all accounts are created and active
SELECT 
  'Account Status Check' as validation,
  account_name,
  health_status,
  priority,
  status
FROM VW_ACCOUNT_STATUS;

-- Show current grants for the role
SHOW GRANTS TO ROLE CLAUDE_DESKTOP_ROLE;

-- Test connection with primary account
SELECT 
  'Primary Account Test' as test,
  CURRENT_USER() as current_user,
  CURRENT_ROLE() as current_role,
  CURRENT_TIMESTAMP() as test_time;