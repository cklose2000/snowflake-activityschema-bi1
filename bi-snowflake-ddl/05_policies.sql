-- 05_policies.sql
-- Row-level security and data masking policies

USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- Row Access Policy for customer isolation
CREATE OR REPLACE ROW ACCESS POLICY customer_isolation AS
    (customer_id STRING) RETURNS BOOLEAN ->
    CASE
        -- Admin roles can see all data
        WHEN CURRENT_ROLE() IN ('ACCOUNTADMIN', 'SECURITYADMIN', 'BI_ADMIN') THEN TRUE
        -- Service accounts can see all data
        WHEN CURRENT_USER() IN ('BI_SERVICE_ACCOUNT', 'MCP_SERVICE') THEN TRUE
        -- Regular users can only see their own data
        WHEN customer_id = CURRENT_SESSION_VARIABLE('CUSTOMER_ID') THEN TRUE
        -- Default deny
        ELSE FALSE
    END;

-- Apply customer isolation to main tables
ALTER TABLE CLAUDE_STREAM ADD ROW ACCESS POLICY customer_isolation ON (customer);
ALTER TABLE INSIGHT_ATOMS ADD ROW ACCESS POLICY customer_isolation ON (customer_id);
ALTER TABLE CONTEXT_CACHE ADD ROW ACCESS POLICY customer_isolation ON (customer_id);
ALTER TABLE ARTIFACTS ADD ROW ACCESS POLICY customer_isolation ON (customer_id);

-- Masking policy for PII data
CREATE OR REPLACE MASKING POLICY mask_pii AS
    (val STRING) RETURNS STRING ->
    CASE
        -- Admins and specific roles can see unmasked data
        WHEN CURRENT_ROLE() IN ('ACCOUNTADMIN', 'DATA_SCIENTIST', 'BI_ADMIN') THEN val
        -- Service accounts need unmasked data
        WHEN CURRENT_USER() IN ('BI_SERVICE_ACCOUNT', 'MCP_SERVICE') THEN val
        -- Mask for everyone else
        ELSE '***MASKED***'
    END;

-- Masking policy for email addresses
CREATE OR REPLACE MASKING POLICY mask_email AS
    (val STRING) RETURNS STRING ->
    CASE
        WHEN CURRENT_ROLE() IN ('ACCOUNTADMIN', 'DATA_SCIENTIST') THEN val
        WHEN val IS NULL THEN NULL
        -- Show only domain
        ELSE CONCAT('***@', SPLIT_PART(val, '@', 2))
    END;

-- Masking policy for IP addresses
CREATE OR REPLACE MASKING POLICY mask_ip AS
    (val STRING) RETURNS STRING ->
    CASE
        WHEN CURRENT_ROLE() IN ('ACCOUNTADMIN', 'SECURITYADMIN') THEN val
        WHEN val IS NULL THEN NULL
        -- Mask last two octets
        ELSE CONCAT(SPLIT_PART(val, '.', 1), '.', SPLIT_PART(val, '.', 2), '.XXX.XXX')
    END;

-- Masking policy for sensitive JSON fields
CREATE OR REPLACE MASKING POLICY mask_json_sensitive AS
    (val VARIANT) RETURNS VARIANT ->
    CASE
        WHEN CURRENT_ROLE() IN ('ACCOUNTADMIN', 'DATA_SCIENTIST') THEN val
        ELSE OBJECT_DELETE(val, 'password', 'token', 'secret', 'api_key', 'private_key')
    END;

-- Apply masking policies
ALTER TABLE CLAUDE_STREAM MODIFY COLUMN anonymous_customer_id SET MASKING POLICY mask_pii;
ALTER TABLE SECURITY_AUDIT_LOG MODIFY COLUMN ip_address SET MASKING POLICY mask_ip;
ALTER TABLE CLAUDE_STREAM MODIFY COLUMN feature_json SET MASKING POLICY mask_json_sensitive;

-- Create network policy for IP restrictions (optional)
CREATE OR REPLACE NETWORK POLICY bi_network_policy
    ALLOWED_IP_LIST = (
        '10.0.0.0/8',     -- Internal network
        '172.16.0.0/12',  -- Internal network
        '192.168.0.0/16'  -- Internal network
        -- Add specific external IPs as needed
    )
    BLOCKED_IP_LIST = ()  -- Add blocked IPs if needed
    COMMENT = 'Network policy for BI system access';

