import { AuthCircuitBreaker, CircuitState } from '../../src/circuit-breaker/auth-circuit-breaker';

describe('AuthCircuitBreaker', () => {
  let circuitBreaker: AuthCircuitBreaker;
  
  beforeEach(() => {
    circuitBreaker = new AuthCircuitBreaker({
      failureThreshold: 3,
      recoveryTimeoutMs: 5000,
      successThreshold: 2,
      timeWindowMs: 60000,
      maxBackoffMs: 30000,
      backoffMultiplier: 2,
    });
  });
  
  afterEach(() => {
    circuitBreaker.destroy();
  });
  
  describe('State Transitions', () => {
    it('should start in CLOSED state', () => {
      const metrics = circuitBreaker.getAccountMetrics('TEST_ACCOUNT');
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(0);
    });
    
    it('should transition to OPEN after threshold failures', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Record failures up to threshold
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      
      let metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(2);
      
      // Third failure should open the circuit
      await circuitBreaker.recordFailure(accountName, 'Error 3');
      
      metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.OPEN);
      expect(metrics.failureCount).toBe(3);
    });
    
    it('should transition to HALF_OPEN after recovery timeout', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Open the circuit
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      await circuitBreaker.recordFailure(accountName, 'Error 3');
      
      let metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.OPEN);
      
      // Advance time past recovery timeout
      jest.advanceTimersByTime(5001);
      
      // Check if execution is allowed (should transition to HALF_OPEN)
      const canExecute = circuitBreaker.canExecute(accountName);
      expect(canExecute).toBe(true);
      
      metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.HALF_OPEN);
    });
    
    it('should transition back to CLOSED after success threshold in HALF_OPEN', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Open the circuit
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      await circuitBreaker.recordFailure(accountName, 'Error 3');
      
      // Move to HALF_OPEN
      jest.advanceTimersByTime(5001);
      circuitBreaker.canExecute(accountName);
      
      // Record successes
      await circuitBreaker.recordSuccess(accountName);
      await circuitBreaker.recordSuccess(accountName);
      
      const metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(0);
    });
    
    it('should transition back to OPEN from HALF_OPEN on failure', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Open the circuit
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      await circuitBreaker.recordFailure(accountName, 'Error 3');
      
      // Move to HALF_OPEN
      jest.advanceTimersByTime(5001);
      circuitBreaker.canExecute(accountName);
      
      // Record a failure in HALF_OPEN state
      await circuitBreaker.recordFailure(accountName, 'Error in half-open');
      
      const metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.OPEN);
    });
  });
  
  describe('Execution Control', () => {
    it('should allow execution when circuit is CLOSED', () => {
      expect(circuitBreaker.canExecute('TEST_ACCOUNT')).toBe(true);
    });
    
    it('should block execution when circuit is OPEN', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Open the circuit
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      await circuitBreaker.recordFailure(accountName, 'Error 3');
      
      expect(circuitBreaker.canExecute(accountName)).toBe(false);
    });
    
    it('should allow limited execution in HALF_OPEN state', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Open the circuit
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      await circuitBreaker.recordFailure(accountName, 'Error 3');
      
      // Move to HALF_OPEN
      jest.advanceTimersByTime(5001);
      
      // First call should be allowed (transitions to HALF_OPEN)
      expect(circuitBreaker.canExecute(accountName)).toBe(true);
      
      // Subsequent calls should be allowed in HALF_OPEN
      expect(circuitBreaker.canExecute(accountName)).toBe(true);
    });
  });
  
  describe('Backoff Calculation', () => {
    it('should calculate exponential backoff correctly', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // First failure - no backoff
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      let metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.nextRetryTime).toBeUndefined();
      
      // Second failure - still no backoff (under threshold)
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.nextRetryTime).toBeUndefined();
      
      // Third failure - circuit opens, backoff applied
      await circuitBreaker.recordFailure(accountName, 'Error 3');
      metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.nextRetryTime).toBeDefined();
      expect(metrics.nextRetryTime).toBeGreaterThan(Date.now());
    });
    
    it('should cap backoff at maximum value', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Open circuit and record many failures
      for (let i = 0; i < 10; i++) {
        await circuitBreaker.recordFailure(accountName, `Error ${i}`);
        if (i > 2) {
          jest.advanceTimersByTime(5001); // Move past recovery timeout
          circuitBreaker.canExecute(accountName); // Try to execute (moves to HALF_OPEN)
        }
      }
      
      const metrics = circuitBreaker.getAccountMetrics(accountName);
      const backoffTime = metrics.nextRetryTime! - Date.now();
      expect(backoffTime).toBeLessThanOrEqual(30000); // Max backoff is 30 seconds
    });
  });
  
  describe('Reset Functionality', () => {
    it('should reset account metrics', async () => {
      const accountName = 'TEST_ACCOUNT';
      
      // Create some failure history
      await circuitBreaker.recordFailure(accountName, 'Error 1');
      await circuitBreaker.recordFailure(accountName, 'Error 2');
      
      // Reset the account
      circuitBreaker.reset(accountName);
      
      const metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.totalFailures).toBe(0);
      expect(metrics.totalSuccesses).toBe(0);
    });
    
    it('should reset all accounts', async () => {
      // Create failure history for multiple accounts
      await circuitBreaker.recordFailure('ACCOUNT_1', 'Error');
      await circuitBreaker.recordFailure('ACCOUNT_2', 'Error');
      await circuitBreaker.recordFailure('ACCOUNT_3', 'Error');
      
      // Reset all
      circuitBreaker.reset('ACCOUNT_1');
      circuitBreaker.reset('ACCOUNT_2');
      circuitBreaker.reset('ACCOUNT_3');
      
      const metrics1 = circuitBreaker.getAccountMetrics('ACCOUNT_1');
      const metrics2 = circuitBreaker.getAccountMetrics('ACCOUNT_2');
      const metrics3 = circuitBreaker.getAccountMetrics('ACCOUNT_3');
      
      expect(metrics1.failureCount).toBe(0);
      expect(metrics2.failureCount).toBe(0);
      expect(metrics3.failureCount).toBe(0);
    });
  });
  
  describe('getAllMetrics', () => {
    it('should return metrics for all tracked accounts', async () => {
      // Track multiple accounts
      await circuitBreaker.recordSuccess('ACCOUNT_1');
      await circuitBreaker.recordFailure('ACCOUNT_2', 'Error');
      await circuitBreaker.recordSuccess('ACCOUNT_3');
      
      const allMetrics = circuitBreaker.getAllMetrics();
      
      expect(Object.keys(allMetrics)).toHaveLength(3);
      expect(Object.keys(allMetrics).sort()).toEqual([
        'ACCOUNT_1',
        'ACCOUNT_2',
        'ACCOUNT_3',
      ]);
    });
  });
  
  describe('Error Handling', () => {
    it('should handle rapid successive failures gracefully', async () => {
      const accountName = 'TEST_ACCOUNT';
      const promises = [];
      
      // Fire 10 failures simultaneously
      for (let i = 0; i < 10; i++) {
        promises.push(circuitBreaker.recordFailure(accountName, `Error ${i}`));
      }
      
      await Promise.all(promises);
      
      const metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.state).toBe(CircuitState.OPEN);
      expect(metrics.failureCount).toBeGreaterThanOrEqual(3);
    });
    
    it('should handle concurrent success and failure recording', async () => {
      const accountName = 'TEST_ACCOUNT';
      const promises = [];
      
      // Mix successes and failures
      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          promises.push(circuitBreaker.recordSuccess(accountName));
        } else {
          promises.push(circuitBreaker.recordFailure(accountName, `Error ${i}`));
        }
      }
      
      await Promise.all(promises);
      
      const metrics = circuitBreaker.getAccountMetrics(accountName);
      expect(metrics.totalFailures).toBeGreaterThan(0);
      expect(metrics.totalSuccesses).toBeGreaterThan(0);
    });
  });
});