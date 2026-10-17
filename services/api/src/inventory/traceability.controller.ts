import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  ChangeTraceabilityUnitStatusDto, CreateGenealogyEventDto, CreateTraceabilityLabelTemplateDto,
  CreateTraceabilityUnitDto, UpdateTraceabilitySettingsDto,
} from './dto/traceability.dto';
import { TraceabilityService } from './traceability.service';

interface TraceabilityRequestContext {
  requestId?: string | null;
  traceId?: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type TraceabilityRequest = Request & { factoryos?: TraceabilityRequestContext };

@Controller('traceability')
export class TraceabilityController {
  constructor(private readonly traceabilityService: TraceabilityService) {}

  @Post('units')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async createUnit(@Req() request: TraceabilityRequest, @Body() body: CreateTraceabilityUnitDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.createUnit(
      c.userId, c.tenantId, c.factoryId, body, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Get('units')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async listUnits(@Req() request: TraceabilityRequest, @Query('search') search?: string,
    @Query('unit_type') unitType?: string, @Query('product_role') productRole?: string,
    @Query('status') status?: string, @Query('limit') rawLimit?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.listUnits(c.userId, c.tenantId, c.factoryId, {
      search, unitType, productRole, status, limit: rawLimit === undefined ? undefined : Number(rawLimit),
    });
  }

  @Get('units/:unitId/forward')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async forwardTrace(@Req() request: TraceabilityRequest,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
    @Query('depth') rawDepth?: string, @Query('limit') rawLimit?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.trace(c.userId, c.tenantId, c.factoryId, unitId, 'FORWARD',
      rawDepth === undefined ? undefined : Number(rawDepth),
      rawLimit === undefined ? undefined : Number(rawLimit));
  }

  @Get('units/:unitId/reverse')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async reverseTrace(@Req() request: TraceabilityRequest,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
    @Query('depth') rawDepth?: string, @Query('limit') rawLimit?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.trace(c.userId, c.tenantId, c.factoryId, unitId, 'REVERSE',
      rawDepth === undefined ? undefined : Number(rawDepth),
      rawLimit === undefined ? undefined : Number(rawLimit));
  }

  @Get('units/:unitId')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async getUnit(@Req() request: TraceabilityRequest,
    @Param('unitId', new ParseUUIDPipe()) unitId: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.getUnit(c.userId, c.tenantId, c.factoryId, unitId);
  }

  @Post('genealogy')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async recordGenealogy(@Req() request: TraceabilityRequest, @Body() body: CreateGenealogyEventDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.recordGenealogyEvent(
      c.userId, c.tenantId, c.factoryId, body, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post('units/:unitId/status')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async changeStatus(@Req() request: TraceabilityRequest,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
    @Body() body: ChangeTraceabilityUnitStatusDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.changeUnitStatus(
      c.userId, c.tenantId, c.factoryId, unitId, body, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Get('units/:unitId/status-history')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async statusHistory(@Req() request: TraceabilityRequest,
    @Param('unitId', new ParseUUIDPipe()) unitId: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.listUnitStatusHistory(c.userId, c.tenantId, c.factoryId, unitId);
  }

  @Post('label-templates')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async createLabelTemplate(@Req() request: TraceabilityRequest,
    @Body() body: CreateTraceabilityLabelTemplateDto) {
    const c = this.requireContext(request);
    return this.traceabilityService.createLabelTemplate(
      c.userId, c.tenantId, c.factoryId, body, c.requestId, c.traceId,
    );
  }

  @Get('label-templates')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async listLabelTemplates(@Req() request: TraceabilityRequest,
    @Query('active_only') rawActiveOnly?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.listLabelTemplates(
      c.userId, c.tenantId, c.factoryId,
      rawActiveOnly === undefined ? true : rawActiveOnly.toLowerCase() !== 'false',
    );
  }

  @Get('settings')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async getSettings(@Req() request: TraceabilityRequest) {
    const c = this.requireContext(request);
    return this.traceabilityService.getSettings(c.userId, c.tenantId, c.factoryId);
  }

  @Put('settings')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async updateSettings(@Req() request: TraceabilityRequest, @Body() body: UpdateTraceabilitySettingsDto) {
    const c = this.requireContext(request);
    return this.traceabilityService.updateSettings(
      c.userId, c.tenantId, c.factoryId, body, c.requestId, c.traceId,
    );
  }

  private requireContext(request: TraceabilityRequest) {
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
