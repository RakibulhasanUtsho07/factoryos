import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CreateUtilityEventDto, CreateUtilityMeterDto, ListUtilityMetersQueryDto,
  ListUtilityReadingsQueryDto, RecordUtilityReadingDto, TransitionUtilityEventDto,
  CreateUtilityWorkOrderCostAllocationDto, ReverseUtilityWorkOrderCostAllocationDto,
} from './utilities.dto';
import { UtilityContext, UtilitiesService } from './utilities.service';
import { UtilityWorkOrderCostAllocationService } from './utility-work-order-cost-allocation.service';

interface UtilityRequestContext {
  requestId?: string | null;
  traceId?: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type UtilityRequest=Request & {factoryos?:UtilityRequestContext};

@Controller('utilities')
export class UtilitiesController {
  constructor(private readonly service:UtilitiesService,private readonly workOrderCostAllocationService:UtilityWorkOrderCostAllocationService){}

  @Get('meters')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.meters.read')
  @RequireFactoryScope()
  listMeters(@Req() req:UtilityRequest,@Query() query:ListUtilityMetersQueryDto){
    return this.service.listMeters(this.context(req),query);
  }

  @Post('meters')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.meters.manage')
  @RequireFactoryScope()
  createMeter(@Req() req:UtilityRequest,@Body() dto:CreateUtilityMeterDto,@Headers('idempotency-key') key?:string){
    return this.service.createMeter(this.context(req),dto,key??null);
  }

  @Get('meters/:meterId/readings')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.readings.read')
  @RequireFactoryScope()
  listReadings(
    @Req() req:UtilityRequest,
    @Param('meterId',new ParseUUIDPipe()) meterId:string,
    @Query() query:ListUtilityReadingsQueryDto,
  ){
    return this.service.listReadings(this.context(req),meterId,query);
  }

  @Post('meters/:meterId/readings')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.readings.capture')
  @RequireFactoryScope()
  recordReading(
    @Req() req:UtilityRequest,
    @Param('meterId',new ParseUUIDPipe()) meterId:string,
    @Body() dto:RecordUtilityReadingDto,
    @Headers('idempotency-key') key?:string,
  ){
    return this.service.recordReading(this.context(req),meterId,dto,key??null);
  }

  @Get('meters/:meterId/readings/:readingId/work-order-cost-allocations')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.readings.read')
  @RequireFactoryScope()
  listWorkOrderCostAllocations(
    @Req() req:UtilityRequest,
    @Param('meterId',new ParseUUIDPipe()) meterId:string,
    @Param('readingId',new ParseUUIDPipe()) readingId:string,
  ){
    return this.workOrderCostAllocationService.list(this.context(req),meterId,readingId);
  }

  @Post('meters/:meterId/readings/:readingId/work-order-cost-allocations')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.readings.capture')
  @RequireFactoryScope()
  allocateWorkOrderCost(
    @Req() req:UtilityRequest,
    @Param('meterId',new ParseUUIDPipe()) meterId:string,
    @Param('readingId',new ParseUUIDPipe()) readingId:string,
    @Body() dto:CreateUtilityWorkOrderCostAllocationDto,
    @Headers('idempotency-key') key?:string,
  ){
    return this.workOrderCostAllocationService.allocate(this.context(req),meterId,readingId,dto,key??null);
  }

  @Post('meters/:meterId/readings/:readingId/work-order-cost-allocations/:allocationId/reverse')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.readings.capture')
  @RequireFactoryScope()
  reverseWorkOrderCostAllocation(
    @Req() req:UtilityRequest,
    @Param('meterId',new ParseUUIDPipe()) meterId:string,
    @Param('readingId',new ParseUUIDPipe()) readingId:string,
    @Param('allocationId',new ParseUUIDPipe()) allocationId:string,
    @Body() dto:ReverseUtilityWorkOrderCostAllocationDto,
    @Headers('idempotency-key') key?:string,
  ){
    return this.workOrderCostAllocationService.reverse(this.context(req),meterId,readingId,allocationId,dto,key??null);
  }

  @Get('events')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.events.read')
  @RequireFactoryScope()
  listEvents(@Req() req:UtilityRequest,@Query('limit') limit?:string,@Query('status') status?:string){
    return this.service.listEvents(this.context(req),limit===undefined?undefined:Number(limit),status);
  }

  @Post('events')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.events.manage')
  @RequireFactoryScope()
  createEvent(@Req() req:UtilityRequest,@Body() dto:CreateUtilityEventDto,@Headers('idempotency-key') key?:string){
    return this.service.createEvent(this.context(req),dto,key??null);
  }

  @Post('events/:eventId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.events.manage')
  @RequireFactoryScope()
  transitionEvent(
    @Req() req:UtilityRequest,
    @Param('eventId',new ParseUUIDPipe()) eventId:string,
    @Body() dto:TransitionUtilityEventDto,
  ){
    return this.service.transitionEvent(this.context(req),eventId,dto);
  }

  private context(req:UtilityRequest):UtilityContext{
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId)throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
