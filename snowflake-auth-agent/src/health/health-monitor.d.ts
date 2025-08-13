/**
 * Health Monitor for Snowflake Authentication System
 *
 * Continuously monitors account health, detects lockouts,
 * and provides real-time status reporting.
 */
import { EventEmitter } from 'events';
import { CredentialVault } from '../credential/credential-vault';
import { AuthCircuitBreaker, CircuitState } from '../circuit-breaker/auth-circuit-breaker';
import { ConnectionManager } from '../connection/connection-manager';
export interface HealthStatus {
    overall: 'healthy' | 'degraded' | 'critical';
    lastCheck: number;
    accounts: AccountHealth[];
    summary: {
        total: number;
        healthy: number;
        degraded: number;
        critical: number;
        offline: number;
    };
    recommendations: string[];
}
export interface AccountHealth {
    username: string;
    priority: number;
    status: 'healthy' | 'degraded' | 'critical' | 'offline';
    healthScore: number;
    circuitState: CircuitState;
    isAvailable: boolean;
    connectionPool: {
        total: number;
        active: number;
        healthy: number;
        maxSize: number;
    };
    metrics: {
        totalAttempts: number;
        successRate: number;
        failureCount: number;
        lastSuccess?: number;
        lastFailure?: number;
        avgResponseTime?: number;
    };
    issues: string[];
}
export interface HealthAlert {
    level: 'info' | 'warning' | 'error' | 'critical';
    type: 'account_lockout' | 'circuit_open' | 'pool_exhausted' | 'auth_failure' | 'system_degraded';
    message: string;
    accountName?: string;
    timestamp: number;
    metadata?: Record<string, any>;
}
export interface HealthMonitorConfig {
    checkInterval: number;
    alertThreshold: {
        degradedHealthScore: number;
        criticalHealthScore: number;
        maxFailureRate: number;
        minAvailableAccounts: number;
    };
    responseTimeTracking: {
        enabled: boolean;
        windowSize: number;
    };
    alerting: {
        enabled: boolean;
        cooldownMs: number;
        maxAlertsPerHour: number;
    };
}
export declare class HealthMonitor extends EventEmitter {
    private config;
    private credentialVault;
    private circuitBreaker;
    private connectionManager;
    private monitorInterval;
    private lastHealthCheck;
    private alertHistory;
    private responseTimeHistory;
    private isRunning;
    constructor(credentialVault: CredentialVault, circuitBreaker: AuthCircuitBreaker, connectionManager: ConnectionManager, config?: Partial<HealthMonitorConfig>);
    /**
     * Start health monitoring
     */
    start(): void;
    /**
     * Stop health monitoring
     */
    stop(): void;
    /**
     * Get current health status
     */
    getHealthStatus(): Promise<HealthStatus>;
    /**
     * Get recent alerts
     */
    getRecentAlerts(hours?: number): HealthAlert[];
    /**
     * Record response time for performance tracking
     */
    recordResponseTime(accountName: string, responseTimeMs: number): void;
    /**
     * Force a health check (manual trigger)
     */
    forceHealthCheck(): Promise<HealthStatus>;
    /**
     * Cleanup resources
     */
    destroy(): void;
    private performHealthCheck;
    private assessAccountHealths;
    private assessAccountHealth;
    private calculateSummary;
    private determineOverallStatus;
    private generateRecommendations;
    private analyzeHealthAndAlert;
    private emitAlert;
    private setupEventListeners;
}
//# sourceMappingURL=health-monitor.d.ts.map