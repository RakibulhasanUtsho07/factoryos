import {
  Body, Controller, Headers, Post, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateRfidReadBatchDto, SyncOfflineBatchDto } from './dto/wms-mobile.dto';
import { WmsMobileService } from './wms.mobile.service';

interface WmsMobileRequestContext {
  requestId?: string | null;
  traceId?: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type WmsMobileRequest = Request & { factoryos?: WmsMobileRequestContext };

@Controller('wms/mobile')
export class WmsMobileController {
  constructor(private readonly wmsMobileService: WmsMobileService) {}

  @Post('offline-sync/batches')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reconcile')
  @RequireFactoryScope()
  async syncOfflineBatch(@Req() request: WmsMobileRequest, @Body() body: SyncOfflineBatchDto) {
    const context = this.requireContext(request);
    return this.wmsMobileService.syncOfflineBatch(
      context.userId, context.tenantId, context.factoryId, body,
      context.requestId, context.traceId,
    );
  }

  @Post('rfid/read-batches')
  @UseGuards(PermissionGuard)
  @RequirePermission('traceability.write')
  @RequireFactoryScope()
  async ingestRfidReadBatch(
    @Req() request: WmsMobileRequest,
    @Body() body: CreateRfidReadBatchDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.wmsMobileService.ingestRfidReadBatch(
      context.userId, context.tenantId, context.factoryId, body,
      idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  private requireContext(request: WmsMobileRequest) {
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
