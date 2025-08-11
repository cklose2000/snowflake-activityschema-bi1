import { z } from 'zod';
const configSchema = z.object({
    snowflake: z.object({
        account: z.string().default('FBC56289.us-east-1.aws'),
        username: z.string(),
        password: z.string(),
        warehouse: z.string().default('COMPUTE_XS'),
        database: z.string().default('ANALYTICS'),
        schema: z.string().default('ACTIVITY'),
        role: z.string().default('ACCOUNTADMIN'),
        queryTag: z.string().default('cdesk'),
    }),
    redis: z.object({
        host: z.string().default('localhost'),
        port: z.number().default(6379),
        password: z.string().optional(),
        db: z.number().default(0),
        keyPrefix: z.string().default('bi:'),
        ttl: z.number().default(300), // 5 minutes
    }),
    cache: z.object({
        maxSize: z.number().default(1000),
        ttl: z.number().default(60000), // 1 minute in ms
        warmupInterval: z.number().default(300000), // 5 minutes
    }),
    queue: z.object({
        path: z.string().default('./data/events.ndjson'),
        maxSize: z.number().default(16 * 1024 * 1024), // 16MB
        maxAge: z.number().default(60000), // 60 seconds
        maxEvents: z.number().default(100000), // backpressure threshold
    }),
    performance: z.object({
        firstTokenLatency: z.number().default(300), // ms
        getContextP95: z.number().default(25), // ms - CRITICAL
        submitQueryTimeout: z.number().default(50), // ms
        logEventTimeout: z.number().default(10), // ms
    }),
});
export function loadConfig() {
    return configSchema.parse({
        snowflake: {
            account: process.env.SNOWFLAKE_ACCOUNT,
            username: process.env.SNOWFLAKE_USER || 'cklose2000',
            password: process.env.SNOWFLAKE_PASSWORD || '',
            warehouse: process.env.SNOWFLAKE_WAREHOUSE,
            database: process.env.SNOWFLAKE_DATABASE,
            schema: process.env.SNOWFLAKE_SCHEMA,
            role: process.env.SNOWFLAKE_ROLE,
        },
        redis: {
            host: process.env.REDIS_HOST,
            port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined,
            password: process.env.REDIS_PASSWORD,
            db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : undefined,
        },
        cache: {
            maxSize: process.env.CACHE_MAX_SIZE ? parseInt(process.env.CACHE_MAX_SIZE) : undefined,
            ttl: process.env.CACHE_TTL ? parseInt(process.env.CACHE_TTL) : undefined,
        },
        queue: {
            path: process.env.QUEUE_PATH,
            maxSize: process.env.QUEUE_MAX_SIZE ? parseInt(process.env.QUEUE_MAX_SIZE) : undefined,
            maxAge: process.env.QUEUE_MAX_AGE ? parseInt(process.env.QUEUE_MAX_AGE) : undefined,
            maxEvents: process.env.QUEUE_MAX_EVENTS ? parseInt(process.env.QUEUE_MAX_EVENTS) : undefined,
        },
        performance: {
            firstTokenLatency: process.env.PERF_FIRST_TOKEN ? parseInt(process.env.PERF_FIRST_TOKEN) : undefined,
            getContextP95: process.env.PERF_GET_CONTEXT_P95 ? parseInt(process.env.PERF_GET_CONTEXT_P95) : undefined,
            submitQueryTimeout: process.env.PERF_SUBMIT_QUERY ? parseInt(process.env.PERF_SUBMIT_QUERY) : undefined,
            logEventTimeout: process.env.PERF_LOG_EVENT ? parseInt(process.env.PERF_LOG_EVENT) : undefined,
        },
    });
}
//# sourceMappingURL=config.js.map