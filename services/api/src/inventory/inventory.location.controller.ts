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
import { CreateInventoryLocationDto } from './dto/create-inventory-location.dto';
import { TransferInventoryLocationDto } from './dto/transfer-inventory-location.dto';
import { InventoryLocationService } from './inventory.location.service';

interface InventoryLocationRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type InventoryLocationRequest = Request & {
  factoryos?: InventoryLocationRequestContext;
};

@Controller('inventory')
export class InventoryLocationController {
  constructor(
    private readonly locationService: InventoryLocationService,
  ) {}

  @Post('locations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async createLocation(
    @Req() request: InventoryLocationRequest,
    @Body() body: CreateInventoryLocationDto,
  ) {
    const context = this.requireContext(request);
    return this.locationService.createLocation(
      context.userId, context.tenantId, context.factoryId,
      body, context.requestId, context.traceId,
    );
  }

  @Get('locations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listLocations(
    @Req() request: InventoryLocationRequest,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.locationService.listLocations(
      context.tenantId, context.factoryId,
      rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  @Get('items/:itemId/locations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listItemLocationBalances(
    @Req() request: InventoryLocationRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.locationService.listItemBalances(
      context.tenantId, context.factoryId, itemId,
      rawLimit === undefined ? 100 : Number(rawLimit),
    );
  }

  @Post('items/:itemId/location-transfers')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async transferStock(
    @Req() request: InventoryLocationRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: TransferInventoryLocationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.locationService.transferStock(
      context.userId, context.tenantId, context.factoryId,
      itemId, body, idempotencyKey ?? null,
      context.requestId, context.traceId,
    );
  }

  @Get('items/:itemId/location-transfers')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listLocationTransfers(
    @Req() request: InventoryLocationRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.locationService.listTransfers(
      context.tenantId, context.factoryId, itemId,
      rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  private requireContext(request: InventoryLocationRequest): {
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
