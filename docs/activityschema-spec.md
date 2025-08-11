# ActivitySchema v2.0 Specification

## Overview

ActivitySchema is a standard for structuring event data that enables powerful temporal analytics, customer journey tracking, and business intelligence. Version 2.0 introduces enhanced features for real-time processing, memory persistence, and provenance tracking.

## Core Schema Definition

### Required Fields

Every activity record MUST contain these fields:

```typescript
interface ActivityRecord {
  activity_id: string;           // Unique identifier (UUID v4)
  ts: timestamp;                 // Event timestamp (UTC)
  activity: string;              // Activity name (verb_noun format)
  customer?: string;             // Customer identifier
  anonymous_customer_id?: string; // Anonymous identifier
  feature_json?: object;         // Activity-specific metadata
  revenue_impact?: number;       // Revenue attribution
  link?: string;                 // Reference URL
}
```

### Field Specifications

#### activity_id
- Type: STRING
- Format: UUID v4
- Required: Yes
- Unique: Yes
- Description: Globally unique identifier for deduplication

#### ts (timestamp)
- Type: TIMESTAMP_NTZ (no timezone)
- Format: ISO 8601
- Required: Yes
- Description: When the activity occurred
- Example: `2024-01-15T14:30:00.000Z`

#### activity
- Type: STRING
- Format: `[namespace_]verb_noun`
- Required: Yes
- Max Length: 100 characters
- Examples:
  - `claude_session_start`
  - `claude_tool_call`
  - `user_signup`
  - `payment_processed`

#### customer
- Type: STRING
- Required: No (but recommended)
- Description: Identifies the customer/user/session
- Max Length: 255 characters

#### anonymous_customer_id
- Type: STRING
- Required: No
- Description: Anonymous identifier when customer is unknown
- Use Cases: Pre-login tracking, privacy compliance

#### feature_json
- Type: VARIANT/JSON
- Required: No
- Description: Activity-specific metadata
- Max Size: 16MB (Snowflake limit)
- Schema: Activity-dependent

#### revenue_impact
- Type: FLOAT
- Required: No
- Description: Revenue attribution in base currency
- Can be negative (refunds, credits)

#### link
- Type: STRING
- Required: No
- Format: Valid URL
- Description: Reference to related resource
- Max Length: 2000 characters

## Activity Naming Conventions

### Format
```
[namespace_]verb_noun[_modifier]
```

### Rules
1. Lowercase only
2. Underscore separation
3. Present tense verbs
4. Singular nouns
5. Optional namespace prefix
6. Optional modifier suffix

### Standard Verbs
- `start`, `end`, `complete`
- `create`, `update`, `delete`
- `view`, `click`, `submit`
- `process`, `fail`, `retry`
- `send`, `receive`, `acknowledge`

### Examples
```
claude_session_start
claude_tool_call
claude_error_encountered
payment_process_failed
user_profile_updated
email_campaign_sent
```

## Feature JSON Patterns

### Tool Execution Pattern
```json
{
  "tool_name": "read_file",
  "parameters": {
    "file_path": "/src/main.py"
  },
  "result_type": "success",
  "duration_ms": 125,
  "tokens_used": 450,
  "error_message": null
}
```

### User Interaction Pattern
```json
{
  "interaction_type": "click",
  "element_id": "submit_button",
  "page_url": "https://app.example.com/checkout",
  "session_duration_ms": 45000,
  "device_type": "mobile"
}
```

### System Event Pattern
```json
{
  "event_type": "deployment",
  "version": "2.0.1",
  "environment": "production",
  "deployment_id": "dep_123",
  "rollback": false,
  "duration_seconds": 300
}
```

## Temporal Analysis Features

### Activity Occurrence Tracking
```sql
-- Helper columns for temporal analysis
ALTER TABLE activities ADD COLUMN activity_occurrence INT;
ALTER TABLE activities ADD COLUMN activity_repeated_at TIMESTAMP_NTZ;

-- Calculate occurrence number
UPDATE activities t1
SET activity_occurrence = (
  SELECT COUNT(*)
  FROM activities t2
  WHERE t2.customer = t1.customer
    AND t2.activity = t1.activity
    AND t2.ts <= t1.ts
);
```

### Customer Journey Analysis
```sql
-- Find common paths
WITH journey AS (
  SELECT customer,
         activity,
         LEAD(activity) OVER (PARTITION BY customer ORDER BY ts) as next_activity
  FROM activities
)
SELECT activity, 
       next_activity, 
       COUNT(*) as frequency
FROM journey
GROUP BY activity, next_activity
ORDER BY frequency DESC;
```

## Memory and Context (v2.0)

### Insight Atoms
Structured memory units for persistent context:

```typescript
interface InsightAtom {
  atom_id: string;              // Unique identifier
  customer_id: string;          // Customer context
  subject: string;              // Entity being measured
  metric: string;               // Metric name
  value: any;                   // Metric value
  provenance_query_hash: string; // Source query hash
  ts: timestamp;                // Creation time
  ttl?: number;                // Time-to-live in seconds
}
```

### Context Cache
Aggregated customer state for fast retrieval:

```typescript
interface ContextCache {
  customer_id: string;          // Customer identifier
  context: object;              // Aggregated context
  updated_at: timestamp;        // Last update time
  version: number;              // Version number
}
```

## Provenance Tracking (v2.0)

