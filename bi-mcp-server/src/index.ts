import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from './config.js';
import { NDJSONQueue } from './queue/ndjson-queue.js';
import { ContextCache } from './cache/context-cache.js';
import { TicketManager } from './query/ticket-manager.js';
import {
  validateAllTemplates,
  TEMPLATE_NAMES,
} from './sql/safe-templates.js';
import { generateQueryTag } from './utils/query-tag.js';
import { SnowflakeClient } from './db/snowflake-client.js';
import { AuthEnabledSnowflakeClient } from './db/auth-enabled-snowflake-client.js';

// Initialize logger
const logger = pino.default({
  name: 'bi-mcp-server',
  level: process.env.LOG_LEVEL || 'info',
});

// Load configuration
const config = loadConfig();

// Initialize components
let queue: NDJSONQueue;
let cache: ContextCache;
let ticketManager: TicketManager;
let snowflakeClient: SnowflakeClient | AuthEnabledSnowflakeClient;

// Performance metrics
const metrics = {
  logEvent: { count: 0, totalMs: 0, errors: 0 },
  getContext: { count: 0, totalMs: 0, errors: 0, p95: [] as number[] },
  submitQuery: { count: 0, totalMs: 0, errors: 0 },
  logInsight: { count: 0, totalMs: 0, errors: 0 },
  getAuthHealth: { count: 0, totalMs: 0, errors: 0 },
  unlockAccount: { count: 0, totalMs: 0, errors: 0 },
  rotateCredentials: { count: 0, totalMs: 0, errors: 0 },
};

// Tool schemas
const logEventSchema = z.object({
  activity: z.string().min(1).max(100),
  feature_json: z.record(z.any()).optional(),
  link: z.string().url().optional(),
});

const getContextSchema = z.object({
  customer_id: z.string().min(1).max(255),
  max_bytes: z.number().optional(),
});

const submitQuerySchema = z.object({
  template: z.string(),
  params: z.array(z.any()),
  byte_cap: z.number().optional(),
});

const logInsightSchema = z.object({
  subject: z.string().min(1).max(255),
  metric: z.string().min(1).max(255),
  value: z.any(),
  provenance_query_hash: z.string().length(16),
});

