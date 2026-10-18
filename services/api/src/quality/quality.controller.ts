import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CloseQualityNcrDto, CreateQualityDefectDto, CreateQualityDefectLinkDto, CreateQualityInspectionDto,
  CreateQualityInspectionPlanDto, CreateQualityInspectionResultDto, CreateQualityNcrActionDto,
  CreateQualityReworkOrderDto, ListQualityInspectionsQueryDto, ListQualityPlansQueryDto,
  ListQualityReworkOrdersQueryDto, QualityDispositionDto, QualityInspectionDecisionDto,
  QualityInspectionPlanTransitionDto, QualityNcrActionTransitionDto, QualityNcrActionVerificationDto,
  QualityReworkTransitionDto,
} from './quality.dto';
import { QualityService } from './quality.service';

interface QualityRequestContext {
  requestId?: string | null;
  traceId?: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type QualityRequest = Request & { factoryos?: QualityRequestContext };

@Controller('quality')
export class QualityController {
  constructor(private readonly qualityService: QualityService) {}

  @Post('plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.plans.manage')
  @RequireFactoryScope()
  async createInspectionPlan(@Req() request: QualityRequest, @Body() body: CreateQualityInspectionPlanDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    return this.qualityService.createInspectionPlan(this.requireContext(request), body, idempotencyKey ?? null);
  }

  @Get('plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async listInspectionPlans(@Req() request: QualityRequest, @Query() query: ListQualityPlansQueryDto) {
    return this.qualityService.listInspectionPlans(this.requireContext(request), query);
  }

  @Get('plans/:planId')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async getInspectionPlan(@Req() request: QualityRequest, @Param('planId', new ParseUUIDPipe()) planId: string) {
    return this.qualityService.getInspectionPlan(this.requireContext(request), planId);
  }

  @Post('plans/:planId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.plans.manage')
  @RequireFactoryScope()
  async transitionInspectionPlan(@Req() request: QualityRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string, @Body() body: QualityInspectionPlanTransitionDto) {
    return this.qualityService.transitionInspectionPlan(this.requireContext(request), planId, body);
  }

  @Post('inspections')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.write')
  @RequireFactoryScope()
  async createInspection(@Req() request: QualityRequest, @Body() body: CreateQualityInspectionDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.qualityService.createInspection(c, body, idempotencyKey ?? null);
  }

  @Get('inspections')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async listInspections(@Req() request: QualityRequest, @Query() query: ListQualityInspectionsQueryDto) {
    const c = this.requireContext(request);
    return this.qualityService.listInspections(c, query);
  }

  @Get('inspections/:inspectionId')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async getInspection(@Req() request: QualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string) {
    const c = this.requireContext(request);
    return this.qualityService.getInspection(c, inspectionId);
  }

  @Post('inspections/:inspectionId/defects')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.defects.write')
  @RequireFactoryScope()
  async recordDefect(@Req() request: QualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: CreateQualityDefectDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.qualityService.recordDefect(c, inspectionId, body, idempotencyKey ?? null);
  }

  @Post('inspections/:inspectionId/results')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.write')
  @RequireFactoryScope()
  async recordInspectionResult(@Req() request: QualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: CreateQualityInspectionResultDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.qualityService.recordInspectionResult(this.requireContext(request), inspectionId, body, idempotencyKey ?? null);
  }

  @Post('inspections/:inspectionId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.write')
  @RequireFactoryScope()
  async decideInspection(@Req() request: QualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: QualityInspectionDecisionDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.qualityService.decideInspection(c, inspectionId, body, idempotencyKey ?? null);
  }

  @Post('inspections/:inspectionId/dispositions')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.disposition.decide')
  @RequireFactoryScope()
  async disposeInspection(@Req() request: QualityRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: QualityDispositionDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.qualityService.disposeInspection(c, inspectionId, body, idempotencyKey ?? null);
  }


  @Post('defects/:defectId/rework-orders')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.rework.manage')
  @RequireFactoryScope()
  async createReworkOrder(@Req() request: QualityRequest,
    @Param('defectId', new ParseUUIDPipe()) defectId: string,
    @Body() body: CreateQualityReworkOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    return this.qualityService.createReworkOrder(this.requireContext(request), defectId, body, idempotencyKey ?? null);
  }

