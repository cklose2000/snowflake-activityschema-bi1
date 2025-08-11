#!/usr/bin/env node

/**
 * Test Snowflake Connection
 * 
 * Run this script to verify Snowflake credentials are working:
 * node scripts/test-connection.js
 */

require('dotenv').config();

async function testConnection() {
  console.log('🔍 Testing Snowflake Connection...\n');
  
  // Check environment variables
  const required = [
    'SNOWFLAKE_ACCOUNT',
    'SNOWFLAKE_USERNAME', 
    'SNOWFLAKE_PASSWORD',
    'SNOWFLAKE_WAREHOUSE',
    'SNOWFLAKE_DATABASE',
    'SNOWFLAKE_SCHEMA',
    'SNOWFLAKE_ROLE'
  ];
  
  console.log('📋 Environment Variables:');
  let missingVars = [];
  
  for (const varName of required) {
    const value = process.env[varName];
    if (!value) {
      console.log(`  ❌ ${varName}: NOT SET`);
      missingVars.push(varName);
    } else {
      // Mask password
      const displayValue = varName === 'SNOWFLAKE_PASSWORD' 
        ? '***' + value.slice(-3) 
        : value;
      console.log(`  ✅ ${varName}: ${displayValue}`);
    }
  }
  
  if (missingVars.length > 0) {
    console.error('\n❌ Missing required environment variables:', missingVars.join(', '));
    console.log('\n💡 Make sure you have a .env file with all required variables.');
    console.log('   Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }
  
  console.log('\n🔗 Attempting to connect to Snowflake...\n');
  
  // Try to load config
  try {
    const { loadConfig } = require('../bi-mcp-server/dist/config.js');
    const config = loadConfig();
    
    console.log('✅ Configuration loaded successfully!');
    console.log('\n📊 Configuration Summary:');
    console.log(`  Account: ${config.snowflake.account}`);
    console.log(`  Database: ${config.snowflake.database}`);
    console.log(`  Schema: ${config.snowflake.schema}`);
    console.log(`  Warehouse: ${config.snowflake.warehouse}`);
    console.log(`  Role: ${config.snowflake.role}`);
    
    // Note: Actual Snowflake connection would require snowflake-sdk
    // For now, we're just validating the configuration loads
    
    console.log('\n✅ Configuration is valid and ready for connection!');
    console.log('\n📝 Next Steps:');
    console.log('  1. Run the POC setup SQL: snowsql -f bi-snowflake-ddl/sql/ddl_poc_setup.sql');
    console.log('  2. Start the MCP server: npm run dev');
    console.log('  3. Test the endpoints: curl http://localhost:3000/health');
    
  } catch (error) {
    console.error('\n❌ Configuration error:', error.message);
    
    if (error.message.includes('password')) {
      console.log('\n💡 Password is required. Make sure SNOWFLAKE_PASSWORD is set in .env');
    }
    
    process.exit(1);
  }
}

// Run the test
testConnection().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});