// Initialize server
const server = new Server(
  {
    name: 'bi-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'log_event',
      description: 'Log an activity event to the NDJSON queue (fire-and-forget, <10ms)',
      inputSchema: {
        type: 'object',
        properties: {
          activity: { type: 'string', description: 'Activity name (e.g., claude_tool_call)' },
          feature_json: { type: 'object', description: 'Event metadata' },
          link: { type: 'string', description: 'Reference URL' },
        },
        required: ['activity'],
      },
    },
    {
      name: 'get_context',
      description: 'Get customer context from cache (<25ms p95)',
      inputSchema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer identifier' },
          max_bytes: { type: 'number', description: 'Maximum response size in bytes' },
        },
        required: ['customer_id'],
      },
    },
    {
      name: 'submit_query',
      description: 'Submit an async query and get a ticket ID',
      inputSchema: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'SafeSQL template name' },
          params: { type: 'array', description: 'Template parameters' },
          byte_cap: { type: 'number', description: 'Result size limit in bytes' },
        },
        required: ['template', 'params'],
      },
    },
    {
      name: 'log_insight',
      description: 'Log an insight atom for persistent memory',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Entity being measured' },
          metric: { type: 'string', description: 'Metric name' },
          value: { description: 'Metric value' },
          provenance_query_hash: { type: 'string', description: 'Source query hash (16 chars)' },
        },
        required: ['subject', 'metric', 'value', 'provenance_query_hash'],
      },
    },
    {
      name: 'get_auth_health',
      description: 'Get comprehensive authentication system health status',
      inputSchema: {
        type: 'object',
        properties: {
          include_details: { type: 'boolean', description: 'Include detailed account metrics', default: true },
        },
      },
    },
    {
      name: 'unlock_account',
      description: 'Manually unlock a Snowflake account (admin operation)',
      inputSchema: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Account username to unlock' },
          reason: { type: 'string', description: 'Reason for unlocking (for audit)' },
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
          force: { type: 'boolean', description: 'Force rotation even if current account is healthy', default: false },
        },
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startTime = process.hrtime.bigint();

  try {
    switch (name) {
      case 'log_event': {
        const params = logEventSchema.parse(args);
        
        // Ensure activity uses cdesk.* namespace
        const activity = params.activity.startsWith('cdesk.') 
          ? params.activity 
          : `cdesk.${params.activity}`;
        
        // Fire-and-forget to NDJSON queue
        const eventId = uuidv4();
        const queryTag = generateQueryTag();
        
        await queue.write({
          activity_id: eventId,
          activity: activity,
          customer: process.env.CUSTOMER_ID || 'default_customer',
          feature_json: params.feature_json,
          link: params.link,
          session_id: process.env.SESSION_ID,
          query_tag: queryTag,
        });
        
        recordMetric('logEvent', startTime);
        
        return {
          content: [
            {
              type: 'text',
              text: 'Event logged successfully',
            },
          ],
        };
      }

      case 'get_context': {
        const params = getContextSchema.parse(args);
        
        // First try ultra-fast memory cache
        let context = await cache.get(params.customer_id);
        
        // If miss, try Snowflake (with strict timeout)
        if (!context && snowflakeClient) {
          const sfContext = await snowflakeClient.getContextFromCache(params.customer_id);
          if (sfContext) {
            // Populate cache for next time
            context = {
              context: sfContext,
              updated_at: new Date().toISOString(),
            };
            await cache.set(params.customer_id, context);
          }
        }
        
        recordMetric('getContext', startTime);
        
        if (context) {
          let result = context.context;
          
          // Apply byte cap if specified
          if (params.max_bytes) {
            const stringified = JSON.stringify(result);
            if (stringified.length > params.max_bytes) {
              // Truncate to fit byte cap
              result = { 
                truncated: true, 
                original_size: stringified.length,
                data: JSON.parse(stringified.substring(0, params.max_bytes - 100))
              };
            }
          }
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ context: null }),
            },
          ],
        };
      }

      case 'submit_query': {
        const params = submitQuerySchema.parse(args);
        
        // Generate query tag for this SQL execution
        const queryTag = generateQueryTag();
        
        // Create ticket
        const ticket = ticketManager.createTicket({
          template: params.template,
          params: params.params,
          byte_cap: params.byte_cap,
        });
        
        // Execute async if Snowflake is available
        if (snowflakeClient) {
          // Fire and forget - execute in background
          snowflakeClient.executeTemplate(
            params.template,
            params.params,
            { queryTag, timeout: 30000 }
          ).then(result => {
            ticketManager.updateStatus(ticket.id, 'completed', result);
          }).catch(error => {
            ticketManager.updateStatus(ticket.id, 'failed', { error: error.message });
          });
        } else {
          // No Snowflake - mark as pending
          ticketManager.updateStatus(ticket.id, 'failed', { 
            error: 'Snowflake not connected' 
          });
        }
        
        // Log the SQL execution activity
        await queue.write({
          activity_id: uuidv4(),
          activity: 'cdesk.sql_executed',
          customer: process.env.CUSTOMER_ID || 'default_customer',
          feature_json: {
            template: params.template,
            ticket_id: ticket.id,
          },
          session_id: process.env.SESSION_ID,
          query_tag: queryTag,
        });
        
        recordMetric('submitQuery', startTime);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ticket_id: ticket.id }),
            },
          ],
        };
      }

      case 'log_insight': {
        const params = logInsightSchema.parse(args);
        
        // Fire-and-forget to NDJSON queue for insight atom
        const atomId = uuidv4();
        const queryTag = generateQueryTag();
        
        await queue.write({
          activity_id: uuidv4(),
          activity: 'cdesk.insight_recorded',
          customer: process.env.CUSTOMER_ID || 'default_customer',
          feature_json: {
            atom_id: atomId,
            subject: params.subject,
            metric: params.metric,
            value: params.value,
            provenance_query_hash: params.provenance_query_hash,
          },
          session_id: process.env.SESSION_ID,
          query_tag: queryTag,
        });
        
        recordMetric('logInsight', startTime);
        
        return {
          content: [
            {
              type: 'text',
              text: 'Insight logged successfully',
            },
          ],
        };
      }

      case 'get_auth_health': {
        // Check if auth-enabled client is available
        if (!('getSystemHealth' in snowflakeClient)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'auth_agent_disabled',
                  message: 'Auth agent not enabled. Set AUTH_AGENT_ENABLED=true to enable.',
                }),
              },
            ],
          };
        }

        const systemHealth = await (snowflakeClient as AuthEnabledSnowflakeClient).getSystemHealth();
        const includeDetails = args?.include_details !== false;
        
        const response = {
          status: systemHealth.overall,
          summary: systemHealth.summary,
          recommendations: systemHealth.recommendations,
          connectionPools: systemHealth.connectionPools?.length || 0,
          cacheSize: systemHealth.cacheSize,
          lastHealthCheck: systemHealth.lastHealthCheck,
        };

        if (includeDetails) {
          (response as any).accounts = systemHealth.accounts;
          (response as any).circuitBreakers = systemHealth.circuitBreakers;
        }

        recordMetric('getAuthHealth', startTime);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      case 'unlock_account': {
        // Check if auth-enabled client is available
        if (!('unlockAccount' in snowflakeClient)) {
          throw new Error('Auth agent not available. Enable with AUTH_AGENT_ENABLED=true');
        }

        const username = args?.username;
        const reason = args?.reason || 'Manual unlock via MCP tool';
        
        if (!username || typeof username !== 'string') {
          throw new Error('Username is required');
        }

        const success = await (snowflakeClient as AuthEnabledSnowflakeClient).unlockAccount(username);
        
        recordMetric('unlockAccount', startTime);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success,
                account: username,
                reason,
                timestamp: new Date().toISOString(),
                message: success ? 'Account unlocked successfully' : 'Failed to unlock account',
              }),
            },
          ],
        };
      }

      case 'rotate_credentials': {
        // Check if auth-enabled client is available
        if (!('refreshConnections' in snowflakeClient)) {
          throw new Error('Auth agent not available. Enable with AUTH_AGENT_ENABLED=true');
        }

        const force = args?.force === true;
        
        // Refresh connection pools to trigger rotation
        await (snowflakeClient as AuthEnabledSnowflakeClient).refreshConnections();
        
        // Get updated system health to show new active account
        const systemHealth = await (snowflakeClient as AuthEnabledSnowflakeClient).getSystemHealth();
        const activeAccounts = systemHealth.accounts?.filter((acc: any) => acc.isAvailable) || [];
        
        recordMetric('rotateCredentials', startTime);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                rotationTime: new Date().toISOString(),
                forced: force,
                availableAccounts: activeAccounts.length,
                activeAccount: activeAccounts.find((acc: any) => acc.priority === 1)?.username || 'None',
              }),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    logger.error({ error: error.message, tool: name }, 'Tool execution error');
    
    // Record error metric
    if (name in metrics) {
      (metrics as any)[name].errors++;
    }
    
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

