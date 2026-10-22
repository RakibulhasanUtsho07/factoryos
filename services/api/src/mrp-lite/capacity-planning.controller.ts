import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateCapacityCalendarDto } from './dto/create-capacity-calendar.dto';
import { UpdateCapacityCalendarDto } from './dto/update-capacity-calendar.dto';
import { CreateCapacityPlanDto } from './dto/create-capacity-plan.dto';
import { CapacityPlanningService } from './capacity-planning.service';

interface CapacityRequestContext {
  requestId:string; traceId:string; userId:string|null; tenantId:string|null; factoryId:string|null;
}
type CapacityRequest=Request & {factoryos?:CapacityRequestContext};

@Controller('mrp-lite')
export class CapacityPlanningController {
  constructor(private readonly service:CapacityPlanningService) {}

  @Get('capacity-calendars')
  @UseGuards(PermissionGuard) @RequirePermission('mrp.capacity.read') @RequireFactoryScope()
  listCalendars(@Req() req:CapacityRequest,@Query('start') start?:string,@Query('end') end?:string): Promise<unknown> {
    const c=this.context(req);return this.service.listCalendars(c.userId,c.tenantId,c.factoryId,start,end);
  }

  @Post('capacity-calendars')
  @UseGuards(PermissionGuard) @RequirePermission('mrp.capacity.manage') @RequireFactoryScope()
  createCalendar(@Req() req:CapacityRequest,@Body() dto:CreateCapacityCalendarDto,@Headers('idempotency-key') key?:string): Promise<unknown> {
    const c=this.context(req);return this.service.createCalendar(c.userId,c.tenantId,c.factoryId,dto,key??null,c.requestId,c.traceId);
  }

  @Put('capacity-calendars/:calendarId')
  @UseGuards(PermissionGuard) @RequirePermission('mrp.capacity.manage') @RequireFactoryScope()
  updateCalendar(@Req() req:CapacityRequest,@Param('calendarId',new ParseUUIDPipe()) calendarId:string,
    @Body() dto:UpdateCapacityCalendarDto,@Headers('idempotency-key') key?:string): Promise<unknown> {
    const c=this.context(req);return this.service.updateCalendar(c.userId,c.tenantId,c.factoryId,calendarId,dto,key??null,c.requestId,c.traceId);
  }

  @Post('capacity-plans')
  @UseGuards(PermissionGuard) @RequirePermission('mrp.capacity.write') @RequireFactoryScope()
  createPlan(@Req() req:CapacityRequest,@Body() dto:CreateCapacityPlanDto,@Headers('idempotency-key') key?:string): Promise<unknown> {
    const c=this.context(req);return this.service.createPlan(c.userId,c.tenantId,c.factoryId,dto,key??null,c.requestId,c.traceId);
  }

  @Get('capacity-plans')
  @UseGuards(PermissionGuard) @RequirePermission('mrp.capacity.read') @RequireFactoryScope()
  listPlans(@Req() req:CapacityRequest,@Query('source_mrp_plan_id') source?:string,@Query('limit') limit?:string): Promise<unknown> {
    const c=this.context(req);return this.service.listPlans(c.userId,c.tenantId,c.factoryId,source,limit===undefined?50:Number(limit));
  }

  @Get('capacity-plans/:planId')
  @UseGuards(PermissionGuard) @RequirePermission('mrp.capacity.read') @RequireFactoryScope()
  getPlan(@Req() req:CapacityRequest,@Param('planId',new ParseUUIDPipe()) planId:string): Promise<unknown> {
    const c=this.context(req);return this.service.getPlan(c.userId,c.tenantId,c.factoryId,planId);
  }

  private context(req:CapacityRequest):{userId:string;tenantId:string;factoryId:string;requestId:string;traceId:string} {
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId)throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
