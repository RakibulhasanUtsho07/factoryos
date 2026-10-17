import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateMrpLiteRunDto } from './dto/create-mrp-lite-run.dto';
import { MrpLiteService } from './mrp-lite.service';

interface MrpLiteRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type MrpLiteRequest = Request & { factoryos?: MrpLiteRequestContext };

@Controller('mrp-lite')
export class MrpLiteController {
  constructor(private readonly service: MrpLiteService) {}

  @Post('runs')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.write')
  @RequireFactoryScope()
  createRun(
    @Req() request: MrpLiteRequest,
    @Body() body: CreateMrpLiteRunDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.context(request);
    return this.service.createRun(
      context.userId, context.tenantId, context.factoryId, body,
      idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get('runs')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.read')
  @RequireFactoryScope()
  listRuns(@Req() request: MrpLiteRequest, @Query('limit') rawLimit?: string) {
    const context = this.context(request);
    return this.service.listRuns(
      context.userId, context.tenantId, context.factoryId,
      rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  @Get('runs/:runId')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.read')
  @RequireFactoryScope()
  getRun(
    @Req() request: MrpLiteRequest,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ) {
    const context = this.context(request);
    return this.service.getRun(context.userId, context.tenantId, context.factoryId, runId);
  }

  private context(request: MrpLiteRequest): {
    userId: string; tenantId: string; factoryId: string; requestId: string; traceId: string;
  } {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
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
