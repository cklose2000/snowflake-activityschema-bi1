# SafeSQL Templates Documentation

## Overview

SafeSQL Templates are parameterized SQL queries that prevent SQL injection attacks by enforcing strict separation between query structure and user input. This document defines the approved templates for the BI system.

## Core Principles

### 1. No Dynamic SQL Generation
```javascript
// ❌ NEVER DO THIS
const query = `SELECT * FROM ${tableName} WHERE id = ${userId}`;

// ✅ ALWAYS USE TEMPLATES
const query = TEMPLATES.GET_USER_BY_ID;
const params = [userId];
```

### 2. Strict Parameter Validation
```javascript
// Every parameter must be validated before use
function validateParameter(value, type, constraints) {
  switch(type) {
    case 'uuid':
      if (!isValidUUID(value)) throw new Error('Invalid UUID');
      break;
    case 'string':
      if (value.length > constraints.maxLength) throw new Error('String too long');
      if (constraints.pattern && !constraints.pattern.test(value)) throw new Error('Invalid format');
      break;
    case 'number':
      if (value < constraints.min || value > constraints.max) throw new Error('Number out of range');
      break;
  }
  return value;
}
```

### 3. Template Registration
```javascript
// All templates must be registered at startup
const SAFE_TEMPLATES = new Map();

function registerTemplate(name, sql, validator) {
  if (SAFE_TEMPLATES.has(name)) {
    throw new Error(`Template ${name} already registered`);
  }
  SAFE_TEMPLATES.set(name, { sql, validator });
}
```

## Approved Templates

### Activity Logging Templates

#### LOG_EVENT
```sql
INSERT INTO CLAUDE_STREAM (
  activity_id, ts, activity, customer, 
  anonymous_customer_id, feature_json, 
  revenue_impact, link
) VALUES (?, CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), ?, ?)
```

**Parameters:**
1. `activity_id` (UUID) - Unique event identifier
2. `activity` (String, max 100) - Activity name
3. `customer` (String, max 255) - Customer ID
4. `anonymous_customer_id` (String, max 255) - Anonymous ID
5. `feature_json` (JSON) - Event metadata
6. `revenue_impact` (Float) - Revenue attribution
7. `link` (URL, max 2000) - Reference URL

**Validator:**
```javascript
function validateLogEvent(params) {
  const [activity_id, activity, customer, anon_id, json, revenue, link] = params;
  
  if (!isValidUUID(activity_id)) throw new Error('Invalid activity_id');
  if (!activity || activity.length > 100) throw new Error('Invalid activity');
  if (customer && customer.length > 255) throw new Error('Customer ID too long');
  if (anon_id && anon_id.length > 255) throw new Error('Anonymous ID too long');
  if (!isValidJSON(json)) throw new Error('Invalid feature_json');
  if (revenue && !isFinite(revenue)) throw new Error('Invalid revenue_impact');
  if (link && !isValidURL(link)) throw new Error('Invalid link URL');
  
  return params;
}
```

#### LOG_INSIGHT
```sql
INSERT INTO INSIGHT_ATOMS (
  atom_id, customer_id, subject, metric, 
  value, provenance_query_hash, ts
) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())
```

**Parameters:**
1. `atom_id` (UUID) - Unique atom identifier
2. `customer_id` (String, max 255) - Customer ID
3. `subject` (String, max 255) - Entity being measured
4. `metric` (String, max 255) - Metric name
5. `value` (JSON) - Metric value
6. `provenance_query_hash` (String, 16) - Source query hash

### Context Retrieval Templates

#### GET_CONTEXT
```sql
SELECT context, updated_at, version
FROM CONTEXT_CACHE
WHERE customer_id = ?
  AND updated_at >= DATEADD(hour, -1, CURRENT_TIMESTAMP())
LIMIT 1
```

**Parameters:**
1. `customer_id` (String, max 255) - Customer identifier

**Validator:**
```javascript
function validateGetContext(params) {
  const [customer_id] = params;
  
  if (!customer_id || typeof customer_id !== 'string') {
    throw new Error('Invalid customer_id');
  }
  if (customer_id.length > 255) {
    throw new Error('Customer ID too long');
  }
  if (!/^[a-zA-Z0-9-_]+$/.test(customer_id)) {
    throw new Error('Customer ID contains invalid characters');
  }
  
  return params;
}
```

