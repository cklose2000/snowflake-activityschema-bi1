# Claude Desktop Integration Guide

## Overview

This guide explains how to connect the ActivitySchema BI system to Claude Desktop as an MCP (Model Context Protocol) server. Once connected, all Claude Desktop interactions will be automatically logged to Snowflake with ActivitySchema v2.0 compliance.

## Prerequisites

1. ✅ **Claude Desktop installed** - Download from [claude.ai](https://claude.ai/download)
2. ✅ **BI System deployed** - Run `npm run deploy` to set up Snowflake tables
3. ✅ **MCP Server running** - Verify with `curl http://localhost:3000/health`

## Quick Setup

### 1. Configure Claude Desktop MCP Settings

Add this configuration to Claude Desktop's MCP settings:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "snowflake-activityschema-bi": {
      "command": "node",
      "args": [
        "/path/to/snowflake-activityschema-bi/bi-mcp-server/dist/index.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### 2. Update the Path

Replace `/path/to/` with the actual path to your project:

```bash
# Find your project path
pwd
# Example: /Users/cklose2000/snowflake-activityschema-bi

# Update the config file
{
  "mcpServers": {
    "snowflake-activityschema-bi": {
      "command": "node",
      "args": [
        "/Users/cklose2000/snowflake-activityschema-bi/bi-mcp-server/dist/index.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### 3. Restart Claude Desktop

Close and reopen Claude Desktop to load the new MCP server configuration.

## Verification

### 1. Check Claude Desktop Logs

Open Claude Desktop Developer Tools (if available) or check system logs:

**macOS**: `tail -f ~/Library/Logs/Claude/claude.log`

Look for messages indicating successful MCP server connection.

### 2. Test Activity Logging

1. **Start a conversation** in Claude Desktop
2. **Ask a question** (this should trigger `cdesk.user_asked` activity)
3. **Check Snowflake** for logged events:

```sql
USE DATABASE CLAUDE_LOGS;
USE SCHEMA ACTIVITIES;

-- Check recent events
SELECT * FROM EVENTS
WHERE ts >= DATEADD(minute, -5, CURRENT_TIMESTAMP())
ORDER BY ts DESC;

-- Verify activity naming
SELECT DISTINCT activity, COUNT(*) as event_count
FROM EVENTS
WHERE ts >= DATEADD(hour, -1, CURRENT_TIMESTAMP())
GROUP BY activity
ORDER BY event_count DESC;
```

### 3. Test Context Retrieval

The system should provide context to Claude Desktop:

1. **Ask Claude about previous interactions**
2. **System should retrieve context** using `get_context` tool
3. **Response should reference past activities**

## Advanced Configuration

### Environment-Specific Setup

For different environments, create separate configurations:

#### Development Configuration
```json
{
  "mcpServers": {
    "snowflake-bi-dev": {
      "command": "node",
      "args": ["/path/to/project/bi-mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "development",
        "LOG_LEVEL": "debug",
        "SNOWFLAKE_SCHEMA": "ACTIVITIES_DEV"
      }
    }
  }
}
```

#### Production Configuration
```json
{
  "mcpServers": {
    "snowflake-bi-prod": {
      "command": "node", 
      "args": ["/path/to/project/bi-mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "production",
        "LOG_LEVEL": "info",
        "ENABLE_METRICS": "true"
      }
    }
  }
}
```

### Custom Tool Configuration

Enable specific MCP tools:

```json
{
  "mcpServers": {
    "snowflake-activityschema-bi": {
      "command": "node",
      "args": ["/path/to/project/bi-mcp-server/dist/index.js"],
      "env": {
        "ENABLED_TOOLS": "log_event,get_context,submit_query,log_insight"
      }
    }
  }
}
```

## MCP Tools Available

Once connected, Claude Desktop can use these tools:

### 1. `log_event`
- **Purpose**: Log user interactions and system events
- **Auto-triggered**: When user asks questions, Claude responds
- **Manual use**: Claude can log custom events during conversations

### 2. `get_context` 
- **Purpose**: Retrieve conversation context and user history
- **Auto-triggered**: At conversation start and periodically
- **Response time**: < 25ms p95 (critical SLO)

### 3. `submit_query`
- **Purpose**: Execute analytics queries against Snowflake
- **Manual use**: Claude can analyze conversation patterns, usage metrics
- **Returns**: Query ticket for async result retrieval

### 4. `log_insight`
- **Purpose**: Store structured insights discovered during conversations
- **Auto-triggered**: When Claude identifies patterns or metrics
- **Creates**: Persistent memory atoms for future reference

## Expected Activity Stream

With Claude Desktop connected, you'll see these activities in Snowflake:

### Session Activities
```sql
cdesk.session_started    -- User opens Claude Desktop
cdesk.session_resumed    -- User returns to existing session
cdesk.session_ended      -- User closes Claude Desktop
```

### Conversation Activities
```sql
cdesk.user_asked         -- User submits question
cdesk.claude_responded   -- Claude provides answer
cdesk.user_clarified     -- User asks follow-up
cdesk.claude_suggested   -- Claude offers suggestions
```

### Context Activities
```sql
cdesk.context_loaded     -- Context retrieved for conversation
cdesk.context_refreshed  -- Context cache updated
cdesk.insight_recorded   -- New insight stored
cdesk.insight_retrieved  -- Past insight recalled
```

### Error Activities
```sql
cdesk.error_encountered  -- Any error occurred
cdesk.retry_attempted    -- Operation retried
cdesk.timeout_occurred   -- Operation timed out
```

## Performance Expectations

### Latency SLOs
- **Context retrieval**: < 25ms p95 (critical)
- **Event logging**: < 10ms (fire-and-forget)
- **Query submission**: < 50ms (ticket only)

### Throughput
- **Events/second**: Up to 1,000
- **Concurrent users**: Up to 100
- **Queue capacity**: 100,000 events

## Monitoring & Troubleshooting

### Health Check Endpoint
```bash
# Verify MCP server is healthy
curl http://localhost:3000/health

# Expected response:
{
  "status": "healthy",
  "timestamp": "2024-01-15T14:30:00.000Z",
  "uptime": 3600,
  "connections": {
    "snowflake": "connected",
    "redis": "connected"
  }
}
```

### Common Issues

#### Issue 1: "MCP server not responding"
**Symptoms**: Claude Desktop shows connection errors
**Solutions**:
1. Check if MCP server is running: `ps aux | grep node`
2. Verify health endpoint: `curl http://localhost:3000/health`  
3. Check logs: `tail -f bi-mcp-server/logs/application.log`
4. Restart server: `npm run start:prod`

#### Issue 2: "No events appearing in Snowflake"
**Symptoms**: Conversations happen but no data in `EVENTS` table
**Solutions**:
1. Check Snowflake connection: `npm run test:connection`
2. Verify credentials in `.env` file
3. Check NDJSON queue: `ls -la data/events*.ndjson`
4. Manual queue upload: `node scripts/upload-queue.js`

#### Issue 3: "Context retrieval too slow"
**Symptoms**: Claude responses delayed, timeout errors
**Solutions**:
1. Check cache status: `redis-cli ping`
2. Verify context cache table: `SELECT COUNT(*) FROM CONTEXT_CACHE`
3. Run performance benchmark: `npm run benchmark`
4. Scale Snowflake warehouse if needed

#### Issue 4: "Permission denied errors"
**Symptoms**: SQL execution failures in logs
**Solutions**:
1. Verify Snowflake role permissions
2. Check database/schema access
3. Re-run grants: `snowsql -f bi-snowflake-ddl/sql/ddl_poc_setup.sql`

### Debug Mode

Enable detailed logging for troubleshooting:

```json
{
  "mcpServers": {
    "snowflake-activityschema-bi": {
      "command": "node",
      "args": ["/path/to/project/bi-mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "development",
        "LOG_LEVEL": "debug",
        "DEBUG": "*"
      }
    }
  }
}
```

## Security Considerations

### Data Privacy
- **User data**: Only conversation metadata logged, not content
- **PII masking**: Automatic masking of sensitive information
- **Retention**: Configure data retention policies in Snowflake

### Access Control  
- **Snowflake RLS**: Row-level security isolates user data
- **API authentication**: MCP server validates requests
- **Network security**: Consider VPN for production deployments

### Credential Security
- **Environment variables**: Keep `.env` file secure and git-ignored
- **Key rotation**: Regularly rotate Snowflake passwords
- **Monitoring**: Alert on unusual query patterns

## Performance Tuning

### Snowflake Optimization
```sql
-- Optimize clustering for query performance
ALTER TABLE EVENTS CLUSTER BY (customer, ts);

-- Scale warehouse for higher throughput
ALTER WAREHOUSE COMPUTE_WH SET WAREHOUSE_SIZE = 'SMALL';

-- Enable result caching
ALTER WAREHOUSE COMPUTE_WH SET 
  ENABLE_QUERY_ACCELERATION = TRUE
  QUERY_ACCELERATION_MAX_SCALE_FACTOR = 8;
```

### Application Tuning
```bash
# Increase event batch size for higher throughput
export BATCH_SIZE=5000

# Reduce context cache TTL for more responsive updates
export CACHE_TTL=300  # 5 minutes

# Enable Redis clustering for high availability
export REDIS_CLUSTER_NODES="redis1:6379,redis2:6379,redis3:6379"
```

## Next Steps

1. **Monitor usage patterns** in Snowflake dashboards
2. **Set up alerting** for SLO breaches and errors  
3. **Scale resources** based on actual usage
4. **Implement chaos testing** for production resilience
5. **Create custom analytics** for conversation insights

## Support

- **Documentation**: See `/docs` directory for detailed guides
- **Issues**: Create GitHub issues for bugs and feature requests
- **Victory Auditor**: Run `npm run validate:victory` to verify system health
- **Integration Tests**: Run `npm run test:integration` for end-to-end validation