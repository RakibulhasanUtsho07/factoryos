import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canExecuteAgentStep,
  createAiAgentControlCenterClient,
  isTerminalAgentTaskState,
} from './ai-agent-control-center.mjs';

test('AI client delegates every request to the authenticated factory session', async () => {
  const calls = [];
  const client = createAiAgentControlCenterClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [], count: 0, limit: 25 };
    },
  });

  const result = await client.listTasks(25);
  assert.deepEqual(result, { items: [], count: 0, limit: 25 });
  assert.deepEqual(calls, [{
    path: '/v1/ai/tasks?limit=25',
    options: {},
  }]);
});

test('AI client uses explicit POST requests for material control and task actions', async () => {
  const calls = [];
  const client = createAiAgentControlCenterClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { accepted: true };
    },
  });

  await client.setAgentControl(
    'agent-definition/1',
    { status: 'PAUSED', execution_scopes: [], reason: 'Operator pause' },
  );
  await client.executeStep('task-id', 'step-id');
  await client.resumeTaskStep('task-id', 'step-id');
  await client.cancelTask('task-id');
  await client.verifyTask('task-id');

  assert.deepEqual(calls, [
    {
      path: '/v1/ai/agents/catalogue/agent-definition%2F1/control',
      options: { method: 'POST', body: { status: 'PAUSED', execution_scopes: [], reason: 'Operator pause' } },
    },
    { path: '/v1/ai/tasks/task-id/steps/step-id/execute', options: { method: 'POST' } },
    { path: '/v1/ai/tasks/task-id/steps/step-id/resume', options: { method: 'POST' } },
    { path: '/v1/ai/tasks/task-id/cancel', options: { method: 'POST' } },
    { path: '/v1/ai/tasks/task-id/verify', options: { method: 'POST' } },
  ]);
});

test('AI client requires the shared authenticated session request function', () => {
  assert.throws(() => createAiAgentControlCenterClient({ request: null }), /authenticated.*session/i);
});

test('task list bound is validated before a request', () => {
  let called = false;
  const client = createAiAgentControlCenterClient({
    request: async () => {
      called = true;
      return {};
    },
  });
  assert.throws(() => client.listTasks(101), /between 1 and 100/);
  assert.equal(called, false);
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