#### UPDATE_CONTEXT
```sql
MERGE INTO CONTEXT_CACHE AS target
USING (SELECT ? as customer_id, PARSE_JSON(?) as context) AS source
ON target.customer_id = source.customer_id
WHEN MATCHED THEN UPDATE SET
  context = source.context,
  updated_at = CURRENT_TIMESTAMP(),
  version = target.version + 1
WHEN NOT MATCHED THEN INSERT
  (customer_id, context, updated_at, version)
  VALUES (source.customer_id, source.context, CURRENT_TIMESTAMP(), 1)
```

**Parameters:**
1. `customer_id` (String, max 255) - Customer ID
2. `context` (JSON) - Context object

### Query Templates

#### GET_RECENT_ACTIVITIES
```sql
SELECT activity_id, ts, activity, feature_json
FROM CLAUDE_STREAM
WHERE customer = ?
  AND ts >= DATEADD(hour, ?, CURRENT_TIMESTAMP())
ORDER BY ts DESC
LIMIT ?
```

**Parameters:**
1. `customer` (String, max 255) - Customer ID
2. `hours_back` (Integer, 1-720) - Hours to look back
3. `limit` (Integer, 1-1000) - Result limit

#### GET_ACTIVITY_STATS
```sql
SELECT 
  activity,
  COUNT(*) as count,
  AVG(revenue_impact) as avg_revenue,
  MAX(ts) as last_seen
FROM CLAUDE_STREAM
WHERE customer = ?
  AND ts >= DATEADD(day, ?, CURRENT_TIMESTAMP())
GROUP BY activity
ORDER BY count DESC
LIMIT ?
```

**Parameters:**
1. `customer` (String, max 255) - Customer ID
2. `days_back` (Integer, 1-90) - Days to analyze
3. `limit` (Integer, 1-100) - Result limit

#### GET_INSIGHTS_BY_SUBJECT
```sql
SELECT metric, value, provenance_query_hash, ts
FROM INSIGHT_ATOMS
WHERE customer_id = ?
  AND subject = ?
  AND ts >= DATEADD(day, ?, CURRENT_TIMESTAMP())
ORDER BY ts DESC
LIMIT ?
```

**Parameters:**
1. `customer_id` (String, max 255) - Customer ID
2. `subject` (String, max 255) - Subject to query
3. `days_back` (Integer, 1-90) - Days to look back
4. `limit` (Integer, 1-100) - Result limit

### Artifact Templates

#### STORE_ARTIFACT
```sql
INSERT INTO ARTIFACTS (
  artifact_id, customer_id, s3_url, 
  size_bytes, content_type, created_at, expires_at
) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(), ?)
```

**Parameters:**
1. `artifact_id` (UUID) - Unique artifact ID
2. `customer_id` (String, max 255) - Customer ID
3. `s3_url` (URL) - S3 location
4. `size_bytes` (Integer) - File size
5. `content_type` (String, max 100) - MIME type
6. `expires_at` (Timestamp) - Expiration time

#### GET_ARTIFACT
```sql
SELECT s3_url, size_bytes, content_type, expires_at
FROM ARTIFACTS
WHERE artifact_id = ?
  AND customer_id = ?
  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP())
LIMIT 1
```

**Parameters:**
1. `artifact_id` (UUID) - Artifact ID
2. `customer_id` (String, max 255) - Customer ID

### Administrative Templates

#### CHECK_HEALTH
```sql
SELECT 1 as healthy, CURRENT_TIMESTAMP() as server_time
```

**Parameters:** None

#### GET_METRICS
```sql
SELECT 
  COUNT(*) as total_events,
  COUNT(DISTINCT customer) as unique_customers,
  SUM(revenue_impact) as total_revenue
FROM CLAUDE_STREAM
WHERE ts >= DATEADD(hour, -1, CURRENT_TIMESTAMP())
```

**Parameters:** None

## Template Execution

