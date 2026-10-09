import {
  jest,
} from '@jest/globals';

import {
  UnauthorizedException,
} from '@nestjs/common';

import {
  AiAgentCatalogueController,
} from './ai.agent.catalogue.controller';

describe('AiAgentCatalogueController', () => {
  const createAgentMock = jest.fn();
  const listAgentsMock = jest.fn();
  const getAgentMock = jest.fn();
  const grantToolMock = jest.fn();
  const revokeToolMock = jest.fn();

  const service = {
    createAgentDefinition:
      createAgentMock,
    listAgentDefinitions:
      listAgentsMock,
    getAgentDefinition:
      getAgentMock,
    grantTool:
      grantToolMock,
    revokeToolGrant:
      revokeToolMock,
  };

  const controller =
    new AiAgentCatalogueController(
      service as never,
    );

  const request = {
    factoryos: {
      requestId:
        '11111111-1111-4111-8111-111111111111',
      traceId:
        '22222222-2222-4222-8222-222222222222',
      requestedUserId: null,
      requestedTenantId: null,
      requestedFactoryId: null,
      userId:
        '33333333-3333-4333-8333-333333333333',
      tenantId:
        '44444444-4444-4444-8444-444444444444',
      factoryId:
        '55555555-5555-4555-8555-555555555555',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    createAgentMock.mockResolvedValue({
      id: 'agent-definition-1',
    });

    listAgentsMock.mockResolvedValue({
      items: [],
      limit: 50,
      offset: 0,
      count: 0,
    });

    getAgentMock.mockResolvedValue({
      id: 'agent-definition-1',
    });

    grantToolMock.mockResolvedValue({
      id: 'grant-1',
      agentDefinitionId:
        '66666666-6666-4666-8666-666666666666',
      toolId: 'AI.RUNTIME.NOOP',
      toolVersion: '1',
    });

    revokeToolMock.mockResolvedValue({
      id: 'grant-1',
      agentDefinitionId:
        '66666666-6666-4666-8666-666666666666',
      status: 'REVOKED',
    });
  });

  it('maps agent definition creation into runtime input', async () => {
    await controller.createAgent(
      request as never,
      {
        agent_id: 'graph-reasoner',
        version: '1.0.0',
        name: 'Graph Reasoner',
        capability: 'Context reasoning',
        typical_output: 'FACT / EXPLANATION',
        authority: 'No write',
      },
    );

    expect(
      createAgentMock,
    ).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      expect.objectContaining({
        agentId: 'graph-reasoner',
        version: '1.0.0',
        riskCeiling: undefined,
        status: undefined,
      }),
    );
  });

  it('passes the authenticated factory scope to list', async () => {
    await controller.listAgents(
      request as never,
    );

    expect(
      listAgentsMock,
    ).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
    );
  });

  it('prevents grant route/body agent mismatch', async () => {
    await expect(
      controller.grantTool(
        request as never,
        '66666666-6666-4666-8666-666666666666',
        {
          agent_definition_id:
            '77777777-7777-4777-8777-777777777777',
          tool_id: 'AI.RUNTIME.NOOP',
          tool_version: '1',
        },
      ),
    ).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(
      grantToolMock,
    ).not.toHaveBeenCalled();
  });

  it('allows grant when route/body agent ids match', async () => {
    const agentId =
      '66666666-6666-4666-8666-666666666666';

    await controller.grantTool(
      request as never,
      agentId,
      {
        agent_definition_id: agentId,
        tool_id: 'AI.RUNTIME.NOOP',
        tool_version: '1',
      },
    );

    expect(
      grantToolMock,
    ).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      expect.objectContaining({
        agentDefinitionId: agentId,
        toolId: 'AI.RUNTIME.NOOP',
      }),
    );
  });
});
