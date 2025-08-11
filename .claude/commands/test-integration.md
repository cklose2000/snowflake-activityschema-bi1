# Full Stack Integration Test Command

Run comprehensive integration tests across all BI system components to validate end-to-end functionality and performance SLOs.

## Test Execution Flow

### 1. Environment Setup
```bash
# Start test infrastructure
docker-compose -f docker-compose.test.yml up -d

# Wait for services
./scripts/wait-for-services.sh

# Initialize test database
snow sql -f bi-snowflake-ddl/test-setup.sql
```

### 2. Component Startup
```bash
# Start MCP server with test config
cd bi-mcp-server && npm run start:test &
MCP_PID=$!

# Start uploader service
cd ../bi-uploader && npm run start:test &
UPLOADER_PID=$!

# Start renderer service  
cd ../bi-renderer && npm run start:test &
RENDERER_PID=$!

# Wait for health checks
sleep 5
curl -f http://localhost:3000/health || exit 1
curl -f http://localhost:3001/health || exit 1
curl -f http://localhost:3002/health || exit 1
```

## Test Scenarios

### Scenario 1: User Conversation Flow
Simulate a complete user interaction:

1. **Session Start**
   - Log session_start event
   - Verify event in NDJSON queue
   - Confirm upload to Snowflake within 5s

2. **Context Retrieval**
   - Call get_context for customer
   - Assert response time < 25ms p95
   - Validate cache hit on second call

3. **SQL Query Submission**
   - Submit query with SafeSQL template
   - Receive ticket immediately (< 300ms)
   - Poll for completion
   - Verify QUERY_TAG='cdesk' in Snowflake

4. **Insight Logging**
   - Log insight with provenance
   - Verify async write to queue
   - Confirm deduplication on activity_id

5. **Large Result Handling**
   - Submit query returning > 1MB
   - Verify artifact creation in S3
   - Validate pre-signed URL generation
   - Assert byte cap enforcement

6. **Session End**
   - Log session_end event
   - Verify all events persisted
   - Check session summary in MV_CLAUDE_SESSIONS

### Scenario 2: Performance Under Load
```javascript
// Load test configuration
const loadTest = {
  concurrent_users: 1000,
  duration_seconds: 60,
  operations: [
    { type: 'get_context', weight: 0.6 },
    { type: 'log_event', weight: 0.3 },
    { type: 'submit_query', weight: 0.1 }
  ]
};

// Execute load test
async function runLoadTest() {
  const results = await autocannon({
    url: 'http://localhost:3000',
    connections: 1000,
    duration: 60,
    requests: [
      {
        method: 'POST',
        path: '/mcp/get_context',
        body: JSON.stringify({ customer_id: 'test' })
      }
    ]
  });
  
  // Assert SLOs
  assert(results.latency.p95 < 25, 'get_context p95 > 25ms');
  assert(results.errors === 0, 'Errors during load test');
}
```

### Scenario 3: Failure Recovery
Test system resilience:

1. **Uploader Crash**
   ```bash
   # Kill uploader mid-batch
   kill -9 $UPLOADER_PID
   sleep 2
   
   # Restart and verify recovery
   cd bi-uploader && npm run start:test &
   
   # Check no data loss
   snow sql -q "SELECT COUNT(*) FROM CLAUDE_STREAM"
   ```

2. **Queue Overflow**
   ```javascript
   // Flood queue to trigger backpressure
   for (let i = 0; i < 100000; i++) {
     await logEvent({ 
       activity: 'overflow_test',
       feature_json: { data: 'x'.repeat(10000) }
     });
   }
   
   // Verify sampling activated
   // Verify queue drain rate
   ```

3. **Network Partition**
   ```bash
   # Simulate network failure
   iptables -A OUTPUT -p tcp --dport 443 -j DROP
   
   # Verify local queue buffering
   # Restore network
   iptables -D OUTPUT -p tcp --dport 443 -j DROP
   
   # Verify queue flush
   ```

### Scenario 4: Security Validation
```javascript
// SQL injection attempts
const injectionTests = [
  "'; DROP TABLE CLAUDE_STREAM; --",
  "1' OR '1'='1",
  "${table}; DELETE FROM CONTEXT_CACHE; --"
];

for (const payload of injectionTests) {
  try {
    await submitQuery({
      template: 'GET_CONTEXT',
      params: { customer_id: payload }
    });
    throw new Error('SQL injection not blocked!');
  } catch (e) {
    assert(e.message.includes('Invalid'), 'Wrong error for injection');
  }
}

// Cross-customer access attempt
const customer1 = await getContext({ customer_id: 'customer1' });
const customer2 = await getContext({ customer_id: 'customer2' });
assert(customer1.data !== customer2.data, 'Customer isolation failed');
```