### Safe Execution Function
```javascript
async function executeSafeSQL(templateName, params, options = {}) {
  // Get template
  const template = SAFE_TEMPLATES.get(templateName);
  if (!template) {
    throw new Error(`Unknown template: ${templateName}`);
  }
  
  // Validate parameters
  const validatedParams = template.validator(params);
  
  // Set query tag
  const queryTag = `cdesk:${templateName}`;
  
  // Execute with timeout
  const timeout = options.timeout || 30000;
  
  try {
    const result = await snowflake.execute({
      sqlText: template.sql,
      binds: validatedParams,
      timeout: timeout,
      queryTag: queryTag
    });
    
    // Log execution
    await logQueryExecution(templateName, params, result.rowCount);
    
    return result;
  } catch (error) {
    // Log error
    await logQueryError(templateName, params, error);
    throw error;
  }
}
```

### Batch Execution
```javascript
async function executeBatch(operations) {
  const connection = await snowflake.connect();
  
  try {
    await connection.execute('BEGIN TRANSACTION');
    
    for (const op of operations) {
      const template = SAFE_TEMPLATES.get(op.template);
      if (!template) {
        throw new Error(`Unknown template: ${op.template}`);
      }
      
      const validatedParams = template.validator(op.params);
      await connection.execute({
        sqlText: template.sql,
        binds: validatedParams
      });
    }
    
    await connection.execute('COMMIT');
  } catch (error) {
    await connection.execute('ROLLBACK');
    throw error;
  } finally {
    await connection.close();
  }
}
```

## Security Validation

### Input Sanitization
```javascript
class InputSanitizer {
  static sanitizeString(value, maxLength = 255) {
    if (typeof value !== 'string') {
      throw new TypeError('Value must be a string');
    }
    
    // Remove null bytes
    value = value.replace(/\0/g, '');
    
    // Trim whitespace
    value = value.trim();
    
    // Check length
    if (value.length > maxLength) {
      throw new Error(`String exceeds maximum length of ${maxLength}`);
    }
    
    // Check for SQL keywords (defense in depth)
    const sqlKeywords = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'EXEC'];
    const upperValue = value.toUpperCase();
    for (const keyword of sqlKeywords) {
      if (upperValue.includes(keyword)) {
        throw new Error(`String contains forbidden SQL keyword: ${keyword}`);
      }
    }
    
    return value;
  }
  
  static sanitizeJSON(value) {
    let json;
    
    // Parse if string
    if (typeof value === 'string') {
      try {
        json = JSON.parse(value);
      } catch (e) {
        throw new Error('Invalid JSON string');
      }
    } else {
      json = value;
    }
    
    // Check for prototype pollution
    if ('__proto__' in json || 'constructor' in json || 'prototype' in json) {
      throw new Error('JSON contains prototype pollution attempt');
    }
    
    // Limit size
    const stringified = JSON.stringify(json);
    if (stringified.length > 65536) { // 64KB limit
      throw new Error('JSON exceeds maximum size');
    }
    
    return stringified;
  }
  
  static sanitizeUUID(value) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(value)) {
      throw new Error('Invalid UUID format');
    }
    return value.toLowerCase();
  }
}
```

