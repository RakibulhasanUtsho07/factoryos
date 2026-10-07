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
    authorization_attempt: 0,
    action_intent_id: null,
    approval_id: null,
    execution_record_id: null,
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
  return {
    id: actionIntentId,
    tenantId,
    factoryId,
    decisionId,
    actionType: 'AI.RUNTIME.NOOP',
    target: {},
    resourceType: null,
    resourceId: null,
    payload: {
      sample: 'value',
    },
    payloadHash: 'b'.repeat(64),
    riskClass: 'L0',
    authorizationStatus: 'AUTHORIZED',
    approvalId: null,
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    idempotencyKey: 'agent-auth-1',
    ...overrides,
  };
}

function gatewayOutcome() {
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
    inputsHash: 'b'.repeat(64),
  };
}

describe(
  'AiAgentRuntimeService',
  () => {
    let service: AiAgentRuntimeService;

    const database = {
      query: jest.fn(),
      transaction: jest.fn(),
    };

    const auditService = {
      record: jest.fn<() => Promise<string>>(),
    };

    const iamService = {
      authorize: jest.fn<() => Promise<void>>(),
    };

    const aiRuntimeService = {
      authorizeAction: jest.fn(),
    };

    const aiAgentCatalogueService = {
      assertToolEntitled: jest.fn(),
    };

    const toolGateway = {
      execute: jest.fn(),
    };

    const toolRegistry = {
      getTool: jest.fn(),
    };

    beforeEach(() => {
      jest.clearAllMocks();

      iamService.authorize.mockResolvedValue(undefined);
      auditService.record.mockResolvedValue('audit-id');
      aiAgentCatalogueService.assertToolEntitled.mockResolvedValue({});

      service = new AiAgentRuntimeService(
        database as never,
        auditService as never,
        iamService as never,
        aiRuntimeService as never,
        aiAgentCatalogueService as never,
        toolGateway as never,
        toolRegistry as never,
      );
    });

    it('accepts the canonical CREATED -> CONTEXT_READY transition', async () => {
      const oldTask = taskRow({
        state: 'CREATED',
      });
      const newTask = taskRow({
        state: 'CONTEXT_READY',
        version: 2,
      });

      (service as any).requireTask = jest.fn().mockResolvedValue(oldTask);
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

      (service as any).requireTask = jest.fn().mockResolvedValue(task);
      (service as any).requireStep = jest.fn().mockResolvedValue(step);

      const result = await service.executeStep(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
      );

      expect(result.idempotent).toBe(true);
      expect(toolGateway.execute).not.toHaveBeenCalled();
    });

    it('stops a cancelled task before Tool Gateway execution', async () => {
      const task = taskRow({
        state: 'CANCELLED',
        cancel_requested_at: '2026-10-07T00:01:00.000Z',
      });
      const step = stepRow();

      (service as any).requireTask = jest.fn().mockResolvedValue(task);
      (service as any).requireStep = jest.fn().mockResolvedValue(step);

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
      expect(toolGateway.execute).not.toHaveBeenCalled();
    });

    it('stops when the maximum tool-call budget is exhausted', async () => {
      const task = taskRow({
        state: 'EXECUTING',
        tool_call_count: 20,
        max_tool_calls: 20,
      });
      const step = stepRow();

      (service as any).requireTask = jest.fn().mockResolvedValue(task);
      (service as any).requireStep = jest.fn().mockResolvedValue(step);

      await expect(
        service.executeStep(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(toolGateway.execute).not.toHaveBeenCalled();
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
        .fn()
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(task);
      (service as any).requireStep = jest
        .fn()
        .mockResolvedValueOnce(step);
      (service as any).updateTaskStateRaw = jest
        .fn()
        .mockResolvedValue(waitingTask);
      (service as any).updateStep = jest
        .fn()
        .mockResolvedValue(waitingStep);

      database.query.mockResolvedValueOnce({
        rows: [],
      });

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
      expect(toolGateway.execute).not.toHaveBeenCalled();
    });

    it('re-checks the approval on resume and then executes through Tool Gateway', async () => {
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
        .fn()
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(task);
      (service as any).requireStep = jest
        .fn()
        .mockResolvedValueOnce(step);
      (service as any).assertDependencies = jest.fn();
      (service as any).transitionState = jest
        .fn()
        .mockResolvedValue(executingTask);
      (service as any).claimToolCall = jest.fn();
      (service as any).updateStep = jest
        .fn()
        .mockResolvedValueOnce(runningStep)
        .mockResolvedValueOnce(succeededStep);
      (service as any).countCompletedSteps = jest.fn().mockResolvedValue(1);
      (service as any).countSteps = jest.fn().mockResolvedValue(1);
      (service as any).updateTaskStateRaw = jest
        .fn()
        .mockResolvedValue(verifyingTask);
      (service as any).recordAttempt = jest.fn();
      (service as any).persistExecutionRecord = jest
        .fn()
        .mockResolvedValue('bf1a2222-2222-4222-8222-222222222222');

      database.query.mockResolvedValueOnce({
        rows: [],
      });

      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action({
          authorizationStatus: 'AUTHORIZED',
          approvalId,
        }),
        actionToken: 'short-lived-token',
      });
      toolGateway.execute.mockResolvedValue(
        gatewayOutcome(),
      );

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
      expect(toolGateway.execute).toHaveBeenCalledTimes(1);
      expect(result.step.status).toBe('SUCCEEDED');
    });

    it('fails closed when the agent tool entitlement is denied', async () => {
      const task = taskRow({ state: 'EXECUTING' });
      const step = stepRow();

      (service as any).requireTask = jest.fn().mockResolvedValue(task);
      (service as any).requireStep = jest.fn().mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn();

      aiAgentCatalogueService.assertToolEntitled.mockRejectedValue(
        new ForbiddenException('AI agent tool is not entitled'),
      );

      await expect(
        service.executeStep(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(
        aiAgentCatalogueService.assertToolEntitled,
      ).toHaveBeenCalledWith(
        tenantId,
        factoryId,
        'AGENT.TEST',
        'AI.RUNTIME.NOOP',
        '1.0.0',
      );
      expect(aiRuntimeService.authorizeAction).not.toHaveBeenCalled();
      expect(toolGateway.execute).not.toHaveBeenCalled();
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
        version: 2,
      });

      (service as any).requireTask = jest
        .fn()
        .mockResolvedValue(task);
      (service as any).requireStep = jest
        .fn()
        .mockResolvedValue(step);
      (service as any).assertDependencies =
        jest.fn();
      (service as any).claimToolCall =
        jest.fn();
      (service as any).updateStep = jest
        .fn()
        .mockResolvedValueOnce(runningStep)
        .mockResolvedValueOnce(succeededStep);
      (service as any).recordAttempt =
        jest.fn();
      (service as any).persistExecutionRecord =
        jest
          .fn()
          .mockResolvedValue(
            'bf1a2222-2222-4222-8222-222222222222',
          );
      (service as any).countCompletedSteps =
        jest
          .fn()
          .mockResolvedValue(1);
      (service as any).countSteps =
        jest
          .fn()
          .mockResolvedValue(1);
      (service as any).updateTaskStateRaw =
        jest
          .fn()
          .mockResolvedValue(verifyingTask);

      database.query.mockResolvedValueOnce({
        rows: [],
      });

      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action(),
        actionToken: 'token',
      });
      toolGateway.execute.mockResolvedValue(
        gatewayOutcome(),
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
        toolGateway.execute,
      ).toHaveBeenCalledTimes(1);
      expect(result.step.status).toBe(
        'SUCCEEDED',
      );
    });

    it('keeps gateway execution fail-closed when the gateway rejects', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });
      const step = stepRow();

      (service as any).requireTask = jest
        .fn()
        .mockResolvedValue(task);
      (service as any).requireStep = jest
        .fn()
        .mockResolvedValue(step);
      (service as any).assertDependencies = jest.fn();
      (service as any).claimToolCall = jest.fn();
      (service as any).updateStep = jest
        .fn()
        .mockResolvedValue(
          stepRow({
            status: 'RUNNING',
            action_intent_id: actionIntentId,
          }),
        );
      (service as any).recordAttempt = jest.fn();
      (service as any).applyFailure = jest.fn().mockResolvedValue({
        idempotent: false,
        task: {
          ...task,
          state: 'FAILED',
        },
        step: {
          ...step,
          status: 'FAILED',
        },
        error: {
          code: 'AI_TOOL_GATEWAY_FAILURE',
        },
      });

      database.query.mockResolvedValueOnce({
        rows: [],
      });

      aiRuntimeService.authorizeAction.mockResolvedValue({
        action: action(),
        actionToken: 'token',
      });
      toolGateway.execute.mockRejectedValue(
        new ConflictException('gateway failure'),
      );

      const result = await service.executeStep(
        tenantId,
        factoryId,
        userId,
        taskId,
        stepId,
      );

      expect(result.error?.code).toBe(
        'AI_TOOL_GATEWAY_FAILURE',
      );
      expect(toolGateway.execute).toHaveBeenCalledTimes(1);
    });

    it('does not execute compensation when the registered tool declares NONE rollback', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });
      const step = stepRow({
        status: 'SUCCEEDED',
      });

      (service as any).requireTask =
        jest.fn().mockResolvedValue(task);
      (service as any).requireStep =
        jest.fn().mockResolvedValue(step);

      toolRegistry.getTool.mockResolvedValue({
        rollback: {
          type: 'NONE',
        },
      });

      const result =
        await service.compensateStep(
          tenantId,
          factoryId,
          userId,
          taskId,
          stepId,
          {},
        );

      expect(result.attempted).toBe(false);
      expect(
        aiRuntimeService.authorizeAction,
      ).not.toHaveBeenCalled();
      expect(
        toolGateway.execute,
      ).not.toHaveBeenCalled();
    });

    it('fails closed when a non-NONE rollback contract is incomplete', async () => {
      const task = taskRow({
        state: 'EXECUTING',
      });
      const step = stepRow({
        status: 'SUCCEEDED',
      });

      (service as any).requireTask =
        jest.fn().mockResolvedValue(task);
      (service as any).requireStep =
        jest.fn().mockResolvedValue(step);

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
      ).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(
        aiRuntimeService.authorizeAction,
      ).not.toHaveBeenCalled();
      expect(
        toolGateway.execute,
      ).not.toHaveBeenCalled();
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
        .fn()
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

      const result =
        await service.acceptHandoff(
          tenantId,
          factoryId,
          userId,
          handoff.id,
        );

      expect(result.status).toBe(
        'ACCEPTED',
      );

      expect(
        iamService.authorize,
      ).toHaveBeenLastCalledWith(
        userId,
        tenantId,
        'ai.actions.execute',
        factoryId,
      );
    });

    it('rejects invalid UUID scope before database access', async () => {
      await expect(
        service.getTask(
          'not-a-tenant',
          factoryId,
          userId,
          taskId,
        ),
      ).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(
        database.query,
      ).not.toHaveBeenCalled();
    });
  },
);