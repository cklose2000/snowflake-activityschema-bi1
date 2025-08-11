# Snowflake DDL - ActivitySchema v2.0 Compliant

## Overview

This directory contains DDL scripts for creating a **strict ActivitySchema v2.0 compliant** data warehouse for Claude Desktop BI. The new structure separates spec-required fields from tool-specific extensions, ensuring org-wide compatibility.

## Directory Structure

```
bi-snowflake-ddl/
├── 00_master_v2_compliant.sql    # Master script - RUN THIS
├── sql/                           # Individual DDL components
│   ├── ddl_analytics_activity_events.sql    # Core v2.0 events table
│   ├── ddl_activity_cdesk_extensions.sql    # Claude Desktop extensions
│   ├── ddl_streams_tasks.sql                # Event-driven processing
│   ├── ddl_typed_views.sql                  # Typed access views
│   └── ddl_governance.sql                   # Security policies
└── [deprecated]/                  # Old non-compliant structure
    ├── 01_tables.sql
    ├── 02_streams.sql
    ├── 03_tasks.sql
    ├── 04_views.sql
    ├── 05_policies.sql
    └── 06_resource_monitors.sql
```

## Key Design Principles

### 1. Strict ActivitySchema v2.0 Compliance
- **Required fields**: `activity`, `customer`, `ts`, `activity_occurrence`, `activity_repeated_at`
- **Optional fields**: `link`, `revenue_impact`
- **Extensions**: Prefixed with underscore (`_feature_json`, `_query_tag`, etc.)

### 2. Schema Separation
- `analytics.activity.*` - Spec-compliant objects only
- `analytics.activity_cdesk.*` - Claude Desktop specific extensions
- `analytics.activity._ingest_ids` - Deduplication tracking

### 3. Performance Optimization
- Clustering by `(customer, ts)` for time-series queries
- Materialized views for typed access
- Event-driven context refresh via streams/tasks

## Installation

### Quick Start
```sql
-- Run the master script to create everything
!source 00_master_v2_compliant.sql
```

### Manual Installation
```sql
-- 1. Core events table
!source sql/ddl_analytics_activity_events.sql

-- 2. Claude Desktop extensions
!source sql/ddl_activity_cdesk_extensions.sql

-- 3. Streams and tasks
!source sql/ddl_streams_tasks.sql

-- 4. Typed views
!source sql/ddl_typed_views.sql

-- 5. Governance policies
!source sql/ddl_governance.sql
```

## Table Descriptions

### Core Tables (Spec Compliant)

#### `analytics.activity.events`
Main event stream following strict ActivitySchema v2.0:
- Required fields only (no spec violations)
- Extensions prefixed with underscore
- Clustered by `(customer, ts)` for performance

#### `analytics.activity._ingest_ids`
Deduplication tracking for idempotent ingestion

### Extension Tables (Claude Desktop)

#### `analytics.activity_cdesk.insight_atoms`
Structured memory for persistent context:
- Subject-metric-value triplets
- Provenance tracking
- TTL support

#### `analytics.activity_cdesk.artifacts`
Large result storage metadata:
- S3 references for actual data
- Sample preview (≤10 rows)
- Content schema tracking

#### `analytics.activity_cdesk.context_cache`
Read-optimized customer state:
- Aggregated metrics and intents
- Auto-refresh via streams/tasks
- < 25ms retrieval target

## Views

### `analytics.activity.vw_events_base`
Base columns only (no extensions) for spec-compliant consumers

### `analytics.activity_cdesk.vw_llm_events`
Typed access to LLM event data from `_feature_json`

### `analytics.activity_cdesk.vw_sql_events`
SQL execution metrics joined with QUERY_HISTORY

## Security Features

### Row-Level Security (RLS)
- Customer isolation via `rap_customer` policy
- Users can only see their own data

### Data Masking
- PII fields masked in `_feature_json`
- Role-based unmasking for authorized users

