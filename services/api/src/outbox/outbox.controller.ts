import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';

import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';

import {
  OutboxDlqService,
} from './outbox-dlq.service';

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

type FactoryOsRequest =
  Request & {
    factoryos?:
      FactoryOsRequestContext;

    user?: {
      userId: string;
      tenantId: string;
      membershipId: string;
    };
  };

@Controller('outbox')
export class OutboxController {
  constructor(
    private readonly outboxDlqService:
      OutboxDlqService,
  ) {}

  // ============================================================
  // GET /api/outbox/quarantined
  // ============================================================

  @Get('quarantined')
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'outbox.dlq.read',
  )
  async listQuarantined(
    @Req()
    request: FactoryOsRequest,
    @Query('factory_id')
    factoryId?: string,
    @Query('limit')
    limit = '50',
    @Query('offset')
    offset = '0',
  ) {
    const context =
      request.factoryos;

    const tenantId =
      context?.tenantId ??
      request.user?.tenantId ??
      null;

    if (!tenantId) {
      throw new UnauthorizedException(
        'Authenticated tenant context is missing',
      );
    }

    return this.outboxDlqService.listQuarantined(
      tenantId,
      {
        factoryId:
          factoryId ??
          null,

        requestFactoryId:
          context?.factoryId ??
          null,

        limit:
          Number(limit),

        offset:
          Number(offset),
      },
    );
  }

  // ============================================================
  // POST /api/outbox/:eventId/replay
  // ============================================================

  @Post(':eventId/replay')
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'outbox.dlq.replay',
  )
  async replay(
    @Param(
      'eventId',
      new ParseUUIDPipe(),
    )
    eventId: string,

    @Req()
    request: FactoryOsRequest,
  ) {
    const context =
      request.factoryos;

    const tenantId =
      context?.tenantId ??
      request.user?.tenantId ??
      null;

    const actorUserId =
      context?.userId ??
      request.user?.userId ??
      null;

    if (
      !tenantId ||
      !actorUserId
    ) {
      throw new UnauthorizedException(
        'Authenticated user context is missing',
      );
    }

    return this.outboxDlqService.replay({
      tenantId,
      actorUserId,
      eventId,
      requestId:
        context?.requestId ??
        null,
      traceId:
        context?.traceId ??
        null,
      requestFactoryId:
        context?.factoryId ??
        null,
    });
  }
}