import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { UpsertInventoryReorderPolicyDto } from './dto/upsert-inventory-reorder-policy.dto';
import { InventoryReplenishmentService } from './inventory.replenishment.service';

interface ReplenishmentRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type ReplenishmentRequest = Request & {
  factoryos?: ReplenishmentRequestContext;
};

@Controller('inventory')
export class InventoryReplenishmentController {
  constructor(
    private readonly replenishmentService: InventoryReplenishmentService,
  ) {}

  @Put('items/:itemId/reorder-policy')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reorder.write')
  @RequireFactoryScope()
  async upsertPolicy(
    @Req() request: ReplenishmentRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: UpsertInventoryReorderPolicyDto,
  ) {
    const context = this.requireContext(request);
    return this.replenishmentService.upsertPolicy(
      context.userId,
      context.tenantId,
      context.factoryId,
      itemId,
      body,
      context.requestId,
      context.traceId,
    );
  }

  @Get('items/:itemId/reorder-policy')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reorder.read')
  @RequireFactoryScope()
  async getPolicy(
    @Req() request: ReplenishmentRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    const context = this.requireContext(request);
    return this.replenishmentService.getPolicy(
      context.tenantId,
      context.factoryId,
      itemId,
    );
  }

  @Get('replenishment/shortages')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reorder.read')
  @RequireFactoryScope()
  async listShortages(
    @Req() request: ReplenishmentRequest,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.replenishmentService.listShortages(
      context.tenantId,
      context.factoryId,
      rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  @Get('replenishment/recommendations')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reorder.read')
  @RequireFactoryScope()
  async listRecommendations(
    @Req() request: ReplenishmentRequest,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.replenishmentService.listRecommendations(
      context.tenantId,
      context.factoryId,
      rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  private requireContext(request: ReplenishmentRequest): {
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
