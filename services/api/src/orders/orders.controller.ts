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
import { ListOrdersDto } from './dto/list-orders.dto';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

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

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
  ) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('orders.write')
  @RequireFactoryScope()
  async create(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateOrderDto,
    @Headers('idempotency-key')
    idempotencyKey?: string,
  ) {
    const userId =
      request.factoryos?.userId ?? null;

    const tenantId =
      request.factoryos?.tenantId ?? null;

    const requestId =
      request.factoryos?.requestId ?? null;

    const traceId =
      request.factoryos?.traceId ?? null;

    if (
      !userId ||
      !tenantId
    ) {
      throw new UnauthorizedException(
        'Authenticated user context is missing',
      );
    }

    return this.ordersService.createOrder(
      userId,
      tenantId,
      body,
      requestId,
      traceId,
      idempotencyKey ?? null,
    );
  }
    @Post(':orderId/status')
  @UseGuards(PermissionGuard)
  @RequirePermission('orders.write')
  @RequireFactoryScope()
  async transitionStatus(
    @Req() request: FactoryOsRequest,
    @Param(
      'orderId',
      new ParseUUIDPipe(),
    )
    orderId: string,
    @Body()
    body: import('./dto/transition-order.dto').TransitionOrderDto,
  ) {
    const userId =
      request.factoryos?.userId ??
      null;

    const tenantId =
      request.factoryos?.tenantId ??
      null;

    const requestId =
      request.factoryos?.requestId ??
      null;

    const traceId =
      request.factoryos?.traceId ??
      null;

    if (
      !userId ||
      !tenantId
    ) {
      throw new UnauthorizedException(
        'Authenticated user context is missing',
      );
    }

    return this.ordersService.transitionOrderStatus(
      userId,
      tenantId,
      orderId,
      body.target_status,
      requestId,
      traceId,
    );
  }
    @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('orders.read')
  @RequireFactoryScope()
  async list(
    @Req() request: FactoryOsRequest,
    @Query() query: ListOrdersDto,
  ) {
    const tenantId =
      request.factoryos?.tenantId ??
      null;

    const factoryId =
      request.factoryos?.factoryId ??
      null;

    if (
      !tenantId ||
      !factoryId
    ) {
      throw new UnauthorizedException(
        'Authenticated tenant/factory context is missing',
      );
    }

    return this.ordersService.listOrders(
      tenantId,
      factoryId,
      query,
    );
  }

  @Get(':orderId')
  @UseGuards(PermissionGuard)
  @RequirePermission('orders.read')
  @RequireFactoryScope()
  async getById(
    @Req() request: FactoryOsRequest,
    @Param(
      'orderId',
      new ParseUUIDPipe(),
    )
    orderId: string,
  ) {
    const tenantId =
      request.factoryos?.tenantId ??
      null;

    const factoryId =
      request.factoryos?.factoryId ??
      null;

    if (
      !tenantId ||
      !factoryId
    ) {
      throw new UnauthorizedException(
        'Authenticated tenant/factory context is missing',
      );
    }

    return this.ordersService.getOrderById(
      tenantId,
      factoryId,
      orderId,
    );
  }
}