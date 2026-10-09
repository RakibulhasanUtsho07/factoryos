import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';

import { AiAgentStudioRunController } from './ai.agent.studio.run.controller';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const sandboxId = '7f1a2222-2222-4222-8222-222222222222';
const runId = '8f1a2222-2222-4222-8222-222222222222';
const traceId = '6f1a2222-2222-4222-8222-222222222222';

function request() {
  return {
    factoryos: {
      traceId,
      userId,
      tenantId,
      factoryId,
    },
  } as never;
}

describe('AiAgentStudioRunController', () => {
  const runService = {
    getRun: jest.fn<() => Promise<unknown>>(),
    inspectStep: jest.fn<() => Promise<unknown>>(),
    replayRun: jest.fn<() => Promise<unknown>>(),
    branchRun: jest.fn<() => Promise<unknown>>(),
    compareRuns: jest.fn<() => Promise<unknown>>(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    runService.getRun.mockResolvedValue({ ok: true });
    runService.inspectStep.mockResolvedValue({ ok: true });
    runService.replayRun.mockResolvedValue({ ok: true });
    runService.branchRun.mockResolvedValue({ ok: true });
    runService.compareRuns.mockResolvedValue({ ok: true });
  });

  it('maps authenticated context for replay', async () => {
    const controller = new AiAgentStudioRunController(runService as never);

    await controller.replay(
      request(),
      sandboxId,
      {
        source_run_id: runId,
        from_step_index: 1,
        to_step_index: 2,
      } as never,
    );

    expect(runService.replayRun).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      userId,
      sandboxId,
      runId,
      1,
      2,
    );
  });

  it('maps an API branch plan into runtime types', async () => {
    const controller = new AiAgentStudioRunController(runService as never);

    await controller.branch(
      request(),
      sandboxId,
      {
        source_run_id: runId,
        branch_from_step_index: 0,
        plan: [
          {
            step_key: 'branch-1',
            tool_id: 'AI.RUNTIME.NOOP',
            tool_version: '1.0.0',
            action_type: 'AI.RUNTIME.NOOP',
            input: { branch: true },
          },
        ],
        simulated_tool_responses: {
          'AI.RUNTIME.NOOP@1.0.0': { ok: true },
        },
      } as never,
    );

    expect(runService.branchRun).toHaveBeenCalledWith(
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
      {
        'AI.RUNTIME.NOOP@1.0.0': { ok: true },
      },
    );
  });

  it('fails closed when authenticated context is missing', async () => {
    const controller = new AiAgentStudioRunController(runService as never);

    await expect(
      controller.getRun(
        { factoryos: { traceId } } as never,
        sandboxId,
        runId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(runService.getRun).not.toHaveBeenCalled();
  });

  it('maps compare request to runtime service', async () => {
    const controller = new AiAgentStudioRunController(runService as never);

    await controller.compare(
      request(),
      sandboxId,
      {
        left_run_id: runId,
        right_run_id: '9f1a2222-2222-4222-8222-222222222222',
      } as never,
    );

    expect(runService.compareRuns).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      userId,
      sandboxId,
      runId,
      '9f1a2222-2222-4222-8222-222222222222',
    );
  });
});
