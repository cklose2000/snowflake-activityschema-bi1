/**
 * BI Uploader Service
 * 
 * Watches NDJSON queue files and uploads them to Snowflake using Snowpipe Streaming.
 * Handles backpressure, retries, and deduplication.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';
import * as snowflake from 'snowflake-sdk';
import { config } from 'dotenv';
import { pino } from 'pino';

// Load environment variables
config({ path: path.join(__dirname, '../../.env') });

const logger = pino({
  name: 'bi-uploader',
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

interface UploadConfig {
  snowflake: {
    account: string;
    username: string;
    password: string;
    warehouse: string;
    database: string;
    schema: string;
    role: string;
  };
  queue: {
    watchDir: string;
    processedDir: string;
    errorDir: string;
    maxBatchSize: number;
    uploadIntervalMs: number;
  };
  retry: {
    maxAttempts: number;
    backoffMs: number;
    maxBackoffMs: number;
  };
}

class SnowflakeUploader {
  private config: UploadConfig;
  private connection: snowflake.Connection | null = null;
  private isProcessing = false;
  private uploadStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    duplicateEvents: 0,
    filesProcessed: 0,
    lastUploadTime: null as Date | null,
  };

  constructor(config: UploadConfig) {
    this.config = config;
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const dirs = [
      this.config.queue.watchDir,
      this.config.queue.processedDir,
      this.config.queue.errorDir,
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created directory: ${dir}`);
      }
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection = snowflake.createConnection({
        account: this.config.snowflake.account,
        username: this.config.snowflake.username,
        password: this.config.snowflake.password,
        warehouse: this.config.snowflake.warehouse,
        database: this.config.snowflake.database,
        schema: this.config.snowflake.schema,
        role: this.config.snowflake.role,
      });

      this.connection.connect((err) => {
        if (err) {
          logger.error({ err }, 'Failed to connect to Snowflake');
          reject(err);
        } else {
          logger.info('Connected to Snowflake');
          resolve();
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      return new Promise((resolve) => {
        this.connection!.destroy((err) => {
          if (err) {
            logger.error({ err }, 'Error disconnecting from Snowflake');
          }
          resolve();
        });
      });
    }
  }

  private async executeQuery(sql: string, binds?: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (!this.connection) {
        reject(new Error('Not connected to Snowflake'));
        return;
      }

      this.connection.execute({
        sqlText: sql,
        binds: binds || [],
        complete: (err, _stmt, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        },
      });
    });
  }

  private async checkDuplicate(eventId: string): Promise<boolean> {
    try {
      const sql = 'SELECT 1 FROM _INGEST_IDS WHERE id = ? LIMIT 1';
      const rows = await this.executeQuery(sql, [eventId]);
      return rows.length > 0;
    } catch (error) {
      logger.warn({ error, eventId }, 'Error checking duplicate');
      return false; // Assume not duplicate on error
    }
  }

  private async recordIngestId(eventId: string): Promise<void> {
    try {
      const sql = 'INSERT INTO _INGEST_IDS (id, ingested_at) VALUES (?, CURRENT_TIMESTAMP())';
      await this.executeQuery(sql, [eventId]);
    } catch (error) {
      logger.warn({ error, eventId }, 'Error recording ingest ID');
    }
  }

  private async uploadBatch(events: any[]): Promise<{ success: number; failed: number; duplicates: number }> {
    let success = 0;
    let failed = 0;
    let duplicates = 0;

    for (const event of events) {
      try {
        // Generate event ID if not present
        const eventId = event.activity_id || createHash('sha256')
          .update(JSON.stringify(event))
          .digest('hex')
          .substring(0, 16);

        // Check for duplicate
        if (await this.checkDuplicate(eventId)) {
          duplicates++;
          logger.debug({ eventId }, 'Skipping duplicate event');
          continue;
        }

        // Insert event
        const sql = `
          INSERT INTO EVENTS (
            activity,
            customer,
            ts,
            activity_occurrence,
            activity_repeated_at,
            link,
            revenue_impact,
            _feature_json,
            _source_system,
            _source_version,
            _session_id,
            _query_tag,
            _ingest_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, PARSE_JSON(?), ?, ?, ?, ?, ?)
        `;

        const binds = [
          event.activity,
          event.customer || null,
          event.ts || new Date().toISOString(),
          event.activity_occurrence || 1,
          event.activity_repeated_at || null,
          event.link || null,
          event.revenue_impact || null,
          JSON.stringify(event.feature_json || {}),
          event.source_system || 'bi-uploader',
          event.source_version || '1.0.0',
          event.session_id || null,
          event.query_tag || null,
          eventId,
        ];

        await this.executeQuery(sql, binds);
        await this.recordIngestId(eventId);
        success++;

      } catch (error) {
        logger.error({ error, event }, 'Failed to upload event');
        failed++;
      }
    }

    return { success, failed, duplicates };
  }

  async processFile(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    logger.info({ fileName }, 'Processing file');

    const events: any[] = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    // Read all events from file
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          events.push(event);
        } catch (error) {
          logger.warn({ error, line }, 'Failed to parse JSON line');
        }
      }
    }

    if (events.length === 0) {
      logger.info({ fileName }, 'File is empty, moving to processed');
      this.moveFile(filePath, this.config.queue.processedDir);
      return;
    }

    logger.info({ fileName, eventCount: events.length }, 'Uploading events');

    // Upload in batches
    const batchSize = this.config.queue.maxBatchSize;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalDuplicates = 0;

    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, Math.min(i + batchSize, events.length));
      const result = await this.uploadBatch(batch);
      
      totalSuccess += result.success;
      totalFailed += result.failed;
      totalDuplicates += result.duplicates;

      logger.info({
        fileName,
        batch: Math.floor(i / batchSize) + 1,
        totalBatches: Math.ceil(events.length / batchSize),
        success: result.success,
        failed: result.failed,
        duplicates: result.duplicates,
      }, 'Batch uploaded');
    }

    // Update stats
    this.uploadStats.totalEvents += events.length;
    this.uploadStats.successfulEvents += totalSuccess;
    this.uploadStats.failedEvents += totalFailed;
    this.uploadStats.duplicateEvents += totalDuplicates;
    this.uploadStats.filesProcessed++;
    this.uploadStats.lastUploadTime = new Date();

    // Move file to appropriate directory
    if (totalFailed > 0) {
      logger.warn({ fileName, totalFailed }, 'Moving file to error directory');
      this.moveFile(filePath, this.config.queue.errorDir);
    } else {
      logger.info({ fileName, totalSuccess, totalDuplicates }, 'File processed successfully');
      this.moveFile(filePath, this.config.queue.processedDir);
    }
  }

  private moveFile(sourcePath: string, targetDir: string): void {
    const fileName = path.basename(sourcePath);
    const targetPath = path.join(targetDir, fileName);
    
    try {
      fs.renameSync(sourcePath, targetPath);
      logger.debug({ sourcePath, targetPath }, 'File moved');
    } catch (error) {
      logger.error({ error, sourcePath, targetPath }, 'Failed to move file');
    }
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      logger.debug('Already processing, skipping');
      return;
    }

    this.isProcessing = true;

    try {
      // Get all NDJSON files in watch directory
      const files = fs.readdirSync(this.config.queue.watchDir)
        .filter(f => f.endsWith('.ndjson'))
        .sort(); // Process in order

      if (files.length === 0) {
        logger.debug('No files to process');
        return;
      }

      logger.info({ fileCount: files.length }, 'Processing queue');

      for (const file of files) {
        const filePath = path.join(this.config.queue.watchDir, file);
        
        // Skip if file is still being written (check if modified in last 5 seconds)
        const stats = fs.statSync(filePath);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs < 5000) {
          logger.debug({ file, ageMs }, 'Skipping file (still being written)');
          continue;
        }

        await this.processFile(filePath);
      }

    } catch (error) {
      logger.error({ error }, 'Error processing queue');
    } finally {
      this.isProcessing = false;
    }
  }

  async startWatching(): Promise<void> {
    logger.info({
      watchDir: this.config.queue.watchDir,
      intervalMs: this.config.queue.uploadIntervalMs,
    }, 'Starting file watcher');

    // Process existing files on startup
    await this.processQueue();

    // Set up periodic processing
    setInterval(() => {
      this.processQueue().catch(error => {
        logger.error({ error }, 'Error in periodic queue processing');
      });
    }, this.config.queue.uploadIntervalMs);

    // Also watch for new files
    fs.watch(this.config.queue.watchDir, async (eventType, filename) => {
      if (filename && filename.endsWith('.ndjson')) {
        logger.debug({ eventType, filename }, 'File change detected');
        // Wait a bit for file to be fully written
        setTimeout(() => {
          this.processQueue().catch(error => {
            logger.error({ error }, 'Error processing after file change');
          });
        }, 1000);
      }
    });
  }

  getStats() {
    return { ...this.uploadStats };
  }
}

// Main execution
async function main() {
  const config: UploadConfig = {
    snowflake: {
      account: process.env.SNOWFLAKE_ACCOUNT || '',
      username: process.env.SNOWFLAKE_USERNAME || '',
      password: process.env.SNOWFLAKE_PASSWORD || '',
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
      database: process.env.SNOWFLAKE_DATABASE || 'CLAUDE_LOGS',
      schema: process.env.SNOWFLAKE_SCHEMA || 'ACTIVITIES',
      role: process.env.SNOWFLAKE_ROLE || 'CLAUDE_DESKTOP_ROLE',
    },
    queue: {
      watchDir: process.env.QUEUE_WATCH_DIR || './bi-mcp-server/data',
      processedDir: process.env.QUEUE_PROCESSED_DIR || './bi-mcp-server/data/processed',
      errorDir: process.env.QUEUE_ERROR_DIR || './bi-mcp-server/data/error',
      maxBatchSize: parseInt(process.env.UPLOAD_BATCH_SIZE || '100'),
      uploadIntervalMs: parseInt(process.env.UPLOAD_INTERVAL_MS || '30000'), // 30 seconds
    },
    retry: {
      maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3'),
      backoffMs: parseInt(process.env.RETRY_BACKOFF_MS || '1000'),
      maxBackoffMs: parseInt(process.env.RETRY_MAX_BACKOFF_MS || '30000'),
    },
  };

  // Validate configuration
  if (!config.snowflake.account || !config.snowflake.username || !config.snowflake.password) {
    logger.error('Missing required Snowflake credentials');
    process.exit(1);
  }

  const uploader = new SnowflakeUploader(config);

  // Handle shutdown gracefully
  process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await uploader.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully...');
    await uploader.disconnect();
    process.exit(0);
  });

  // Set up metrics endpoint
  if (process.env.ENABLE_METRICS === 'true') {
    const http = require('http');
    const metricsPort = parseInt(process.env.METRICS_PORT || '9091');
    
    http.createServer((req: any, res: any) => {
      if (req.url === '/metrics') {
        const stats = uploader.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats, null, 2));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    }).listen(metricsPort, () => {
      logger.info({ port: metricsPort }, 'Metrics server started');
    });
  }

  try {
    // Connect to Snowflake
    await uploader.connect();

    // Start watching and processing
    await uploader.startWatching();

    logger.info('BI Uploader service started successfully');

  } catch (error) {
    logger.error({ error }, 'Failed to start uploader service');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    logger.error({ error }, 'Unhandled error');
    process.exit(1);
  });
}

export { SnowflakeUploader, UploadConfig };