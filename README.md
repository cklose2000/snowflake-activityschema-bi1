# Snowflake ActivitySchema BI for Claude Desktop

A high-performance Business Intelligence system that captures Claude Desktop interactions using ActivitySchema v2.0 with < 25ms p95 latency.

## 🚨 Current Status

**Victory Audit Score: 40% (NOT PRODUCTION READY)**

| Component | Status | Evidence |
|-----------|--------|----------|
| MCP Server | 🟡 Built | Not tested under load |
| Snowflake DDL | ✅ Deployed | 46 tables in POC |
| Uploader Service | ✅ Implemented | Ready for testing |
| Performance SLO | ❌ Unverified | < 25ms p95 not proven |
| Load Testing | ✅ Suite Ready | Not executed |
| Chaos Testing | ❌ Missing | No resilience testing |
| Production Ready | ❌ No | Multiple gaps |

## 🏗️ Architecture

```
Claude Desktop → MCP Server → NDJSON Queue → Uploader → Snowflake
                     ↓                                        ↓
                Context Cache                          Analytics Views
```

### Components

- **bi-mcp-server**: Ultra-light Node.js MCP tools (< 25ms p95 target)
- **bi-uploader**: NDJSON to Snowflake streaming service
- **bi-snowflake-ddl**: ActivitySchema v2.0 compliant DDL
- **bi-renderer**: Card rendering service (future)

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Snowflake account with ACCOUNTADMIN access
- Redis (optional, falls back to memory cache)

### Installation

```bash
# Clone repository
git clone https://github.com/cklose2000/snowflake-activityschema-bi1.git
cd snowflake-activityschema-bi

# Install dependencies
npm run setup

# Copy environment template
cp .env.example .env
# Edit .env with your Snowflake credentials
```

### Deployment

```bash
# Deploy Snowflake DDL
npm run deploy

# Start MCP server
cd bi-mcp-server && npm run start:dev

# Start uploader service (separate terminal)
cd bi-uploader && npm start

# Run victory audit to verify
npm run validate:victory
```

## 🧪 Testing

### Victory Auditor

Automatically challenges all success claims:

```bash
# Manual audit
npm run validate:victory

# Automatic on commit (via git hook)
git commit -m "✅ Feature complete"  # Will trigger audit
```

### Load Testing

Test performance under realistic conditions:

```bash
# Quick test (30s, 50 users)
npm run load-test:quick

# Full test (5min, 1000 users)
npm run load-test:full
```

### Integration Testing

```bash
# Run all integration tests
npm run test:integration

# Test Snowflake connection
npm run test:connection
```

## 📊 Performance Requirements

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| First token latency | < 300ms p95 | Unknown | ❌ |
| MCP get_context | < 25ms p95 | Unknown | ❌ |
| Ingestion lag | < 5s p95 | Unknown | ❌ |
| Concurrent users | 1000+ | 0 tested | ❌ |

## 🔒 Security

- **SafeSQL Templates**: All queries use parameterized templates
- **Row-Level Security**: Customer data isolation enforced
- **Query Tags**: Provenance tracking with `cdesk_[uuid]`
- **Credential Management**: Uses environment variables

⚠️ **Known Issues**:
- 8-character UUIDs have collision risk at ~77K queries
- No rate limiting implemented
- Missing penetration testing

## 🛠️ Development

### VSCode Tasks

Press `Ctrl+Shift+P` and run:
- **Victory Audit** - Validate all claims
- **Quick Performance Test** - Run benchmarks
- **Start MCP Server** - Launch development server

### Git Hooks

Pre-commit hook automatically runs victory audit when detecting:
- ✅ Checkmarks
- "Complete" or "Successfully"
- "100%" claims
- "Ready for production"

### CI/CD

GitHub Actions run on every PR:
- Victory audit for claims validation
- Performance checks for latency claims
- Security scanning

## 📋 Configuration

### Environment Variables

```bash
# Snowflake Configuration
SNOWFLAKE_ACCOUNT=your-account
SNOWFLAKE_USERNAME=your-username
SNOWFLAKE_PASSWORD=your-password
SNOWFLAKE_DATABASE=CLAUDE_LOGS
SNOWFLAKE_SCHEMA=ACTIVITIES
SNOWFLAKE_ROLE=CLAUDE_DESKTOP_ROLE

# Performance Settings
MAX_QUEUE_SIZE=100000
CACHE_TTL=3600

# Optional: Redis Cache
REDIS_URL=redis://localhost:6379
```

### MCP Tools

| Tool | Purpose | Latency Target |
|------|---------|----------------|
| log_event | Fire-and-forget event logging | < 10ms |
| get_context | Retrieve customer context | < 25ms p95 |
| submit_query | Async query submission | < 50ms |
| log_insight | Store structured insights | < 10ms |

## 📈 Monitoring

### Metrics Endpoint

```bash
# MCP Server metrics
curl http://localhost:3000/metrics

# Uploader metrics
curl http://localhost:9091/metrics
```

### Key Metrics

- Event ingestion rate
- Queue depth
- Cache hit ratio
- P95 latency by operation
- Error rates

## 🚧 Roadmap

### Immediate (Week 1)
- [ ] Run load test to verify < 25ms p95
- [ ] Implement chaos testing
- [ ] Fix query tag collision risk
- [ ] Add rate limiting

### Short-term (Weeks 2-3)
- [ ] Claude Desktop integration
- [ ] E2E testing suite
- [ ] Security audit
- [ ] Production monitoring

### Long-term (Weeks 4+)
- [ ] Multi-region support
- [ ] Advanced analytics views
- [ ] Cost optimization
- [ ] GDPR compliance

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Make changes (victory audit must pass!)
4. Submit PR with audit results

## 📝 License

MIT

## ⚠️ Production Checklist

Before deploying to production, ensure:

- [ ] Victory audit score > 80%
- [ ] Load test passed (< 25ms p95 with 1000 users)
- [ ] Chaos testing Level 3 survived
- [ ] Security audit completed
- [ ] Monitoring configured
- [ ] Rollback procedures tested
- [ ] Documentation complete
- [ ] Team trained on operations

**Current Status: NOT READY FOR PRODUCTION**

---

*"Trust, but verify"* - All claims must be validated by victory-auditor