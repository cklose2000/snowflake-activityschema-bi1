/**
 * Smart Connection Manager for Snowflake
 * 
 * Manages connection pools per account with intelligent failover,
 * connection reuse, and health monitoring to minimize authentication attempts.
 */

import snowflake from 'snowflake-sdk';
import pino from 'pino';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { CredentialVault, AccountConfig } from '../credential/credential-vault';
import { AuthCircuitBreaker, CircuitState } from '../circuit-breaker/auth-circuit-breaker';

const logger = pino({ name: 'connection-manager' });

// Auth event logging function (will write to AUTH_EVENTS table)
async function logAuthEvent(
  connection: snowflake.Connection | null,
  accountName: string,
  eventType: string,
  success: boolean,
  errorMessage?: string,
  metadata?: any
): Promise<void> {
  try {
    if (connection) {
      const eventId = uuidv4().substring(0, 8);
      // Use fully qualified table name
      const query = `
        INSERT INTO CLAUDE_LOGS.ACTIVITIES.AUTH_EVENTS (
          event_id, account_name, event_type, error_message,
          source_ip, user_agent, connection_id, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())
      `;
      
      logger.info({ eventId, accountName, eventType }, 'Attempting to log auth event');
      
      await new Promise((resolve, reject) => {
        connection.execute({
          sqlText: query,
          binds: [
            eventId,
            accountName,
            eventType,
            errorMessage || null,
            null, // source_ip
            null, // user_agent
            metadata?.connectionId || null // connection_id from metadata
          ] as any[],
          complete: (err: any, stmt: any, rows: any) => {
            if (err) {
              logger.warn({ error: err, accountName, eventType, query }, 'Failed to log auth event');
              resolve(null); // Don't fail on logging errors
            } else {
              logger.info({ accountName, eventType, success, eventId, rowCount: stmt?.getNumRowsAffected?.() }, 'Auth event logged successfully');
              resolve(null);
            }
          }
        });
      });
    } else {
      logger.debug({ accountName, eventType }, 'No connection available for logging auth event');
    }
  } catch (error) {
    logger.warn({ error, accountName, eventType }, 'Error logging auth event');
  }
}

export interface ConnectionPool {
  account: AccountConfig;
  connections: snowflake.Connection[];
  activeConnections: Set<snowflake.Connection>;
  healthyConnections: Set<snowflake.Connection>;
  lastHealthCheck: number;
  totalCreated: number;
  totalDestroyed: number;
  maxSize: number;
}

export interface ConnectionStats {
  accountName: string;
  totalConnections: number;
  activeConnections: number;
  healthyConnections: number;
  idleConnections: number;
  lastHealthCheck: number;
  totalCreated: number;
  totalDestroyed: number;
  maxSize: number;
}

export interface ConnectionManagerConfig {
  minPoolSize: number;
  maxPoolSize: number;
  connectionTimeout: number;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  maxIdleTime: number;
  retryAttempts: number;
  retryDelayMs: number;
}

export class ConnectionManager extends EventEmitter {
  private config: ConnectionManagerConfig;
  private credentialVault: CredentialVault;
  private circuitBreaker: AuthCircuitBreaker;
  private pools: Map<string, ConnectionPool> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isInitialized = false;

  constructor(
    credentialVault: CredentialVault,
    circuitBreaker: AuthCircuitBreaker,
    config: Partial<ConnectionManagerConfig> = {}
  ) {
    super();

    this.credentialVault = credentialVault;
    this.circuitBreaker = circuitBreaker;
    
    this.config = {
      minPoolSize: config.minPoolSize || 2,
      maxPoolSize: config.maxPoolSize || 15,
      connectionTimeout: config.connectionTimeout || 10000,
      healthCheckInterval: config.healthCheckInterval || 30000,
      healthCheckTimeout: config.healthCheckTimeout || 5000,
      maxIdleTime: config.maxIdleTime || 600000, // 10 minutes
      retryAttempts: config.retryAttempts || 3,
      retryDelayMs: config.retryDelayMs || 1000,
    };

    logger.info({ config: this.config }, 'Connection manager created');
  }

