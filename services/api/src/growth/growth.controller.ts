import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateGrowthExperimentDto } from './dto/create-growth-experiment.dto';
import { CreateGrowthValidationUnknownDto } from './dto/create-growth-validation-unknown.dto';
import { DecideGrowthValidationUnknownDto } from './dto/decide-growth-validation-unknown.dto';
import { CreateGrowthOpportunityDto } from './dto/create-growth-opportunity.dto';
import { CreateGrowthScenarioDto } from './dto/create-growth-scenario.dto';
import { DecideGrowthOpportunityDto } from './dto/decide-growth-opportunity.dto';
import { RecordGrowthExperimentResultDto } from './dto/record-growth-experiment-result.dto';
import { RecordGrowthOpportunityOutcomeDto } from './dto/record-growth-opportunity-outcome.dto';
import { GrowthService } from './growth.service';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & { factoryos?: FactoryOsRequestContext };

@Controller('growth')
export class GrowthController {
  constructor(private readonly growth: GrowthService) {}

  @Post('opportunities')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  createOpportunity(@Req() req: FactoryOsRequest, @Body() body: CreateGrowthOpportunityDto): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.createOpportunity(c.userId, c.tenantId, c.factoryId, body, c.requestId, c.traceId);
  }

  @Get('opportunities')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  listOpportunities(
    @Req() req: FactoryOsRequest,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.listOpportunities(c.tenantId, c.factoryId, {
      status, category, limit: rawLimit === undefined ? 50 : Number(rawLimit),
    });
  }

  @Get('opportunities/:opportunityId')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  getOpportunity(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.getOpportunity(c.tenantId, c.factoryId, opportunityId);
  }

  @Post('opportunities/:opportunityId/unknowns')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  createValidationUnknown(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: CreateGrowthValidationUnknownDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.createValidationUnknown(
      c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId,
    );
  }

  @Get('opportunities/:opportunityId/unknowns')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  listValidationUnknowns(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Query('include_resolved') includeResolved?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.listValidationUnknowns(
      c.tenantId, c.factoryId, opportunityId, includeResolved === 'true',
    );
  }

  @Post('unknowns/:unknownId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.review')
  @RequireFactoryScope()
  decideValidationUnknown(
    @Req() req: FactoryOsRequest,
    @Param('unknownId', new ParseUUIDPipe()) unknownId: string,
    @Body() body: DecideGrowthValidationUnknownDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.decideValidationUnknown(
      c.userId, c.tenantId, c.factoryId, unknownId, body, c.requestId, c.traceId,
    );
  }

  @Post('opportunities/:opportunityId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.review')
  @RequireFactoryScope()
  decideOpportunity(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: DecideGrowthOpportunityDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.decideOpportunity(c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId);
  }

  @Post('opportunities/:opportunityId/scenarios')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  createScenario(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: CreateGrowthScenarioDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.createScenario(c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId);
  }

  @Post('opportunities/:opportunityId/experiments')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  createExperiment(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: CreateGrowthExperimentDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.createExperiment(c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId);
  }

  @Post('experiments/:experimentId/start')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.review')
  @RequireFactoryScope()
  startExperiment(
    @Req() req: FactoryOsRequest,
    @Param('experimentId', new ParseUUIDPipe()) experimentId: string,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.startExperiment(c.userId, c.tenantId, c.factoryId, experimentId, c.requestId, c.traceId);
  }

  @Post('experiments/:experimentId/results')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  recordExperimentResult(
    @Req() req: FactoryOsRequest,
    @Param('experimentId', new ParseUUIDPipe()) experimentId: string,
    @Body() body: RecordGrowthExperimentResultDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.recordExperimentResult(c.userId, c.tenantId, c.factoryId, experimentId, body, c.requestId, c.traceId);
  }

  @Post('opportunities/:opportunityId/outcomes')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  recordOpportunityOutcome(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: RecordGrowthOpportunityOutcomeDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.growth.recordOpportunityOutcome(c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId);
  }

  private context(req: FactoryOsRequest) {
    const c = req.factoryos;
    if (!c?.userId || !c.tenantId || !c.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId: c.userId, tenantId: c.tenantId, factoryId: c.factoryId,
      requestId: c.requestId ?? null, traceId: c.traceId ?? null,
    };
  }
}
