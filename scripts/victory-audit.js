#!/usr/bin/env node

/**
 * Victory Auditor Script
 * 
 * Automatically challenges any victory claims made during development.
 * Implements the victory-auditor agent as a command-line tool.
 */

require('dotenv').config();

class VictoryAuditor {
    constructor() {
        this.claims = [];
        this.results = {
            verified: 0,
            unsubstantiated: 0,
            failed: 0
        };
    }

    log(message, type = 'info') {
        const colors = {
            info: '\x1b[36m',    // cyan
            success: '\x1b[32m', // green
            warning: '\x1b[33m', // yellow
            error: '\x1b[31m',   // red
            audit: '\x1b[35m',   // magenta
            reset: '\x1b[0m'
        };
        
        const timestamp = new Date().toISOString();
        console.log(`${colors[type]}[${timestamp}] ${message}${colors.reset}`);
    }

    addClaim(claim, evidence = null) {
        this.claims.push({ claim, evidence, status: 'pending' });
    }

    async auditClaim(claim, testFunction) {
        this.log(`🔍 AUDITING CLAIM: "${claim}"`, 'audit');
        
        try {
            const result = await testFunction();
            
            if (result.verified) {
                this.log(`✅ VERIFIED: ${claim}`, 'success');
                this.results.verified++;
                return { status: 'verified', evidence: result.evidence };
            } else if (result.failed) {
                this.log(`❌ FAILED: ${claim} - ${result.reason}`, 'error');
                this.results.failed++;
                return { status: 'failed', reason: result.reason };
            } else {
                this.log(`⚠️ UNSUBSTANTIATED: ${claim} - ${result.reason}`, 'warning');
                this.results.unsubstantiated++;
                return { status: 'unsubstantiated', reason: result.reason };
            }
        } catch (error) {
            this.log(`💥 ERROR AUDITING: ${claim} - ${error.message}`, 'error');
            this.results.failed++;
            return { status: 'failed', reason: error.message };
        }
    }

