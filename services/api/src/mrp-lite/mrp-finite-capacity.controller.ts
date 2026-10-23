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
import { CreateMrpCapacityCalendarDto } from './dto/create-mrp-capacity-calendar.dto';
import { CreateMrpCapacityPlanDto } from './dto/create-mrp-capacity-plan.dto';
import { UpdateMrpCapacityCalendarDto } from './dto/update-mrp-capacity-calendar.dto';
import { MrpFiniteCapacityService } from './mrp-finite-capacity.service';

interface MrpCapacityRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type MrpCapacityRequest = Request & { factoryos?: MrpCapacityRequestContext };

@Controller('mrp-lite')
export class MrpFiniteCapacityController {
  constructor(private readonly service: MrpFiniteCapacityService) {}

  @Get('capacity-calendar')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.capacity.read')
  @RequireFactoryScope()
  async listCalendar(
    @Req() request: MrpCapacityRequest,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(request);
    return this.service.listCapacityCalendar(
      c.userId, c.tenantId, c.factoryId, fromDate ?? '', toDate ?? '',
      rawLimit === undefined ? 500 : Number(rawLimit),
    );
  }

  @Post('capacity-calendar')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.capacity.write')
  @RequireFactoryScope()
  async createCalendarEntry(
    @Req() request: MrpCapacityRequest,
    @Body() body: CreateMrpCapacityCalendarDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<unknown> {
    const c = this.context(request);
    return this.service.createCapacityCalendarEntry(
      c.userId, c.tenantId, c.factoryId, body, key ?? null, c.requestId, c.traceId,
    );
  }

  @Post('capacity-calendar/:calendarId/update')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.capacity.write')
  @RequireFactoryScope()
  async updateCalendarEntry(
    @Req() request: MrpCapacityRequest,
    @Param('calendarId', new ParseUUIDPipe()) calendarId: string,
    @Body() body: UpdateMrpCapacityCalendarDto,
  ): Promise<unknown> {
    const c = this.context(request);
    return this.service.updateCapacityCalendarEntry(
      c.userId, c.tenantId, c.factoryId, calendarId, body, c.requestId, c.traceId,
    );
  }

  @Post('runs/:runId/capacity-plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.capacity.plan')
  @RequireFactoryScope()
  async createCapacityPlan(
    @Req() request: MrpCapacityRequest,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body() body: CreateMrpCapacityPlanDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<unknown> {
    const c = this.context(request);
    return this.service.createCapacityPlan(
      c.userId, c.tenantId, c.factoryId, runId, body, key ?? null, c.requestId, c.traceId,
    );
  }

  @Get('runs/:runId/capacity-plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.capacity.read')
  @RequireFactoryScope()
  async listCapacityPlans(
    @Req() request: MrpCapacityRequest,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(request);
    return this.service.listCapacityPlans(
      c.userId, c.tenantId, c.factoryId, runId, rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  @Get('capacity-plans/:capacityPlanId')
  @UseGuards(PermissionGuard)
  @RequirePermission('mrp.capacity.read')
  @RequireFactoryScope()
  async getCapacityPlan(
    @Req() request: MrpCapacityRequest,
    @Param('capacityPlanId', new ParseUUIDPipe()) capacityPlanId: string,
  ): Promise<unknown> {
    const c = this.context(request);
    return this.service.getCapacityPlan(c.userId, c.tenantId, c.factoryId, capacityPlanId);
  }

  private context(request: MrpCapacityRequest): {
    requestId: string;
    traceId: string;
    userId: string;
    tenantId: string;
    factoryId: string;
  } {
    const c = request.factoryos;
    if (!c?.userId || !c.tenantId || !c.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      requestId: c.requestId,
      traceId: c.traceId,
      userId: c.userId,
      tenantId: c.tenantId,
      factoryId: c.factoryId,
    };
  }
}