  /**
   * Initialize connection pools for all active accounts
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Connection manager already initialized');
      return;
    }

    logger.info('Initializing connection manager');

    // Initialize pools for all active accounts
    const activeAccounts = this.credentialVault.getActiveAccounts();
    
    for (const account of activeAccounts) {
      try {
        await this.initializePool(account);
      } catch (error) {
        logger.error({
          error,
          username: account.username,
        }, 'Failed to initialize pool for account');
        
        // Record failure but don't fail entire initialization
        await this.circuitBreaker.recordFailure(
          account.username,
          `Pool initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Start health check interval
    this.startHealthChecks();
    
    this.isInitialized = true;
    logger.info({ totalPools: this.pools.size }, 'Connection manager initialized');
  }

  /**
   * Get a healthy connection from any available account
   */
  async getConnection(preferredAccount?: string): Promise<{
    connection: snowflake.Connection;
    account: AccountConfig;
  }> {
    if (!this.isInitialized) {
      throw new Error('Connection manager not initialized');
    }

    // Try preferred account first if specified and available
    if (preferredAccount) {
      const preferredConn = await this.getConnectionFromAccount(preferredAccount);
      if (preferredConn) {
        return preferredConn;
      }
    }

    // Get next available account from credential vault
    const account = this.credentialVault.getNextAccount();
    if (!account) {
      throw new Error('No available accounts for connection');
    }

    // Check circuit breaker
    if (!this.circuitBreaker.canExecute(account.username)) {
      logger.warn({
        username: account.username,
        circuitState: this.circuitBreaker.getAccountMetrics(account.username).state,
      }, 'Circuit breaker preventing connection attempt');
      
      // Log circuit breaker blocking
      const pool = this.pools.get(account.username);
      if (pool && pool.connections.length > 0) {
        await logAuthEvent(
          pool.connections[0],
          account.username,
          'circuit_breaker_blocked',
          false,
          'Circuit breaker is open',
          { state: this.circuitBreaker.getAccountMetrics(account.username).state }
        );
      }
      
      throw new Error(`Circuit breaker open for account ${account.username}`);
    }

    try {
      const result = await this.getConnectionFromAccount(account.username);
      if (result) {
        // Log successful failover if this wasn't the preferred account
        if (preferredAccount && preferredAccount !== account.username) {
          await logAuthEvent(
            result.connection,
            account.username,
            'failover_success',
            true,
            undefined,
            { from: preferredAccount, to: account.username }
          );
        }
        return result;
      }
      throw new Error('No healthy connections available');
    } catch (error) {
      logger.error({
        error,
        username: account.username,
      }, 'Failed to get connection from account');
      
      // Log failover failure
      const pool = this.pools.get(account.username);
      if (pool && pool.connections.length > 0) {
        await logAuthEvent(
          pool.connections[0],
          account.username,
          'failover_failed',
          false,
          error instanceof Error ? error.message : 'Unknown error',
          { attemptedAccount: account.username }
        );
      }
      
      await this.circuitBreaker.recordFailure(
        account.username,
        error instanceof Error ? error.message : 'Unknown error'
      );
      
      throw error;
    }
  }

  /**
   * Release a connection back to its pool
   */
  async releaseConnection(connection: snowflake.Connection): Promise<void> {
    for (const pool of this.pools.values()) {
      if (pool.activeConnections.has(connection)) {
        pool.activeConnections.delete(connection);
        logger.debug({
          username: pool.account.username,
          activeCount: pool.activeConnections.size,
          totalCount: pool.connections.length,
        }, 'Connection released');
        
        this.emit('connectionReleased', { 
          account: pool.account.username, 
          connection 
        });
        return;
      }
    }
    
    logger.warn('Attempted to release unknown connection');
  }

  /**
   * Get connection statistics for all pools
   */
  getStats(): ConnectionStats[] {
    return Array.from(this.pools.values()).map(pool => ({
      accountName: pool.account.username,
      totalConnections: pool.connections.length,
      activeConnections: pool.activeConnections.size,
      healthyConnections: pool.healthyConnections.size,
      idleConnections: pool.connections.length - pool.activeConnections.size,
      lastHealthCheck: pool.lastHealthCheck,
      totalCreated: pool.totalCreated,
      totalDestroyed: pool.totalDestroyed,
      maxSize: pool.maxSize,
    }));
  }

  /**
   * Force refresh of connection pools
   */
  async refreshPools(): Promise<void> {
    logger.info('Refreshing connection pools');
    
    const activeAccounts = this.credentialVault.getActiveAccounts();
    const currentPools = new Set(this.pools.keys());
    const activeUsernames = new Set(activeAccounts.map(acc => acc.username));

    // Remove pools for inactive accounts
    for (const username of currentPools) {
      if (!activeUsernames.has(username)) {
        await this.destroyPool(username);
      }
    }

    // Add pools for new active accounts
    for (const account of activeAccounts) {
      if (!this.pools.has(account.username)) {
        try {
          await this.initializePool(account);
        } catch (error) {
          logger.error({
            error,
            username: account.username,
          }, 'Failed to initialize new pool');
        }
      }
    }
  }