// Helper to record metrics
function recordMetric(tool: string, startTime: bigint): void {
  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1_000_000;
  
  if (tool in metrics) {
    const metric = (metrics as any)[tool];
    metric.count++;
    metric.totalMs += durationMs;
    
    // Track p95 for get_context
    if (tool === 'getContext') {
      metric.p95.push(durationMs);
      if (metric.p95.length > 1000) {
        metric.p95.shift();
      }
      
      // Check if we're exceeding p95 target
      const sorted = [...metric.p95].sort((a, b) => a - b);
      const p95Value = sorted[Math.floor(sorted.length * 0.95)] || 0;
      
      if (p95Value > config.performance.getContextP95) {
        logger.warn({ p95: p95Value, target: config.performance.getContextP95 }, 
          'get_context p95 exceeding target!');
      }
    }
  }
  
  // Log slow operations
  if (durationMs > 100) {
    logger.warn({ tool, durationMs }, 'Slow tool execution');
  }
}

// Initialize Snowflake connection pool
async function initSnowflake(): Promise<void> {
  try {
    // Use auth-enabled client if AUTH_AGENT_ENABLED is set
    const useAuthAgent = process.env.AUTH_AGENT_ENABLED === 'true' || process.env.AUTH_AGENT_ENABLED === '1';
    
    if (useAuthAgent) {
      logger.info('Initializing with Auth-Enabled Snowflake client');
      snowflakeClient = new AuthEnabledSnowflakeClient(config);
    } else {
      logger.info('Initializing with standard Snowflake client');
      snowflakeClient = new SnowflakeClient(config, 20); // 20 connection pool for better concurrency
    }
    
    await snowflakeClient.initialize();
    logger.info(`Snowflake client initialized ${useAuthAgent ? 'with auth agent' : 'with standard pool'}`);
    
    // Test connection with health check
    const health = await snowflakeClient.executeTemplate(
      TEMPLATE_NAMES.CHECK_HEALTH,
      [],
      { timeout: 5000 }
    );
    logger.info({ health }, 'Snowflake health check passed');
    
    // Log system health if using auth agent
    if (useAuthAgent && 'getSystemHealth' in snowflakeClient) {
      const systemHealth = await (snowflakeClient as AuthEnabledSnowflakeClient).getSystemHealth();
      logger.info({
        overall: systemHealth.overall,
        accounts: systemHealth.accounts?.length || 0,
        connectionPools: systemHealth.connectionPools?.length || 0,
      }, 'Auth agent system health');
    }
    
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Snowflake client');
    throw error;
  }
}

