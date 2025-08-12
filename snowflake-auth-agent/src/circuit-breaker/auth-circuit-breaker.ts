/**
 * Authentication Circuit Breaker
 * 
 * Prevents cascading failures by tracking authentication attempts,
 * implementing exponential backoff, and managing account failover.
 */

import pino from 'pino';
import { EventEmitter } from 'events';

const logger = pino({ name: 'auth-circuit-breaker' });

export enum CircuitState {
  CLOSED = 'closed',     // Normal operation
  OPEN = 'open',         // Failing, don't attempt
  HALF_OPEN = 'half-open' // Testing if recovered
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening
  recoveryTimeoutMs: number;     // Time before attempting recovery
  successThreshold: number;      // Successes needed to close circuit
  timeWindowMs: number;          // Sliding window for failure counting
  maxBackoffMs: number;          // Maximum backoff time
  backoffMultiplier: number;     // Exponential backoff multiplier
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

export class AuthCircuitBreaker extends EventEmitter {
  private config: CircuitBreakerConfig;
  private metrics: Map<string, CircuitMetrics> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    
    this.config = {
      failureThreshold: config.failureThreshold || 3,
      recoveryTimeoutMs: config.recoveryTimeoutMs || 300000, // 5 minutes
      successThreshold: config.successThreshold || 1,
      timeWindowMs: config.timeWindowMs || 600000, // 10 minutes
      maxBackoffMs: config.maxBackoffMs || 300000, // 5 minutes
      backoffMultiplier: config.backoffMultiplier || 2,
    };

