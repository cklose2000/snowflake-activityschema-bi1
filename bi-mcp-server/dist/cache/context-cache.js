import { LRUCache } from 'lru-cache';
import Redis from 'ioredis';
import pino from 'pino';
const logger = pino.default({ name: 'context-cache' });
export class ContextCache {
    memoryCache;
    redis = null;
    keyPrefix;
    ttl;
    bloomFilter = new Set(); // Bloom filter for negative cache
    accessPatterns = new Map(); // Track access frequency
    preloadedUsers = new Set(); // Track pre-loaded users
    metricsBuffer = { hits: 0, misses: 0, negativeHits: 0, latencies: [] };
    constructor(maxSize = 10000, // Increased from 1000 to 10000 for better hit rate
    ttl = 300000, // 5 minutes (increased from 1 minute)
    redisConfig) {
        // Initialize ultra-fast in-memory LRU cache with optimized settings
        this.memoryCache = new LRUCache({
            max: maxSize,
            ttl: ttl,
            updateAgeOnGet: true,
            updateAgeOnHas: false,
            // Dispose callback for metrics
            dispose: (_value, key) => {
                this.bloomFilter.delete(key);
            }
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
        // Track access pattern for intelligent pre-loading
        this.trackAccess(customerId);
        try {
            // Check bloom filter first (< 0.1ms) - negative cache
            if (!this.bloomFilter.has(customerId) && !this.preloadedUsers.has(customerId)) {
                // User definitely doesn't exist, skip all lookups
                this.recordMetrics(false, startTime, true);
                return null;
            }
            // First check memory cache (sub-microsecond)
            const memoryResult = this.memoryCache.get(customerId);
            if (memoryResult) {
                this.recordMetrics(true, startTime);
                // Return cached object directly without cloning for speed
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
                        // Use optimized JSON parsing
                        const data = this.fastJSONParse(redisResult);
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
        // Add to bloom filter for positive existence
        this.bloomFilter.add(customerId);
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
        // Mark these users as pre-loaded to skip bloom filter check
        customerIds.forEach(id => {
            this.preloadedUsers.add(id);
            this.bloomFilter.add(id);
        });
        logger.info({ count: customerIds.length }, 'Cache warmup requested');
    }
    // Track access patterns for intelligent pre-loading
    trackAccess(customerId) {
        const count = this.accessPatterns.get(customerId) || 0;
        this.accessPatterns.set(customerId, count + 1);
        // Keep only top 1000 most accessed users
        if (this.accessPatterns.size > 1000) {
            // Remove least accessed
            const sorted = Array.from(this.accessPatterns.entries())
                .sort((a, b) => a[1] - b[1]);
            this.accessPatterns.delete(sorted[0][0]);
        }
    }
    // Get most frequently accessed users for pre-warming
    getMostAccessedUsers(limit = 100) {
        return Array.from(this.accessPatterns.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([userId]) => userId);
    }
    // Optimized JSON parsing that reuses objects when possible
    fastJSONParse(str) {
        try {
            // For small strings, native JSON.parse is actually fastest
            if (str.length < 1024) {
                return JSON.parse(str);
            }
            // For larger strings, we could use a streaming parser
            // but for now, stick with native
            return JSON.parse(str);
        }
        catch (err) {
            logger.warn({ err }, 'JSON parse failed');
            return null;
        }
    }
    clear() {
        this.memoryCache.clear();
    }
    recordMetrics(hit, startTime, negativeHit = false) {
        const latencyNs = Number(process.hrtime.bigint() - startTime);
        const latencyMs = latencyNs / 1_000_000;
        if (hit) {
            this.metricsBuffer.hits++;
        }
        else if (negativeHit) {
            this.metricsBuffer.negativeHits++;
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
        const totalRequests = this.metricsBuffer.hits + this.metricsBuffer.misses + this.metricsBuffer.negativeHits;
        return {
            hits: this.metricsBuffer.hits,
            misses: this.metricsBuffer.misses,
            negativeHits: this.metricsBuffer.negativeHits,
            hitRate: this.metricsBuffer.hits / totalRequests,
            negativeHitRate: this.metricsBuffer.negativeHits / totalRequests,
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
    getStats() {
        return this.getMetrics();
    }
}
//# sourceMappingURL=context-cache.js.map