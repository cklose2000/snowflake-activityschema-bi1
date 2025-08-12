#!/usr/bin/env node

/**
 * Simple test for auth event logging
 */

const { execSync } = require('child_process');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function testAuthLogging() {
  console.log('🧪 Testing auth event logging...');
  
  try {
    // Get initial count
    const beforeResult = execSync('snow sql -q "SELECT COUNT(*) as count FROM AUTH_EVENTS"', { encoding: 'utf-8' });
    const beforeLines = beforeResult.split('\n');
    const beforeCountLine = beforeLines.find(line => line.includes('|') && !line.includes('COUNT'));
    const beforeMatch = beforeCountLine ? beforeCountLine.match(/\d+/) : null;
    const beforeCount = beforeMatch ? parseInt(beforeMatch[0]) : 0;
    console.log(`📊 Starting with ${beforeCount} events`);
    
    // Test direct insert
    console.log('📝 Inserting test event...');
    execSync(`snow sql -q "INSERT INTO AUTH_EVENTS (event_id, account_name, event_type, error_message, source_ip, user_agent, connection_id) VALUES ('test-${Date.now()}', 'CLAUDE_DESKTOP1', 'test_connection', NULL, NULL, NULL, 'conn-123')"`);
    
    // Get new count
    const afterResult = execSync('snow sql -q "SELECT COUNT(*) as count FROM AUTH_EVENTS"', { encoding: 'utf-8' });
    const afterLines = afterResult.split('\n');
    const afterCountLine = afterLines.find(line => line.includes('|') && !line.includes('COUNT'));
    const afterMatch = afterCountLine ? afterCountLine.match(/\d+/) : null;
    const afterCount = afterMatch ? parseInt(afterMatch[0]) : 0;
    console.log(`📊 Ending with ${afterCount} events`);
    
    if (afterCount > beforeCount) {
      console.log('✅ Auth event logging is working!');
      
      // Show recent events
      console.log('\n📋 Recent auth events:');
      const recentEvents = execSync('snow sql -q "SELECT event_id, account_name, event_type FROM AUTH_EVENTS ORDER BY ts DESC LIMIT 5"', { encoding: 'utf-8' });
      console.log(recentEvents);
    } else {
      console.log('❌ Auth event logging failed - no new events');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Now test with the auth agent
async function testAuthAgentLogging() {
  console.log('\n🧪 Testing auth agent event logging...');
  
  try {
    // Import the auth agent components
    const { CredentialVault } = require('../snowflake-auth-agent/dist/credential/credential-vault.js');
    const { AuthCircuitBreaker } = require('../snowflake-auth-agent/dist/circuit-breaker/auth-circuit-breaker.js');
    const { ConnectionManager } = require('../snowflake-auth-agent/dist/connection/connection-manager.js');
    
    // Initialize components
    const vault = new CredentialVault();
    await vault.initialize();
    
    const breaker = new AuthCircuitBreaker();
    const manager = new ConnectionManager(vault, breaker);
    
    console.log('📝 Initializing connection manager...');
    await manager.initialize();
    
    // Get a connection
    console.log('📝 Getting connection...');
    const { connection, account } = await manager.getConnection();
    console.log(`✅ Got connection for ${account.username}`);
    
    // Execute a simple query
    await new Promise((resolve, reject) => {
      connection.execute({
        sqlText: 'SELECT 1 as test',
        complete: (err, stmt, rows) => {
          if (err) reject(err);
          else {
            console.log('✅ Query executed successfully');
            resolve(rows);
          }
        }
      });
    });
    
    // Release connection
    await manager.releaseConnection(connection);
    
    // Clean up
    await manager.destroy();
    console.log('✅ Auth agent test completed');
    
  } catch (error) {
    console.error('❌ Auth agent test failed:', error.message);
  }
}

// Run tests
(async () => {
  await testAuthLogging();
  await testAuthAgentLogging();
  
  // Final check
  console.log('\n📊 Final auth events check:');
  const finalResult = execSync('snow sql -q "SELECT COUNT(*) as count FROM AUTH_EVENTS"', { encoding: 'utf-8' });
  console.log(finalResult);
})();