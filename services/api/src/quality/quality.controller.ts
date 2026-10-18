import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CloseQualityNcrDto, CreateQualityDefectDto, CreateQualityInspectionDto, CreateQualityNcrActionDto,
  ListQualityInspectionsQueryDto, QualityDispositionDto, QualityInspectionDecisionDto,
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
