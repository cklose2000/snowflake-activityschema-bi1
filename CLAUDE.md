# Snowflake ActivitySchema BI for Claude Desktop

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
- QUERY_TAG='cdesk' on ALL Snowflake queries

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
- `analytics.activity.events`: Core v2.0 compliant event stream (spec fields only)
- `analytics.activity_cdesk.insight_atoms`: Structured memory with subject, metric, value, provenance
- `analytics.activity_cdesk.artifacts`: Large result storage with S3 references
- `analytics.activity_cdesk.context_cache`: Customer state blob for < 25ms retrieval
- `analytics.activity._ingest_ids`: Deduplication tracking for idempotent ingestion

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
  activity: string;          // ActivitySchema activity name (e.g., 'cdesk.user_asked')
  feature_json: object;      // Event metadata (stored as _feature_json extension)
  link?: string;             // Reference URL
}
// Returns: void (fire-and-forget to NDJSON queue)
// Latency: < 10ms local write
// Note: Writes to analytics.activity.events with v2.0 compliance
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
- Account: FBC56289.us-east-1.aws
- Warehouse: COMPUTE_XS
- Database: ANALYTICS
- Schema: ACTIVITY (base) / ACTIVITY_CDESK (extensions)
- Role: ACCOUNTADMIN

### Query Standards
- ALWAYS set QUERY_TAG='cdesk'
- Use clustering keys on (activity, ts)
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