/**
 * Authentication-Enabled Snowflake Client
 * 
 * Enhanced Snowflake client that integrates with the authentication agent
 * for intelligent failover, circuit breaking, and anti-lockout protection.
 */

import { performance } from 'perf_hooks';
import { Config } from '../config.js';
import { QueryResult } from './snowflake-client.js';
import { SAFE_TEMPLATES } from '../sql/safe-templates.js';

// Import auth agent components from built files
import { CredentialVault } from '../../../snowflake-auth-agent/dist/credential/credential-vault.js';
import { AuthCircuitBreaker } from '../../../snowflake-auth-agent/dist/circuit-breaker/auth-circuit-breaker.js';
import { ConnectionManager } from '../../../snowflake-auth-agent/dist/connection/connection-manager.js';
import { HealthMonitor } from '../../../snowflake-auth-agent/dist/health/health-monitor.js';

// Create a simple logger for now
const logger = {
  info: (obj: any, msg?: string) => console.log(`INFO: ${msg || ''} ${JSON.stringify(obj)}`),
  warn: (obj: any, msg?: string) => console.warn(`WARN: ${msg || ''} ${JSON.stringify(obj)}`),
  error: (obj: any, msg?: string) => console.error(`ERROR: ${msg || ''} ${JSON.stringify(obj)}`),
  debug: (obj: any, msg?: string) => process.env.LOG_LEVEL === 'debug' && console.log(`DEBUG: ${msg || ''} ${JSON.stringify(obj)}`),
};

export class AuthEnabledSnowflakeClient {
  private config: Config;
  private credentialVault: CredentialVault;
  private circuitBreaker: AuthCircuitBreaker;
  private connectionManager: ConnectionManager;
  private healthMonitor: HealthMonitor;
  private isInitialized: boolean = false;
  private queryCache: Map<string, { result: QueryResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute cache for repeated queries

  constructor(config: Config) {
    this.config = config;

    // Initialize auth agent components
    this.credentialVault = new CredentialVault(
      process.env.AUTH_VAULT_CONFIG_PATH,
      process.env.VAULT_ENCRYPTION_KEY
    );

    this.circuitBreaker = new AuthCircuitBreaker({
      failureThreshold: 3,
      recoveryTimeoutMs: 300000, // 5 minutes
      successThreshold: 1,
      timeWindowMs: 600000, // 10 minutes
      maxBackoffMs: 300000, // 5 minutes
      backoffMultiplier: 2,
    });

    this.connectionManager = new ConnectionManager(
      this.credentialVault,
      this.circuitBreaker,
      {
        minPoolSize: 2,
        maxPoolSize: Math.min(config.snowflake.username ? 15 : 20, 20), // Use configured limit
        connectionTimeout: config.performance?.connectionTimeout || 10000,
        healthCheckInterval: 30000,
        healthCheckTimeout: 5000,
        maxIdleTime: 600000,
        retryAttempts: 3,
        retryDelayMs: 1000,
      }
    );

    this.healthMonitor = new HealthMonitor(
      this.credentialVault,
      this.circuitBreaker,
      this.connectionManager,
      {
        checkInterval: 30000,
        alertThreshold: {
          degradedHealthScore: 70,
          criticalHealthScore: 30,
          maxFailureRate: 0.2,
          minAvailableAccounts: 1,
        },
        responseTimeTracking: {
          enabled: true,
          windowSize: 100,
        },
        alerting: {
          enabled: true,
          cooldownMs: 300000,
          maxAlertsPerHour: 10,
        },
      }
    );
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Auth-enabled Snowflake client already initialized');
      return;
    }

    logger.info('Initializing auth-enabled Snowflake client');
    
    try {
      // Initialize auth agent components
      await this.credentialVault.initialize();
      await this.connectionManager.initialize();
      this.healthMonitor.start();
      
      this.isInitialized = true;
      
      // Warm up cache with common queries
      await this.warmCache();
      
      logger.info('Auth-enabled Snowflake client initialized successfully');
      
    } catch (error) {
      logger.error({ error }, 'Failed to initialize auth-enabled Snowflake client');
      throw error;
    }
  }

