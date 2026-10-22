import {
  Controller,
  Get,
  Headers,
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
import { OutboxBusDlqService } from './outbox-bus-dlq.service';

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
    private readonly outboxDlqService: OutboxDlqService,
    private readonly outboxBusDlqService: OutboxBusDlqService,
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
  // GET /api/outbox/bus-dead-letters
  // ============================================================

  @Get('bus-dead-letters')
  @UseGuards(PermissionGuard)
  @RequirePermission('outbox.dlq.read')
  async listBusDeadLetters(
    @Req() request: FactoryOsRequest,
    @Query('factory_id') factoryId?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    const context = request.factoryos;
    const tenantId = context?.tenantId ?? request.user?.tenantId ?? null;
    if (!tenantId) throw new UnauthorizedException('Authenticated tenant context is missing');
    return this.outboxBusDlqService.listDeadLetters(tenantId, {
      factoryId: factoryId ?? null,
      requestFactoryId: context?.factoryId ?? null,
      limit: Number(limit),
      offset: Number(offset),
    });
  }

  // ============================================================
  // POST /api/outbox/bus-dead-letters/:deadLetterId/redrive
  // ============================================================

  @Post('bus-dead-letters/:deadLetterId/redrive')
  @UseGuards(PermissionGuard)
  @RequirePermission('outbox.dlq.replay')
  async redriveBusDeadLetter(
    @Param('deadLetterId', new ParseUUIDPipe()) deadLetterId: string,
    @Req() request: FactoryOsRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = request.factoryos;
    const tenantId = context?.tenantId ?? request.user?.tenantId ?? null;
    const actorUserId = context?.userId ?? request.user?.userId ?? null;
    if (!tenantId || !actorUserId) {
      throw new UnauthorizedException('Authenticated user and tenant context are required');
    }
    return this.outboxBusDlqService.redrive({
      tenantId,
      actorUserId,
      deadLetterId,
      idempotencyKey: idempotencyKey ?? null,
      requestId: context?.requestId ?? null,
      traceId: context?.traceId ?? null,
      requestFactoryId: context?.factoryId ?? null,
    });
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
    @Headers('idempotency-key') idempotencyKey?: string,
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
      idempotencyKey: idempotencyKey ?? null,
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