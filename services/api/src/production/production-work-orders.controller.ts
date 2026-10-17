import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateWorkOrderDto } from './dto/create-work-order.dto';
import { OperationEventDto } from './dto/operation-event.dto';
import { WorkOrderOutputReportDto } from './dto/work-order-output-report.dto';
import { WorkOrderTransitionDto } from './dto/work-order-transition.dto';
import { ProductionWorkOrdersService } from './production-work-orders.service';

interface ProductionRequestContext {
  requestId: string;
  traceId: string;
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type ProductionRequest = Request & { factoryos?: ProductionRequestContext };

@Controller('production/work-orders')
export class ProductionWorkOrdersController {
  constructor(private readonly service: ProductionWorkOrdersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('production.workorders.read')
  @RequireFactoryScope()
  list(
    @Req() request: ProductionRequest,
    @Query('limit') rawLimit?: string,
    @Query('status') status?: string,
  ) {
    const c = this.context(request);
    return this.service.listWorkOrders(
      c.userId, c.tenantId, c.factoryId,
      rawLimit === undefined ? 50 : Number(rawLimit),
      status,
    );
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('production.workorders.write')
  @RequireFactoryScope()
  create(
    @Req() request: ProductionRequest,
    @Body() dto: CreateWorkOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.createWorkOrder(
      c.userId, c.tenantId, c.factoryId, dto,
      idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Get(':workOrderId')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.workorders.read')
  @RequireFactoryScope()
  get(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
  ) {
    const c = this.context(request);
    return this.service.getWorkOrder(c.userId, c.tenantId, c.factoryId, workOrderId);
  }

  @Post(':workOrderId/release')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.workorders.release')
  @RequireFactoryScope()
  release(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: WorkOrderTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.transitionWorkOrder(
      c.userId, c.tenantId, c.factoryId, workOrderId, 'RELEASE',
      dto, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post(':workOrderId/hold')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.operations.operate')
  @RequireFactoryScope()
  hold(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: WorkOrderTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.transitionWorkOrder(
      c.userId, c.tenantId, c.factoryId, workOrderId, 'HOLD',
      dto, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post(':workOrderId/resume')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.operations.operate')
  @RequireFactoryScope()
  resume(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: WorkOrderTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.transitionWorkOrder(
      c.userId, c.tenantId, c.factoryId, workOrderId, 'RESUME',
      dto, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post(':workOrderId/complete')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.workorders.release')
  @RequireFactoryScope()
  complete(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: WorkOrderTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.transitionWorkOrder(
      c.userId, c.tenantId, c.factoryId, workOrderId, 'COMPLETE',
      dto, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post(':workOrderId/cancel')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.workorders.release')
  @RequireFactoryScope()
  cancel(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: WorkOrderTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.transitionWorkOrder(
      c.userId, c.tenantId, c.factoryId, workOrderId, 'CANCEL',
      dto, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post(':workOrderId/operations/:operationId/events')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.operations.operate')
  @RequireFactoryScope()
  operationEvent(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
    @Body() dto: OperationEventDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.reportOperationEvent(
      c.userId, c.tenantId, c.factoryId, workOrderId, operationId,
      dto, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post(':workOrderId/output-reports')
  @UseGuards(PermissionGuard)
  @RequirePermission('production.output.report')
  @RequireFactoryScope()
  outputReport(
    @Req() request: ProductionRequest,
    @Param('workOrderId', new ParseUUIDPipe()) workOrderId: string,
    @Body() dto: WorkOrderOutputReportDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.context(request);
    return this.service.reportOutput(
      c.userId, c.tenantId, c.factoryId, workOrderId, dto,
      idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  private context(request: ProductionRequest) {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId: context.userId,
      tenantId: context.tenantId,
      factoryId: context.factoryId,
      requestId: context.requestId,
      traceId: context.traceId,
    };
  }
}
