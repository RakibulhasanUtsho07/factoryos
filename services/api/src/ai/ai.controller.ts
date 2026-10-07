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
} from '../iam/guards/permission.guard';

import {
  RequireFactoryScope,
} from '../iam/require-factory-scope.decorator';

import {
  RequirePermission,
} from '../iam/require-permission.decorator';

import {
  AiRuntimeService,
} from './ai.runtime.service';

import {
  CreateAiDecisionDto,
} from './dto/create-ai-decision.dto';

import {
  ResolveAiContextDto,
} from './dto/resolve-ai-context.dto';

import {
  VerifyAiDecisionDto,
} from './dto/verify-ai-decision.dto';

import {
  AuthorizeAiActionDto,
} from './dto/authorize-ai-action.dto';

import {
  ExecuteAiActionDto,
} from './dto/execute-ai-action.dto';

import {
  CreateAiOutcomeDto,
} from './dto/create-ai-outcome.dto';

import {
  CreateAiLearningSignalDto,
} from './dto/create-ai-learning-signal.dto';

import {
  CreateAiReleaseDto,
} from './dto/create-ai-release.dto';

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

@Controller('v2/ai')
export class AiController {
  constructor(
    private readonly aiRuntimeService: AiRuntimeService,
  ) {}

  // ============================================================
  // DECISIONS
  // ============================================================

  @Post('decisions')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.decisions.write')
  @RequireFactoryScope()
  async createDecision(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiDecisionDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.createDecision(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.requestId,
      context.traceId,
      body,
    );
  }

  // ============================================================
  // CONTEXT
  // ============================================================

  @Post('context/resolve')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.context.read')
  @RequireFactoryScope()
  async resolveContext(
    @Req() request: FactoryOsRequest,
    @Body() body: ResolveAiContextDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.resolveContext(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  // ============================================================
  // VERIFICATION
  // ============================================================

  @Post('verify')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.verify')
  @RequireFactoryScope()
  async verifyDecision(
    @Req() request: FactoryOsRequest,
    @Body() body: VerifyAiDecisionDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.verifyDecision(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  // ============================================================
  // ACTION AUTHORIZATION
  // ============================================================

  @Post('actions/authorize')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.authorize')
  @RequireFactoryScope()
  async authorizeAction(
    @Req() request: FactoryOsRequest,
    @Body() body: AuthorizeAiActionDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.authorizeAction(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  // ============================================================
  // ACTION EXECUTION
  // ============================================================

  @Post('actions/execute')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.actions.execute')
  @RequireFactoryScope()
  async executeAction(
    @Req() request: FactoryOsRequest,
    @Body() body: ExecuteAiActionDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.executeAction(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  // ============================================================
  // OUTCOMES
  // ============================================================

  @Post('outcomes')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.outcomes.write')
  @RequireFactoryScope()
  async createOutcome(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiOutcomeDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.createOutcome(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  // ============================================================
  // LEARNING SIGNALS
  // ============================================================

  @Post('learning/signals')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.learning.write')
  @RequireFactoryScope()
  async createLearningSignal(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiLearningSignalDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.createLearningSignal(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  // ============================================================
  // RELEASES
  // ============================================================

  @Post('releases')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.release.write')
  @RequireFactoryScope()
  async createRelease(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiReleaseDto,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.createRelease(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  // ============================================================
  // REPLAY
  // ============================================================

  @Get('replay/:traceId')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.replay.read')
  @RequireFactoryScope()
  async replayDecision(
    @Req() request: FactoryOsRequest,
    @Param('traceId', new ParseUUIDPipe())
    traceId: string,
  ) {
    const context =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.aiRuntimeService.replayDecision(
      context.tenantId,
      context.factoryId,
      context.userId,
      traceId,
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
    const userId =
      request.factoryos?.userId ?? null;
    const tenantId =
      request.factoryos?.tenantId ?? null;
    const factoryId =
      request.factoryos?.factoryId ?? null;
    const requestId =
      request.factoryos?.requestId ?? null;
    const traceId =
      request.factoryos?.traceId ?? null;

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
