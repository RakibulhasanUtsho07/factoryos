import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { CreateInventoryReservationDto } from './dto/create-inventory-reservation.dto';
import { TransitionInventoryReservationDto } from './dto/transition-inventory-reservation.dto';
import { CreateInventoryStockReconciliationDto } from './dto/create-inventory-stock-reconciliation.dto';
import { CreateInventoryCycleCountDto } from './dto/create-inventory-cycle-count.dto';
import { ReviewInventoryCycleCountDto } from './dto/review-inventory-cycle-count.dto';
import { InventoryReservationService } from './inventory.reservation.service';
import { InventoryStockReconciliationService } from './inventory.stock-reconciliation.service';
import { InventoryCycleCountService } from './inventory.cycle-count.service';
import { InventoryService } from './inventory.service';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('inventory/items')
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly reservationService: InventoryReservationService,
    private readonly reconciliationService: InventoryStockReconciliationService,
    private readonly cycleCountService: InventoryCycleCountService,
  ) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async create(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateInventoryItemDto,
  ) {
    const context = this.requireContext(request);
    return this.inventoryService.createItem(
      context.userId,
      context.tenantId,
      context.factoryId,
      body,
      context.requestId,
      context.traceId,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async list(
    @Req() request: FactoryOsRequest,
    @Query('search') search?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    return this.inventoryService.listItems(
      context.tenantId,
      context.factoryId,
      search,
      limit,
    );
  }

  @Post(':itemId/movements')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async createMovement(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: CreateStockMovementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.inventoryService.createStockMovement(
      context.userId,
      context.tenantId,
      context.factoryId,
      itemId,
      body,
      idempotencyKey ?? null,
      context.requestId,
      context.traceId,
    );
  }

  @Post(':itemId/reconciliations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reconcile.direct')
  @RequireFactoryScope()
  async reconcileStock(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: CreateInventoryStockReconciliationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.reconciliationService.recordReconciliation(
      context.userId,
      context.tenantId,
      context.factoryId,
      itemId,
      body,
      idempotencyKey ?? null,
      context.requestId,
      context.traceId,
    );
  }

  @Post(':itemId/cycle-counts')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reconcile')
  @RequireFactoryScope()
  async submitCycleCount(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: CreateInventoryCycleCountDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.cycleCountService.submitCycleCount(
      context.userId, context.tenantId, context.factoryId, itemId,
      body, idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get(':itemId/cycle-counts')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listCycleCounts(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.cycleCountService.listCycleCounts(
      context.tenantId, context.factoryId, itemId,
      { status, limit: rawLimit === undefined ? 50 : Number(rawLimit) },
    );
  }

  @Post(':itemId/cycle-counts/:proposalId/approve')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.cycle-count.review')
  @RequireFactoryScope()
  async approveCycleCount(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Param('proposalId', new ParseUUIDPipe()) proposalId: string,
    @Body() body: ReviewInventoryCycleCountDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.cycleCountService.approveCycleCount(
      context.userId, context.tenantId, context.factoryId, itemId, proposalId,
      body, idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Post(':itemId/cycle-counts/:proposalId/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.cycle-count.review')
  @RequireFactoryScope()
  async rejectCycleCount(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Param('proposalId', new ParseUUIDPipe()) proposalId: string,
    @Body() body: ReviewInventoryCycleCountDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.cycleCountService.rejectCycleCount(
      context.userId, context.tenantId, context.factoryId, itemId, proposalId,
      body, idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get(':itemId/reconciliations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listReconciliations(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.reconciliationService.listReconciliations(
      context.tenantId,
      context.factoryId,
      itemId,
      rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  @Post(':itemId/reservations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async createReservation(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: CreateInventoryReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.reservationService.createReservation(
      context.userId, context.tenantId, context.factoryId, itemId, body,
      idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get(':itemId/reservations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listReservations(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.reservationService.listReservations(
      context.tenantId, context.factoryId, itemId,
      { status, limit: rawLimit === undefined ? 50 : Number(rawLimit) },
    );
  }

  @Post(':itemId/reservations/:reservationId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async transitionReservation(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() body: TransitionInventoryReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.reservationService.transitionReservation(
      context.userId, context.tenantId, context.factoryId, itemId, reservationId,
      body, idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get(':itemId/movements')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listMovements(
    @Req() request: FactoryOsRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    return this.inventoryService.listMovements(
      context.tenantId,
      context.factoryId,
      itemId,
      limit,
    );
  }

  private requireContext(request: FactoryOsRequest): {
    userId: string;
    tenantId: string;
    factoryId: string;
    requestId: string;
    traceId: string;
  } {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException(
        'Authenticated user, tenant and factory context are required',
      );
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
