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
    private metricsBuffer;
    constructor(maxSize?: number, ttl?: number, // 1 minute
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
    clear(): void;
    private recordMetrics;
    getMetrics(): {
        hits: number;
        misses: number;
        hitRate: number;
        p50Latency: number;
        p95Latency: number;
        p99Latency: number;
        memoryCacheSize: number;
        redisConnected: boolean;
    };
    close(): Promise<void>;
}
//# sourceMappingURL=context-cache.d.ts.map