import { jest } from '@jest/globals';

import {
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import { AiAgentStudioPromotionService } from './ai.agent.studio.promotion.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const traceId = '6f1a2222-2222-4222-8222-222222222222';
const agentDefinitionId = '7f1a2222-2222-4222-8222-222222222222';
const sandboxId = '8f1a2222-2222-4222-8222-222222222222';
const simulationRunId = '9f1a2222-2222-4222-8222-222222222222';
const policySimulationRunId = 'af1a2222-2222-4222-8222-222222222222';
const requestId = 'bf1a2222-2222-4222-8222-222222222222';
const deploymentId = 'cf1a2222-2222-4222-8222-222222222222';

const database = {
  query: jest.fn<(...args: never[]) => Promise<any>>(),
  transaction: jest.fn<(...args: never[]) => Promise<any>>(),
};

const iamService = {
  authorize: jest.fn<(...args: never[]) => Promise<void>>(),
};

const catalogueService = {
  getAgentDefinition: jest.fn<(...args: never[]) => Promise<any>>(),
};

const auditService = {
  record: jest.fn<(...args: never[]) => Promise<string>>(),
};

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentDefinitionId,
    tenantId,
    factoryId,
    agentId: 'AGENT.TEST',
    version: '1.0.0',
    name: 'Test agent',
    description: null,
    capability: 'Testing',
    typicalOutput: 'Simulation result',
    authority: 'No autonomous write',
    riskCeiling: 'L0',
    executionScopes: ['ai.actions.execute'],
    status: 'DRAFT',
    maxSteps: 20,
    maxRetries: 3,
    maxToolCalls: 20,
    timeoutMs: 60000,
    config: {},
    createdBy: userId,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: sandboxId,
    tenant_id: tenantId,
    factory_id: factoryId,
    mode: 'SIMULATION',
    live_write_allowed: false,
    status: 'COMPLETED',
    agent_spec: {
      agentId: 'AGENT.TEST',
      version: '1.0.0',
    },
    ...overrides,
  };
}

function makeSimulation(overrides: Record<string, unknown> = {}) {
  return {
    id: simulationRunId,
    sandbox_id: sandboxId,
    status: 'COMPLETED',
    result: {
      kind: 'SANDBOX_SIMULATION',
      liveExecution: false,
      ...overrides,
    },
  };
}

function makePolicySimulation(overrides: Record<string, unknown> = {}) {
  return {
    id: policySimulationRunId,
    sandbox_id: sandboxId,
    status: 'COMPLETED',
    result: {
      kind: 'POLICY_SIMULATION',
      recommendation: 'READY_FOR_REVIEW',
      allCasesNonDenied: true,
      ...overrides,
    },
  };
}

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    request_id: requestId,
    version: '1',
    tenant_id: tenantId,
    factory_id: factoryId,
    agent_definition_id: agentDefinitionId,
    agent_key: 'AGENT.TEST',
    sandbox_id: sandboxId,
    simulation_run_id: simulationRunId,
    policy_simulation_run_id: policySimulationRunId,
    target_stage: 'CANARY',
    action: 'REQUEST',
    status: 'PENDING',
    reason: null,
    created_by: userId,
    created_at: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

function deploymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: deploymentId,
    tenant_id: tenantId,
    factory_id: factoryId,
    agent_definition_id: agentDefinitionId,
    agent_key: 'AGENT.TEST',
    sandbox_id: sandboxId,
    simulation_run_id: simulationRunId,
    policy_simulation_run_id: policySimulationRunId,
    stage: 'CANARY',
    deployment_version: '1',
    status: 'ACTIVE',
    previous_deployment_id: null,
    rollback_of_deployment_id: null,
    reason: null,
    created_by: userId,
    created_at: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeService() {
  return new AiAgentStudioPromotionService(
    database as never,
    iamService as never,
    catalogueService as never,
    auditService as never,
  );
}

