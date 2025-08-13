/**
 * MCP Server Interface for Snowflake Authentication Agent
 * 
 * Provides MCP tools for secure Snowflake operations with intelligent
 * authentication, failover, and monitoring capabilities.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pino from 'pino';
import { performance } from 'perf_hooks';

import { CredentialVault } from '../credential/credential-vault';
import { AuthCircuitBreaker } from '../circuit-breaker/auth-circuit-breaker';
import { ConnectionManager } from '../connection/connection-manager';
import { HealthMonitor } from '../health/health-monitor';
import { SAFE_TEMPLATES, validateAllTemplates, TEMPLATE_NAMES } from '../sql/safe-templates';

const logger = pino({ name: 'auth-agent-server' });

// Tool input schemas
const executeQuerySchema = z.object({
  template: z.string().min(1),
  params: z.array(z.any()),
  options: z.object({
    timeout: z.number().optional(),
    useCache: z.boolean().default(false),
    queryTag: z.string().optional(),
    preferredAccount: z.string().optional(),
  }).optional(),
});

const getHealthStatusSchema = z.object({
  includeDetails: z.boolean().default(true),
});

const unlockAccountSchema = z.object({
  username: z.string().min(1),
  reason: z.string().optional(),
});

const rotateCredentialsSchema = z.object({
  force: z.boolean().default(false),
});

const getConnectionStatsSchema = z.object({
  accountName: z.string().optional(),
});

export interface AuthAgentServerConfig {
  name: string;
  version: string;
  performanceTargets: {
    executeQuery: number;
    getHealth: number;
    unlockAccount: number;
  };
  features: {
    healthMonitoring: boolean;
    performanceTracking: boolean;
    alerting: boolean;
  };
}

export class AuthAgentServer {
  private server: Server;
  private credentialVault: CredentialVault;
  private circuitBreaker: AuthCircuitBreaker;
  private connectionManager: ConnectionManager;
  private healthMonitor: HealthMonitor;
  private config: AuthAgentServerConfig;
  
  // Performance metrics
  private metrics = {
    executeQuery: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
    getHealth: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
    unlockAccount: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
    rotateCredentials: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
  };

  private isInitialized = false;

  constructor(
    credentialVault: CredentialVault,
    circuitBreaker: AuthCircuitBreaker,
    connectionManager: ConnectionManager,
    healthMonitor: HealthMonitor,
    config: Partial<AuthAgentServerConfig> = {}
  ) {
    this.credentialVault = credentialVault;
    this.circuitBreaker = circuitBreaker;
    this.connectionManager = connectionManager;
    this.healthMonitor = healthMonitor;
    
    this.config = {
      name: config.name || 'snowflake-auth-agent',
      version: config.version || '1.0.0',
      performanceTargets: {
        executeQuery: config.performanceTargets?.executeQuery || 1000, // 1s for complex queries
        getHealth: config.performanceTargets?.getHealth || 100, // 100ms for health checks
        unlockAccount: config.performanceTargets?.unlockAccount || 500, // 500ms for unlock
        ...config.performanceTargets,
      },
      features: {
        healthMonitoring: config.features?.healthMonitoring ?? true,
        performanceTracking: config.features?.performanceTracking ?? true,
        alerting: config.features?.alerting ?? true,
        ...config.features,
      },
    };

    this.server = new Server({
      name: this.config.name,
      version: this.config.version,
    });

    this.setupToolHandlers();
    logger.info({ config: this.config }, 'Auth agent server created');
  }

  /**
   * Initialize the MCP server and all components
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Auth agent server already initialized');
      return;
    }

    logger.info('Initializing auth agent server');

    try {
      // Validate SQL templates first
      validateAllTemplates();
      logger.info('SQL templates validated');

      // Initialize core components
      await this.credentialVault.initialize();
      await this.connectionManager.initialize();

      // Start health monitoring if enabled
      if (this.config.features.healthMonitoring) {
        this.healthMonitor.start();
        logger.info('Health monitoring started');
      }

      // Setup performance tracking if enabled
      if (this.config.features.performanceTracking) {
        this.setupPerformanceTracking();
        logger.info('Performance tracking enabled');
      }

      this.isInitialized = true;
      logger.info('Auth agent server initialized successfully');

    } catch (error) {
      logger.error({ error }, 'Failed to initialize auth agent server');
      throw error;
    }
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    logger.info('Auth agent MCP server started');
  }

  /**
   * Stop the MCP server and cleanup
   */
  async stop(): Promise<void> {
    logger.info('Stopping auth agent server');

    try {
      if (this.config.features.healthMonitoring) {
        this.healthMonitor.stop();
      }

      await this.connectionManager.destroy();
      
      this.isInitialized = false;
      logger.info('Auth agent server stopped successfully');

    } catch (error) {
      logger.error({ error }, 'Error stopping auth agent server');
      throw error;
    }
  }

  // Private methods

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'execute_query',
          description: 'Execute a SafeSQL template with intelligent failover and circuit breaking',
          inputSchema: {
            type: 'object',
            properties: {
              template: { 
                type: 'string', 
                description: 'SafeSQL template name',
                enum: Array.from(SAFE_TEMPLATES.keys()),
              },
              params: { 
                type: 'array', 
                description: 'Template parameters' 
              },
              options: {
                type: 'object',
                properties: {
                  timeout: { type: 'number', description: 'Query timeout in milliseconds' },
                  useCache: { type: 'boolean', description: 'Enable result caching' },
                  queryTag: { type: 'string', description: 'Custom query tag' },
                  preferredAccount: { type: 'string', description: 'Preferred account username' },
                },
              },
            },
            required: ['template', 'params'],
          },
        },
        {
          name: 'get_health_status',
          description: 'Get comprehensive health status of all accounts and connections',
          inputSchema: {
            type: 'object',
            properties: {
              includeDetails: { 
                type: 'boolean', 
                description: 'Include detailed account metrics',
                default: true,
              },
            },
          },
        },
        {
          name: 'unlock_account',
          description: 'Manually unlock a Snowflake account (admin operation)',
          inputSchema: {
            type: 'object',
            properties: {
              username: { 
                type: 'string', 
                description: 'Account username to unlock' 
              },
              reason: { 
                type: 'string', 
                description: 'Reason for unlocking (for audit)' 
              },
            },
            required: ['username'],
          },
        },
        {
          name: 'rotate_credentials',
          description: 'Force rotation to next available account',
          inputSchema: {
            type: 'object',
            properties: {
              force: { 
                type: 'boolean', 
                description: 'Force rotation even if current account is healthy',
                default: false,
              },
            },
          },
        },
        {
          name: 'get_connection_stats',
          description: 'Get connection pool statistics',
          inputSchema: {
            type: 'object',
            properties: {
              accountName: { 
                type: 'string', 
                description: 'Specific account name (optional)' 
              },
            },
          },
        },
        {
          name: 'get_performance_metrics',
          description: 'Get performance metrics for the auth agent',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const startTime = performance.now();

      try {
        let result;

        switch (name) {
          case 'execute_query':
            result = await this.handleExecuteQuery(args);
            break;
            
          case 'get_health_status':
            result = await this.handleGetHealthStatus(args);
            break;
            
          case 'unlock_account':
            result = await this.handleUnlockAccount(args);
            break;
            
          case 'rotate_credentials':
            result = await this.handleRotateCredentials(args);
            break;
            
          case 'get_connection_stats':
            result = await this.handleGetConnectionStats(args);
            break;
            
          case 'get_performance_metrics':
            result = await this.handleGetPerformanceMetrics(args);
            break;
            
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        this.recordMetric(name, startTime, false);
        return result;

      } catch (error: any) {
        this.recordMetric(name, startTime, true);
        
        logger.error({ 
          error: error.message, 
          tool: name,
          args: Object.keys(args || {}),
        }, 'Tool execution error');

        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleExecuteQuery(args: any) {
    const params = executeQuerySchema.parse(args);
    
    // Get connection with intelligent failover
    const { connection, account } = await this.connectionManager.getConnection(
      params.options?.preferredAccount
    );

    try {
      // Get the SafeSQL template
      const template = SAFE_TEMPLATES.get(params.template);
      if (!template) {
        throw new Error(`Unknown template: ${params.template}`);
      }

      // Validate parameters
      const validatedParams = template.validator(params.params);
      
      // Execute query
      const result = await this.executeQuery(
        connection,
        template.sql,
        validatedParams,
        params.options
      );

      // Record success
      await this.credentialVault.recordSuccess(account.username);
      this.circuitBreaker.recordSuccess(account.username);
      
      // Record response time if performance tracking enabled
      if (this.config.features.performanceTracking) {
        this.healthMonitor.recordResponseTime(account.username, result.executionTime);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rows: result.rows,
              rowCount: result.rowCount,
              executionTime: result.executionTime,
              accountUsed: account.username,
              queryId: result.queryId,
            }),
          },
        ],
      };

    } catch (error: any) {
      // Record failure
      await this.credentialVault.recordFailure(account.username, error.message);
      this.circuitBreaker.recordFailure(account.username, error.message);
      
      throw error;
    } finally {
      // Always release connection
      await this.connectionManager.releaseConnection(connection);
    }
  }

  private async handleGetHealthStatus(args: any) {
    const params = getHealthStatusSchema.parse(args);
    const healthStatus = await this.healthMonitor.getHealthStatus();
    
    const response = {
      overall: healthStatus.overall,
      lastCheck: healthStatus.lastCheck,
      summary: healthStatus.summary,
      recommendations: healthStatus.recommendations,
    };

    if (params.includeDetails) {
      (response as any).accounts = healthStatus.accounts;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  private async handleUnlockAccount(args: any) {
    const params = unlockAccountSchema.parse(args);
    
    // Unlock in both credential vault and circuit breaker
    const vaultResult = await this.credentialVault.unlockAccount(params.username);
    this.circuitBreaker.reset(params.username);
    
    if (vaultResult) {
      logger.info({
        username: params.username,
        reason: params.reason || 'Manual unlock via MCP',
      }, 'Account unlocked');
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Account ${params.username} unlocked successfully`,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      };
    } else {
      throw new Error(`Failed to unlock account ${params.username}`);
    }
  }

  private async handleRotateCredentials(args: any) {
    const params = rotateCredentialsSchema.parse(args);
    
    // Get current account
    const currentAccount = this.credentialVault.getNextAccount();
    if (!currentAccount) {
      throw new Error('No available accounts to rotate from');
    }

    // Force refresh pools to pick up changes
    await this.connectionManager.refreshPools();
    
    // Get next account after refresh
    const nextAccount = this.credentialVault.getNextAccount();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            previousAccount: currentAccount.username,
            newAccount: nextAccount?.username || 'None available',
            rotationTime: new Date().toISOString(),
            forced: params.force,
          }),
        },
      ],
    };
  }

  private async handleGetConnectionStats(args: any) {
    const params = getConnectionStatsSchema.parse(args);
    const stats = this.connectionManager.getStats();
    
    const filteredStats = params.accountName 
      ? stats.filter(stat => stat.accountName === params.accountName)
      : stats;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            stats: filteredStats,
            totalPools: stats.length,
            timestamp: new Date().toISOString(),
          }, null, 2),
        },
      ],
    };
  }

  private async handleGetPerformanceMetrics(args: any) {
    const metricsWithCalculations = Object.entries(this.metrics).map(([tool, metric]) => {
      const avgMs = metric.count > 0 ? metric.totalMs / metric.count : 0;
      const errorRate = metric.count > 0 ? metric.errors / metric.count : 0;
      const p95 = metric.p95 && metric.p95.length > 0 
        ? this.calculateP95(metric.p95)
        : undefined;

      return {
        tool,
        count: metric.count,
        averageMs: Math.round(avgMs),
        errorRate: Math.round(errorRate * 100) / 100,
        p95Ms: p95 ? Math.round(p95) : undefined,
        target: this.config.performanceTargets[tool as keyof typeof this.config.performanceTargets],
      };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            metrics: metricsWithCalculations,
            timestamp: new Date().toISOString(),
            config: this.config,
          }, null, 2),
        },
      ],
    };
  }

  private async executeQuery(
    connection: any,
    sql: string,
    binds: any[],
    options?: any
  ): Promise<{
    rows: any[];
    rowCount: number;
    executionTime: number;
    queryId?: string;
  }> {
    const startTime = performance.now();
    
    return new Promise((resolve, reject) => {
      const timeout = options?.timeout || 30000;
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Query timeout after ${timeout}ms`));
      }, timeout);

      connection.execute({
        sqlText: sql,
        binds,
        streamResult: false,
        queryId: options?.queryTag,
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
              queryId: options?.queryTag,
            });
          }
        },
      });
    });
  }

  private recordMetric(tool: string, startTime: number, isError: boolean): void {
    const durationMs = performance.now() - startTime;
    
    if (tool in this.metrics) {
      const metric = (this.metrics as any)[tool];
      metric.count++;
      metric.totalMs += durationMs;
      
      if (isError) {
        metric.errors++;
      }
      
      // Track P95 for all tools
      metric.p95.push(durationMs);
      if (metric.p95.length > 1000) {
        metric.p95.shift();
      }
      
      // Log performance warnings
      const target = this.config.performanceTargets[tool as keyof typeof this.config.performanceTargets];
      if (target && durationMs > target) {
        logger.warn({
          tool,
          duration: Math.round(durationMs),
          target,
        }, 'Tool execution exceeded performance target');
      }
    }
  }

  private calculateP95(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.95);
    return sorted[index];
  }

  private setupPerformanceTracking(): void {
    // Log performance metrics every 60 seconds
    setInterval(() => {
      const summary = Object.entries(this.metrics).map(([tool, metric]) => ({
        tool,
        count: metric.count,
        avgMs: metric.count > 0 ? Math.round(metric.totalMs / metric.count) : 0,
        errorRate: metric.count > 0 ? Math.round((metric.errors / metric.count) * 100) : 0,
      }));
      
      logger.info({ metrics: summary }, 'Performance metrics summary');
    }, 60000);
  }
}