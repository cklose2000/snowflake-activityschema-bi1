# SQL Compliance Guide for ActivitySchema v2.0

## Overview

This guide documents the SQL and schema compliance requirements for the Snowflake ActivitySchema BI system. **ALL SQL changes, DDL scripts, and data model modifications MUST comply with these rules.**

## 🚨 Critical Issue: Database/Schema Mismatch

**Current Problem:**
- Environment (.env) specifies: `CLAUDE_LOGS.ACTIVITIES`
- SQL templates reference: `analytics.activity.*`
- **This causes "Database 'ANALYTICS' does not exist" errors!**

**Solution Required:**
Choose ONE approach and apply consistently:

### Option 1: Update Templates to Match Environment
```javascript
// Change all templates from:
sql: `SELECT * FROM analytics.activity.events WHERE ...`

// To:
sql: `SELECT * FROM CLAUDE_LOGS.ACTIVITIES.events WHERE ...`
```

### Option 2: Update Environment to Match PRD
```bash
# .env file
SNOWFLAKE_DATABASE=ANALYTICS
SNOWFLAKE_SCHEMA=ACTIVITY
```

## ActivitySchema v2.0 Requirements

### Required Table Structure

Every `events` table MUST have these columns:

```sql
CREATE TABLE events (
  -- REQUIRED COLUMNS (ActivitySchema v2.0 spec)
  activity                 STRING           NOT NULL,
  customer                 STRING           NOT NULL,
  ts                       TIMESTAMP_NTZ    NOT NULL,
  activity_repeated_at     TIMESTAMP_NTZ,    -- REQUIRED!
  activity_occurrence      NUMBER           NOT NULL, -- REQUIRED!
  
  -- OPTIONAL SPEC COLUMNS
  link                     STRING,
  revenue_impact           NUMBER,
  
  -- EXTENSION COLUMNS (must have underscore prefix)
  _feature_json            VARIANT,
  _source_system           STRING DEFAULT 'claude_desktop',
  _source_version          STRING DEFAULT '2.0',
  _session_id              STRING,
  _query_tag               STRING,
  _created_at              TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
) CLUSTER BY (customer, ts);
```

### Activity Naming Convention

All activities MUST use the `cdesk.*` namespace:

| ✅ Valid | ❌ Invalid | Why Invalid |
|----------|------------|-------------|
| `cdesk.session_started` | `session_started` | Missing namespace |
| `cdesk.user_asked` | `claude_session_start` | Wrong format |
| `cdesk.tool_called` | `cdesk_user_asked` | Underscore instead of dot |
| `cdesk.sql_executed` | `claude.desktop.started` | Wrong namespace |
| `cdesk.error_encountered` | `cdesk.loadTest` | CamelCase not allowed |

**Validation Regex:** `/^cdesk\.[a-z_]+$/`

### Extension Column Naming

Non-spec columns MUST have underscore prefix:

| ✅ Valid | ❌ Invalid |
|----------|------------|
| `_feature_json` | `feature_json` |
| `_query_tag` | `query_tag` |
| `_session_id` | `session_id` |
| `_custom_field` | `custom_field` |

## SafeSQL Template Requirements

### Template Registration

Every SQL query MUST be registered as a SafeSQL template:

```javascript
// ✅ CORRECT: Parameterized template
SAFE_TEMPLATES.set('GET_CONTEXT', {
  sql: `SELECT context_blob 
        FROM CLAUDE_LOGS.ACTIVITIES.context_cache 
        WHERE customer = ?`,
  validator: (params) => {
    const [customer] = params;
    return [validateCustomerId(customer)];
  }
});

// ❌ WRONG: Dynamic SQL generation
const query = `SELECT * FROM ${table} WHERE id = ${id}`; // SQL INJECTION RISK!
```

### Parameter Validation

Every template MUST have a validator function:

```javascript
validator: (params) => {
  const [customerId, hoursBack, limit] = params;
  
  // Validate each parameter
  if (!customerId || !/^[a-zA-Z0-9-_]+$/.test(customerId)) {
    throw new Error('Invalid customer ID');
  }
  
  if (hoursBack < 1 || hoursBack > 720) {
    throw new Error('Hours must be between 1 and 720');
  }
  
  if (limit < 1 || limit > 1000) {
    throw new Error('Limit must be between 1 and 1000');
  }
  
  return [customerId, hoursBack, limit];
}
```

## Query Tag Format

Every query MUST set a proper query tag:

**Format:** `cdesk_[16-character-uuid]`

```javascript
// ✅ CORRECT: 16 characters after prefix
const queryTag = `cdesk_${uuid.v4().replace(/-/g, '').substring(0, 16)}`;
// Result: "cdesk_a1b2c3d4e5f6g7h8"

// ❌ WRONG: Only 8 characters
const queryTag = `cdesk_${uuid.v4().substring(0, 8)}`;
// Result: "cdesk_a1b2c3d4" (too short!)
```

