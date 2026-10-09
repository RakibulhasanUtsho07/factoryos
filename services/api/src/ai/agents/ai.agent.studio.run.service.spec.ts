import { jest } from '@jest/globals';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { AiAgentStudioRunService } from './ai.agent.studio.run.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const sandboxId = '7f1a2222-2222-4222-8222-222222222222';
const runId = '8f1a2222-2222-4222-8222-222222222222';
const childRunId = '9f1a2222-2222-4222-8222-222222222222';

const database = {
  query: jest.fn<() => Promise<unknown>>(),
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

function sandboxRow() {
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
    },
    input_snapshot: {},
    policy_snapshot: {},
    network_access: 'NONE',
    credentials_access: 'NONE',
    live_write_allowed: false,
    status: 'COMPLETED',
    created_by: userId,
    trace_id: null,
    created_at: '2026-10-08T00:00:00.000Z',
    updated_at: '2026-10-08T00:00:00.000Z',
  };
}

function simulationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    sandbox_id: sandboxId,
    parent_run_id: null,
    status: 'COMPLETED',
    plan: [
      {
        stepKey: 'step-1',
        toolId: 'AI.RUNTIME.NOOP',
        toolVersion: '1.0.0',
        actionType: 'AI.RUNTIME.NOOP',
        input: { value: 1 },
      },
      {
        stepKey: 'step-2',
        toolId: 'AI.RUNTIME.NOOP',
        toolVersion: '1.0.0',
        actionType: 'AI.RUNTIME.NOOP',
        input: { value: 2 },
      },
    ],
    simulated_tool_responses: {
      'AI.RUNTIME.NOOP@1.0.0': { ok: true },
    },
    observations: [
      { stepIndex: 0, stepKey: 'step-1', responseProvided: true },
      { stepIndex: 1, stepKey: 'step-2', responseProvided: true },
    ],
    result: {
      outcome: 'SIMULATION_COMPLETE',
      liveExecution: false,
      liveWriteBlocked: true,
    },
    started_at: '2026-10-08T00:00:00.000Z',
    finished_at: '2026-10-08T00:00:00.010Z',
    created_by: userId,
    trace_id: null,
    created_at: '2026-10-08T00:00:00.010Z',
    ...overrides,
  };
}

function makeService() {
  return new AiAgentStudioRunService(
    database as never,
    iamService as never,
    auditService as never,
    toolRegistry as never,
  );
}

