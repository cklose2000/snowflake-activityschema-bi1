/**
 * Snowflake Authentication Agent
 * 
 * Main entry point for the intelligent Snowflake authentication system
 * with anti-lockout protection, circuit breaking, and health monitoring.
 */

import pino from 'pino';
import { resolve } from 'path';

import { CredentialVault } from './credential/credential-vault';
import { AuthCircuitBreaker } from './circuit-breaker/auth-circuit-breaker';
import { ConnectionManager } from './connection/connection-manager';
import { HealthMonitor } from './health/health-monitor';
import { AuthAgentServer } from './mcp/auth-agent-server';

const logger = pino({ 
  name: 'snowflake-auth-agent',
  level: process.env.LOG_LEVEL || 'info',
});

interface AuthAgentConfig {
  credentialVault: {
    configPath?: string;
    encryptionKey?: string;
  };
  circuitBreaker: {
    failureThreshold: number;
    recoveryTimeoutMs: number;
    successThreshold: number;
    timeWindowMs: number;
    maxBackoffMs: number;
    backoffMultiplier: number;
  };
  connectionManager: {
    minPoolSize: number;
    maxPoolSize: number;
    connectionTimeout: number;
    healthCheckInterval: number;
    healthCheckTimeout: number;
    maxIdleTime: number;
  };
  healthMonitor: {
    checkInterval: number;
    alertThreshold: {
      degradedHealthScore: number;
      criticalHealthScore: number;
      maxFailureRate: number;
      minAvailableAccounts: number;
    };
  };
  mcpServer: {
    name: string;
    version: string;
    performanceTargets: {
      executeQuery: number;
      getHealth: number;
      unlockAccount: number;
    };
  };
}

const DEFAULT_CONFIG: AuthAgentConfig = {
  credentialVault: {
    configPath: resolve(process.cwd(), 'config/accounts.encrypted.json'),
    encryptionKey: process.env.VAULT_ENCRYPTION_KEY,
  },
  circuitBreaker: {
    failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '3'),
    recoveryTimeoutMs: parseInt(process.env.CB_RECOVERY_TIMEOUT || '300000'), // 5 minutes
    successThreshold: parseInt(process.env.CB_SUCCESS_THRESHOLD || '1'),
    timeWindowMs: parseInt(process.env.CB_TIME_WINDOW || '600000'), // 10 minutes
    maxBackoffMs: parseInt(process.env.CB_MAX_BACKOFF || '300000'), // 5 minutes
    backoffMultiplier: parseFloat(process.env.CB_BACKOFF_MULTIPLIER || '2'),
  },
  connectionManager: {
    minPoolSize: parseInt(process.env.POOL_MIN_SIZE || '2'),
    maxPoolSize: parseInt(process.env.POOL_MAX_SIZE || '15'),
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '10000'), // 10 seconds
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000'), // 30 seconds
    healthCheckTimeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000'), // 5 seconds
    maxIdleTime: parseInt(process.env.MAX_IDLE_TIME || '600000'), // 10 minutes
  },
  healthMonitor: {
    checkInterval: parseInt(process.env.HEALTH_MONITOR_INTERVAL || '30000'), // 30 seconds
    alertThreshold: {
      degradedHealthScore: parseInt(process.env.ALERT_DEGRADED_SCORE || '70'),
      criticalHealthScore: parseInt(process.env.ALERT_CRITICAL_SCORE || '30'),
      maxFailureRate: parseFloat(process.env.ALERT_MAX_FAILURE_RATE || '0.2'), // 20%
      minAvailableAccounts: parseInt(process.env.ALERT_MIN_ACCOUNTS || '1'),
    },
  },
  mcpServer: {
    name: process.env.MCP_SERVER_NAME || 'snowflake-auth-agent',
    version: process.env.MCP_SERVER_VERSION || '1.0.0',
    performanceTargets: {
      executeQuery: parseInt(process.env.PERF_TARGET_QUERY || '1000'), // 1 second
      getHealth: parseInt(process.env.PERF_TARGET_HEALTH || '100'), // 100ms
      unlockAccount: parseInt(process.env.PERF_TARGET_UNLOCK || '500'), // 500ms
    },
  },
};

class SnowflakeAuthAgent {
  private config: AuthAgentConfig;
  private credentialVault: CredentialVault;
  private circuitBreaker: AuthCircuitBreaker;
  private connectionManager: ConnectionManager;
  private healthMonitor: HealthMonitor;
  private mcpServer: AuthAgentServer;
  
  private isRunning = false;

