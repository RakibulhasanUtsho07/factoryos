import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type {
  Request,
} from 'express';

import {
  PermissionGuard,
} from '../../iam/guards/permission.guard';

import {
  RequireFactoryScope,
} from '../../iam/require-factory-scope.decorator';

import {
  RequirePermission,
} from '../../iam/require-permission.decorator';

import {
  AiAgentCatalogueService,
} from './ai.agent.catalogue.service';

import type {
  AiToolRiskClass,
} from '../tools/ai.tool.types';

import {
  CreateAiAgentDefinitionDto,
} from './dto/create-ai-agent-definition.dto';

import {
  CreateAiAgentToolGrantDto,
} from './dto/create-ai-agent-tool-grant.dto';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('v1/ai/agents/catalogue')
export class AiAgentCatalogueController {
  constructor(
    private readonly catalogueService: AiAgentCatalogueService,
  ) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async createAgent(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiAgentDefinitionDto,
  ) {
    const context = this.getContext(request);

    return this.catalogueService.createAgentDefinition(
      context.tenantId,
      context.factoryId,
      context.userId,
      {
        agentId: body.agent_id,
        version: body.version,
        name: body.name,
        description: body.description ?? null,
        capability: body.capability,
        typicalOutput: body.typical_output,
        authority: body.authority,
        riskCeiling: body.risk_ceiling as AiToolRiskClass | undefined,
        status: body.status as never,
        maxSteps: body.max_steps,
        maxRetries: body.max_retries,
        maxToolCalls: body.max_tool_calls,
        timeoutMs: body.timeout_ms,
        config: body.config ?? {},
      },
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.read')
  @RequireFactoryScope()
  async listAgents(
    @Req() request: FactoryOsRequest,
  ) {
    const context = this.getContext(request);

    return this.catalogueService.listAgentDefinitions(
      context.tenantId,
      context.factoryId,
      context.userId,
    );
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.read')
  @RequireFactoryScope()
  async getAgent(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const context = this.getContext(request);

    return this.catalogueService.getAgentDefinition(
      context.tenantId,
      context.factoryId,
      context.userId,
      id,
    );
  }

  @Post(':id/tools')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async grantTool(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) agentDefinitionId: string,
    @Body() body: CreateAiAgentToolGrantDto,
  ) {
    const context = this.getContext(request);

    if (
      body.agent_definition_id !==
      agentDefinitionId
    ) {
      throw new UnauthorizedException(
        'Agent definition route id does not match body',
      );
    }

    return this.catalogueService.grantTool(
      context.tenantId,
      context.factoryId,
      context.userId,
      {
        agentDefinitionId,
        toolId: body.tool_id,
        toolVersion: body.tool_version,
        effectiveFrom: body.effective_from,
        expiresAt: body.expires_at ?? null,
        metadata: body.metadata ?? {},
      },
    );
  }

  @Post(':id/tools/:grantId/revoke')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async revokeTool(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) agentDefinitionId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
  ) {
    const context = this.getContext(request);

    /*
     * The service re-checks the tenant/factory scope of the grant.
     * Route id is intentionally not accepted as a body-controlled
     * field, preventing cross-agent grant spoofing.
     */
    const revoked =
      await this.catalogueService.revokeToolGrant(
        context.tenantId,
        context.factoryId,
        context.userId,
        grantId,
      );

    if (
      revoked.agentDefinitionId !==
      agentDefinitionId
    ) {
      throw new UnauthorizedException(
        'Grant does not belong to the requested agent definition',
      );
    }

    return revoked;
  }

  private getContext(
    request: FactoryOsRequest,
  ): {
    userId: string;
    tenantId: string;
    factoryId: string;
  } {
    const context = request.factoryos;

    const userId = context?.userId ?? null;
    const tenantId = context?.tenantId ?? null;
    const factoryId = context?.factoryId ?? null;

    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException(
        'Authenticated AI factory context is missing',
      );
    }

    return {
      userId,
      tenantId,
      factoryId,
    };
  }
}
