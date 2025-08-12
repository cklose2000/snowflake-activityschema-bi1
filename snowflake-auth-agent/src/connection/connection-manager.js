/**
 * Smart Connection Manager for Snowflake
 *
 * Manages connection pools per account with intelligent failover,
 * connection reuse, and health monitoring to minimize authentication attempts.
 */
import snowflake from 'snowflake-sdk';
import pino from 'pino';
import { EventEmitter } from 'events';
const logger = pino({ name: 'connection-manager' });
export class ConnectionManager extends EventEmitter {
    config;
    credentialVault;
    circuitBreaker;
    pools = new Map();
    healthCheckInterval = null;
    isInitialized = false;
    constructor(credentialVault, circuitBreaker, config = {}) {
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
    async initialize() {
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
            }
            catch (error) {
                logger.error({
                    error,
                    username: account.username,
                }, 'Failed to initialize pool for account');
                // Record failure but don't fail entire initialization
                await this.circuitBreaker.recordFailure(account.username, `Pool initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    async getConnection(preferredAccount) {
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
            throw new Error(`Circuit breaker open for account ${account.username}`);
        }
        try {
            const result = await this.getConnectionFromAccount(account.username);
            if (result) {
                return result;
            }
            throw new Error('No healthy connections available');
        }
        catch (error) {
            logger.error({
                error,
                username: account.username,
            }, 'Failed to get connection from account');
            await this.circuitBreaker.recordFailure(account.username, error instanceof Error ? error.message : 'Unknown error');
            throw error;
        }
    }
    /**
     * Release a connection back to its pool
     */
    async releaseConnection(connection) {
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
    getStats() {
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
    async refreshPools() {
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
                }
                catch (error) {
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
    async destroy() {
        logger.info('Destroying connection manager');
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        // Destroy all pools
        const destroyPromises = Array.from(this.pools.keys()).map(username => this.destroyPool(username));
        await Promise.all(destroyPromises);
        this.pools.clear();
        this.isInitialized = false;
        this.removeAllListeners();
        logger.info('Connection manager destroyed');
    }
    // Private methods
    async getConnectionFromAccount(username) {
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
            }
            catch (error) {
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
    async initializePool(account) {
        logger.info({ username: account.username }, 'Initializing connection pool');
        const pool = {
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
        const connectionPromises = [];
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
                }
                else {
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
        }
        catch (error) {
            logger.error({
                error,
                username: account.username,
            }, 'Failed to initialize connection pool');
            throw error;
        }
    }
    async createConnection(account) {
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
                }
                else {
                    logger.debug({
                        username: account.username,
                    }, 'Snowflake connection created successfully');
                    resolve(connection);
                }
            });
        });
    }
    async destroyPool(username) {
        const pool = this.pools.get(username);
        if (!pool)
            return;
        logger.info({
            username,
            totalConnections: pool.connections.length,
        }, 'Destroying connection pool');
        // Close all connections
        const destroyPromises = pool.connections.map(conn => this.destroyConnection(conn));
        await Promise.allSettled(destroyPromises);
        pool.totalDestroyed += pool.connections.length;
        this.pools.delete(username);
        logger.info({ username }, 'Connection pool destroyed');
    }
    async destroyConnection(connection) {
        return new Promise((resolve) => {
            connection.destroy((err) => {
                if (err) {
                    logger.warn({ error: err }, 'Error destroying connection');
                }
                resolve();
            });
        });
    }
    startHealthChecks() {
        this.healthCheckInterval = setInterval(async () => {
            await this.performHealthChecks();
        }, this.config.healthCheckInterval);
        logger.debug({
            intervalMs: this.config.healthCheckInterval,
        }, 'Health check interval started');
    }
    async performHealthChecks() {
        const healthCheckPromises = Array.from(this.pools.values()).map(pool => this.checkPoolHealth(pool));
        await Promise.allSettled(healthCheckPromises);
    }
    async checkPoolHealth(pool) {
        const now = Date.now();
        pool.lastHealthCheck = now;
        const healthCheckPromises = pool.connections.map(async (conn) => {
            try {
                // Simple health check query
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Health check timeout'));
                    }, this.config.healthCheckTimeout);
                    conn.execute({
                        sqlText: 'SELECT 1 as health_check',
                        complete: (err) => {
                            clearTimeout(timeout);
                            if (err)
                                reject(err);
                            else
                                resolve();
                        },
                    });
                });
                // Connection is healthy
                pool.healthyConnections.add(conn);
            }
            catch (error) {
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
                const newConnections = await Promise.allSettled(Array(connectionsNeeded).fill(0).map(() => this.createConnection(pool.account)));
                for (const result of newConnections) {
                    if (result.status === 'fulfilled') {
                        pool.connections.push(result.value);
                        pool.healthyConnections.add(result.value);
                        pool.totalCreated++;
                    }
                }
            }
            catch (error) {
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
//# sourceMappingURL=connection-manager.js.map