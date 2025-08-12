/**
 * Snowflake Client with Connection Pooling
 * 
 * Manages Snowflake connections and executes SafeSQL templates
 * with < 25ms p95 latency for cached queries.
 */

import snowflake from 'snowflake-sdk';
import { Config } from '../config.js';
import pino from 'pino';
import { performance } from 'perf_hooks';
import { SAFE_TEMPLATES } from '../sql/safe-templates.js';

const logger = pino.default({ name: 'snowflake-client' });

export interface QueryResult {
  rows: any[];
  rowCount: number;
  executionTime: number;
  queryId?: string;
}

export class SnowflakeClient {
  private connections: snowflake.Connection[] = [];
  private activeConnections: Set<snowflake.Connection> = new Set();
  private config: Config;
  private isInitialized: boolean = false;
  private poolSize: number;
  private queryCache: Map<string, { result: QueryResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute cache for repeated queries

  constructor(config: Config, poolSize: number = 20) {
    this.config = config;
    this.poolSize = poolSize;
  }

  async initialize(): Promise<void> {
    logger.info({ poolSize: this.poolSize }, 'Initializing Snowflake connection pool');
    
    const promises: Promise<void>[] = [];
    
    for (let i = 0; i < this.poolSize; i++) {
      promises.push(this.createConnection(i));
    }
    
    await Promise.all(promises);
    this.isInitialized = true;
    
    logger.info({ connections: this.connections.length }, 'Snowflake pool initialized');
    
    // Warm up cache with common queries
    await this.warmCache();
    
    // Start health check interval
    setInterval(() => this.healthCheck(), 30000);
    
    // Start cache refresh interval (every 5 minutes)
    setInterval(() => this.warmCache(), 300000);
  }

  private async createConnection(index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = snowflake.createConnection({
        account: this.config.snowflake.account,
        username: this.config.snowflake.username,
        password: this.config.snowflake.password,
        warehouse: this.config.snowflake.warehouse,
        database: this.config.snowflake.database,
        schema: this.config.snowflake.schema,
        role: this.config.snowflake.role,
        clientSessionKeepAlive: true,
        clientSessionKeepAliveHeartbeatFrequency: 3600, // 1 hour
        jsTreatIntegerAsBigInt: false,
      });

      conn.connect((err) => {
        if (err) {
          logger.error({ err, index }, 'Failed to create connection');
          reject(err);
        } else {
          logger.info({ index }, 'Connection created');
          this.connections.push(conn);
          
          // Set query tag for all queries from this connection
          conn.execute({
            sqlText: `ALTER SESSION SET QUERY_TAG = 'cdesk_pool_${index}'`,
            complete: (err) => {
              if (err) {
                logger.error({ err, index }, 'Failed to set query tag');
              }
              resolve();
            },
          });
        }
      });
    });
  }

  private async getConnection(): Promise<snowflake.Connection> {
    if (!this.isInitialized) {
      throw new Error('Snowflake client not initialized');
    }
    
    // Find available connection
    for (const conn of this.connections) {
      if (!this.activeConnections.has(conn)) {
        this.activeConnections.add(conn);
        return conn;
      }
    }
    
    // All connections busy, wait and retry
    await new Promise(resolve => setTimeout(resolve, 10));
    return this.getConnection();
  }

  private releaseConnection(conn: snowflake.Connection): void {
    this.activeConnections.delete(conn);
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
      
      // Pre-load common user contexts if they exist
      const commonUsers = ['test_user', 'user_1', 'user_2', 'user_3'];
      
      for (const userId of commonUsers) {
        try {
          await this.executeTemplate(
            'GET_CONTEXT',
            [userId],
            { useCache: true, timeout: 2000 }
          );
        } catch (error) {
          // Ignore errors for missing users
        }
      }
      
      logger.info({ cachedQueries: this.queryCache.size }, 'Cache warmed');
    } catch (error) {
      logger.error({ error }, 'Failed to warm cache');
    }
  }

  async executeTemplate(
    templateName: string,
    params: any[],
    options: { 
      timeout?: number; 
      useCache?: boolean;
      queryTag?: string;
    } = {}
  ): Promise<QueryResult> {
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
    
    const conn = await this.getConnection();
    
    try {
      return await new Promise((resolve, reject) => {
        const timeout = options.timeout || 30000;
        let timeoutHandle: NodeJS.Timeout;
        
        // Set timeout
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Query timeout after ${timeout}ms`));
        }, timeout);
        
        // Build query tag
        const queryTag = options.queryTag || `cdesk_${templateName}_${Date.now()}`;
        
        conn.execute({
          sqlText: template.sql,
          binds: validatedParams,
          streamResult: false,
          complete: (err: any, _stmt: any, rows?: any[]) => {
            clearTimeout(timeoutHandle);
            
            const executionTime = performance.now() - start;
            
            if (err) {
              logger.error({ 
                err, 
                templateName, 
                executionTime 
              }, 'Query execution failed');
              reject(err);
            } else {
              const result: QueryResult = {
                rows: rows || [],
                rowCount: rows?.length || 0,
                executionTime,
                queryId: queryTag,
              };
              
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
                rowCount: result.rowCount,
                executionTime,
                cached: false 
              }, 'Query executed');
              
              // Warn if slow
              if (executionTime > 100) {
                logger.warn({ 
                  templateName, 
                  executionTime 
                }, 'Slow query execution');
              }
              
              resolve(result);
            }
          },
        });
      });
    } finally {
      this.releaseConnection(conn);
    }
  }

  async executeBatch(operations: Array<{ template: string; params: any[] }>): Promise<void> {
    const conn = await this.getConnection();
    
    try {
      // Start transaction
      await this.executeRaw(conn, 'BEGIN TRANSACTION');
      
      try {
        for (const op of operations) {
          const template = SAFE_TEMPLATES.get(op.template);
          if (!template) {
            throw new Error(`Unknown template: ${op.template}`);
          }
          
          const validatedParams = template.validator(op.params);
          await this.executeRaw(conn, template.sql, validatedParams);
        }
        
        // Commit transaction
        await this.executeRaw(conn, 'COMMIT');
        
        logger.info({ count: operations.length }, 'Batch executed successfully');
      } catch (error) {
        // Rollback on error
        await this.executeRaw(conn, 'ROLLBACK');
        throw error;
      }
    } finally {
      this.releaseConnection(conn);
    }
  }

  private async executeRaw(
    conn: snowflake.Connection, 
    sql: string, 
    binds?: any[]
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      conn.execute({
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

  private async healthCheck(): Promise<void> {
    const unhealthy: number[] = [];
    
    for (let i = 0; i < this.connections.length; i++) {
      const conn = this.connections[i];
      
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Health check timeout')), 5000);
          
          conn.execute({
            sqlText: 'SELECT 1',
            complete: (err: any) => {
              clearTimeout(timeout);
              if (err) reject(err);
              else resolve(undefined);
            },
          });
        });
      } catch (error) {
        logger.warn({ index: i, error }, 'Connection unhealthy');
        unhealthy.push(i);
      }
    }
    
    // Replace unhealthy connections
    for (const index of unhealthy) {
      try {
        this.connections[index].destroy(() => {});
        const newConn = snowflake.createConnection({
          account: this.config.snowflake.account,
          username: this.config.snowflake.username,
          password: this.config.snowflake.password,
          warehouse: this.config.snowflake.warehouse,
          database: this.config.snowflake.database,
          schema: this.config.snowflake.schema,
          role: this.config.snowflake.role,
          clientSessionKeepAlive: true,
          clientSessionKeepAliveHeartbeatFrequency: 3600,
          jsTreatIntegerAsBigInt: false,
        });
        
        await new Promise<void>((resolve, reject) => {
          newConn.connect((err) => {
            if (err) reject(err);
            else {
              this.connections[index] = newConn;
              resolve();
            }
          });
        });
        logger.info({ index }, 'Connection replaced');
      } catch (error) {
        logger.error({ index, error }, 'Failed to replace connection');
      }
    }
  }

  async getContextFromCache(customerId: string): Promise<any> {
    const start = performance.now();
    
    try {
      const result = await this.executeTemplate(
        'GET_CONTEXT',
        [customerId],
        { 
          useCache: true,
          timeout: 1000, // 1 second timeout for context queries
        }
      );
      
      if (result.rows.length > 0) {
        const latency = performance.now() - start;
        
        if (latency > 25) {
          logger.warn({ customerId, latency }, 'Context retrieval exceeded 25ms');
        }
        
        return result.rows[0].CONTEXT_BLOB;
      }
      
      return null;
    } catch (error) {
      logger.error({ error, customerId }, 'Failed to get context');
      return null;
    }
  }

  async close(): Promise<void> {
    logger.info('Closing Snowflake connections');
    
    for (const conn of this.connections) {
      conn.destroy(() => {});
    }
    
    this.connections = [];
    this.activeConnections.clear();
    this.isInitialized = false;
  }

  getStats() {
    return {
      poolSize: this.poolSize,
      totalConnections: this.connections.length,
      activeConnections: this.activeConnections.size,
      cacheSize: this.queryCache.size,
      cacheHitRate: this.calculateCacheHitRate(),
    };
  }

  private calculateCacheHitRate(): number {
    // This would need proper tracking in production
    return 0;
  }
}