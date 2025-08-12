#!/usr/bin/env node

/**
 * Create tables in Snowflake for the BI system
 */

require('dotenv').config();
const snowflake = require('snowflake-sdk');

async function createTables() {
  console.log('🔨 Creating Snowflake tables...\n');
  
  const connection = snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USERNAME,
    password: process.env.SNOWFLAKE_PASSWORD,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA,
    role: process.env.SNOWFLAKE_ROLE,
  });

  return new Promise((resolve, reject) => {
    connection.connect(async (err, conn) => {
      if (err) {
        console.error('❌ Failed to connect:', err.message);
        reject(err);
        return;
      }
      
      console.log('✅ Connected to Snowflake\n');
      
      const statements = [
        // Create context_cache table
        `CREATE TABLE IF NOT EXISTS context_cache (
          customer STRING PRIMARY KEY,
          context_blob VARIANT NOT NULL,
          updated_at TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
        )`,
        
        // Create events table (ActivitySchema v2.0 compliant)
        `CREATE TABLE IF NOT EXISTS events (
          -- Required by ActivitySchema v2.0
          activity STRING NOT NULL,
          customer STRING NOT NULL,
          ts TIMESTAMP_NTZ NOT NULL,
          activity_repeated_at TIMESTAMP_NTZ,
          activity_occurrence NUMBER NOT NULL DEFAULT 1,
          
          -- Optional spec columns
          link STRING,
          revenue_impact FLOAT,
          
          -- Extension columns (underscore prefix)
          _activity_id STRING PRIMARY KEY DEFAULT UUID_STRING(),
          _anonymous_customer_id STRING,
          _feature_json VARIANT,
          _source_system STRING DEFAULT 'claude_desktop',
          _source_version STRING DEFAULT '2.0',
          _session_id STRING,
          _query_tag STRING,
          _created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
        ) CLUSTER BY (customer, ts)`,
        
        // Create insight_atoms table
        `CREATE TABLE IF NOT EXISTS insight_atoms (
          id STRING PRIMARY KEY DEFAULT UUID_STRING(),
          customer STRING NOT NULL,
          subject STRING NOT NULL,
          metric STRING NOT NULL,
          value VARIANT NOT NULL,
          provenance_query_hash STRING,
          ts TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
        ) CLUSTER BY (subject, metric, ts)`,
        
        // Create _ingest_ids table for deduplication
        `CREATE TABLE IF NOT EXISTS _ingest_ids (
          id STRING PRIMARY KEY,
          ingested_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
        )`,
        
        // Populate test user context
        `MERGE INTO context_cache AS target
         USING (SELECT 'test_user' as customer, PARSE_JSON('{"initialized": true, "theme": "dark", "stats": {"queries": 0}}') as context_blob) AS source
         ON target.customer = source.customer
         WHEN NOT MATCHED THEN
           INSERT (customer, context_blob, updated_at)
           VALUES (source.customer, source.context_blob, CURRENT_TIMESTAMP())
         WHEN MATCHED THEN
           UPDATE SET context_blob = source.context_blob, updated_at = CURRENT_TIMESTAMP()`,
      ];
      
      for (const sql of statements) {
        const shortSql = sql.substring(0, 50).replace(/\n/g, ' ') + '...';
        console.log(`📝 Executing: ${shortSql}`);
        
        await new Promise((resolve, reject) => {
          connection.execute({
            sqlText: sql,
            complete: (err, stmt, rows) => {
              if (err) {
                console.error(`❌ Error: ${err.message}`);
                reject(err);
              } else {
                console.log(`✅ Success\n`);
                resolve(rows);
              }
            }
          });
        }).catch(err => {
          // Continue on error
          console.error(`⚠️  Continuing after error: ${err.message}\n`);
        });
      }
      
      // Check tables
      console.log('📊 Checking tables...');
      
      await new Promise((resolve) => {
        connection.execute({
          sqlText: 'SHOW TABLES',
          complete: (err, stmt, rows) => {
            if (!err && rows) {
              console.log('\nTables in database:');
              rows.forEach(row => {
                console.log(`  - ${row.name}`);
              });
            }
            resolve();
          }
        });
      });
      
      // Check context cache
      await new Promise((resolve) => {
        connection.execute({
          sqlText: 'SELECT COUNT(*) as count FROM context_cache',
          complete: (err, stmt, rows) => {
            if (!err && rows && rows[0]) {
              console.log(`\n✅ Context cache has ${rows[0].COUNT} entries`);
            }
            resolve();
          }
        });
      });
      
      connection.destroy();
      console.log('\n🎉 Table creation complete!');
      resolve();
    });
  });
}

createTables().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});