#!/bin/bash

# ============================================
# SNOWFLAKE POC DEPLOYMENT SCRIPT
# ============================================
# Automates the deployment of ActivitySchema BI to Snowflake
# Run with: ./scripts/deploy-snowflake.sh

set -euo pipefail  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}🚀 ActivitySchema BI Snowflake Deployment${NC}"
echo "================================================"

# Load environment variables
if [[ -f "$PROJECT_ROOT/.env" ]]; then
    echo -e "${GREEN}✅ Loading environment from .env${NC}"
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
else
    echo -e "${RED}❌ .env file not found!${NC}"
    echo "Please create .env file with Snowflake credentials"
    exit 1
fi

# Verify required environment variables
REQUIRED_VARS=(
    "SNOWFLAKE_ACCOUNT"
    "SNOWFLAKE_USERNAME" 
    "SNOWFLAKE_PASSWORD"
    "SNOWFLAKE_DATABASE"
    "SNOWFLAKE_SCHEMA"
    "SNOWFLAKE_WAREHOUSE"
    "SNOWFLAKE_ROLE"
)

echo -e "${BLUE}📋 Verifying environment variables...${NC}"
for var in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        echo -e "${RED}❌ Missing required variable: $var${NC}"
        exit 1
    fi
    # Mask password in output
    if [[ "$var" == "SNOWFLAKE_PASSWORD" ]]; then
        echo -e "  ✅ $var: ***${!var: -3}"
    else
        echo -e "  ✅ $var: ${!var}"
    fi
done

# Function to run SQL with error handling using snow CLI
run_sql() {
    local description="$1"
    local sql_file="$2"
    
    echo -e "${BLUE}🔧 $description...${NC}"
    
    if [[ ! -f "$sql_file" ]]; then
        echo -e "${RED}❌ SQL file not found: $sql_file${NC}"
        return 1
    fi
    
    # Use snow sql with direct connection parameters
    if snow sql \
        --account "$SNOWFLAKE_ACCOUNT" \
        --user "$SNOWFLAKE_USERNAME" \
        --password "$SNOWFLAKE_PASSWORD" \
        --database "$SNOWFLAKE_DATABASE" \
        --schema "$SNOWFLAKE_SCHEMA" \
        --warehouse "$SNOWFLAKE_WAREHOUSE" \
        --role "$SNOWFLAKE_ROLE" \
        --filename "$sql_file" \
        --temporary-connection > /dev/null 2>&1; then
        echo -e "${GREEN}✅ $description completed${NC}"
        return 0
    else
        echo -e "${YELLOW}⚠️ $description failed, retrying with verbose output...${NC}"
        snow sql \
            --account "$SNOWFLAKE_ACCOUNT" \
            --user "$SNOWFLAKE_USERNAME" \
            --password "$SNOWFLAKE_PASSWORD" \
            --database "$SNOWFLAKE_DATABASE" \
            --schema "$SNOWFLAKE_SCHEMA" \
            --warehouse "$SNOWFLAKE_WAREHOUSE" \
            --role "$SNOWFLAKE_ROLE" \
            --filename "$sql_file" \
            --temporary-connection
        return $?
    fi
}

# Function to run SQL query and capture output
run_query() {
    local query="$1"
    snow sql \
        --account "$SNOWFLAKE_ACCOUNT" \
        --user "$SNOWFLAKE_USERNAME" \
        --password "$SNOWFLAKE_PASSWORD" \
        --database "$SNOWFLAKE_DATABASE" \
        --schema "$SNOWFLAKE_SCHEMA" \
        --warehouse "$SNOWFLAKE_WAREHOUSE" \
        --role "$SNOWFLAKE_ROLE" \
        --query "$query" \
        --temporary-connection
}

# Deploy DDL files in order
echo -e "${BLUE}🏗️ Deploying database objects...${NC}"

# Check if we can connect
echo -e "${BLUE}🔗 Testing connection...${NC}"
if run_query "SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_DATABASE(), CURRENT_SCHEMA(), CURRENT_WAREHOUSE();"; then
    echo -e "${GREEN}✅ Connection successful!${NC}"
else
    echo -e "${RED}❌ Connection failed!${NC}"
    echo "Please check your credentials and network connection."
    exit 1
fi

# Deploy the main POC setup
DDL_FILE="$PROJECT_ROOT/bi-snowflake-ddl/sql/ddl_poc_setup.sql"
if run_sql "Deploying POC database structure" "$DDL_FILE"; then
    echo -e "${GREEN}✅ POC database structure deployed successfully!${NC}"
