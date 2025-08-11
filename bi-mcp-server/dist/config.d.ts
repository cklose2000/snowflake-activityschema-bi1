import { z } from 'zod';
declare const configSchema: z.ZodObject<{
    snowflake: z.ZodObject<{
        account: z.ZodDefault<z.ZodString>;
        username: z.ZodString;
        password: z.ZodString;
        warehouse: z.ZodDefault<z.ZodString>;
        database: z.ZodDefault<z.ZodString>;
        schema: z.ZodDefault<z.ZodString>;
        role: z.ZodDefault<z.ZodString>;
        queryTag: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        account: string;
        username: string;
        password: string;
        warehouse: string;
        database: string;
        schema: string;
        role: string;
        queryTag: string;
    }, {
        username: string;
        password: string;
        account?: string | undefined;
        warehouse?: string | undefined;
        database?: string | undefined;
        schema?: string | undefined;
        role?: string | undefined;
        queryTag?: string | undefined;
    }>;
    redis: z.ZodObject<{
        host: z.ZodDefault<z.ZodString>;
        port: z.ZodDefault<z.ZodNumber>;
        password: z.ZodOptional<z.ZodString>;
        db: z.ZodDefault<z.ZodNumber>;
        keyPrefix: z.ZodDefault<z.ZodString>;
        ttl: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        host: string;
        port: number;
        db: number;
        keyPrefix: string;
        ttl: number;
        password?: string | undefined;
    }, {
        password?: string | undefined;
        host?: string | undefined;
        port?: number | undefined;
        db?: number | undefined;
        keyPrefix?: string | undefined;
        ttl?: number | undefined;
    }>;
    cache: z.ZodObject<{
        maxSize: z.ZodDefault<z.ZodNumber>;
        ttl: z.ZodDefault<z.ZodNumber>;
        warmupInterval: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        ttl: number;
        maxSize: number;
        warmupInterval: number;
    }, {
        ttl?: number | undefined;
        maxSize?: number | undefined;
        warmupInterval?: number | undefined;
    }>;
    queue: z.ZodObject<{
        path: z.ZodDefault<z.ZodString>;
        maxSize: z.ZodDefault<z.ZodNumber>;
        maxAge: z.ZodDefault<z.ZodNumber>;
        maxEvents: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        maxSize: number;
        maxAge: number;
        maxEvents: number;
    }, {
        path?: string | undefined;
        maxSize?: number | undefined;
        maxAge?: number | undefined;
        maxEvents?: number | undefined;
    }>;
    performance: z.ZodObject<{
        firstTokenLatency: z.ZodDefault<z.ZodNumber>;
        getContextP95: z.ZodDefault<z.ZodNumber>;
        submitQueryTimeout: z.ZodDefault<z.ZodNumber>;
        logEventTimeout: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        firstTokenLatency: number;
        getContextP95: number;
        submitQueryTimeout: number;
        logEventTimeout: number;
    }, {
        firstTokenLatency?: number | undefined;
        getContextP95?: number | undefined;
        submitQueryTimeout?: number | undefined;
        logEventTimeout?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    snowflake: {
        account: string;
        username: string;
        password: string;
        warehouse: string;
        database: string;
        schema: string;
        role: string;
        queryTag: string;
    };
    redis: {
        host: string;
        port: number;
        db: number;
        keyPrefix: string;
        ttl: number;
        password?: string | undefined;
    };
    cache: {
        ttl: number;
        maxSize: number;
        warmupInterval: number;
    };
    queue: {
        path: string;
        maxSize: number;
        maxAge: number;
        maxEvents: number;
    };
    performance: {
        firstTokenLatency: number;
        getContextP95: number;
        submitQueryTimeout: number;
        logEventTimeout: number;
    };
}, {
    snowflake: {
        username: string;
        password: string;
        account?: string | undefined;
        warehouse?: string | undefined;
        database?: string | undefined;
        schema?: string | undefined;
        role?: string | undefined;
        queryTag?: string | undefined;
    };
    redis: {
        password?: string | undefined;
        host?: string | undefined;
        port?: number | undefined;
        db?: number | undefined;
        keyPrefix?: string | undefined;
        ttl?: number | undefined;
    };
    cache: {
        ttl?: number | undefined;
        maxSize?: number | undefined;
        warmupInterval?: number | undefined;
    };
    queue: {
        path?: string | undefined;
        maxSize?: number | undefined;
        maxAge?: number | undefined;
        maxEvents?: number | undefined;
    };
    performance: {
        firstTokenLatency?: number | undefined;
        getContextP95?: number | undefined;
        submitQueryTimeout?: number | undefined;
        logEventTimeout?: number | undefined;
    };
}>;
export type Config = z.infer<typeof configSchema>;
export declare function loadConfig(): Config;
export {};
//# sourceMappingURL=config.d.ts.map