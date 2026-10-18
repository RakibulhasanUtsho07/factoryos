import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  AddMaintenanceSparePartDto, CompleteMaintenanceTaskDto, CreateMaintenanceAssetDto,
  CreateMaintenanceBreakdownWorkOrderDto, CreateMaintenancePmPlanDto,
  GenerateDueMaintenanceWorkOrderDto, IssueMaintenanceSparePartDto, ListMaintenanceAssetsQueryDto,
  ListMaintenancePmPlansQueryDto, ListMaintenanceWorkOrdersQueryDto, MaintenancePmPlanTransitionDto,
  MaintenanceWorkOrderTransitionDto, UpdateMaintenanceAssetDto,
} from './maintenance.dto';
import { MaintenanceContext, MaintenanceService } from './maintenance.service';

interface MaintenanceRequestContext {
  requestId?: string | null;
  traceId?: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type MaintenanceRequest = Request & { factoryos?: MaintenanceRequestContext };

@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @Get('assets')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.assets.read')
  @RequireFactoryScope()
  listAssets(@Req() request: MaintenanceRequest, @Query() query: ListMaintenanceAssetsQueryDto) {
    return this.service.listAssets(this.context(request), query);
  }

  @Post('assets')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.assets.manage')
  @RequireFactoryScope()
  createAsset(
    @Req() request: MaintenanceRequest,
    @Body() dto: CreateMaintenanceAssetDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createAsset(this.context(request), dto, idempotencyKey ?? null);
  }

  @Get('assets/:assetId')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.assets.read')
  @RequireFactoryScope()
  getAsset(@Req() request: MaintenanceRequest, @Param('assetId', new ParseUUIDPipe()) assetId: string) {
    return this.service.getAsset(this.context(request), assetId);
  }

  @Post('assets/:assetId/update')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.assets.manage')
  @RequireFactoryScope()
  updateAsset(
    @Req() request: MaintenanceRequest,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Body() dto: UpdateMaintenanceAssetDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.updateAsset(this.context(request), assetId, dto, idempotencyKey ?? null);
  }

  @Get('pm-plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.pm.read')
  @RequireFactoryScope()
  listPmPlans(@Req() request: MaintenanceRequest, @Query() query: ListMaintenancePmPlansQueryDto) {
    return this.service.listPmPlans(this.context(request), query);
  }

  @Post('pm-plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.pm.manage')
  @RequireFactoryScope()
  createPmPlan(
    @Req() request: MaintenanceRequest,
    @Body() dto: CreateMaintenancePmPlanDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createPmPlan(this.context(request), dto, idempotencyKey ?? null);
  }

  @Get('pm-plans/:planId')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.pm.read')
  @RequireFactoryScope()
  getPmPlan(@Req() request: MaintenanceRequest, @Param('planId', new ParseUUIDPipe()) planId: string) {
    return this.service.getPmPlan(this.context(request), planId);
  }

  @Post('pm-plans/:planId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.pm.manage')
  @RequireFactoryScope()
  transitionPmPlan(
    @Req() request: MaintenanceRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() dto: MaintenancePmPlanTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.transitionPmPlan(this.context(request), planId, dto, idempotencyKey ?? null);
  }

  @Post('pm-plans/:planId/generate-due')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.pm.manage')
  @RequireFactoryScope()
  generateDueWorkOrder(
    @Req() request: MaintenanceRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() dto: GenerateDueMaintenanceWorkOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.generateDueWorkOrder(this.context(request), planId, dto, idempotencyKey ?? null);
  }

  @Get('work-orders')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.workorders.read')
  @RequireFactoryScope()
  listWorkOrders(@Req() request: MaintenanceRequest, @Query() query: ListMaintenanceWorkOrdersQueryDto) {
    return this.service.listWorkOrders(this.context(request), query);
  }

  @Post('work-orders')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.workorders.manage')
  @RequireFactoryScope()
  createBreakdownWorkOrder(
    @Req() request: MaintenanceRequest,
    @Body() dto: CreateMaintenanceBreakdownWorkOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createBreakdownWorkOrder(this.context(request), dto, idempotencyKey ?? null);
  }

  @Get('work-orders/:workOrderId')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.workorders.read')
  @RequireFactoryScope()
  getWorkOrder(
    @Req() request: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
  ) {
    return this.service.getWorkOrder(this.context(request), workOrderId);
  }

  @Post('work-orders/:workOrderId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.workorders.execute')
  @RequireFactoryScope()
  transitionWorkOrder(
    @Req() request: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: MaintenanceWorkOrderTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.transitionWorkOrder(this.context(request), workOrderId, dto, idempotencyKey ?? null);
  }

  @Post('work-orders/:workOrderId/tasks/:taskId/complete')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.workorders.execute')
  @RequireFactoryScope()
  completeTask(
    @Req() request: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() dto: CompleteMaintenanceTaskDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.completeTask(this.context(request), workOrderId, taskId, dto, idempotencyKey ?? null);
  }

  @Post('work-orders/:workOrderId/spare-parts')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.parts.manage')
  @RequireFactoryScope()
  addSparePart(
    @Req() request: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: AddMaintenanceSparePartDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.addSparePart(this.context(request), workOrderId, dto, idempotencyKey ?? null);
  }

  @Post('work-orders/:workOrderId/spare-parts/:partId/issue')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.parts.manage')
  @RequireFactoryScope()
  issueSparePart(
    @Req() request: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Param('partId', new ParseUUIDPipe()) partId: string,
    @Body() dto: IssueMaintenanceSparePartDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.issueSparePart(this.context(request), workOrderId, partId, dto, idempotencyKey ?? null);
  }

  @Get('spare-parts/availability/:itemId')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.parts.manage')
  @RequireFactoryScope()
  sparePartAvailability(
    @Req() request: MaintenanceRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    return this.service.getSparePartAvailability(this.context(request), itemId);
  }

  private context(request: MaintenanceRequest): MaintenanceContext {
    const c=request.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId??null,traceId:c.traceId??null};
  }
}
