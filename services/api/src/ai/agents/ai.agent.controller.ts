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
  Query,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../../iam/guards/permission.guard';
import { RequireFactoryScope } from '../../iam/require-factory-scope.decorator';
import { RequirePermission } from '../../iam/require-permission.decorator';

import { AiAgentRuntimeService } from './ai.agent.runtime.service';
import {
  CreateAiAgentHandoffDto,
} from './dto/create-ai-agent-handoff.dto';
import { RejectAiAgentHandoffDto } from './dto/reject-ai-agent-handoff.dto';
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
        ...(body.planner_attestation ? { plannerAttestation: body.planner_attestation } : {}),
        ...(body.agent_definition_id !== undefined
          ? { agentDefinitionId: body.agent_definition_id }
          : {}),
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

  /**
   * Advance one persisted, dependency-checked task step through the governed
   * authorization and Tool Gateway boundary. The service re-checks policy,
   * approval, signed planner provenance for writes, idempotency and deadlines.
   */
  @Post('tasks/:id/steps/:stepId/execute')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.execute')
  @RequireFactoryScope()
  async executeStep(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) taskId: string,
    @Param('stepId', new ParseUUIDPipe()) stepId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.executeStep(
      context.tenantId,
      context.factoryId,
      context.userId,
      taskId,
      stepId,
    );
  }

  /**
   * Resume only a persisted approval-pending step. executeStep re-runs the
   * live authorization checks and rejects a revoked, expired or mismatched
   * approval before crossing the executor boundary.
   */
  @Post('tasks/:id/steps/:stepId/resume')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.execute')
  @RequireFactoryScope()
  async resumeTaskStep(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) taskId: string,
    @Param('stepId', new ParseUUIDPipe()) stepId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.resumeTaskStep(
      context.tenantId,
      context.factoryId,
      context.userId,
      taskId,
      stepId,
    );
  }

  /**
   * Finalize a task only after every persisted step is SUCCEEDED. The service
   * independently checks cancellation, deadline and the complete step ledger.
   */
  @Post('tasks/:id/verify')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.execute')
  @RequireFactoryScope()
  async verifyTask(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) taskId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.verifyTask(
      context.tenantId,
      context.factoryId,
      context.userId,
      taskId,
    );
  }

  @Get('tasks')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listTasks(
    @Req() request: FactoryOsRequest,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);

    return this.aiAgentRuntimeService.listTasks(
      context.tenantId,
      context.factoryId,
      context.userId,
      limit,
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

  @Post('handoffs/:id/accept')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.authorize')
  @RequireFactoryScope()
  async acceptHandoff(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) handoffId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.acceptHandoff(
      context.tenantId,
      context.factoryId,
      context.userId,
      handoffId,
    );
  }

  @Post('handoffs/:id/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.authorize')
  @RequireFactoryScope()
  async rejectHandoff(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) handoffId: string,
    @Body() body?: RejectAiAgentHandoffDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);

    return this.aiAgentRuntimeService.rejectHandoff(
      context.tenantId,
      context.factoryId,
      context.userId,
      handoffId,
      body?.reason,
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
