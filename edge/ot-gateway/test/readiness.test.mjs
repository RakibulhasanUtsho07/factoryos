import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGatewayReadiness } from '../src/index.mjs';

const base = {
  httpReady: true,
  shuttingDown: false,
  driverReady: true,
  spoolStats: { queued: 4, blocked: 0, oldestEnqueuedAt: '2026-10-24T10:00:00Z' },
  spoolCapacity: 5,
};

test('readiness remains available while the durable queue has capacity', () => {
  assert.deepEqual(evaluateGatewayReadiness(base), {
    ready: true,
    status: 'ready',
    reason: null,
    spoolCapacityAvailable: true,
  });
});

test('readiness fails closed at exact spool capacity', () => {
  const result = evaluateGatewayReadiness({
    ...base,
    spoolStats: { ...base.spoolStats, queued: 5 },
  });
  assert.equal(result.ready, false);
  assert.equal(result.status, 'not_ready');
  assert.equal(result.reason, 'SPOOL_CAPACITY_REACHED');
  assert.equal(result.spoolCapacityAvailable, false);
});

test('readiness fails closed when spool stats are unavailable or malformed', () => {
  const unavailable = evaluateGatewayReadiness({
    ...base,
    spoolStats: null,
    spoolAvailable: false,
  });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.reason, 'SPOOL_STATUS_UNAVAILABLE');

  const malformed = evaluateGatewayReadiness({
    ...base,
    spoolStats: { queued: -1 },
  });
  assert.equal(malformed.ready, false);
  assert.equal(malformed.reason, 'SPOOL_STATUS_UNAVAILABLE');
});

test('readiness fails closed when spool capacity configuration is invalid', () => {
  const result = evaluateGatewayReadiness({ ...base, spoolCapacity: 0 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'SPOOL_CAPACITY_INVALID');
});

test('protocol-driver and HTTP readiness faults take precedence over queue capacity', () => {
  const driverFault = evaluateGatewayReadiness({
    ...base, driverReady: false, spoolStats: { queued: 5 },
  });
  assert.equal(driverFault.ready, false);
  assert.equal(driverFault.reason, 'PROTOCOL_DRIVERS_NOT_READY');

  const httpFault = evaluateGatewayReadiness({ ...base, httpReady: false });
  assert.equal(httpFault.ready, false);
  assert.equal(httpFault.reason, 'HTTP_NOT_READY');

  const stopping = evaluateGatewayReadiness({ ...base, shuttingDown: true });
  assert.equal(stopping.ready, false);
  assert.equal(stopping.status, 'stopping');
  assert.equal(stopping.reason, 'SHUTTING_DOWN');
});

test('readiness fails closed while any durable spool entry is blocked for operator review', () => {
  const result = evaluateGatewayReadiness({
    ...base,
    spoolStats: { ...base.spoolStats, blocked: 1 },
  });
  assert.equal(result.ready, false);
  assert.equal(result.status, 'not_ready');
  assert.equal(result.reason, 'SPOOL_HAS_BLOCKED_ENTRIES');
  assert.equal(result.spoolCapacityAvailable, true);
});

test('readiness rejects a spool status without a valid blocked-entry count', () => {
  const result = evaluateGatewayReadiness({
    ...base,
    spoolStats: { queued: 1, blocked: Number.NaN },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'SPOOL_STATUS_UNAVAILABLE');
});
