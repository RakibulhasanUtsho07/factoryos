import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canExecuteAgentStep,
  createAiAgentControlCenterClient,
  isTerminalAgentTaskState,
} from './ai-agent-control-center.mjs';

const tenantId = '11111111-1111-4111-8111-111111111111';
const factoryId = '22222222-2222-4222-8222-222222222222';

function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('client binds bearer authentication and factory request context without trusting a caller user id', async () => {
  const calls = [];
  const client = createAiAgentControlCenterClient({
    apiOrigin: 'https://factory-api.example.com',
    accessToken: 'ephemeral-token',
    tenantId,
    factoryId,
    idFactory: (() => {
      let n = 0;
      return () => `request-${++n}`;
    })(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ data: { items: [], count: 0, limit: 25 } });
    },
  });

  const result = await client.listTasks(25);
  assert.deepEqual(result, { items: [], count: 0, limit: 25 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://factory-api.example.com/api/v1/ai/tasks?limit=25');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, 'Bearer ephemeral-token');
  assert.equal(calls[0].options.headers['x-tenant-id'], tenantId);
  assert.equal(calls[0].options.headers['x-factory-id'], factoryId);
  assert.equal(calls[0].options.headers['x-request-id'], 'request-1');
  assert.equal(calls[0].options.headers['x-trace-id'], 'request-2');
  assert.equal(Object.keys(calls[0].options.headers).some((key) => key.toLowerCase() === 'x-user-id'), false);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('non-local HTTP, URL credentials and non-origin paths are rejected before a request', () => {
  const make = (apiOrigin) => () => createAiAgentControlCenterClient({
    apiOrigin,
    accessToken: 'token',
    tenantId,
    factoryId,
    fetchImpl: async () => fakeResponse({ data: {} }),
    idFactory: () => 'id',
  });

  assert.throws(make('http://factory-api.example.com'), /HTTPS/);
  assert.throws(make('https://user:secret@factory-api.example.com'), /only the API origin/);
  assert.throws(make('https://factory-api.example.com/api'), /only the API origin/);
});

test('invalid credentials and scope fail before network access', () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeResponse({ data: {} });
  };
  assert.throws(() => createAiAgentControlCenterClient({
    apiOrigin: 'https://factory-api.example.com',
    accessToken: '',
    tenantId,
    factoryId,
    fetchImpl,
  }), /bearer access token/);
  assert.throws(() => createAiAgentControlCenterClient({
    apiOrigin: 'https://factory-api.example.com',
    accessToken: 'token',
    tenantId: 'not-a-uuid',
    factoryId,
    fetchImpl,
  }), /Tenant ID/);
  assert.equal(called, false);
});

test('control writes are explicit POST actions and API response envelopes are unwrapped', async () => {
  const calls = [];
  const client = createAiAgentControlCenterClient({
    apiOrigin: 'https://factory-api.example.com',
    accessToken: 'token',
    tenantId,
    factoryId,
    idFactory: () => 'request-id',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ data: { status: 'PAUSED', revision: '3' } });
    },
  });

  const result = await client.setAgentControl(
    'agent-definition/1',
    { status: 'PAUSED', execution_scopes: [], reason: 'Operator pause' },
  );
  assert.deepEqual(result, { status: 'PAUSED', revision: '3' });
  assert.equal(calls[0].url, 'https://factory-api.example.com/api/v1/ai/agents/catalogue/agent-definition%2F1/control');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    status: 'PAUSED', execution_scopes: [], reason: 'Operator pause',
  });
});

test('task list bound is validated before fetch', () => {
  const client = createAiAgentControlCenterClient({
    apiOrigin: 'https://factory-api.example.com',
    accessToken: 'token',
    tenantId,
    factoryId,
    fetchImpl: async () => fakeResponse({ data: {} }),
    idFactory: () => 'id',
  });
  assert.throws(() => client.listTasks(101), /between 1 and 100/);
});

test('task step actions are enabled only for pending and due retries', () => {
  assert.equal(canExecuteAgentStep({ status: 'PENDING' }), true);
  assert.equal(canExecuteAgentStep({ status: 'RUNNING' }), false);
  assert.equal(canExecuteAgentStep({ status: 'AWAITING_APPROVAL' }), false);
  assert.equal(canExecuteAgentStep({ status: 'PENDING', nextRetryAt: 'not-a-date' }), false);
  assert.equal(canExecuteAgentStep({ status: 'PENDING', nextRetryAt: '2099-01-01T00:00:00Z' }, Date.parse('2026-11-04T00:00:00Z')), false);
  assert.equal(canExecuteAgentStep({ status: 'PENDING', nextRetryAt: '2020-01-01T00:00:00Z' }, Date.parse('2026-11-04T00:00:00Z')), true);
});

test('terminal task states are identified without guessing provider completion', () => {
  assert.equal(isTerminalAgentTaskState('COMPLETED'), true);
  assert.equal(isTerminalAgentTaskState('BLOCKED'), true);
  assert.equal(isTerminalAgentTaskState('RUNNING'), false);
});
