/**
 * Smart Connection Manager for Snowflake
 *
 * Manages connection pools per account with intelligent failover,
 * connection reuse, and health monitoring to minimize authentication attempts.
 */
import snowflake from 'snowflake-sdk';
import { EventEmitter } from 'events';
import { CredentialVault, AccountConfig } from '../credential/credential-vault.js';
import { AuthCircuitBreaker } from '../circuit-breaker/auth-circuit-breaker.js';
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
export declare class ConnectionManager extends EventEmitter {
    private config;
    private credentialVault;
    private circuitBreaker;
    private pools;
    private healthCheckInterval;
    private isInitialized;
    constructor(credentialVault: CredentialVault, circuitBreaker: AuthCircuitBreaker, config?: Partial<ConnectionManagerConfig>);
    /**
     * Initialize connection pools for all active accounts
     */
    initialize(): Promise<void>;
    /**
     * Get a healthy connection from any available account
     */
    getConnection(preferredAccount?: string): Promise<{
        connection: snowflake.Connection;
        account: AccountConfig;
    }>;
    /**
     * Release a connection back to its pool
     */
    releaseConnection(connection: snowflake.Connection): Promise<void>;
    /**
     * Get connection statistics for all pools
     */
    getStats(): ConnectionStats[];
    /**
     * Force refresh of connection pools
     */
    refreshPools(): Promise<void>;
    /**
     * Destroy all connection pools and cleanup
     */
    destroy(): Promise<void>;
    private getConnectionFromAccount;
    private initializePool;
    private createConnection;
    private destroyPool;
    private destroyConnection;
    private startHealthChecks;
    private performHealthChecks;
    private checkPoolHealth;
}
//# sourceMappingURL=connection-manager.d.ts.map