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
import { CreateProductChangeOrderDto } from './dto/create-product-change-order.dto';
import { ProductChangeOrderActionDto } from './dto/product-change-order-action.dto';
import { ProductChangeOrdersService } from './product-change-orders.service';

interface ProductChangeOrderRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type ProductChangeOrderRequest = Request & { factoryos?: ProductChangeOrderRequestContext };

@Controller('products')
export class ProductChangeOrdersController {
  constructor(private readonly service: ProductChangeOrdersService) {}

  @Get(':productId/change-orders')
  @UseGuards(PermissionGuard)
  @RequirePermission('products.eco.read')
  @RequireFactoryScope()
  list(
    @Req() req: ProductChangeOrderRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Query('limit') limit?: string,
  ) {
    const c = this.context(req);
    return this.service.list(c.userId, c.tenantId, c.factoryId, productId, limit === undefined ? 50 : Number(limit));
  }

  @Post(':productId/change-orders')
  @UseGuards(PermissionGuard)
  @RequirePermission('products.eco.write')
  @RequireFactoryScope()
  create(
    @Req() req: ProductChangeOrderRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: CreateProductChangeOrderDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const c = this.context(req);
    return this.service.create(c.userId, c.tenantId, c.factoryId, productId, dto, key ?? null, c.requestId, c.traceId);
  }

  @Get(':productId/change-orders/:changeOrderId')
  @UseGuards(PermissionGuard)
  @RequirePermission('products.eco.read')
  @RequireFactoryScope()
  detail(
    @Req() req: ProductChangeOrderRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('changeOrderId', new ParseUUIDPipe()) changeOrderId: string,
  ) {
    const c = this.context(req);
    return this.service.detail(c.userId, c.tenantId, c.factoryId, productId, changeOrderId);
  }

  @Post(':productId/change-orders/:changeOrderId/submit')
  @UseGuards(PermissionGuard)
  @RequirePermission('products.eco.write')
  @RequireFactoryScope()
  submit(
    @Req() req: ProductChangeOrderRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('changeOrderId', new ParseUUIDPipe()) changeOrderId: string,
    @Body() dto: ProductChangeOrderActionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const c = this.context(req);
    return this.service.submit(c.userId, c.tenantId, c.factoryId, productId, changeOrderId, dto, key ?? null, c.requestId, c.traceId);
  }

  @Post(':productId/change-orders/:changeOrderId/approve')
  @UseGuards(PermissionGuard)
  @RequirePermission('products.eco.approve')
  @RequireFactoryScope()
  approve(
    @Req() req: ProductChangeOrderRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('changeOrderId', new ParseUUIDPipe()) changeOrderId: string,
    @Body() dto: ProductChangeOrderActionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const c = this.context(req);
    return this.service.approve(c.userId, c.tenantId, c.factoryId, productId, changeOrderId, dto, key ?? null, c.requestId, c.traceId);
  }

  @Post(':productId/change-orders/:changeOrderId/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('products.eco.approve')
  @RequireFactoryScope()
  reject(
    @Req() req: ProductChangeOrderRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('changeOrderId', new ParseUUIDPipe()) changeOrderId: string,
    @Body() dto: ProductChangeOrderActionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const c = this.context(req);
    return this.service.reject(c.userId, c.tenantId, c.factoryId, productId, changeOrderId, dto, key ?? null, c.requestId, c.traceId);
  }

  private context(req: ProductChangeOrderRequest): {
    userId: string;
    tenantId: string;
    factoryId: string;
    requestId: string;
    traceId: string;
  } {
    const c = req.factoryos;
    if (!c?.userId || !c.tenantId || !c.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId: c.userId,
      tenantId: c.tenantId,
      factoryId: c.factoryId,
      requestId: c.requestId,
      traceId: c.traceId,
    };
  }
}
