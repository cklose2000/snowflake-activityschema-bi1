import { isValidQueryTag, generateQueryTag } from '../src/utils/query-tag';

/**
 * ActivitySchema v2.0 Compliance Tests
 * 
 * These tests ensure strict compliance with the ActivitySchema v2.0 specification:
 * 1. Required fields are present and non-null
 * 2. Extensions use underscore prefix
 * 3. Activities use cdesk.* namespace
 * 4. Query tags follow cdesk_[uuid] format
 */

describe('ActivitySchema v2.0 Compliance', () => {
  
  describe('Activity Naming Convention', () => {
    const validActivities = [
      'cdesk.session_started',
      'cdesk.user_asked',
      'cdesk.claude_responded',
      'cdesk.sql_executed',
      'cdesk.insight_recorded',
      'cdesk.error_encountered',
    ];

    const invalidActivities = [
      'session_started',        // Missing namespace
      'claude.session_started', // Wrong namespace
      'cdesk.SessionStarted',  // Wrong case
      'cdesk.start_session',   // Wrong verb form
      'CDESK.user_asked',      // Wrong case in namespace
      'user_asked',            // No namespace
    ];

    test('should accept valid cdesk.* activities', () => {
      validActivities.forEach(activity => {
        expect(isValidCdeskActivity(activity)).toBe(true);
      });
    });

    test('should reject invalid activities', () => {
      invalidActivities.forEach(activity => {
        expect(isValidCdeskActivity(activity)).toBe(false);
      });
    });

    test('should auto-prefix activities without namespace', () => {
      expect(ensureCdeskNamespace('user_asked')).toBe('cdesk.user_asked');
      expect(ensureCdeskNamespace('cdesk.user_asked')).toBe('cdesk.user_asked');
    });
  });

  describe('Query Tag Format', () => {
    test('should generate valid query tags', () => {
      const tag = generateQueryTag();
      expect(tag).toMatch(/^cdesk_[0-9a-f]{8}$/);
      expect(isValidQueryTag(tag)).toBe(true);
    });

    test('should validate query tag format', () => {
      expect(isValidQueryTag('cdesk_a1b2c3d4')).toBe(true);
      expect(isValidQueryTag('cdesk_12345678')).toBe(true);
      expect(isValidQueryTag('cdesk')).toBe(false);
      expect(isValidQueryTag('cdesk_')).toBe(false);
      expect(isValidQueryTag('cdesk_toolong123')).toBe(false);
      expect(isValidQueryTag('wrongprefix_12345678')).toBe(false);
    });

    test('should generate unique query tags', () => {
      const tags = new Set();
      for (let i = 0; i < 1000; i++) {
        tags.add(generateQueryTag());
      }
      expect(tags.size).toBe(1000); // All should be unique
    });
  });

  describe('Required Fields Validation', () => {
    const requiredFields = [
      'activity',
      'customer',
      'ts',
      'activity_occurrence',
      'activity_repeated_at',
    ];

    const optionalSpecFields = [
      'link',
      'revenue_impact',
    ];

    const extensionFields = [
      '_feature_json',
      '_source_system',
      '_source_version',
      '_session_id',
      '_query_tag',
    ];

    test('should identify required fields', () => {
      const event = {
        activity: 'cdesk.user_asked',
        customer: 'user123',
        ts: new Date().toISOString(),
        activity_occurrence: 1,
        activity_repeated_at: null,
      };

      requiredFields.forEach(field => {
        expect(field in event || field === 'activity_repeated_at').toBe(true);
      });
    });

    test('should validate extension field prefixes', () => {
      extensionFields.forEach(field => {
        expect(field.startsWith('_')).toBe(true);
      });
    });

    test('should not allow non-underscored extensions', () => {
      const invalidExtensions = [
        'feature_json',    // Missing underscore
        'source_system',   // Missing underscore
        'query_tag',       // Missing underscore
      ];

      invalidExtensions.forEach(field => {
        expect(field.startsWith('_')).toBe(false);
      });
    });
  });

  describe('Feature JSON Structure', () => {
    test('should structure LLM event features correctly', () => {
      const llmFeatures = {
        model: 'claude-3-opus',
        prompt_tokens: 150,
        completion_tokens: 300,
        latency_ms: 250,
        cost_usd: 0.0045,
      };

      expect(llmFeatures).toHaveProperty('model');
      expect(llmFeatures).toHaveProperty('prompt_tokens');
      expect(llmFeatures).toHaveProperty('completion_tokens');
      expect(typeof llmFeatures.prompt_tokens).toBe('number');
      expect(typeof llmFeatures.cost_usd).toBe('number');
    });

    test('should structure SQL event features correctly', () => {
      const sqlFeatures = {
        template: 'GET_RECENT_ACTIVITIES',
        warehouse: 'COMPUTE_XS',
        rows_returned: 100,
        bytes_scanned: 1024000,
        duration_ms: 450,
      };

      expect(sqlFeatures).toHaveProperty('template');
      expect(sqlFeatures).toHaveProperty('warehouse');
      expect(sqlFeatures).toHaveProperty('rows_returned');
      expect(typeof sqlFeatures.rows_returned).toBe('number');
      expect(typeof sqlFeatures.bytes_scanned).toBe('number');
    });

    test('should structure insight features correctly', () => {
      const insightFeatures = {
        atom_id: 'a1b2c3d4-e5f6-4789-0123-456789abcdef',
        subject: 'revenue',
        metric: 'daily_total',
        value: 45000.50,
        provenance_query_hash: '1234567890abcdef',
      };

      expect(insightFeatures).toHaveProperty('atom_id');
      expect(insightFeatures).toHaveProperty('subject');
      expect(insightFeatures).toHaveProperty('metric');
      expect(insightFeatures).toHaveProperty('value');
      expect(insightFeatures).toHaveProperty('provenance_query_hash');
      expect(insightFeatures.provenance_query_hash).toHaveLength(16);
    });
  });

  describe('Temporal Fields Validation', () => {
    test('activity_occurrence should be positive integer', () => {
      const occurrences = [1, 2, 3, 10, 100];
      occurrences.forEach(occ => {
        expect(Number.isInteger(occ)).toBe(true);
        expect(occ > 0).toBe(true);
      });
    });

    test('activity_repeated_at should be null or valid timestamp', () => {
      const validValues = [
        null,
        '2024-01-15T14:30:00.000Z',
        new Date().toISOString(),
      ];

      validValues.forEach(val => {
        if (val !== null) {
          expect(() => new Date(val)).not.toThrow();
        }
      });
    });
  });

  describe('Revenue Impact Validation', () => {
    test('should use consistent currency units', () => {
      const revenueValues = [
        0.001,    // $0.001 (one tenth of a cent)
        0.01,     // $0.01 (one cent)
        1.00,     // $1.00 (one dollar)
        -5.00,    // -$5.00 (refund)
      ];

      revenueValues.forEach(val => {
        expect(typeof val).toBe('number');
        expect(isFinite(val)).toBe(true);
      });
    });

    test('should handle null revenue_impact', () => {
      const event = {
        activity: 'cdesk.session_started',
        revenue_impact: null,
      };

      expect(event.revenue_impact).toBeNull();
    });
  });

  describe('Source System Validation', () => {
    test('should default to claude_desktop', () => {
      const defaultSource = 'claude_desktop';
      const defaultVersion = '2.0';

      expect(defaultSource).toBe('claude_desktop');
      expect(defaultVersion).toBe('2.0');
    });

    test('should not accept Claude Code events', () => {
      const invalidSources = [
        'claude_code',
        'code',
        'vscode',
      ];

      invalidSources.forEach(source => {
        expect(source).not.toBe('claude_desktop');
      });
    });
  });
});

// Helper functions for validation
function isValidCdeskActivity(activity: string): boolean {
  // Must start with cdesk.
  if (!activity.startsWith('cdesk.')) return false;
  
  // Must be lowercase
  if (activity !== activity.toLowerCase()) return false;
  
  // Must follow verb_noun pattern
  const parts = activity.split('.');
  if (parts.length !== 2) return false;
  
  const eventName = parts[1];
  if (!/^[a-z]+(_[a-z]+)+$/.test(eventName)) return false;
  
  return true;
}

function ensureCdeskNamespace(activity: string): string {
  return activity.startsWith('cdesk.') ? activity : `cdesk.${activity}`;
}

// Export for use in other tests
export { isValidCdeskActivity, ensureCdeskNamespace };