  /**
   * Destroy all connection pools and cleanup
   */
  async destroy(): Promise<void> {
    logger.info('Destroying connection manager');

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Destroy all pools
    const destroyPromises = Array.from(this.pools.keys()).map(username => 
      this.destroyPool(username)
    );
    
    await Promise.all(destroyPromises);
    
    this.pools.clear();
    this.isInitialized = false;
    
    this.removeAllListeners();
    logger.info('Connection manager destroyed');
  }

  // Private methods

  private async getConnectionFromAccount(username: string): Promise<{
    connection: snowflake.Connection;
    account: AccountConfig;
  } | null> {
    const pool = this.pools.get(username);
    if (!pool) {
      logger.warn({ username }, 'No pool found for account');
      return null;
    }

    // Find an available healthy connection
    for (const conn of pool.connections) {
      if (!pool.activeConnections.has(conn) && pool.healthyConnections.has(conn)) {
        pool.activeConnections.add(conn);
        
        logger.debug({
          username,
          activeCount: pool.activeConnections.size,
          totalCount: pool.connections.length,
        }, 'Connection acquired from pool');
        
        this.emit('connectionAcquired', { 
          account: username, 
          connection: conn 
        });
        
        return { connection: conn, account: pool.account };
      }
    }

    // No available connections, try to create new one if under limit
    if (pool.connections.length < pool.maxSize) {
      try {
        const newConnection = await this.createConnection(pool.account);
        pool.connections.push(newConnection);
        pool.healthyConnections.add(newConnection);
        pool.activeConnections.add(newConnection);
        pool.totalCreated++;
        
        // Log successful connection creation
        await logAuthEvent(
          newConnection,
          username,
          'connection_created',
          true,
          undefined,
          { poolSize: pool.connections.length, maxSize: pool.maxSize }
        );
        
        logger.info({
          username,
          totalConnections: pool.connections.length,
          maxSize: pool.maxSize,
        }, 'Created new connection for pool');
        
        this.emit('connectionCreated', { 
          account: username, 
          connection: newConnection 
        });
        
        return { connection: newConnection, account: pool.account };
      } catch (error) {
        // Log connection failure
        await logAuthEvent(
          null,
          username,
          'connection_failed',
          false,
          error instanceof Error ? error.message : 'Unknown error',
          { poolSize: pool.connections.length }
        );
        
        logger.error({
          error,
          username,
        }, 'Failed to create new connection');
        throw error;
      }
    }

    logger.warn({
      username,
      activeConnections: pool.activeConnections.size,
      totalConnections: pool.connections.length,
      maxSize: pool.maxSize,
    }, 'No available connections and pool is at max size');
    
    return null;
  }

  private async initializePool(account: AccountConfig): Promise<void> {
    logger.info({ username: account.username }, 'Initializing connection pool');

    const pool: ConnectionPool = {
      account,
      connections: [],
      activeConnections: new Set(),
      healthyConnections: new Set(),
      lastHealthCheck: Date.now(),
      totalCreated: 0,
      totalDestroyed: 0,
      maxSize: Math.min(account.maxConnections || this.config.maxPoolSize, this.config.maxPoolSize),
    };

    // Create minimum number of connections
    const minConnections = Math.min(this.config.minPoolSize, pool.maxSize);
    const connectionPromises: Promise<snowflake.Connection>[] = [];

    for (let i = 0; i < minConnections; i++) {
      connectionPromises.push(this.createConnection(account));
    }

    try {
      const connections = await Promise.allSettled(connectionPromises);
      
      for (const result of connections) {
        if (result.status === 'fulfilled') {
          pool.connections.push(result.value);
          pool.healthyConnections.add(result.value);
          pool.totalCreated++;
        } else {
          logger.error({
            error: result.reason,
            username: account.username,
          }, 'Failed to create initial connection');
        }
      }

      if (pool.connections.length === 0) {
        throw new Error('Failed to create any initial connections');
      }

      this.pools.set(account.username, pool);
      
      logger.info({
        username: account.username,
        createdConnections: pool.connections.length,
        requestedConnections: minConnections,
      }, 'Connection pool initialized');

      // Record success if we got at least one connection
      await this.circuitBreaker.recordSuccess(account.username);
      
    } catch (error) {
      logger.error({
        error,
        username: account.username,
      }, 'Failed to initialize connection pool');
      throw error;
    }
  }