describe('AiAgentStudioRunService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    toolRegistry.getTool.mockResolvedValue(tool());
  });

  it('returns a reviewable simulation run with expected tool calls', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [simulationRow()] });

    const result = await makeService().getRun(
      tenantId,
      factoryId,
      userId,
      sandboxId,
      runId,
    );

    expect(result.runKind).toBe('ORIGINAL');
    expect(result.planReview.totalSteps).toBe(2);
    expect(result.planReview.expectedToolCalls).toHaveLength(2);
    expect(result.planReview.expectedToolCalls[0]).toMatchObject({
      toolId: 'AI.RUNTIME.NOOP',
      riskClass: 'L0',
      sideEffect: 'NONE',
      approvalPoint: false,
      requiredScopes: ['ai.actions.execute'],
    });
  });

  it('inspects a single step without executing a tool', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [simulationRow()] });

    const result = await makeService().inspectStep(
      tenantId,
      factoryId,
      userId,
      sandboxId,
      runId,
      1,
    );

    expect(result.stepIndex).toBe(1);
    expect(result.step.stepKey).toBe('step-2');
    expect(result.observation?.stepIndex).toBe(1);
    expect(result.simulatedResponse).toEqual({ ok: true });
    expect(toolRegistry.getTool).toHaveBeenCalled();
  });

  it('rejects inspection beyond the plan', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [simulationRow()] });

    await expect(
      makeService().inspectStep(
        tenantId,
        factoryId,
        userId,
        sandboxId,
        runId,
        3,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replays an immutable child run for a selected step range', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [simulationRow()] });

    database.transaction.mockImplementation(
      async (callback) =>
        callback({
          query: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValueOnce({
              rows: [
                simulationRow({
                  id: childRunId,
                  parent_run_id: runId,
                  plan: [simulationRow().plan[1]],
                  result: {
                    outcome: 'REPLAY_COMPLETE',
                    runKind: 'REPLAY',
                  },
                }),
              ],
            }),
        } as never),
    );

    const result = await makeService().replayRun(
      tenantId,
      factoryId,
      userId,
      sandboxId,
      runId,
      1,
      1,
    );

    expect(result.runKind).toBe('REPLAY');
    expect(result.simulation.parentRunId).toBe(runId);
    expect(result.simulation.plan).toHaveLength(1);
    expect(result.simulation.result.outcome).toBe('REPLAY_COMPLETE');
  });

  it('creates a branch from an existing run with a candidate plan', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [simulationRow()] });

    database.transaction.mockImplementation(
      async (callback) =>
        callback({
          query: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValueOnce({
              rows: [
                simulationRow({
                  id: childRunId,
                  parent_run_id: runId,
                  plan: [
                    {
                      stepKey: 'branch-1',
                      toolId: 'AI.RUNTIME.NOOP',
                      toolVersion: '1.0.0',
                      actionType: 'AI.RUNTIME.NOOP',
                      input: { branch: true },
                    },
                  ],
                  result: {
                    outcome: 'BRANCH_COMPLETE',
                    runKind: 'BRANCH',
                  },
                }),
              ],
            }),
        } as never),
    );

    const result = await makeService().branchRun(
      tenantId,
      factoryId,
      userId,
      sandboxId,
      runId,
      0,
      [
        {
          stepKey: 'branch-1',
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
          input: { branch: true },
        },
      ],
      { 'AI.RUNTIME.NOOP@1.0.0': { ok: true } },
    );

    expect(result.runKind).toBe('BRANCH');
    expect(result.simulation.parentRunId).toBe(runId);
    expect(result.planReview.expectedToolCalls[0].stepKey).toBe('branch-1');
  });

  it('fails closed when a branch uses an undeclared tool', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [simulationRow()] });

    await expect(
      makeService().branchRun(
        tenantId,
        factoryId,
        userId,
        sandboxId,
        runId,
        0,
        [
          {
            stepKey: 'branch-1',
            toolId: 'AI.RUNTIME.UNDECLARED',
            toolVersion: '1.0.0',
            actionType: 'AI.RUNTIME.UNDECLARED',
            input: {},
          },
        ],
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when a branch uses a write-capable tool', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [simulationRow()] });
    toolRegistry.getTool.mockResolvedValue(
      tool({ writeCapable: true, riskClass: 'L1' }),
    );

    await expect(
      makeService().branchRun(
        tenantId,
        factoryId,
        userId,
        sandboxId,
        runId,
        0,
        [
          {
            stepKey: 'branch-1',
            toolId: 'AI.RUNTIME.NOOP',
            toolVersion: '1.0.0',
            actionType: 'AI.RUNTIME.NOOP',
            input: {},
          },
        ],
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('compares two candidate plans and reports changed steps', async () => {
    const left = simulationRow();
    const right = simulationRow({
      id: childRunId,
      plan: [
        left.plan[0],
        {
          stepKey: 'branch-2',
          toolId: 'AI.RUNTIME.NOOP',
          toolVersion: '1.0.0',
          actionType: 'AI.RUNTIME.NOOP',
          input: { value: 99 },
        },
      ],
    });

    database.query
      .mockResolvedValueOnce({ rows: [left] })
      .mockResolvedValueOnce({ rows: [right] });

    const result = await makeService().compareRuns(
      tenantId,
      factoryId,
      userId,
      sandboxId,
      runId,
      childRunId,
    );

    expect(result.samePlan).toBe(false);
    expect(result.changedStepCount).toBe(1);
    expect(result.differences[0]).toMatchObject({
      index: 1,
      change: 'CHANGED',
    });
  });

  it('rejects comparing a run outside the sandbox scope', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      makeService().compareRuns(
        tenantId,
        factoryId,
        userId,
        sandboxId,
        runId,
        childRunId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a non-UUID actor before IAM', async () => {
    await expect(
      makeService().getRun(
        tenantId,
        factoryId,
        'not-a-user',
        sandboxId,
        runId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(iamService.authorize).not.toHaveBeenCalled();
  });
});
