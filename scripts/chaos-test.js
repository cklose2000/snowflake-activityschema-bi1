#!/usr/bin/env node

/**
 * Chaos Testing Framework for BI System
 * 
 * Tests system resilience by introducing controlled failures.
 * Levels:
 * - Level 1: Basic failures (process kills, restarts)
 * - Level 2: Resource exhaustion (memory, disk, CPU)
 * - Level 3: Data corruption and byzantine failures
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Chaos test configuration
const CONFIG = {
  level: parseInt(process.env.CHAOS_LEVEL || '1'),
  duration: parseInt(process.env.CHAOS_DURATION || '60'), // seconds
  services: {
    mcp: {
      path: path.join(__dirname, '..', 'bi-mcp-server'),
      command: 'npm run start:dev',
      port: 3000,
    },
    uploader: {
      path: path.join(__dirname, '..', 'bi-uploader'),
      command: 'npm start',
      port: 9091,
    },
  },
  dataDir: path.join(__dirname, '..', 'bi-mcp-server', 'data'),
};

// Track chaos results
class ChaosReporter {
  constructor() {
    this.scenarios = [];
    this.failures = [];
    this.recoveries = [];
    this.startTime = Date.now();
  }

  recordScenario(name, description, outcome) {
    this.scenarios.push({
      name,
      description,
      outcome,
      timestamp: Date.now() - this.startTime,
    });
    
    console.log(`🎲 ${name}: ${outcome}`);
  }

  recordFailure(service, error, recovered = false) {
    this.failures.push({
      service,
      error: error.message || error,
      recovered,
      timestamp: Date.now() - this.startTime,
    });
    
    if (recovered) {
      this.recoveries.push({ service, timestamp: Date.now() - this.startTime });
    }
  }

  generateReport() {
    const duration = (Date.now() - this.startTime) / 1000;
    const recoveryRate = this.recoveries.length / Math.max(1, this.failures.length);
    
    return {
      level: CONFIG.level,
      duration: `${duration}s`,
      scenarios: this.scenarios.length,
      failures: this.failures.length,
      recoveries: this.recoveries.length,
      recoveryRate: `${(recoveryRate * 100).toFixed(1)}%`,
      details: {
        scenarios: this.scenarios,
        failures: this.failures,
      },
    };
  }
}

// Service management
class ServiceManager {
  constructor() {
    this.processes = new Map();
  }

  async start(name, config) {
    return new Promise((resolve, reject) => {
      console.log(`🚀 Starting ${name}...`);
      
      const proc = spawn(config.command, [], {
        cwd: config.path,
        shell: true,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      
      this.processes.set(name, proc);
      
      // Wait for service to be ready
      setTimeout(() => {
        this.checkHealth(name, config.port)
          .then(() => {
            console.log(`✅ ${name} started`);
            resolve(proc);
          })
          .catch(reject);
      }, 3000);
      
      proc.on('error', (err) => {
        console.error(`❌ ${name} error:`, err.message);
      });
    });
  }

  async stop(name) {
    const proc = this.processes.get(name);
    if (proc) {
      console.log(`🛑 Stopping ${name}...`);
      proc.kill('SIGTERM');
      this.processes.delete(name);
      
      // Wait for process to terminate
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async kill(name) {
    const proc = this.processes.get(name);
    if (proc) {
      console.log(`💀 Killing ${name} (PID: ${proc.pid})`);
      proc.kill('SIGKILL');
      this.processes.delete(name);
    }
  }

  async checkHealth(name, port) {
    const http = require('http');
    
    return new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${port}/health`, { timeout: 2000 }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(true));
      });
      
      req.on('error', () => reject(new Error(`${name} not responding`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`${name} timeout`));
      });
    });
  }

  async stopAll() {
    for (const [name] of this.processes) {
      await this.stop(name);
    }
  }
}

// Chaos scenarios
class ChaosScenarios {
  constructor(services, reporter) {
    this.services = services;
    this.reporter = reporter;
  }

  // Level 1: Basic failures
  async killRandomProcess() {
    const serviceNames = ['mcp', 'uploader'];
    const target = serviceNames[Math.floor(Math.random() * serviceNames.length)];
    
    await this.services.kill(target);
    this.reporter.recordScenario(
      'kill_process',
      `Killed ${target} process with SIGKILL`,
      'executed'
    );
    
    // Try to restart
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      await this.services.start(target, CONFIG.services[target]);
      this.reporter.recordFailure(target, 'Process killed', true);
      return true;
    } catch (error) {
      this.reporter.recordFailure(target, 'Process killed', false);
      return false;
    }
  }

  async networkPartition() {
    // Simulate network failure by blocking localhost connections
    // Note: This requires sudo on real systems
    this.reporter.recordScenario(
      'network_partition',
      'Simulated network partition (mock)',
      'simulated'
    );
    
    // In a real test, would use:
    // sudo iptables -A INPUT -p tcp --dport 3000 -j DROP
    // sudo iptables -A INPUT -p tcp --dport 9091 -j DROP
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Restore network
    // sudo iptables -D INPUT -p tcp --dport 3000 -j DROP
    // sudo iptables -D INPUT -p tcp --dport 9091 -j DROP
    
    return true;
  }

  // Level 2: Resource exhaustion
  async fillMemory() {
    this.reporter.recordScenario(
      'memory_exhaustion',
      'Allocating large memory buffers',
      'started'
    );
    
    const buffers = [];
    try {
      // Allocate 100MB chunks
      for (let i = 0; i < 10; i++) {
        buffers.push(Buffer.alloc(100 * 1024 * 1024));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      this.reporter.recordScenario(
        'memory_exhaustion',
        'Allocated 1GB of memory',
        'completed'
      );
      
      // Hold for 5 seconds
      await new Promise(resolve => setTimeout(resolve, 5000));
      
    } catch (error) {
      this.reporter.recordFailure('system', `Memory allocation failed: ${error.message}`, true);
    }
    
    // Release memory
    buffers.length = 0;
    if (global.gc) global.gc();
    
    return true;
  }

  async fillDisk() {
    const testFile = path.join(CONFIG.dataDir, 'chaos_disk_test.dat');
    
    this.reporter.recordScenario(
      'disk_exhaustion',
      'Creating large file to fill disk',
      'started'
    );
    
    try {
      // Create a 500MB file
      const stream = fs.createWriteStream(testFile);
      const chunk = Buffer.alloc(1024 * 1024); // 1MB chunks
      
      for (let i = 0; i < 500; i++) {
        stream.write(chunk);
      }
      
      stream.end();
      
      this.reporter.recordScenario(
        'disk_exhaustion',
        'Created 500MB file',
        'completed'
      );
      
      // Hold for 5 seconds
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Clean up
      fs.unlinkSync(testFile);
      
    } catch (error) {
      this.reporter.recordFailure('disk', error.message, false);
      
      // Try to clean up
      try {
        if (fs.existsSync(testFile)) {
          fs.unlinkSync(testFile);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    return true;
  }

  async cpuSpike() {
    this.reporter.recordScenario(
      'cpu_spike',
      'Creating CPU-intensive workload',
      'started'
    );
    
    const startTime = Date.now();
    const duration = 5000; // 5 seconds
    
    // CPU-intensive calculation
    while (Date.now() - startTime < duration) {
      Math.sqrt(Math.random());
      // Don't completely block event loop
      if ((Date.now() - startTime) % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    this.reporter.recordScenario(
      'cpu_spike',
      'CPU spike completed',
      'completed'
    );
    
    return true;
  }

  // Level 3: Data corruption
  async corruptNDJSON() {
    const files = fs.readdirSync(CONFIG.dataDir)
      .filter(f => f.endsWith('.ndjson'));
    
    if (files.length === 0) {
      // Create a test file
      const testFile = path.join(CONFIG.dataDir, 'chaos_test.ndjson');
      fs.writeFileSync(testFile, '{"test": true}\n{"corrupt": ');
      files.push('chaos_test.ndjson');
    }
    
    const target = files[0];
    const filePath = path.join(CONFIG.dataDir, target);
    
    this.reporter.recordScenario(
      'corrupt_data',
      `Corrupting NDJSON file: ${target}`,
      'executed'
    );
    
    try {
      // Append corrupted data
      fs.appendFileSync(filePath, '\n{CORRUPTED JSON HERE}\n{"partial": ');
      
      // Wait for uploader to process
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check if uploader handled corruption gracefully
      const errorDir = path.join(CONFIG.dataDir, '..', '..', 'bi-uploader', 'data', 'error');
      const errorFiles = fs.existsSync(errorDir) ? fs.readdirSync(errorDir) : [];
      
      if (errorFiles.includes(target)) {
        this.reporter.recordFailure('uploader', 'Corrupted file detected', true);
      }
      
    } catch (error) {
      this.reporter.recordFailure('data', error.message, false);
    }
    
    return true;
  }

  async rapidRestarts() {
    this.reporter.recordScenario(
      'rapid_restarts',
      'Rapidly restarting services',
      'started'
    );
    
    for (let i = 0; i < 5; i++) {
      await this.services.stop('mcp');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      try {
        await this.services.start('mcp', CONFIG.services.mcp);
      } catch (error) {
        this.reporter.recordFailure('mcp', `Restart ${i + 1} failed`, false);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    this.reporter.recordScenario(
      'rapid_restarts',
      'Completed 5 rapid restarts',
      'completed'
    );
    
    return true;
  }

  async concurrentWrites() {
    this.reporter.recordScenario(
      'concurrent_writes',
      'Testing concurrent NDJSON writes',
      'started'
    );
    
    const promises = [];
    const testFile = path.join(CONFIG.dataDir, 'concurrent_test.ndjson');
    
    // 100 concurrent writes
    for (let i = 0; i < 100; i++) {
      promises.push(
        fs.promises.appendFile(
          testFile,
          JSON.stringify({ id: i, timestamp: Date.now() }) + '\n'
        )
      );
    }
    
    try {
      await Promise.all(promises);
      
      // Verify file integrity
      const lines = fs.readFileSync(testFile, 'utf8').split('\n').filter(l => l);
      const validLines = lines.filter(line => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });
      
      const integrity = validLines.length / lines.length;
      
      this.reporter.recordScenario(
        'concurrent_writes',
        `File integrity: ${(integrity * 100).toFixed(1)}%`,
        integrity === 1 ? 'passed' : 'degraded'
      );
      
      if (integrity < 1) {
        this.reporter.recordFailure('queue', `Lost ${lines.length - validLines.length} events`, false);
      }
      
    } catch (error) {
      this.reporter.recordFailure('queue', error.message, false);
    }
    
    return true;
  }
}

// Main chaos orchestrator
async function runChaosTests(level) {
  console.log('💥 CHAOS TESTING FRAMEWORK');
  console.log('═══════════════════════════════════════');
  console.log(`Level: ${level}`);
  console.log(`Duration: ${CONFIG.duration}s`);
  console.log('');
  
  const services = new ServiceManager();
  const reporter = new ChaosReporter();
  const scenarios = new ChaosScenarios(services, reporter);
  
  // Start services
  console.log('🚀 Starting services...');
  try {
    await services.start('mcp', CONFIG.services.mcp);
    await services.start('uploader', CONFIG.services.uploader);
  } catch (error) {
    console.error('❌ Failed to start services:', error.message);
    console.error('Please ensure services can start normally before chaos testing');
    process.exit(1);
  }
  
  console.log('');
  console.log('🎲 Beginning chaos scenarios...');
  console.log('');
  
  const startTime = Date.now();
  const endTime = startTime + (CONFIG.duration * 1000);
  
  // Run scenarios based on level
  while (Date.now() < endTime) {
    try {
      // Level 1 scenarios
      if (level >= 1) {
        await scenarios.killRandomProcess();
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        if (Date.now() >= endTime) break;
        
        await scenarios.networkPartition();
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      // Level 2 scenarios
      if (level >= 2 && Date.now() < endTime) {
        await scenarios.fillMemory();
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (Date.now() >= endTime) break;
        
        await scenarios.fillDisk();
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (Date.now() >= endTime) break;
        
        await scenarios.cpuSpike();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Level 3 scenarios
      if (level >= 3 && Date.now() < endTime) {
        await scenarios.corruptNDJSON();
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (Date.now() >= endTime) break;
        
        await scenarios.rapidRestarts();
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (Date.now() >= endTime) break;
        
        await scenarios.concurrentWrites();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
    } catch (error) {
      console.error('💥 Chaos scenario error:', error.message);
      reporter.recordFailure('chaos', error.message, false);
    }
  }
  
  // Stop services
  console.log('');
  console.log('🛑 Stopping services...');
  await services.stopAll();
  
  // Generate report
  const report = reporter.generateReport();
  
  console.log('');
  console.log('📊 CHAOS TEST RESULTS');
  console.log('═══════════════════════════════════════');
  console.log(`Level: ${report.level}`);
  console.log(`Duration: ${report.duration}`);
  console.log(`Scenarios Run: ${report.scenarios}`);
  console.log(`Failures: ${report.failures}`);
  console.log(`Recoveries: ${report.recoveries}`);
  console.log(`Recovery Rate: ${report.recoveryRate}`);
  console.log('');
  
  // Detailed breakdown
  console.log('📝 Scenario Summary:');
  const scenarioTypes = {};
  report.details.scenarios.forEach(s => {
    scenarioTypes[s.name] = (scenarioTypes[s.name] || 0) + 1;
  });
  
  for (const [name, count] of Object.entries(scenarioTypes)) {
    const passed = report.details.scenarios
      .filter(s => s.name === name && (s.outcome === 'completed' || s.outcome === 'passed'))
      .length;
    console.log(`  ${name}: ${passed}/${count} passed`);
  }
  
  // Save report
  const resultsDir = path.join(__dirname, '..', 'test-results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  
  const reportFile = path.join(resultsDir, `chaos-test-level${level}-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  
  console.log('');
  console.log(`📁 Full report saved to: ${reportFile}`);
  
  // Verdict
  const passed = parseFloat(report.recoveryRate.replace('%', '')) >= 70;
  
  console.log('');
  console.log('═══════════════════════════════════════');
  if (passed) {
    console.log(`✅ CHAOS LEVEL ${level} SURVIVED - System shows resilience`);
  } else {
    console.log(`❌ CHAOS LEVEL ${level} FAILED - Insufficient recovery rate`);
  }
  
  return passed;
}

// Main execution
async function main() {
  const level = CONFIG.level;
  
  try {
    const passed = await runChaosTests(level);
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error('❌ Chaos test crashed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { runChaosTests };