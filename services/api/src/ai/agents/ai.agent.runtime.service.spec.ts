import {
  createHash,
} from 'node:crypto';

import {
  jest,
} from '@jest/globals';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import {
  AiAgentRuntimeService,
} from './ai.agent.runtime.service';

const tenantId =
  'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId =
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId =
  '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const decisionId =
  '6f1a3333-3333-4333-8333-333333333333';
const traceId =
  '6f1a2222-2222-4222-8222-222222222222';
const taskId =
  '7f1a2222-2222-4222-8222-222222222222';
const stepId =
  '8f1a2222-2222-4222-8222-222222222222';
const actionIntentId =
  '9f1a2222-2222-4222-8222-222222222222';
const approvalId =
  'af1a2222-2222-4222-8222-222222222222';

function hashPayload(value: unknown): string {
  const canonicalize = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      return current.map(canonicalize);
    }
    if (current !== null && typeof current === 'object') {
      const object = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]),
      );
    }
    return current;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

function taskRow(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: taskId,
    tenant_id: tenantId,
    factory_id: factoryId,
    decision_id: decisionId,
    parent_trace_id: traceId,
    actor_user_id: userId,
    goal: 'Run deterministic AI agent task',
    state: 'PLAN_READY',
    max_steps: 20,
    max_retries: 3,
    max_tool_calls: 20,
    timeout_ms: 60_000,
    deadline_at: '2099-01-01T00:00:00.000Z',
    retry_count: 0,
    tool_call_count: 0,
    completed_step_count: 0,
    current_step_id: null,
    context_version: 'cbb-1',
    plan_version: 'plan-1',
    context_hash: 'a'.repeat(64),
    cancel_requested_at: null,
    failure_code: null,
    failure_reason: null,
    idempotency_key: 'task-001',
    request_hash: null,
    version: 1,
    created_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}

function stepRow(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: stepId,
    tenant_id: tenantId,
    factory_id: factoryId,
    task_id: taskId,
    step_key: 'step-1',
    step_index: 0,
    agent_id: 'AGENT.TEST',
    capability: 'deterministic-test',
    input_schema: {
      type: 'object',
    },
    output_schema: {
      type: 'object',
    },
    tool_id: 'AI.RUNTIME.NOOP',
    tool_version: '1.0.0',
    action_type: 'AI.RUNTIME.NOOP',
    target: {},
    payload: {
      sample: 'value',
    },
    resource_type: null,
    resource_id: null,
    risk_class: 'L0',
    timeout_ms: 1000,
    retry_limit: 1,
    authority_level: 'TASK_SCOPED',
    depends_on: [],
    status: 'PENDING',
    retry_count: 0,
    next_retry_at: null,
    authorization_attempt: 0,
    action_intent_id: null,
    approval_id: null,
    execution_record_id: null,
    execution_evidence: {},
    output: {},
    error: {},
    started_at: null,
    finished_at: null,
    version: 1,
    created_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}

function action(overrides: Record<string, unknown> = {}) {
  const payload =
    overrides.payload !== null &&
    typeof overrides.payload === 'object' &&
    !Array.isArray(overrides.payload)
      ? overrides.payload as Record<string, unknown>
      : { sample: 'value' };
  return {
    id: actionIntentId,
    tenantId,
    factoryId,
    decisionId,
    actionType: 'AI.RUNTIME.NOOP',
    toolId: 'AI.RUNTIME.NOOP',
    toolVersion: '1.0.0',
    target: {},
    resourceType: null,
    resourceId: null,
    payload,
    payloadHash: hashPayload(payload),
    riskClass: 'L0',
    authorizationStatus: 'AUTHORIZED',
    approvalId: null,
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    idempotencyKey: 'agent-auth-1',
    ...overrides,
  };
}

function gatewayOutcome(inputsHash = hashPayload({ sample: 'value' })) {
  return {
    status: 'SUCCEEDED' as const,
    result: {
      execution: 'NO_SIDE_EFFECT',
      executorType: 'AGENT_RUNTIME',
      actionType: 'AI.RUNTIME.NOOP',
      committed: false,
    },
    error: {},
    tool: {
      id: 'tool-row',
      tenantId: null,
      factoryId: null,
      toolId: 'AI.RUNTIME.NOOP',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
      },
      outputSchema: {
        type: 'object',
      },
      riskClass: 'L0',
      requiredScopes: ['ai.actions.execute'],
      approvalMode: 'none',
      writeCapable: false,
      idempotencyRequired: false,
      timeoutMs: 1000,
      auditMode: 'REDACTED',
      rollback: {
        type: 'NONE',
      },
      status: 'ACTIVE',
      metadata: {},
      createdBy: null,
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
    },
    executorType: 'AGENT_RUNTIME',
    toolVersion: '1.0.0',
    inputsHash,
  };
}

function agentExecutionResult(
  outcome = gatewayOutcome(),
  executionKey = `agent:${taskId}:${stepId}:1`,
) {
  return {
    idempotent: false,
    execution: {
      id: 'bf1a2222-2222-4222-8222-222222222222',
      tenantId,
      factoryId,
      decisionId,
      actionIntentId,
      executionKey,
      executorType: 'AGENT_RUNTIME',
      toolVersion: outcome.toolVersion,
      inputsHash: outcome.inputsHash,
      result: outcome.result,
      error: outcome.error,
      status: outcome.status,
      startedAt: '2026-10-07T00:00:00.000Z',
      finishedAt: '2026-10-07T00:00:01.000Z',
    },
  };
}

