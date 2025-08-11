# Product Requirements Document v2.0
# Snowflake ActivitySchema BI for Claude Desktop

## Executive Summary

A high-performance, secure Business Intelligence system that captures Claude Desktop interactions using ActivitySchema v2.0, providing real-time insights while maintaining strict latency SLOs and data isolation.

## 1. Problem Statement

### Current Challenges
- No structured logging of Claude Desktop interactions
- Lack of insights into usage patterns and performance
- Missing cost attribution for API calls
- No persistent memory across sessions
- Inability to track decision provenance

### Solution
Implement ActivitySchema v2.0 compliant logging with ultra-low latency MCP tools, async processing, and comprehensive analytics in Snowflake.

## 2. Success Metrics

### Performance SLOs
| Metric | Target | Measurement |
|--------|--------|-------------|
| First token latency | < 300ms | p95 |
| MCP get_context | < 25ms | p95 |
| Ingestion lag | < 5s | p95 |
| Card rendering | < 8s | p95 |
| Query execution | Async only | 100% |

### Business Metrics
- 100% of Claude Desktop interactions logged
- < $0.001 per interaction cost
- 99.9% data durability
- Zero customer data leakage
- < $1000/month Snowflake credits

## 3. User Stories

### As a Claude Desktop User
- I want my interactions logged without performance impact
- I want Claude to remember context from previous sessions
- I want to see insights about my usage patterns

### As a Data Analyst
- I want to query interaction data using standard SQL
- I want to track tool usage and performance metrics
- I want to identify optimization opportunities

### As a Security Admin
- I want customer data isolated with RLS
- I want all queries using SafeSQL templates
- I want audit logs of all data access

## 4. Functional Requirements

### 4.1 MCP Tools

#### log_event
- Fire-and-forget to NDJSON queue
- < 10ms local write latency
- Automatic activity_id generation
- Deduplication support

#### get_context
- Two-tier cache (memory + Redis)
- < 25ms p95 response time
- Automatic cache warming
- Graceful fallback to Snowflake

#### submit_query
- Return ticket immediately
- Async execution with progress updates
- SafeSQL template enforcement
- Byte cap with sampling fallback

#### log_insight
- Structured metric storage
- Provenance tracking via query hash
- Subject-metric-value triplets
- Temporal aggregation support

### 4.2 Data Pipeline

#### NDJSON Queue
- Append-only local file
- Rotation at 16MB or 60 seconds
- fsync on rotation
- Backpressure at 100K events

#### Uploader Service
- Snowpipe Streaming integration
- Batch size optimization
- Schema drift detection
- Automatic retry with backoff

#### Stream Processing
- Event-driven Tasks in Snowflake
- Context cache refresh every 5 minutes
- Insight atom aggregation
- Automatic cleanup of old data

### 4.3 Security Requirements

#### Data Isolation
- Row-level security on all tables
- Customer ID validation
- Cross-customer access prevention
- Session-based authentication

#### SQL Safety
- Parameterized templates only
- Input validation on all parameters
- Query timeout enforcement
- Credit consumption limits

## 5. Non-Functional Requirements

### 5.1 Performance
- Support 1000 concurrent users
- Handle 10K events/second
- < 500MB memory footprint
- < 50% CPU at normal load

### 5.2 Reliability
- 99.9% uptime SLA
- Automatic failover
- Data durability guarantees
- Graceful degradation

### 5.3 Scalability
- Horizontal scaling for MCP servers
- Auto-scaling Snowflake warehouses
- Partitioned data by time
- Archival after 90 days

### 5.4 Observability
- Prometheus metrics export
- Distributed tracing with OpenTelemetry
- Error tracking with Sentry
- Custom Snowflake dashboards

## 6. Technical Architecture

### Component Overview
```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│Claude Desktop│────▶│  MCP Server  │────▶│NDJSON Queue │
└─────────────┘     └──────────────┘     └─────────────┘
                           │                      │
                           ▼                      ▼
                    ┌──────────────┐      ┌─────────────┐
                    │ Redis Cache  │      │  Uploader   │
                    └──────────────┘      └─────────────┘
                           │                      │
                           ▼                      ▼
                    ┌──────────────┐      ┌─────────────┐
                    │  Snowflake   │◀─────│  Snowpipe   │
                    └──────────────┘      └─────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Renderer   │────▶ S3 Artifacts
                    └──────────────┘
```

