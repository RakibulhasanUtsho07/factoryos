import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';

import { AiAgentController } from './ai.agent.controller';

describe('AiAgentController', () => {
  const createTaskMock = jest.fn();
  const getTaskMock = jest.fn();
  const cancelTaskMock = jest.fn();
  const createHandoffMock = jest.fn();

  const runtime = {
    createTask: createTaskMock,
    getTask: getTaskMock,
    cancelTask: cancelTaskMock,
    createHandoff: createHandoffMock,
  };

  const controller = new AiAgentController(runtime as never);

  const request = {
    factoryos: {
      requestId: '11111111-1111-4111-8111-111111111111',
      traceId: '22222222-2222-4222-8222-222222222222',
      requestedUserId: null,
      requestedTenantId: null,
      requestedFactoryId: null,
      userId: '33333333-3333-4333-8333-333333333333',
      tenantId: '44444444-4444-4444-8444-444444444444',
      factoryId: '55555555-5555-4555-8555-555555555555',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    createTaskMock.mockResolvedValue({ idempotent: false });
    getTaskMock.mockResolvedValue({ task: { id: 'task-1' }, steps: [] });
    cancelTaskMock.mockResolvedValue({ id: 'task-1', state: 'CANCELLED' });
    createHandoffMock.mockResolvedValue({ id: 'handoff-1' });
  });

  it('creates a task using authenticated trace context and mapped DTO fields', async () => {
    await controller.createTask(request as never, {
      decision_id: '66666666-6666-4666-8666-666666666666',
      goal: 'Explain order delay',
      limits: {
        max_steps: 10,
        max_retries: 2,
        max_tool_calls: 10,
        timeout_ms: 30_000,
      },
      steps: [
        {
          step_key: 'inspect',
          capability: 'inspection',
          tool_id: 'AI.RUNTIME.NOOP',
          tool_version: '1',
          action_type: 'AI.RUNTIME.NOOP',
          payload: { check: true },
        },
      ],
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      expect.objectContaining({
        decisionId: '66666666-6666-4666-8666-666666666666',
        parentTraceId: request.factoryos.traceId,
        goal: 'Explain order delay',
        limits: {
          maxSteps: 10,
          maxRetries: 2,
          maxToolCalls: 10,
          timeoutMs: 30_000,
        },
        steps: [
          expect.objectContaining({
            stepKey: 'inspect',
            toolId: 'AI.RUNTIME.NOOP',
            actionType: 'AI.RUNTIME.NOOP',
          }),
        ],
      }),
    );
  });

  it('gets a task in the authenticated factory scope', async () => {
    await controller.getTask(request as never, '77777777-7777-4777-8777-777777777777');

    expect(getTaskMock).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      '77777777-7777-4777-8777-777777777777',
    );
  });

  it('cancels a task in the authenticated factory scope', async () => {
    await controller.cancelTask(request as never, '88888888-8888-4888-8888-888888888888');

    expect(cancelTaskMock).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      '88888888-8888-4888-8888-888888888888',
    );
  });

  it('uses the route source agent id and prevents body-level source spoofing', async () => {
    await controller.createHandoff(
      request as never,
      'source-agent-1',
      {
        target_agent_id: 'target-agent-1',
        purpose: 'Send verified inspection context',
        allowed_data_classes: ['INTERNAL'],
        permitted_tools: ['AI.RUNTIME.NOOP@1'],
      },
    );

    expect(createHandoffMock).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      expect.objectContaining({
        sourceAgentId: 'source-agent-1',
        targetAgentId: 'target-agent-1',
        parentTraceId: request.factoryos.traceId,
      }),
    );
  });

  it('rejects requests without authenticated factory context', async () => {
    const invalidRequest = { factoryos: undefined };

    await expect(
      controller.getTask(
        invalidRequest as never,
        '77777777-7777-4777-8777-777777777777',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
