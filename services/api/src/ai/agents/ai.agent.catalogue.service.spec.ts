import {
  jest,
} from '@jest/globals';

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import {
  AiAgentCatalogueService,
} from './ai.agent.catalogue.service';

describe('AiAgentCatalogueService', () => {
  const databaseQueryMock = jest.fn();
  const authorizeMock = jest.fn();
  const auditRecordMock = jest.fn();
  const getToolMock = jest.fn();

  const database = {
    query: databaseQueryMock,
  };

  const iamService = {
    authorize: authorizeMock,
  };

  const auditService = {
    record: auditRecordMock,
  };

  const toolRegistry = {
    getTool: getToolMock,
  };

  let service: AiAgentCatalogueService;

  const tenantId =
    '11111111-1111-4111-8111-111111111111';
  const factoryId =
    '22222222-2222-4222-8222-222222222222';
  const userId =
    '33333333-3333-4333-8333-333333333333';
  const agentDefinitionId =
    '44444444-4444-4444-8444-444444444444';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AiAgentCatalogueService(
      database as never,
      iamService as never,
      auditService as never,
      toolRegistry as never,
    );
  });

  it('rejects a tool above the agent risk ceiling', async () => {
    databaseQueryMock
      .mockResolvedValueOnce({
        rows: [{
          id: agentDefinitionId,
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          version: '1.0.0',
          name: 'Graph Reasoner',
          description: null,
          capability: 'Context reasoning',
          typical_output: 'FACT / EXPLANATION',
          authority: 'No write',
          risk_ceiling: 'L1',
          status: 'ACTIVE',
          max_steps: 20,
          max_retries: 3,
          max_tool_calls: 20,
          timeout_ms: 60000,
          config: {},
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
          updated_at: '2026-10-07T00:00:00.000Z',
        }],
      });

    getToolMock.mockResolvedValue({
      toolId: 'TEST.WRITE',
      version: '1',
      riskClass: 'L3',
      status: 'ACTIVE',
    });

    await expect(
      service.assertToolEntitled(
        tenantId,
        factoryId,
        'graph-reasoner',
        'TEST.WRITE',
        '1',
      ),
    ).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(databaseQueryMock).toHaveBeenCalledTimes(1);
  });

  it('returns an active entitlement when grant and risk checks pass', async () => {
    databaseQueryMock
      .mockResolvedValueOnce({
        rows: [{
          id: agentDefinitionId,
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          version: '1.0.0',
          name: 'Graph Reasoner',
          description: null,
          capability: 'Context reasoning',
          typical_output: 'FACT / EXPLANATION',
          authority: 'No write',
          risk_ceiling: 'L2',
          status: 'ACTIVE',
          max_steps: 20,
          max_retries: 3,
          max_tool_calls: 20,
          timeout_ms: 60000,
          config: {},
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
          updated_at: '2026-10-07T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: '55555555-5555-4555-8555-555555555555',
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_definition_id: agentDefinitionId,
          tool_id: 'AI.RUNTIME.NOOP',
          tool_version: '1',
          version: '1',
          status: 'ACTIVE',
          effective_from: '2026-10-07T00:00:00.000Z',
          expires_at: null,
          metadata: {},
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
        }],
      });

    getToolMock.mockResolvedValue({
      toolId: 'AI.RUNTIME.NOOP',
      version: '1',
      riskClass: 'L0',
      status: 'ACTIVE',
    });

    const result =
      await service.assertToolEntitled(
        tenantId,
        factoryId,
        'graph-reasoner',
        'AI.RUNTIME.NOOP',
        '1',
      );

    expect(result.agent.agentId).toBe(
      'graph-reasoner',
    );
    expect(result.grant.toolId).toBe(
      'AI.RUNTIME.NOOP',
    );
  });

  it('does not resolve an inactive agent for runtime entitlement', async () => {
    databaseQueryMock.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.assertToolEntitled(
        tenantId,
        factoryId,
        'graph-reasoner',
        'AI.RUNTIME.NOOP',
        '1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(getToolMock).not.toHaveBeenCalled();
  });


  it('fails closed when an operator has paused the agent', async () => {
    databaseQueryMock
      .mockResolvedValueOnce({
        rows: [{
          id: agentDefinitionId,
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          version: '1.0.0',
          name: 'Graph Reasoner',
          description: null,
          capability: 'Context reasoning',
          typical_output: 'FACT / EXPLANATION',
          authority: 'No write',
          risk_ceiling: 'L2',
          execution_scopes: ['ai.actions.execute'],
          status: 'ACTIVE',
          max_steps: 20,
          max_retries: 3,
          max_tool_calls: 20,
          timeout_ms: 60000,
          config: {},
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
          updated_at: '2026-10-07T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: '55555555-5555-4555-8555-555555555555',
          control_revision: '1',
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          agent_definition_id: agentDefinitionId,
          status: 'PAUSED',
          execution_scopes: [],
          reason: 'Incident response',
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
        }],
      });

    getToolMock.mockResolvedValue({
      toolId: 'AI.RUNTIME.NOOP',
      version: '1',
      riskClass: 'L0',
      requiredScopes: ['ai.actions.execute'],
      status: 'ACTIVE',
    });

    await expect(
      service.assertToolEntitled(
        tenantId,
        factoryId,
        'graph-reasoner',
        'AI.RUNTIME.NOOP',
        '1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(databaseQueryMock).toHaveBeenCalledTimes(2);
    expect(databaseQueryMock.mock.calls[1]?.[0]).toContain(
      'FROM ai_agent_operational_controls',
    );
  });

  it('applies restricted execution scopes before allowing a tool', async () => {
    databaseQueryMock
      .mockResolvedValueOnce({
        rows: [{
          id: agentDefinitionId,
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          version: '1.0.0',
          name: 'Graph Reasoner',
          description: null,
          capability: 'Context reasoning',
          typical_output: 'FACT / EXPLANATION',
          authority: 'No write',
          risk_ceiling: 'L2',
          execution_scopes: ['ai.actions.execute', 'orders.read'],
          status: 'ACTIVE',
          max_steps: 20,
          max_retries: 3,
          max_tool_calls: 20,
          timeout_ms: 60000,
          config: {},
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
          updated_at: '2026-10-07T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: '55555555-5555-4555-8555-555555555555',
          control_revision: '1',
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          agent_definition_id: agentDefinitionId,
          status: 'RESTRICTED',
          execution_scopes: ['ai.actions.execute'],
          reason: 'Reduce access during investigation',
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
        }],
      });

    getToolMock.mockResolvedValue({
      toolId: 'ORDERS.READ',
      version: '1',
      riskClass: 'L0',
      requiredScopes: ['orders.read'],
      status: 'ACTIVE',
    });

    await expect(
      service.assertToolEntitled(
        tenantId,
        factoryId,
        'graph-reasoner',
        'ORDERS.READ',
        '1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(databaseQueryMock).toHaveBeenCalledTimes(2);
  });

  it('records a pause as an immutable operational-control revision', async () => {
    databaseQueryMock
      .mockResolvedValueOnce({
        rows: [{
          id: agentDefinitionId,
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          version: '1.0.0',
          name: 'Graph Reasoner',
          description: null,
          capability: 'Context reasoning',
          typical_output: 'FACT / EXPLANATION',
          authority: 'No write',
          risk_ceiling: 'L2',
          execution_scopes: ['ai.actions.execute'],
          status: 'ACTIVE',
          max_steps: 20,
          max_retries: 3,
          max_tool_calls: 20,
          timeout_ms: 60000,
          config: {},
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
          updated_at: '2026-10-07T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: '55555555-5555-4555-8555-555555555555',
          control_revision: '8',
          tenant_id: tenantId,
          factory_id: factoryId,
          agent_id: 'graph-reasoner',
          agent_definition_id: agentDefinitionId,
          status: 'PAUSED',
          execution_scopes: [],
          reason: 'Incident response',
          created_by: userId,
          created_at: '2026-10-07T00:00:00.000Z',
        }],
      });

    const result = await service.setAgentOperationalControl(
      tenantId,
      factoryId,
      userId,
      agentDefinitionId,
      {
        status: 'PAUSED',
        executionScopes: [],
        reason: 'Incident response',
      },
    );

    expect(result.status).toBe('PAUSED');
    expect(result.revision).toBe('8');
    expect(databaseQueryMock).toHaveBeenCalledTimes(2);
    expect(databaseQueryMock.mock.calls[1]?.[0]).toContain(
      'INSERT INTO ai_agent_operational_controls',
    );
    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SET_OPERATIONAL_CONTROL',
        resourceType: 'AI_AGENT_OPERATIONAL_CONTROL',
      }),
    );
  });

  it('rejects operational controls that try to add execution scopes', async () => {
    databaseQueryMock.mockResolvedValueOnce({
      rows: [{
        id: agentDefinitionId,
        tenant_id: tenantId,
        factory_id: factoryId,
        agent_id: 'graph-reasoner',
        version: '1.0.0',
        name: 'Graph Reasoner',
        description: null,
        capability: 'Context reasoning',
        typical_output: 'FACT / EXPLANATION',
        authority: 'No write',
        risk_ceiling: 'L2',
        execution_scopes: ['ai.actions.execute'],
        status: 'ACTIVE',
        max_steps: 20,
        max_retries: 3,
        max_tool_calls: 20,
        timeout_ms: 60000,
        config: {},
        created_by: userId,
        created_at: '2026-10-07T00:00:00.000Z',
        updated_at: '2026-10-07T00:00:00.000Z',
      }],
    });

    await expect(
      service.setAgentOperationalControl(
        tenantId,
        factoryId,
        userId,
        agentDefinitionId,
        {
          status: 'RESTRICTED',
          executionScopes: ['orders.write'],
          reason: 'Attempt to widen scope',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(databaseQueryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate versioned agent definitions as conflict', async () => {
    authorizeMock.mockResolvedValue(undefined);
    databaseQueryMock.mockRejectedValue({
      code: '23505',
    });

    await expect(
      service.createAgentDefinition(
        tenantId,
        factoryId,
        userId,
        {
          agentId: 'graph-reasoner',
          version: '1.0.0',
          name: 'Graph Reasoner',
          capability: 'Context reasoning',
          typicalOutput: 'FACT / EXPLANATION',
          authority: 'No write',
        },
      ),
    ).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
