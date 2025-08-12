import { z } from 'zod';
import crypto from 'crypto';
// Validation schemas for parameters
const uuidSchema = z.string().uuid();
const customerIdSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9-_]+$/);
const activitySchema = z.string().min(1).max(100).regex(/^[a-z_.]+$/);
const jsonSchema = z.record(z.any());
const urlSchema = z.string().url().max(2000);
// Template registry
export const SAFE_TEMPLATES = new Map();
// Template definitions
SAFE_TEMPLATES.set('LOG_EVENT', {
    sql: `INSERT INTO CLAUDE_LOGS.ACTIVITIES.events (
    activity, customer, ts, activity_occurrence,
    link, revenue_impact,
    _feature_json, _source_system, _source_version, _session_id, _query_tag
  ) VALUES (?, ?, CURRENT_TIMESTAMP(), 1, ?, ?, PARSE_JSON(?), 'claude_desktop', '2.0', ?, ?)`,
    validator: (params) => {
        const [activity, customer, link, revenue, feature_json, session_id, query_tag] = params;
        return [
            activitySchema.parse(activity),
            customerIdSchema.parse(customer),
            link ? urlSchema.parse(link) : null,
            revenue !== undefined ? z.number().finite().parse(revenue) : null,
            feature_json ? JSON.stringify(jsonSchema.parse(feature_json)) : '{}',
            session_id ? z.string().max(255).parse(session_id) : null,
            query_tag ? z.string().max(255).parse(query_tag) : null,
        ];
    },
});
SAFE_TEMPLATES.set('LOG_INSIGHT', {
    sql: `INSERT INTO CLAUDE_LOGS.ACTIVITIES.insight_atoms (
    id, customer, subject, metric, 
    value, provenance_query_hash, ts
  ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
    validator: (params) => {
        const [atom_id, customer, subject, metric, value, hash] = params;
        return [
            uuidSchema.parse(atom_id),
            customerIdSchema.parse(customer),
            z.string().min(1).max(255).parse(subject),
            z.string().min(1).max(255).parse(metric),
            JSON.stringify(value),
            z.string().length(16).parse(hash),
        ];
    },
});
SAFE_TEMPLATES.set('GET_CONTEXT', {
    sql: `SELECT context_blob, updated_at
    FROM CLAUDE_LOGS.ACTIVITIES.context_cache
    WHERE customer = ?
      AND updated_at >= DATEADD(hour, -1, CURRENT_TIMESTAMP())
    LIMIT 1`,
    validator: (params) => {
        const [customer_id] = params;
        return [customerIdSchema.parse(customer_id)];
    },
});
SAFE_TEMPLATES.set('UPDATE_CONTEXT', {
    sql: `MERGE INTO CLAUDE_LOGS.ACTIVITIES.context_cache AS target
    USING (SELECT ? as customer, PARSE_JSON(?) as context_blob) AS source
    ON target.customer = source.customer
    WHEN MATCHED THEN UPDATE SET
      context_blob = source.context_blob,
      updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT
      (customer, context_blob, updated_at)
      VALUES (source.customer, source.context_blob, CURRENT_TIMESTAMP())`,
    validator: (params) => {
        const [customer, context] = params;
        return [
            customerIdSchema.parse(customer),
            JSON.stringify(jsonSchema.parse(context)),
        ];
    },
});
SAFE_TEMPLATES.set('GET_RECENT_ACTIVITIES', {
    sql: `SELECT activity, ts, link, _feature_json
    FROM CLAUDE_LOGS.ACTIVITIES.events
    WHERE customer = ?
      AND ts >= DATEADD(hour, ?, CURRENT_TIMESTAMP())
    ORDER BY ts DESC
    LIMIT ?`,
    validator: (params) => {
        const [customer, hours_back, limit] = params;
        return [
            customerIdSchema.parse(customer),
            z.number().int().min(1).max(720).parse(hours_back),
            z.number().int().min(1).max(1000).parse(limit),
        ];
    },
});
SAFE_TEMPLATES.set('GET_ACTIVITY_STATS', {
    sql: `SELECT 
      activity,
      COUNT(*) as count,
      AVG(revenue_impact) as avg_revenue,
      MAX(ts) as last_seen
    FROM CLAUDE_LOGS.ACTIVITIES.events
    WHERE customer = ?
      AND ts >= DATEADD(day, ?, CURRENT_TIMESTAMP())
    GROUP BY activity
    ORDER BY count DESC
    LIMIT ?`,
    validator: (params) => {
        const [customer, days_back, limit] = params;
        return [
            customerIdSchema.parse(customer),
            z.number().int().min(1).max(90).parse(days_back),
            z.number().int().min(1).max(100).parse(limit),
        ];
    },
});
SAFE_TEMPLATES.set('CHECK_HEALTH', {
    sql: `SELECT 1 as healthy, CURRENT_TIMESTAMP() as server_time`,
    validator: () => [],
});
// Template for idempotent ingestion
SAFE_TEMPLATES.set('CHECK_INGEST_ID', {
    sql: `SELECT id FROM CLAUDE_LOGS.ACTIVITIES._ingest_ids WHERE id = ?`,
    validator: (params) => {
        const [id] = params;
        return [uuidSchema.parse(id)];
    },
});
SAFE_TEMPLATES.set('RECORD_INGEST_ID', {
    sql: `INSERT INTO CLAUDE_LOGS.ACTIVITIES._ingest_ids (id) VALUES (?)`,
    validator: (params) => {
        const [id] = params;
        return [uuidSchema.parse(id)];
    },
});
// Helper to generate query hash for provenance
export function generateQueryHash(template, params) {
    const normalized = template.replace(/\s+/g, ' ').trim();
    const paramString = JSON.stringify(params, Object.keys(params).sort());
    return crypto
        .createHash('sha256')
        .update(normalized + paramString)
        .digest('hex')
        .substring(0, 16);
}
// Main execution function
export async function executeSafeSQL(connection, // Snowflake connection
templateName, params, options = {}) {
    const template = SAFE_TEMPLATES.get(templateName);
    if (!template) {
        throw new Error(`Unknown template: ${templateName}`);
    }
    // Validate parameters
    const validatedParams = template.validator(params);
    // Execute with timeout
    const timeout = options.timeout || 30000;
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Query timeout after ${timeout}ms`));
        }, timeout);
        connection.execute({
            sqlText: template.sql,
            binds: validatedParams,
            complete: (err, stmt, rows) => {
                clearTimeout(timeoutId);
                if (err) {
                    reject(err);
                }
                else {
                    resolve({ rows, rowCount: stmt.getNumRows() });
                }
            },
        });
    });
}
// Validation function to ensure templates are safe
export function validateAllTemplates() {
    const errors = [];
    for (const [name, template] of SAFE_TEMPLATES) {
        // Check for dynamic SQL patterns
        if (template.sql.includes('${') || template.sql.includes('`')) {
            errors.push(`Template ${name} contains template literals`);
        }
        // Check for dangerous string concatenation
        if (template.sql.includes('||') || template.sql.includes('CONCAT')) {
            errors.push(`Template ${name} contains string concatenation`);
        }
        // Verify parameter markers
        const paramCount = (template.sql.match(/\?/g) || []).length;
        if (paramCount === 0 && name !== 'CHECK_HEALTH') {
            errors.push(`Template ${name} has no parameters`);
        }
        // Verify validator function
        if (typeof template.validator !== 'function') {
            errors.push(`Template ${name} missing validator function`);
        }
    }
    if (errors.length > 0) {
        throw new Error('Template validation failed:\n' + errors.join('\n'));
    }
}
// Export template names for reference
export const TEMPLATE_NAMES = {
    LOG_EVENT: 'LOG_EVENT',
    LOG_INSIGHT: 'LOG_INSIGHT',
    GET_CONTEXT: 'GET_CONTEXT',
    UPDATE_CONTEXT: 'UPDATE_CONTEXT',
    GET_RECENT_ACTIVITIES: 'GET_RECENT_ACTIVITIES',
    GET_ACTIVITY_STATS: 'GET_ACTIVITY_STATS',
    CHECK_HEALTH: 'CHECK_HEALTH',
};
//# sourceMappingURL=safe-templates.js.map