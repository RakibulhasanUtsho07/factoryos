import {
  Body,
  Controller,
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
  AiAgentStudioService,
} from './ai.agent.studio.service';

import {
  CreateAiAgentStudioSandboxDto,
} from './dto/create-ai-agent-studio-sandbox.dto';

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

@Controller('v1/ai/agent-studio')
export class AiAgentStudioController {
  constructor(
    private readonly studioService: AiAgentStudioService,
  ) {}

  @Post('sandboxes')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async createSandbox(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiAgentStudioSandboxDto,
  ) {
    const context = this.getContext(request);

    return this.studioService.createSandbox(
      context.tenantId,
      context.factoryId,
      context.userId,
      {
        name: body.name,
        traceId:
          body.trace_id ??
          context.traceId,
        agentSpec: {
          agentId: body.agent_spec.agent_id,
          version: body.agent_spec.version,
          goal: body.agent_spec.goal,
          riskCeiling: body.agent_spec.risk_ceiling as
            | 'L0'
            | 'L1'
            | 'L2'
            | 'L3'
            | 'L4',
          executionScopes:
            body.agent_spec.execution_scopes,
          tools: body.agent_spec.tools.map(
            (tool) => ({
              toolId: tool.tool_id,
              version: tool.version,
              actionType: tool.action_type,
            }),
          ),
          memory: body.agent_spec.memory,
          policies: body.agent_spec.policies,
          prompts: body.agent_spec.prompts,
          completionCriteria:
            body.agent_spec.completion_criteria,
        },
        inputSnapshot:
          body.input_snapshot,
        policySnapshot:
          body.policy_snapshot,
        plan: body.plan.map(
          (step) => ({
            stepKey: step.step_key,
            toolId: step.tool_id,
            toolVersion: step.tool_version,
            actionType: step.action_type,
            input: step.input,
          }),
        ),
        simulatedToolResponses:
          body.simulated_tool_responses,
      },
    );
  }

  private getContext(
    request: FactoryOsRequest,
  ): {
    userId: string;
    tenantId: string;
    factoryId: string;
    traceId: string;
  } {
    const userId =
      request.factoryos?.userId ?? null;
    const tenantId =
      request.factoryos?.tenantId ?? null;
    const factoryId =
      request.factoryos?.factoryId ?? null;
    const traceId =
      request.factoryos?.traceId ?? null;

    if (
      !userId ||
      !tenantId ||
      !factoryId ||
      !traceId
    ) {
      throw new UnauthorizedException(
        'Authenticated AI factory context is missing',
      );
    }

    return {
      userId,
      tenantId,
      factoryId,
      traceId,
    };
  }
}
