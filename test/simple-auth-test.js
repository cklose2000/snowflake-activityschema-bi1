#!/usr/bin/env node

const { execSync } = require('child_process');

// Clean up old test events
execSync('snow sql -q "DELETE FROM AUTH_EVENTS WHERE event_id LIKE \'test-%\'"');

// Get initial count
const before = execSync('snow sql -q "SELECT COUNT(*) as c FROM AUTH_EVENTS"', { encoding: 'utf-8' });
console.log('Before:', before.match(/\d+/)?.[0] || '0');

// Insert test event
execSync('snow sql -q "INSERT INTO AUTH_EVENTS (event_id, account_name, event_type) VALUES (\'test-simple\', \'CLAUDE_DESKTOP1\', \'test\')"');

// Get final count
const after = execSync('snow sql -q "SELECT COUNT(*) as c FROM AUTH_EVENTS"', { encoding: 'utf-8' });
console.log('After:', after.match(/\d+/)?.[0] || '0');

// Show the event
const events = execSync('snow sql -q "SELECT event_id, account_name, event_type FROM AUTH_EVENTS WHERE event_id = \'test-simple\'"', { encoding: 'utf-8' });
console.log('Event:', events);

console.log('✅ Direct SQL insert works!');