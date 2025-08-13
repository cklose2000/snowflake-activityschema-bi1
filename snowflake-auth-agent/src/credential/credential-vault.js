"use strict";
/**
 * Secure Credential Vault for Snowflake Authentication
 *
 * Provides encrypted storage and management of multiple Snowflake accounts
 * with intelligent rotation and failover capabilities.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialVault = void 0;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const pino_1 = __importDefault(require("pino"));
const zod_1 = require("zod");
const logger = (0, pino_1.default)({ name: 'credential-vault' });
// Account configuration schema
const AccountConfigSchema = zod_1.z.object({
    username: zod_1.z.string().min(1),
    password: zod_1.z.string().min(1),
    priority: zod_1.z.number().min(1).max(10),
    maxFailures: zod_1.z.number().default(3),
    cooldownMs: zod_1.z.number().default(300000), // 5 minutes
    maxConnections: zod_1.z.number().default(15),
    role: zod_1.z.string().default('CLAUDE_DESKTOP_ROLE'),
    warehouse: zod_1.z.string().default('COMPUTE_WH'),
    database: zod_1.z.string().default('CLAUDE_LOGS'),
    schema: zod_1.z.string().default('ACTIVITIES'),
    account: zod_1.z.string().default('yshmxno-fbc56289'),
    isActive: zod_1.z.boolean().default(true),
    lastSuccess: zod_1.z.string().optional(),
    lastFailure: zod_1.z.string().optional(),
    consecutiveFailures: zod_1.z.number().default(0),
    inCooldown: zod_1.z.boolean().default(false),
    cooldownUntil: zod_1.z.string().optional(),
});
const CredentialConfigSchema = zod_1.z.object({
    accounts: zod_1.z.array(AccountConfigSchema),
    encryption: zod_1.z.object({
        algorithm: zod_1.z.string().default('aes-256-cbc'),
        keyDerivation: zod_1.z.string().default('pbkdf2'),
        iterations: zod_1.z.number().default(100000),
    }),
    failover: zod_1.z.object({
        enabled: zod_1.z.boolean().default(true),
        maxRetries: zod_1.z.number().default(3),
        backoffMultiplier: zod_1.z.number().default(2),
        maxBackoffMs: zod_1.z.number().default(300000),
    }),
});
class CredentialVault {
    config;
    encryptionKey;
    configPath;
    activeAccountIndex = 0;
    constructor(configPath, encryptionKey) {
        this.configPath = configPath || (0, path_1.resolve)(process.cwd(), 'config/accounts.encrypted.json');
        this.encryptionKey = encryptionKey || process.env.VAULT_ENCRYPTION_KEY || this.generateKey();
        this.config = this.loadConfig();
    }
    /**
     * Initialize vault with default accounts if config doesn't exist
     */
    async initialize() {
        if (!(0, fs_1.existsSync)(this.configPath)) {
            logger.info('Creating credential configuration from environment');
            // Read multi-account configuration from environment
            const accountNames = (process.env.SNOWFLAKE_ACCOUNTS || 'CLAUDE_DESKTOP1').split(',');
            const passwords = (process.env.SNOWFLAKE_PASSWORDS || process.env.SNOWFLAKE_PASSWORD || 'Password123!').split(',');
            const priorities = (process.env.SNOWFLAKE_ACCOUNT_PRIORITIES || '1,2,3').split(',').map(Number);
            const maxFailures = (process.env.SNOWFLAKE_MAX_FAILURES || '3,3,2').split(',').map(Number);
            const cooldownMs = (process.env.SNOWFLAKE_COOLDOWN_MS || '300000,300000,180000').split(',').map(Number);
            // Create account configurations
            const accounts = accountNames.map((username, index) => ({
                username: username.trim(),
                password: passwords[index] || passwords[0] || 'Password123!',
                priority: priorities[index] || index + 1,
                account: process.env.SNOWFLAKE_ACCOUNT || 'yshmxno-fbc56289',
                role: process.env.SNOWFLAKE_ROLE || 'CLAUDE_DESKTOP_ROLE',
                warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
                database: process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS',
                schema: process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES',
                maxFailures: maxFailures[index] || 3,
                cooldownMs: cooldownMs[index] || 300000,
                maxConnections: index === 0 ? 15 : index === 1 ? 10 : 5,
                isActive: true,
                consecutiveFailures: 0,
                inCooldown: false,
            }));
            const defaultConfig = {
                accounts,
                encryption: {
                    algorithm: 'aes-256-cbc',
                    keyDerivation: 'pbkdf2',
                    iterations: 100000,
                },
                failover: {
                    enabled: true,
                    maxRetries: 3,
                    backoffMultiplier: 2,
                    maxBackoffMs: 300000,
                },
            };
            await this.saveConfig(defaultConfig);
            this.config = defaultConfig;
        }
        logger.info({
            totalAccounts: this.config.accounts.length,
            activeAccounts: this.getActiveAccounts().length,
        }, 'Credential vault initialized');
    }
    /**
     * Get the next available account for authentication
     */
    getNextAccount() {
        const activeAccounts = this.getActiveAccounts()
            .filter(account => !account.inCooldown)
            .sort((a, b) => a.priority - b.priority);
        if (activeAccounts.length === 0) {
            logger.error('No available accounts for authentication');
            return null;
        }
        // Try to use the current active account first
        let account = activeAccounts[this.activeAccountIndex % activeAccounts.length];
        // If current account is in cooldown or has too many failures, find next available
        if (account.inCooldown || account.consecutiveFailures >= account.maxFailures) {
            const nextAccount = activeAccounts.find(acc => !acc.inCooldown &&
                acc.consecutiveFailures < acc.maxFailures);
            if (!nextAccount) {
                logger.warn('All accounts are either in cooldown or have exceeded failure limits');
                return null;
            }
            account = nextAccount;
        }
        logger.debug({ username: account.username, priority: account.priority }, 'Selected account for authentication');
        return account;
    }
    /**
     * Record successful authentication
     */
    async recordSuccess(username) {
        const accountIndex = this.config.accounts.findIndex(acc => acc.username === username);
        if (accountIndex === -1)
            return;
        const account = this.config.accounts[accountIndex];
        account.lastSuccess = new Date().toISOString();
        account.consecutiveFailures = 0;
        account.inCooldown = false;
        account.cooldownUntil = undefined;
        this.activeAccountIndex = accountIndex;
        await this.saveConfig(this.config);
        logger.info({ username, priority: account.priority }, 'Authentication success recorded');
    }
    /**
     * Record authentication failure and apply circuit breaker logic
     */
    async recordFailure(username, error) {
        const accountIndex = this.config.accounts.findIndex(acc => acc.username === username);
        if (accountIndex === -1)
            return;
        const account = this.config.accounts[accountIndex];
        account.lastFailure = new Date().toISOString();
        account.consecutiveFailures++;
        // Apply circuit breaker logic
        if (account.consecutiveFailures >= account.maxFailures) {
            account.inCooldown = true;
            account.cooldownUntil = new Date(Date.now() + account.cooldownMs).toISOString();
            logger.warn({
                username,
                consecutiveFailures: account.consecutiveFailures,
                maxFailures: account.maxFailures,
                cooldownUntil: account.cooldownUntil,
            }, 'Account placed in cooldown due to excessive failures');
        }
        await this.saveConfig(this.config);
        logger.error({
            username,
            consecutiveFailures: account.consecutiveFailures,
            maxFailures: account.maxFailures,
            error
        }, 'Authentication failure recorded');
    }
    /**
     * Manually unlock an account (admin operation)
     */
    async unlockAccount(username) {
        const accountIndex = this.config.accounts.findIndex(acc => acc.username === username);
        if (accountIndex === -1) {
            logger.error({ username }, 'Cannot unlock unknown account');
            return false;
        }
        const account = this.config.accounts[accountIndex];
        account.consecutiveFailures = 0;
        account.inCooldown = false;
        account.cooldownUntil = undefined;
        account.isActive = true;
        await this.saveConfig(this.config);
        logger.info({ username }, 'Account manually unlocked');
        return true;
    }
    /**
     * Get all accounts sorted by priority
     */
    getAllAccounts() {
        return [...this.config.accounts].sort((a, b) => a.priority - b.priority);
    }
    /**
     * Get active accounts not in cooldown
     */
    getActiveAccounts() {
        const now = Date.now();
        return this.config.accounts
            .filter(account => {
            if (!account.isActive)
                return false;
            // Check if cooldown has expired
            if (account.inCooldown && account.cooldownUntil) {
                const cooldownExpires = new Date(account.cooldownUntil).getTime();
                if (now > cooldownExpires) {
                    // Cooldown expired, clear it
                    account.inCooldown = false;
                    account.cooldownUntil = undefined;
                    // Don't reset consecutive failures automatically
                }
            }
            return !account.inCooldown;
        })
            .sort((a, b) => a.priority - b.priority);
    }
    /**
     * Get account health status for monitoring
     */
    getHealthStatus() {
        return this.config.accounts.map(account => {
            // Calculate health score (0-100)
            let healthScore = 100;
            if (account.consecutiveFailures > 0) {
                healthScore -= (account.consecutiveFailures / account.maxFailures) * 50;
            }
            if (account.inCooldown) {
                healthScore -= 50;
            }
            if (!account.isActive) {
                healthScore = 0;
            }
            return {
                username: account.username,
                priority: account.priority,
                isActive: account.isActive,
                inCooldown: account.inCooldown,
                consecutiveFailures: account.consecutiveFailures,
                maxFailures: account.maxFailures,
                lastSuccess: account.lastSuccess,
                lastFailure: account.lastFailure,
                cooldownUntil: account.cooldownUntil,
                healthScore: Math.max(0, Math.round(healthScore)),
            };
        });
    }
    /**
     * Load and decrypt configuration from file
     */
    loadConfig() {
        if (!(0, fs_1.existsSync)(this.configPath)) {
            logger.info('Configuration file not found, will create default');
            return {
                accounts: [],
                encryption: {
                    algorithm: 'aes-256-cbc',
                    keyDerivation: 'pbkdf2',
                    iterations: 100000,
                },
                failover: {
                    enabled: true,
                    maxRetries: 3,
                    backoffMultiplier: 2,
                    maxBackoffMs: 300000,
                },
            };
        }
        try {
            const encryptedData = (0, fs_1.readFileSync)(this.configPath, 'utf-8');
            const decryptedData = this.decrypt(encryptedData);
            const config = JSON.parse(decryptedData);
            return CredentialConfigSchema.parse(config);
        }
        catch (error) {
            logger.error({ error, configPath: this.configPath }, 'Failed to load credential configuration');
            throw new Error(`Failed to load credential configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Encrypt and save configuration to file
     */
    async saveConfig(config) {
        try {
            const configData = JSON.stringify(config, null, 2);
            const encryptedData = this.encrypt(configData);
            (0, fs_1.writeFileSync)(this.configPath, encryptedData, 'utf-8');
            logger.debug('Configuration saved successfully');
        }
        catch (error) {
            logger.error({ error, configPath: this.configPath }, 'Failed to save credential configuration');
            throw new Error(`Failed to save credential configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Encrypt data using AES-256-CBC
     */
    encrypt(text) {
        const iv = (0, crypto_1.randomBytes)(16);
        const salt = (0, crypto_1.randomBytes)(32);
        const key = (0, crypto_1.scryptSync)(this.encryptionKey, salt, 32);
        const cipher = (0, crypto_1.createCipheriv)('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return salt.toString('hex') + ':' + iv.toString('hex') + ':' + encrypted;
    }
    /**
     * Decrypt data using AES-256-CBC
     */
    decrypt(encryptedData) {
        const parts = encryptedData.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted data format');
        }
        const salt = Buffer.from(parts[0], 'hex');
        const iv = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];
        const key = (0, crypto_1.scryptSync)(this.encryptionKey, salt, 32);
        const decipher = (0, crypto_1.createDecipheriv)('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
    /**
     * Generate a secure encryption key
     */
    generateKey() {
        return (0, crypto_1.randomBytes)(32).toString('hex');
    }
}
exports.CredentialVault = CredentialVault;
//# sourceMappingURL=credential-vault.js.map