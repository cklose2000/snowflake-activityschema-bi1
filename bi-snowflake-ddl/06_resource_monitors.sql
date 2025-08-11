-- 06_resource_monitors.sql
-- Resource monitors and credit controls for cost management

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- Daily credit monitor for BI workloads
CREATE OR REPLACE RESOURCE MONITOR bi_daily_monitor
    WITH CREDIT_QUOTA = 100  -- 100 credits per day
    FREQUENCY = DAILY
    START_TIMESTAMP = IMMEDIATELY
    TRIGGERS
        ON 50 PERCENT DO NOTIFY  -- Alert at 50% usage
        ON 75 PERCENT DO NOTIFY  -- Alert at 75% usage
        ON 90 PERCENT DO SUSPEND  -- Suspend at 90% usage
        ON 100 PERCENT DO SUSPEND_IMMEDIATE;  -- Immediate suspend at 100%

-- Weekly monitor for larger operations
CREATE OR REPLACE RESOURCE MONITOR bi_weekly_monitor
    WITH CREDIT_QUOTA = 500  -- 500 credits per week
    FREQUENCY = WEEKLY
    START_TIMESTAMP = IMMEDIATELY
    TRIGGERS
        ON 60 PERCENT DO NOTIFY
        ON 80 PERCENT DO NOTIFY
        ON 95 PERCENT DO SUSPEND
        ON 100 PERCENT DO SUSPEND_IMMEDIATE;

-- Monthly monitor for overall budget control
CREATE OR REPLACE RESOURCE MONITOR bi_monthly_monitor
    WITH CREDIT_QUOTA = 1500  -- 1500 credits per month (~$3000)
    FREQUENCY = MONTHLY
    START_TIMESTAMP = IMMEDIATELY
    TRIGGERS
        ON 50 PERCENT DO NOTIFY
        ON 70 PERCENT DO NOTIFY
        ON 85 PERCENT DO NOTIFY
        ON 95 PERCENT DO SUSPEND
        ON 100 PERCENT DO SUSPEND_IMMEDIATE;

-- Monitor for MCP server queries (strict limits)
CREATE OR REPLACE RESOURCE MONITOR mcp_query_monitor
    WITH CREDIT_QUOTA = 10  -- Very limited for MCP queries
    FREQUENCY = DAILY
    START_TIMESTAMP = IMMEDIATELY
    TRIGGERS
        ON 80 PERCENT DO NOTIFY
        ON 100 PERCENT DO SUSPEND_IMMEDIATE;

-- Monitor for batch processing jobs
CREATE OR REPLACE RESOURCE MONITOR batch_job_monitor
    WITH CREDIT_QUOTA = 50
    FREQUENCY = DAILY
    START_TIMESTAMP = IMMEDIATELY
    TRIGGERS
        ON 75 PERCENT DO NOTIFY
        ON 90 PERCENT DO SUSPEND;

-- Create warehouses with appropriate sizes and monitors

-- Extra small warehouse for MCP queries (minimal cost)
CREATE OR REPLACE WAREHOUSE MCP_WH
    WITH WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60  -- Suspend after 1 minute idle
    AUTO_RESUME = TRUE
    MIN_CLUSTER_COUNT = 1
    MAX_CLUSTER_COUNT = 1
    RESOURCE_MONITOR = mcp_query_monitor
    COMMENT = 'Warehouse for MCP server queries';

-- Small warehouse for general queries
CREATE OR REPLACE WAREHOUSE COMPUTE_WH
    WITH WAREHOUSE_SIZE = 'SMALL'
    AUTO_SUSPEND = 300  -- Suspend after 5 minutes idle
    AUTO_RESUME = TRUE
    MIN_CLUSTER_COUNT = 1
    MAX_CLUSTER_COUNT = 2
    SCALING_POLICY = 'STANDARD'
    RESOURCE_MONITOR = bi_daily_monitor
    COMMENT = 'General compute warehouse for BI';

-- Medium warehouse for batch jobs
CREATE OR REPLACE WAREHOUSE BATCH_WH
    WITH WAREHOUSE_SIZE = 'MEDIUM'
    AUTO_SUSPEND = 60  -- Quick suspend for batch jobs
    AUTO_RESUME = TRUE
    MIN_CLUSTER_COUNT = 1
    MAX_CLUSTER_COUNT = 1
    RESOURCE_MONITOR = batch_job_monitor
    COMMENT = 'Warehouse for batch processing';

-- Assign warehouses to resource monitors
ALTER WAREHOUSE MCP_WH SET RESOURCE_MONITOR = mcp_query_monitor;
ALTER WAREHOUSE COMPUTE_WH SET RESOURCE_MONITOR = bi_daily_monitor;
ALTER WAREHOUSE BATCH_WH SET RESOURCE_MONITOR = batch_job_monitor;

