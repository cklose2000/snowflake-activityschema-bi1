/**
 * Secure Credential Vault for Snowflake Authentication
 *
 * Provides encrypted storage and management of multiple Snowflake accounts
 * with intelligent rotation and failover capabilities.
 */
import { z } from 'zod';
declare const AccountConfigSchema: z.ZodObject<{
    username: z.ZodString;
    password: z.ZodString;
    priority: z.ZodNumber;
    maxFailures: z.ZodDefault<z.ZodNumber>;
    cooldownMs: z.ZodDefault<z.ZodNumber>;
    maxConnections: z.ZodDefault<z.ZodNumber>;
    role: z.ZodDefault<z.ZodString>;
    warehouse: z.ZodDefault<z.ZodString>;
    database: z.ZodDefault<z.ZodString>;
    schema: z.ZodDefault<z.ZodString>;
    account: z.ZodDefault<z.ZodString>;
    isActive: z.ZodDefault<z.ZodBoolean>;
    lastSuccess: z.ZodOptional<z.ZodString>;
    lastFailure: z.ZodOptional<z.ZodString>;
    consecutiveFailures: z.ZodDefault<z.ZodNumber>;
    inCooldown: z.ZodDefault<z.ZodBoolean>;
    cooldownUntil: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    account: string;
    username: string;
    password: string;
    warehouse: string;
    database: string;
    schema: string;
    role: string;
    priority: number;
    maxFailures: number;
    cooldownMs: number;
    maxConnections: number;
    isActive: boolean;
    consecutiveFailures: number;
    inCooldown: boolean;
    lastSuccess?: string | undefined;
    lastFailure?: string | undefined;
    cooldownUntil?: string | undefined;
}, {
    username: string;
    password: string;
    priority: number;
    account?: string | undefined;
    warehouse?: string | undefined;
    database?: string | undefined;
    schema?: string | undefined;
    role?: string | undefined;
    maxFailures?: number | undefined;
    cooldownMs?: number | undefined;
    maxConnections?: number | undefined;
    isActive?: boolean | undefined;
    lastSuccess?: string | undefined;
    lastFailure?: string | undefined;
    consecutiveFailures?: number | undefined;
    inCooldown?: boolean | undefined;
    cooldownUntil?: string | undefined;
}>;
declare const CredentialConfigSchema: z.ZodObject<{
    accounts: z.ZodArray<z.ZodObject<{
        username: z.ZodString;
        password: z.ZodString;
        priority: z.ZodNumber;
        maxFailures: z.ZodDefault<z.ZodNumber>;
        cooldownMs: z.ZodDefault<z.ZodNumber>;
        maxConnections: z.ZodDefault<z.ZodNumber>;
        role: z.ZodDefault<z.ZodString>;
        warehouse: z.ZodDefault<z.ZodString>;
        database: z.ZodDefault<z.ZodString>;
        schema: z.ZodDefault<z.ZodString>;
        account: z.ZodDefault<z.ZodString>;
        isActive: z.ZodDefault<z.ZodBoolean>;
        lastSuccess: z.ZodOptional<z.ZodString>;
        lastFailure: z.ZodOptional<z.ZodString>;
        consecutiveFailures: z.ZodDefault<z.ZodNumber>;
        inCooldown: z.ZodDefault<z.ZodBoolean>;
        cooldownUntil: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        account: string;
        username: string;
        password: string;
        warehouse: string;
        database: string;
        schema: string;
        role: string;
        priority: number;
        maxFailures: number;
        cooldownMs: number;
        maxConnections: number;
        isActive: boolean;
        consecutiveFailures: number;
        inCooldown: boolean;
        lastSuccess?: string | undefined;
        lastFailure?: string | undefined;
        cooldownUntil?: string | undefined;
    }, {
        username: string;
        password: string;
        priority: number;
        account?: string | undefined;
        warehouse?: string | undefined;
        database?: string | undefined;
        schema?: string | undefined;
        role?: string | undefined;
        maxFailures?: number | undefined;
        cooldownMs?: number | undefined;
        maxConnections?: number | undefined;
        isActive?: boolean | undefined;
        lastSuccess?: string | undefined;
        lastFailure?: string | undefined;
        consecutiveFailures?: number | undefined;
        inCooldown?: boolean | undefined;
        cooldownUntil?: string | undefined;
    }>, "many">;
    encryption: z.ZodObject<{
        algorithm: z.ZodDefault<z.ZodString>;
        keyDerivation: z.ZodDefault<z.ZodString>;
        iterations: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        algorithm: string;
        keyDerivation: string;
        iterations: number;
    }, {
        algorithm?: string | undefined;
        keyDerivation?: string | undefined;
        iterations?: number | undefined;
    }>;
    failover: z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        maxRetries: z.ZodDefault<z.ZodNumber>;
        backoffMultiplier: z.ZodDefault<z.ZodNumber>;
        maxBackoffMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        maxRetries: number;
        backoffMultiplier: number;
        maxBackoffMs: number;
    }, {
        enabled?: boolean | undefined;
        maxRetries?: number | undefined;
        backoffMultiplier?: number | undefined;
        maxBackoffMs?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    accounts: {
        account: string;
        username: string;
        password: string;
        warehouse: string;
        database: string;
        schema: string;
        role: string;
        priority: number;
        maxFailures: number;
        cooldownMs: number;
        maxConnections: number;
        isActive: boolean;
        consecutiveFailures: number;
        inCooldown: boolean;
        lastSuccess?: string | undefined;
        lastFailure?: string | undefined;
        cooldownUntil?: string | undefined;
    }[];
    encryption: {
        algorithm: string;
        keyDerivation: string;
        iterations: number;
    };
    failover: {
        enabled: boolean;
        maxRetries: number;
        backoffMultiplier: number;
        maxBackoffMs: number;
    };
}, {
    accounts: {
        username: string;
        password: string;
        priority: number;
        account?: string | undefined;
        warehouse?: string | undefined;
        database?: string | undefined;
        schema?: string | undefined;
        role?: string | undefined;
        maxFailures?: number | undefined;
        cooldownMs?: number | undefined;
        maxConnections?: number | undefined;
        isActive?: boolean | undefined;
        lastSuccess?: string | undefined;
        lastFailure?: string | undefined;
        consecutiveFailures?: number | undefined;
        inCooldown?: boolean | undefined;
        cooldownUntil?: string | undefined;
    }[];
    encryption: {
        algorithm?: string | undefined;
        keyDerivation?: string | undefined;
        iterations?: number | undefined;
    };
    failover: {
        enabled?: boolean | undefined;
        maxRetries?: number | undefined;
        backoffMultiplier?: number | undefined;
        maxBackoffMs?: number | undefined;
    };
}>;
export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type CredentialConfig = z.infer<typeof CredentialConfigSchema>;
export interface AuthResult {
    success: boolean;
    account?: AccountConfig;
    error?: string;
    failedAccounts: string[];
}
export declare class CredentialVault {
    private config;
    private encryptionKey;
    private configPath;
    private activeAccountIndex;
    constructor(configPath?: string, encryptionKey?: string);
    /**
     * Initialize vault with default accounts if config doesn't exist
     */
    initialize(): Promise<void>;
    /**
     * Get the next available account for authentication
     */
    getNextAccount(): AccountConfig | null;
    /**
     * Record successful authentication
     */
    recordSuccess(username: string): Promise<void>;
    /**
     * Record authentication failure and apply circuit breaker logic
     */
    recordFailure(username: string, error: string): Promise<void>;
    /**
     * Manually unlock an account (admin operation)
     */
    unlockAccount(username: string): Promise<boolean>;
    /**
     * Get all accounts sorted by priority
     */
    getAllAccounts(): AccountConfig[];
    /**
     * Get active accounts not in cooldown
     */
    getActiveAccounts(): AccountConfig[];
    /**
     * Get account health status for monitoring
     */
    getHealthStatus(): Array<{
        username: string;
        priority: number;
        isActive: boolean;
        inCooldown: boolean;
        consecutiveFailures: number;
        maxFailures: number;
        lastSuccess?: string;
        lastFailure?: string;
        cooldownUntil?: string;
        healthScore: number;
    }>;
    /**
     * Load and decrypt configuration from file
     */
    private loadConfig;
    /**
     * Encrypt and save configuration to file
     */
    private saveConfig;
    /**
     * Encrypt data using AES-256-CBC
     */
    private encrypt;
    /**
     * Decrypt data using AES-256-CBC
     */
    private decrypt;
    /**
     * Generate a secure encryption key
     */
    private generateKey;
}
export {};
//# sourceMappingURL=credential-vault.d.ts.map