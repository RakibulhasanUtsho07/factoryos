import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersDto } from './dto/list-suppliers.dto';
import { TransitionSupplierStatusDto } from './dto/transition-supplier-status.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import { TransitionPurchaseOrderDto } from './dto/transition-purchase-order.dto';
import { PurchaseOrderStatus } from './purchase-order-lifecycle';
import { ProcurementService } from './procurement.service';

interface ProcurementRequestContext {
  requestId: string | null;
  traceId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type ProcurementRequest = Request & { factoryos?: ProcurementRequestContext };

function requiredUserTenant(request: ProcurementRequest) {
  const userId = request.factoryos?.userId ?? null;
  const tenantId = request.factoryos?.tenantId ?? null;
  if (!userId || !tenantId) throw new UnauthorizedException('Authenticated user and tenant context are required');
  return { userId, tenantId };
}
function requiredFactoryContext(request: ProcurementRequest) {
  const scope = requiredUserTenant(request);
  const factoryId = request.factoryos?.factoryId ?? null;
  if (!factoryId) throw new UnauthorizedException('Authenticated factory context is required');
  return { ...scope, factoryId };
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly procurementService: ProcurementService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('suppliers.write')
  async create(@Req() request: ProcurementRequest, @Body() body: CreateSupplierDto) {
    const { userId, tenantId } = requiredUserTenant(request);
    return this.procurementService.createSupplier(
      userId, tenantId, body,
      request.factoryos?.requestId ?? null, request.factoryos?.traceId ?? null,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('suppliers.read')
  async list(@Req() request: ProcurementRequest, @Query() query: ListSuppliersDto) {
    const { tenantId } = requiredUserTenant(request);
    return this.procurementService.listSuppliers(tenantId, query);
  }

  @Post(':supplierId/status')
  @UseGuards(PermissionGuard)
  @RequirePermission('suppliers.write')
  async transitionStatus(
    @Req() request: ProcurementRequest,
    @Param('supplierId', new ParseUUIDPipe()) supplierId: string,
    @Body() body: TransitionSupplierStatusDto,
  ) {
    const { userId, tenantId } = requiredUserTenant(request);
    return this.procurementService.transitionSupplierStatus(
      userId, tenantId, supplierId, body,
      request.factoryos?.requestId ?? null, request.factoryos?.traceId ?? null,
    );
  }
}

@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly procurementService: ProcurementService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('purchase_orders.write')
  @RequireFactoryScope()
  async create(
    @Req() request: ProcurementRequest,
    @Body() body: CreatePurchaseOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const { userId, tenantId, factoryId } = requiredFactoryContext(request);
    return this.procurementService.createPurchaseOrder(
      userId, tenantId, factoryId, body, idempotencyKey ?? null,
      request.factoryos?.requestId ?? null, request.factoryos?.traceId ?? null,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('purchase_orders.read')
  @RequireFactoryScope()
  async list(@Req() request: ProcurementRequest, @Query() query: ListPurchaseOrdersDto) {
    const { tenantId, factoryId } = requiredFactoryContext(request);
    return this.procurementService.listPurchaseOrders(tenantId, factoryId, query);
  }

  @Get(':purchaseOrderId')
  @UseGuards(PermissionGuard)
  @RequirePermission('purchase_orders.read')
  @RequireFactoryScope()
  async getById(
    @Req() request: ProcurementRequest,
    @Param('purchaseOrderId', new ParseUUIDPipe()) purchaseOrderId: string,
  ) {
    const { tenantId, factoryId } = requiredFactoryContext(request);
    return this.procurementService.getPurchaseOrder(tenantId, factoryId, purchaseOrderId);
  }

  @Post(':purchaseOrderId/submit')
  @UseGuards(PermissionGuard)
  @RequirePermission('purchase_orders.write')
  @RequireFactoryScope()
  async submit(
    @Req() request: ProcurementRequest,
    @Param('purchaseOrderId', new ParseUUIDPipe()) purchaseOrderId: string,
    @Body() body: TransitionPurchaseOrderDto = {},
  ) {
    return this.transition(request, purchaseOrderId, 'SUBMITTED', body);
  }

  @Post(':purchaseOrderId/approve')
  @UseGuards(PermissionGuard)
  @RequirePermission('purchase_orders.approve')
  @RequireFactoryScope()
  async approve(
    @Req() request: ProcurementRequest,
    @Param('purchaseOrderId', new ParseUUIDPipe()) purchaseOrderId: string,
    @Body() body: TransitionPurchaseOrderDto = {},
  ) {
    return this.transition(request, purchaseOrderId, 'APPROVED', body);
  }

  @Post(':purchaseOrderId/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('purchase_orders.approve')
  @RequireFactoryScope()
  async reject(
    @Req() request: ProcurementRequest,
    @Param('purchaseOrderId', new ParseUUIDPipe()) purchaseOrderId: string,
    @Body() body: TransitionPurchaseOrderDto = {},
  ) {
    return this.transition(request, purchaseOrderId, 'REJECTED', body);
  }

  @Post(':purchaseOrderId/cancel')
  @UseGuards(PermissionGuard)
  @RequirePermission('purchase_orders.write')
  @RequireFactoryScope()
  async cancel(
    @Req() request: ProcurementRequest,
    @Param('purchaseOrderId', new ParseUUIDPipe()) purchaseOrderId: string,
    @Body() body: TransitionPurchaseOrderDto = {},
  ) {
    return this.transition(request, purchaseOrderId, 'CANCELLED', body);
  }

  private async transition(
    request: ProcurementRequest,
    purchaseOrderId: string,
    targetStatus: PurchaseOrderStatus,
    body: TransitionPurchaseOrderDto,
  ) {
    const { userId, tenantId, factoryId } = requiredFactoryContext(request);
    return this.procurementService.transitionPurchaseOrder(
      userId, tenantId, factoryId, purchaseOrderId, targetStatus,
      body.expected_version, body.reason,
      request.factoryos?.requestId ?? null, request.factoryos?.traceId ?? null,
    );
  }
}
