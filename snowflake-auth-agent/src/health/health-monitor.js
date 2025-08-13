"use strict";
/**
 * Health Monitor for Snowflake Authentication System
 *
 * Continuously monitors account health, detects lockouts,
 * and provides real-time status reporting.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthMonitor = void 0;
const pino_1 = __importDefault(require("pino"));
const events_1 = require("events");
const auth_circuit_breaker_1 = require("../circuit-breaker/auth-circuit-breaker");
const logger = (0, pino_1.default)({ name: 'health-monitor' });
class HealthMonitor extends events_1.EventEmitter {
    config;
    credentialVault;
    circuitBreaker;
    connectionManager;
    monitorInterval = null;
    lastHealthCheck = 0;
    alertHistory = new Map();
    responseTimeHistory = new Map();
    isRunning = false;
    constructor(credentialVault, circuitBreaker, connectionManager, config = {}) {
        super();
        this.credentialVault = credentialVault;
        this.circuitBreaker = circuitBreaker;
        this.connectionManager = connectionManager;
        this.config = {
            checkInterval: config.checkInterval || 30000, // 30 seconds
            alertThreshold: {
                degradedHealthScore: config.alertThreshold?.degradedHealthScore || 70,
                criticalHealthScore: config.alertThreshold?.criticalHealthScore || 30,
                maxFailureRate: config.alertThreshold?.maxFailureRate || 0.2, // 20%
                minAvailableAccounts: config.alertThreshold?.minAvailableAccounts || 1,
                ...config.alertThreshold,
            },
            responseTimeTracking: {
                enabled: config.responseTimeTracking?.enabled ?? true,
                windowSize: config.responseTimeTracking?.windowSize || 100,
                ...config.responseTimeTracking,
            },
            alerting: {
                enabled: config.alerting?.enabled ?? true,
                cooldownMs: config.alerting?.cooldownMs || 300000, // 5 minutes
                maxAlertsPerHour: config.alerting?.maxAlertsPerHour || 10,
                ...config.alerting,
            },
        };
        this.setupEventListeners();
        logger.info({ config: this.config }, 'Health monitor created');
    }
    /**
     * Start health monitoring
     */
    start() {
        if (this.isRunning) {
            logger.warn('Health monitor already running');
            return;
        }
        logger.info('Starting health monitor');
        // Perform initial health check
        this.performHealthCheck().catch(error => {
            logger.error({ error }, 'Initial health check failed');
        });
        // Start periodic health checks
        this.monitorInterval = setInterval(async () => {
            try {
                await this.performHealthCheck();
            }
            catch (error) {
                logger.error({ error }, 'Health check failed');
                this.emitAlert('error', 'system_degraded', 'Health check system failure', undefined, { error });
            }
        }, this.config.checkInterval);
        this.isRunning = true;
        logger.info({ intervalMs: this.config.checkInterval }, 'Health monitor started');
    }
    /**
     * Stop health monitoring
     */
    stop() {
        if (!this.isRunning) {
            logger.warn('Health monitor not running');
            return;
        }
        logger.info('Stopping health monitor');
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        this.isRunning = false;
        logger.info('Health monitor stopped');
    }
    /**
     * Get current health status
     */
    async getHealthStatus() {
        const accountHealths = await this.assessAccountHealths();
        const summary = this.calculateSummary(accountHealths);
        const overallStatus = this.determineOverallStatus(summary);
        const recommendations = this.generateRecommendations(accountHealths, summary);
        return {
            overall: overallStatus,
            lastCheck: this.lastHealthCheck,
            accounts: accountHealths,
            summary,
            recommendations,
        };
    }
    /**
     * Get recent alerts
     */
    getRecentAlerts(hours = 24) {
        const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
        const allAlerts = [];
        for (const alerts of this.alertHistory.values()) {
            allAlerts.push(...alerts.filter(alert => alert.timestamp >= cutoffTime));
        }
        return allAlerts.sort((a, b) => b.timestamp - a.timestamp);
    }
    /**
     * Record response time for performance tracking
     */
    recordResponseTime(accountName, responseTimeMs) {
        if (!this.config.responseTimeTracking.enabled)
            return;
        if (!this.responseTimeHistory.has(accountName)) {
            this.responseTimeHistory.set(accountName, []);
        }
        const history = this.responseTimeHistory.get(accountName);
        history.push(responseTimeMs);
        // Keep only recent measurements
        if (history.length > this.config.responseTimeTracking.windowSize) {
            history.shift();
        }
    }
    /**
     * Force a health check (manual trigger)
     */
    async forceHealthCheck() {
        logger.info('Performing forced health check');
        await this.performHealthCheck();
        return this.getHealthStatus();
    }
    /**
     * Cleanup resources
     */
    destroy() {
        this.stop();
        this.alertHistory.clear();
        this.responseTimeHistory.clear();
        this.removeAllListeners();
        logger.info('Health monitor destroyed');
    }
    // Private methods
    async performHealthCheck() {
        const startTime = Date.now();
        try {
            const healthStatus = await this.getHealthStatus();
            this.lastHealthCheck = Date.now();
            // Emit health status update
            this.emit('healthUpdate', healthStatus);
            // Check for issues and generate alerts
            await this.analyzeHealthAndAlert(healthStatus);
            const checkDuration = Date.now() - startTime;
            logger.debug({
                duration: checkDuration,
                overallStatus: healthStatus.overall,
                healthyAccounts: healthStatus.summary.healthy,
                totalAccounts: healthStatus.summary.total,
            }, 'Health check completed');
        }
        catch (error) {
            logger.error({ error }, 'Health check failed');
            this.emitAlert('error', 'system_degraded', 'Health monitoring system error', undefined, { error });
        }
    }
    async assessAccountHealths() {
        const accountConfigs = this.credentialVault.getAllAccounts();
        const circuitMetrics = this.circuitBreaker.getAllMetrics();
        const connectionStats = this.connectionManager.getStats();
        const healthAssessments = [];
        for (const account of accountConfigs) {
            const circuitMetric = circuitMetrics[account.username] || {
                state: auth_circuit_breaker_1.CircuitState.CLOSED,
                failureCount: 0,
                successCount: 0,
                totalAttempts: 0,
                totalFailures: 0,
                totalSuccesses: 0,
            };
            const connectionStat = connectionStats.find(stat => stat.accountName === account.username) || {
                accountName: account.username,
                totalConnections: 0,
                activeConnections: 0,
                healthyConnections: 0,
                idleConnections: 0,
                lastHealthCheck: 0,
                totalCreated: 0,
                totalDestroyed: 0,
                maxSize: account.maxConnections || 15,
            };
            const responseHistory = this.responseTimeHistory.get(account.username) || [];
            const avgResponseTime = responseHistory.length > 0
                ? responseHistory.reduce((sum, time) => sum + time, 0) / responseHistory.length
                : undefined;
            const healthAssessment = this.assessAccountHealth(account, circuitMetric, connectionStat, avgResponseTime);
            healthAssessments.push(healthAssessment);
        }
        return healthAssessments.sort((a, b) => a.priority - b.priority);
    }
    assessAccountHealth(account, circuitMetric, connectionStat, avgResponseTime) {
        const issues = [];
        let healthScore = 100;
        let status = 'healthy';
        // Check if account is active
        if (!account.isActive) {
            status = 'offline';
            healthScore = 0;
            issues.push('Account is disabled');
        }
        else {
            // Check circuit breaker state
            if (circuitMetric.state === auth_circuit_breaker_1.CircuitState.OPEN) {
                status = 'critical';
                healthScore = Math.min(healthScore, 20);
                issues.push('Circuit breaker is open');
            }
            else if (circuitMetric.state === auth_circuit_breaker_1.CircuitState.HALF_OPEN) {
                status = 'degraded';
                healthScore = Math.min(healthScore, 60);
                issues.push('Circuit breaker is half-open');
            }
            // Check failure rate
            if (circuitMetric.totalAttempts > 0) {
                const successRate = circuitMetric.totalSuccesses / circuitMetric.totalAttempts;
                if (successRate < 0.5) {
                    status = 'critical';
                    healthScore = Math.min(healthScore, 30);
                    issues.push(`Low success rate: ${Math.round(successRate * 100)}%`);
                }
                else if (successRate < 0.8) {
                    status = status === 'healthy' ? 'degraded' : status;
                    healthScore = Math.min(healthScore, 70);
                    issues.push(`Moderate success rate: ${Math.round(successRate * 100)}%`);
                }
            }
            // Check consecutive failures
            if (account.consecutiveFailures >= account.maxFailures) {
                status = 'critical';
                healthScore = Math.min(healthScore, 25);
                issues.push(`Too many consecutive failures: ${account.consecutiveFailures}`);
            }
            else if (account.consecutiveFailures > 0) {
                status = status === 'healthy' ? 'degraded' : status;
                healthScore = Math.min(healthScore, 80 - (account.consecutiveFailures * 20));
                issues.push(`${account.consecutiveFailures} consecutive failures`);
            }
            // Check cooldown status
            if (account.inCooldown) {
                status = status === 'healthy' ? 'degraded' : status;
                healthScore = Math.min(healthScore, 50);
                issues.push('Account in cooldown');
            }
            // Check connection pool health
            if (connectionStat.totalConnections === 0) {
                status = 'critical';
                healthScore = Math.min(healthScore, 10);
                issues.push('No connections in pool');
            }
            else {
                const healthyRatio = connectionStat.healthyConnections / connectionStat.totalConnections;
                if (healthyRatio < 0.3) {
                    status = 'critical';
                    healthScore = Math.min(healthScore, 40);
                    issues.push('Low healthy connection ratio');
                }
                else if (healthyRatio < 0.7) {
                    status = status === 'healthy' ? 'degraded' : status;
                    healthScore = Math.min(healthScore, 75);
                    issues.push('Moderate healthy connection ratio');
                }
            }
            // Check response time
            if (avgResponseTime && avgResponseTime > 5000) {
                status = status === 'healthy' ? 'degraded' : status;
                healthScore = Math.min(healthScore, 60);
                issues.push(`High average response time: ${Math.round(avgResponseTime)}ms`);
            }
        }
        const successRate = circuitMetric.totalAttempts > 0
            ? circuitMetric.totalSuccesses / circuitMetric.totalAttempts
            : 1;
        return {
            username: account.username,
            priority: account.priority,
            status,
            healthScore: Math.max(0, Math.round(healthScore)),
            circuitState: circuitMetric.state,
            isAvailable: this.circuitBreaker.canExecute(account.username) && account.isActive && !account.inCooldown,
            connectionPool: {
                total: connectionStat.totalConnections,
                active: connectionStat.activeConnections,
                healthy: connectionStat.healthyConnections,
                maxSize: connectionStat.maxSize,
            },
            metrics: {
                totalAttempts: circuitMetric.totalAttempts,
                successRate: Math.round(successRate * 100) / 100,
                failureCount: circuitMetric.totalFailures,
                lastSuccess: circuitMetric.lastSuccessTime,
                lastFailure: circuitMetric.lastFailureTime,
                avgResponseTime: avgResponseTime ? Math.round(avgResponseTime) : undefined,
            },
            issues,
        };
    }
    calculateSummary(accountHealths) {
        const summary = {
            total: accountHealths.length,
            healthy: 0,
            degraded: 0,
            critical: 0,
            offline: 0,
        };
        for (const account of accountHealths) {
            summary[account.status]++;
        }
        return summary;
    }
    determineOverallStatus(summary) {
        const availableAccounts = summary.healthy + summary.degraded;
        if (availableAccounts < this.config.alertThreshold.minAvailableAccounts) {
            return 'critical';
        }
        if (summary.critical > 0 || summary.healthy === 0) {
            return 'critical';
        }
        if (summary.degraded > summary.healthy) {
            return 'degraded';
        }
        return 'healthy';
    }
    generateRecommendations(accountHealths, summary) {
        const recommendations = [];
        // Critical issues
        if (summary.total - summary.offline < this.config.alertThreshold.minAvailableAccounts) {
            recommendations.push('URGENT: Too few available accounts. Enable backup accounts immediately.');
        }
        // Account-specific recommendations
        for (const account of accountHealths) {
            if (account.status === 'critical') {
                if (account.circuitState === auth_circuit_breaker_1.CircuitState.OPEN) {
                    recommendations.push(`Reset circuit breaker for ${account.username} or wait for automatic recovery.`);
                }
                if (account.connectionPool.healthy === 0 && account.connectionPool.total > 0) {
                    recommendations.push(`Restart connection pool for ${account.username}.`);
                }
            }
            if (account.issues.length > 0) {
                recommendations.push(`Address issues for ${account.username}: ${account.issues.join(', ')}`);
            }
        }
        // System-wide recommendations
        if (summary.degraded > summary.healthy) {
            recommendations.push('System is degraded. Consider adding more backup accounts.');
        }
        const avgHealthScore = accountHealths.reduce((sum, acc) => sum + acc.healthScore, 0) / accountHealths.length;
        if (avgHealthScore < this.config.alertThreshold.degradedHealthScore) {
            recommendations.push('Overall system health is poor. Review authentication configuration.');
        }
        return recommendations;
    }
    async analyzeHealthAndAlert(healthStatus) {
        // Overall system alerts
        if (healthStatus.overall === 'critical') {
            this.emitAlert('critical', 'system_degraded', `System is in critical state. Available accounts: ${healthStatus.summary.healthy + healthStatus.summary.degraded}/${healthStatus.summary.total}`, undefined, { healthStatus });
        }
        // Account-specific alerts
        for (const account of healthStatus.accounts) {
            if (account.status === 'critical' && account.isAvailable === false) {
                if (account.circuitState === auth_circuit_breaker_1.CircuitState.OPEN) {
                    this.emitAlert('error', 'circuit_open', `Circuit breaker open for account ${account.username}`, account.username, { account });
                }
                if (account.connectionPool.healthy === 0) {
                    this.emitAlert('error', 'pool_exhausted', `No healthy connections for account ${account.username}`, account.username, { account });
                }
            }
        }
    }
    emitAlert(level, type, message, accountName, metadata) {
        if (!this.config.alerting.enabled)
            return;
        const alert = {
            level,
            type,
            message,
            accountName,
            timestamp: Date.now(),
            metadata,
        };
        // Check alert cooldown
        const alertKey = `${type}:${accountName || 'system'}`;
        if (!this.alertHistory.has(alertKey)) {
            this.alertHistory.set(alertKey, []);
        }
        const history = this.alertHistory.get(alertKey);
        const recentAlerts = history.filter(a => Date.now() - a.timestamp < this.config.alerting.cooldownMs);
        if (recentAlerts.length === 0) {
            history.push(alert);
            // Clean old alerts
            while (history.length > this.config.alerting.maxAlertsPerHour) {
                history.shift();
            }
            this.emit('alert', alert);
            logger[level === 'info' ? 'info' : level === 'warning' ? 'warn' : 'error']({ alert }, `Health alert: ${message}`);
        }
    }
    setupEventListeners() {
        // Listen to circuit breaker events
        this.circuitBreaker.on('stateChange', ({ accountName, newState }) => {
            if (newState === auth_circuit_breaker_1.CircuitState.OPEN) {
                this.emitAlert('warning', 'circuit_open', `Circuit breaker opened for account ${accountName}`, accountName);
            }
        });
        this.circuitBreaker.on('failure', ({ accountName, error }) => {
            this.emitAlert('warning', 'auth_failure', `Authentication failure for account ${accountName}: ${error}`, accountName, { error });
        });
        // Listen to connection manager events
        this.connectionManager.on('connectionUnhealthy', ({ account, error }) => {
            this.emitAlert('warning', 'pool_exhausted', `Unhealthy connection detected for account ${account}`, account, { error });
        });
    }
}
exports.HealthMonitor = HealthMonitor;
//# sourceMappingURL=health-monitor.js.map