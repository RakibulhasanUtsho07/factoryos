import {
  jest,
} from '@jest/globals';

import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

import {
  AiAgentStudioService,
} from './ai.agent.studio.service';

const tenantId =
  'faaab63d-c447-46ce-950d-deebdd7f5f30';

const factoryId =
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

const userId =
  '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

const traceId =
  '6f1a2222-2222-4222-8222-222222222222';

const sandboxId =
  '7f1a2222-2222-4222-8222-222222222222';

const simulationId =
  '8f1a2222-2222-4222-8222-222222222222';

const database = {
  transaction: jest.fn<() => Promise<unknown>>(),
};

const iamService = {
  authorize: jest.fn<() => Promise<void>>(),
};

const auditService = {
  record: jest.fn<() => Promise<string>>(),
};

const toolRegistry = {
  getTool: jest.fn<() => Promise<unknown>>(),
};

function tool(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool-row',
    tenantId: null,
    factoryId: null,
    toolId: 'AI.RUNTIME.NOOP',
    version: '1.0.0',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    riskClass: 'L0',
    requiredScopes: ['ai.actions.execute'],
    approvalMode: 'none',
    writeCapable: false,
    idempotencyRequired: false,
    timeoutMs: 1000,
    auditMode: 'REDACTED',
    rollback: { type: 'NONE' },
    status: 'ACTIVE',
    metadata: {},
    createdBy: null,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

function sandboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: sandboxId,
    tenant_id: tenantId,
    factory_id: factoryId,
    name: 'Sandbox test',
    mode: 'SIMULATION',
    agent_spec: {
      agentId: 'AGENT.TEST',
      version: '1.0.0',
      goal: 'Test',
      riskCeiling: 'L0',
      executionScopes: ['ai.actions.execute'],
      tools: [
        {
          toolId: 'AI.RUNTIME.NOOP',
          version: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
        },
      ],
      memory: {},
      policies: {},
      prompts: {},
      completionCriteria: {},
    },
    input_snapshot: {},
    policy_snapshot: {},
    network_access: 'NONE',
    credentials_access: 'NONE',
    live_write_allowed: false,
    status: 'COMPLETED',
    created_by: userId,
    trace_id: traceId,
    created_at: '2026-10-08T00:00:00.000Z',
    updated_at: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

function simulationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: simulationId,
    sandbox_id: sandboxId,
    parent_run_id: null,
    status: 'COMPLETED',
    plan: [
      {
        stepKey: 'step-1',
        toolId: 'AI.RUNTIME.NOOP',
        toolVersion: '1.0.0',
        actionType: 'AI.RUNTIME.NOOP',
        input: {},
      },
    ],
    simulated_tool_responses: {
      'AI.RUNTIME.NOOP@1.0.0': {
        execution: 'NO_SIDE_EFFECT',
      },
    },
    observations: [
      {
        stepIndex: 0,
        stepKey: 'step-1',
        toolId: 'AI.RUNTIME.NOOP',
        toolVersion: '1.0.0',
        actionType: 'AI.RUNTIME.NOOP',
        simulated: true,
        liveExecution: false,
        responseProvided: true,
      },
    ],
    result: {
      outcome: 'SIMULATION_COMPLETE',
      liveExecution: false,
      liveWriteBlocked: true,
      networkAccess: 'NONE',
      credentialsAccess: 'NONE',
    },
    started_at: '2026-10-08T00:00:00.000Z',
    finished_at: '2026-10-08T00:00:00.010Z',
    created_by: userId,
    trace_id: traceId,
    created_at: '2026-10-08T00:00:00.010Z',
    ...overrides,
  };
}

function makeService() {
  return new AiAgentStudioService(
    database as never,
    iamService as never,
    auditService as never,
    toolRegistry as never,
  );
}

