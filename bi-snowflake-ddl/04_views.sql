-- 04_views.sql  
-- Views for analytics and reporting

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- View for Claude-specific activities
CREATE OR REPLACE VIEW V_CLAUDE_ACTIVITIES AS
SELECT 
    activity_id,
    ts,
    activity,
    customer as session_id,
    anonymous_customer_id as host_id,
    feature_json:tool_name::STRING as tool_name,
    feature_json:command::STRING as command,
    feature_json:parameters as parameters,
    feature_json:result_type::STRING as result_type,
    feature_json:error_message::STRING as error_message,
    feature_json:duration_ms::INT as duration_ms,
    feature_json:tokens_used::INT as tokens_used,
    feature_json:confidence_score::FLOAT as confidence_score,
    feature_json:project_path::STRING as project_path,
    feature_json:git_branch::STRING as git_branch,
    feature_json:file_path::STRING as file_path,
    feature_json,
    revenue_impact,
    link
FROM CLAUDE_STREAM
WHERE activity LIKE 'claude_%' OR activity LIKE 'ccode_%';

-- Recent activities view
CREATE OR REPLACE VIEW V_RECENT_ACTIVITIES AS
SELECT 
    activity_id,
    ts,
    activity,
    customer,
    anonymous_customer_id,
    feature_json,
    revenue_impact,
    link,
    TIMEDIFF(second, ts, CURRENT_TIMESTAMP()) as seconds_ago,
    TIMEDIFF(minute, ts, CURRENT_TIMESTAMP()) as minutes_ago
FROM CLAUDE_STREAM
WHERE ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
ORDER BY ts DESC;

-- Activity statistics view
CREATE OR REPLACE VIEW V_ACTIVITY_STATS AS
SELECT 
    activity,
    DATE_TRUNC('hour', ts) as hour,
    COUNT(*) as activity_count,
    COUNT(DISTINCT customer) as unique_sessions,
    AVG(feature_json:duration_ms::INT) as avg_duration_ms,
    SUM(revenue_impact) as total_revenue_impact,
    MAX(ts) as last_occurrence
FROM CLAUDE_STREAM
GROUP BY activity, DATE_TRUNC('hour', ts);

-- Session summary materialized view
CREATE OR REPLACE MATERIALIZED VIEW MV_CLAUDE_SESSIONS AS
SELECT 
    customer as session_id,
    MIN(CASE WHEN activity = 'claude_session_start' THEN ts END) as session_start,
    MAX(CASE WHEN activity = 'claude_session_end' THEN ts END) as session_end,
    COUNT(*) as total_activities,
    COUNT(DISTINCT activity) as unique_activity_types,
    SUM(CASE WHEN activity = 'claude_tool_call' THEN 1 ELSE 0 END) as tool_calls,
    SUM(CASE WHEN activity = 'claude_error' THEN 1 ELSE 0 END) as errors,
    SUM(feature_json:tokens_used::INT) as total_tokens,
    SUM(revenue_impact) as total_cost,
    ARRAY_AGG(DISTINCT feature_json:tool_name::STRING) as tools_used,
    MAX(feature_json:project_path::STRING) as project_path
FROM CLAUDE_STREAM
WHERE activity LIKE 'claude_%'
GROUP BY customer;

-- LLM events view
CREATE OR REPLACE VIEW VW_LLM_EVENTS AS
SELECT
    activity_id,
    ts,
    customer as session_id,
    feature_json:model::STRING as model,
    feature_json:prompt_tokens::INT as prompt_tokens,
    feature_json:completion_tokens::INT as completion_tokens,
    feature_json:total_tokens::INT as total_tokens,
    feature_json:latency_ms::INT as latency_ms,
    revenue_impact as cost,
    feature_json
FROM CLAUDE_STREAM
WHERE activity IN ('claude_completion', 'llm_call', 'model_inference');

