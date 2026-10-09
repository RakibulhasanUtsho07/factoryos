import {
  jest,
} from '@jest/globals';

import {
  UnauthorizedException,
} from '@nestjs/common';

import {
  AiAgentStudioController,
} from './ai.agent.studio.controller';

const tenantId =
  'faaab63d-c447-46ce-950d-deebdd7f5f30';

const factoryId =
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

const userId =
  '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

const traceId =
  '6f1a2222-2222-4222-8222-222222222222';

function request() {
  return {
    factoryos: {
      requestId: 'request-1',
      traceId,
      requestedUserId: userId,
      requestedTenantId: tenantId,
      requestedFactoryId: factoryId,
      userId,
      tenantId,
      factoryId,
    },
  } as never;
}

const sandboxBody = {
  name: 'Sandbox test',
  agent_spec: {
    agent_id: 'AGENT.TEST',
    version: '1.0.0',
    goal: 'Test governed simulation',
    risk_ceiling: 'L0',
    execution_scopes: ['ai.actions.execute'],
    tools: [
      {
        tool_id: 'AI.RUNTIME.NOOP',
        version: '1.0.0',
        action_type: 'AI.RUNTIME.NOOP',
      },
    ],
    memory: {},
    policies: {},
    prompts: {},
    completion_criteria: {},
  },
  input_snapshot: {},
  policy_snapshot: {},
  plan: [
    {
      step_key: 'step-1',
      tool_id: 'AI.RUNTIME.NOOP',
      tool_version: '1.0.0',
      action_type: 'AI.RUNTIME.NOOP',
      input: {},
    },
  ],
  simulated_tool_responses: {
    'AI.RUNTIME.NOOP@1.0.0': {
      execution: 'NO_SIDE_EFFECT',
    },
  },
};

describe('AiAgentStudioController', () => {
  const studioService = {
    createSandbox: jest.fn<() => Promise<unknown>>(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    studioService.createSandbox.mockResolvedValue({
      sandbox: { status: 'COMPLETED' },
      simulation: { status: 'COMPLETED' },
    });
  });

  it('maps the authenticated factory context and creates a sandbox', async () => {
    const controller = new AiAgentStudioController(
      studioService as never,
    );

    const result =
      await controller.createSandbox(
        request(),
        sandboxBody as never,
      );

    expect(result).toEqual({
      sandbox: { status: 'COMPLETED' },
      simulation: { status: 'COMPLETED' },
    });

    expect(
      studioService.createSandbox,
    ).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      userId,
      expect.objectContaining({
        name: 'Sandbox test',
        traceId,
        agentSpec: expect.objectContaining({
          agentId: 'AGENT.TEST',
          riskCeiling: 'L0',
        }),
      }),
    );
  });

  it('fails closed when authenticated factory context is missing', async () => {
    const controller = new AiAgentStudioController(
      studioService as never,
    );

    await expect(
      controller.createSandbox(
        {
          factoryos: {
            traceId,
          },
        } as never,
        sandboxBody as never,
      ),
    ).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(
      studioService.createSandbox,
    ).not.toHaveBeenCalled();
  });
});