describe('AiAgentStudioService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');

    toolRegistry.getTool.mockResolvedValue(
      tool(),
    );

    database.transaction.mockImplementation(
      async (callback) =>
        callback({
          query: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValueOnce({
              rows: [sandboxRow()],
            })
            .mockResolvedValueOnce({
              rows: [simulationRow()],
            }),
        } as never),
    );
  });

  it('creates a simulation-only sandbox with live writes disabled', async () => {
    const service = makeService();

    const result =
      await service.createSandbox(
        tenantId,
        factoryId,
        userId,
        {
          name: 'Sandbox test',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'Test the noop plan',
            riskCeiling: 'L0',
            executionScopes: [
              'ai.actions.execute',
            ],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.NOOP',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.NOOP',
              input: {},
            },
          ],
          simulatedToolResponses: {
            'AI.RUNTIME.NOOP@1.0.0': {
              execution: 'NO_SIDE_EFFECT',
            },
          },
        },
      );

    expect(result.sandbox.status).toBe(
      'COMPLETED',
    );

    expect(
      result.sandbox.liveWriteAllowed,
    ).toBe(false);

    expect(
      result.sandbox.networkAccess,
    ).toBe('NONE');

    expect(
      result.sandbox.credentialsAccess,
    ).toBe('NONE');

    expect(
      result.simulation.result.liveExecution,
    ).toBe(false);

    expect(
      result.simulation.result.liveWriteBlocked,
    ).toBe(true);

    expect(
      toolRegistry.getTool,
    ).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      'AI.RUNTIME.NOOP',
      '1.0.0',
    );
  });

  it('blocks a write-capable tool from sandbox execution', async () => {
    const service = makeService();

    toolRegistry.getTool.mockResolvedValue(
      tool({
        writeCapable: true,
        riskClass: 'L2',
      }),
    );

    await expect(
      service.createSandbox(
        tenantId,
        factoryId,
        userId,
        {
          name: 'Unsafe sandbox',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'Should be blocked',
            riskCeiling: 'L2',
            executionScopes: [
              'ai.actions.execute',
            ],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.NOOP',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.NOOP',
              input: {},
            },
          ],
          simulatedToolResponses: {
            'AI.RUNTIME.NOOP@1.0.0': {},
          },
        },
      ),
    ).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(
      database.transaction,
    ).not.toHaveBeenCalled();
  });

  it('blocks a tool whose risk exceeds the agent ceiling', async () => {
    const service = makeService();

    toolRegistry.getTool.mockResolvedValue(
      tool({
        riskClass: 'L2',
      }),
    );

    await expect(
      service.createSandbox(
        tenantId,
        factoryId,
        userId,
        {
          name: 'Risk sandbox',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'Should be blocked',
            riskCeiling: 'L0',
            executionScopes: [
              'ai.actions.execute',
            ],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.NOOP',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.NOOP',
              input: {},
            },
          ],
          simulatedToolResponses: {
            'AI.RUNTIME.NOOP@1.0.0': {},
          },
        },
      ),
    ).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('blocks missing execution scopes before persistence', async () => {
    const service = makeService();

    toolRegistry.getTool.mockResolvedValue(
      tool(),
    );

    await expect(
      service.createSandbox(
        tenantId,
        factoryId,
        userId,
        {
          name: 'Scope sandbox',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'Should be blocked',
            riskCeiling: 'L0',
            executionScopes: [],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.NOOP',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.NOOP',
              input: {},
            },
          ],
          simulatedToolResponses: {
            'AI.RUNTIME.NOOP@1.0.0': {},
          },
        },
      ),
    ).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(
      database.transaction,
    ).not.toHaveBeenCalled();
  });

  it('blocks a plan tool that is not declared in the agent spec', async () => {
    const service = makeService();

    await expect(
      service.createSandbox(
        tenantId,
        factoryId,
        userId,
        {
          name: 'Plan mismatch',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'Should be blocked',
            riskCeiling: 'L0',
            executionScopes: [
              'ai.actions.execute',
            ],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.AUDIT',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.AUDIT',
              input: {},
            },
          ],
          simulatedToolResponses: {
            'AI.RUNTIME.AUDIT@1.0.0': {},
          },
        },
      ),
    ).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(
      database.transaction,
    ).not.toHaveBeenCalled();
  });

  it('does not execute the Tool Gateway during sandbox simulation', async () => {
    const service = makeService();

    const result =
      await service.createSandbox(
        tenantId,
        factoryId,
        userId,
        {
          name: 'No gateway sandbox',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'No live execution',
            riskCeiling: 'L0',
            executionScopes: [
              'ai.actions.execute',
            ],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.NOOP',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.NOOP',
              input: {},
            },
          ],
          simulatedToolResponses: {
            'AI.RUNTIME.NOOP@1.0.0': {},
          },
        },
      );

    expect(result.simulation.status).toBe(
      'COMPLETED',
    );
  });

  it('blocks a missing simulated response without touching production execution', async () => {
    const service = makeService();

    database.transaction.mockImplementation(
      async (callback) =>
        callback({
          query: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValueOnce({
              rows: [sandboxRow()],
            })
            .mockResolvedValueOnce({
              rows: [
                simulationRow({
                  status: 'BLOCKED',
                  result: {
                    outcome: 'SIMULATION_INCOMPLETE',
                    missingSimulatedResponses: [
                      'AI.RUNTIME.NOOP@1.0.0',
                    ],
                    liveExecution: false,
                    liveWriteBlocked: true,
                    networkAccess: 'NONE',
                    credentialsAccess: 'NONE',
                  },
                }),
              ],
            }),
        } as never),
    );

    const result =
      await service.createSandbox(
        tenantId,
        factoryId,
        userId,
        {
          name: 'Incomplete sandbox',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'Need simulated result',
            riskCeiling: 'L0',
            executionScopes: [
              'ai.actions.execute',
            ],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.NOOP',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.NOOP',
              input: {},
            },
          ],
          simulatedToolResponses: {},
        },
      );

    expect(result.simulation.status).toBe(
      'BLOCKED',
    );
    expect(
      result.simulation.result.liveWriteBlocked,
    ).toBe(true);
  });

  it('rejects an invalid tenant before IAM or DB access', async () => {
    const service = makeService();

    await expect(
      service.createSandbox(
        'not-a-tenant',
        factoryId,
        userId,
        {
          name: 'Invalid',
          traceId,
          agentSpec: {
            agentId: 'AGENT.TEST',
            version: '1.0.0',
            goal: 'Invalid',
            riskCeiling: 'L0',
            executionScopes: [],
            tools: [
              {
                toolId: 'AI.RUNTIME.NOOP',
                version: '1.0.0',
                actionType: 'AI.RUNTIME.NOOP',
              },
            ],
          },
          plan: [
            {
              stepKey: 'step-1',
              toolId: 'AI.RUNTIME.NOOP',
              toolVersion: '1.0.0',
              actionType: 'AI.RUNTIME.NOOP',
              input: {},
            },
          ],
          simulatedToolResponses: {},
        },
      ),
    ).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(
      iamService.authorize,
    ).not.toHaveBeenCalled();

    expect(
      database.transaction,
    ).not.toHaveBeenCalled();
  });
});