-- SQL events view
CREATE OR REPLACE VIEW VW_SQL_EVENTS AS
SELECT
    activity_id,
    ts,
    customer,
    feature_json:template_name::STRING as template_name,
    feature_json:query_hash::STRING as query_hash,
    feature_json:execution_time_ms::INT as execution_time_ms,
    feature_json:rows_affected::INT as rows_affected,
    feature_json:warehouse::STRING as warehouse,
    feature_json:credits_used::FLOAT as credits_used,
    feature_json
FROM CLAUDE_STREAM
WHERE activity LIKE '%_query_%' OR activity = 'sql_execution';

-- Product metrics view
CREATE OR REPLACE VIEW VW_PRODUCT_METRICS AS
SELECT
    DATE_TRUNC('day', ts) as date,
    COUNT(DISTINCT customer) as daily_active_users,
    COUNT(*) as total_events,
    SUM(CASE WHEN activity = 'claude_session_start' THEN 1 ELSE 0 END) as sessions_started,
    SUM(CASE WHEN activity = 'claude_tool_call' THEN 1 ELSE 0 END) as tool_calls,
    SUM(CASE WHEN activity LIKE '%error%' THEN 1 ELSE 0 END) as errors,
    SUM(revenue_impact) as daily_revenue,
    AVG(feature_json:duration_ms::INT) as avg_operation_time_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY feature_json:duration_ms::INT) as p95_duration_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY feature_json:duration_ms::INT) as p99_duration_ms
FROM CLAUDE_STREAM
GROUP BY DATE_TRUNC('day', ts);

-- Funnel analysis view
CREATE OR REPLACE VIEW V_USER_FUNNEL AS
WITH funnel_steps AS (
    SELECT
        customer,
        MAX(CASE WHEN activity = 'claude_session_start' THEN 1 ELSE 0 END) as started_session,
        MAX(CASE WHEN activity = 'claude_tool_call' THEN 1 ELSE 0 END) as used_tool,
        MAX(CASE WHEN activity = 'claude_file_operation' THEN 1 ELSE 0 END) as modified_file,
        MAX(CASE WHEN activity = 'claude_session_end' THEN 1 ELSE 0 END) as completed_session
    FROM CLAUDE_STREAM
    GROUP BY customer
)
SELECT
    COUNT(*) as total_users,
    SUM(started_session) as started,
    SUM(started_session * used_tool) as started_and_used_tool,
    SUM(started_session * used_tool * modified_file) as modified_files,
    SUM(started_session * used_tool * modified_file * completed_session) as completed_full_flow,
    ROUND(100.0 * SUM(used_tool) / NULLIF(SUM(started_session), 0), 2) as tool_usage_rate,
    ROUND(100.0 * SUM(modified_file) / NULLIF(SUM(used_tool), 0), 2) as file_modification_rate,
    ROUND(100.0 * SUM(completed_session) / NULLIF(SUM(started_session), 0), 2) as completion_rate
FROM funnel_steps;

-- Error analysis view
CREATE OR REPLACE VIEW V_ERROR_ANALYSIS AS
SELECT
    DATE_TRUNC('hour', ts) as error_hour,
    activity,
    feature_json:error_type::STRING as error_type,
    feature_json:error_message::STRING as error_message,
    COUNT(*) as error_count,
    COUNT(DISTINCT customer) as affected_users,
    ARRAY_AGG(DISTINCT feature_json:stack_trace::STRING) as stack_traces
FROM CLAUDE_STREAM
WHERE activity LIKE '%error%' OR feature_json:error_message IS NOT NULL
GROUP BY DATE_TRUNC('hour', ts), activity, error_type, error_message
ORDER BY error_hour DESC, error_count DESC;

-- Grant permissions on views
GRANT SELECT ON ALL VIEWS IN SCHEMA ACTIVITIES TO ROLE PUBLIC;
GRANT SELECT ON ALL MATERIALIZED VIEWS IN SCHEMA ACTIVITIES TO ROLE PUBLIC;