  /**
   * Execute a SafeSQL template with intelligent authentication and failover
   */
  async executeTemplate(
    templateName: string,
    params: any[],
    options: { 
      timeout?: number; 
      useCache?: boolean;
      queryTag?: string;
      preferredAccount?: string;
    } = {}
  ): Promise<QueryResult> {
    if (!this.isInitialized) {
      throw new Error('Auth-enabled Snowflake client not initialized');
    }

    const start = performance.now();
    
    // Check cache if enabled
    if (options.useCache) {
      const cacheKey = `${templateName}:${JSON.stringify(params)}`;
      const cached = this.queryCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        const executionTime = performance.now() - start;
        logger.debug({ templateName, executionTime, cached: true }, 'Cache hit');
        return { ...cached.result, executionTime };
      }
    }
    
    // Validate template exists
    const template = SAFE_TEMPLATES.get(templateName);
    if (!template) {
      throw new Error(`Unknown template: ${templateName}`);
    }
    
    // Validate parameters
    const validatedParams = template.validator(params);
    
    // Get connection with intelligent failover
    const { connection, account } = await this.connectionManager.getConnection(
      options.preferredAccount
    );
    
    const queryTag = options.queryTag || `cdesk_${templateName}_${Date.now()}`;
    
    try {
      const result = await this.executeQuery(
        connection,
        template.sql,
        validatedParams,
        {
          timeout: options.timeout || this.config.performance?.databaseQueryTimeout || 30000,
          queryTag,
        }
      );
      
      // Record success
      await this.credentialVault.recordSuccess(account.username);
      this.circuitBreaker.recordSuccess(account.username);
      
      // Record response time for health monitoring
      this.healthMonitor.recordResponseTime(account.username, result.executionTime);
      
      // Cache if enabled
      if (options.useCache) {
        const cacheKey = `${templateName}:${JSON.stringify(params)}`;
        this.queryCache.set(cacheKey, {
          result,
          timestamp: Date.now(),
        });
        
        // Clean old cache entries
        if (this.queryCache.size > 1000) {
          const oldest = Array.from(this.queryCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
          this.queryCache.delete(oldest[0]);
        }
      }
      
      logger.info({ 
        templateName, 
        account: account.username,
        rowCount: result.rowCount,
        executionTime: result.executionTime,
        cached: false 
      }, 'Query executed successfully');
      
      return result;
      
    } catch (error: any) {
      // Record failure
      await this.credentialVault.recordFailure(account.username, error.message);
      this.circuitBreaker.recordFailure(account.username, error.message);
      
      logger.error({ 
        error: error.message,
        templateName,
        account: account.username,
        executionTime: performance.now() - start,
      }, 'Query execution failed');
      
      throw error;
      
    } finally {
      // Always release connection
      await this.connectionManager.releaseConnection(connection);
    }
  }

