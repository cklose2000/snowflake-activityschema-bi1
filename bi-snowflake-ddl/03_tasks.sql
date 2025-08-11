-- 03_tasks.sql
-- Snowflake Tasks for automated processing

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- Task to refresh context cache from activity stream
CREATE OR REPLACE TASK REFRESH_CONTEXT_CACHE
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = 'USING CRON */5 * * * * UTC'  -- Every 5 minutes
WHEN
    SYSTEM$STREAM_HAS_DATA('S_CLAUDE_STREAM')
AS
    MERGE INTO CONTEXT_CACHE AS target
    USING (
        SELECT 
            customer,
            OBJECT_AGG(activity, feature_json) WITHIN GROUP (ORDER BY ts DESC) as context,
            MAX(ts) as last_activity
        FROM S_CLAUDE_STREAM
        WHERE customer IS NOT NULL
        GROUP BY customer
    ) AS source
    ON target.customer_id = source.customer
    WHEN MATCHED THEN UPDATE SET
        context = source.context,
        updated_at = CURRENT_TIMESTAMP(),
        version = target.version + 1
    WHEN NOT MATCHED THEN INSERT
        (customer_id, context, updated_at, version)
        VALUES (source.customer, source.context, CURRENT_TIMESTAMP(), 1);

-- Task to aggregate insight atoms
CREATE OR REPLACE TASK AGGREGATE_INSIGHTS
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = 'USING CRON */10 * * * * UTC'  -- Every 10 minutes
WHEN
    SYSTEM$STREAM_HAS_DATA('S_INSIGHT_ATOMS')
AS
    INSERT INTO INSIGHT_ATOMS (atom_id, customer_id, subject, metric, value, provenance_query_hash, ts)
    SELECT 
        UUID_STRING() as atom_id,
        customer_id,
        subject,
        metric || '_aggregated' as metric,
        OBJECT_AGG(metric, value) as value,
        MD5(CONCAT(subject, metric)) as provenance_query_hash,
        CURRENT_TIMESTAMP() as ts
    FROM S_INSIGHT_ATOMS
    GROUP BY customer_id, subject, metric;

-- Task to clean up expired artifacts
CREATE OR REPLACE TASK CLEANUP_EXPIRED_ARTIFACTS
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = 'USING CRON 0 2 * * * UTC'  -- Daily at 2 AM UTC
AS
    DELETE FROM ARTIFACTS
    WHERE expires_at < CURRENT_TIMESTAMP()
        AND expires_at IS NOT NULL;

-- Task to update activity occurrences
CREATE OR REPLACE TASK UPDATE_ACTIVITY_OCCURRENCES
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = 'USING CRON */30 * * * * UTC'  -- Every 30 minutes
AS
BEGIN
    -- Update activity_occurrence for new activities
    UPDATE CLAUDE_STREAM t1
    SET activity_occurrence = (
        SELECT COUNT(*)
        FROM CLAUDE_STREAM t2
        WHERE t2.customer = t1.customer
            AND t2.activity = t1.activity
            AND t2.ts <= t1.ts
    )
    WHERE t1.activity_occurrence IS NULL;
    
    -- Update activity_repeated_at
    UPDATE CLAUDE_STREAM t1
    SET activity_repeated_at = (
        SELECT MIN(t2.ts)
        FROM CLAUDE_STREAM t2
        WHERE t2.customer = t1.customer
            AND t2.activity = t1.activity
            AND t2.ts > t1.ts
    )
    WHERE t1.activity_repeated_at IS NULL;
END;

-- Task to monitor security events
CREATE OR REPLACE TASK MONITOR_SECURITY_EVENTS
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = 'USING CRON */1 * * * * UTC'  -- Every minute
WHEN
    SYSTEM$STREAM_HAS_DATA('S_SECURITY_AUDIT')
AS
BEGIN
    -- Check for critical security events
    LET critical_events := (
        SELECT COUNT(*) 
        FROM S_SECURITY_AUDIT 
        WHERE threat_level = 'CRITICAL'
    );
    
    IF (:critical_events > 0) THEN
        -- In production, this would trigger an alert
        INSERT INTO SECURITY_AUDIT_LOG (audit_id, ts, event_type, customer_id, action, result, threat_level, details)
        VALUES (UUID_STRING(), CURRENT_TIMESTAMP(), 'ALERT_TRIGGERED', 'SYSTEM', 'CRITICAL_EVENTS_DETECTED', 
                'NOTIFIED', 'HIGH', OBJECT_CONSTRUCT('count', :critical_events));
    END IF;
END;

-- Enable all tasks (must be done after creation)
ALTER TASK REFRESH_CONTEXT_CACHE RESUME;
ALTER TASK AGGREGATE_INSIGHTS RESUME;
ALTER TASK CLEANUP_EXPIRED_ARTIFACTS RESUME;
ALTER TASK UPDATE_ACTIVITY_OCCURRENCES RESUME;
ALTER TASK MONITOR_SECURITY_EVENTS RESUME;

-- Grant permissions
GRANT MONITOR, OPERATE ON ALL TASKS IN SCHEMA ACTIVITIES TO ROLE PUBLIC;