import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createWriteStream, WriteStream } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';

const logger = pino.default({ name: 'ndjson-queue' });

export interface QueueEvent {
  activity_id?: string;
  activity: string;
  customer: string;
  ts?: string;
  link?: string;
  revenue_impact?: number;
  feature_json?: Record<string, any>;  // Will be stored as _feature_json
  session_id?: string;                  // Will be stored as _session_id
  query_tag?: string;                   // Will be stored as _query_tag
}

export class NDJSONQueue {
  private stream: WriteStream | null = null;
  private currentPath: string;
  private baseDir: string;
  private currentSize: number = 0;
  private eventCount: number = 0;
  private rotationTimer: NodeJS.Timeout | null = null;
  private readonly maxSize: number;
  private readonly maxAge: number;
  private readonly maxEvents: number;
  private isRotating: boolean = false;
  private writeBuffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    basePath: string,
    maxSize: number = 16 * 1024 * 1024, // 16MB
    maxAge: number = 60000, // 60s
    maxEvents: number = 100000
  ) {
    this.baseDir = dirname(basePath);
    this.currentPath = this.generateFilePath();
    this.maxSize = maxSize;
    this.maxAge = maxAge;
    this.maxEvents = maxEvents;
  }

  async initialize(): Promise<void> {
    // Ensure directory exists
    await fs.mkdir(this.baseDir, { recursive: true });
    
    // Open initial stream
    await this.openStream();
    
    // Set rotation timer
    this.scheduleRotation();
  }

  private generateFilePath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(this.baseDir, `events_${timestamp}_${uuidv4().substring(0, 8)}.ndjson`);
  }

  private async openStream(): Promise<void> {
    this.currentPath = this.generateFilePath();
    this.stream = createWriteStream(this.currentPath, {
      flags: 'a',
      highWaterMark: 64 * 1024, // 64KB buffer
    });
    this.currentSize = 0;
    this.eventCount = 0;
    
    this.stream.on('error', (err) => {
      logger.error({ err }, 'Stream error');
    });
  }

  private scheduleRotation(): void {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }
    
    this.rotationTimer = setTimeout(() => {
      this.rotate().catch(err => {
        logger.error({ err }, 'Rotation error');
      });
    }, this.maxAge);
  }

  async rotate(): Promise<string | null> {
    if (this.isRotating || !this.stream) {
      return null;
    }
    
    this.isRotating = true;
    const oldPath = this.currentPath;
    
    try {
      // Flush any buffered writes
      await this.flush();
      
      // Close current stream with fsync
      await new Promise<void>((resolve) => {
        if (!this.stream) {
          resolve();
          return;
        }
        
        this.stream.end(() => {
          // Stream is closed, resolve
          resolve();
        });
      });
      
      // Open new stream
      await this.openStream();
      
      // Reschedule rotation
      this.scheduleRotation();
      
      logger.info({ oldPath, newPath: this.currentPath }, 'Rotated queue file');
      return oldPath;
      
    } finally {
      this.isRotating = false;
    }
  }

  async write(event: QueueEvent): Promise<void> {
    // Apply backpressure if too many events
    if (this.eventCount >= this.maxEvents) {
      throw new Error('Queue backpressure: too many events');
    }
    
    // Add defaults
    const enrichedEvent = {
      activity_id: event.activity_id || uuidv4(),
      ts: event.ts || new Date().toISOString(),
      ...event,
    };
    
    const line = JSON.stringify(enrichedEvent) + '\n';
    const lineSize = Buffer.byteLength(line);
    
    // Check if rotation needed
    if (this.currentSize + lineSize > this.maxSize) {
      await this.rotate();
    }
    
    // Buffer the write for better performance
    this.writeBuffer.push(line);
    this.currentSize += lineSize;
    this.eventCount++;
    
    // Flush buffer if it gets too large or schedule flush
    if (this.writeBuffer.length >= 100) {
      await this.flush();
    } else if (!this.flushTimer) {
      // Flush within 100ms for low latency
      this.flushTimer = setTimeout(() => {
        this.flush().catch(err => logger.error({ err }, 'Flush error'));
      }, 100);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    
    if (this.writeBuffer.length === 0 || !this.stream) {
      return;
    }
    
    const data = this.writeBuffer.join('');
    this.writeBuffer = [];
    
    return new Promise((resolve, reject) => {
      if (!this.stream) {
        reject(new Error('Stream not initialized'));
        return;
      }
      
      this.stream.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }
    
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    
    await this.flush();
    
    if (this.stream) {
      await new Promise<void>((resolve) => {
        this.stream!.end(() => resolve());
      });
    }
  }

  getStats() {
    return {
      currentPath: this.currentPath,
      currentSize: this.currentSize,
      eventCount: this.eventCount,
      bufferLength: this.writeBuffer.length,
    };
  }
}