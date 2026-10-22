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
import { CreateGrowthScenarioSetDto } from './dto/create-growth-scenario-set.dto';
import { DecideGrowthOpportunityDto } from './dto/decide-growth-opportunity.dto';
import { RecordGrowthExperimentResultDto } from './dto/record-growth-experiment-result.dto';
import { RecordGrowthOpportunityOutcomeDto } from './dto/record-growth-opportunity-outcome.dto';
import { RecordGrowthForecastEvaluationDto } from './dto/record-growth-forecast-evaluation.dto';
import { SyncGrowthSourceObservationsDto } from './dto/sync-growth-source-observations.dto';
import { RecordGrowthExperimentResultFromSourceDto } from './dto/record-growth-experiment-result-from-source.dto';
import { RecordGrowthOpportunityOutcomeFromSourceDto } from './dto/record-growth-opportunity-outcome-from-source.dto';
import { CreateGrowthAssumptionDto } from './dto/create-growth-assumption.dto';
import { DecideGrowthAssumptionDto } from './dto/decide-growth-assumption.dto';
import { CreateGrowthConstraintDto } from './dto/create-growth-constraint.dto';
import { CreateGrowthEvidenceGapDto } from './dto/create-growth-evidence-gap.dto';
import { DecideGrowthEvidenceGapDto } from './dto/decide-growth-evidence-gap.dto';
import { AssignGrowthDecisionOwnerDto } from './dto/assign-growth-decision-owner.dto';
import { GrowthService } from './growth.service';
import { GrowthSourceOfRecordService } from './growth-source-of-record.service';

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
  constructor(
    private readonly growth: GrowthService,
    private readonly growthSources: GrowthSourceOfRecordService,
  ) {}

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

  @Get('opportunities/:opportunityId/scenario-comparison')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  compareScenarios(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.compareScenarios(c.tenantId, c.factoryId, opportunityId);
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

  @Post('opportunities/:opportunityId/scenario-sets')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  createScenarioSet(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: CreateGrowthScenarioSetDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.createScenarioSet(
      c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId,
    );
  }

  @Get('opportunities/:opportunityId/scenario-sets')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  listScenarioSets(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.listScenarioSets(c.tenantId, c.factoryId, opportunityId);
  }

  @Get('opportunities/:opportunityId/scenario-sets/:scenarioSetId')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  getScenarioSet(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Param('scenarioSetId', new ParseUUIDPipe()) scenarioSetId: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.getScenarioSet(c.tenantId, c.factoryId, opportunityId, scenarioSetId);
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


  @Get('opportunities/:opportunityId/governance')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  getOpportunityGovernance(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.getOpportunityGovernance(c.tenantId, c.factoryId, opportunityId);
  }

  @Post('opportunities/:opportunityId/assumptions')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  addOpportunityAssumption(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: CreateGrowthAssumptionDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.addOpportunityAssumption(c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId);
  }

  @Post('opportunities/:opportunityId/assumptions/:assumptionId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.review')
  @RequireFactoryScope()
  decideOpportunityAssumption(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Param('assumptionId', new ParseUUIDPipe()) assumptionId: string,
    @Body() body: DecideGrowthAssumptionDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.decideOpportunityAssumption(
      c.userId, c.tenantId, c.factoryId, opportunityId, assumptionId, body, c.requestId, c.traceId,
    );
  }

  @Post('opportunities/:opportunityId/constraints')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  addOpportunityConstraint(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: CreateGrowthConstraintDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.addOpportunityConstraint(c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId);
  }

  @Post('opportunities/:opportunityId/evidence-gaps')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  addOpportunityEvidenceGap(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: CreateGrowthEvidenceGapDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.addOpportunityEvidenceGap(c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId);
  }

  @Post('opportunities/:opportunityId/evidence-gaps/:gapId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.review')
  @RequireFactoryScope()
  decideOpportunityEvidenceGap(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Param('gapId', new ParseUUIDPipe()) gapId: string,
    @Body() body: DecideGrowthEvidenceGapDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.decideOpportunityEvidenceGap(
      c.userId, c.tenantId, c.factoryId, opportunityId, gapId, body, c.requestId, c.traceId,
    );
  }

  @Post('opportunities/:opportunityId/decision-owners')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.review')
  @RequireFactoryScope()
  assignOpportunityDecisionOwner(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: AssignGrowthDecisionOwnerDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.assignOpportunityDecisionOwner(
      c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId,
    );
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

  @Post('opportunities/:opportunityId/outcomes/from-source')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  recordOpportunityOutcomeFromSource(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: RecordGrowthOpportunityOutcomeFromSourceDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growthSources.recordOpportunityOutcomeFromSource(
      c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId,
    );
  }

  @Post('opportunities/:opportunityId/forecast-evaluations')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  recordForecastEvaluation(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: RecordGrowthForecastEvaluationDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.recordForecastEvaluation(
      c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId,
    );
  }

  @Get('opportunities/:opportunityId/forecast-evaluations/calibration')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  getForecastCalibration(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Query('domain') domain?: string,
    @Query('residual_coverage_pct') residualCoveragePct?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growth.getForecastCalibration(
      c.tenantId, c.factoryId, opportunityId, domain,
      residualCoveragePct === undefined ? 90 : Number(residualCoveragePct),
    );
  }


  @Post('opportunities/:opportunityId/source-observations/sync')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  syncSourceObservations(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Body() body: SyncGrowthSourceObservationsDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growthSources.syncObservations(
      c.userId, c.tenantId, c.factoryId, opportunityId, body, c.requestId, c.traceId,
    );
  }

  @Get('opportunities/:opportunityId/source-observations')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  listSourceObservations(
    @Req() req: FactoryOsRequest,
    @Param('opportunityId', new ParseUUIDPipe()) opportunityId: string,
    @Query('source_kind') sourceKind?: string,
    @Query('metric_key') metricKey?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growthSources.listObservations(c.tenantId, c.factoryId, opportunityId, {
      source_kind: sourceKind, metric_key: metricKey,
      limit: rawLimit === undefined ? 50 : Number(rawLimit),
    });
  }

  @Post('experiments/:experimentId/results/from-source')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  recordExperimentResultFromSource(
    @Req() req: FactoryOsRequest,
    @Param('experimentId', new ParseUUIDPipe()) experimentId: string,
    @Body() body: RecordGrowthExperimentResultFromSourceDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.growthSources.recordExperimentResultFromSource(
      c.userId, c.tenantId, c.factoryId, experimentId, body, c.requestId, c.traceId,
    );
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
