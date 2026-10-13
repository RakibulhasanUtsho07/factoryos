import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
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

import {
  CreateInventoryItemDto,
  CreateInventoryMovementDto,
  ListInventoryBalancesDto,
  ListInventoryItemsDto,
  ListInventoryMovementsDto,
} from './inventory.dto';
import { InventoryService } from './inventory.service';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type FactoryOsRequest = Request & { factoryos?: FactoryOsRequestContext };

@Controller('v1/inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('items')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async createItem(@Req() request: FactoryOsRequest, @Body() body: CreateInventoryItemDto): Promise<unknown> {
    const context = this.requireContext(request);
    return this.inventoryService.createItem(
      context.userId, context.tenantId, context.factoryId, body, context.requestId, context.traceId,
    );
  }

  @Get('items')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listItems(@Req() request: FactoryOsRequest, @Query() query: ListInventoryItemsDto): Promise<unknown> {
    const context = this.requireContext(request);
    return this.inventoryService.listItems(context.tenantId, context.factoryId, query);
  }

  @Post('movements')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async recordMovement(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateInventoryMovementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const context = this.requireContext(request);
    if (idempotencyKey === undefined || idempotencyKey === null) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return this.inventoryService.createMovement(
      context.userId, context.tenantId, context.factoryId, body,
      idempotencyKey, context.requestId, context.traceId,
    );
  }

  @Get('balances')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listBalances(@Req() request: FactoryOsRequest, @Query() query: ListInventoryBalancesDto): Promise<unknown> {
    const context = this.requireContext(request);
    return this.inventoryService.listBalances(context.tenantId, context.factoryId, query);
  }

  @Get('movements')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listMovements(@Req() request: FactoryOsRequest, @Query() query: ListInventoryMovementsDto): Promise<unknown> {
    const context = this.requireContext(request);
    return this.inventoryService.listMovements(context.tenantId, context.factoryId, query);
  }

  private requireContext(request: FactoryOsRequest): {
    userId: string; tenantId: string; factoryId: string;
    requestId: string | null; traceId: string | null;
  } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId,
      tenantId,
      factoryId,
      requestId: request.factoryos?.requestId ?? null,
      traceId: request.factoryos?.traceId ?? null,
    };
  }
}
