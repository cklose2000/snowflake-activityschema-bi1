// Jest test setup
import { config } from 'dotenv';

// Load environment variables for testing
config({ path: '../.env' });

// Set test environment
process.env.NODE_ENV = 'test';