  @Get('rework-orders')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async listReworkOrders(@Req() request: QualityRequest, @Query() query: ListQualityReworkOrdersQueryDto) {
    return this.qualityService.listReworkOrders(this.requireContext(request), query);
  }

  @Get('rework-orders/:reworkOrderId')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async getReworkOrder(@Req() request: QualityRequest,
    @Param('reworkOrderId', new ParseUUIDPipe()) reworkOrderId: string) {
    return this.qualityService.getReworkOrder(this.requireContext(request), reworkOrderId);
  }

  @Post('rework-orders/:reworkOrderId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.rework.manage')
  @RequireFactoryScope()
  async transitionReworkOrder(@Req() request: QualityRequest,
    @Param('reworkOrderId', new ParseUUIDPipe()) reworkOrderId: string,
    @Body() body: QualityReworkTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    return this.qualityService.transitionReworkOrder(this.requireContext(request), reworkOrderId, body, idempotencyKey ?? null);
  }

  @Get('holds')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async listHolds(@Req() request: QualityRequest, @Query('status') status?: string,
    @Query('limit') rawLimit?: string) {
    const c = this.requireContext(request);
    return this.qualityService.listHolds(c, status, rawLimit === undefined ? undefined : Number(rawLimit));
  }

  @Post('ncrs/:ncrId/actions')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.ncr.manage')
  @RequireFactoryScope()
  async recordNcrAction(@Req() request: QualityRequest,
    @Param('ncrId', new ParseUUIDPipe()) ncrId: string,
    @Body() body: CreateQualityNcrActionDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.qualityService.recordNcrAction(c, ncrId, body, idempotencyKey ?? null);
  }


  @Post('ncrs/:ncrId/actions/:actionId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.ncr.manage')
  @RequireFactoryScope()
  async transitionNcrAction(@Req() request: QualityRequest,
    @Param('ncrId', new ParseUUIDPipe()) ncrId: string,
    @Param('actionId', new ParseUUIDPipe()) actionId: string,
    @Body() body: QualityNcrActionTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    return this.qualityService.transitionNcrAction(this.requireContext(request), ncrId, actionId, body, idempotencyKey ?? null);
  }

  @Post('ncrs/:ncrId/actions/:actionId/verify')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.capa.verify')
  @RequireFactoryScope()
  async verifyNcrAction(@Req() request: QualityRequest,
    @Param('ncrId', new ParseUUIDPipe()) ncrId: string,
    @Param('actionId', new ParseUUIDPipe()) actionId: string,
    @Body() body: QualityNcrActionVerificationDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    return this.qualityService.verifyNcrAction(this.requireContext(request), ncrId, actionId, body, idempotencyKey ?? null);
  }

  @Post('defects/:defectId/links')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.defects.trace')
  @RequireFactoryScope()
  async createDefectLink(@Req() request: QualityRequest,
    @Param('defectId', new ParseUUIDPipe()) defectId: string,
    @Body() body: CreateQualityDefectLinkDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    return this.qualityService.createDefectLink(this.requireContext(request), defectId, body, idempotencyKey ?? null);
  }

  @Get('defect-links/:linkId')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.inspections.read')
  @RequireFactoryScope()
  async getDefectLink(@Req() request: QualityRequest,
    @Param('linkId', new ParseUUIDPipe()) linkId: string) {
    return this.qualityService.getDefectLink(this.requireContext(request), linkId);
  }

  @Get('defects/:defectId/traceability')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.defects.trace')
  @RequireFactoryScope()
  async getDefectTraceability(@Req() request: QualityRequest,
    @Param('defectId', new ParseUUIDPipe()) defectId: string) {
    return this.qualityService.getDefectTraceability(this.requireContext(request), defectId);
  }

  @Post('ncrs/:ncrId/close')
  @UseGuards(PermissionGuard)
  @RequirePermission('quality.ncr.manage')
  @RequireFactoryScope()
  async closeNcr(@Req() request: QualityRequest,
    @Param('ncrId', new ParseUUIDPipe()) ncrId: string, @Body() body: CloseQualityNcrDto) {
    const c = this.requireContext(request);
    return this.qualityService.closeNcr(c, ncrId, body);
  }

  private requireContext(request: QualityRequest) {
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
