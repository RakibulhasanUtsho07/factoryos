import {
  BadRequestException,
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
  Body,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CreateFinanceClosePeriodDto,
  FinanceCloseActionDto,
  FinanceWorkbenchQueryDto,
  ListFinanceClosePeriodsDto,
} from './dto/finance-workbench.dto';
import { FinanceWorkbenchService } from './finance-workbench.service';

interface FinanceWorkbenchRequestContext {
  requestId: string | null;
  traceId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FinanceWorkbenchRequest = Request & { factoryos?: FinanceWorkbenchRequestContext };

function requestContext(request: FinanceWorkbenchRequest) {
  const userId = request.factoryos?.userId ?? null;
  const tenantId = request.factoryos?.tenantId ?? null;
  const factoryId = request.factoryos?.factoryId ?? null;
  if (!userId || !tenantId || !factoryId) {
    throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
  }
  return {
    userId,
    tenantId,
    factoryId,
    eventContext: {
      requestId: request.factoryos?.requestId ?? null,
      traceId: request.factoryos?.traceId ?? null,
    },
  };
}

@Controller('finance')
export class FinanceWorkbenchController {
  constructor(private readonly service: FinanceWorkbenchService) {}

  @Get('workbench')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.workbench.read')
  @RequireFactoryScope()
  async workbench(@Req() request: FinanceWorkbenchRequest, @Query() query: FinanceWorkbenchQueryDto) {
    const ctx = requestContext(request);
    return this.service.readWorkbench(ctx.userId, ctx.tenantId, ctx.factoryId, query);
  }

  @Get('close-periods')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.close.read')
  @RequireFactoryScope()
  async listClosePeriods(
    @Req() request: FinanceWorkbenchRequest,
    @Query() query: ListFinanceClosePeriodsDto,
  ) {
    const ctx = requestContext(request);
    return this.service.listClosePeriods(ctx.userId, ctx.tenantId, ctx.factoryId, query);
  }

  @Post('close-periods')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.close.write')
  @RequireFactoryScope()
  async createClosePeriod(
    @Req() request: FinanceWorkbenchRequest,
    @Body() body: CreateFinanceClosePeriodDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = requestContext(request);
    return this.service.createClosePeriod(
      ctx.userId, ctx.tenantId, ctx.factoryId, body, key ?? null, ctx.eventContext,
    );
  }

  @Post('close-periods/:periodId/refresh')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.close.write')
  @RequireFactoryScope()
  async refreshClosePeriod(
    @Req() request: FinanceWorkbenchRequest,
    @Param('periodId', new ParseUUIDPipe()) periodId: string,
    @Body() body: FinanceCloseActionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = requestContext(request);
    return this.service.refreshClosePeriod(
      ctx.userId, ctx.tenantId, ctx.factoryId, periodId, body, key ?? null, ctx.eventContext,
    );
  }

  @Post('close-periods/:periodId/submit')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.close.submit')
  @RequireFactoryScope()
  async submitClosePeriod(
    @Req() request: FinanceWorkbenchRequest,
    @Param('periodId', new ParseUUIDPipe()) periodId: string,
    @Body() body: FinanceCloseActionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = requestContext(request);
    return this.service.submitClosePeriod(
      ctx.userId, ctx.tenantId, ctx.factoryId, periodId, body, key ?? null, ctx.eventContext,
    );
  }

  @Post('close-periods/:periodId/recall')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.close.submit')
  @RequireFactoryScope()
  async recallClosePeriod(
    @Req() request: FinanceWorkbenchRequest,
    @Param('periodId', new ParseUUIDPipe()) periodId: string,
    @Body() body: FinanceCloseActionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = requestContext(request);
    return this.service.recallClosePeriod(
      ctx.userId, ctx.tenantId, ctx.factoryId, periodId, body, key ?? null, ctx.eventContext,
    );
  }

  @Post('close-periods/:periodId/approve')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.close.approve')
  @RequireFactoryScope()
  async approveClosePeriod(
    @Req() request: FinanceWorkbenchRequest,
    @Param('periodId', new ParseUUIDPipe()) periodId: string,
    @Body() body: FinanceCloseActionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = requestContext(request);
    if (body.expected_version < 1) throw new BadRequestException('expected_version must be positive');
    return this.service.approveClosePeriod(
      ctx.userId, ctx.tenantId, ctx.factoryId, periodId, body, key ?? null, ctx.eventContext,
    );
  }
}