  /**
   * Execute batch operations with transaction support
   */
  async executeBatch(operations: Array<{ template: string; params: any[] }>): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Auth-enabled Snowflake client not initialized');
    }

    // Get connection for batch operation
    const { connection, account } = await this.connectionManager.getConnection();
    
    try {
      // Start transaction
      await this.executeRaw(connection, 'BEGIN TRANSACTION');
      
      try {
        for (const op of operations) {
          const template = SAFE_TEMPLATES.get(op.template);
          if (!template) {
            throw new Error(`Unknown template: ${op.template}`);
          }
          
          const validatedParams = template.validator(op.params);
          await this.executeRaw(connection, template.sql, validatedParams);
        }
        
        // Commit transaction
        await this.executeRaw(connection, 'COMMIT');
        
        // Record success
        await this.credentialVault.recordSuccess(account.username);
        this.circuitBreaker.recordSuccess(account.username);
        
        logger.info({ 
          account: account.username,
          operationCount: operations.length 
        }, 'Batch executed successfully');
        
      } catch (error) {
        // Rollback on error
        await this.executeRaw(connection, 'ROLLBACK');
        throw error;
      }
      
    } catch (error: any) {
      // Record failure
      await this.credentialVault.recordFailure(account.username, error.message);
      this.circuitBreaker.recordFailure(account.username, error.message);
      
      throw error;
      
    } finally {
      await this.connectionManager.releaseConnection(connection);
    }
  }

  /**
   * Get context with ultra-fast caching (maintains original interface)
   */
  async getContextFromCache(customerId: string): Promise<any> {
    const start = performance.now();
    
    try {
      const result = await this.executeTemplate(
        'GET_CONTEXT',
        [customerId],
        { 
          useCache: true,
          timeout: this.config.performance?.cacheHitTimeout || 25, // Strict 25ms for cache hits
        }
      );
      
      const latency = performance.now() - start;
      
      if (latency > 25) {
        logger.warn({ customerId, latency }, 'Context retrieval exceeded 25ms target');
      }
      
      if (result.rows.length > 0) {
        return result.rows[0].CONTEXT_BLOB;
      }
      
      return null;
      
    } catch (error: any) {
      logger.error({ error: error.message, customerId }, 'Failed to get context');
      return null;
    }
  }

  /**
   * Get comprehensive system health status
   */
  async getSystemHealth(): Promise<any> {
    if (!this.isInitialized) {
      return { status: 'not_initialized' };
    }

    const healthStatus = await this.healthMonitor.getHealthStatus();
    const connectionStats = this.connectionManager.getStats();
    const circuitMetrics = this.circuitBreaker.getAllMetrics();
    
    return {
      overall: healthStatus.overall,
      accounts: healthStatus.accounts,
      summary: healthStatus.summary,
      recommendations: healthStatus.recommendations,
      connectionPools: connectionStats,
      circuitBreakers: circuitMetrics,
      cacheSize: this.queryCache.size,
      lastHealthCheck: healthStatus.lastCheck,
    };
  }

  /**
   * Manually unlock an account (admin operation)
   */
  async unlockAccount(username: string): Promise<boolean> {
    const vaultResult = await this.credentialVault.unlockAccount(username);
    this.circuitBreaker.reset(username);
    
    if (vaultResult) {
      logger.info({ username }, 'Account unlocked via admin operation');
      return true;
    }
    
    return false;
  }

  /**
   * Force refresh of connection pools
   */
  async refreshConnections(): Promise<void> {
    await this.connectionManager.refreshPools();
    logger.info('Connection pools refreshed');
  }

  /**
   * Get performance and usage statistics
   */
  getStats() {
    if (!this.isInitialized) {
      return {
        initialized: false,
        cacheSize: this.queryCache.size,
      };
    }

    const connectionStats = this.connectionManager.getStats();
    const totalConnections = connectionStats.reduce((sum, stat) => sum + stat.totalConnections, 0);
    const totalActive = connectionStats.reduce((sum, stat) => sum + stat.activeConnections, 0);
    
    return {
      initialized: true,
      totalConnectionPools: connectionStats.length,
      totalConnections,
      totalActive,
      totalIdle: totalConnections - totalActive,
      cacheSize: this.queryCache.size,
      connectionStats,
    };
  }

  /**
   * Close all connections and cleanup
   */
  async close(): Promise<void> {
    logger.info('Closing auth-enabled Snowflake client');
    
    try {
      if (this.isInitialized) {
        this.healthMonitor.stop();
        await this.connectionManager.destroy();
        this.circuitBreaker.destroy();
      }
      
      this.queryCache.clear();
      this.isInitialized = false;
      
      logger.info('Auth-enabled Snowflake client closed successfully');
      
    } catch (error) {
      logger.error({ error }, 'Error closing auth-enabled Snowflake client');
      throw error;
    }
  }

  // Private methods

  private async executeQuery(
    connection: any,
    sql: string,
    binds: any[],
    options: { timeout: number; queryTag?: string }
  ): Promise<QueryResult> {
    const startTime = performance.now();
    
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Query timeout after ${options.timeout}ms`));
      }, options.timeout);

      connection.execute({
        sqlText: sql,
        binds,
        streamResult: false,
        queryId: options.queryTag,
        complete: (err: any, _stmt: any, rows?: any[]) => {
          clearTimeout(timeoutHandle);
          
          const executionTime = performance.now() - startTime;
          
          if (err) {
            reject(err);
          } else {
            resolve({
              rows: rows || [],
              rowCount: rows?.length || 0,
              executionTime,
              queryId: options.queryTag,
            });
          }
        },
      });
    });
  }

  private async executeRaw(
    connection: any, 
    sql: string, 
    binds?: any[]
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      connection.execute({
        sqlText: sql,
        binds,
        complete: (err: any, _stmt: any, rows?: any[]) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        },
      });
    });
  }

  private async warmCache(): Promise<void> {
    logger.info('Warming cache with common queries');
    
    try {
      // Pre-load test_user context
      await this.executeTemplate(
        'GET_CONTEXT',
        ['test_user'],
        { useCache: true, timeout: 5000 }
      );
      
      // Pre-load common health checks
      await this.executeTemplate(
        'CHECK_HEALTH',
        [],
        { useCache: true, timeout: 5000 }
      );
      
      logger.info({ cachedQueries: this.queryCache.size }, 'Cache warmed');
      
    } catch (error) {
      logger.warn({ error }, 'Failed to warm cache - this is expected on first run');
    }
  }
}