// Test setup file
import dotenv from 'dotenv';
import path from 'path';

// Load test environment variables
dotenv.config({ path: path.join(__dirname, '../../.env.test') });

// Set test-specific environment variables
process.env.NODE_ENV = 'test';
process.env.AUTH_AGENT_ENABLED = 'true';
process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests

// Mock timers for testing
jest.useFakeTimers();

// Extend global namespace for test utilities
declare global {
  var testUtils: any;
}

// Global test utilities
global.testUtils = {
  async waitFor(condition: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (!condition() && Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!condition()) {
      throw new Error('Timeout waiting for condition');
    }
  },
  
  mockSnowflakeConnection() {
    return {
      execute: jest.fn((options) => {
        const { complete } = options;
        if (complete) {
          complete(null, { getNumRowsAffected: () => 1 }, [{ healthy: 1 }]);
        }
      }),
      connect: jest.fn((callback) => callback(null)),
      destroy: jest.fn((callback) => callback(null)),
      isUp: jest.fn(() => true),
      getId: jest.fn(() => 'mock-connection-id'),
    };
  },
  
  mockAccountConfig(overrides = {}) {
    return {
      username: 'TEST_ACCOUNT',
      password: 'test_password',
      account: 'test_account',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      role: 'TEST_ROLE',
      priority: 1,
      maxFailures: 3,
      cooldownMs: 300000,
      maxConnections: 10,
      isActive: true,
      consecutiveFailures: 0,
      inCooldown: false,
      ...overrides
    };
  }
};

// Cleanup after each test
afterEach(() => {
  jest.clearAllMocks();
  jest.clearAllTimers();
});

// Restore real timers after all tests
afterAll(() => {
  jest.useRealTimers();
});