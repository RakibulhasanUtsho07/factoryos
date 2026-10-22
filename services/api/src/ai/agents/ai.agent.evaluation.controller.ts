import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../../iam/guards/permission.guard';
import { RequireFactoryScope } from '../../iam/require-factory-scope.decorator';
import { RequirePermission } from '../../iam/require-permission.decorator';
import { AiAgentEvaluationService } from './ai.agent.evaluation.service';
import { CreateAiAgentEvaluationCaseDto } from './dto/create-ai-agent-evaluation-case.dto';
import { EvaluateAiAgentCaseDto } from './dto/evaluate-ai-agent-case.dto';
import { EvaluateAiAgentLiveCaseDto } from './dto/evaluate-ai-agent-live-case.dto';

interface FactoryOsRequestContext {
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type FactoryOsRequest = Request & { factoryos?: FactoryOsRequestContext };

@Controller('v1/ai/agents/catalogue')
export class AiAgentEvaluationController {
  constructor(private readonly evaluationService: AiAgentEvaluationService) {}

  @Post(':definitionId/evaluation-cases')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async createCase(
    @Req() request: FactoryOsRequest,
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Body() body: CreateAiAgentEvaluationCaseDto,
  ) {
    const context = this.getContext(request);
    return this.evaluationService.createCase(
      context.tenantId, context.factoryId, context.userId, definitionId,
      {
        caseKey: body.case_key, version: body.version, name: body.name,
        description: body.description ?? null, kind: body.kind,
        expectedToolId: body.expected_tool_id ?? null,
        expectedToolVersion: body.expected_tool_version ?? null,
        expectedActionType: body.expected_action_type ?? null,
        expectedInputSubset: body.expected_input_subset ?? {},
        expectedRefusalReasonContains: body.expected_refusal_reason_contains ?? null,
        status: body.status,
      },
    );
  }

  @Get(':definitionId/evaluation-cases')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.read')
  @RequireFactoryScope()
  async listCases(
    @Req() request: FactoryOsRequest,
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
  ) {
    const context = this.getContext(request);
    return this.evaluationService.listCases(
      context.tenantId, context.factoryId, context.userId, definitionId,
    );
  }

  @Post(':definitionId/evaluation-cases/:caseId/evaluate')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async evaluateCase(
    @Req() request: FactoryOsRequest,
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() body: EvaluateAiAgentCaseDto,
  ) {
    const context = this.getContext(request);
    return this.evaluationService.evaluateCase(
      context.tenantId, context.factoryId, context.userId, definitionId, caseId, body.simulation_run_id,
    );
  }

  @Post(':definitionId/evaluation-cases/:caseId/evaluate-live')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async evaluateLiveExecution(
    @Req() request: FactoryOsRequest,
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() body: EvaluateAiAgentLiveCaseDto,
  ) {
    const context = this.getContext(request);
    return this.evaluationService.evaluateLiveExecution(
      context.tenantId, context.factoryId, context.userId, definitionId, caseId, body.task_id,
    );
  }

  @Get(':definitionId/evaluation-report')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.read')
  @RequireFactoryScope()
  async report(
    @Req() request: FactoryOsRequest,
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
  ) {
    const context = this.getContext(request);
    return this.evaluationService.getReport(
      context.tenantId, context.factoryId, context.userId, definitionId,
    );
  }

  private getContext(request: FactoryOsRequest): { userId: string; tenantId: string; factoryId: string } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException('Authenticated AI factory context is missing');
    }
    return { userId, tenantId, factoryId };
  }
}
