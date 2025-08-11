import { LRUCache } from 'lru-cache';
import Redis from 'ioredis';
import pino from 'pino';
const logger = pino.default({ name: 'context-cache' });
export class ContextCache {
    memoryCache;
    redis = null;
    keyPrefix;
    ttl;
    metricsBuffer = { hits: 0, misses: 0, latencies: [] };
    constructor(maxSize = 1000, ttl = 60000, // 1 minute
    redisConfig) {
        // Initialize ultra-fast in-memory LRU cache
        this.memoryCache = new LRUCache({
            max: maxSize,
            ttl: ttl,
            updateAgeOnGet: true,
            updateAgeOnHas: false,
        });
        this.ttl = ttl;
        this.keyPrefix = redisConfig?.keyPrefix || 'bi:context:';
        // Initialize Redis connection if config provided
        if (redisConfig) {
            try {
                this.redis = new Redis.default({
                    host: redisConfig.host,
                    port: redisConfig.port,
                    password: redisConfig.password,
                    db: redisConfig.db || 0,
                    lazyConnect: true,
                    enableReadyCheck: false,
                    maxRetriesPerRequest: 1,
                    retryStrategy: () => null, // Don't retry - fail fast
                    commandTimeout: 20, // 20ms timeout for Redis commands
                });
                this.redis.on('error', (err) => {
                    logger.warn({ err }, 'Redis error - falling back to memory cache');
                });
                // Connect async without blocking
                this.redis.connect().catch((err) => {
                    logger.warn({ err }, 'Redis connection failed - using memory cache only');
                });
            }
            catch (err) {
                logger.warn({ err }, 'Redis initialization failed - using memory cache only');
                this.redis = null;
            }
        }
    }
    async get(customerId) {
        const startTime = process.hrtime.bigint();
        try {
            // First check memory cache (sub-microsecond)
            const memoryResult = this.memoryCache.get(customerId);
            if (memoryResult) {
                this.recordMetrics(true, startTime);
                return memoryResult;
            }
            // If Redis is available and connected, try Redis (with timeout)
            if (this.redis && this.redis.status === 'ready') {
                const redisKey = this.keyPrefix + customerId;
                // Use Promise.race to enforce timeout
                const redisPromise = this.redis.get(redisKey);
                const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 15) // 15ms timeout for Redis
                );
                const redisResult = await Promise.race([redisPromise, timeoutPromise]);
                if (redisResult && typeof redisResult === 'string') {
                    try {
                        const data = JSON.parse(redisResult);
                        // Warm memory cache
                        this.memoryCache.set(customerId, data);
                        this.recordMetrics(true, startTime);
                        return data;
                    }
                    catch (err) {
                        logger.warn({ err, customerId }, 'Failed to parse Redis data');
                    }
                }
            }
            this.recordMetrics(false, startTime);
            return null;
        }
        catch (err) {
            logger.error({ err, customerId }, 'Cache get error');
            this.recordMetrics(false, startTime);
            return null;
        }
    }
    async set(customerId, data) {
        // Always set in memory cache first (non-blocking)
        this.memoryCache.set(customerId, data);
        // Async write to Redis if available (fire-and-forget)
        if (this.redis && this.redis.status === 'ready') {
            const redisKey = this.keyPrefix + customerId;
            const ttlSeconds = Math.floor(this.ttl / 1000);
            // Fire and forget - don't await
            this.redis.setex(redisKey, ttlSeconds, JSON.stringify(data)).catch((err) => {
                logger.debug({ err, customerId }, 'Redis set failed - memory cache still updated');
            });
        }
    }
    async warmup(customerIds) {
        // This would be called on startup to pre-warm cache
        // Implementation depends on having Snowflake connection
        logger.info({ count: customerIds.length }, 'Cache warmup requested');
    }
    clear() {
        this.memoryCache.clear();
    }
    recordMetrics(hit, startTime) {
        const latencyNs = Number(process.hrtime.bigint() - startTime);
        const latencyMs = latencyNs / 1_000_000;
        if (hit) {
            this.metricsBuffer.hits++;
        }
        else {
            this.metricsBuffer.misses++;
        }
        this.metricsBuffer.latencies.push(latencyMs);
        // Keep only last 1000 latencies for p95 calculation
        if (this.metricsBuffer.latencies.length > 1000) {
            this.metricsBuffer.latencies.shift();
        }
    }
    getMetrics() {
        const latencies = [...this.metricsBuffer.latencies].sort((a, b) => a - b);
        const p95Index = Math.floor(latencies.length * 0.95);
        return {
            hits: this.metricsBuffer.hits,
            misses: this.metricsBuffer.misses,
            hitRate: this.metricsBuffer.hits / (this.metricsBuffer.hits + this.metricsBuffer.misses),
            p50Latency: latencies[Math.floor(latencies.length * 0.5)] || 0,
            p95Latency: latencies[p95Index] || 0,
            p99Latency: latencies[Math.floor(latencies.length * 0.99)] || 0,
            memoryCacheSize: this.memoryCache.size,
            redisConnected: this.redis?.status === 'ready',
        };
    }
    async close() {
        if (this.redis) {
            await this.redis.quit();
        }
    }
}
//# sourceMappingURL=context-cache.js.map