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
import { CancelInventoryCycleCountTaskDto } from './dto/cancel-inventory-cycle-count-task.dto';
import { CreateInventoryCycleCountSessionDto } from './dto/create-inventory-cycle-count-session.dto';
import { InventoryCycleCountSessionService } from './inventory.cycle-count-session.service';

interface CycleCountSessionRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type CycleCountSessionRequest = Request & { factoryos?: CycleCountSessionRequestContext };

@Controller('inventory/cycle-count-sessions')
export class InventoryCycleCountSessionController {
  constructor(private readonly sessionService: InventoryCycleCountSessionService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async createSession(
    @Req() request: CycleCountSessionRequest,
    @Body() body: CreateInventoryCycleCountSessionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.sessionService.createSession(
      context.userId, context.tenantId, context.factoryId, body,
      idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listSessions(
    @Req() request: CycleCountSessionRequest,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.sessionService.listSessions(
      context.userId, context.tenantId, context.factoryId,
      { status, limit: rawLimit === undefined ? 50 : Number(rawLimit) },
    );
  }

  @Get(':sessionId')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async getSession(
    @Req() request: CycleCountSessionRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ) {
    const context = this.requireContext(request);
    return this.sessionService.getSession(
      context.userId, context.tenantId, context.factoryId, sessionId,
    );
  }

  @Post(':sessionId/start')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reconcile')
  @RequireFactoryScope()
  async startSession(
    @Req() request: CycleCountSessionRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ) {
    const context = this.requireContext(request);
    return this.sessionService.startSession(
      context.userId, context.tenantId, context.factoryId, sessionId,
      context.requestId, context.traceId,
    );
  }

  @Post(':sessionId/cancel')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async cancelSession(
    @Req() request: CycleCountSessionRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() body: CancelInventoryCycleCountTaskDto,
  ) {
    const context = this.requireContext(request);
    return this.sessionService.cancelSession(
      context.userId, context.tenantId, context.factoryId, sessionId,
      body.cancellation_reason, context.requestId, context.traceId,
    );
  }

  private requireContext(request: CycleCountSessionRequest) {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Verified FactoryOS factory context is required');
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
