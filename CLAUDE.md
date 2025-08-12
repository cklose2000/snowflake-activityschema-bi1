# Snowflake ActivitySchema BI for Claude Desktop

## ✅ CURRENT IMPLEMENTATION STATUS

**IMPORTANT**: The system correctly uses `CLAUDE_LOGS.ACTIVITIES` as the production database location:
- **Environment uses**: `CLAUDE_LOGS.ACTIVITIES` (CORRECT - this is the actual Snowflake location)
- **Templates use**: `CLAUDE_LOGS.ACTIVITIES.*` (CORRECT - aligned with environment)
- **Note**: While the PRD references `analytics.activity.*` conceptually, the actual implementation uses `CLAUDE_LOGS.ACTIVITIES` per the Snowflake environment configuration

The system is properly configured to use the correct production database.

## 🛡️ VALIDATION PHILOSOPHY: Trust but Verify

**No victory without validation.** Every claim of success, completion, or achievement MUST be independently verified before acceptance. This is not about cynicism - it's about professionalism and reliability.

### Automatic Validation Triggers
When ANY of these phrases appear, validation is MANDATORY:
- ✅ (checkmarks) - Each one needs evidence
- "Complete", "Successfully", "Finished" - Run the tests
- "100%", "Fully", "All" - Find the exception
- "Ready for production" - Invoke chaos-tester
- "X ms latency achieved" - Load test immediately
- "Compliant", "Passing", "Working" - Prove it

### Validation Agents
- **victory-auditor**: Challenges all success claims with evidence requests
- **chaos-tester**: Attempts to break "production ready" systems
- **meta-auditor**: Ensures auditors maintain appropriate standards

### Before Declaring Victory Checklist
- [ ] Unit tests pass with >80% coverage
- [ ] Integration tests complete
- [ ] Load tests meet all SLOs
- [ ] Chaos testing survived (Level 3)
- [ ] victory-auditor ran and passed
- [ ] Performance verified under adverse conditions
- [ ] Rollback procedure tested
- [ ] Documentation complete
- [ ] Edge cases handled

## CRITICAL CONSTRAINTS
- First token latency MUST be < 300ms
- MCP get_context p95 MUST be < 25ms  
- NO synchronous DB writes in turn path
- NO inline rendering of tables > 10 rows
- ALL data operations MUST use SafeSQL templates
- QUERY_TAG='cdesk_[shortUuid]' on ALL Snowflake queries (8-char UUID prefix)
- ALL activities MUST use `cdesk.*` namespace (e.g., `cdesk.user_asked`, `cdesk.sql_executed`)
- STRICT ActivitySchema v2.0 compliance - NO deviations in base stream

## Project Architecture
- **Claude Desktop MCP**: Node.js ultra-light tools for minimal latency
- **NDJSON Queue**: Append-only local file with async upload to Snowflake
- **Snowflake**: Single source of truth via ActivitySchema v2.0
- **S3**: Artifact storage with pre-signed URLs for large results
- **Renderer**: Minimal Express/Next API for card rendering

## Development Priorities (10-week plan)
- **W1-2**: Foundation (DDL, logger, uploader)
- **W3-4**: Memory (Insight Atoms, context cache)
- **W5-6**: Async UX (tickets, progress, sampling)
- **W7-8**: Observability (metrics, alerts)
- **W9-10**: Governance & hardening

## Key Tables (Strict ActivitySchema v2.0)
- `CLAUDE_LOGS.ACTIVITIES.events`: Core v2.0 compliant event stream
  - **Required columns**: `activity`, `customer`, `ts`, `activity_repeated_at`, `activity_occurrence`
  - **Optional spec columns**: `link`, `revenue_impact`
  - **Extensions** (underscore prefix): `_feature_json`, `_source_system`, `_source_version`, `_session_id`, `_query_tag`
- `CLAUDE_LOGS.ACTIVITIES.insight_atoms`: Structured memory (ONLY authoritative recall mechanism)
- `CLAUDE_LOGS.ACTIVITIES.artifacts`: Large result storage with S3 references
- `CLAUDE_LOGS.ACTIVITIES.context_cache`: Read-optimized state blob for < 25ms retrieval
- `CLAUDE_LOGS.ACTIVITIES._ingest_ids`: Deduplication tracking for idempotent ingestion

## Import Context
- @docs/prd-v2.md - Complete product requirements and SLOs
- @docs/activityschema-spec.md - ActivitySchema v2.0 specification
- @docs/safesql-templates.md - SQL injection prevention templates

## Performance Requirements
| Metric | Target | Measure |
|--------|--------|---------|
| First token latency | < 300ms | p95 |
| MCP get_context | < 25ms | p95 |
| Ingestion lag | < 5s | p95 |
| Card ready | < 8s | p95 |
| Query execution | Async only | 100% |

## Security Requirements
- All SQL MUST use SafeSQL templates (no dynamic generation)
- Row-level security enforced at database level
- Customer data isolation with RLS policies
- PII masking in all views
- Credit burn monitors with kill switches

## Development Workflow

### Daily TDD Cycle with Validation
1. Write tests for feature before implementation
2. Run tests to confirm they fail correctly
3. Implement to make tests pass
4. Use performance-optimizer agent to verify < 25ms latency
5. Run security-auditor agent for SQL injection checks
6. **NEW: Run victory-auditor on any success claims**
7. **NEW: If claiming "ready", run chaos-tester Level 1-3**
8. **NEW: Document evidence for all performance claims**

### Evidence-Based Development
- **Never claim** - Always prove with test output
- **Performance claims** require load test evidence (not single-request)
- **"Working" claims** require integration test results
- **"Complete" claims** require coverage reports
- **"Production ready"** requires chaos test survival report

