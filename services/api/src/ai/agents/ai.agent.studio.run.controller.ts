import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../../iam/guards/permission.guard';
import { RequireFactoryScope } from '../../iam/require-factory-scope.decorator';
import { RequirePermission } from '../../iam/require-permission.decorator';
import { AiAgentStudioRunService } from './ai.agent.studio.run.service';
import {
  BranchAiAgentStudioRunDto,
  CompareAiAgentStudioRunsDto,
  ReplayAiAgentStudioRunDto,
} from './dto/ai.agent.studio.run.dto';

interface FactoryOsRequestContext {
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('v1/ai/agent-studio')
export class AiAgentStudioRunController {
  constructor(
    private readonly runService: AiAgentStudioRunService,
  ) {}

  @Get('sandboxes/:sandboxId/simulations/:runId')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.read')
  @RequireFactoryScope()
  async getRun(
    @Req() request: FactoryOsRequest,
    @Param('sandboxId') sandboxId: string,
    @Param('runId') runId: string,
  ) {
    const context = this.getContext(request);

    return this.runService.getRun(
      context.tenantId,
      context.factoryId,
      context.userId,
      sandboxId,
      runId,
    );
  }

  @Get('sandboxes/:sandboxId/simulations/:runId/steps/:stepIndex')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.read')
  @RequireFactoryScope()
  async inspectStep(
    @Req() request: FactoryOsRequest,
    @Param('sandboxId') sandboxId: string,
    @Param('runId') runId: string,
    @Param('stepIndex') rawStepIndex: string,
  ) {
    const context = this.getContext(request);
    const stepIndex = Number(rawStepIndex);

    return this.runService.inspectStep(
      context.tenantId,
      context.factoryId,
      context.userId,
      sandboxId,
      runId,
      stepIndex,
    );
  }

  @Post('sandboxes/:sandboxId/simulations/replay')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async replay(
    @Req() request: FactoryOsRequest,
    @Param('sandboxId') sandboxId: string,
    @Body() body: ReplayAiAgentStudioRunDto,
  ) {
    const context = this.getContext(request);

    return this.runService.replayRun(
      context.tenantId,
      context.factoryId,
      context.userId,
      sandboxId,
      body.source_run_id,
      body.from_step_index,
      body.to_step_index,
    );
  }

  @Post('sandboxes/:sandboxId/simulations/branch')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async branch(
    @Req() request: FactoryOsRequest,
    @Param('sandboxId') sandboxId: string,
    @Body() body: BranchAiAgentStudioRunDto,
  ) {
    const context = this.getContext(request);

    return this.runService.branchRun(
      context.tenantId,
      context.factoryId,
      context.userId,
      sandboxId,
      body.source_run_id,
      body.branch_from_step_index,
      body.plan.map((step) => ({
        stepKey: step.step_key,
        toolId: step.tool_id,
        toolVersion: step.tool_version,
        actionType: step.action_type,
        input: step.input,
      })),
      body.simulated_tool_responses,
    );
  }

  @Post('sandboxes/:sandboxId/simulations/compare')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.read')
  @RequireFactoryScope()
  async compare(
    @Req() request: FactoryOsRequest,
    @Param('sandboxId') sandboxId: string,
    @Body() body: CompareAiAgentStudioRunsDto,
  ) {
    const context = this.getContext(request);

    return this.runService.compareRuns(
      context.tenantId,
      context.factoryId,
      context.userId,
      sandboxId,
      body.left_run_id,
      body.right_run_id,
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
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    const traceId = request.factoryos?.traceId ?? null;

    if (!userId || !tenantId || !factoryId || !traceId) {
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
