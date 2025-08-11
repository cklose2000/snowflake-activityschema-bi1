# Snowflake Setup Guide

## Prerequisites

1. **Snowflake Account**: Either existing account or [30-day trial](https://signup.snowflake.com/)
2. **Node.js 18+**: For running MCP server
3. **Git**: For cloning repository
4. **Optional**: Redis for production cache tier

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/cklose2000/snowflake-activityschema-bi1.git
cd snowflake-activityschema-bi1
npm install
```

### 2. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with your Snowflake credentials
# CRITICAL: Never commit .env file!
nano .env
```

Required fields in `.env`:
- `SNOWFLAKE_ACCOUNT`: Your account identifier (e.g., `ABC12345.us-east-1.aws`)
- `SNOWFLAKE_USERNAME`: Your username
- `SNOWFLAKE_PASSWORD`: Your password

### 3. Deploy Snowflake Infrastructure

```bash
# Connect to Snowflake
snowsql -a $SNOWFLAKE_ACCOUNT -u $SNOWFLAKE_USERNAME

# Run DDL scripts in order
!source bi-snowflake-ddl/sql/ddl_analytics_activity_events.sql
!source bi-snowflake-ddl/sql/ddl_activity_cdesk_extensions.sql
!source bi-snowflake-ddl/sql/ddl_derived_views.sql
!source bi-snowflake-ddl/sql/ddl_streams_tasks.sql
!source bi-snowflake-ddl/sql/ddl_security_policies.sql
```

### 4. Start MCP Server

```bash
# Development mode
npm run dev

# Production mode
npm run build
npm start
```

### 5. Verify Installation

```bash
# Check MCP server health
curl http://localhost:3000/health

# Test context retrieval (should be < 25ms)
time curl http://localhost:3000/context/test-customer

# Run compliance validation
npm run validate
```

## Detailed Setup

### Option 1: Development Environment (Recommended First)

Create isolated development environment:

```sql
-- Create development warehouse (smaller, auto-suspend)
CREATE WAREHOUSE IF NOT EXISTS COMPUTE_DEV
  WAREHOUSE_SIZE = 'X-SMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

-- Create development schemas
CREATE SCHEMA IF NOT EXISTS ANALYTICS.ACTIVITY_DEV;
CREATE SCHEMA IF NOT EXISTS ANALYTICS.ACTIVITY_CDESK_DEV;

-- Create development role with limited permissions
CREATE ROLE IF NOT EXISTS BI_DEVELOPER;
GRANT USAGE ON WAREHOUSE COMPUTE_DEV TO ROLE BI_DEVELOPER;
GRANT ALL ON SCHEMA ANALYTICS.ACTIVITY_DEV TO ROLE BI_DEVELOPER;
GRANT ALL ON SCHEMA ANALYTICS.ACTIVITY_CDESK_DEV TO ROLE BI_DEVELOPER;
GRANT ROLE BI_DEVELOPER TO USER your_username;

-- Set resource monitor (prevent runaway costs)
CREATE RESOURCE MONITOR IF NOT EXISTS DEV_MONITOR
  WITH CREDIT_QUOTA = 10  -- 10 credits per day
  FREQUENCY = DAILY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS 
    ON 75 PERCENT DO NOTIFY
    ON 90 PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND;
    
ALTER WAREHOUSE COMPUTE_DEV SET RESOURCE_MONITOR = DEV_MONITOR;
```

Update `.env` for development:
```bash
SNOWFLAKE_WAREHOUSE=COMPUTE_DEV
SNOWFLAKE_SCHEMA=ACTIVITY_DEV
SNOWFLAKE_ROLE=BI_DEVELOPER
```

### Option 2: Production Setup

For production deployment:

```sql
-- Create production warehouse
CREATE WAREHOUSE IF NOT EXISTS COMPUTE_PROD
  WAREHOUSE_SIZE = 'SMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 3
  SCALING_POLICY = 'STANDARD';

-- Production schemas (from DDL files)
-- Run all DDL scripts from bi-snowflake-ddl/sql/

-- Production role
CREATE ROLE IF NOT EXISTS BI_PRODUCTION;
-- Grant specific permissions (see ddl_security_policies.sql)

-- Production resource monitor
CREATE RESOURCE MONITOR IF NOT EXISTS PROD_MONITOR
  WITH CREDIT_QUOTA = 100  -- Adjust based on budget
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS 
    ON 75 PERCENT DO NOTIFY
    ON 90 PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND_IMMEDIATE;
```

### Option 3: Key-Pair Authentication (More Secure)

Instead of password authentication:

1. Generate RSA key pair:
```bash
# Generate private key
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8

# Generate public key
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

2. Configure in Snowflake:
```sql
ALTER USER your_username SET RSA_PUBLIC_KEY='MIIBIjANBgkq...';
```

3. Update `.env`:
```bash
# Comment out password
# SNOWFLAKE_PASSWORD=...

# Add key path
SNOWFLAKE_PRIVATE_KEY_PATH=/path/to/rsa_key.p8
SNOWFLAKE_PRIVATE_KEY_PASSPHRASE=your_passphrase  # If encrypted
```

## Validation & Testing

### 1. Run Victory-Auditor

```bash
# Validate all claims about the system
npm run validate-victory

# This will check:
# - Performance claims (< 25ms p95)
# - Compliance with ActivitySchema v2.0
# - All integration points working
```

### 2. Run Chaos Tests

```bash
# Level 1: Gentle chaos (development)
npm run chaos:level1

# Level 2: Moderate chaos (staging)
npm run chaos:level2

# Level 3: Severe chaos (pre-production)
npm run chaos:level3
```

### 3. Compliance Validation

```sql
-- Run in Snowflake
-- Check ActivitySchema compliance
SELECT * FROM TABLE(VALIDATE_ACTIVITY_COMPLIANCE());

-- Check for non-compliant activities
SELECT * FROM ANALYTICS.ACTIVITY.EVENTS
WHERE activity NOT LIKE 'cdesk.%'
   OR activity_occurrence IS NULL
   OR ts IS NULL;
```

### 4. Performance Validation

```bash
# Load test get_context endpoint
npm run benchmark:context

# Expected output:
# P50: < 10ms
# P95: < 25ms
# P99: < 50ms
```

## Common Issues

### Issue: "SNOWFLAKE_PASSWORD not set"
**Solution**: Ensure `.env` file exists and contains credentials

### Issue: "Table ANALYTICS.ACTIVITY.EVENTS does not exist"
**Solution**: Run DDL scripts to create tables

### Issue: "Insufficient privileges"
**Solution**: Ensure your role has necessary permissions:
```sql
GRANT CREATE TABLE ON SCHEMA ANALYTICS.ACTIVITY TO ROLE your_role;
GRANT USAGE ON WAREHOUSE COMPUTE_XS TO ROLE your_role;
```

### Issue: Performance exceeds 25ms SLO
**Solution**: 
1. Ensure Redis is running for cache tier
2. Check Snowflake warehouse size
3. Verify clustering keys are set correctly

## Monitoring

### Snowflake Query History
```sql
-- Monitor query performance
SELECT query_text, 
       execution_time,
       bytes_scanned,
       credits_used
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE query_tag LIKE 'cdesk_%'
  AND start_time > DATEADD(hour, -24, CURRENT_TIMESTAMP())
ORDER BY execution_time DESC;
```

### Credit Usage
```sql
-- Monitor credit consumption
SELECT date_trunc('day', start_time) as day,
       warehouse_name,
       SUM(credits_used) as daily_credits
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time > DATEADD(day, -7, CURRENT_TIMESTAMP())
GROUP BY 1, 2
ORDER BY 1 DESC;
```

## Security Best Practices

1. **Never commit credentials**: Use `.env` file (git-ignored)
2. **Use key-pair auth**: More secure than passwords
3. **Implement least privilege**: Create specific roles
4. **Enable MFA**: For production accounts
5. **Set resource monitors**: Prevent runaway costs
6. **Use network policies**: Restrict IP access
7. **Audit regularly**: Review QUERY_HISTORY
8. **Rotate credentials**: Change passwords/keys periodically

## Next Steps

1. **Connect Claude Desktop**: Configure MCP integration
2. **Deploy Redis**: For production cache tier
3. **Set up S3**: For artifact storage
4. **Configure monitoring**: Prometheus/Grafana
5. **Run chaos tests**: Ensure production readiness
6. **Document runbooks**: For operational procedures

## Support

- **Snowflake Documentation**: https://docs.snowflake.com
- **GitHub Issues**: https://github.com/cklose2000/snowflake-activityschema-bi1/issues
- **Victory-Auditor**: Run `npm run validate-victory` to verify setup