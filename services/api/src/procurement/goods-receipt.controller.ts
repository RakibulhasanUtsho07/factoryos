import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateGoodsReceiptDto } from './dto/create-goods-receipt.dto';
import { GoodsReceiptService } from './goods-receipt.service';

interface GoodsReceiptRequestContext {
  requestId: string | null;
  traceId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type GoodsReceiptRequest = Request & { factoryos?: GoodsReceiptRequestContext };

function requireGoodsReceiptContext(request: GoodsReceiptRequest) {
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

@Controller()
export class GoodsReceiptsController {
  constructor(private readonly goodsReceiptService: GoodsReceiptService) {}

  @Post('purchase-orders/:purchaseOrderId/goods-receipts')
  @UseGuards(PermissionGuard)
  @RequirePermission('goods_receipts.write')
  @RequireFactoryScope()
  async post(
    @Req() request: GoodsReceiptRequest,
    @Param('purchaseOrderId', new ParseUUIDPipe()) purchaseOrderId: string,
    @Body() body: CreateGoodsReceiptDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = requireGoodsReceiptContext(request);
    return this.goodsReceiptService.postGoodsReceipt(
      c.userId, c.tenantId, c.factoryId, purchaseOrderId, body,
      idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Get('purchase-orders/:purchaseOrderId/goods-receipts')
  @UseGuards(PermissionGuard)
  @RequirePermission('goods_receipts.read')
  @RequireFactoryScope()
  async listForPurchaseOrder(
    @Req() request: GoodsReceiptRequest,
    @Param('purchaseOrderId', new ParseUUIDPipe()) purchaseOrderId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const c = requireGoodsReceiptContext(request);
    return this.goodsReceiptService.listGoodsReceipts(
      c.userId, c.tenantId, c.factoryId, purchaseOrderId,
      rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  @Get('goods-receipts/:receiptId')
  @UseGuards(PermissionGuard)
  @RequirePermission('goods_receipts.read')
  @RequireFactoryScope()
  async getById(
    @Req() request: GoodsReceiptRequest,
    @Param('receiptId', new ParseUUIDPipe()) receiptId: string,
  ) {
    const c = requireGoodsReceiptContext(request);
    return this.goodsReceiptService.getGoodsReceipt(c.userId, c.tenantId, c.factoryId, receiptId);
  }
}
