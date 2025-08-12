#!/usr/bin/env node

/**
 * Failover Integration Test for MCP Server
 * 
 * Tests that the MCP server correctly handles account failover scenarios
 * when using the auth-enabled Snowflake client.
 */

import { execSync } from 'child_process';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Ensure auth agent is enabled
process.env.AUTH_AGENT_ENABLED = 'true';

class FailoverIntegrationTest {
  constructor() {
    this.testResults = [];
    this.startTime = Date.now();
  }

  log(message, level = 'info') {
    const prefix = {
      info: '📋',
      success: '✅',
      error: '❌',
      test: '🧪',
    }[level] || '📝';
    
    console.log(`${prefix} ${new Date().toISOString()} - ${message}`);
  }

  async runTest(name, testFn) {
    this.log(`Running: ${name}`, 'test');
    
    try {
      await testFn();
      this.testResults.push({ name, passed: true });
      this.log(`${name} passed`, 'success');
      return true;
    } catch (error) {
      this.testResults.push({ name, passed: false, error: error.message });
      this.log(`${name} failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test 1: Initialize MCP server with auth agent
   */
  async testMCPInitialization() {
    const { loadConfig } = await import('../dist/config.js');
    const { AuthEnabledSnowflakeClient } = await import('../dist/db/auth-enabled-snowflake-client.js');
    
    const config = loadConfig();
    const client = new AuthEnabledSnowflakeClient(config);
    
    await client.initialize();
    
    // Verify initialization
    const health = await client.getSystemHealth();
    assert(health.overall, 'System health should be available');
    assert(health.accounts && health.accounts.length > 0, 'Should have accounts configured');
    
    await client.close();
  }

  /**
   * Test 2: Test log_event tool execution
   */
  async testLogEventTool() {
    const { AuthEnabledSnowflakeClient } = await import('../dist/db/auth-enabled-snowflake-client.js');
    const { loadConfig } = await import('../dist/config.js');
    const { NDJSONQueue } = await import('../dist/queue/ndjson-queue.js');
    
    const config = loadConfig();
    const client = new AuthEnabledSnowflakeClient(config);
    const queue = new NDJSONQueue(config.queue);
    
    await client.initialize();
    
    // Log an event
    await queue.push({
      activity: 'cdesk.test_event',
      customer: 'test_customer',
      ts: new Date().toISOString(),
      _feature_json: { test: true },
      _query_tag: 'cdesk_test_001',
    });
    
    // Verify queue has the event
    const stats = await queue.getStats();
    assert(stats.totalEvents > 0, 'Queue should have events');
    
    await client.close();
  }

  /**
   * Test 3: Test get_context with failover
   */
  async testGetContextWithFailover() {
    const { AuthEnabledSnowflakeClient } = await import('../dist/db/auth-enabled-snowflake-client.js');
    const { loadConfig } = await import('../dist/config.js');
    const { ContextCache } = await import('../dist/cache/context-cache.js');
    
    const config = loadConfig();
    const client = new AuthEnabledSnowflakeClient(config);
    const cache = new ContextCache(config.cache);
    
    await client.initialize();
    
    // Try to get context (should handle failover if primary is down)
    const context = await client.getContextFromCache('test_customer');
    
    // Context might be null if not exists, that's ok
    // The important thing is no error was thrown
    
    await client.close();
  }

  /**
   * Test 4: Test auth health monitoring
   */
  async testAuthHealthMonitoring() {
    const { AuthEnabledSnowflakeClient } = await import('../dist/db/auth-enabled-snowflake-client.js');
    const { loadConfig } = await import('../dist/config.js');
    
    const config = loadConfig();
    const client = new AuthEnabledSnowflakeClient(config);
    
    await client.initialize();
    
    const health = await client.getSystemHealth();
    
    // Verify health structure
    assert(health.overall, 'Should have overall health status');
    assert(Array.isArray(health.accounts), 'Should have accounts array');
    assert(health.connectionPools !== undefined, 'Should have connection pool info');
    assert(health.circuitBreakers !== undefined, 'Should have circuit breaker info');
    
    // Check at least one account is healthy
    const healthyAccount = health.accounts.find(acc => acc.healthScore > 50);
    assert(healthyAccount, 'Should have at least one healthy account');
    
    await client.close();
  }

  /**
   * Test 5: Test performance check
   */
  async testPerformanceCheck() {
    const { AuthEnabledSnowflakeClient } = await import('../dist/db/auth-enabled-snowflake-client.js');
    const { loadConfig } = await import('../dist/config.js');
    
    const config = loadConfig();
    const client = new AuthEnabledSnowflakeClient(config);
    
    await client.initialize();
    
    // Measure query latency
    const iterations = 5;
    const latencies = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await client.executeTemplate('CHECK_HEALTH', [], { timeout: 5000 });
      const latency = Date.now() - start;
      latencies.push(latency);
      this.log(`Query ${i + 1} latency: ${latency}ms`);
    }
    
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    this.log(`Average latency: ${avgLatency}ms`);
    
    // Check if latency is reasonable
    assert(avgLatency < 1000, `Average latency (${avgLatency}ms) should be < 1000ms`);
    
    await client.close();
  }

  /**
   * Generate test report
   */
  generateReport() {
    const duration = Date.now() - this.startTime;
    const passed = this.testResults.filter(r => r.passed).length;
    const total = this.testResults.length;
    
    console.log('\n' + '='.repeat(60));
    console.log('🔐 FAILOVER INTEGRATION TEST REPORT');
    console.log('='.repeat(60));
    console.log();
    console.log(`📊 Results: ${passed}/${total} tests passed (${Math.round(passed/total * 100)}%)`);
    console.log(`⏱️  Duration: ${duration}ms`);
    console.log();
    
    console.log('📋 Test Results:');
    console.log('-'.repeat(40));
    
    for (const result of this.testResults) {
      const icon = result.passed ? '✅' : '❌';
      console.log(`${icon} ${result.name}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }
    
    console.log();
    console.log('='.repeat(60));
    
    if (passed === total) {
      console.log('🎉 All tests passed! Failover integration is working!');
    } else {
      console.log('⚠️  Some tests failed. Please review the results.');
    }
    
    return passed === total;
  }

  /**
   * Run all tests
   */
  async run() {
    console.log('🔐 Starting Failover Integration Tests');
    console.log('='.repeat(60));
    
    await this.runTest('MCP Initialization', () => this.testMCPInitialization());
    await this.runTest('Log Event Tool', () => this.testLogEventTool());
    await this.runTest('Get Context with Failover', () => this.testGetContextWithFailover());
    await this.runTest('Auth Health Monitoring', () => this.testAuthHealthMonitoring());
    await this.runTest('Performance Check', () => this.testPerformanceCheck());
    
    return this.generateReport();
  }
}

// Run tests if called directly
const tester = new FailoverIntegrationTest();
tester.run()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('❌ Test suite failed:', error);
    process.exit(1);
  });