### Technology Stack
- **MCP Server**: Node.js 18+, TypeScript
- **Cache**: Redis 7+ or in-memory LRU
- **Queue**: NDJSON files with rotation
- **Database**: Snowflake Enterprise
- **Storage**: S3 for artifacts
- **Monitoring**: Prometheus + Grafana

## 7. Data Model

### CLAUDE_STREAM Table
```sql
CREATE TABLE CLAUDE_STREAM (
    activity_id STRING PRIMARY KEY,
    ts TIMESTAMP_NTZ NOT NULL,
    activity STRING NOT NULL,
    customer STRING,
    anonymous_customer_id STRING,
    feature_json VARIANT,
    revenue_impact FLOAT,
    link STRING
) CLUSTER BY (activity, ts);
```

### INSIGHT_ATOMS Table
```sql
CREATE TABLE INSIGHT_ATOMS (
    atom_id STRING PRIMARY KEY,
    customer_id STRING NOT NULL,
    subject STRING NOT NULL,
    metric STRING NOT NULL,
    value VARIANT NOT NULL,
    provenance_query_hash STRING,
    ts TIMESTAMP_NTZ NOT NULL
) CLUSTER BY (subject, metric, ts);
```

### CONTEXT_CACHE Table
```sql
CREATE TABLE CONTEXT_CACHE (
    customer_id STRING PRIMARY KEY,
    context VARIANT NOT NULL,
    updated_at TIMESTAMP_NTZ NOT NULL,
    version INT NOT NULL
);
```

### ARTIFACTS Table
```sql
CREATE TABLE ARTIFACTS (
    artifact_id STRING PRIMARY KEY,
    customer_id STRING NOT NULL,
    s3_url STRING NOT NULL,
    size_bytes INT NOT NULL,
    content_type STRING,
    created_at TIMESTAMP_NTZ NOT NULL,
    expires_at TIMESTAMP_NTZ
);
```

## 8. Development Timeline (10 Weeks)

### Weeks 1-2: Foundation
- Snowflake DDL implementation
- MCP server core with 4 tools
- Basic NDJSON queue
- Unit test framework

### Weeks 3-4: Memory System
- Insight Atoms implementation
- Context Cache with refresh
- Redis integration
- Stream/Task setup

### Weeks 5-6: Async UX
- Ticket system for queries
- Progress update mechanism
- Byte cap with sampling
- Artifact storage in S3

### Weeks 7-8: Observability
- Metrics collection
- Dashboard creation
- Alert configuration
- Performance optimization

### Weeks 9-10: Hardening
- Security audit
- Chaos testing
- Documentation
- Production deployment

## 9. Risk Mitigation

### Technical Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Latency SLO miss | High | Two-tier caching, profiling |
| Queue overflow | Medium | Backpressure, sampling |
| SQL injection | Critical | SafeSQL templates only |
| Credit overrun | High | Resource monitors, kill switch |
| Data loss | High | Durable queue, checksums |

### Operational Risks
- On-call rotation for incidents
- Runbooks for common issues
- Automated rollback procedures
- Regular disaster recovery drills

## 10. Success Criteria

### Launch Readiness Checklist
- [ ] All p95 latency SLOs met
- [ ] 1000 user load test passed
- [ ] Security audit complete
- [ ] Zero data leakage verified
- [ ] Monitoring dashboards live
- [ ] Runbooks documented
- [ ] Team trained on operations
- [ ] Rollback plan tested

### Post-Launch Metrics
- Week 1: 50% of sessions logged
- Week 2: 90% of sessions logged
- Week 4: Full production rollout
- Month 2: Cost optimization complete
- Month 3: Advanced analytics available

## 11. Open Questions

1. Should we support multi-region deployment?
2. What's the retention policy for raw events?
3. Do we need GDPR compliance features?
4. Should context cache be per-user or per-session?
5. What's the budget for Snowflake credits?

## 12. Appendix

### A. Glossary
- **ActivitySchema**: Standard for event logging
- **MCP**: Model Context Protocol
- **SafeSQL**: Parameterized query templates
- **Insight Atoms**: Structured metric storage
- **Provenance**: Query lineage tracking

### B. References
- [ActivitySchema v2.0 Spec](https://activityschema.com/v2)
- [MCP Protocol](https://github.com/anthropics/mcp)
- [Snowflake Best Practices](https://docs.snowflake.com)
- [Claude Desktop Docs](https://claude.ai/docs)

### C. Dependencies
- Snowflake account with Enterprise features
- AWS S3 bucket for artifacts
- Redis instance or memory for caching
- Node.js 18+ runtime environment
- Monitoring infrastructure (Prometheus/Grafana)