#!/usr/bin/env node

/**
 * Failover Simulation Test
 * 
 * This test simulates a primary account lockout and validates that the
 * authentication agent seamlessly fails over to backup accounts.
 */

const { execSync } = require('child_process');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Set auth agent enabled
process.env.AUTH_AGENT_ENABLED = 'true';

class FailoverSimulationTest {
  constructor() {
    this.results = {
      primaryConnectionTest: { passed: false, details: [] },
      simulatedLockout: { passed: false, details: [] },
      failoverTest: { passed: false, details: [] },
      circuitBreakerTest: { passed: false, details: [] },
      recoveryTest: { passed: false, details: [] },
      authEventLogging: { passed: false, details: [] },
    };
    
    this.startTime = Date.now();
    this.authEventsBeforeTest = 0;
    this.authEventsAfterTest = 0;
  }

  log(message, level = 'info') {
    const levels = {
      info: '📋',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      test: '🧪',
    };
    console.log(`${levels[level]} ${new Date().toISOString()} - ${message}`);
  }

  /**
   * Initialize the test environment
   */
  async initialize() {
    this.log('Initializing failover simulation test', 'test');
    
    try {
      // Check auth events table baseline
      const countResult = execSync('snow sql -q "SELECT COUNT(*) as count FROM AUTH_EVENTS"', { encoding: 'utf-8' });
      // Parse the table output to extract count
      const lines = countResult.split('\n');
      const countLine = lines.find(line => line.includes('|') && !line.includes('COUNT'));
      const match = countLine ? countLine.match(/\d+/) : null;
      this.authEventsBeforeTest = match ? parseInt(match[0]) : 0;
      this.log(`Starting with ${this.authEventsBeforeTest} auth events in table`, 'info');
      
      // Import the auth-enabled client
      const configPath = path.join(__dirname, '../bi-mcp-server/dist/config.js');
      const clientPath = path.join(__dirname, '../bi-mcp-server/dist/db/auth-enabled-snowflake-client.js');
      
      const { loadConfig } = require(configPath);
      const { AuthEnabledSnowflakeClient } = require(clientPath);
      
      this.config = loadConfig();
      this.AuthEnabledSnowflakeClient = AuthEnabledSnowflakeClient;
      
      this.log('Test environment initialized', 'success');
      return true;
      
    } catch (error) {
      this.log(`Initialization failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test 1: Verify primary account works
   */
  async testPrimaryConnection() {
    this.log('Testing primary account connection (CLAUDE_DESKTOP1)', 'test');
    
    try {
      const client = new this.AuthEnabledSnowflakeClient(this.config);
      await client.initialize();
      
      // Execute a simple query
      const result = await client.executeTemplate(
        'CHECK_HEALTH',
        [],
        { timeout: 5000 }
      );
      
      if (result.rows.length > 0) {
        this.results.primaryConnectionTest.passed = true;
        this.results.primaryConnectionTest.details.push('✓ Primary account connected successfully');
        this.results.primaryConnectionTest.details.push(`✓ Query returned ${result.rowCount} rows`);
        this.log('Primary connection test passed', 'success');
      }
      
      await client.close();
      return true;
      
    } catch (error) {
      this.results.primaryConnectionTest.details.push(`✗ Error: ${error.message}`);
      this.log(`Primary connection test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test 2: Simulate account lockout
   */
  async simulateLockout() {
    this.log('Simulating CLAUDE_DESKTOP1 lockout', 'test');
    
    try {
      // We'll simulate lockout by forcing failures in the circuit breaker
      const client = new this.AuthEnabledSnowflakeClient(this.config);
      await client.initialize();
      
      // Get the credential vault and circuit breaker
      const vaultPath = path.join(__dirname, '../snowflake-auth-agent/dist/credential/credential-vault.js');
      const circuitPath = path.join(__dirname, '../snowflake-auth-agent/dist/circuit-breaker/auth-circuit-breaker.js');
      
      const { CredentialVault } = require(vaultPath);
      const { AuthCircuitBreaker } = require(circuitPath);
      
      const vault = new CredentialVault();
      const breaker = new AuthCircuitBreaker();
      
      // Force 3 failures on CLAUDE_DESKTOP1 to open circuit
      await breaker.recordFailure('CLAUDE_DESKTOP1', 'Simulated authentication failure');
      await breaker.recordFailure('CLAUDE_DESKTOP1', 'Simulated authentication failure');
      await breaker.recordFailure('CLAUDE_DESKTOP1', 'Simulated authentication failure');
      
      const metrics = breaker.getAccountMetrics('CLAUDE_DESKTOP1');
      
      if (metrics.state === 'OPEN') {
        this.results.simulatedLockout.passed = true;
        this.results.simulatedLockout.details.push('✓ Circuit breaker opened for CLAUDE_DESKTOP1');
        this.results.simulatedLockout.details.push(`✓ Failure count: ${metrics.consecutiveFailures}`);
        this.log('Lockout simulation successful', 'success');
      } else {
        this.results.simulatedLockout.details.push(`✗ Circuit state: ${metrics.state} (expected OPEN)`);
      }
      
      await client.close();
      return true;
      
    } catch (error) {
      this.results.simulatedLockout.details.push(`✗ Error: ${error.message}`);
      this.log(`Lockout simulation failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test 3: Verify failover to backup account
   */
  async testFailover() {
    this.log('Testing failover to CLAUDE_DESKTOP2', 'test');
    
    try {
      const client = new this.AuthEnabledSnowflakeClient(this.config);
      await client.initialize();
      
      // Try to execute query - should failover to CLAUDE_DESKTOP2
      const result = await client.executeTemplate(
        'CHECK_HEALTH',
        [],
        { timeout: 5000, preferredAccount: 'CLAUDE_DESKTOP1' } // Request primary but it's locked
      );
      
      if (result.rows.length > 0) {
        // Check which account was actually used
        const authEvents = execSync(
          'snow sql -q "SELECT account_name, event_type FROM AUTH_EVENTS WHERE event_type = \'failover_success\' ORDER BY ts DESC LIMIT 1"',
          { encoding: 'utf-8' }
        );
        
        // Parse table output to check for CLAUDE_DESKTOP2
        if (authEvents.includes('CLAUDE_DESKTOP2') && authEvents.includes('failover_success')) {
          this.results.failoverTest.passed = true;
          this.results.failoverTest.details.push('✓ Successfully failed over to CLAUDE_DESKTOP2');
          this.results.failoverTest.details.push('✓ Query executed on backup account');
          this.log('Failover test passed', 'success');
        } else {
          this.results.failoverTest.details.push('✗ Failover event not found in AUTH_EVENTS');
          this.log(`Auth events output: ${authEvents}`, 'warning');
        }
      }
      
      await client.close();
      return true;
      
    } catch (error) {
      this.results.failoverTest.details.push(`✗ Error: ${error.message}`);
      this.log(`Failover test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test 4: Verify circuit breaker behavior
   */
  async testCircuitBreaker() {
    this.log('Testing circuit breaker recovery', 'test');
    
    try {
      // Wait for half-open state (simulated timeout)
      this.log('Waiting 5 seconds for circuit breaker recovery window...', 'info');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const circuitPath = path.join(__dirname, '../snowflake-auth-agent/dist/circuit-breaker/auth-circuit-breaker.js');
      const { AuthCircuitBreaker } = require(circuitPath);
      const breaker = new AuthCircuitBreaker();
      
      // Check if circuit is in HALF_OPEN state
      const metrics = breaker.getAccountMetrics('CLAUDE_DESKTOP1');
      
      this.results.circuitBreakerTest.details.push(`Circuit state: ${metrics.state}`);
      this.results.circuitBreakerTest.details.push(`Consecutive failures: ${metrics.consecutiveFailures}`);
      
      if (metrics.state === 'OPEN' || metrics.state === 'HALF_OPEN') {
        this.results.circuitBreakerTest.passed = true;
        this.results.circuitBreakerTest.details.push('✓ Circuit breaker protecting failed account');
        this.log('Circuit breaker test passed', 'success');
      }
      
      return true;
      
    } catch (error) {
      this.results.circuitBreakerTest.details.push(`✗ Error: ${error.message}`);
      this.log(`Circuit breaker test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test 5: Verify auth event logging
   */
  async testAuthEventLogging() {
    this.log('Verifying auth event logging', 'test');
    
    try {
      // Get current auth events count
      const countResult = execSync('snow sql -q "SELECT COUNT(*) as count FROM AUTH_EVENTS"', { encoding: 'utf-8' });
      // Parse the table output to extract count
      const lines = countResult.split('\n');
      const countLine = lines.find(line => line.includes('|') && !line.includes('COUNT'));
      const match = countLine ? countLine.match(/\d+/) : null;
      this.authEventsAfterTest = match ? parseInt(match[0]) : 0;
      
      const newEvents = this.authEventsAfterTest - this.authEventsBeforeTest;
      
      if (newEvents > 0) {
        // Get event types that were logged
        const eventsResult = execSync(
          `snow sql -q "SELECT event_type, COUNT(*) as count FROM AUTH_EVENTS WHERE ts >= DATEADD(minute, -10, CURRENT_TIMESTAMP()) GROUP BY event_type"`,
          { encoding: 'utf-8' }
        );
        
        // Parse table output to extract event types and counts
        const eventLines = eventsResult.split('\n').filter(line => 
          line.includes('|') && 
          !line.includes('EVENT_TYPE') && 
          !line.includes('----')
        );
        const eventTypes = [];
        for (const line of eventLines) {
          const parts = line.split('|').map(p => p.trim());
          if (parts.length >= 2 && parts[0]) {
            eventTypes.push({
              EVENT_TYPE: parts[0],
              COUNT: parseInt(parts[1]) || 0
            });
          }
        }
        
        this.results.authEventLogging.passed = true;
        this.results.authEventLogging.details.push(`✓ ${newEvents} new auth events logged`);
        
        for (const event of eventTypes) {
          this.results.authEventLogging.details.push(`  - ${event.EVENT_TYPE}: ${event.COUNT} events`);
        }
        
        this.log('Auth event logging verified', 'success');
      } else {
        this.results.authEventLogging.details.push('✗ No auth events were logged');
      }
      
      return true;
      
    } catch (error) {
      this.results.authEventLogging.details.push(`✗ Error: ${error.message}`);
      this.log(`Auth event logging test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Generate test report
   */
  generateReport() {
    const duration = Date.now() - this.startTime;
    const totalTests = Object.keys(this.results).length;
    const passedTests = Object.values(this.results).filter(r => r.passed).length;
    const successRate = Math.round((passedTests / totalTests) * 100);
    
    console.log('\n' + '='.repeat(80));
    console.log('🔐 FAILOVER SIMULATION TEST REPORT');
    console.log('='.repeat(80));
    console.log();
    
    console.log(`📊 OVERALL RESULTS:`);
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Tests Passed: ${passedTests}/${totalTests} (${successRate}%)`);
    console.log(`   Auth Events Logged: ${this.authEventsAfterTest - this.authEventsBeforeTest}`);
    console.log();
    
    console.log('📋 DETAILED RESULTS:');
    console.log('-'.repeat(50));
    
    for (const [testName, result] of Object.entries(this.results)) {
      const status = result.passed ? '✅' : '❌';
      const name = testName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
      console.log(`${status} ${name}`);
      
      for (const detail of result.details) {
        console.log(`   ${detail}`);
      }
      console.log();
    }
    
    // Anti-lockout validation
    console.log('🛡️  ANTI-LOCKOUT VALIDATION:');
    console.log('-'.repeat(50));
    
    const validations = [
      { 
        name: 'Primary account connection works', 
        check: this.results.primaryConnectionTest.passed 
      },
      { 
        name: 'Circuit breaker opens on failures', 
        check: this.results.simulatedLockout.passed 
      },
      { 
        name: 'Automatic failover to backup account', 
        check: this.results.failoverTest.passed 
      },
      { 
        name: 'Circuit breaker protects failed account', 
        check: this.results.circuitBreakerTest.passed 
      },
      { 
        name: 'Auth events logged for audit trail', 
        check: this.results.authEventLogging.passed 
      },
    ];
    
    for (const validation of validations) {
      const status = validation.check ? '✅' : '❌';
      console.log(`${status} ${validation.name}`);
    }
    
    console.log();
    console.log('='.repeat(80));
    
    if (successRate === 100) {
      console.log('🎉 ALL TESTS PASSED! Anti-lockout protection is working!');
    } else if (successRate >= 80) {
      console.log('⚠️  Most tests passed but some issues need attention');
    } else {
      console.log('❌ Failover mechanism needs significant work');
    }
    
    return {
      passed: successRate === 100,
      successRate,
      duration,
    };
  }

  /**
   * Run all tests
   */
  async run() {
    this.log('Starting Failover Simulation Test Suite', 'info');
    console.log('='.repeat(80));
    
    // Initialize
    const initialized = await this.initialize();
    if (!initialized) {
      this.log('Failed to initialize test environment', 'error');
      return this.generateReport();
    }
    
    // Run test sequence
    const tests = [
      () => this.testPrimaryConnection(),
      () => this.simulateLockout(),
      () => this.testFailover(),
      () => this.testCircuitBreaker(),
      () => this.testAuthEventLogging(),
    ];
    
    for (const test of tests) {
      try {
        await test();
      } catch (error) {
        this.log(`Test error: ${error.message}`, 'error');
      }
    }
    
    return this.generateReport();
  }
}

// Run the test if called directly
if (require.main === module) {
  const tester = new FailoverSimulationTest();
  tester.run()
    .then((result) => {
      process.exit(result.passed ? 0 : 1);
    })
    .catch((error) => {
      console.error('❌ Test suite failed:', error);
      process.exit(1);
    });
}

module.exports = { FailoverSimulationTest };