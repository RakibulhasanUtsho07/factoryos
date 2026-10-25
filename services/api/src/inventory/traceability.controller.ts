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
  CreateTraceabilityUnitDto, IssueTraceabilityLabelDto, UpdateTraceabilitySettingsDto,
} from './dto/traceability.dto';
import { TraceabilityService } from './traceability.service';
import { WmsFulfillmentService } from './wms-fulfillment.service';
import { AddWmsPackingContentDto, CreateWmsPackingContainerDto, DispatchWmsShipmentDto, RecordWmsShipmentDeliveryEventDto } from './dto/wms-packing-shipment.dto';

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
  constructor(
    private readonly traceabilityService: TraceabilityService,
    private readonly wmsFulfillmentService: WmsFulfillmentService,
  ) {}

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

  @Get('units/:unitId/recall-impact')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async recallImpact(@Req() request: TraceabilityRequest,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
    @Query('depth') rawDepth?: string, @Query('limit') rawLimit?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.recallImpact(
      c.userId, c.tenantId, c.factoryId, unitId,
      rawDepth === undefined ? undefined : Number(rawDepth),
      rawLimit === undefined ? undefined : Number(rawLimit),
    );
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

  @Post('labels/issue')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async issueLabel(
    @Req() request: TraceabilityRequest,
    @Body() body: IssueTraceabilityLabelDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.requireContext(request);
    return this.traceabilityService.issueLabel(
      c.userId, c.tenantId, c.factoryId, body, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Get('labels/resolve')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async resolveLabel(@Req() request: TraceabilityRequest, @Query('code') code?: string) {
    const c = this.requireContext(request);
    return this.traceabilityService.resolveLabel(c.userId, c.tenantId, c.factoryId, code ?? '');
  }

  @Get('units/:unitId/label-history')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async labelHistory(
    @Req() request: TraceabilityRequest,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
  ) {
    const c = this.requireContext(request);
    return this.traceabilityService.listLabelIssuesForUnit(c.userId, c.tenantId, c.factoryId, unitId);
  }

  @Get('items/:itemId/label-history')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async materialLabelHistory(
    @Req() request: TraceabilityRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    const c = this.requireContext(request);
    return this.traceabilityService.listLabelIssuesForItem(c.userId, c.tenantId, c.factoryId, itemId);
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


  @Post('containers')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async createWmsContainer(
    @Req() request: TraceabilityRequest,
    @Body() body: CreateWmsPackingContainerDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.createContainer(
      c.userId, c.tenantId, c.factoryId, body, idempotencyKey ?? null, c.requestId ?? null, c.traceId ?? null,
    );
  }

  @Get('shipments')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async listWmsShipments(
    @Req() request: TraceabilityRequest,
    @Query('search') search?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.listShipments(
      c.userId, c.tenantId, c.factoryId,
      { search, limit: rawLimit === undefined ? undefined : Number(rawLimit) },
    );
  }

  @Get('containers/:containerUnitId')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async getWmsContainer(
    @Req() request: TraceabilityRequest,
    @Param('containerUnitId', new ParseUUIDPipe()) containerUnitId: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.getContainer(c.userId, c.tenantId, c.factoryId, containerUnitId);
  }

  @Post('containers/:containerUnitId/contents')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async addWmsContainerContent(
    @Req() request: TraceabilityRequest,
    @Param('containerUnitId', new ParseUUIDPipe()) containerUnitId: string,
    @Body() body: AddWmsPackingContentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.addContent(
      c.userId, c.tenantId, c.factoryId, containerUnitId, body,
      idempotencyKey ?? null, c.requestId ?? null, c.traceId ?? null,
    );
  }

  @Post('containers/:containerUnitId/seal')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async sealWmsContainer(
    @Req() request: TraceabilityRequest,
    @Param('containerUnitId', new ParseUUIDPipe()) containerUnitId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.sealContainer(
      c.userId, c.tenantId, c.factoryId, containerUnitId,
      idempotencyKey ?? null, c.requestId ?? null, c.traceId ?? null,
    );
  }

  @Post('containers/:containerUnitId/dispatch')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async dispatchWmsContainer(
    @Req() request: TraceabilityRequest,
    @Param('containerUnitId', new ParseUUIDPipe()) containerUnitId: string,
    @Body() body: DispatchWmsShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.dispatchContainer(
      c.userId, c.tenantId, c.factoryId, containerUnitId, body,
      idempotencyKey ?? null, c.requestId ?? null, c.traceId ?? null,
    );
  }

  @Post('shipments/:shipmentUnitId/delivery-events')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async recordShipmentDeliveryEvent(
    @Req() request: TraceabilityRequest,
    @Param('shipmentUnitId', new ParseUUIDPipe()) shipmentUnitId: string,
    @Body() body: RecordWmsShipmentDeliveryEventDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.recordDeliveryEvent(
      c.userId, c.tenantId, c.factoryId, shipmentUnitId, body,
      idempotencyKey ?? null, c.requestId ?? null, c.traceId ?? null,
    );
  }

  @Get('shipments/:shipmentUnitId/delivery-events')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.read')
  @RequireFactoryScope()
  async listShipmentDeliveryEvents(
    @Req() request: TraceabilityRequest,
    @Param('shipmentUnitId', new ParseUUIDPipe()) shipmentUnitId: string,
  ) {
    const c = this.requireContext(request);
    return this.wmsFulfillmentService.listDeliveryEvents(c.userId, c.tenantId, c.factoryId, shipmentUnitId);
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
