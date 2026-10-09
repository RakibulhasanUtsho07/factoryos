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
import type { Request } from 'express';

import { PermissionGuard } from '../../iam/guards/permission.guard';
import { RequireFactoryScope } from '../../iam/require-factory-scope.decorator';
import { RequirePermission } from '../../iam/require-permission.decorator';

import { AiAgentRuntimeService } from './ai.agent.runtime.service';
import {
  CreateAiAgentHandoffDto,
} from './dto/create-ai-agent-handoff.dto';
import {
  CreateAiAgentTaskDto,
} from './dto/create-ai-agent-task.dto';

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

@Controller('v1/ai')
export class AiAgentController {
  constructor(
    private readonly aiAgentRuntimeService: AiAgentRuntimeService,
  ) {}

  @Post('tasks')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.authorize')
  @RequireFactoryScope()
  async createTask(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiAgentTaskDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.createTask(
      context.tenantId,
      context.factoryId,
      context.userId,
      {
        decisionId: body.decision_id,
        parentTraceId: body.parent_trace_id ?? context.traceId,
        goal: body.goal,
        limits: body.limits
          ? {
              ...(body.limits.max_steps !== undefined
                ? { maxSteps: body.limits.max_steps }
                : {}),
              ...(body.limits.max_retries !== undefined
                ? { maxRetries: body.limits.max_retries }
                : {}),
              ...(body.limits.max_tool_calls !== undefined
                ? { maxToolCalls: body.limits.max_tool_calls }
                : {}),
              ...(body.limits.timeout_ms !== undefined
                ? { timeoutMs: body.limits.timeout_ms }
                : {}),
            }
          : undefined,
        deadlineAt: body.deadline_at ?? null,
        contextVersion: body.context_version ?? null,
        planVersion: body.plan_version ?? null,
        contextHash: body.context_hash ?? null,
        idempotencyKey: body.idempotency_key ?? null,
        steps: body.steps.map((step) => ({
          stepKey: step.step_key,
          capability: step.capability,
          agentId: step.agent_id ?? null,
          inputSchema: step.input_schema ?? {},
          outputSchema: step.output_schema ?? {},
          toolId: step.tool_id,
          toolVersion: step.tool_version,
          actionType: step.action_type,
          target: step.target ?? {},
          payload: step.payload ?? {},
          resourceType: step.resource_type ?? null,
          resourceId: step.resource_id ?? null,
          riskClass: step.risk_class ?? null,
          timeoutMs: step.timeout_ms,
          retryLimit: step.retry_limit,
          authorityLevel: step.authority_level,
          dependsOn: step.depends_on ?? [],
        })),
      },
    );
  }

  @Get('tasks/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async getTask(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) taskId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.getTask(
      context.tenantId,
      context.factoryId,
      context.userId,
      taskId,
    );
  }

  @Post('tasks/:id/cancel')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.authorize')
  @RequireFactoryScope()
  async cancelTask(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) taskId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.cancelTask(
      context.tenantId,
      context.factoryId,
      context.userId,
      taskId,
    );
  }

  @Post('agents/:id/handoff')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.authorize')
  @RequireFactoryScope()
  async createHandoff(
    @Req() request: FactoryOsRequest,
    @Param('id') sourceAgentId: string,
    @Body() body: CreateAiAgentHandoffDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.createHandoff(
      context.tenantId,
      context.factoryId,
      context.userId,
      {
        sourceAgentId,
        targetAgentId: body.target_agent_id,
        purpose: body.purpose,
        allowedDataClasses: body.allowed_data_classes,
        permittedTools: body.permitted_tools,
        expiresAt:
          body.expires_at ??
          new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        parentTraceId: body.parent_trace_id ?? context.traceId,
        expectedArtifact: body.expected_artifact ?? null,
      },
    );
  }

  private getAuthenticatedFactoryContext(
    request: FactoryOsRequest,
  ): {
    userId: string;
    tenantId: string;
    factoryId: string;
    requestId: string;
    traceId: string;
  } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    const requestId = request.factoryos?.requestId ?? null;
    const traceId = request.factoryos?.traceId ?? null;

    if (
      !userId ||
      !tenantId ||
      !factoryId ||
      !requestId ||
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
      requestId,
      traceId,
    };
  }
}