    // Clean up old metrics every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldMetrics();
    }, 60000);

    logger.info({ config: this.config }, 'Circuit breaker initialized');
  }

  /**
   * Check if operation should be allowed for given account
   */
  canExecute(accountName: string): boolean {
    const metrics = this.getMetrics(accountName);
    const now = Date.now();

    switch (metrics.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if recovery timeout has passed
        if (metrics.nextRetryTime && now >= metrics.nextRetryTime) {
          this.transitionToHalfOpen(accountName);
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        return true;

      default:
        return false;
    }
  }

  /**
   * Record successful authentication
   */
  recordSuccess(accountName: string): void {
    const metrics = this.getMetrics(accountName);
    const now = Date.now();

    metrics.successCount++;
    metrics.totalSuccesses++;
    metrics.totalAttempts++;
    metrics.lastSuccessTime = now;

    // Clear failures in the time window
    this.clearOldFailures(metrics, now);

    switch (metrics.state) {
      case CircuitState.HALF_OPEN:
        if (metrics.successCount >= this.config.successThreshold) {
          this.transitionToClosed(accountName);
        }
        break;

      case CircuitState.OPEN:
        // Success from open state means we should try half-open
        this.transitionToHalfOpen(accountName);
        break;

      case CircuitState.CLOSED:
        // Reset failure count on success
        metrics.failureCount = 0;
        break;
    }

    logger.debug({
      accountName,
      state: metrics.state,
      successCount: metrics.successCount,
      failureCount: metrics.failureCount,
    }, 'Authentication success recorded');

    this.emit('success', { accountName, metrics });
  }

  /**
   * Record authentication failure
   */
  recordFailure(accountName: string, error: string): void {
    const metrics = this.getMetrics(accountName);
    const now = Date.now();

    metrics.failureCount++;
    metrics.totalFailures++;
    metrics.totalAttempts++;
    metrics.lastFailureTime = now;

    // Clear old failures outside the time window
    this.clearOldFailures(metrics, now);

    switch (metrics.state) {
      case CircuitState.CLOSED:
      case CircuitState.HALF_OPEN:
        if (metrics.failureCount >= this.config.failureThreshold) {
          this.transitionToOpen(accountName);
        }
        break;

      case CircuitState.OPEN:
        // Calculate exponential backoff
        this.calculateNextRetryTime(metrics);
        break;
    }

    logger.warn({
      accountName,
      error,
      state: metrics.state,
      failureCount: metrics.failureCount,
      threshold: this.config.failureThreshold,
      nextRetryTime: metrics.nextRetryTime,
    }, 'Authentication failure recorded');

    this.emit('failure', { accountName, error, metrics });
  }

  /**
   * Get current metrics for an account
   */
  getAccountMetrics(accountName: string): CircuitMetrics {
    return { ...this.getMetrics(accountName) };
  }

  /**
   * Get metrics for all accounts
   */
  getAllMetrics(): Record<string, CircuitMetrics> {
    const result: Record<string, CircuitMetrics> = {};
    for (const [accountName, metrics] of this.metrics) {
      result[accountName] = { ...metrics };
    }
    return result;
  }

  /**
   * Manually reset circuit for an account (admin operation)
   */
  reset(accountName: string): void {
    const metrics = this.getMetrics(accountName);
    
    metrics.state = CircuitState.CLOSED;
    metrics.failureCount = 0;
    metrics.successCount = 0;
    metrics.nextRetryTime = undefined;

    logger.info({ accountName }, 'Circuit breaker manually reset');
    this.emit('reset', { accountName, metrics });
  }

  /**
   * Force circuit to open state (admin operation)
   */
  forceOpen(accountName: string, reason: string): void {
    const metrics = this.getMetrics(accountName);
    
    metrics.state = CircuitState.OPEN;
    metrics.nextRetryTime = Date.now() + this.config.recoveryTimeoutMs;

    logger.warn({ accountName, reason }, 'Circuit breaker forced to open state');
    this.emit('forceOpen', { accountName, reason, metrics });
  }

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
  } {
    const accounts = [];
    let healthy = 0;
    let degraded = 0;
    let failing = 0;

    for (const [accountName, metrics] of this.metrics) {
      let healthScore = 100;
      let isAvailable = this.canExecute(accountName);

      // Calculate health score based on recent performance
      if (metrics.totalAttempts > 0) {
        const successRate = metrics.totalSuccesses / metrics.totalAttempts;
        healthScore = Math.round(successRate * 100);
      }

      // Adjust for circuit state
      if (metrics.state === CircuitState.OPEN) {
        healthScore = Math.min(healthScore, 25);
        failing++;
      } else if (metrics.state === CircuitState.HALF_OPEN) {
        healthScore = Math.min(healthScore, 50);
        degraded++;
      } else {
        if (healthScore > 80) healthy++;
        else if (healthScore > 50) degraded++;
        else failing++;
      }

      accounts.push({
        name: accountName,
        state: metrics.state,
        healthScore,
        isAvailable,
      });
    }

    return {
      totalAccounts: this.metrics.size,
      healthy,
      degraded,
      failing,
      accounts: accounts.sort((a, b) => b.healthScore - a.healthScore),
    };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.metrics.clear();
    this.removeAllListeners();
    
    logger.info('Circuit breaker destroyed');
  }

  // Private methods

  private getMetrics(accountName: string): CircuitMetrics {
    if (!this.metrics.has(accountName)) {
      this.metrics.set(accountName, {
        state: CircuitState.CLOSED,
        failureCount: 0,
        successCount: 0,
        totalAttempts: 0,
        totalFailures: 0,
        totalSuccesses: 0,
      });
    }
    return this.metrics.get(accountName)!;
  }

  private transitionToClosed(accountName: string): void {
    const metrics = this.getMetrics(accountName);
    metrics.state = CircuitState.CLOSED;
    metrics.failureCount = 0;
    metrics.successCount = 0;
    metrics.nextRetryTime = undefined;

    logger.info({ accountName }, 'Circuit breaker transitioned to CLOSED');
    this.emit('stateChange', { accountName, newState: CircuitState.CLOSED, metrics });
  }

  private transitionToOpen(accountName: string): void {
    const metrics = this.getMetrics(accountName);
    metrics.state = CircuitState.OPEN;
    metrics.successCount = 0;
    
    this.calculateNextRetryTime(metrics);

    logger.warn({ 
      accountName, 
      failureCount: metrics.failureCount,
      nextRetryTime: metrics.nextRetryTime 
    }, 'Circuit breaker transitioned to OPEN');
    
    this.emit('stateChange', { accountName, newState: CircuitState.OPEN, metrics });
  }

  private transitionToHalfOpen(accountName: string): void {
    const metrics = this.getMetrics(accountName);
    metrics.state = CircuitState.HALF_OPEN;
    metrics.successCount = 0;
    metrics.nextRetryTime = undefined;

    logger.info({ accountName }, 'Circuit breaker transitioned to HALF_OPEN');
    this.emit('stateChange', { accountName, newState: CircuitState.HALF_OPEN, metrics });
  }

  private calculateNextRetryTime(metrics: CircuitMetrics): void {
    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.config.recoveryTimeoutMs * Math.pow(this.config.backoffMultiplier, metrics.failureCount - this.config.failureThreshold),
      this.config.maxBackoffMs
    );
    
    // Add jitter (±20%)
    const jitter = baseDelay * 0.2 * (Math.random() - 0.5);
    const delay = Math.max(1000, baseDelay + jitter); // Minimum 1 second
    
    metrics.nextRetryTime = Date.now() + delay;
  }

  private clearOldFailures(metrics: CircuitMetrics, now: number): void {
    // In a more sophisticated implementation, we would track individual failure timestamps
    // For now, we'll reset if enough time has passed since last failure
    if (metrics.lastFailureTime && (now - metrics.lastFailureTime) > this.config.timeWindowMs) {
      metrics.failureCount = 0;
    }
  }

  private cleanupOldMetrics(): void {
    const now = Date.now();
    const cutoffTime = now - (this.config.timeWindowMs * 2); // Keep metrics for 2x window

    for (const [accountName, metrics] of this.metrics) {
      const lastActivity = Math.max(
        metrics.lastFailureTime || 0,
        metrics.lastSuccessTime || 0
      );

      // Remove metrics for accounts with no recent activity and closed circuits
      if (lastActivity < cutoffTime && metrics.state === CircuitState.CLOSED) {
        this.metrics.delete(accountName);
        logger.debug({ accountName }, 'Cleaned up old circuit breaker metrics');
      }
    }
  }
}