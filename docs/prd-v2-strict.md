# PRD — Snowflake-Native ActivitySchema BI for Claude Desktop (v2.0) — Strict Activity Schema

**Scope note**: This project logs Claude Desktop activity only. Claude Code integration is explicitly out of scope for this PRD and will be a follow-on project.

## Core Promise
"Ask once, stay in flow, no context juggling." If the user has to think about models, tokens, tabs, environments, or performance, we failed.

## What's New in This Revision
- The base stream is now `analytics.activity.events` and adheres strictly to Activity Schema v2:
  - Required columns: `activity`, `customer`, `ts`, `activity_repeated_at`, `activity_occurrence`
  - Optional spec columns: `link`, `revenue_impact`
- All extra fields live in underscore-prefixed columns (ignored by spec)
- All Claude Desktop activities are namespaced as `cdesk.*` (e.g., `cdesk.user_asked`, `cdesk.sql_executed`)
- Tool-specific optimizations (insight atoms, artifacts, context cache, typed views) live under `analytics.activity_cdesk.*` and do not alter the base spec surface

## Goals
1. Chat-first BI in Claude Desktop with no visible context management
2. All activities and insights stored in Snowflake; structured memory only
3. Big results delivered as insight cards + renderer link (no big tables in chat)
4. Hard SLOs for latency and ingestion; cost guardrails, provenance everywhere

## Non-Goals (Clarified)
- No Claude Code in this phase
- No full dashboard builder (renderer is minimal)
- No schema deviations from Activity Schema v2 in the base stream

## Users & UX Principles
- Single conversation thread
- Cards not spreadsheets
- Structured memory
- Progress via ticket pattern
- Zero local friction

## Functional Requirements (Patched)

### Activity Capture (Claude Desktop Only)
- Write each event into `analytics.activity.events` using namespaced activity values (`cdesk.*`)
- Use org-canonical customer id; place session id in `_session_id`
- Compute and store `activity_occurrence` and `activity_repeated_at`
- Put telemetry (tokens, latency, rows, bytes, model, warehouse, etc.) in `_feature_json`
- Set `_query_tag = 'cdesk_' || short_uuid` and also set Snowflake QUERY_TAG for provenance
- Use `link` for renderer artifact ids/URLs; `revenue_impact` (one unit, consistent)

### Structured Memory
- `analytics.activity_cdesk.insight_atoms` is the ONLY authoritative recall mechanism for insights/metrics
- Prose summaries are non-authoritative and stored only as artifacts if needed

### Artifacts & Renderer
- `analytics.activity_cdesk.artifacts` stores preview/sample and metadata
- Full data in S3 with pre-signed pagination
- Chat always shows headline + ≤10-row preview + link

### Context Cache (Read-Optimization)
- `analytics.activity_cdesk.context_cache` contains a single VARIANT blob of metrics/filters/definitions/recent intents
- Derived event-driven from Streams/Tasks
- MCP reads this blob in <25ms

### SafeSQL Templates & Guardrails
- Template-only generation with param binding
- Dry-run/estimate
- Byte caps
- Sampled fallback (visible watermark)
- `QUERY_TAG='cdesk_[uuid]'`

### Governance
- Row Access on customer
- Masking on `_feature_json` for sensitive elements
- Retention: events ≥180d, artifacts ≥90d (legal hold overrides)

### Observability
Dashboards for:
- MCP p50/p95
- get_context p95
- Ingestion lag
- Queue depth
- Snowpipe errors
- Credits/day
- % answers with clickable provenance (≥98%)

## System Architecture
- **Ultra-light Node MCP**: `log_event`, `get_context`, `submit_query`, `log_insight`
- **Local NDJSON queue** → Snowpipe Streaming (async)
- **Snowflake**: base stream (strict), cdesk extensions, Streams/Tasks, typed views, policies
- **S3 + Renderer API** for artifacts (pre-signed URLs)
- No proxies/mmap/sidecars
- No synchronous DB writes in the turn path

## Data Model (Now Spec-True)

### Base Stream
`analytics.activity.events` — strict columns only:
```sql
CREATE TABLE analytics.activity.events (
  -- REQUIRED BY SPEC
  activity                 STRING           NOT NULL,
  customer                 STRING           NOT NULL,
  ts                       TIMESTAMP_NTZ    NOT NULL,
  activity_repeated_at     TIMESTAMP_NTZ,
  activity_occurrence      NUMBER           NOT NULL,
  
  -- OPTIONAL BY SPEC
  link                     STRING,
  revenue_impact           NUMBER,
  
  -- EXTENSIONS (underscore prefix)
  _feature_json            VARIANT,
  _source_system           STRING DEFAULT 'claude_desktop',
  _source_version          STRING DEFAULT '2.0',
  _session_id              STRING,
  _query_tag               STRING
) CLUSTER BY (customer, ts);
```