## Provenance Hash Requirements

Query hashes for provenance tracking MUST be exactly 16 characters:

```javascript
// ✅ CORRECT: 16 character hash
function generateQueryHash(template, params) {
  return crypto
    .createHash('sha256')
    .update(template + JSON.stringify(params))
    .digest('hex')
    .substring(0, 16); // MUST be 16!
}

// ❌ WRONG: 8 character hash
.substring(0, 8); // Too short - causes validation failures
```

## Common Violations and Fixes

### 1. Database Mismatch

**Violation:**
```javascript
sql: `SELECT * FROM analytics.activity.events`
```

**Fix:**
```javascript
sql: `SELECT * FROM CLAUDE_LOGS.ACTIVITIES.events`
```

### 2. Missing Required Columns

**Violation:**
```sql
CREATE TABLE events (
  activity STRING,
  customer STRING,
  ts TIMESTAMP_NTZ
  -- Missing activity_repeated_at and activity_occurrence!
)
```

**Fix:**
```sql
ALTER TABLE events 
ADD COLUMN activity_repeated_at TIMESTAMP_NTZ,
ADD COLUMN activity_occurrence NUMBER DEFAULT 1;
```

### 3. Wrong Activity Format

**Violation:**
```javascript
activity: 'load_test'
```

**Fix:**
```javascript
activity: 'cdesk.load_test'
```

### 4. Dynamic SQL

**Violation:**
```javascript
const sql = `SELECT * FROM ${tableName} WHERE id = ${userId}`;
```

**Fix:**
```javascript
SAFE_TEMPLATES.set('GET_BY_ID', {
  sql: `SELECT * FROM users WHERE id = ?`,
  validator: validateUserId
});
```

## Automated Compliance Checking

### Pre-Commit Hook

The system automatically checks SQL compliance before commits:

```bash
# Triggered automatically on:
git commit -m "Update SQL templates"

# Output:
📊 SQL/Schema changes detected - Running Snowflake Compliance Review...
═══════════════════════════════════════════
❌ VIOLATIONS FOUND: 3
─────────────────────────────────────
📍 bi-mcp-server/src/sql/safe-templates.ts
   Type: TEMPLATE_ENV_MISMATCH
   Issue: Templates reference analytics.activity but ENV uses CLAUDE_LOGS.ACTIVITIES
   Fix: Update templates to use CLAUDE_LOGS.ACTIVITIES
```

### Manual Validation

Run compliance check manually:

```bash
node scripts/snowflake-review.js
```

### Bypass (Emergency Only)

```bash
git commit --no-verify -m "Emergency fix"
# ⚠️ WARNING: This bypasses ALL safety checks!
```

## Performance Requirements

### Latency SLOs

| Operation | Target P95 | Current | Status |
|-----------|------------|---------|--------|
| get_context | < 25ms | 924ms | ❌ FAIL |
| log_event | < 10ms | N/A | ❌ FAIL |
| submit_query | < 50ms | 0.37ms | ✅ PASS |

### Required Optimizations

1. **Connection Pool:** Minimum 20 connections (currently 5)
2. **Caching:** Two-tier (memory + Redis) required
3. **Query Timeout:** Appropriate values (not 10ms!)
4. **Result Limits:** Always use LIMIT clause

## Troubleshooting

### "Database does not exist" Error

**Cause:** Mismatch between template database names and environment configuration

**Solution:**
1. Check `.env` file for actual database name
2. Update all SQL templates to use correct database
3. Or update `.env` to match templates

### "Invalid activity name" Error

**Cause:** Activity doesn't follow `cdesk.*` format

**Solution:**
1. Change activity to use `cdesk.` prefix
2. Use only lowercase and underscores
3. Example: `cdesk.user_asked`

### "Query timeout after 10ms" Error

**Cause:** Timeout too aggressive for Snowflake queries

**Solution:**
1. Increase timeout to reasonable value (1000ms+)
2. Implement proper caching to avoid queries
3. Use fire-and-forget for log_event

### "Provenance hash validation failed"

**Cause:** Hash is not exactly 16 characters

**Solution:**
1. Find hash generation code
2. Change `.substring(0, X)` to `.substring(0, 16)`
3. Ensure consistent across all files

## References

- [PRD v2 Strict Requirements](./prd-v2-strict.md)
- [ActivitySchema v2.0 Specification](./activityschema-spec.md)
- [SafeSQL Templates Documentation](./safesql-templates.md)
- [Snowflake Expert Agent](./../.claude/agents/snowflake-expert.md)

## Getting Help

If you encounter SQL compliance issues:

1. Run the compliance checker: `node scripts/snowflake-review.js`
2. Review violations in the output
3. Apply fixes suggested by the tool
4. Consult the Snowflake Expert agent for complex issues
5. Test changes with: `npm run test:integration`

Remember: **Every SQL change can break production.** Always validate compliance before committing.