## Performance Assertions

```javascript
class PerformanceValidator {
  static async validateSLOs() {
    const metrics = await this.collectMetrics();
    
    // Critical SLOs
    assert(metrics.firstToken.p95 < 300, `First token ${metrics.firstToken.p95}ms > 300ms`);
    assert(metrics.getContext.p95 < 25, `get_context ${metrics.getContext.p95}ms > 25ms`);
    assert(metrics.ingestionLag.p95 < 5000, `Ingestion lag ${metrics.ingestionLag.p95}ms > 5s`);
    assert(metrics.cardReady.p95 < 8000, `Card ready ${metrics.cardReady.p95}ms > 8s`);
    
    // Throughput requirements
    assert(metrics.eventsPerSecond > 1000, `Throughput ${metrics.eventsPerSecond} < 1000 events/s`);
    assert(metrics.queriesPerSecond > 100, `Query rate ${metrics.queriesPerSecond} < 100 queries/s`);
    
    // Resource usage
    assert(metrics.memoryUsageMB < 500, `Memory ${metrics.memoryUsageMB}MB > 500MB`);
    assert(metrics.cpuUsagePercent < 50, `CPU ${metrics.cpuUsagePercent}% > 50%`);
    
    return metrics;
  }
  
  static async collectMetrics() {
    // Collect from various sources
    const prometheusMetrics = await fetch('http://localhost:9090/metrics');
    const snowflakeMetrics = await this.querySnowflakeMetrics();
    const systemMetrics = await this.getSystemMetrics();
    
    return this.aggregateMetrics(prometheusMetrics, snowflakeMetrics, systemMetrics);
  }
}
```

## Test Report Generation

```javascript
async function generateTestReport() {
  const report = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    results: {
      functional: await runFunctionalTests(),
      performance: await runPerformanceTests(),
      security: await runSecurityTests(),
      resilience: await runResilienceTests()
    },
    metrics: await PerformanceValidator.collectMetrics(),
    coverage: await getCoverageReport()
  };
  
  // Generate HTML report
  const html = await renderReport(report);
  fs.writeFileSync('test-report.html', html);
  
  // Generate JSON for CI
  fs.writeFileSync('test-results.json', JSON.stringify(report, null, 2));
  
  // Print summary
  console.log('\n=== Integration Test Summary ===');
  console.log(`Total Tests: ${report.results.functional.total}`);
  console.log(`Passed: ${report.results.functional.passed}`);
  console.log(`Failed: ${report.results.functional.failed}`);
  console.log(`\nPerformance SLOs:`);
  console.log(`  First Token p95: ${report.metrics.firstToken.p95}ms (target < 300ms)`);
  console.log(`  get_context p95: ${report.metrics.getContext.p95}ms (target < 25ms)`);
  console.log(`  Ingestion Lag p95: ${report.metrics.ingestionLag.p95}ms (target < 5000ms)`);
  console.log(`\nSecurity Tests: ${report.results.security.passed}/${report.results.security.total} passed`);
  
  // Exit code based on results
  const allPassed = report.results.functional.failed === 0 &&
                    report.results.performance.slosMet &&
                    report.results.security.vulnerabilities === 0;
  
  process.exit(allPassed ? 0 : 1);
}
```

## Cleanup

```bash
# Stop all services
kill $MCP_PID $UPLOADER_PID $RENDERER_PID

# Clean test data
snow sql -q "TRUNCATE TABLE CLAUDE_LOGS.ACTIVITIES.CLAUDE_STREAM"
snow sql -q "DROP DATABASE IF EXISTS CLAUDE_LOGS_TEST"

# Stop Docker containers
docker-compose -f docker-compose.test.yml down -v

# Remove test artifacts
rm -rf test-output/
rm -f test-report.html test-results.json
```

## CI/CD Integration

```yaml
# .github/workflows/integration-test.yml
name: Integration Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - name: Install dependencies
        run: npm ci
      - name: Run integration tests
        run: npm run test:integration
      - name: Upload test report
        uses: actions/upload-artifact@v2
        with:
          name: test-report
          path: test-report.html
      - name: Check SLOs
        run: |
          node -e "
          const results = require('./test-results.json');
          if (!results.results.performance.slosMet) {
            console.error('Performance SLOs not met!');
            process.exit(1);
          }"
```

## Usage

To run the full integration test suite:

```bash
# From project root
claude run test-integration

# Or directly
npm run test:integration

# With specific scenarios
npm run test:integration -- --scenario=performance

# With custom config
npm run test:integration -- --config=test-config.json
```

The test will automatically:
1. Set up test environment
2. Run all test scenarios
3. Validate SLOs are met
4. Generate comprehensive report
5. Clean up test resources
6. Exit with appropriate code for CI/CD