-- Session policy for timeout and authentication
CREATE OR REPLACE SESSION POLICY bi_session_policy
    SESSION_IDLE_TIMEOUT_MINS = 60
    SESSION_UI_IDLE_TIMEOUT_MINS = 30
    COMMENT = 'Session policy for BI users';

-- Password policy for service accounts
CREATE OR REPLACE PASSWORD POLICY bi_password_policy
    PASSWORD_MIN_LENGTH = 16
    PASSWORD_MAX_LENGTH = 256
    PASSWORD_MIN_UPPER_CASE_CHARS = 2
    PASSWORD_MIN_LOWER_CASE_CHARS = 2
    PASSWORD_MIN_NUMERIC_CHARS = 2
    PASSWORD_MIN_SPECIAL_CHARS = 2
    PASSWORD_MAX_AGE_DAYS = 90
    PASSWORD_MAX_RETRIES = 5
    PASSWORD_LOCKOUT_TIME_MINS = 30
    PASSWORD_HISTORY = 10
    COMMENT = 'Password policy for BI service accounts';

-- Tag-based masking for dynamic column protection
CREATE OR REPLACE TAG sensitive_data ALLOWED_VALUES 'PII', 'FINANCIAL', 'HEALTH', 'PUBLIC';
CREATE OR REPLACE TAG data_classification ALLOWED_VALUES 'CONFIDENTIAL', 'INTERNAL', 'PUBLIC';

-- Apply tags to columns
ALTER TABLE CLAUDE_STREAM MODIFY COLUMN customer SET TAG sensitive_data = 'PII';
ALTER TABLE CLAUDE_STREAM MODIFY COLUMN revenue_impact SET TAG sensitive_data = 'FINANCIAL';
ALTER TABLE INSIGHT_ATOMS MODIFY COLUMN value SET TAG data_classification = 'INTERNAL';

-- Create masking policy based on tags
CREATE OR REPLACE MASKING POLICY tag_based_masking AS
    (val STRING) RETURNS STRING ->
    CASE
        WHEN SYSTEM$GET_TAG('sensitive_data', CURRENT_DATABASE(), CURRENT_SCHEMA(), CURRENT_TABLE(), CURRENT_COLUMN()) = 'PUBLIC' THEN val
        WHEN SYSTEM$GET_TAG('sensitive_data', CURRENT_DATABASE(), CURRENT_SCHEMA(), CURRENT_TABLE(), CURRENT_COLUMN()) = 'PII' 
            AND CURRENT_ROLE() NOT IN ('ACCOUNTADMIN', 'DATA_SCIENTIST') THEN '***PII***'
        WHEN SYSTEM$GET_TAG('sensitive_data', CURRENT_DATABASE(), CURRENT_SCHEMA(), CURRENT_TABLE(), CURRENT_COLUMN()) = 'FINANCIAL'
            AND CURRENT_ROLE() NOT IN ('ACCOUNTADMIN', 'FINANCE_ANALYST') THEN '***FINANCIAL***'
        ELSE val
    END;

-- Aggregation policy to prevent individual identification
CREATE OR REPLACE AGGREGATION POLICY minimum_aggregation AS
    () RETURNS AGGREGATION_CONSTRAINT ->
    CASE
        WHEN CURRENT_ROLE() IN ('ACCOUNTADMIN', 'DATA_SCIENTIST') THEN NO_AGGREGATION_CONSTRAINT()
        ELSE AGGREGATION_CONSTRAINT(MIN_GROUP_SIZE => 5)
    END;

-- Apply aggregation policy to sensitive tables
ALTER TABLE CLAUDE_STREAM SET AGGREGATION POLICY minimum_aggregation;

-- Create projection policy to limit column access
CREATE OR REPLACE PROJECTION POLICY limit_columns AS
    () RETURNS PROJECTION_CONSTRAINT ->
    CASE
        WHEN CURRENT_ROLE() = 'READONLY_USER' THEN PROJECTION_CONSTRAINT(EXCLUDE => ['revenue_impact', 'anonymous_customer_id'])
        ELSE PROJECTION_CONSTRAINT()
    END;

-- Grant policy management permissions
GRANT APPLY ON ROW ACCESS POLICY customer_isolation TO ROLE BI_ADMIN;
GRANT APPLY ON MASKING POLICY mask_pii TO ROLE BI_ADMIN;
GRANT APPLY ON MASKING POLICY mask_email TO ROLE BI_ADMIN;
GRANT APPLY ON MASKING POLICY mask_ip TO ROLE BI_ADMIN;