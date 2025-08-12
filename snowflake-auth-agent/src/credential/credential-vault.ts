/**
 * Secure Credential Vault for Snowflake Authentication
 * 
 * Provides encrypted storage and management of multiple Snowflake accounts
 * with intelligent rotation and failover capabilities.
 */

import { createCipher, createDecipher, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import pino from 'pino';
import { z } from 'zod';

const logger = pino({ name: 'credential-vault' });

// Account configuration schema
const AccountConfigSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  priority: z.number().min(1).max(10),
  maxFailures: z.number().default(3),
  cooldownMs: z.number().default(300000), // 5 minutes
  maxConnections: z.number().default(15),
  role: z.string().default('CLAUDE_DESKTOP_ROLE'),
  warehouse: z.string().default('COMPUTE_WH'),
  database: z.string().default('CLAUDE_LOGS'),
  schema: z.string().default('ACTIVITIES'),
  account: z.string().default('yshmxno-fbc56289'),
  isActive: z.boolean().default(true),
  lastSuccess: z.string().optional(),
  lastFailure: z.string().optional(),
  consecutiveFailures: z.number().default(0),
  inCooldown: z.boolean().default(false),
  cooldownUntil: z.string().optional(),
});

const CredentialConfigSchema = z.object({
  accounts: z.array(AccountConfigSchema),
  encryption: z.object({
    algorithm: z.string().default('aes-256-cbc'),
    keyDerivation: z.string().default('pbkdf2'),
    iterations: z.number().default(100000),
  }),
  failover: z.object({
    enabled: z.boolean().default(true),
    maxRetries: z.number().default(3),
    backoffMultiplier: z.number().default(2),
    maxBackoffMs: z.number().default(300000),
  }),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type CredentialConfig = z.infer<typeof CredentialConfigSchema>;

export interface AuthResult {
  success: boolean;
  account?: AccountConfig;
  error?: string;
  failedAccounts: string[];
}

export class CredentialVault {
  private config: CredentialConfig;
  private encryptionKey: string;
  private configPath: string;
  private activeAccountIndex: number = 0;

  constructor(configPath?: string, encryptionKey?: string) {
    this.configPath = configPath || resolve(process.cwd(), 'config/accounts.encrypted.json');
    this.encryptionKey = encryptionKey || process.env.VAULT_ENCRYPTION_KEY || this.generateKey();
    this.config = this.loadConfig();
  }

  /**
   * Initialize vault with default accounts if config doesn't exist
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.configPath)) {
      logger.info('Creating default credential configuration');
      
      const defaultConfig: CredentialConfig = {
        accounts: [
          {
            username: 'CLAUDE_DESKTOP1',
            password: process.env.SNOWFLAKE_PASSWORD || 'Password123!',
            priority: 1,
            account: process.env.SNOWFLAKE_ACCOUNT || 'yshmxno-fbc56289',
            role: process.env.SNOWFLAKE_ROLE || 'CLAUDE_DESKTOP_ROLE',
            warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
            database: process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS',
            schema: process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES',
            maxFailures: 3,
            cooldownMs: 300000,
            maxConnections: 15,
            isActive: true,
            consecutiveFailures: 0,
            inCooldown: false,
          },
          {
            username: 'CLAUDE_DESKTOP2',
            password: process.env.SNOWFLAKE_PASSWORD || 'Password123!',
            priority: 2,
            account: process.env.SNOWFLAKE_ACCOUNT || 'yshmxno-fbc56289',
            role: process.env.SNOWFLAKE_ROLE || 'CLAUDE_DESKTOP_ROLE',
            warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
            database: process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS',
            schema: process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES',
            maxFailures: 3,
            cooldownMs: 300000,
            maxConnections: 10,
            isActive: true,
            consecutiveFailures: 0,
            inCooldown: false,
          },
          {
            username: 'CLAUDE_DESKTOP_TEST',
            password: process.env.SNOWFLAKE_PASSWORD || 'Password123!',
            priority: 3,
            account: process.env.SNOWFLAKE_ACCOUNT || 'yshmxno-fbc56289',
            role: process.env.SNOWFLAKE_ROLE || 'CLAUDE_DESKTOP_ROLE',
            warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
            database: process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS',
            schema: process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES',
            maxFailures: 2,
            cooldownMs: 180000,
            maxConnections: 5,
            isActive: true,
            consecutiveFailures: 0,
            inCooldown: false,
          },
        ],
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
  getNextAccount(): AccountConfig | null {
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
      const nextAccount = activeAccounts.find(acc => 
        !acc.inCooldown && 
        acc.consecutiveFailures < acc.maxFailures
      );
      
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
  async recordSuccess(username: string): Promise<void> {
    const accountIndex = this.config.accounts.findIndex(acc => acc.username === username);
    if (accountIndex === -1) return;

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
  async recordFailure(username: string, error: string): Promise<void> {
    const accountIndex = this.config.accounts.findIndex(acc => acc.username === username);
    if (accountIndex === -1) return;

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
  async unlockAccount(username: string): Promise<boolean> {
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
  getAllAccounts(): AccountConfig[] {
    return [...this.config.accounts].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get active accounts not in cooldown
   */
  getActiveAccounts(): AccountConfig[] {
    const now = Date.now();
    
    return this.config.accounts
      .filter(account => {
        if (!account.isActive) return false;
        
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
  }> {
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
  private loadConfig(): CredentialConfig {
    if (!existsSync(this.configPath)) {
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
      const encryptedData = readFileSync(this.configPath, 'utf-8');
      const decryptedData = this.decrypt(encryptedData);
      const config = JSON.parse(decryptedData);
      
      return CredentialConfigSchema.parse(config);
    } catch (error) {
      logger.error({ error, configPath: this.configPath }, 'Failed to load credential configuration');
      throw new Error(`Failed to load credential configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Encrypt and save configuration to file
   */
  private async saveConfig(config: CredentialConfig): Promise<void> {
    try {
      const configData = JSON.stringify(config, null, 2);
      const encryptedData = this.encrypt(configData);
      writeFileSync(this.configPath, encryptedData, 'utf-8');
      
      logger.debug('Configuration saved successfully');
    } catch (error) {
      logger.error({ error, configPath: this.configPath }, 'Failed to save credential configuration');
      throw new Error(`Failed to save credential configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Encrypt data using AES-256-CBC
   */
  private encrypt(text: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(16);
    const cipher = createCipher('aes-256-cbc', this.encryptionKey);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return salt.toString('hex') + ':' + iv.toString('hex') + ':' + encrypted;
  }

  /**
   * Decrypt data using AES-256-CBC
   */
  private decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }
    
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    const decipher = createDecipher('aes-256-cbc', this.encryptionKey);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * Generate a secure encryption key
   */
  private generateKey(): string {
    return randomBytes(32).toString('hex');
  }
}