    async auditPerformanceClaim() {
        return this.auditClaim(
            "0.525ms p95 latency for get_context",
            async () => {
                // Check if MCP server is running
                const http = require('http');
                const { performance } = require('perf_hooks');
                
                const makeRequest = () => new Promise((resolve, reject) => {
                    const req = http.get('http://localhost:3000/health', { timeout: 1000 }, (res) => {
                        res.on('data', () => {});
                        res.on('end', () => resolve());
                    });
                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Timeout'));
                    });
                });
                
                try {
                    // Test if server is running
                    await makeRequest();
                } catch (error) {
                    return {
                        failed: true,
                        reason: "MCP server not running - cannot verify latency claims"
                    };
                }
                
                // Run basic performance test
                const times = [];
                const iterations = 100;
                
                this.log(`🚀 Running ${iterations} requests to measure actual latency...`, 'info');
                
                for (let i = 0; i < iterations; i++) {
                    const start = performance.now();
                    try {
                        await makeRequest();
                        times.push(performance.now() - start);
                    } catch (error) {
                        // Count failed requests as high latency
                        times.push(5000); // 5 second penalty
                    }
                }
                
                times.sort((a, b) => a - b);
                const p50 = times[Math.floor(times.length * 0.5)];
                const p95 = times[Math.floor(times.length * 0.95)];
                
                this.log(`📊 Actual Results: P50=${p50.toFixed(2)}ms, P95=${p95.toFixed(2)}ms`, 'info');
                
                if (p95 <= 0.525) {
                    return {
                        verified: true,
                        evidence: `Measured P95: ${p95.toFixed(2)}ms <= 0.525ms`
                    };
                } else if (p95 <= 25) {
                    return {
                        unsubstantiated: true,
                        reason: `Measured P95: ${p95.toFixed(2)}ms. Claim of 0.525ms is false, but meets 25ms SLO`
                    };
                } else {
                    return {
                        failed: true,
                        reason: `Measured P95: ${p95.toFixed(2)}ms exceeds both claimed 0.525ms and 25ms SLO`
                    };
                }
            }
        );
    }

    async auditProductionReadiness() {
        return this.auditClaim(
            "Ready for Production",
            async () => {
                const fs = require('fs');
                const path = require('path');
                
                const issues = [];
                
                // Check 1: Environment file exists
                const envPath = path.join(process.cwd(), '.env');
                if (!fs.existsSync(envPath)) {
                    issues.push("No .env file - credentials not configured");
                }
                
                // Check 2: Required environment variables
                const required = [
                    'SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USERNAME', 'SNOWFLAKE_PASSWORD',
                    'SNOWFLAKE_DATABASE', 'SNOWFLAKE_SCHEMA'
                ];
                
                const missing = required.filter(env => !process.env[env]);
                if (missing.length > 0) {
                    issues.push(`Missing environment variables: ${missing.join(', ')}`);
                }
                
                // Check 3: MCP server can start
                try {
                    const http = require('http');
                    await new Promise((resolve, reject) => {
                        const req = http.get('http://localhost:3000/health', { timeout: 2000 }, (res) => {
                            res.on('data', () => {});
                            res.on('end', resolve);
                        });
                        req.on('error', reject);
                        req.on('timeout', () => {
                            req.destroy();
                            reject(new Error('Server not responding'));
                        });
                    });
                } catch (error) {
                    issues.push("MCP server not running or not healthy");
                }
                
                // Check 4: Chaos testing never performed
                const chaosResultsPath = path.join(process.cwd(), 'test-results', 'chaos-tests.json');
                if (!fs.existsSync(chaosResultsPath)) {
                    issues.push("No chaos testing results found");
                }
                
                // Check 5: Load testing never performed
                const loadTestPath = path.join(process.cwd(), 'test-results', 'load-tests.json');
                if (!fs.existsSync(loadTestPath)) {
                    issues.push("No load testing results found");
                }
                
                if (issues.length === 0) {
                    return {
                        verified: true,
                        evidence: "All production readiness checks passed"
                    };
                } else if (issues.length <= 2) {
                    return {
                        unsubstantiated: true,
                        reason: `Minor issues found: ${issues.join('; ')}`
                    };
                } else {
                    return {
                        failed: true,
                        reason: `Multiple production issues: ${issues.join('; ')}`
                    };
                }
            }
        );
    }

    async auditActivitySchemaCompliance() {
        return this.auditClaim(
            "100% ActivitySchema v2.0 compliance",
            async () => {
                const fs = require('fs');
                const path = require('path');
                
                // Check if compliance tests exist
                const testPath = path.join(process.cwd(), 'bi-mcp-server', 'tests', 'compliance.test.ts');
                if (!fs.existsSync(testPath)) {
                    return {
                        failed: true,
                        reason: "Compliance tests do not exist"
                    };
                }
                
                // Check if tests can run (basic syntax check)
                try {
                    const testContent = fs.readFileSync(testPath, 'utf8');
                    
                    // Look for required test patterns
                    const requiredTests = [
                        'cdesk.*',
                        'query.*tag',
                        'underscore.*prefix',
                        'temporal.*field'
                    ];
                    
                    const missingTests = requiredTests.filter(pattern => {
                        const regex = new RegExp(pattern, 'i');
                        return !regex.test(testContent);
                    });
                    
                    if (missingTests.length > 0) {
                        return {
                            unsubstantiated: true,
                            reason: `Compliance tests missing patterns: ${missingTests.join(', ')}`
                        };
                    }
                    
                    // Check if there's actual Snowflake data to validate against
                    if (!process.env.SNOWFLAKE_PASSWORD) {
                        return {
                            unsubstantiated: true,
                            reason: "No Snowflake connection - cannot validate compliance with real data"
                        };
                    }
                    
                    return {
                        verified: true,
                        evidence: "Compliance test framework exists and covers required patterns"
                    };
                    
                } catch (error) {
                    return {
                        failed: true,
                        reason: `Error reading compliance tests: ${error.message}`
                    };
                }
            }
        );
    }

    async auditQueryTagFormat() {
        return this.auditClaim(
            "Query tags using cdesk_[shortUuid] format",
            async () => {
                const fs = require('fs');
                const path = require('path');
                
                // Check if query tag utility exists
                const utilPath = path.join(process.cwd(), 'bi-mcp-server', 'src', 'utils', 'query-tag.ts');
                if (!fs.existsSync(utilPath)) {
                    return {
                        failed: true,
                        reason: "Query tag utility not found"
                    };
                }
                
                try {
                    const utilContent = fs.readFileSync(utilPath, 'utf8');
                    
                    // Check for proper format implementation
                    if (!utilContent.includes('cdesk_') || !utilContent.includes('.substring(0, 8)')) {
                        return {
                            failed: true,
                            reason: "Query tag format implementation incorrect"
                        };
                    }
                    
                    // Warn about collision risk
                    if (utilContent.includes('.substring(0, 8)')) {
                        return {
                            unsubstantiated: true,
                            reason: "8-character UUIDs have collision risk in production (birthday paradox at ~77K queries)"
                        };
                    }
                    
                    return {
                        verified: true,
                        evidence: "Query tag format correctly implemented"
                    };
                    
                } catch (error) {
                    return {
                        failed: true,
                        reason: `Error reading query tag utility: ${error.message}`
                    };
                }
            }
        );
    }

    async auditIntegrationCompleteness() {
        return this.auditClaim(
            "Integration Complete",
            async () => {
                const fs = require('fs');
                const path = require('path');
                
                const missingComponents = [];
                
                // Check for key implementation files
                const requiredFiles = [
                    'bi-mcp-server/src/index.ts',
                    'bi-mcp-server/src/config.ts',
                    'bi-snowflake-ddl/sql/ddl_poc_setup.sql',
                    '.env.example'
                ];
                
                for (const file of requiredFiles) {
                    if (!fs.existsSync(path.join(process.cwd(), file))) {
                        missingComponents.push(file);
                    }
                }
                
                // Check if Snowflake tables actually exist (would require connection)
                if (!process.env.SNOWFLAKE_PASSWORD) {
                    missingComponents.push("Snowflake connection (DDL not deployed)");
                }
                
                // Check if npm dependencies are installed
                const nodeModulesPath = path.join(process.cwd(), 'bi-mcp-server', 'node_modules');
                if (!fs.existsSync(nodeModulesPath)) {
                    missingComponents.push("Node.js dependencies not installed");
                }
                
                if (missingComponents.length === 0) {
                    return {
                        verified: true,
                        evidence: "All integration components present"
                    };
                } else if (missingComponents.length <= 2) {
                    return {
                        unsubstantiated: true,
                        reason: `Minor components missing: ${missingComponents.join(', ')}`
                    };
                } else {
                    return {
                        failed: true,
                        reason: `Major components missing: ${missingComponents.join(', ')}`
                    };
                }
            }
        );
    }

    async run() {
        this.log('🔴 VICTORY AUDITOR ACTIVATED', 'audit');
        this.log('Challenging all claims of success, completion, and achievement...', 'audit');
        this.log('═══════════════════════════════════════', 'audit');
        
        // Audit common claims from the system
        await this.auditPerformanceClaim();
        await this.auditProductionReadiness();
        await this.auditActivitySchemaCompliance();
        await this.auditQueryTagFormat();
        await this.auditIntegrationCompleteness();
        
        // Generate final report
        this.generateReport();
    }

    generateReport() {
        const total = this.results.verified + this.results.unsubstantiated + this.results.failed;
        
        this.log('\n🔴 VICTORY AUDIT RESULTS', 'audit');
        this.log('═══════════════════════════════════════', 'audit');
        
        this.log(`Claims Audited: ${total}`, 'info');
        this.log(`Verified: ${this.results.verified}`, 'success');
        this.log(`Unsubstantiated: ${this.results.unsubstantiated}`, 'warning');
        this.log(`Failed: ${this.results.failed}`, 'error');
        
        // Calculate trust score
        const trustScore = total > 0 ? Math.round((this.results.verified / total) * 100) : 0;
        const productionReadiness = this.results.failed === 0 ? Math.round((this.results.verified / total) * 100) : 0;
        
        this.log(`\nTRUST SCORE: ${trustScore}%`, trustScore >= 80 ? 'success' : trustScore >= 60 ? 'warning' : 'error');
        this.log(`Production Readiness: ${productionReadiness}%`, productionReadiness >= 80 ? 'success' : 'error');
        
        // Final verdict
        this.log('\nVERDICT:', 'audit');
        if (this.results.failed === 0 && this.results.unsubstantiated <= 1) {
            this.log('✅ CLAIMS VERIFIED - Achievements are backed by evidence', 'success');
        } else if (this.results.failed === 0) {
            this.log('⚠️ PREMATURE VICTORY - Some claims lack sufficient evidence', 'warning');
        } else {
            this.log('❌ CLAIMS REFUTED - Demonstrable failures found', 'error');
        }
        
        this.log('\nRECOMMENDations:', 'info');
        this.log('• Run actual performance benchmarks before claiming latency numbers', 'info');
        this.log('• Deploy to Snowflake before claiming "integration complete"', 'info');
        this.log('• Perform chaos testing before claiming "production ready"', 'info');
        this.log('• Consider longer UUIDs to prevent query tag collisions', 'info');
        
        this.log('\nPHILOSOPHY: Better to find issues now than at 3 AM in production.', 'audit');
        
        // Exit with appropriate code
        process.exit(this.results.failed > 0 ? 1 : 0);
    }
}

// Run if called directly
if (require.main === module) {
    const auditor = new VictoryAuditor();
    auditor.run().catch(error => {
        console.error('Victory audit crashed:', error);
        process.exit(1);
    });
}

module.exports = VictoryAuditor;