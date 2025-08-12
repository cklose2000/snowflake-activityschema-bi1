#!/usr/bin/env node

/**
 * Snowflake Compliance Review Script
 * 
 * Automatically validates SQL changes against ActivitySchema v2.0 requirements
 * and PRD v2 strict compliance rules.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Compliance rules
const COMPLIANCE_RULES = {
  // Database/Schema names per environment
  ENV_DATABASE: process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS',
  ENV_SCHEMA: process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES',
  
  // PRD v2 requirements
  PRD_DATABASE: 'analytics',
  PRD_SCHEMA: 'activity',
  PRD_EXTENSIONS_SCHEMA: 'activity_cdesk',
  
  // Required columns in events table
  REQUIRED_COLUMNS: [
    'activity',              // STRING NOT NULL
    'customer',              // STRING NOT NULL
    'ts',                    // TIMESTAMP_NTZ NOT NULL
    'activity_repeated_at',  // TIMESTAMP_NTZ (REQUIRED)
    'activity_occurrence'    // NUMBER NOT NULL (REQUIRED)
  ],
  
  // Optional spec columns
  OPTIONAL_COLUMNS: ['link', 'revenue_impact'],
  
  // Extension columns (must have underscore prefix)
  EXTENSION_PREFIX: '_',
  
  // Activity namespace
  ACTIVITY_NAMESPACE: 'cdesk.',
  ACTIVITY_REGEX: /^cdesk\.[a-z_]+$/,
  
  // Query tag format
  QUERY_TAG_PREFIX: 'cdesk_',
  QUERY_TAG_LENGTH: 21, // cdesk_ + 16 chars
  
  // Provenance hash length
  HASH_LENGTH: 16
};

class SnowflakeComplianceReviewer {
  constructor() {
    this.violations = [];
    this.warnings = [];
    this.fixes = [];
  }

  /**
   * Main review entry point
   */
  async review() {
    console.log('🔍 Snowflake Compliance Review Starting...');
    console.log('═══════════════════════════════════════════');
    
    // Load .env file
    this.loadEnvironment();
    
    // Get changed files
    const changedFiles = this.getChangedFiles();
    
    if (changedFiles.length === 0) {
      console.log('✅ No SQL/schema files changed.');
      return 0;
    }
    
    console.log(`\n📋 Reviewing ${changedFiles.length} files...`);
    
    // Review each file
    for (const file of changedFiles) {
      await this.reviewFile(file);
    }
    
    // Check cross-file consistency
    this.checkGlobalConsistency();
    
    // Generate report
    return this.generateReport();
  }

  /**
   * Load environment variables
   */
  loadEnvironment() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath });
      
      // Update rules from environment
      COMPLIANCE_RULES.ENV_DATABASE = process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS';
      COMPLIANCE_RULES.ENV_SCHEMA = process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES';
    }
  }

  /**
   * Get list of changed SQL/schema files
   */
  getChangedFiles() {
    try {
      // Get staged files
      const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      
      // Filter for SQL/schema related files
      return staged.filter(file => {
        return file.endsWith('.sql') ||
               file.endsWith('.ddl') ||
               file.includes('template') ||
               file.includes('schema') ||
               (file.endsWith('.ts') && this.containsSQLContent(file)) ||
               (file.endsWith('.js') && this.containsSQLContent(file));
      });
    } catch (error) {
      console.error('Error getting changed files:', error.message);
      return [];
    }
  }

  /**
   * Check if file contains SQL content
   */
  containsSQLContent(filePath) {
    if (!fs.existsSync(filePath)) return false;
    
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes('CREATE TABLE') ||
           content.includes('ALTER TABLE') ||
           content.includes('SAFE_TEMPLATES') ||
           content.includes('sql:') ||
           content.includes('sqlText');
  }

  /**
   * Review a single file
   */
  async reviewFile(filePath) {
    console.log(`\n📄 Reviewing: ${filePath}`);
    
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️  File deleted or not found`);
      return;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    // Check database/schema references
    this.checkDatabaseReferences(content, filePath);
    
    // Check for CREATE TABLE statements
    this.checkTableStructure(content, filePath);
    
    // Check activity names
    this.checkActivityNames(content, filePath);
    
    // Check SafeSQL templates
    this.checkSafeSQLTemplates(content, filePath);
    
    // Check query tags
    this.checkQueryTags(content, filePath);
    
    // Check provenance hash
    this.checkProvenanceHash(content, filePath);
  }

  /**
   * Check database/schema references
   */
  checkDatabaseReferences(content, filePath) {
    // Check for analytics.activity references
    const prdPattern = /analytics\.activity[._]/gi;
    const prdMatches = content.match(prdPattern) || [];
    
    // Check for CLAUDE_LOGS references
    const envPattern = /CLAUDE_LOGS\.ACTIVITIES/gi;
    const envMatches = content.match(envPattern) || [];
    
    // Check for mismatches
    if (prdMatches.length > 0 && envMatches.length > 0) {
      this.violations.push({
        file: filePath,
        type: 'DATABASE_MISMATCH',
        message: 'File contains both analytics.activity and CLAUDE_LOGS.ACTIVITIES references',
        fix: 'Use consistent database/schema names throughout'
      });
    }
    
    // Check if templates match environment
    if (filePath.includes('template') || filePath.includes('safe-templates')) {
      if (prdMatches.length > 0 && COMPLIANCE_RULES.ENV_DATABASE !== 'analytics') {
        this.violations.push({
          file: filePath,
          type: 'TEMPLATE_ENV_MISMATCH',
          message: `Templates reference analytics.activity but ENV uses ${COMPLIANCE_RULES.ENV_DATABASE}.${COMPLIANCE_RULES.ENV_SCHEMA}`,
          fix: `Update templates to use ${COMPLIANCE_RULES.ENV_DATABASE}.${COMPLIANCE_RULES.ENV_SCHEMA}`
        });
      }
    }
  }

  /**
   * Check CREATE TABLE structure
   */
  checkTableStructure(content, filePath) {
    const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\(([\s\S]*?)\)/gi;
    let match;
    
    while ((match = createTableRegex.exec(content)) !== null) {
      const tableName = match[1];
      const tableDefinition = match[2];
      
      // Check if it's the events table
      if (tableName.toLowerCase().includes('events')) {
        // Check for required columns
        for (const requiredCol of COMPLIANCE_RULES.REQUIRED_COLUMNS) {
          const colRegex = new RegExp(`\\b${requiredCol}\\b`, 'i');
          if (!colRegex.test(tableDefinition)) {
            this.violations.push({
              file: filePath,
              type: 'MISSING_REQUIRED_COLUMN',
              message: `Events table missing required column: ${requiredCol}`,
              fix: `Add column: ${requiredCol} ${this.getColumnType(requiredCol)}`
            });
          }
        }
        
        // Check for non-prefixed extension columns
        const columnRegex = /(\w+)\s+(STRING|NUMBER|TIMESTAMP|VARIANT|FLOAT|INT|BOOLEAN)/gi;
        let colMatch;
        
        while ((colMatch = columnRegex.exec(tableDefinition)) !== null) {
          const colName = colMatch[1];
          
          // Skip required and optional columns
          if (COMPLIANCE_RULES.REQUIRED_COLUMNS.includes(colName) ||
              COMPLIANCE_RULES.OPTIONAL_COLUMNS.includes(colName)) {
            continue;
          }
          
          // Check if extension column has underscore prefix
          if (!colName.startsWith(COMPLIANCE_RULES.EXTENSION_PREFIX)) {
            this.violations.push({
              file: filePath,
              type: 'INVALID_EXTENSION_COLUMN',
              message: `Extension column '${colName}' must have underscore prefix`,
              fix: `Rename to: _${colName}`
            });
          }
        }
      }
    }
  }

  /**
   * Check activity names
   */
  checkActivityNames(content, filePath) {
    // Look for activity assignments
    const activityPatterns = [
      /activity:\s*['"`]([^'"`]+)['"`]/g,
      /activity\s*=\s*['"`]([^'"`]+)['"`]/g,
      /"activity":\s*"([^"]+)"/g
    ];
    
    for (const pattern of activityPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const activity = match[1];
        
        // Check if it follows cdesk.* format
        if (!COMPLIANCE_RULES.ACTIVITY_REGEX.test(activity)) {
          this.violations.push({
            file: filePath,
            type: 'INVALID_ACTIVITY_NAME',
            message: `Activity '${activity}' doesn't follow cdesk.* namespace`,
            fix: `Change to: cdesk.${activity.replace(/[^a-z_]/g, '_')}`
          });
        }
      }
    }
  }

  /**
   * Check SafeSQL templates
   */
  checkSafeSQLTemplates(content, filePath) {
    // Check for dynamic SQL patterns
    const dynamicSQLPatterns = [
      /\$\{[^}]+\}/g,           // Template literals in SQL
      /['"`]\s*\+\s*\w+\s*\+\s*['"`]/g,  // String concatenation
      /`[^`]*\$\{[^}]+\}[^`]*`/g  // Template strings with variables
    ];
    
    for (const pattern of dynamicSQLPatterns) {
      if (pattern.test(content)) {
        // Check if it's in SQL context
        const sqlContext = /sql[:\s]*['"`]|sqlText[:\s]*['"`]|query[:\s]*['"`]/i;
        if (sqlContext.test(content)) {
          this.violations.push({
            file: filePath,
            type: 'DYNAMIC_SQL_DETECTED',
            message: 'Dynamic SQL generation detected (potential injection risk)',
            fix: 'Use parameterized SafeSQL templates only'
          });
        }
      }
    }
    
    // Check for SAFE_TEMPLATES registration
    if (content.includes('SAFE_TEMPLATES.set')) {
      // Verify validator function exists
      const templateRegex = /SAFE_TEMPLATES\.set\(['"`](\w+)['"`],\s*{([^}]+)}/g;
      let match;
      
      while ((match = templateRegex.exec(content)) !== null) {
        const templateName = match[1];
        const templateBody = match[2];
        
        if (!templateBody.includes('validator')) {
          this.violations.push({
            file: filePath,
            type: 'MISSING_VALIDATOR',
            message: `Template '${templateName}' missing validator function`,
            fix: 'Add validator function to validate parameters'
          });
        }
      }
    }
  }

  /**
   * Check query tags
   */
  checkQueryTags(content, filePath) {
    // Look for query tag patterns
    const queryTagPatterns = [
      /QUERY_TAG\s*=\s*['"`]([^'"`]+)['"`]/gi,
      /queryTag:\s*['"`]([^'"`]+)['"`]/g,
      /query_tag[:\s]*['"`]([^'"`]+)['"`]/g
    ];
    
    for (const pattern of queryTagPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const tag = match[1];
        
        // Check format
        if (!tag.startsWith(COMPLIANCE_RULES.QUERY_TAG_PREFIX)) {
          this.violations.push({
            file: filePath,
            type: 'INVALID_QUERY_TAG',
            message: `Query tag '${tag}' must start with '${COMPLIANCE_RULES.QUERY_TAG_PREFIX}'`,
            fix: `Use format: ${COMPLIANCE_RULES.QUERY_TAG_PREFIX}[16-char-uuid]`
          });
        }
        
        // Check length (should be 21: cdesk_ + 16 chars)
        if (tag.length !== COMPLIANCE_RULES.QUERY_TAG_LENGTH && 
            !tag.includes('$') && !tag.includes('{')) { // Skip variables
          this.warnings.push({
            file: filePath,
            type: 'QUERY_TAG_LENGTH',
            message: `Query tag '${tag}' should be ${COMPLIANCE_RULES.QUERY_TAG_LENGTH} characters`,
            fix: `Ensure 16 character UUID after prefix`
          });
        }
      }
    }
  }

  /**
   * Check provenance hash generation
   */
  checkProvenanceHash(content, filePath) {
    // Look for hash generation
    const hashPatterns = [
      /substring\(0,\s*(\d+)\)/g,
      /substr\(0,\s*(\d+)\)/g,
      /slice\(0,\s*(\d+)\)/g
    ];
    
    // Only check in files that deal with query hashing
    if (content.includes('generateQueryHash') || content.includes('provenance')) {
      for (const pattern of hashPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const length = parseInt(match[1]);
          
          if (length !== COMPLIANCE_RULES.HASH_LENGTH) {
            this.violations.push({
              file: filePath,
              type: 'INVALID_HASH_LENGTH',
              message: `Provenance hash using ${length} characters instead of ${COMPLIANCE_RULES.HASH_LENGTH}`,
              fix: `Change to: substring(0, ${COMPLIANCE_RULES.HASH_LENGTH})`
            });
          }
        }
      }
    }
  }

  /**
   * Check global consistency across files
   */
  checkGlobalConsistency() {
    // This could check for consistency across multiple files
    // For now, we'll just note the current configuration
    console.log('\n🌍 Global Configuration:');
    console.log(`  ENV Database: ${COMPLIANCE_RULES.ENV_DATABASE}`);
    console.log(`  ENV Schema: ${COMPLIANCE_RULES.ENV_SCHEMA}`);
    console.log(`  PRD Database: ${COMPLIANCE_RULES.PRD_DATABASE}`);
    console.log(`  PRD Schema: ${COMPLIANCE_RULES.PRD_SCHEMA}`);
  }

  /**
   * Get column type for required columns
   */
  getColumnType(columnName) {
    const types = {
      'activity': 'STRING NOT NULL',
      'customer': 'STRING NOT NULL',
      'ts': 'TIMESTAMP_NTZ NOT NULL',
      'activity_repeated_at': 'TIMESTAMP_NTZ',
      'activity_occurrence': 'NUMBER NOT NULL'
    };
    return types[columnName] || 'STRING';
  }

  /**
   * Generate compliance report
   */
  generateReport() {
    console.log('\n═══════════════════════════════════════════');
    console.log('📊 COMPLIANCE REVIEW RESULTS');
    console.log('═══════════════════════════════════════════');
    
    // Show violations
    if (this.violations.length > 0) {
      console.log('\n❌ VIOLATIONS FOUND:', this.violations.length);
      console.log('─────────────────────────────────────');
      
      for (const violation of this.violations) {
        console.log(`\n📍 ${violation.file}`);
        console.log(`   Type: ${violation.type}`);
        console.log(`   Issue: ${violation.message}`);
        console.log(`   Fix: ${violation.fix}`);
      }
    }
    
    // Show warnings
    if (this.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:', this.warnings.length);
      console.log('─────────────────────────────────────');
      
      for (const warning of this.warnings) {
        console.log(`\n📍 ${warning.file}`);
        console.log(`   Type: ${warning.type}`);
        console.log(`   Issue: ${warning.message}`);
        console.log(`   Suggestion: ${warning.fix}`);
      }
    }
    
    // Final verdict
    console.log('\n═══════════════════════════════════════════');
    
    if (this.violations.length > 0) {
      console.log('❌ REVIEW FAILED - Fix violations before committing');
      console.log('\nRun the Snowflake Expert agent for detailed guidance:');
      console.log('  Task: snowflake-expert');
      return 1;
    } else if (this.warnings.length > 0) {
      console.log('⚠️  REVIEW PASSED WITH WARNINGS');
      console.log('Consider addressing warnings for better compliance');
      return 0;
    } else {
      console.log('✅ REVIEW PASSED - All compliance checks satisfied');
      return 0;
    }
  }
}

// Run the review
async function main() {
  const reviewer = new SnowflakeComplianceReviewer();
  const exitCode = await reviewer.review();
  process.exit(exitCode);
}

// Execute if run directly
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Review failed with error:', error);
    process.exit(1);
  });
}

module.exports = { SnowflakeComplianceReviewer };