### Extensions
- `analytics.activity_cdesk.insight_atoms` - Structured memory
- `analytics.activity_cdesk.artifacts` - Large result metadata
- `analytics.activity_cdesk.context_cache` - Read-optimized state

### Typed Views
- `vw_llm_events` - Read `_feature_json` for LLM metrics
- `vw_sql_events` - Join QUERY_HISTORY by `_query_tag`

## Activity Namespace Convention

All Claude Desktop activities MUST use the `cdesk.*` namespace:

### Core Activities
- `cdesk.session_started` - New session initiated
- `cdesk.session_ended` - Session terminated
- `cdesk.user_asked` - User submitted a question
- `cdesk.claude_responded` - Claude provided an answer

### Tool Activities
- `cdesk.tool_called` - Any tool invocation
- `cdesk.sql_executed` - SQL query submitted
- `cdesk.sql_completed` - SQL query finished
- `cdesk.file_read` - File accessed
- `cdesk.file_written` - File created/modified

### Memory Activities
- `cdesk.insight_recorded` - Insight atom created
- `cdesk.context_refreshed` - Context cache updated
- `cdesk.artifact_created` - Large result stored

### Error Activities
- `cdesk.error_encountered` - Any error occurred
- `cdesk.retry_attempted` - Operation retried
- `cdesk.fallback_triggered` - Degraded mode activated

## SLOs / SLAs
| Metric | Target | Measurement |
|--------|--------|-------------|
| First token | < 300ms | p95 |
| MCP get_context | < 25ms | p95 |
| Card ready | < 8s | p95 |
| Ingestion lag | < 5s | p95 |
| Never dump big tables in chat | 100% | Binary |

## Acceptance Criteria
1. Re-ask same question in 24h → same value (± tolerance) with identical provenance
2. Byte cap → sampled answer with watermark
3. Schema drift → incident + quarantine
4. Validation: dbt tests confirm presence and non-null of the five required columns
5. Optional columns allowed; underscore fields ignored by spec

## Migration & Cutover
1. Dual-write window (48–72h)
2. Backfill + checksums
3. Cutover flag
4. Rollback path
5. Version stamping

## Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Schema drift | High | dbt spec tests + underscore isolation |
| Query injection | Critical | SafeSQL templates only |
| Context staleness | Medium | 5-minute refresh via Tasks |
| Credit overrun | High | Resource monitors + kill switch |
| Memory overflow | Medium | LRU cache + Redis fallback |

## Dev To-Dos (Implementation)
- [x] Replace any feature_1/2/3 usage with `_feature_json` (typed payload)
- [x] Ensure all activity values are namespaced (`cdesk.*`)
- [x] Compute window fields (`activity_occurrence`, `activity_repeated_at`) via `t_derivations`
- [x] Set `_query_tag` AND Snowflake QUERY_TAG for all system SQL
- [x] Point renderer/typed views to the strict base stream and `_feature_json`

## Success Metrics
- 100% of Claude Desktop interactions logged
- < $0.001 per interaction cost
- 99.9% data durability
- Zero customer data leakage
- < $1000/month Snowflake credits
- ≥98% queries with provenance

## Timeline
- Week 1-2: Foundation (DDL, MCP tools, queue)
- Week 3-4: Memory system (Insight Atoms, context)
- Week 5-6: Async UX (tickets, progress, artifacts)
- Week 7-8: Observability (metrics, dashboards)
- Week 9-10: Governance & production hardening

## Appendix: Query Tag Format

Query tags follow the format `cdesk_[shortUuid]` where:
- `cdesk_` is the constant prefix
- `[shortUuid]` is the first 8 characters of a UUID v4

Example: `cdesk_a1b2c3d4`

This tag is used for:
1. Setting the `_query_tag` field in events table
2. Setting Snowflake's session QUERY_TAG
3. Joining with QUERY_HISTORY for metrics

## Appendix: Structured Memory Philosophy

**Insight Atoms are the ONLY authoritative recall mechanism.**

- Prose summaries: Non-authoritative, for display only
- Context cache: Derived from atoms, not source of truth
- Artifacts: Store samples and metadata, not insights
- All business logic must reference atoms, not prose

This ensures:
- Consistent recall across sessions
- Provenance tracking for all insights
- No hallucination in metric reporting
- Audit trail for all decisions