-- Create notification integration for alerts (requires setup)
-- CREATE OR REPLACE NOTIFICATION INTEGRATION bi_email_notifications
--     TYPE = EMAIL
--     ENABLED = TRUE
--     ALLOWED_RECIPIENTS = ('bi-team@example.com', 'ops@example.com')
--     COMMENT = 'Email notifications for resource monitor alerts';

-- Query timeout settings for different workloads
ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 30;  -- 30 second timeout for MCP
ALTER SESSION SET STATEMENT_QUEUED_TIMEOUT_IN_SECONDS = 60;  -- 1 minute queue timeout

-- Create a view to monitor credit usage
CREATE OR REPLACE VIEW V_CREDIT_USAGE AS
SELECT
    DATE_TRUNC('day', START_TIME) as usage_date,
    WAREHOUSE_NAME,
    SUM(CREDITS_USED) as daily_credits,
    SUM(CREDITS_USED_COMPUTE) as compute_credits,
    SUM(CREDITS_USED_CLOUD_SERVICES) as cloud_service_credits,
    COUNT(*) as query_count,
    AVG(EXECUTION_TIME) / 1000 as avg_execution_seconds,
    MAX(EXECUTION_TIME) / 1000 as max_execution_seconds
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE START_TIME >= DATEADD('day', -30, CURRENT_DATE())
GROUP BY DATE_TRUNC('day', START_TIME), WAREHOUSE_NAME
ORDER BY usage_date DESC, daily_credits DESC;

-- View for monitoring expensive queries
CREATE OR REPLACE VIEW V_EXPENSIVE_QUERIES AS
SELECT
    QUERY_ID,
    QUERY_TEXT,
    USER_NAME,
    WAREHOUSE_NAME,
    START_TIME,
    END_TIME,
    EXECUTION_TIME / 1000 as execution_seconds,
    CREDITS_USED_CLOUD_SERVICES,
    ROWS_PRODUCED,
    BYTES_SCANNED / (1024*1024*1024) as gb_scanned
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE CREDITS_USED_CLOUD_SERVICES > 0.1  -- Queries using > 0.1 credits
    AND START_TIME >= DATEADD('day', -7, CURRENT_DATE())
    AND QUERY_TAG LIKE 'cdesk%'
ORDER BY CREDITS_USED_CLOUD_SERVICES DESC
LIMIT 100;

-- Alert procedure for credit overuse
CREATE OR REPLACE PROCEDURE check_credit_usage()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
    daily_usage FLOAT;
    daily_limit FLOAT := 100;  -- Daily credit limit
    alert_message STRING;
BEGIN
    -- Get today's credit usage
    SELECT SUM(CREDITS_USED) INTO :daily_usage
    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
    WHERE DATE_TRUNC('day', START_TIME) = CURRENT_DATE();
    
    IF (daily_usage > daily_limit * 0.8) THEN
        alert_message := 'WARNING: Daily credit usage at ' || ROUND(daily_usage, 2) || 
                        ' credits (' || ROUND(100 * daily_usage / daily_limit, 1) || '% of limit)';
        
        -- Log alert
        INSERT INTO SECURITY_AUDIT_LOG (audit_id, ts, event_type, action, result, threat_level, details)
        VALUES (UUID_STRING(), CURRENT_TIMESTAMP(), 'CREDIT_ALERT', 'HIGH_USAGE_DETECTED', 
                alert_message, 'MEDIUM', OBJECT_CONSTRUCT('usage', daily_usage, 'limit', daily_limit));
        
        RETURN alert_message;
    END IF;
    
    RETURN 'Credit usage within limits: ' || ROUND(daily_usage, 2) || ' credits used today';
END;
$$;

-- Schedule credit check task
CREATE OR REPLACE TASK monitor_credit_usage
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = 'USING CRON 0 */4 * * * UTC'  -- Every 4 hours
AS
    CALL check_credit_usage();

-- Enable the monitoring task
ALTER TASK monitor_credit_usage RESUME;

-- Grant permissions
GRANT MONITOR ON ALL RESOURCE MONITORS IN ACCOUNT TO ROLE BI_ADMIN;
GRANT MODIFY ON WAREHOUSE MCP_WH TO ROLE MCP_SERVICE;
GRANT USAGE ON WAREHOUSE MCP_WH TO ROLE MCP_SERVICE;
GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE PUBLIC;
GRANT USAGE ON WAREHOUSE BATCH_WH TO ROLE BI_ADMIN;