/**
 * Authentication Circuit Breaker
 *
 * Prevents cascading failures by tracking authentication attempts,
 * implementing exponential backoff, and managing account failover.
 */
import { EventEmitter } from 'events';
export declare enum CircuitState {
    CLOSED = "closed",// Normal operation
    OPEN = "open",// Failing, don't attempt
    HALF_OPEN = "half-open"
}
export interface CircuitBreakerConfig {
    failureThreshold: number;
    recoveryTimeoutMs: number;
    successThreshold: number;
    timeWindowMs: number;
    maxBackoffMs: number;
    backoffMultiplier: number;
}
export interface CircuitMetrics {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime?: number;
    lastSuccessTime?: number;
    nextRetryTime?: number;
    totalAttempts: number;
    totalFailures: number;
    totalSuccesses: number;
}
export declare class AuthCircuitBreaker extends EventEmitter {
    private config;
    private metrics;
    private cleanupInterval;
    constructor(config?: Partial<CircuitBreakerConfig>);
    /**
     * Check if operation should be allowed for given account
     */
    canExecute(accountName: string): boolean;
    /**
     * Record successful authentication
     */
    recordSuccess(accountName: string): void;
    /**
     * Record authentication failure
     */
    recordFailure(accountName: string, error: string): void;
    /**
     * Get current metrics for an account
     */
    getAccountMetrics(accountName: string): CircuitMetrics;
    /**
     * Get metrics for all accounts
     */
    getAllMetrics(): Record<string, CircuitMetrics>;
    /**
     * Manually reset circuit for an account (admin operation)
     */
    reset(accountName: string): void;
    /**
     * Force circuit to open state (admin operation)
     */
    forceOpen(accountName: string, reason: string): void;
    /**
     * Get health summary for all accounts
     */
    getHealthSummary(): {
        totalAccounts: number;
        healthy: number;
        degraded: number;
        failing: number;
        accounts: Array<{
            name: string;
            state: CircuitState;
            healthScore: number;
            isAvailable: boolean;
        }>;
    };
    /**
     * Cleanup resources
     */
    destroy(): void;
    private getMetrics;
    private transitionToClosed;
    private transitionToOpen;
    private transitionToHalfOpen;
    private calculateNextRetryTime;
    private clearOldFailures;
    private cleanupOldMetrics;
}
//# sourceMappingURL=auth-circuit-breaker.d.ts.map