  constructor(config: Partial<AuthAgentConfig> = {}) {
    this.config = this.mergeConfig(DEFAULT_CONFIG, config);
    
    logger.info({ config: this.sanitizeConfig(this.config) }, 'Auth agent configuration loaded');
    
    // Initialize components
    this.credentialVault = new CredentialVault(
      this.config.credentialVault.configPath,
      this.config.credentialVault.encryptionKey
    );
    
    this.circuitBreaker = new AuthCircuitBreaker(this.config.circuitBreaker);
    
    this.connectionManager = new ConnectionManager(
      this.credentialVault,
      this.circuitBreaker,
      this.config.connectionManager
    );
    
    this.healthMonitor = new HealthMonitor(
      this.credentialVault,
      this.circuitBreaker,
      this.connectionManager,
      this.config.healthMonitor
    );
    
    this.mcpServer = new AuthAgentServer(
      this.credentialVault,
      this.circuitBreaker,
      this.connectionManager,
      this.healthMonitor,
      this.config.mcpServer
    );
    
    // Setup graceful shutdown
    this.setupGracefulShutdown();
    
    logger.info('Snowflake Auth Agent components initialized');
  }

  /**
   * Start the authentication agent
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Auth agent already running');
      return;
    }

    logger.info('Starting Snowflake Authentication Agent');

    try {
      // Start the MCP server (this will initialize all components)
      await this.mcpServer.start();
      
      this.isRunning = true;
      logger.info('🔐 Snowflake Authentication Agent started successfully');
      
      // Log initial system status
      await this.logSystemStatus();
      
    } catch (error) {
      logger.error({ error }, 'Failed to start auth agent');
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the authentication agent
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Auth agent not running');
      return;
    }

    logger.info('Stopping Snowflake Authentication Agent');

    try {
      // Stop components in reverse order
      await this.mcpServer.stop();
      this.circuitBreaker.destroy();
      
      this.isRunning = false;
      logger.info('Snowflake Authentication Agent stopped successfully');
      
    } catch (error) {
      logger.error({ error }, 'Error stopping auth agent');
      throw error;
    }
  }

  /**
   * Get current system status
   */
  async getStatus(): Promise<{
    running: boolean;
    health: any;
    connectionStats: any;
    circuitMetrics: any;
  }> {
    return {
      running: this.isRunning,
      health: this.isRunning ? await this.healthMonitor.getHealthStatus() : null,
      connectionStats: this.isRunning ? this.connectionManager.getStats() : null,
      circuitMetrics: this.isRunning ? this.circuitBreaker.getAllMetrics() : null,
    };
  }

  // Private methods

  private mergeConfig(defaultConfig: AuthAgentConfig, userConfig: Partial<AuthAgentConfig>): AuthAgentConfig {
    const merged = JSON.parse(JSON.stringify(defaultConfig)); // Deep clone
    
    // Deep merge user config
    for (const [key, value] of Object.entries(userConfig)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        merged[key] = { ...merged[key], ...value };
      } else {
        merged[key] = value;
      }
    }
    
    return merged;
  }

  private sanitizeConfig(config: AuthAgentConfig): any {
    const sanitized = JSON.parse(JSON.stringify(config));
    
    // Remove sensitive information
    if (sanitized.credentialVault?.encryptionKey) {
      sanitized.credentialVault.encryptionKey = '[REDACTED]';
    }
    
    return sanitized;
  }

  private async logSystemStatus(): Promise<void> {
    try {
      const status = await this.getStatus();
      
      logger.info({
        health: status.health?.overall,
        totalAccounts: status.health?.summary?.total,
        healthyAccounts: status.health?.summary?.healthy,
        totalConnectionPools: status.connectionStats?.length,
        circuitBreakers: Object.keys(status.circuitMetrics || {}).length,
      }, 'System status check');
      
    } catch (error) {
      logger.warn({ error }, 'Failed to log system status');
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);
      
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        logger.error({ error }, 'Error during graceful shutdown');
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.fatal({ error }, 'Uncaught exception');
      process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.fatal({ reason, promise }, 'Unhandled rejection');
      process.exit(1);
    });
  }
}

// Main execution
async function main() {
  try {
    const agent = new SnowflakeAuthAgent();
    await agent.start();
    
    // Keep the process running
    // The MCP server will handle stdin/stdout communication
    
  } catch (error) {
    logger.fatal({ error }, 'Failed to start Snowflake Authentication Agent');
    process.exit(1);
  }
}

// Start the agent if this file is run directly
if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ error }, 'Fatal error in main');
    process.exit(1);
  });
}

export { SnowflakeAuthAgent };
export type { AuthAgentConfig };