// Main initialization
async function main() {
  try {
    // Validate SQL templates
    validateAllTemplates();
    logger.info('SQL templates validated');
    
    // Initialize components
    queue = new NDJSONQueue(
      config.queue.path,
      config.queue.maxSize,
      config.queue.maxAge,
      config.queue.maxEvents
    );
    await queue.initialize();
    logger.info('NDJSON queue initialized');
    
    cache = new ContextCache(
      config.cache.maxSize,
      config.cache.ttl,
      config.redis.host ? {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        keyPrefix: config.redis.keyPrefix,
      } : undefined
    );
    logger.info('Context cache initialized');
    
    ticketManager = new TicketManager();
    logger.info('Ticket manager initialized');
    
    // Initialize Snowflake if credentials provided
    if (config.snowflake.password) {
      await initSnowflake();
    } else {
      logger.warn('Snowflake password not provided - running in offline mode');
    }
    
    // Start server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    logger.info('MCP server started successfully');
    
    // Log metrics periodically
    setInterval(() => {
      logger.info({ 
        metrics,
        cache: cache.getMetrics(),
        queue: queue.getStats(),
        tickets: ticketManager.getStats(),
      }, 'Performance metrics');
    }, 30000);
    
    // Proactive cache refresh for hot users
    setInterval(async () => {
      if (snowflakeClient && cache) {
        const hotUsers = cache.getMostAccessedUsers(50); // Top 50 users
        
        for (const userId of hotUsers) {
          try {
            // Refresh context in background
            const context = await snowflakeClient.getContextFromCache(userId);
            if (context) {
              await cache.set(userId, {
                context: context,
                updated_at: new Date().toISOString(),
              });
            }
          } catch (error) {
            logger.debug({ error, userId }, 'Failed to refresh cache for user');
          }
        }
        
        logger.debug({ refreshedUsers: hotUsers.length }, 'Proactive cache refresh completed');
      }
    }, 60000); // Every minute
    
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  
  try {
    await queue.close();
    await cache.close();
    
    if (snowflakeClient) {
      await snowflakeClient.close();
    }
    
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
});

// Start server
main();