describe(
  'AiAgentRuntimeService',
  () => {
    let service: AiAgentRuntimeService;

    const database = {
      query: jest.fn<() => Promise<unknown>>(),
      transaction: jest.fn<() => Promise<unknown>>(),
    };

    const auditService = {
      record: jest.fn<() => Promise<string>>(),
    };

    const iamService = {
      authorize: jest.fn<() => Promise<void>>(),
    };

    const aiRuntimeService = {
      authorizeAction: jest.fn<() => Promise<unknown>>(),
      executeAgentAction: jest.fn<() => Promise<unknown>>(),
    };

    const aiAgentCatalogueService = {
      assertToolEntitled: jest.fn<() => Promise<unknown>>(),
    };

    const toolRegistry = {
      getTool: jest.fn<() => Promise<unknown>>(),
    };

    beforeEach(() => {
      jest.clearAllMocks();

      iamService.authorize.mockResolvedValue(undefined);
      auditService.record.mockResolvedValue('audit-id');
      aiAgentCatalogueService.assertToolEntitled.mockResolvedValue({});
      aiRuntimeService.executeAgentAction.mockResolvedValue(agentExecutionResult());
      database.query.mockResolvedValue({ rows: [], rowCount: 1 });
      toolRegistry.getTool.mockResolvedValue(gatewayOutcome().tool);

      service = new AiAgentRuntimeService(
        database as never,
        auditService as never,
        iamService as never,
        aiRuntimeService as never,
        aiAgentCatalogueService as never,
        toolRegistry as never,
      );
    });

    const buildTaskRequest = (goal = 'Run deterministic AI agent task') => ({
      decisionId,
      parentTraceId: traceId,
      goal,
      idempotencyKey: 'task-001',
      steps: [
        {
          stepKey: 'step-1',
          capability: 'deterministic-test',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
          target: {},
          payload: { sample: 'value' },
          riskClass: 'L0',
          timeoutMs: 1000,
          retryLimit: 1,
          authorityLevel: 'TASK_SCOPED',
          dependsOn: [],
        },
      ],
    });

    const hashTaskRequest = (input: ReturnType<typeof buildTaskRequest>) =>
      (service as any).computeTaskRequestHash({
        tenantId,
        factoryId,
        actorUserId: userId,
        input,
        decisionId: input.decisionId,
        parentTraceId: input.parentTraceId,
        goal: input.goal,
        limits: {
          maxSteps: 20,
          maxRetries: 3,
          maxToolCalls: 20,
          timeoutMs: 60_000,
        },
        deadlineAt: '2099-01-01T00:00:00.000Z',
        contextVersion: null,
        planVersion: null,
        contextHash: null,
      });

    it('rejects task creation when the deadline expires before the database insert', async () => {
      const insertQuery = jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({ rows: [] });

      (database.transaction as any).mockImplementationOnce(
        async (
          work: (
            client: {
              query: (...args: unknown[]) => Promise<unknown>;
            },
          ) => Promise<unknown>,
        ) => work({ query: insertQuery }),
      );

      await expect(
        service.createTask(
          tenantId,
          factoryId,
          userId,
          buildTaskRequest(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(insertQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = insertQuery.mock.calls[0] ?? [];
      expect(sql).toContain('WHERE $12::timestamptz > NOW()');
      expect(Array.isArray(values)).toBe(true);
      expect((values as unknown[])[11]).toEqual(expect.any(String));
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('replays a task only when the idempotency key matches the request fingerprint', async () => {
      const input = buildTaskRequest();
      const requestHash = hashTaskRequest(input);
      (service as any).getTaskByIdempotencyKey = jest
        .fn()
        .mockResolvedValue(taskRow({ request_hash: requestHash }));

      const result = await service.createTask(
        tenantId,
        factoryId,
        userId,
        input,
      );

      expect(result.idempotent).toBe(true);
      expect(result.task.id).toBe(taskId);
      expect(database.transaction).not.toHaveBeenCalled();
    });

    it('rejects an idempotency key reused with a different task payload', async () => {
      const originalInput = buildTaskRequest();
      const originalHash = hashTaskRequest(originalInput);
      (service as any).getTaskByIdempotencyKey = jest
        .fn()
        .mockResolvedValue(taskRow({ request_hash: originalHash }));

      await expect(
        service.createTask(
          tenantId,
          factoryId,
          userId,
          buildTaskRequest('Different task goal'),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(database.transaction).not.toHaveBeenCalled();
    });

    it('fails closed for an existing idempotency key without a stored fingerprint', async () => {
      (service as any).getTaskByIdempotencyKey = jest
        .fn()
        .mockResolvedValue(taskRow({ request_hash: null }));

      await expect(
        service.createTask(
          tenantId,
          factoryId,
          userId,
          buildTaskRequest(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(database.transaction).not.toHaveBeenCalled();
    });

    it('replays the winning task when concurrent creates race on the same idempotency key', async () => {
      const input = buildTaskRequest();
      const requestHash = hashTaskRequest(input);

      (service as any).getTaskByIdempotencyKey = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(taskRow({ request_hash: requestHash }));

      const uniqueConflict = Object.assign(
        new Error('duplicate key violates unique constraint'),
        {
          code: '23505',
          constraint: 'uq_agent_tasks_tenant_idempotency',
        },
      );
      database.transaction.mockRejectedValueOnce(uniqueConflict);

      const result = await service.createTask(
        tenantId,
        factoryId,
        userId,
        input,
      );

      expect(result.idempotent).toBe(true);
      expect(result.task.id).toBe(taskId);
      expect((service as any).getTaskByIdempotencyKey).toHaveBeenCalledTimes(2);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rejects a concurrent idempotency-key race when the winning request fingerprint differs', async () => {
      const input = buildTaskRequest();

      (service as any).getTaskByIdempotencyKey = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(taskRow({ request_hash: 'f'.repeat(64) }));

      database.transaction.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_agent_tasks_tenant_idempotency',
        }),
      );

      await expect(
        service.createTask(tenantId, factoryId, userId, input),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((service as any).getTaskByIdempotencyKey).toHaveBeenCalledTimes(2);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('does not reinterpret unrelated unique-constraint failures as idempotent replays', async () => {
      (service as any).getTaskByIdempotencyKey = jest
        .fn()
        .mockResolvedValueOnce(null);

      const uniqueConflict = Object.assign(
        new Error('duplicate step key'),
        {
          code: '23505',
          constraint: 'uq_agent_task_steps_task_key',
        },
      );
      database.transaction.mockRejectedValueOnce(uniqueConflict);

      await expect(
        service.createTask(
          tenantId,
          factoryId,
          userId,
          buildTaskRequest(),
        ),
      ).rejects.toBe(uniqueConflict);
      expect((service as any).getTaskByIdempotencyKey).toHaveBeenCalledTimes(1);
    });

    it('accepts the canonical CREATED -> CONTEXT_READY transition', async () => {
      const oldTask = taskRow({
        state: 'CREATED',
      });
      const newTask = taskRow({
        state: 'CONTEXT_READY',
        version: 2,
      });

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(oldTask);
      database.query.mockResolvedValueOnce({
        rows: [newTask],
      });

      const result = await service.transitionState(
        tenantId,
        factoryId,
        userId,
        taskId,
        'CREATED',
        'CONTEXT_READY',
      );

      expect(result.state).toBe('CONTEXT_READY');
      expect(database.query).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid state transition before database mutation', async () => {
      await expect(
        service.transitionState(
          tenantId,
          factoryId,
          userId,
          taskId,
          'CREATED',
          'EXECUTING',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(database.query).not.toHaveBeenCalled();
    });

    it('returns an idempotent result when a step is already succeeded', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });
      const step = stepRow({
        status: 'SUCCEEDED',
      });

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);

      const result = await service.executeStep(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
      );

      expect(result.idempotent).toBe(true);
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('does not execute a scheduled retry before its persisted due time', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow({
        status: 'PENDING',
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      });
      (service as any).requireTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(task);
      (service as any).requireStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(step);

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(database.query).not.toHaveBeenCalled();
      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('atomically rechecks retry eligibility in PostgreSQL after the application-level due-time check', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow({
        status: 'PENDING',
        next_retry_at: new Date(Date.now() - 1_000).toISOString(),
      });
      (service as any).requireTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(task);
      (service as any).requireStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(database.query).toHaveBeenCalledTimes(1);
      const sql = String(database.query.mock.calls[0]?.[0] ?? '');
      expect(sql).toContain('next_retry_at = NULL');
      expect(sql).toContain('(next_retry_at IS NULL OR next_retry_at <= NOW())');
      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('stops a cancelled task before Tool Gateway execution', async () => {
      const task = taskRow({
        state: 'CANCELLED',
        cancel_requested_at: '2026-10-07T00:01:00.000Z',
      });
      const step = stepRow();

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);

      await expect(
        service.executeStep(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('stops when the maximum tool-call budget is exhausted', async () => {
      const task = taskRow({
        state: 'EXECUTING',
        tool_call_count: 20,
        max_tool_calls: 20,
      });
      const step = stepRow();

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);

      await expect(
        service.executeStep(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('conditions the final tool-call claim on an unexpired database deadline', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        (service as any).claimToolCall(
          tenantId,
          factoryId,
          userId,
          task,
          stepId,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const queryCalls = (database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls;
      const sql = String(queryCalls[0]?.[0] ?? '');
      expect(sql).toContain('AND deadline_at > NOW()');
      expect(sql).toContain('AND cancel_requested_at IS NULL');
      expect(sql).toContain('AND tool_call_count < max_tool_calls');
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('does not let a delayed task-state update resurrect a cancelled task', async () => {
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        (service as any).updateTaskStateRaw(
          tenantId,
          factoryId,
          userId,
          taskId,
          'VERIFYING',
          { completedStepCount: 1 },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const queryCalls = (database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls;
      const sql = String(queryCalls[0]?.[0] ?? '');
      expect(sql).toContain(
        "AND state NOT IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')",
      );
      expect(sql).toContain('AND cancel_requested_at IS NULL');
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('rejects a concurrent step execution when its optimistic claim loses the race', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow();

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();

      database.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('fails closed when an authorized action intent is bound to another tool version', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow();
      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();
      (service as any).failTask = jest.fn<() => Promise<unknown>>();
      (service as any).claimToolCall = jest.fn<() => Promise<unknown>>();

      database.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({ authorizationStatus: 'AUTHORIZED', toolVersion: '9.9.9' }),
        actionToken: 'short-lived-token',
      });

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.authorizeAction).toHaveBeenCalledTimes(1);
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
      expect((service as any).claimToolCall).not.toHaveBeenCalled();
      expect((service as any).failTask).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        userId,
        taskId,
        'AI_AGENT_EXECUTION_FAILURE',
        'AI action authorization does not match the bound agent task step',
        stepId,
      );
    });

    it('moves a material step into AWAITING_APPROVAL when authorization requires approval', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });
      const step = stepRow();
      const waitingTask = taskRow({
        state: 'AWAITING_APPROVAL',
        current_step_id: stepId,
        version: 2,
      });
      const waitingStep = stepRow({
        status: 'AWAITING_APPROVAL',
        approval_id: approvalId,
        action_intent_id: actionIntentId,
        authorization_attempt: 1,
      });

      (service as any).requireTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(task);
      (service as any).requireStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(step);
      (service as any).updateTaskStateRaw = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(waitingTask);
      (service as any).updateStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(waitingStep);

      database.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({
          authorizationStatus: 'APPROVAL_REQUIRED',
          approvalId,
        }),
        actionToken: null,
      });

      const result = await service.executeStep(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
      );

      expect(result.waitingForApproval).toBe(true);
      expect(result.task.state).toBe('AWAITING_APPROVAL');
      expect(result.step.approvalId).toBe(approvalId);
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('re-checks the approval on resume and executes through durable claims', async () => {
      const task = taskRow({
        state: 'AWAITING_APPROVAL',
      });
      const step = stepRow({
        status: 'AWAITING_APPROVAL',
        approval_id: approvalId,
        authorization_attempt: 1,
      });
      const runningStep = stepRow({
        status: 'RUNNING',
        action_intent_id: actionIntentId,
        approval_id: approvalId,
        authorization_attempt: 2,
      });
      const succeededStep = stepRow({
        status: 'SUCCEEDED',
        action_intent_id: actionIntentId,
        execution_record_id: 'bf1a2222-2222-4222-8222-222222222222',
        output: {
          execution: 'NO_SIDE_EFFECT',
        },
      });
      const executingTask = taskRow({
        state: 'EXECUTING',
        version: 3,
      });
      const verifyingTask = taskRow({
        state: 'VERIFYING',
        version: 4,
        completed_step_count: 1,
      });

      (service as any).requireTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(task);
      (service as any).requireStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();
      (service as any).transitionState = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(executingTask);
      (service as any).claimToolCall = jest.fn<() => Promise<unknown>>();
      (service as any).updateStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(runningStep)
        .mockResolvedValueOnce(succeededStep);
      (service as any).countCompletedSteps = jest.fn<() => Promise<unknown>>().mockResolvedValue(1);
      (service as any).countSteps = jest.fn<() => Promise<unknown>>().mockResolvedValue(1);
      (service as any).updateTaskStateRaw = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(verifyingTask);
      (service as any).recordAttempt = jest.fn<() => Promise<unknown>>();

      database.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({
          authorizationStatus: 'AUTHORIZED',
          approvalId,
        }),
        actionToken: 'short-lived-token',
      });
      aiRuntimeService.executeAgentAction.mockResolvedValue(agentExecutionResult());

      const result = await service.executeStep(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
      );

      expect(
        aiAgentCatalogueService.assertToolEntitled,
      ).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        'AGENT.TEST',
        'AI.RUNTIME.NOOP',
        '1.0.0',
      );

      expect(
        aiRuntimeService.authorizeAction,
      ).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        userId,
        expect.objectContaining({
          approval_id: approvalId,
        }),
      );
      expect(aiRuntimeService.executeAgentAction).toHaveBeenCalledTimes(1);
      expect(result.step.status).toBe('SUCCEEDED');
      const successFields = (service as any).updateStep.mock.calls[1][4];
      expect(successFields.executionEvidence).toMatchObject({
        schemaVersion: 1,
        taskId,
        stepId,
        decisionId,
        parentTraceId: traceId,
        actionIntentId,
        executionRecordId: 'bf1a2222-2222-4222-8222-222222222222',
        executionKey: `agent:${taskId}:${stepId}:1`,
        toolId: 'AI.RUNTIME.NOOP',
        toolVersion: '1.0.0',
        executorType: 'AGENT_RUNTIME',
        inputsHash: hashPayload({ sample: 'value' }),
        outcomeStatus: 'SUCCEEDED',
      });
      expect(successFields.executionEvidence.outcomeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(successFields.executionEvidence)).not.toContain('short-lived-token');
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'AI_AGENT_STEP_EXECUTION',
        action: 'SUCCEEDED',
        correlationId: traceId,
        payload: expect.objectContaining({
          executionEvidence: expect.objectContaining({
            actionIntentId,
            executionRecordId: 'bf1a2222-2222-4222-8222-222222222222',
          }),
        }),
      }));
    });

    it('rejects an execution record that does not match the authorized action binding', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow();
      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();
      (service as any).claimToolCall = jest.fn<() => Promise<unknown>>();
      (service as any).recordAttempt = jest.fn<() => Promise<unknown>>();
      (service as any).failTask = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
      (service as any).updateStep = jest.fn<() => Promise<unknown>>()
        .mockResolvedValue(stepRow({ status: 'RUNNING', action_intent_id: actionIntentId }));
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action(),
        actionToken: 'short-lived-token',
      });
      const execution = agentExecutionResult().execution;
      aiRuntimeService.executeAgentAction.mockResolvedValue({
        idempotent: false,
        execution: { ...execution, actionIntentId: 'af1a2222-2222-4222-8222-222222222222' },
      });

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.executeAgentAction).toHaveBeenCalledTimes(1);
      expect((service as any).updateStep).toHaveBeenCalledTimes(1);
      expect((service as any).failTask).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        userId,
        taskId,
        'AI_AGENT_EXECUTION_FAILURE',
        'AI execution record does not match the bound agent action',
        stepId,
      );
    });

    it('does not execute when an authorized action intent payload differs from the step', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow();
      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();
      (service as any).failTask = jest.fn<() => Promise<unknown>>();
      (service as any).claimToolCall = jest.fn<() => Promise<unknown>>();

      database.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({
          authorizationStatus: 'AUTHORIZED',
          payload: { sample: 'different-value' },
        }),
        actionToken: 'short-lived-token',
      });

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
      expect((service as any).claimToolCall).not.toHaveBeenCalled();
    });

    it('fails closed when the agent tool entitlement is denied', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow();

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();

      aiAgentCatalogueService.assertToolEntitled.mockRejectedValue(
        new ForbiddenException('AI agent tool is not entitled'),
      );

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(aiAgentCatalogueService.assertToolEntitled).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        'AGENT.TEST',
        'AI.RUNTIME.NOOP',
        '1.0.0',
      );
      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
    });

    it('skips agent entitlement lookup for legacy steps without an agent binding', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });

      const step = stepRow({
        agent_id: null,
      });

      const runningStep = stepRow({
        status: 'RUNNING',
        action_intent_id: actionIntentId,
      });

      const succeededStep = stepRow({
        status: 'SUCCEEDED',
        action_intent_id: actionIntentId,
        execution_record_id:
          'bf1a2222-2222-4222-8222-222222222222',
        output: {
          execution: 'NO_SIDE_EFFECT',
        },
      });

      const verifyingTask = taskRow({
        state: 'VERIFYING',
        completed_step_count: 1,
      });

      (service as any).requireTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(task);

      (service as any).requireStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(step);

      (service as any).assertDependencies =
        jest.fn<() => Promise<unknown>>();

      (service as any).claimToolCall =
        jest.fn<() => Promise<unknown>>();

      (service as any).updateStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(runningStep)
        .mockResolvedValueOnce(succeededStep);

      (service as any).recordAttempt =
        jest.fn<() => Promise<unknown>>();


      (service as any).countCompletedSteps = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(1);

      (service as any).countSteps = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(1);

      (service as any).updateTaskStateRaw = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(verifyingTask);

      database.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action(),
        actionToken: 'token',
      });

      aiRuntimeService.executeAgentAction.mockResolvedValue(
        agentExecutionResult(),
      );

      const result =
        await service.executeStep(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
        );

      expect(
        aiAgentCatalogueService.assertToolEntitled,
      ).not.toHaveBeenCalled();

      expect(
        aiRuntimeService.authorizeAction,
      ).toHaveBeenCalledTimes(1);

      expect(
        aiRuntimeService.executeAgentAction,
      ).toHaveBeenCalledTimes(1);

      expect(result.step.status).toBe(
        'SUCCEEDED',
      );
    });

    it('exposes the persisted retry eligibility timestamp on the public step record', () => {
      const nextRetryAt = '2026-10-20T10:00:02.000Z';
      const mapped = (service as any).mapStep(
        stepRow({ next_retry_at: nextRetryAt }),
      );
      expect(mapped.nextRetryAt).toBe(nextRetryAt);
    });

    it('uses deterministic exponential backoff with a hard maximum delay', () => {
      expect((service as any).retryDelaySeconds(1)).toBe(2);
      expect((service as any).retryDelaySeconds(2)).toBe(4);
      expect((service as any).retryDelaySeconds(3)).toBe(8);
      expect((service as any).retryDelaySeconds(5)).toBe(32);
      expect((service as any).retryDelaySeconds(6)).toBe(60);
      expect((service as any).retryDelaySeconds(20)).toBe(60);
    });

    it('does not schedule a retry if backoff would outlive the task deadline', async () => {
      const task = taskRow({
        state: 'EXECUTING',
        deadline_at: new Date(Date.now() + 1_000).toISOString(),
      });
      const step = stepRow({
        status: 'RUNNING',
        retry_count: 0,
        retry_limit: 1,
      });
      (service as any).failTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({});

      await (service as any).applyFailure(
        tenantId,
        factoryId,
        userId,
        task,
        step,
        { code: 'TRANSIENT', message: 'execution failed' },
      );

      expect(database.query).not.toHaveBeenCalled();
      expect((service as any).failTask).toHaveBeenCalledTimes(1);
    });

    it('does not requeue a failed step when its atomic retry claim loses a cancellation race', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow({ status: 'RUNNING', retry_count: 0, retry_limit: 1 });
      (service as any).failTask = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await (service as any).applyFailure(
        tenantId,
        factoryId,
        userId,
        task,
        step,
        { code: 'TRANSIENT', message: 'execution failed' },
      );

      const queryCalls = (database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls;
      expect(queryCalls).toHaveLength(1);
      const sql = String(queryCalls[0]?.[0] ?? '');
      expect(sql).toContain("AND status = 'RUNNING'");
      expect(sql).toContain('FROM agent_tasks parent_task');
      expect(sql).toContain('parent_task.cancel_requested_at IS NULL');
      expect(sql).toContain('parent_task.deadline_at > NOW() + ($8::int * INTERVAL');
      expect(sql).toContain("next_retry_at = NOW() + ($8::int * INTERVAL '1 second')");
      expect((queryCalls[0]?.[1] as unknown[])[7]).toBe(2);
      expect((service as any).failTask).toHaveBeenCalledTimes(1);
    });

    it('guards retry state transition against cancellation and deadline expiry', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow({ status: 'RUNNING', retry_count: 0, retry_limit: 1 });
      (service as any).failTask = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
      database.query
        .mockResolvedValueOnce({ rows: [{ id: stepId }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await (service as any).applyFailure(
        tenantId,
        factoryId,
        userId,
        task,
        step,
        { code: 'TRANSIENT', message: 'execution failed' },
      );

      const queryCalls = (database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls;
      expect(queryCalls).toHaveLength(2);
      const sql = String(queryCalls[1]?.[0] ?? '');
      expect(sql).toContain('AND cancel_requested_at IS NULL');
      expect(sql).toContain('AND deadline_at > NOW()');
      expect(sql).toContain("state IN ('EXECUTING', 'AWAITING_AUTH')");
      expect((service as any).failTask).toHaveBeenCalledTimes(1);
    });

    it('does not automatically retry when durable execution reports an ambiguous claim', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow();

      (service as any).requireTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(task);
      (service as any).requireStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn<() => Promise<unknown>>();
      (service as any).claimToolCall = jest.fn<() => Promise<unknown>>();
      (service as any).updateStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(
          stepRow({
            status: 'RUNNING',
            action_intent_id: actionIntentId,
          }),
        );
      (service as any).recordAttempt = jest.fn<() => Promise<unknown>>();
      (service as any).failTask = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
      (service as any).applyFailure = jest.fn<() => Promise<unknown>>();

      database.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      });

      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action(),
        actionToken: 'token',
      });
      aiRuntimeService.executeAgentAction.mockRejectedValue(
        new ConflictException('execution claim is active or requires reconciliation'),
      );

      await expect(
        service.executeStep(tenantId, factoryId, userId, taskId, stepId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.executeAgentAction).toHaveBeenCalledTimes(1);
      expect((service as any).applyFailure).not.toHaveBeenCalled();
      expect((service as any).failTask).toHaveBeenCalledTimes(1);
    });

    it('upserts agent attempts atomically without reopening a terminal attempt', async () => {
      database.query.mockResolvedValueOnce({
        rows: [{ id: 'attempt-row-id' }],
        rowCount: 1,
      });

      await (service as any).recordAttempt(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        'STARTED',
      );

      expect(database.query).toHaveBeenCalledTimes(1);
      const sql = String(database.query.mock.calls[0]?.[0]);
      expect(sql).toContain('ON CONFLICT (task_id, step_id, attempt_number, attempt_type)');
      expect(sql).toContain("WHEN attempt_row.status IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')");
      expect(sql).toContain("OR EXCLUDED.status = 'STARTED'");
      expect(sql).toContain('attempt_row.execution_record_id = EXCLUDED.execution_record_id');
      expect(sql).toContain('attempt_row.tenant_id = EXCLUDED.tenant_id');
      expect(database.query.mock.calls[0]?.[1]).toEqual([
        expect.any(String),
        tenantId,
        factoryId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        null,
        null,
        'STARTED',
        '{}',
      ]);
    });

    it('fails closed when an attempt upsert conflicts with the recorded execution binding', async () => {
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        (service as any).recordAttempt(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
          1,
          'COMPENSATION',
          'SUCCEEDED',
          {},
          'bf1a2222-2222-4222-8222-222222222222',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(database.query).toHaveBeenCalledTimes(1);
      expect(String(database.query.mock.calls[0]?.[0])).toContain('ON CONFLICT');
    });

    it('does not execute compensation when the registered tool declares NONE rollback', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });
      const step = stepRow({
        status: 'SUCCEEDED',
      });

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      toolRegistry.getTool.mockResolvedValue({
        rollback: {
          type: 'NONE',
        },
      });

      const result = await service.compensateStep(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        {},
      );

      expect(result.attempted).toBe(false);
      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('uses the same attempt key for compensation authorization and durable execution', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow({
        status: 'SUCCEEDED',
        execution_record_id: 'bf1a2222-2222-4222-8222-222222222222',
      });
      const registeredTool = {
        ...gatewayOutcome().tool,
        rollback: {
          type: 'COMPENSATION',
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
        },
      };

      (service as any).requireTask = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(task);
      (service as any).requireStep = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(step);
      toolRegistry.getTool.mockResolvedValue(registeredTool);
      jest.spyOn(service as any, 'recordAttempt');
      database.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });
      database.query.mockResolvedValueOnce({
        rows: [{ id: 'compensation-attempt-id' }],
        rowCount: 1,
      });
      database.query.mockResolvedValueOnce({
        rows: [{ id: 'compensation-attempt-id' }],
        rowCount: 1,
      });
      const compensationPayload = { reason: 'verified compensation retry' };
      const compensationHash = hashPayload(compensationPayload);
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({ payload: compensationPayload, payloadHash: compensationHash }),
        actionToken: 'compensation-token',
      });
      aiRuntimeService.executeAgentAction.mockResolvedValue(
        agentExecutionResult(
          gatewayOutcome(compensationHash),
          `agent:${taskId}:${stepId}:compensation:1`,
        ),
      );

      const result = await service.compensateStep(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        compensationPayload,
      );

      const expectedKey = `agent:${taskId}:${stepId}:compensation:1`;
      expect(aiRuntimeService.authorizeAction).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        userId,
        expect.objectContaining({
          idempotency_key: expectedKey,
        }),
      );
      expect(aiRuntimeService.executeAgentAction).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        userId,
        expect.objectContaining({
          execution_key: expectedKey,
          action_token: 'compensation-token',
          tool_version: '1.0.0',
        }),
      );
      expect((service as any).recordAttempt).toHaveBeenNthCalledWith(
        1,
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        'STARTED',
        {},
        undefined,
        actionIntentId,
      );
      expect((service as any).recordAttempt).toHaveBeenNthCalledWith(
        2,
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        'SUCCEEDED',
        {},
        'bf1a2222-2222-4222-8222-222222222222',
        actionIntentId,
      );
      expect(result).toMatchObject({
        attempted: true,
        status: 'SUCCEEDED',
        executionEvidence: {
          schemaVersion: 1,
          executionKind: 'COMPENSATION',
          taskId,
          stepId,
          decisionId,
          parentTraceId: traceId,
          actionIntentId,
          executionRecordId: 'bf1a2222-2222-4222-8222-222222222222',
          executionKey: expectedKey,
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          executorType: 'AGENT_RUNTIME',
          inputsHash: compensationHash,
          outcomeStatus: 'SUCCEEDED',
          sourceExecutionRecordId: 'bf1a2222-2222-4222-8222-222222222222',
          attemptNumber: 1,
        },
      });
      expect(JSON.stringify(result.executionEvidence)).not.toContain('compensation-token');
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'AI_AGENT_COMPENSATION',
        action: 'SUCCEEDED',
        resourceId: stepId,
        correlationId: traceId,
        payload: expect.objectContaining({
          compensationEvidence: expect.objectContaining({
            actionIntentId,
            executionKey: expectedKey,
            executionRecordId: 'bf1a2222-2222-4222-8222-222222222222',
            sourceExecutionRecordId: 'bf1a2222-2222-4222-8222-222222222222',
          }),
        }),
      }));
    });

    it('rejects compensation authorization bound to a different rollback tool', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow({ status: 'SUCCEEDED' });
      const registeredTool = {
        ...gatewayOutcome().tool,
        rollback: {
          type: 'COMPENSATION',
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
        },
      };
      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      (service as any).recordAttempt = jest.fn<() => Promise<unknown>>();
      toolRegistry.getTool.mockResolvedValue(registeredTool);
      database.query.mockResolvedValueOnce({ rows: [{ max_number: null }], rowCount: 1 });
      const payload = { reason: 'wrongly bound compensation' };
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({ payload, payloadHash: hashPayload(payload), toolId: 'AI.RUNTIME.OTHER' }),
        actionToken: 'compensation-token',
      });

      await expect(
        service.compensateStep(tenantId, factoryId, userId, taskId, stepId, payload),
      ).rejects.toThrow('Compensation authorization does not match the registered rollback contract');

      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
      expect((service as any).recordAttempt).not.toHaveBeenCalled();
    });

    it('fails closed when the compensation execution record is bound to another action intent', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const sourceExecutionId = 'bf1a2222-2222-4222-8222-222222222222';
      const step = stepRow({ status: 'SUCCEEDED', execution_record_id: sourceExecutionId });
      const registeredTool = {
        ...gatewayOutcome().tool,
        rollback: {
          type: 'COMPENSATION',
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
        },
      };
      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      (service as any).recordAttempt = jest.fn<() => Promise<unknown>>();
      toolRegistry.getTool.mockResolvedValue(registeredTool);
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      database.query.mockResolvedValueOnce({ rows: [{ id: 'compensation-attempt-id' }], rowCount: 1 });
      const payload = { reason: 'verified compensation retry' };
      const payloadHash = hashPayload(payload);
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({ payload, payloadHash }),
        actionToken: 'compensation-token',
      });
      const execution = agentExecutionResult(
        gatewayOutcome(payloadHash),
        `agent:${taskId}:${stepId}:compensation:1`,
      ).execution;
      aiRuntimeService.executeAgentAction.mockResolvedValue({
        idempotent: false,
        execution: { ...execution, actionIntentId: 'af1a2222-2222-4222-8222-222222222222' },
      });

      await expect(
        service.compensateStep(tenantId, factoryId, userId, taskId, stepId, payload),
      ).rejects.toThrow('AI execution record does not match the bound agent action');

      expect(aiRuntimeService.executeAgentAction).toHaveBeenCalledTimes(1);
      expect((service as any).recordAttempt).toHaveBeenCalledTimes(1);
      expect((service as any).recordAttempt).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        'STARTED',
        {},
        undefined,
        actionIntentId,
      );
    });

    it('closes a reconciled failed compensation attempt before allocating the next attempt number', async () => {
      const payload = { reason: 'confirmed failed compensation' };
      const inputsHash = hashPayload(payload);
      const executionKey = `agent:${taskId}:${stepId}:compensation:1`;
      database.query.mockReset();
      database.query.mockResolvedValue({ rows: [], rowCount: 1 });
      database.query.mockResolvedValueOnce({
        rows: [{
          attempt_number: 1,
          status: 'STARTED',
          action_intent_id: actionIntentId,
        }],
        rowCount: 1,
      });
      database.query.mockResolvedValueOnce({
        rows: [{
          claim_status: 'FAILED',
          execution_key: executionKey,
          tool_version: '1.0.0',
          inputs_hash: inputsHash,
          execution_record_id: 'bf1a2222-2222-4222-8222-222222222222',
          execution_record_status: 'FAILED',
          record_execution_key: executionKey,
          record_tool_version: '1.0.0',
          record_inputs_hash: inputsHash,
          reconciliation_decision: 'CONFIRMED_FAILED',
        }],
        rowCount: 1,
      });
      database.query.mockResolvedValueOnce({
        rows: [{ id: 'attempt-id' }],
        rowCount: 1,
      });

      const nextAttempt = await (service as any).nextAttemptNumber(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        'COMPENSATION',
        '1.0.0',
      );

      expect(nextAttempt).toBe(2);
      expect(database.query).toHaveBeenCalledTimes(3);
      expect(database.query.mock.calls[2]?.[1]).toEqual([
        expect.any(String),
        tenantId,
        factoryId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        actionIntentId,
        'bf1a2222-2222-4222-8222-222222222222',
        'FAILED',
        JSON.stringify({
          code: 'AI_EXECUTION_CLAIM_FAILED',
          reconciliationDecision: 'CONFIRMED_FAILED',
        }),
      ]);
    });

    it('requires operator confirmation before retrying a failed compensation claim without a record', async () => {
      const executionKey = `agent:${taskId}:${stepId}:compensation:1`;
      database.query.mockReset();
      database.query.mockResolvedValue({ rows: [], rowCount: 1 });
      database.query.mockResolvedValueOnce({
        rows: [{
          attempt_number: 1,
          status: 'STARTED',
          action_intent_id: actionIntentId,
        }],
        rowCount: 1,
      });
      database.query.mockResolvedValueOnce({
        rows: [{
          claim_status: 'FAILED',
          execution_key: executionKey,
          tool_version: '1.0.0',
          inputs_hash: hashPayload({ reason: 'claim failure with unknown outcome' }),
          execution_record_id: null,
          execution_record_status: null,
          record_execution_key: null,
          record_tool_version: null,
          record_inputs_hash: null,
          reconciliation_decision: null,
        }],
        rowCount: 1,
      });

      await expect(
        (service as any).nextAttemptNumber(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
          'COMPENSATION',
          '1.0.0',
        ),
      ).rejects.toThrow(
        'A failed compensation claim without an execution record requires operator confirmation before retrying',
      );

      expect(database.query).toHaveBeenCalledTimes(2);
    });

    it('marks confirmed completed compensation and blocks duplicate rollback', async () => {
      const payload = { reason: 'completed compensation recovery' };
      const inputsHash = hashPayload(payload);
      const executionKey = `agent:${taskId}:${stepId}:compensation:1`;
      database.query.mockReset();
      database.query.mockResolvedValue({ rows: [], rowCount: 1 });
      database.query.mockResolvedValueOnce({
        rows: [{
          attempt_number: 1,
          status: 'STARTED',
          action_intent_id: actionIntentId,
        }],
        rowCount: 1,
      });
      database.query.mockResolvedValueOnce({
        rows: [{
          claim_status: 'COMPLETED',
          execution_key: executionKey,
          tool_version: '1.0.0',
          inputs_hash: inputsHash,
          execution_record_id: 'bf1a2222-2222-4222-8222-222222222222',
          execution_record_status: 'SUCCEEDED',
          record_execution_key: executionKey,
          record_tool_version: '1.0.0',
          record_inputs_hash: inputsHash,
          reconciliation_decision: null,
        }],
        rowCount: 1,
      });
      database.query.mockResolvedValueOnce({
        rows: [{ id: 'attempt-id' }],
        rowCount: 1,
      });

      await expect(
        (service as any).nextAttemptNumber(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
          'COMPENSATION',
          '1.0.0',
        ),
      ).rejects.toThrow(
        'The previous compensation attempt is confirmed completed; duplicate compensation is blocked',
      );

      expect(database.query).toHaveBeenCalledTimes(3);
      expect(database.query.mock.calls[2]?.[1]).toEqual([
        expect.any(String),
        tenantId,
        factoryId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        actionIntentId,
        'bf1a2222-2222-4222-8222-222222222222',
        'SUCCEEDED',
        '{}',
      ]);
    });

    it('blocks a new compensation attempt after an interrupted execution until claim reconciliation', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow({ status: 'SUCCEEDED' });
      const registeredTool = {
        ...gatewayOutcome().tool,
        rollback: {
          type: 'COMPENSATION',
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
        },
      };
      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      toolRegistry.getTool.mockResolvedValue(registeredTool);
      jest.spyOn(service as any, 'recordAttempt');
      // Reset any unused one-shot responses from neighboring failure-path tests.
      database.query.mockReset();
      database.query.mockResolvedValue({ rows: [], rowCount: 1 });
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      database.query.mockResolvedValueOnce({ rows: [{ id: 'attempt-id' }], rowCount: 1 });
      database.query.mockResolvedValueOnce({
        rows: [{
          attempt_number: 1,
          status: 'STARTED',
          action_intent_id: actionIntentId,
        }],
        rowCount: 1,
      });
      database.query.mockResolvedValueOnce({
        rows: [{
          claim_status: 'CLAIMED',
          execution_key: `agent:${taskId}:${stepId}:compensation:1`,
          tool_version: '1.0.0',
          inputs_hash: hashPayload({ reason: 'resume after a network interruption' }),
          execution_record_id: null,
          execution_record_status: null,
          record_execution_key: null,
          record_tool_version: null,
          record_inputs_hash: null,
          reconciliation_decision: null,
        }],
        rowCount: 1,
      });

      const payload = { reason: 'resume after a network interruption' };
      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({ payload, payloadHash: hashPayload(payload) }),
        actionToken: 'short-lived-compensation-token',
      });
      aiRuntimeService.executeAgentAction.mockRejectedValue(
        new ConflictException('execution claim is active or requires reconciliation'),
      );

      await expect(
        service.compensateStep(tenantId, factoryId, userId, taskId, stepId, payload),
      ).rejects.toThrow('execution claim is active or requires reconciliation');

      expect((service as any).recordAttempt).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
        1,
        'COMPENSATION',
        'STARTED',
        {},
        undefined,
        actionIntentId,
      );

      await expect(
        service.compensateStep(tenantId, factoryId, userId, taskId, stepId, payload),
      ).rejects.toThrow(
        'A previous compensation attempt is unresolved; reconcile its AI execution claim before retrying',
      );

      expect(aiRuntimeService.authorizeAction).toHaveBeenCalledTimes(1);
      expect(aiRuntimeService.executeAgentAction).toHaveBeenCalledTimes(1);
    });

    it('fails closed when a non-NONE rollback contract is incomplete', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });
      const step = stepRow({
        status: 'SUCCEEDED',
      });

      (service as any).requireTask = jest.fn<() => Promise<unknown>>().mockResolvedValue(task);
      (service as any).requireStep = jest.fn<() => Promise<unknown>>().mockResolvedValue(step);
      toolRegistry.getTool.mockResolvedValue({
        rollback: {
          type: 'COMPENSATION',
        },
      });

      await expect(
        service.compensateStep(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
          {},
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(aiRuntimeService.executeAgentAction).not.toHaveBeenCalled();
    });

    it('requires the source agent to be entitled to every permitted handoff tool', async () => {
      aiAgentCatalogueService.assertToolEntitled.mockRejectedValue(
        new ForbiddenException('AI agent tool is not entitled'),
      );

      await expect(
        service.createHandoff(
          tenantId,
          factoryId,
          userId,
          {
            sourceAgentId: 'AGENT.SENDER',
            targetAgentId: 'AGENT.RECEIVER',
            purpose: 'Check order recovery',
            allowedDataClasses: ['INTERNAL'],
            permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
            expiresAt: '2099-01-01T00:00:00.000Z',
            parentTraceId: traceId,
            expectedArtifact: { type: 'recovery-options' },
          },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(aiAgentCatalogueService.assertToolEntitled).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        'AGENT.SENDER',
        'AI.RUNTIME.NOOP',
        '1.0.0',
      );
      expect(database.query).not.toHaveBeenCalled();
    });

    it('fails closed when handoff expiry passes before the insert reaches PostgreSQL', async () => {
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        service.createHandoff(
          tenantId,
          factoryId,
          userId,
          {
            sourceAgentId: 'AGENT.SENDER',
            targetAgentId: 'AGENT.RECEIVER',
            purpose: 'Create a short-lived inspection handoff',
            allowedDataClasses: ['INTERNAL'],
            permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            parentTraceId: traceId,
            expectedArtifact: { type: 'inspection' },
          },
        ),
      ).rejects.toThrow(
        'AI agent handoff expiry elapsed before the record could be created',
      );

      const queryCalls = (database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls;
      expect(queryCalls).toHaveLength(1);
      const sql = String(queryCalls[0]?.[0] ?? '');
      expect(sql).toContain('INSERT INTO agent_handoffs');
      expect(sql).toContain('WHERE $8::timestamptz > NOW()');
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('creates a handoff only after source entitlement is verified', async () => {
      const handoff = {
        id: 'cf1a2222-2222-4222-8222-222222222222',
        tenant_id: tenantId,
        factory_id: factoryId,
        source_agent_id: 'AGENT.SENDER',
        target_agent_id: 'AGENT.RECEIVER',
        purpose: 'Check order recovery',
        allowed_data_classes: ['INTERNAL'],
        permitted_tools: ['AI.RUNTIME.NOOP@1.0.0'],
        expires_at: '2099-01-01T00:00:00.000Z',
        parent_trace_id: traceId,
        expected_artifact: { type: 'recovery-options' },
        handoff_hash: 'c'.repeat(64),
        status: 'PENDING' as const,
        accepted_by: null,
        accepted_at: null,
        created_at: '2026-10-07T00:00:00.000Z',
        updated_at: '2026-10-07T00:00:00.000Z',
      };

      database.query.mockResolvedValueOnce({ rows: [handoff] });

      const result = await service.createHandoff(
        tenantId,
        factoryId,
        userId,
        {
          sourceAgentId: 'AGENT.SENDER',
          targetAgentId: 'AGENT.RECEIVER',
          purpose: 'Check order recovery',
          allowedDataClasses: ['INTERNAL'],
          permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
          expiresAt: '2099-01-01T00:00:00.000Z',
          parentTraceId: traceId,
          expectedArtifact: { type: 'recovery-options' },
        },
      );

      expect(result.status).toBe('PENDING');
      expect(aiAgentCatalogueService.assertToolEntitled).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        'AGENT.SENDER',
        'AI.RUNTIME.NOOP',
        '1.0.0',
      );
    });

    it('rejects a pending handoff with an atomic expiry guard and audit event', async () => {
      const handoff = {
        id: 'cf1a2222-2222-4222-8222-222222222222',
        tenantId,
        factoryId,
        sourceAgentId: 'AGENT.SENDER',
        targetAgentId: 'AGENT.RECEIVER',
        purpose: 'Check order recovery',
        allowedDataClasses: ['INTERNAL'],
        permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        parentTraceId: traceId,
        expectedArtifact: { type: 'recovery-options' },
        handoffHash: 'c'.repeat(64),
        status: 'PENDING' as const,
        acceptedBy: null,
        acceptedAt: null,
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:00.000Z',
      };
      (service as any).getHandoff = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(handoff);
      database.query.mockResolvedValueOnce({
        rows: [{
          id: handoff.id,
          tenant_id: tenantId,
          factory_id: factoryId,
          source_agent_id: handoff.sourceAgentId,
          target_agent_id: handoff.targetAgentId,
          purpose: handoff.purpose,
          allowed_data_classes: handoff.allowedDataClasses,
          permitted_tools: handoff.permittedTools,
          expires_at: handoff.expiresAt,
          parent_trace_id: handoff.parentTraceId,
          expected_artifact: handoff.expectedArtifact,
          handoff_hash: handoff.handoffHash,
          status: 'REJECTED',
          accepted_by: null,
          accepted_at: null,
          created_at: handoff.createdAt,
          updated_at: handoff.updatedAt,
        }],
        rowCount: 1,
      });

      const result = await service.rejectHandoff(
        tenantId,
        factoryId,
        userId,
        handoff.id,
        'Operator chose not to proceed',
      );

      expect(result.status).toBe('REJECTED');
      expect(iamService.authorize).toHaveBeenCalledWith(
        userId,
        tenantId,
        'ai.actions.authorize',
        factoryId,
      );
      const sql = String((database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls[0]?.[0] ?? '');
      expect(sql).toContain("SET status = 'REJECTED'");
      expect(sql).toContain("AND status = 'PENDING'");
      expect(sql).toContain('AND expires_at > NOW()');
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'AI_AGENT_HANDOFF',
        action: 'REJECT',
        resourceId: handoff.id,
        correlationId: traceId,
        payload: { reason: 'Operator chose not to proceed' },
      }));
    });

    it('requires the handoff to remain unexpired in the atomic acceptance update', async () => {
      const handoff = {
        id: 'cf1a2222-2222-4222-8222-222222222222',
        tenantId,
        factoryId,
        sourceAgentId: 'AGENT.SENDER',
        targetAgentId: 'AGENT.RECEIVER',
        purpose: 'Check order recovery',
        allowedDataClasses: ['INTERNAL'],
        permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        parentTraceId: traceId,
        expectedArtifact: { type: 'recovery-options' },
        handoffHash: 'c'.repeat(64),
        status: 'PENDING' as const,
        acceptedBy: null,
        acceptedAt: null,
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:00.000Z',
      };

      (service as any).getHandoff = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(handoff);
      toolRegistry.getTool.mockResolvedValue({
        requiredScopes: ['ai.actions.execute'],
      });
      database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        service.acceptHandoff(tenantId, factoryId, userId, handoff.id),
      ).rejects.toThrow('AI agent handoff acceptance lost a concurrency race or the handoff expired');

      const queryCalls = (database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls;
      expect(queryCalls).toHaveLength(1);
      const sql = String(queryCalls[0]?.[0] ?? '');
      expect(sql).toContain("AND status = 'PENDING'");
      expect(sql).toContain('AND expires_at > NOW()');
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('expires only a still-pending handoff whose database expiry has passed', async () => {
      const handoff = {
        id: 'cf1a2222-2222-4222-8222-222222222222',
        tenantId,
        factoryId,
        sourceAgentId: 'AGENT.SENDER',
        targetAgentId: 'AGENT.RECEIVER',
        purpose: 'Check order recovery',
        allowedDataClasses: ['INTERNAL'],
        permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
        expiresAt: '2000-01-01T00:00:00.000Z',
        parentTraceId: traceId,
        expectedArtifact: { type: 'recovery-options' },
        handoffHash: 'c'.repeat(64),
        status: 'PENDING' as const,
        acceptedBy: null,
        acceptedAt: null,
        createdAt: '1999-12-31T00:00:00.000Z',
        updatedAt: '1999-12-31T00:00:00.000Z',
      };
      (service as any).getHandoff = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(handoff);

      await expect(
        service.acceptHandoff(tenantId, factoryId, userId, handoff.id),
      ).rejects.toThrow('AI agent handoff has expired');

      const queryCalls = (database.query as unknown as {
        mock: { calls: unknown[][] };
      }).mock.calls;
      expect(queryCalls).toHaveLength(1);
      const sql = String(queryCalls[0]?.[0] ?? '');
      expect(sql).toContain("SET status = 'EXPIRED'");
      expect(sql).toContain("AND status = 'PENDING'");
      expect(sql).toContain('AND expires_at <= NOW()');
      expect(aiAgentCatalogueService.assertToolEntitled).not.toHaveBeenCalled();
      expect(iamService.authorize).not.toHaveBeenCalled();
    });

    it('re-checks receiving permissions for every permitted handoff tool', async () => {
      const handoff = {
        id: 'cf1a2222-2222-4222-8222-222222222222',
        tenantId,
        factoryId,
        sourceAgentId: 'AGENT.SENDER',
        targetAgentId: 'AGENT.RECEIVER',
        purpose: 'Check order recovery',
        allowedDataClasses: ['INTERNAL'],
        permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        parentTraceId: traceId,
        expectedArtifact: {
          type: 'recovery-options',
        },
        handoffHash: 'c'.repeat(64),
        status: 'PENDING' as const,
        acceptedBy: null,
        acceptedAt: null,
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:00.000Z',
      };

      (service as any).getHandoff = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(handoff);
      toolRegistry.getTool.mockResolvedValue({
        requiredScopes: [
          'ai.actions.execute',
        ],
      });
      database.query.mockResolvedValueOnce({
        rows: [
          {
            ...handoff,
            id: handoff.id,
            status: 'ACCEPTED',
          },
        ],
      });

      const result = await service.acceptHandoff(
        tenantId,
        factoryId,
        userId,
        handoff.id,
      );

      expect(result.status).toBe('ACCEPTED');
      expect(aiAgentCatalogueService.assertToolEntitled).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        'AGENT.RECEIVER',
        'AI.RUNTIME.NOOP',
        '1.0.0',
      );
      expect(iamService.authorize).toHaveBeenLastCalledWith(
        userId,
        tenantId,
        'ai.actions.execute',
        factoryId,
      );
    });

    it('rejects handoff acceptance when the receiving agent lacks tool entitlement', async () => {
      const handoff = {
        id: 'cf1a2222-2222-4222-8222-222222222222',
        tenantId,
        factoryId,
        sourceAgentId: 'AGENT.SENDER',
        targetAgentId: 'AGENT.RECEIVER',
        purpose: 'Check order recovery',
        allowedDataClasses: ['INTERNAL'],
        permittedTools: ['AI.RUNTIME.NOOP@1.0.0'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        parentTraceId: traceId,
        expectedArtifact: { type: 'recovery-options' },
        handoffHash: 'c'.repeat(64),
        status: 'PENDING' as const,
        acceptedBy: null,
        acceptedAt: null,
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:00.000Z',
      };

      (service as any).getHandoff = jest.fn<() => Promise<unknown>>().mockResolvedValue(handoff);
      aiAgentCatalogueService.assertToolEntitled.mockRejectedValue(
        new ForbiddenException('AI agent tool is not entitled'),
      );

      await expect(
        service.acceptHandoff(tenantId, factoryId, userId, handoff.id),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(aiAgentCatalogueService.assertToolEntitled).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        'AGENT.RECEIVER',
        'AI.RUNTIME.NOOP',
        '1.0.0',
      );
      expect(iamService.authorize).toHaveBeenCalledTimes(0);
      expect(toolRegistry.getTool).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
    });

    it('rejects invalid UUID scope before database access', async () => {
      await expect(
        service.getTask(
          'not-a-tenant',
          factoryId,
          userId,
          taskId,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(database.query).not.toHaveBeenCalled();
    });
  },
);
