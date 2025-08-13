/**
 * Insight Atoms - Structured Memory System
 * 
 * The ONLY authoritative recall mechanism for the BI system.
 * Stores subject-metric-value triplets with provenance tracking.
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import pino from 'pino';
import { SnowflakeClient } from '../db/snowflake-client.js';

const logger = pino.default({ name: 'insight-atoms' });

export interface InsightAtom {
  atom_id: string;
  customer_id: string;
  subject: string;           // Entity being measured (e.g., "user_behavior", "query_performance")
  metric: string;            // Metric name (e.g., "avg_latency", "login_count")
  value: any;                // Metric value (can be number, string, object)
  provenance_query_hash: string; // SHA-256 hash of source query (16 chars)
  ts: string;                // Timestamp when atom was created
  ttl?: number;              // Time-to-live in seconds (optional)
}

export interface QueryProvenance {
  query_hash: string;
  template_name: string;
  query_text: string;
  parameters: any[];
  created_at: string;
  created_by: string;
}

export class InsightAtoms {
  private snowflakeClient: SnowflakeClient | null = null;
  private localCache: Map<string, InsightAtom[]> = new Map(); // customer_id -> atoms
  private provenanceCache: Map<string, QueryProvenance> = new Map(); // hash -> provenance
  private readonly maxCacheSize = 1000;

  constructor(snowflakeClient?: SnowflakeClient) {
    this.snowflakeClient = snowflakeClient || null;
    
    // Clean up expired atoms periodically
    setInterval(() => {
      this.cleanupExpiredAtoms();
    }, 300000); // Every 5 minutes
  }

  /**
   * Generate provenance hash for a query
   */
  generateProvenanceHash(template: string, params: any[]): string {
    const normalized = template.replace(/\s+/g, ' ').trim();
    const paramString = JSON.stringify(params, Object.keys(params).sort());
    const fullString = normalized + paramString;
    
    return createHash('sha256')
      .update(fullString)
      .digest('hex')
      .substring(0, 16); // 16 character hash
  }

  /**
   * Store query provenance for audit trail
   */
  async storeProvenance(
    template: string, 
    params: any[], 
    queryText?: string,
    createdBy?: string
  ): Promise<string> {
    const hash = this.generateProvenanceHash(template, params);
    
    const provenance: QueryProvenance = {
      query_hash: hash,
      template_name: template,
      query_text: queryText || template,
      parameters: params,
      created_at: new Date().toISOString(),
      created_by: createdBy || 'system',
    };
    
    // Cache locally
    this.provenanceCache.set(hash, provenance);
    
    // Store in Snowflake if available
    if (this.snowflakeClient) {
      try {
        await this.snowflakeClient.executeTemplate('LOG_PROVENANCE', [
          hash,
          template,
          queryText || template,
          JSON.stringify(params),
          createdBy || 'system'
        ]);
      } catch (error) {
        logger.warn({ error, hash }, 'Failed to store provenance in Snowflake');
      }
    }
    
    return hash;
  }

  /**
   * Record an insight atom
   */
  async record(
    customerId: string,
    subject: string,
    metric: string,
    value: any,
    provenanceHash?: string,
    ttl?: number
  ): Promise<string> {
    const atomId = uuidv4();
    const atom: InsightAtom = {
      atom_id: atomId,
      customer_id: customerId,
      subject,
      metric,
      value,
      provenance_query_hash: provenanceHash || '',
      ts: new Date().toISOString(),
      ttl,
    };
    
    // Store in local cache
    const customerAtoms = this.localCache.get(customerId) || [];
    customerAtoms.push(atom);
    this.localCache.set(customerId, customerAtoms);
    
    // Limit cache size per customer
    if (customerAtoms.length > 100) {
      customerAtoms.splice(0, customerAtoms.length - 100);
    }
    
    // Store in Snowflake if available
    if (this.snowflakeClient) {
      try {
        await this.snowflakeClient.executeTemplate('LOG_INSIGHT', [
          atomId,
          customerId,
          subject,
          metric,
          value
        ]);
        
        logger.debug({ atomId, customerId, subject, metric }, 'Insight atom stored');
      } catch (error) {
        logger.error({ error, atomId }, 'Failed to store insight atom in Snowflake');
        throw error;
      }
    }
    
    return atomId;
  }

  /**
   * Query insights by subject and metric
   */
  async query(
    customerId: string,
    subject?: string,
    metric?: string,
    limit: number = 100
  ): Promise<InsightAtom[]> {
    // First try local cache
    const cached = this.localCache.get(customerId) || [];
    let localResults = cached.filter(atom => {
      if (subject && atom.subject !== subject) return false;
      if (metric && atom.metric !== metric) return false;
      if (atom.ttl && this.isExpired(atom)) return false;
      return true;
    });
    
    // If we have enough results locally, return them
    if (localResults.length >= limit) {
      return localResults
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
        .slice(0, limit);
    }
    
    // Query Snowflake for more complete results
    if (this.snowflakeClient) {
      try {
        const params = [customerId];
        let templateName = 'GET_INSIGHTS_BY_CUSTOMER';
        
        if (subject && metric) {
          templateName = 'GET_INSIGHTS_BY_SUBJECT_METRIC';
          params.push(subject, metric, limit.toString());
        } else if (subject) {
          templateName = 'GET_INSIGHTS_BY_SUBJECT';
          params.push(subject, limit.toString());
        } else {
          params.push(limit.toString());
        }
        
        const result = await this.snowflakeClient.executeTemplate(templateName, params);
        
        if (result.rows) {
          const atoms: InsightAtom[] = result.rows.map((row: any) => ({
            atom_id: row.ATOM_ID,
            customer_id: row.CUSTOMER,
            subject: row.SUBJECT,
            metric: row.METRIC,
            value: row.VALUE, // Already parsed by Snowflake PARSE_JSON
            provenance_query_hash: '', // Not available in current table structure
            ts: row.TS,
          }));
          
          // Update local cache
          this.localCache.set(customerId, atoms.slice(0, 100));
          
          return atoms;
        }
      } catch (error) {
        logger.error({ error, customerId, subject, metric }, 'Failed to query insights from Snowflake');
        // Fall back to local cache
      }
    }
    
    return localResults;
  }

  /**
   * Get the latest value for a specific subject-metric
   */
  async getLatest(
    customerId: string,
    subject: string,
    metric: string
  ): Promise<any | null> {
    const atoms = await this.query(customerId, subject, metric, 1);
    return atoms.length > 0 ? atoms[0].value : null;
  }

  /**
   * Get temporal trends for a metric
   */
  async getTrend(
    customerId: string,
    subject: string,
    metric: string,
    days: number = 7
  ): Promise<{ ts: string; value: any }[]> {
    const atoms = await this.query(customerId, subject, metric, 1000);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    return atoms
      .filter(atom => new Date(atom.ts) >= cutoff)
      .map(atom => ({ ts: atom.ts, value: atom.value }))
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }

  /**
   * Aggregate metrics for a subject
   */
  async aggregate(
    customerId: string,
    subject: string,
    aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max' = 'count'
  ): Promise<Record<string, any>> {
    const atoms = await this.query(customerId, subject);
    const groupedByMetric: Record<string, any[]> = {};
    
    // Group by metric
    atoms.forEach(atom => {
      if (!groupedByMetric[atom.metric]) {
        groupedByMetric[atom.metric] = [];
      }
      groupedByMetric[atom.metric].push(atom.value);
    });
    
    // Apply aggregation
    const result: Record<string, any> = {};
    for (const [metric, values] of Object.entries(groupedByMetric)) {
      switch (aggregation) {
        case 'count':
          result[metric] = values.length;
          break;
        case 'sum':
          result[metric] = values.reduce((sum, val) => sum + (Number(val) || 0), 0);
          break;
        case 'avg':
          const sum = values.reduce((sum, val) => sum + (Number(val) || 0), 0);
          result[metric] = values.length > 0 ? sum / values.length : 0;
          break;
        case 'min':
          result[metric] = Math.min(...values.map(v => Number(v) || 0));
          break;
        case 'max':
          result[metric] = Math.max(...values.map(v => Number(v) || 0));
          break;
      }
    }
    
    return result;
  }

  /**
   * Get provenance information for an atom
   */
  async getProvenance(provenanceHash: string): Promise<QueryProvenance | null> {
    // Check local cache first
    const cached = this.provenanceCache.get(provenanceHash);
    if (cached) {
      return cached;
    }
    
    // Query Snowflake
    if (this.snowflakeClient) {
      try {
        const result = await this.snowflakeClient.executeTemplate('GET_PROVENANCE', [provenanceHash]);
        if (result.rows && result.rows.length > 0) {
          const row = result.rows[0];
          const provenance: QueryProvenance = {
            query_hash: row.QUERY_HASH,
            template_name: row.TEMPLATE_NAME,
            query_text: row.QUERY_TEXT,
            parameters: JSON.parse(row.PARAMETERS),
            created_at: row.CREATED_AT,
            created_by: row.CREATED_BY,
          };
          
          // Cache locally
          this.provenanceCache.set(provenanceHash, provenance);
          return provenance;
        }
      } catch (error) {
        logger.error({ error, provenanceHash }, 'Failed to get provenance from Snowflake');
      }
    }
    
    return null;
  }

  /**
   * Clean up expired atoms from local cache
   */
  private cleanupExpiredAtoms(): void {
    for (const [customerId, atoms] of this.localCache.entries()) {
      const validAtoms = atoms.filter(atom => !this.isExpired(atom));
      
      if (validAtoms.length !== atoms.length) {
        this.localCache.set(customerId, validAtoms);
        logger.debug({ 
          customerId, 
          removed: atoms.length - validAtoms.length 
        }, 'Cleaned up expired atoms');
      }
    }
    
    // Clean up provenance cache if it gets too large
    if (this.provenanceCache.size > this.maxCacheSize) {
      const entries = Array.from(this.provenanceCache.entries());
      entries.sort((a, b) => 
        new Date(a[1].created_at).getTime() - new Date(b[1].created_at).getTime()
      );
      
      // Remove oldest 20%
      const toRemove = Math.floor(entries.length * 0.2);
      for (let i = 0; i < toRemove; i++) {
        this.provenanceCache.delete(entries[i][0]);
      }
    }
  }

  /**
   * Check if an atom has expired
   */
  private isExpired(atom: InsightAtom): boolean {
    if (!atom.ttl) return false;
    
    const created = new Date(atom.ts).getTime();
    const now = Date.now();
    const ttlMs = atom.ttl * 1000;
    
    return (now - created) > ttlMs;
  }

  /**
   * Get statistics about the insight atoms system
   */
  getStats() {
    const customerCount = this.localCache.size;
    let totalAtoms = 0;
    const subjectCounts: Record<string, number> = {};
    
    for (const atoms of this.localCache.values()) {
      totalAtoms += atoms.length;
      atoms.forEach(atom => {
        subjectCounts[atom.subject] = (subjectCounts[atom.subject] || 0) + 1;
      });
    }
    
    return {
      customerCount,
      totalAtoms,
      provenanceCount: this.provenanceCache.size,
      topSubjects: Object.entries(subjectCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([subject, count]) => ({ subject, count })),
    };
  }
}