### Commit Discipline
- Conventional commits (feat:, fix:, docs:, test:, perf:)
- Update CHANGELOG.md with each feature
- Tag with feature flags for gradual rollout
- Never commit secrets or credentials

### Testing Strategy
- Unit tests with > 80% coverage
- Integration tests with test-integration command
- Load tests with 1000 concurrent users
- Security tests with bi-red-teamer agent
- Chaos engineering for failure scenarios

## MCP Tools Specification

### 1. log_event
```typescript
interface LogEventParams {
  activity: string;          // MUST use cdesk.* namespace (e.g., 'cdesk.user_asked')
  feature_json: object;      // Event metadata (stored as _feature_json extension)
  link?: string;             // Reference URL (spec-compliant optional column)
  revenue_impact?: number;   // Revenue attribution (spec-compliant optional column)
}
// Returns: void (fire-and-forget to NDJSON queue)
// Latency: < 10ms local write
// Note: Writes to CLAUDE_LOGS.ACTIVITIES.events with strict v2.0 compliance
// Automatically computes: activity_occurrence, activity_repeated_at
// Sets: _query_tag='cdesk_[shortUuid]', _source_system='claude_desktop'
```

### 2. get_context
```typescript
interface GetContextParams {
  customer_id: string;       // Customer identifier
  max_bytes?: number;        // Response size limit
}
// Returns: object (context from cache/CONTEXT_CACHE table)
// Latency: < 25ms p95
```

### 3. submit_query
```typescript
interface SubmitQueryParams {
  template: string;          // SafeSQL template name
  params: object;            // Template parameters
  byte_cap?: number;         // Result size limit
}
// Returns: { ticket_id: string }
// Latency: < 50ms (ticket generation only)
```

### 4. log_insight
```typescript
interface LogInsightParams {
  subject: string;           // Entity being measured
  metric: string;            // Metric name
  value: any;                // Metric value
  provenance_query_hash: string;  // Source query hash
}
// Returns: void (async write to queue)
// Latency: < 10ms local write
```

## Snowflake Configuration

### Connection Details
- Account: FBC56289.us-east-1.aws (or yshmxno-fbc56289)
- Warehouse: COMPUTE_WH (or COMPUTE_XS)
- Database: CLAUDE_LOGS (production database)
- Schema: ACTIVITIES (contains all tables)
- Role: CLAUDE_DESKTOP_ROLE (or ACCOUNTADMIN for setup)

### Table Organization
All tables live in `CLAUDE_LOGS.ACTIVITIES` schema:
- Base stream: `events` table (ActivitySchema v2.0 compliant)
- Extensions: `insight_atoms`, `artifacts`, `context_cache`, `_ingest_ids`

### Query Standards
- ALWAYS set QUERY_TAG='cdesk_[shortUuid]' (8-char UUID prefix)
- Use clustering keys on (customer, ts) per spec
- Required columns MUST be non-null: activity, customer, ts, activity_occurrence
- Implement micro-partitions for time-series
- Enable query result caching
- Set statement timeout to 30s

## Component Responsibilities

### bi-snowflake-ddl/
- Idempotent DDL scripts
- Resource monitors and credit caps
- Row-level security policies
- Masking policies for PII
- Streams and Tasks for event processing

### bi-mcp-server/
- Ultra-light Node.js implementation
- Redis/memory cache for context
- NDJSON queue writer
- Ticket generation for async queries
- < 25ms p95 for all synchronous operations

### bi-uploader/
- NDJSON file rotation and upload
- Snowpipe Streaming integration
- Backpressure handling
- Deduplication on activity_id
- Schema drift detection

### bi-renderer/
- Minimal Express/Next API
- S3 pre-signed URL generation
- Card rendering < 8s p95
- Progressive loading support
- Byte cap enforcement

## Error Handling

### Failure Modes
1. **Uploader crash**: Resume from last checkpoint
2. **Queue overflow**: Apply backpressure, sample events
3. **Schema drift**: Quarantine events, raise alert
4. **Credit exhaustion**: Kill switch activation
5. **Network failure**: Local queue buffering

### Recovery Procedures
- Automatic retry with exponential backoff
- Circuit breaker for failing services
- Graceful degradation with sampling
- Manual intervention runbooks

## Monitoring & Observability

### Key Metrics
- Latency percentiles (p50, p95, p99)
- Throughput (events/sec, queries/sec)
- Error rates by component
- Queue depth and lag
- Credit consumption rate

### Alerting Thresholds
- First token > 300ms: Page on-call
- get_context > 25ms: Warning → Critical
- Queue depth > 100K: Apply backpressure
- Credit burn > $100/hour: Kill switch
- Error rate > 1%: Investigation required

## Activity Namespace Convention (cdesk.*)

ALL Claude Desktop activities MUST use the `cdesk.*` namespace:

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

## Structured Memory Philosophy

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

## Launch Criteria

### Go/No-Go Checklist
- [ ] All p95 latency SLOs met in production-like environment
- [ ] 1000 concurrent user load test passed
- [ ] Security audit passed (no SQL injection vulnerabilities)
- [ ] Data isolation verified across customers
- [ ] Rollback procedures tested and documented
- [ ] Monitoring and alerting configured
- [ ] Runbooks for all failure scenarios
- [ ] Performance degradation plan tested

## References
- [ActivitySchema v2.0 Specification](https://activityschema.com/v2)
- [Snowflake Best Practices](https://docs.snowflake.com/en/user-guide/performance)
- [MCP Protocol Documentation](https://github.com/anthropics/mcp)
- [Claude Desktop Integration Guide](https://claude.ai/docs/desktop)