### Template Validation
```javascript
// Run at startup to validate all templates
function validateAllTemplates() {
  const errors = [];
  
  for (const [name, template] of SAFE_TEMPLATES) {
    // Check for dynamic SQL patterns
    if (template.sql.includes('${') || template.sql.includes('`')) {
      errors.push(`Template ${name} contains template literals`);
    }
    
    // Check for string concatenation
    if (template.sql.includes('||') || template.sql.includes('CONCAT')) {
      errors.push(`Template ${name} contains string concatenation`);
    }
    
    // Verify parameter markers
    const paramCount = (template.sql.match(/\?/g) || []).length;
    if (paramCount === 0 && name !== 'CHECK_HEALTH') {
      errors.push(`Template ${name} has no parameters`);
    }
    
    // Verify validator function
    if (typeof template.validator !== 'function') {
      errors.push(`Template ${name} missing validator function`);
    }
  }
  
  if (errors.length > 0) {
    throw new Error('Template validation failed:\\n' + errors.join('\\n'));
  }
}
```

## Testing Templates

### Unit Tests
```javascript
describe('SafeSQL Templates', () => {
  describe('LOG_EVENT template', () => {
    it('should accept valid parameters', () => {
      const params = [
        'a1b2c3d4-e5f6-4789-0123-456789abcdef',
        'claude_tool_call',
        'customer123',
        'anonymous456',
        '{"tool": "read_file"}',
        0.001,
        'https://example.com/ref'
      ];
      
      expect(() => validateLogEvent(params)).not.toThrow();
    });
    
    it('should reject SQL injection attempts', () => {
      const params = [
        'a1b2c3d4-e5f6-4789-0123-456789abcdef',
        "'; DROP TABLE CLAUDE_STREAM; --",
        'customer123',
        null,
        '{}',
        0,
        null
      ];
      
      expect(() => validateLogEvent(params)).toThrow('Invalid activity');
    });
  });
});
```

### Integration Tests
```javascript
describe('Template Execution', () => {
  it('should execute GET_CONTEXT safely', async () => {
    const result = await executeSafeSQL('GET_CONTEXT', ['customer123']);
    expect(result).toBeDefined();
    expect(result.rows).toBeInstanceOf(Array);
  });
  
  it('should prevent SQL injection', async () => {
    const maliciousInput = "'; DROP TABLE CONTEXT_CACHE; --";
    await expect(
      executeSafeSQL('GET_CONTEXT', [maliciousInput])
    ).rejects.toThrow('Customer ID contains invalid characters');
  });
});
```

## Monitoring and Auditing

### Query Logging
```sql
CREATE TABLE QUERY_AUDIT_LOG (
  query_id STRING PRIMARY KEY,
  template_name STRING NOT NULL,
  parameters VARIANT,
  customer_id STRING,
  executed_at TIMESTAMP_NTZ,
  execution_time_ms INT,
  rows_affected INT,
  error_message STRING
);
```

### Performance Tracking
```javascript
async function trackTemplatePerformance(templateName, executionTime, rowCount) {
  metrics.histogram('template_execution_time', executionTime, {
    template: templateName
  });
  
  metrics.counter('template_executions', 1, {
    template: templateName
  });
  
  if (executionTime > 1000) {
    logger.warn(`Slow template execution: ${templateName} took ${executionTime}ms`);
  }
}
```

## Emergency Procedures

### Blocking Malicious Templates
```javascript
const BLOCKED_TEMPLATES = new Set();

function blockTemplate(templateName, reason) {
  BLOCKED_TEMPLATES.add(templateName);
  logger.error(`Template ${templateName} blocked: ${reason}`);
  
  // Alert security team
  alertSecurityTeam({
    event: 'template_blocked',
    template: templateName,
    reason: reason,
    timestamp: new Date().toISOString()
  });
}

function isTemplateBlocked(templateName) {
  return BLOCKED_TEMPLATES.has(templateName);
}
```

### Rollback Procedure
```sql
-- If a bad template causes issues, rollback
BEGIN TRANSACTION;

-- Identify affected records
CREATE TEMPORARY TABLE affected_records AS
SELECT activity_id 
FROM CLAUDE_STREAM 
WHERE ts >= '2024-01-15 14:00:00'
  AND feature_json:template_name = 'BAD_TEMPLATE';

-- Remove affected records
DELETE FROM CLAUDE_STREAM
WHERE activity_id IN (SELECT activity_id FROM affected_records);

-- Log the rollback
INSERT INTO AUDIT_LOG (action, affected_count, reason)
VALUES ('ROLLBACK', (SELECT COUNT(*) FROM affected_records), 'Bad template execution');

COMMIT;
```

## Best Practices

1. **Never modify templates in production** - Test thoroughly in development
2. **Version control all templates** - Track changes with Git
3. **Document parameter constraints** - Be explicit about validation rules
4. **Monitor template performance** - Set alerts for slow queries
5. **Regular security audits** - Review templates quarterly
6. **Fail closed on validation errors** - Reject uncertain input
7. **Log all template executions** - Maintain audit trail
8. **Test with malicious input** - Include security tests in CI/CD

## References

- [OWASP SQL Injection Prevention](https://owasp.org/www-community/attacks/SQL_Injection)
- [Snowflake Security Best Practices](https://docs.snowflake.com/en/user-guide/security-best-practices)
- [Node.js Security Checklist](https://blog.risingstack.com/node-js-security-checklist/)