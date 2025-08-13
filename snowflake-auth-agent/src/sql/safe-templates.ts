/**
 * SafeSQL Templates for Authentication Agent
 * 
 * Secure, parameterized SQL templates that prevent injection attacks
 * while providing all necessary database operations.
 */

import { z } from 'zod';
import pino from 'pino';

const logger = pino({ name: 'safe-templates' });

export interface Template {
  sql: string;
  validator: (params: any[]) => any[];
}

export const SAFE_TEMPLATES = new Map<string, Template>();

// Validation helper functions
function isValidUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

function isValidJSON(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validateString(value: any, maxLength: number = 255, required: boolean = true): string {
  if (required && (!value || typeof value !== 'string')) {
    throw new Error('String value is required');
  }
  if (!required && !value) return '';
  if (typeof value !== 'string') {
    throw new Error('Value must be a string');
  }
  if (value.length > maxLength) {
    throw new Error(`String exceeds maximum length of ${maxLength}`);
  }
  // Basic SQL injection prevention
  if (/[;'"`\\]|--|\*\/|\*\*/.test(value)) {
    throw new Error('String contains forbidden characters');
  }
  return value.trim();
}

function validateNumber(value: any, min?: number, max?: number): number {
  if (typeof value !== 'number' || !isFinite(value)) {
    throw new Error('Value must be a finite number');
  }
  if (min !== undefined && value < min) {
    throw new Error(`Number must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`Number must be <= ${max}`);
  }
  return value;
}

// Health check template
SAFE_TEMPLATES.set('CHECK_HEALTH', {
  sql: 'SELECT 1 as healthy, CURRENT_TIMESTAMP() as server_time, CURRENT_USER() as username, CURRENT_ROLE() as role',
  validator: (params: any[]) => {
    if (params.length !== 0) {
      throw new Error('CHECK_HEALTH expects no parameters');
    }
    return [];
  },
});

// Context retrieval template
SAFE_TEMPLATES.set('GET_CONTEXT', {
  sql: `
    SELECT 
      context as CONTEXT_BLOB,
      updated_at,
      version
    FROM CONTEXT_CACHE
    WHERE customer_id = ?
      AND updated_at >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
    LIMIT 1
  `,
  validator: (params: any[]) => {
    if (params.length !== 1) {
      throw new Error('GET_CONTEXT expects exactly 1 parameter');
    }
    const customerId = validateString(params[0], 255, true);
    return [customerId];
  },
});

// Event logging template
SAFE_TEMPLATES.set('LOG_EVENT', {
  sql: `
    INSERT INTO EVENTS (
      activity, customer, ts, _feature_json, 
      link, _source_system, _source_version,
      _session_id, _query_tag, _ingested_at
    ) VALUES (
      ?, ?, CURRENT_TIMESTAMP(), PARSE_JSON(?),
      ?, 'auth_agent', '1.0',
      ?, ?, CURRENT_TIMESTAMP()
    )
  `,
  validator: (params: any[]) => {
    if (params.length < 4 || params.length > 6) {
      throw new Error('LOG_EVENT expects 4-6 parameters');
    }
    
    const activity = validateString(params[0], 100, true);
    const customer = validateString(params[1], 255, true);
    const featureJson = params[2] ? JSON.stringify(params[2]) : '{}';
    const link = params[3] ? validateString(params[3], 2000, false) : null;
    const sessionId = params[4] ? validateString(params[4], 255, false) : null;
    const queryTag = params[5] ? validateString(params[5], 100, false) : null;
    
    if (!isValidJSON(featureJson)) {
      throw new Error('Invalid feature_json');
    }
    
    return [activity, customer, featureJson, link, sessionId, queryTag];
  },
});

// Authentication event logging
SAFE_TEMPLATES.set('LOG_AUTH_EVENT', {
  sql: `
    INSERT INTO AUTH_EVENTS (
      event_id, account_name, event_type, error_message,
      source_ip, user_agent, connection_id, ts
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, CURRENT_TIMESTAMP()
    )
  `,
  validator: (params: any[]) => {
    if (params.length !== 7) {
      throw new Error('LOG_AUTH_EVENT expects exactly 7 parameters');
    }
    
    const eventId = validateString(params[0], 50, true);
    const accountName = validateString(params[1], 255, true);
    const eventType = validateString(params[2], 50, true);
    const errorMessage = params[3] ? validateString(params[3], 1000, false) : null;
    const sourceIp = params[4] ? validateString(params[4], 50, false) : null;
    const userAgent = params[5] ? validateString(params[5], 500, false) : null;
    const connectionId = params[6] ? validateString(params[6], 100, false) : null;
    
    // Validate event type
    const validEventTypes = ['success', 'failure', 'lockout', 'unlock'];
    if (!validEventTypes.includes(eventType)) {
      throw new Error(`Invalid event_type. Must be one of: ${validEventTypes.join(', ')}`);
    }
    
    return [eventId, accountName, eventType, errorMessage, sourceIp, userAgent, connectionId];
  },
});

// Update account health
SAFE_TEMPLATES.set('UPDATE_ACCOUNT_HEALTH', {
  sql: `
    MERGE INTO ACCOUNT_HEALTH AS target
    USING (
      SELECT ? as account_name, ? as is_locked, ? as failure_count,
             ? as consecutive_failures, ? as status
    ) AS source
    ON target.account_name = source.account_name
    WHEN MATCHED THEN UPDATE SET
      is_locked = source.is_locked,
      failure_count = source.failure_count,
      consecutive_failures = source.consecutive_failures,
      last_health_check = CURRENT_TIMESTAMP(),
      status = source.status,
      updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT
      (account_name, is_locked, failure_count, consecutive_failures, 
       status, last_health_check, updated_at)
    VALUES 
      (source.account_name, source.is_locked, source.failure_count,
       source.consecutive_failures, source.status, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
  `,
  validator: (params: any[]) => {
    if (params.length !== 5) {
      throw new Error('UPDATE_ACCOUNT_HEALTH expects exactly 5 parameters');
    }
    
    const accountName = validateString(params[0], 255, true);
    const isLocked = typeof params[1] === 'boolean' ? params[1] : false;
    const failureCount = validateNumber(params[2], 0, 1000);
    const consecutiveFailures = validateNumber(params[3], 0, 100);
    const status = validateString(params[4], 50, true);
    
    // Validate status
    const validStatuses = ['active', 'cooldown', 'locked', 'disabled'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
    
    return [accountName, isLocked, failureCount, consecutiveFailures, status];
  },
});

// Get account health status
SAFE_TEMPLATES.set('GET_ACCOUNT_HEALTH', {
  sql: `
    SELECT 
      account_name,
      is_locked,
      failure_count,
      consecutive_failures,
      last_success_at,
      last_failure_at,
      last_health_check,
      priority,
      status,
      updated_at
    FROM ACCOUNT_HEALTH
    ORDER BY priority
  `,
  validator: (params: any[]) => {
    if (params.length !== 0) {
      throw new Error('GET_ACCOUNT_HEALTH expects no parameters');
    }
    return [];
  },
});

// Get recent authentication events
SAFE_TEMPLATES.set('GET_AUTH_EVENTS', {
  sql: `
    SELECT 
      event_id,
      account_name,
      event_type,
      error_message,
      source_ip,
      connection_id,
      ts
    FROM AUTH_EVENTS
    WHERE ts >= DATEADD(hour, ?, CURRENT_TIMESTAMP())
    ORDER BY ts DESC
    LIMIT ?
  `,
  validator: (params: any[]) => {
    if (params.length !== 2) {
      throw new Error('GET_AUTH_EVENTS expects exactly 2 parameters');
    }
    
    const hoursBack = validateNumber(params[0], 1, 720); // 1 hour to 30 days
    const limit = validateNumber(params[1], 1, 1000);
    
    return [-Math.abs(hoursBack), limit]; // Negative for DATEADD
  },
});

// Insight atom logging
SAFE_TEMPLATES.set('LOG_INSIGHT', {
  sql: `
    INSERT INTO INSIGHT_ATOMS (
      atom_id, customer_id, subject, metric,
      value, provenance_query_hash, ts
    ) VALUES (
      ?, ?, ?, ?,
      PARSE_JSON(?), ?, CURRENT_TIMESTAMP()
    )
  `,
  validator: (params: any[]) => {
    if (params.length !== 6) {
      throw new Error('LOG_INSIGHT expects exactly 6 parameters');
    }
    
    const atomId = validateString(params[0], 50, true);
    const customerId = validateString(params[1], 255, true);
    const subject = validateString(params[2], 255, true);
    const metric = validateString(params[3], 255, true);
    const value = JSON.stringify(params[4]);
    const provenanceHash = validateString(params[5], 16, true);
    
    if (!isValidUUID(atomId)) {
      throw new Error('Invalid atom_id UUID format');
    }
    
    if (!isValidJSON(value)) {
      throw new Error('Invalid value JSON');
    }
    
    return [atomId, customerId, subject, metric, value, provenanceHash];
  },
});

// Get recent activities
SAFE_TEMPLATES.set('GET_RECENT_ACTIVITIES', {
  sql: `
    SELECT 
      activity,
      customer,
      ts,
      _feature_json,
      link,
      _session_id,
      _query_tag
    FROM EVENTS
    WHERE customer = ?
      AND ts >= DATEADD(hour, ?, CURRENT_TIMESTAMP())
    ORDER BY ts DESC
    LIMIT ?
  `,
  validator: (params: any[]) => {
    if (params.length !== 3) {
      throw new Error('GET_RECENT_ACTIVITIES expects exactly 3 parameters');
    }
    
    const customer = validateString(params[0], 255, true);
    const hoursBack = validateNumber(params[1], 1, 720); // 1 hour to 30 days
    const limit = validateNumber(params[2], 1, 1000);
    
    return [customer, -Math.abs(hoursBack), limit];
  },
});

// Performance query - get connection metrics
SAFE_TEMPLATES.set('GET_CONNECTION_METRICS', {
  sql: `
    SELECT 
      'connection_stats' as metric_type,
      COUNT(*) as total_connections,
      SUM(CASE WHEN ts >= DATEADD(minute, -5, CURRENT_TIMESTAMP()) THEN 1 ELSE 0 END) as recent_connections,
      AVG(CASE WHEN ts >= DATEADD(hour, -1, CURRENT_TIMESTAMP()) THEN 1 ELSE 0 END) as success_rate
    FROM AUTH_EVENTS
    WHERE event_type = 'success'
      AND ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
  `,
  validator: (params: any[]) => {
    if (params.length !== 0) {
      throw new Error('GET_CONNECTION_METRICS expects no parameters');
    }
    return [];
  },
});

// Execute stored procedures for account management
SAFE_TEMPLATES.set('CALL_UNLOCK_ACCOUNT', {
  sql: 'CALL SP_UNLOCK_ACCOUNT(?)',
  validator: (params: any[]) => {
    if (params.length !== 1) {
      throw new Error('CALL_UNLOCK_ACCOUNT expects exactly 1 parameter');
    }
    
    const accountName = validateString(params[0], 255, true);
    return [accountName];
  },
});

SAFE_TEMPLATES.set('CALL_LOCK_ACCOUNT', {
  sql: 'CALL SP_LOCK_ACCOUNT(?, ?)',
  validator: (params: any[]) => {
    if (params.length !== 2) {
      throw new Error('CALL_LOCK_ACCOUNT expects exactly 2 parameters');
    }
    
    const accountName = validateString(params[0], 255, true);
    const errorMessage = validateString(params[1], 1000, true);
    
    return [accountName, errorMessage];
  },
});

SAFE_TEMPLATES.set('CALL_AUTH_SUCCESS', {
  sql: 'CALL SP_AUTH_SUCCESS(?, ?)',
  validator: (params: any[]) => {
    if (params.length !== 2) {
      throw new Error('CALL_AUTH_SUCCESS expects exactly 2 parameters');
    }
    
    const accountName = validateString(params[0], 255, true);
    const connectionId = validateString(params[1], 100, true);
    
    return [accountName, connectionId];
  },
});

SAFE_TEMPLATES.set('CALL_AUTH_FAILURE', {
  sql: 'CALL SP_AUTH_FAILURE(?, ?)',
  validator: (params: any[]) => {
    if (params.length !== 2) {
      throw new Error('CALL_AUTH_FAILURE expects exactly 2 parameters');
    }
    
    const accountName = validateString(params[0], 255, true);
    const errorMessage = validateString(params[1], 1000, true);
    
    return [accountName, errorMessage];
  },
});

// Export template names for validation
export const TEMPLATE_NAMES = {
  CHECK_HEALTH: 'CHECK_HEALTH',
  GET_CONTEXT: 'GET_CONTEXT',
  LOG_EVENT: 'LOG_EVENT',
  LOG_AUTH_EVENT: 'LOG_AUTH_EVENT',
  UPDATE_ACCOUNT_HEALTH: 'UPDATE_ACCOUNT_HEALTH',
  GET_ACCOUNT_HEALTH: 'GET_ACCOUNT_HEALTH',
  GET_AUTH_EVENTS: 'GET_AUTH_EVENTS',
  LOG_INSIGHT: 'LOG_INSIGHT',
  GET_RECENT_ACTIVITIES: 'GET_RECENT_ACTIVITIES',
  GET_CONNECTION_METRICS: 'GET_CONNECTION_METRICS',
  CALL_UNLOCK_ACCOUNT: 'CALL_UNLOCK_ACCOUNT',
  CALL_LOCK_ACCOUNT: 'CALL_LOCK_ACCOUNT',
  CALL_AUTH_SUCCESS: 'CALL_AUTH_SUCCESS',
  CALL_AUTH_FAILURE: 'CALL_AUTH_FAILURE',
} as const;

/**
 * Validate all templates at startup
 */
export function validateAllTemplates(): void {
  logger.info('Validating SafeSQL templates');
  
  const errors: string[] = [];
  
  for (const [name, template] of SAFE_TEMPLATES) {
    // Check for dangerous patterns
    if (template.sql.includes('${') || template.sql.includes('`') || template.sql.includes('eval(')) {
      errors.push(`Template ${name} contains template literals or eval`);
    }
    
    // Check parameter markers
    const paramCount = (template.sql.match(/\?/g) || []).length;
    if (paramCount === 0 && name !== 'CHECK_HEALTH' && name !== 'GET_ACCOUNT_HEALTH' && name !== 'GET_CONNECTION_METRICS') {
      errors.push(`Template ${name} has no parameters but should have some`);
    }
    
    // Verify validator function
    if (typeof template.validator !== 'function') {
      errors.push(`Template ${name} missing validator function`);
    }
    
    try {
      // Test validator with empty params for parameterless queries
      if (paramCount === 0) {
        template.validator([]);
      }
    } catch (error) {
      // This is expected for templates that require parameters
    }
  }
  
  if (errors.length > 0) {
    logger.error({ errors }, 'Template validation failed');
    throw new Error(`Template validation failed:\n${errors.join('\n')}`);
  }
  
  logger.info({ templateCount: SAFE_TEMPLATES.size }, 'All SafeSQL templates validated successfully');
}

// Get active customers for cache warming
SAFE_TEMPLATES.set('GET_ACTIVE_CUSTOMERS', {
  sql: `
    SELECT DISTINCT customer_id
    FROM CONTEXT_CACHE
    WHERE updated_at >= DATEADD(hour, -1, CURRENT_TIMESTAMP())
    ORDER BY updated_at DESC
    LIMIT ?
  `,
  validator: (params: any[]) => {
    if (params.length !== 1) {
      throw new Error('GET_ACTIVE_CUSTOMERS expects exactly 1 parameter');
    }
    const limit = validateNumber(params[0], 1, 1000);
    return [limit];
  },
});

// Template names array for validation
export const TEMPLATE_NAMES_ARRAY = Array.from(SAFE_TEMPLATES.keys());