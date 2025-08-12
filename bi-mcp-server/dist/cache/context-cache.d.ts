export interface ContextData {
    context: Record<string, any>;
    updated_at: string;
    version?: number;
}
export declare class ContextCache {
    private memoryCache;
    private redis;
    private readonly keyPrefix;
    private readonly ttl;
    private bloomFilter;
    private accessPatterns;
    private preloadedUsers;
    private metricsBuffer;
    constructor(maxSize?: number, // Increased from 1000 to 10000 for better hit rate
    ttl?: number, // 5 minutes (increased from 1 minute)
    redisConfig?: {
        host: string;
        port: number;
        password?: string;
        db?: number;
        keyPrefix?: string;
    });
    get(customerId: string): Promise<ContextData | null>;
    set(customerId: string, data: ContextData): Promise<void>;
    warmup(customerIds: string[]): Promise<void>;
    private trackAccess;
    getMostAccessedUsers(limit?: number): string[];
    private fastJSONParse;
    clear(): void;
    private recordMetrics;
    getMetrics(): {
        hits: number;
        misses: number;
        negativeHits: number;
        hitRate: number;
        negativeHitRate: number;
        p50Latency: number;
        p95Latency: number;
        p99Latency: number;
        memoryCacheSize: number;
        redisConnected: boolean;
    };
    close(): Promise<void>;
    getStats(): {
        hits: number;
        misses: number;
        negativeHits: number;
        hitRate: number;
        negativeHitRate: number;
        p50Latency: number;
        p95Latency: number;
        p99Latency: number;
        memoryCacheSize: number;
        redisConnected: boolean;
    };
}
//# sourceMappingURL=context-cache.d.ts.map