### Query Hash Generation
```javascript
function generateQueryHash(template, params) {
  const normalized = template.replace(/\s+/g, ' ').trim();
  const paramString = JSON.stringify(params, Object.keys(params).sort());
  return crypto
    .createHash('sha256')
    .update(normalized + paramString)
    .digest('hex')
    .substring(0, 16);
}
```

### Provenance Chain
```sql
-- Track insight lineage
CREATE TABLE provenance_chain (
  query_hash STRING PRIMARY KEY,
  template_name STRING,
  query_text STRING,
  parameters VARIANT,
  created_at TIMESTAMP_NTZ,
  created_by STRING
);
```

## Implementation Guidelines

### 1. Event Ingestion
```javascript
class ActivityLogger {
  async log(activity) {
    // Validate required fields
    if (!activity.activity || !activity.ts) {
      throw new Error('Missing required fields');
    }
    
    // Generate activity_id if missing
    activity.activity_id = activity.activity_id || uuid.v4();
    
    // Ensure timestamp format
    activity.ts = new Date(activity.ts).toISOString();
    
    // Validate feature_json is object
    if (activity.feature_json && typeof activity.feature_json === 'string') {
      activity.feature_json = JSON.parse(activity.feature_json);
    }
    
    // Queue for async processing
    await this.queue.push(activity);
  }
}
```

### 2. Deduplication
```sql
-- Use MERGE for idempotent inserts
MERGE INTO activities AS target
USING (SELECT ? as activity_id, ? as ts, ? as activity, ...) AS source
ON target.activity_id = source.activity_id
WHEN NOT MATCHED THEN
  INSERT (activity_id, ts, activity, ...)
  VALUES (source.activity_id, source.ts, source.activity, ...);
```

### 3. Partitioning Strategy
```sql
-- Partition by date for efficient querying
ALTER TABLE activities 
CLUSTER BY (DATE(ts), activity);

-- Auto-clustering for large tables
ALTER TABLE activities 
SET AUTO_RECLUSTERING = TRUE;
```

## Query Patterns

### Recent Activity
```sql
SELECT * FROM activities
WHERE ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
ORDER BY ts DESC
LIMIT 100;
```

### Activity Funnel
```sql
WITH funnel AS (
  SELECT customer,
         MAX(CASE WHEN activity = 'signup_started' THEN 1 END) as step1,
         MAX(CASE WHEN activity = 'email_verified' THEN 1 END) as step2,
         MAX(CASE WHEN activity = 'profile_completed' THEN 1 END) as step3
  FROM activities
  GROUP BY customer
)
SELECT 
  COUNT(*) as total_users,
  SUM(step1) as started_signup,
  SUM(step2) as verified_email,
  SUM(step3) as completed_profile
FROM funnel;
```

### Cohort Analysis
```sql
WITH cohorts AS (
  SELECT customer,
         DATE_TRUNC('week', MIN(ts)) as cohort_week
  FROM activities
  WHERE activity = 'user_signup'
  GROUP BY customer
)
SELECT cohort_week,
       COUNT(DISTINCT c.customer) as cohort_size,
       COUNT(DISTINCT a.customer) as active_users
FROM cohorts c
LEFT JOIN activities a 
  ON c.customer = a.customer
  AND a.ts >= DATEADD(week, 1, c.cohort_week)
GROUP BY cohort_week;
```

## Best Practices

### 1. Activity Design
- Keep activity names consistent and descriptive
- Use feature_json for variable data, not new columns
- Include enough context for debugging
- Avoid PII in activity names

### 2. Performance
- Batch inserts when possible
- Use clustering keys effectively
- Implement retention policies
- Cache frequent queries

### 3. Security
- Encrypt sensitive data in feature_json
- Implement row-level security
- Audit all data access
- Mask PII in non-production

### 4. Data Quality
- Validate schema on ingestion
- Monitor for anomalies
- Track schema evolution
- Document all activities

## Migration from v1.0

### Schema Changes
```sql
-- Add v2.0 columns
ALTER TABLE activities ADD COLUMN activity_id STRING;
ALTER TABLE activities ADD COLUMN revenue_impact FLOAT;
ALTER TABLE activities ADD COLUMN link STRING;

-- Backfill activity_id
UPDATE activities 
SET activity_id = MD5(CONCAT(customer, '::', activity, '::', ts))
WHERE activity_id IS NULL;

-- Add primary key
ALTER TABLE activities ADD PRIMARY KEY (activity_id);
```

### New Tables
```sql
-- Create insight atoms table
CREATE TABLE insight_atoms AS SELECT * FROM activities WHERE 1=0;

-- Create context cache
CREATE TABLE context_cache (
  customer_id STRING PRIMARY KEY,
  context VARIANT,
  updated_at TIMESTAMP_NTZ,
  version INT DEFAULT 1
);
```

## Compliance Considerations

### GDPR
- Support right to deletion
- Enable data portability
- Track consent in feature_json
- Implement retention policies

### CCPA
- Anonymous tracking option
- Opt-out mechanism
- Data disclosure reports
- Do not sell flags

### SOC2
- Encryption at rest
- Audit logging
- Access controls
- Change management

## Reference Implementation

See the complete implementation at:
- MCP Server: `/bi-mcp-server/`
- Snowflake DDL: `/bi-snowflake-ddl/`
- Documentation: `/docs/`

For questions or contributions, see [CONTRIBUTING.md](../CONTRIBUTING.md).