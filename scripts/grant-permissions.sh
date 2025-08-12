#!/bin/bash

# ============================================
# GRANT PERMISSIONS FOR CLAUDE_DESKTOP_ROLE
# ============================================
# Run this script to grant necessary permissions to CLAUDE_DESKTOP_ROLE
# Must be run as ACCOUNTADMIN

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔐 Granting Permissions to CLAUDE_DESKTOP_ROLE${NC}"
echo "=============================================="

# Load environment variables
if [[ -f ".env" ]]; then
    echo -e "${GREEN}✅ Loading environment from .env${NC}"
    set -a
    source .env
    set +a
else
    echo -e "${RED}❌ .env file not found!${NC}"
    exit 1
fi

# Grant permissions SQL
GRANT_SQL="
-- Switch to ACCOUNTADMIN role
USE ROLE ACCOUNTADMIN;

-- Grant database-level privileges
GRANT USAGE ON DATABASE ${SNOWFLAKE_DATABASE} TO ROLE ${SNOWFLAKE_ROLE};
GRANT CREATE SCHEMA ON DATABASE ${SNOWFLAKE_DATABASE} TO ROLE ${SNOWFLAKE_ROLE};

-- Grant warehouse usage  
GRANT USAGE ON WAREHOUSE ${SNOWFLAKE_WAREHOUSE} TO ROLE ${SNOWFLAKE_ROLE};
GRANT OPERATE ON WAREHOUSE ${SNOWFLAKE_WAREHOUSE} TO ROLE ${SNOWFLAKE_ROLE};

-- Create schema if it doesn't exist (as ACCOUNTADMIN)
CREATE SCHEMA IF NOT EXISTS ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA};

-- Grant schema-level privileges
GRANT USAGE ON SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};
GRANT CREATE TABLE ON SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};
GRANT CREATE VIEW ON SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};
GRANT CREATE TASK ON SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};
GRANT CREATE STREAM ON SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};

-- Grant all privileges on future objects
GRANT ALL ON FUTURE TABLES IN SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};
GRANT ALL ON FUTURE VIEWS IN SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};
GRANT ALL ON FUTURE TASKS IN SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};
GRANT ALL ON FUTURE STREAMS IN SCHEMA ${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA} TO ROLE ${SNOWFLAKE_ROLE};

-- Ensure user has the role
GRANT ROLE ${SNOWFLAKE_ROLE} TO USER ${SNOWFLAKE_USERNAME};

-- Make it default role
ALTER USER ${SNOWFLAKE_USERNAME} SET DEFAULT_ROLE = ${SNOWFLAKE_ROLE};

-- Verify grants
SHOW GRANTS TO ROLE ${SNOWFLAKE_ROLE};
"

echo -e "${BLUE}📝 Executing grant statements...${NC}"

# Execute as ACCOUNTADMIN using snow CLI
# Note: This assumes you have ACCOUNTADMIN privileges
if snow sql \
    --account "$SNOWFLAKE_ACCOUNT" \
    --user "$SNOWFLAKE_USERNAME" \
    --password "$SNOWFLAKE_PASSWORD" \
    --warehouse "$SNOWFLAKE_WAREHOUSE" \
    --role "ACCOUNTADMIN" \
    --query "$GRANT_SQL" \
    --temporary-connection; then
    
    echo -e "${GREEN}✅ Permissions granted successfully!${NC}"
    
    # Test the permissions
    echo -e "${BLUE}🧪 Testing permissions...${NC}"
    
    if snow sql \
        --account "$SNOWFLAKE_ACCOUNT" \
        --user "$SNOWFLAKE_USERNAME" \
        --password "$SNOWFLAKE_PASSWORD" \
        --database "$SNOWFLAKE_DATABASE" \
        --schema "$SNOWFLAKE_SCHEMA" \
        --warehouse "$SNOWFLAKE_WAREHOUSE" \
        --role "$SNOWFLAKE_ROLE" \
        --query "SELECT 'Permissions test successful' as status;" \
        --temporary-connection; then
        
        echo -e "${GREEN}✅ Permission test passed! Ready to run deployment.${NC}"
        echo -e "${BLUE}📝 Next step: ./scripts/deploy-snowflake.sh${NC}"
        
    else
        echo -e "${RED}❌ Permission test failed${NC}"
        exit 1
    fi
    
else
    echo -e "${RED}❌ Failed to grant permissions${NC}"
    echo -e "${YELLOW}💡 Make sure you have ACCOUNTADMIN privileges${NC}"
    exit 1
fi