### Retention Policies
- 180 days for events
- 90 days for artifacts
- Configurable per table

## Migration from Old Structure

### Mapping Old → New
| Old Table | New Table |
|-----------|-----------|
| `CLAUDE_LOGS.ACTIVITIES.CLAUDE_STREAM` | `analytics.activity.events` |
| `CLAUDE_LOGS.ACTIVITIES.INSIGHT_ATOMS` | `analytics.activity_cdesk.insight_atoms` |
| `CLAUDE_LOGS.ACTIVITIES.CONTEXT_CACHE` | `analytics.activity_cdesk.context_cache` |
| `CLAUDE_LOGS.ACTIVITIES.ARTIFACTS` | `analytics.activity_cdesk.artifacts` |

### Field Changes
- `feature_json` → `_feature_json` (underscore prefix)
- `activity_id` → Removed (using dedup table instead)
- Added: `activity_occurrence`, `activity_repeated_at`
- Added: `_source_system`, `_source_version`, `_session_id`, `_query_tag`

## Usage Examples

### Insert Event (v2.0 Compliant)
```sql
INSERT INTO analytics.activity.events (
    activity, customer, ts, activity_occurrence,
    link, revenue_impact,
    _feature_json, _source_system, _source_version, _session_id, _query_tag
) VALUES (
    'cdesk.user_asked',
    'user123',
    CURRENT_TIMESTAMP(),
    1,
    NULL,
    0.001,
    OBJECT_CONSTRUCT('model', 'claude-3', 'tokens', 450),
    'claude_desktop',
    '2.0',
    'session_abc',
    'cdesk'
);
```

### Query Recent Events
```sql
-- Spec-compliant query (no extensions)
SELECT * FROM analytics.activity.vw_events_base
WHERE customer = 'user123'
  AND ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP());

-- With extensions
SELECT * FROM analytics.activity.events
WHERE customer = 'user123'
  AND _source_system = 'claude_desktop';
```

### Access Typed Views
```sql
-- LLM metrics
SELECT * FROM analytics.activity_cdesk.vw_llm_events
WHERE customer = 'user123';

-- SQL execution metrics
SELECT * FROM analytics.activity_cdesk.vw_sql_events
WHERE success = TRUE;
```

## Monitoring

### Check Stream Status
```sql
SHOW STREAMS IN SCHEMA analytics.activity_cdesk;
SELECT SYSTEM$STREAM_HAS_DATA('analytics.activity_cdesk.s_events');
```

### Check Task Status
```sql
SHOW TASKS IN SCHEMA analytics.activity_cdesk;
SELECT * FROM TABLE(INFORMATION_SCHEMA.TASK_HISTORY())
WHERE NAME IN ('T_REFRESH_CONTEXT', 'T_DERIVATIONS')
ORDER BY SCHEDULED_TIME DESC;
```

## Best Practices

1. **Always use underscore prefix for extensions** - Ensures spec compliance
2. **Set QUERY_TAG='cdesk'** - Enables query tracking and joins
3. **Use typed views for analysis** - Better performance than parsing VARIANT
4. **Monitor task execution** - Ensure context refresh is working
5. **Test RLS policies** - Verify customer isolation

## Troubleshooting

### Context not updating
```sql
-- Check if stream has data
SELECT SYSTEM$STREAM_HAS_DATA('analytics.activity_cdesk.s_events');

-- Check task status
SHOW TASKS LIKE 't_refresh_context';

-- Resume task if suspended
ALTER TASK analytics.activity_cdesk.t_refresh_context RESUME;
```

### Performance issues
```sql
-- Check clustering status
SELECT SYSTEM$CLUSTERING_INFORMATION('analytics.activity.events');

-- Re-cluster if needed
ALTER TABLE analytics.activity.events RECLUSTER;
```

## Support

For issues or questions:
1. Check this README first
2. Review the ActivitySchema v2.0 spec
3. Check CLAUDE.md for project-specific configuration