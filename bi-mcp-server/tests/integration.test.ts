import { describe, it, expect } from '@jest/globals';

describe('MCP Server Integration', () => {
  it('should validate system is ready', () => {
    // Basic system checks
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('should import modules without errors', async () => {
    // Test that our main modules can be imported
    const { loadConfig } = await import('../src/config');
    const config = loadConfig();
    
    expect(config).toBeDefined();
    expect(config.snowflake).toBeDefined();
    expect(config.performance.getContextP95).toBe(25);
  });

  it('should validate SafeSQL templates', async () => {
    const { validateAllTemplates } = await import('../src/sql/safe-templates');
    
    // This should not throw
    expect(() => validateAllTemplates()).not.toThrow();
  });
});