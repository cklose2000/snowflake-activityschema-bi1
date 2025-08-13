/**
 * Cache Warmer for Context Cache
 * 
 * Pre-loads frequently accessed customers and maintains cache freshness
 * to ensure < 25ms P95 latency for most requests
 */

import { ContextCache } from './context-cache.js';
import { SnowflakeClient } from '../db/snowflake-client.js';
import pino from 'pino';
import { performance } from 'perf_hooks';

const logger = pino.default({ name: 'cache-warmer' });

export interface WarmingStrategy {
  topCustomerCount: number;      // Number of top customers to pre-load
  refreshIntervalMs: number;      // How often to refresh cache
  batchSize: number;             // Batch size for loading
  ttlBufferMs: number;          // Refresh before TTL expires
}

export class CacheWarmer {
  private cache: ContextCache;
  private snowflake: SnowflakeClient;
  private strategy: WarmingStrategy;
  private warmingInterval?: NodeJS.Timeout;
  private accessTracking: Map<string, number> = new Map();
  private isWarming: boolean = false;

  constructor(
    cache: ContextCache,
    snowflake: SnowflakeClient,
    strategy?: Partial<WarmingStrategy>
  ) {
    this.cache = cache;
    this.snowflake = snowflake;
    this.strategy = {
      topCustomerCount: strategy?.topCustomerCount || 100,
      refreshIntervalMs: strategy?.refreshIntervalMs || 300000, // 5 minutes
      batchSize: strategy?.batchSize || 10,
      ttlBufferMs: strategy?.ttlBufferMs || 60000, // 1 minute before TTL
    };
  }

  /**
   * Start the cache warming process
   */
  async start(): Promise<void> {
    logger.info({ strategy: this.strategy }, 'Starting cache warmer');
    
    // Initial warming
    await this.warmCache();
    
    // Schedule periodic warming
    this.warmingInterval = setInterval(async () => {
      if (!this.isWarming) {
        await this.warmCache();
      }
    }, this.strategy.refreshIntervalMs);
  }

  /**
   * Stop the cache warming process
   */
  stop(): void {
    if (this.warmingInterval) {
      clearInterval(this.warmingInterval);
      this.warmingInterval = undefined;
    }
    logger.info('Cache warmer stopped');
  }

  /**
   * Warm the cache with frequently accessed customers
   */
  private async warmCache(): Promise<void> {
    if (this.isWarming) {
      logger.debug('Warming already in progress, skipping');
      return;
    }

    this.isWarming = true;
    const startTime = performance.now();
    
    try {
      // 1. Get list of customers to warm
      const customersToWarm = await this.getCustomersToWarm();
      
      if (customersToWarm.length === 0) {
        logger.debug('No customers to warm');
        this.isWarming = false;
        return;
      }
      
      logger.info({ count: customersToWarm.length }, 'Warming cache for customers');
      
      // 2. Load in batches to avoid overwhelming Snowflake
      for (let i = 0; i < customersToWarm.length; i += this.strategy.batchSize) {
        const batch = customersToWarm.slice(i, i + this.strategy.batchSize);
        await this.loadBatch(batch);
      }
      
      const duration = performance.now() - startTime;
      logger.info({
        duration: duration.toFixed(2),
        customersWarmed: customersToWarm.length,
      }, 'Cache warming completed');
      
    } catch (error) {
      logger.error({ error }, 'Cache warming failed');
    } finally {
      this.isWarming = false;
    }
  }

  /**
   * Get list of customers that should be warmed
   */
  private async getCustomersToWarm(): Promise<string[]> {
    const customers: string[] = [];
    
    // 1. Get most frequently accessed customers from tracking
    const topAccessed = Array.from(this.accessTracking.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.strategy.topCustomerCount / 2)
      .map(([customerId]) => customerId);
    
    customers.push(...topAccessed);
    
    // 2. Get recently active customers from Snowflake
    try {
      const result = await this.snowflake.executeTemplate('GET_ACTIVE_CUSTOMERS', [
        this.strategy.topCustomerCount - topAccessed.length,
      ]);
      
      if (result.rows) {
        const activeCustomers = result.rows.map((row: any) => row.CUSTOMER_ID);
        customers.push(...activeCustomers);
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get active customers from Snowflake');
    }
    
    // 3. Get customers whose cache is about to expire
    const expiringCustomers = this.cache.getMostAccessedUsers(20)
      .filter((customerId: string) => !customers.includes(customerId));
    
    customers.push(...expiringCustomers);
    
    // Remove duplicates and limit to strategy count
    return [...new Set(customers)].slice(0, this.strategy.topCustomerCount);
  }

  /**
   * Load a batch of customers into cache
   */
  private async loadBatch(customerIds: string[]): Promise<void> {
    if (customerIds.length === 0) return;
    
    try {
      // Use batch query to load multiple customers at once
      const placeholders = customerIds.map(() => '?').join(',');
      const query = `
        SELECT customer_id, context_blob as context, updated_at, version
        FROM CONTEXT_CACHE
        WHERE customer_id IN (${placeholders})
      `;
      
      const result = await this.snowflake.executeRawQuery(query, customerIds);
      
      if (result.rows) {
        // Load all results into cache
        for (const row of result.rows) {
          await this.cache.set(row.CUSTOMER_ID, {
            context: row.CONTEXT,
            updated_at: row.UPDATED_AT,
            version: row.VERSION,
          });
        }
        
        logger.debug({
          batchSize: customerIds.length,
          loaded: result.rows.length,
        }, 'Batch loaded into cache');
      }
    } catch (error) {
      logger.error({ error, batch: customerIds }, 'Failed to load batch');
    }
  }

  /**
   * Track customer access for intelligent warming
   */
  trackAccess(customerId: string): void {
    const count = this.accessTracking.get(customerId) || 0;
    this.accessTracking.set(customerId, count + 1);
    
    // Limit tracking map size
    if (this.accessTracking.size > 1000) {
      // Remove least accessed
      const sorted = Array.from(this.accessTracking.entries())
        .sort((a, b) => a[1] - b[1]);
      this.accessTracking.delete(sorted[0][0]);
    }
  }

  /**
   * Pre-warm specific customers (useful after writes)
   */
  async warmCustomers(customerIds: string[]): Promise<void> {
    if (customerIds.length === 0) return;
    
    logger.debug({ count: customerIds.length }, 'Pre-warming specific customers');
    
    for (let i = 0; i < customerIds.length; i += this.strategy.batchSize) {
      const batch = customerIds.slice(i, i + this.strategy.batchSize);
      await this.loadBatch(batch);
    }
  }

  /**
   * Get warming statistics
   */
  getStats() {
    return {
      isWarming: this.isWarming,
      topAccessedCustomers: Array.from(this.accessTracking.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([customerId, count]) => ({ customerId, accessCount: count })),
      totalTracked: this.accessTracking.size,
      strategy: this.strategy,
    };
  }
}