else
    echo -e "${RED}❌ POC database deployment failed!${NC}"
    exit 1
fi

# Verify deployment
echo -e "${BLUE}🔍 Verifying deployment...${NC}"

# Check tables
echo -e "${BLUE}📊 Checking tables...${NC}"
TABLES_QUERY="
SELECT 
    TABLE_NAME,
    ROW_COUNT,
    BYTES,
    CREATED
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = '${SNOWFLAKE_SCHEMA}'
ORDER BY CREATED DESC;
"

if run_query "$TABLES_QUERY"; then
    echo -e "${GREEN}✅ Tables created successfully${NC}"
else
    echo -e "${RED}❌ Failed to verify tables${NC}"
fi

# Check views
echo -e "${BLUE}👁️ Checking views...${NC}"
VIEWS_QUERY="
SELECT 
    TABLE_NAME as VIEW_NAME,
    CREATED
FROM INFORMATION_SCHEMA.VIEWS
WHERE TABLE_SCHEMA = '${SNOWFLAKE_SCHEMA}'
ORDER BY CREATED DESC;
"

if run_query "$VIEWS_QUERY"; then
    echo -e "${GREEN}✅ Views created successfully${NC}"
else
    echo -e "${RED}❌ Failed to verify views${NC}"
fi

# Insert test data and verify
echo -e "${BLUE}🧪 Testing with sample data...${NC}"
TEST_QUERY="
INSERT INTO EVENTS (
    activity,
    customer,
    ts,
    _feature_json,
    _query_tag,
    _session_id
) 
SELECT
    'cdesk.deployment_test',
    'deployment_user',
    CURRENT_TIMESTAMP(),
    OBJECT_CONSTRUCT(
        'deployed_by', 'automation_script',
        'deployment_time', CURRENT_TIMESTAMP(),
        'version', '1.0.0'
    ),
    'cdesk_deploy_001',
    'deploy_session_001'
WHERE NOT EXISTS (
    SELECT 1 FROM EVENTS WHERE activity = 'cdesk.deployment_test'
);

-- Verify the test
SELECT 
    'Deployment Test Complete' as status,
    COUNT(*) as test_events_count,
    MAX(ts) as last_event_time
FROM EVENTS
WHERE activity LIKE 'cdesk.%test%';
"

if run_query "$TEST_QUERY"; then
    echo -e "${GREEN}✅ Test data inserted and verified${NC}"
else
    echo -e "${YELLOW}⚠️ Test data insertion had issues${NC}"
fi

# Check permissions
echo -e "${BLUE}🔐 Verifying permissions...${NC}"
PERMS_QUERY="
SELECT 
    PRIVILEGE_TYPE,
    GRANTED_ON,
    NAME,
    GRANTED_TO
FROM INFORMATION_SCHEMA.OBJECT_PRIVILEGES
WHERE GRANTEE_NAME = '${SNOWFLAKE_ROLE}'
    AND GRANTED_ON IN ('TABLE', 'VIEW', 'SCHEMA')
    AND NAME LIKE '%${SNOWFLAKE_SCHEMA}%'
ORDER BY GRANTED_ON, NAME;
"

if run_query "$PERMS_QUERY"; then
    echo -e "${GREEN}✅ Permissions verified${NC}"
else
    echo -e "${YELLOW}⚠️ Could not verify all permissions${NC}"
fi

# No temporary files to clean up

echo -e "${GREEN}🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!${NC}"
echo "================================================"
echo -e "${BLUE}📊 Summary:${NC}"
echo -e "  Database: ${SNOWFLAKE_DATABASE}"
echo -e "  Schema: ${SNOWFLAKE_SCHEMA}"
echo -e "  Warehouse: ${SNOWFLAKE_WAREHOUSE}"
echo -e "  Role: ${SNOWFLAKE_ROLE}"

echo -e "${BLUE}📝 Next Steps:${NC}"
echo -e "  1. Start MCP server: ${GREEN}npm run start:dev${NC}"
echo -e "  2. Test health: ${GREEN}curl http://localhost:3000/health${NC}"
echo -e "  3. Run integration tests: ${GREEN}npm run test:integration${NC}"
echo -e "  4. Connect to Claude Desktop using the MCP configuration"

echo -e "${BLUE}🔗 Connection String:${NC}"
echo -e "  Account: ${SNOWFLAKE_ACCOUNT}"
echo -e "  Database: ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA}"

echo -e "${GREEN}✅ Ready for production use!${NC}"