import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  BindQualitySamplingProfilesDto, CreateFabricScoringProfileDto, CreateQualityAqlProfileDto,
  QualityAdvancedProfileTransitionDto, QualityDefectParetoQueryDto, QualityRepeatAlertsQueryDto,
  RecordFabricRollScoreDto, RecordQualityAqlSampleDto, RecordQualityDefectContextDto,
} from './advanced-quality.dto';
import { AdvancedQualityService } from './advanced-quality.service';

interface AdvancedQualityRequestContext {
  requestId?: string | null;
  traceId?: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type AdvancedQualityRequest = Request & { factoryos?: AdvancedQualityRequestContext };

@Controller('quality')
export class AdvancedQualityController {
  constructor(private readonly quality: AdvancedQualityService) {}

  @Post('aql-profiles')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async createAqlProfile(@Req() request: AdvancedQualityRequest, @Body() body: CreateQualityAqlProfileDto,
    @Headers('idempotency-key') key?: string) {
    return this.quality.createAqlProfile(this.requireContext(request), body, key ?? null);
  }

  @Get('aql-profiles')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.read')
  @RequireFactoryScope()
  async listAqlProfiles(@Req() request: AdvancedQualityRequest, @Query('status') status?: string) {
    return this.quality.listProfiles(this.requireContext(request), 'AQL', status);
  }

  @Post('aql-profiles/:profileId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async transitionAqlProfile(@Req() request: AdvancedQualityRequest,
    @Param('profileId', new ParseUUIDPipe()) profileId: string,
    @Body() body: QualityAdvancedProfileTransitionDto, @Headers('idempotency-key') key?: string) {
    return this.quality.transitionAqlProfile(this.requireContext(request), profileId, body, key ?? null);
  }

  @Post('fabric-scoring-profiles')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async createFabricProfile(@Req() request: AdvancedQualityRequest, @Body() body: CreateFabricScoringProfileDto,
    @Headers('idempotency-key') key?: string) {
    return this.quality.createFabricScoringProfile(this.requireContext(request), body, key ?? null);
  }

  @Get('fabric-scoring-profiles')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.read')
  @RequireFactoryScope()
  async listFabricProfiles(@Req() request: AdvancedQualityRequest, @Query('status') status?: string) {
    return this.quality.listProfiles(this.requireContext(request), 'FABRIC', status);
  }

  @Post('fabric-scoring-profiles/:profileId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async transitionFabricProfile(@Req() request: AdvancedQualityRequest,
    @Param('profileId', new ParseUUIDPipe()) profileId: string,
    @Body() body: QualityAdvancedProfileTransitionDto, @Headers('idempotency-key') key?: string) {
    return this.quality.transitionFabricScoringProfile(this.requireContext(request), profileId, body, key ?? null);
  }

  @Post('inspections/:inspectionId/sampling-profile')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async bindSamplingProfiles(@Req() request: AdvancedQualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: BindQualitySamplingProfilesDto, @Headers('idempotency-key') key?: string) {
    return this.quality.bindSamplingProfiles(this.requireContext(request), inspectionId, body, key ?? null);
  }

  @Post('inspections/:inspectionId/aql-samples')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async recordAqlSample(@Req() request: AdvancedQualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: RecordQualityAqlSampleDto, @Headers('idempotency-key') key?: string) {
    return this.quality.recordAqlSample(this.requireContext(request), inspectionId, body, key ?? null);
  }

  @Post('inspections/:inspectionId/fabric-roll-scores')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async recordFabricRollScore(@Req() request: AdvancedQualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: RecordFabricRollScoreDto, @Headers('idempotency-key') key?: string) {
    return this.quality.recordFabricRollScore(this.requireContext(request), inspectionId, body, key ?? null);
  }

  @Get('inspections/:inspectionId/advanced-evidence')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.read')
  @RequireFactoryScope()
  async getAdvancedInspectionEvidence(@Req() request: AdvancedQualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string) {
    return this.quality.getInspectionAdvancedEvidence(this.requireContext(request), inspectionId);
  }

  @Post('defects/:defectId/context')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.manage')
  @RequireFactoryScope()
  async recordDefectContext(@Req() request: AdvancedQualityRequest,
    @Param('defectId', new ParseUUIDPipe()) defectId: string, @Body() body: RecordQualityDefectContextDto,
    @Headers('idempotency-key') key?: string) {
    return this.quality.recordDefectContext(this.requireContext(request), defectId, body, key ?? null);
  }

  @Get('analytics/defect-pareto')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.read')
  @RequireFactoryScope()
  async defectPareto(@Req() request: AdvancedQualityRequest, @Query() query: QualityDefectParetoQueryDto) {
    return this.quality.defectPareto(this.requireContext(request), query);
  }

  @Get('analytics/supplier-quality')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.read')
  @RequireFactoryScope()
  async supplierQuality(@Req() request: AdvancedQualityRequest, @Query('limit') rawLimit?: string) {
    return this.quality.supplierQuality(this.requireContext(request), rawLimit === undefined ? undefined : Number(rawLimit));
  }

  @Get('analytics/rework-repeat-alerts')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.advanced.read')
  @RequireFactoryScope()
  async reworkRepeatAlerts(@Req() request: AdvancedQualityRequest, @Query() query: QualityRepeatAlertsQueryDto) {
    return this.quality.reworkRepeatAlerts(this.requireContext(request), query);
  }

  private requireContext(request: AdvancedQualityRequest) {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId, tenantId, factoryId,
      requestId: request.factoryos?.requestId ?? null,
      traceId: request.factoryos?.traceId ?? null,
    };
  }
}
