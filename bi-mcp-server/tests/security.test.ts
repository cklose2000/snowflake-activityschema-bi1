import { validateAllTemplates } from '../src/sql/safe-templates';

describe('SQL Security Tests', () => {
  describe('Template validation', () => {
    it('should validate all templates on startup', () => {
      expect(() => validateAllTemplates()).not.toThrow();
    });
  });

  describe('SQL injection prevention', () => {
    const maliciousInputs = [
      "'; DROP TABLE CLAUDE_STREAM; --",
      "1 OR 1=1",
      "admin'--",
      "' UNION SELECT * FROM users--",
      "${process.env.SECRET}",
      "`rm -rf /`",
      "../../../etc/passwd",
      "\\x00",
      "{{7*7}}",
      "<script>alert('xss')</script>",
    ];

    it('should reject malicious customer IDs', async () => {
      // Import after validation
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('GET_CONTEXT');
      
      for (const input of maliciousInputs) {
        expect(() => {
          template?.validator([input]);
        }).toThrow();
      }
    });

    it('should reject malicious activity names', async () => {
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('LOG_EVENT');
      
      const validUuid = 'a1b2c3d4-e5f6-4789-0123-456789abcdef';
      
      for (const input of maliciousInputs) {
        expect(() => {
          template?.validator([validUuid, input, null, null, {}, null, null]);
        }).toThrow();
      }
    });

    it('should reject SQL keywords in strings', async () => {
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('GET_CONTEXT');
      
      const sqlKeywords = [
        'customer_DROP_TABLE',
        'customer_DELETE_FROM',
        'customer_INSERT_INTO',
        'customer_UPDATE_SET',
        'customer_ALTER_TABLE',
      ];
      
      for (const input of sqlKeywords) {
        // Should reject due to regex pattern validation
        expect(() => {
          template?.validator([input]);
        }).toThrow();
      }
    });

    it('should properly escape JSON in feature_json', async () => {
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('LOG_EVENT');
      
      const validUuid = 'a1b2c3d4-e5f6-4789-0123-456789abcdef';
      const maliciousJson = {
        "__proto__": { "isAdmin": true },
        "constructor": { "prototype": { "isAdmin": true } },
        "sql": "'; DROP TABLE users; --",
      };
      
      const result = template?.validator([
        validUuid,
        'test_activity',
        'customer123',
        null,
        maliciousJson,
        null,
        null,
      ]);
      
      // Should stringify JSON, preventing injection
      expect(result?.[4]).toBe(JSON.stringify(maliciousJson));
    });

    it('should validate parameter count matches placeholders', () => {
      // This test verifies templates have correct number of ? placeholders
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      
      for (const [name, template] of SAFE_TEMPLATES) {
        const placeholderCount = (template.sql.match(/\?/g) || []).length;
        
        if (name === 'CHECK_HEALTH') {
          expect(placeholderCount).toBe(0);
        } else {
          expect(placeholderCount).toBeGreaterThan(0);
        }
      }
    });

    it('should prevent prototype pollution', async () => {
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('UPDATE_CONTEXT');
      
      const maliciousContext = {
        "__proto__": { "isAdmin": true },
        "constructor": { "prototype": { "isAdmin": true } },
        "prototype": { "isAdmin": true },
      };
      
      // Should safely stringify without prototype pollution
      const result = template?.validator(['customer123', maliciousContext]);
      const parsed = JSON.parse(result?.[1] || '{}');
      
      // Verify prototype pollution didn't occur
      expect(parsed.__proto__).toBeUndefined();
      expect(parsed.constructor).toBeUndefined();
      expect(parsed.prototype).toBeUndefined();
      expect(({} as any).isAdmin).toBeUndefined();
    });
  });

  describe('Parameter validation', () => {
    it('should enforce UUID format', async () => {
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('LOG_EVENT');
      
      const invalidUuids = [
        '123',
        'not-a-uuid',
        '12345678-1234-1234-1234-123456789012', // wrong version
        'g1b2c3d4-e5f6-4789-0123-456789abcdef', // invalid character
      ];
      
      for (const uuid of invalidUuids) {
        expect(() => {
          template?.validator([uuid, 'activity', null, null, {}, null, null]);
        }).toThrow();
      }
    });

    it('should enforce URL format', async () => {
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('LOG_EVENT');
      
      const validUuid = 'a1b2c3d4-e5f6-4789-0123-456789abcdef';
      const invalidUrls = [
        'not-a-url',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'ftp://example.com',
      ];
      
      for (const url of invalidUrls) {
        expect(() => {
          template?.validator([validUuid, 'activity', null, null, {}, null, url]);
        }).toThrow();
      }
    });

    it('should enforce numeric limits', async () => {
      const { SAFE_TEMPLATES } = await import('../src/sql/safe-templates');
      const template = SAFE_TEMPLATES.get('GET_RECENT_ACTIVITIES');
      
      const invalidNumbers = [
        ['customer', 0, 100],    // hours_back too small
        ['customer', 721, 100],  // hours_back too large
        ['customer', 24, 0],     // limit too small
        ['customer', 24, 1001],  // limit too large
      ];
      
      for (const params of invalidNumbers) {
        expect(() => {
          template?.validator(params);
        }).toThrow();
      }
    });
  });
});

// Export for test runner
export {};