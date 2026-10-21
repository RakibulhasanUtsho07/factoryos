import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { UpdateInventoryAllocationPolicyDto } from './dto/update-inventory-allocation-policy.dto';
import { InventoryReservationService } from './inventory.reservation.service';

interface AllocationPolicyRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type AllocationPolicyRequest = Request & {
  factoryos?: AllocationPolicyRequestContext;
};

@Controller('inventory/allocation-policies')
export class InventoryAllocationPolicyController {
  constructor(private readonly reservationService: InventoryReservationService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listPolicies(@Req() request: AllocationPolicyRequest) {
    const context = this.requireContext(request);
    return this.reservationService.listAllocationPolicies(context.tenantId, context.factoryId);
  }

  @Put('materials/:itemId')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async updateMaterialPolicy(
    @Req() request: AllocationPolicyRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: UpdateInventoryAllocationPolicyDto,
  ) {
    const context = this.requireContext(request);
    return this.reservationService.updateAllocationPolicy(
      context.userId, context.tenantId, context.factoryId,
      { scope: 'MATERIAL', itemId }, body, context.requestId, context.traceId,
    );
  }

  @Put('sectors/:sectorCode')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async updateSectorPolicy(
    @Req() request: AllocationPolicyRequest,
    @Param('sectorCode') sectorCode: string,
    @Body() body: UpdateInventoryAllocationPolicyDto,
  ) {
    const context = this.requireContext(request);
    return this.reservationService.updateAllocationPolicy(
      context.userId, context.tenantId, context.factoryId,
      { scope: 'SECTOR', sectorCode }, body, context.requestId, context.traceId,
    );
  }

  private requireContext(request: AllocationPolicyRequest) {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory scope are required');
    }
    return {
      userId: context.userId,
      tenantId: context.tenantId,
      factoryId: context.factoryId,
      requestId: context.requestId ?? null,
      traceId: context.traceId ?? null,
    };
  }
}