  private async createConnection(account: AccountConfig): Promise<snowflake.Connection> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.config.connectionTimeout}ms`));
      }, this.config.connectionTimeout);

      const connection = snowflake.createConnection({
        account: account.account,
        username: account.username,
        password: account.password,
        warehouse: account.warehouse,
        database: account.database,
        schema: account.schema,
        role: account.role,
        clientSessionKeepAlive: true,
        clientSessionKeepAliveHeartbeatFrequency: 300, // 5 minutes
        timeout: this.config.connectionTimeout,
        jsTreatIntegerAsBigInt: false,
      });

      connection.connect((err) => {
        clearTimeout(timeout);
        
        if (err) {
          logger.error({
            error: err,
            username: account.username,
          }, 'Failed to create Snowflake connection');
          reject(err);
        } else {
          logger.debug({
            username: account.username,
          }, 'Snowflake connection created successfully');
          resolve(connection);
        }
      });
    });
  }

  private async destroyPool(username: string): Promise<void> {
    const pool = this.pools.get(username);
    if (!pool) return;

    logger.info({
      username,
      totalConnections: pool.connections.length,
    }, 'Destroying connection pool');

    // Close all connections
    const destroyPromises = pool.connections.map(conn => 
      this.destroyConnection(conn)
    );

    await Promise.allSettled(destroyPromises);
    
    pool.totalDestroyed += pool.connections.length;
    this.pools.delete(username);
    
    logger.info({ username }, 'Connection pool destroyed');
  }

  private async destroyConnection(connection: snowflake.Connection): Promise<void> {
    return new Promise<void>((resolve) => {
      connection.destroy((err) => {
        if (err) {
          logger.warn({ error: err }, 'Error destroying connection');
        }
        resolve();
      });
    });
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.healthCheckInterval);

    logger.debug({
      intervalMs: this.config.healthCheckInterval,
    }, 'Health check interval started');
  }

  private async performHealthChecks(): Promise<void> {
    const healthCheckPromises = Array.from(this.pools.values()).map(pool =>
      this.checkPoolHealth(pool)
    );

    await Promise.allSettled(healthCheckPromises);
  }

  private async checkPoolHealth(pool: ConnectionPool): Promise<void> {
    const now = Date.now();
    pool.lastHealthCheck = now;
    
    const healthCheckPromises = pool.connections.map(async (conn) => {
      try {
        // Simple health check query
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Health check timeout'));
          }, this.config.healthCheckTimeout);

          conn.execute({
            sqlText: 'SELECT 1 as health_check',
            complete: (err: any) => {
              clearTimeout(timeout);
              if (err) reject(err);
              else resolve();
            },
          });
        });

        // Connection is healthy
        pool.healthyConnections.add(conn);
      } catch (error) {
        // Connection is unhealthy
        pool.healthyConnections.delete(conn);
        pool.activeConnections.delete(conn);
        
        logger.warn({
          error,
          username: pool.account.username,
        }, 'Connection failed health check');

        this.emit('connectionUnhealthy', { 
          account: pool.account.username, 
          connection: conn,
          error 
        });

        // Remove and destroy unhealthy connection
        const index = pool.connections.indexOf(conn);
        if (index > -1) {
          pool.connections.splice(index, 1);
          pool.totalDestroyed++;
          await this.destroyConnection(conn);
        }
      }
    });

    await Promise.allSettled(healthCheckPromises);

    // Ensure minimum pool size by creating new connections if needed
    const minSize = Math.min(this.config.minPoolSize, pool.maxSize);
    if (pool.connections.length < minSize) {
      const connectionsNeeded = minSize - pool.connections.length;
      
      try {
        const newConnections = await Promise.allSettled(
          Array(connectionsNeeded).fill(0).map(() => this.createConnection(pool.account))
        );

        for (const result of newConnections) {
          if (result.status === 'fulfilled') {
            pool.connections.push(result.value);
            pool.healthyConnections.add(result.value);
            pool.totalCreated++;
          }
        }
      } catch (error) {
        logger.error({
          error,
          username: pool.account.username,
        }, 'Failed to replenish connection pool during health check');
      }
    }

    logger.debug({
      username: pool.account.username,
      totalConnections: pool.connections.length,
      healthyConnections: pool.healthyConnections.size,
      activeConnections: pool.activeConnections.size,
    }, 'Pool health check completed');
  }
}