describe('AiAgentStudioPromotionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    catalogueService.getAgentDefinition.mockResolvedValue(makeAgent());

    database.transaction.mockImplementation(async (callback) =>
      callback({
        query: jest
          .fn<(...args: never[]) => Promise<any>>()
          .mockResolvedValue({ rows: [] }),
      } as never),
    );
  });

  it('creates a pending canary publication request from a completed sandbox', async () => {
    const service = makeService();

    database.query
      .mockResolvedValueOnce({ rows: [makeSandbox()] })
      .mockResolvedValueOnce({ rows: [makeSimulation()] });

    database.transaction.mockImplementation(async (callback) =>
      callback({
        query: jest
          .fn<(...args: never[]) => Promise<any>>()
          .mockResolvedValue({ rows: [requestRow()] }),
      } as never),
    );

    const result = await service.requestPublication(
      tenantId,
      factoryId,
      userId,
      traceId,
      {
        agentDefinitionId,
        sandboxId,
        simulationRunId,
        targetStage: 'CANARY',
      },
    );

    expect(result.status).toBe('PENDING');
    expect(result.targetStage).toBe('CANARY');
  });

  it('requires policy simulation for production request', async () => {
    const service = makeService();

    database.query
      .mockResolvedValueOnce({ rows: [makeSandbox()] })
      .mockResolvedValueOnce({ rows: [makeSimulation()] });

    await expect(
      service.requestPublication(
        tenantId,
        factoryId,
        userId,
        traceId,
        {
          agentDefinitionId,
          sandboxId,
          simulationRunId,
          targetStage: 'PRODUCTION',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an active canary before production promotion', async () => {
    const service = makeService();

    database.query
      .mockResolvedValueOnce({ rows: [requestRow({ target_stage: 'PRODUCTION', status: 'APPROVED' })] })
      .mockResolvedValueOnce({ rows: [makeSandbox()] })
      .mockResolvedValueOnce({ rows: [makeSimulation()] })
      .mockResolvedValueOnce({ rows: [makePolicySimulation()] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.promotePublication(
        tenantId,
        factoryId,
        userId,
        traceId,
        requestId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires policy simulation with no denial/drift for production', async () => {
    const service = makeService();

    database.query
      .mockResolvedValueOnce({ rows: [makeSandbox()] })
      .mockResolvedValueOnce({ rows: [makeSimulation()] })
      .mockResolvedValueOnce({ rows: [makePolicySimulation({ recommendation: 'POLICY_DRIFT_DETECTED' })] });

    await expect(
      service.requestPublication(
        tenantId,
        factoryId,
        userId,
        traceId,
        {
          agentDefinitionId,
          sandboxId,
          simulationRunId,
          targetStage: 'PRODUCTION',
          policySimulationRunId,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('approves a pending request using append-only state', async () => {
    const service = makeService();

    database.query.mockResolvedValueOnce({ rows: [requestRow()] });
    database.query.mockResolvedValueOnce({ rows: [requestRow({ version: '2', action: 'APPROVE', status: 'APPROVED' })] });

    const result = await service.approvePublication(
      tenantId,
      factoryId,
      userId,
      traceId,
      requestId,
    );

    expect(result.version).toBe(2);
    expect(result.status).toBe('APPROVED');
  });

  it('blocks approval of a request that is no longer pending', async () => {
    const service = makeService();

    database.query.mockResolvedValueOnce({ rows: [requestRow({ status: 'PROMOTED' })] });

    await expect(
      service.approvePublication(
        tenantId,
        factoryId,
        userId,
        traceId,
        requestId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('promotes an approved canary request into an active deployment', async () => {
    const service = makeService();

    database.query
      .mockResolvedValueOnce({ rows: [requestRow({ status: 'APPROVED', target_stage: 'CANARY' })] })
      .mockResolvedValueOnce({ rows: [makeSandbox()] })
      .mockResolvedValueOnce({ rows: [makeSimulation()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ max_version: '0' }] });

    database.transaction.mockImplementation(async (callback) =>
      callback({
        query: jest
          .fn<(...args: never[]) => Promise<any>>()
          .mockResolvedValueOnce({ rows: [deploymentRow()] }),
      } as never),
    );

    database.query.mockResolvedValueOnce({ rows: [requestRow({ version: '2', status: 'PROMOTED', action: 'PROMOTE' })] });

    const result = await service.promotePublication(
      tenantId,
      factoryId,
      userId,
      traceId,
      requestId,
    );

    expect(result.deployment.status).toBe('ACTIVE');
    expect(result.request.status).toBe('PROMOTED');
  });

  it('rolls back an active deployment to the previous deployment snapshot', async () => {
    const service = makeService();

    database.query
      .mockResolvedValueOnce({ rows: [deploymentRow()] })
      .mockResolvedValueOnce({ rows: [deploymentRow({ id: 'df1a2222-2222-4222-8222-222222222222', deployment_version: '0', status: 'ACTIVE' })] })
      .mockResolvedValueOnce({ rows: [{ max_version: '1' }] });

    database.transaction.mockImplementation(async (callback) =>
      callback({
        query: jest
          .fn<(...args: never[]) => Promise<any>>()
          .mockResolvedValueOnce({ rows: [deploymentRow({ deployment_version: '2', rollback_of_deployment_id: deploymentId, previous_deployment_id: deploymentId })] }),
      } as never),
    );

    const result = await service.rollbackDeployment(
      tenantId,
      factoryId,
      userId,
      traceId,
      deploymentId,
      'Rollback drill',
    );

    expect(result.status).toBe('ACTIVE');
    expect(result.rollbackOfDeploymentId).toBe(deploymentId);
  });

  it('fails closed when a non-active deployment is rolled back', async () => {
    const service = makeService();

    database.query.mockResolvedValueOnce({
      rows: [deploymentRow({ status: 'ROLLED_BACK' })],
    });

    await expect(
      service.rollbackDeployment(
        tenantId,
        factoryId,
        userId,
        traceId,
        deploymentId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
