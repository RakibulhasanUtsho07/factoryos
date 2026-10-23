import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CreateUtilitySourceBindingDto, CreateUtilityThresholdPolicyDto, IngestUtilitySourceEventDto,
  TransitionUtilitySourceBindingDto, TransitionUtilityThresholdPolicyDto,
} from './utilities-closure.dto';
import { TransitionUtilityEventDto } from './utilities.dto';
import { UtilitiesClosureService } from './utilities-closure.service';
import type { UtilityContext } from './utilities.service';

interface UtilityClosureRequestContext {
  requestId?: string|null; traceId?: string|null; userId: string|null; tenantId: string|null; factoryId: string|null;
}
type UtilityClosureRequest=Request&{factoryos?:UtilityClosureRequestContext};

@Controller('utilities')
export class UtilitiesClosureController {
  constructor(private readonly service:UtilitiesClosureService){}

  @Get('source-bindings')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.meters.read')
  @RequireFactoryScope()
  listBindings(@Req() req:UtilityClosureRequest,@Query('limit') limit?:string){
    return this.service.listSourceBindings(this.context(req),limit===undefined?undefined:Number(limit));
  }

  @Post('source-bindings')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.sources.manage')
  @RequireFactoryScope()
  createBinding(@Req() req:UtilityClosureRequest,@Body() dto:CreateUtilitySourceBindingDto,@Headers('idempotency-key') key?:string){
    return this.service.createSourceBinding(this.context(req),dto,key??null);
  }

  @Post('source-bindings/:bindingId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.sources.manage')
  @RequireFactoryScope()
  transitionBinding(@Req() req:UtilityClosureRequest,@Param('bindingId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionUtilitySourceBindingDto){
    return this.service.transitionSourceBinding(this.context(req),id,dto);
  }

  @Post('source-events')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.readings.capture')
  @RequireFactoryScope()
  ingestSourceEvent(@Req() req:UtilityClosureRequest,@Body() dto:IngestUtilitySourceEventDto){
    return this.service.ingestSourceEvent(this.context(req),dto);
  }

  @Get('threshold-policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.alerts.read')
  @RequireFactoryScope()
  listPolicies(@Req() req:UtilityClosureRequest,@Query('limit') limit?:string){
    return this.service.listThresholdPolicies(this.context(req),limit===undefined?undefined:Number(limit));
  }

  @Post('threshold-policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.alerts.manage')
  @RequireFactoryScope()
  createPolicy(@Req() req:UtilityClosureRequest,@Body() dto:CreateUtilityThresholdPolicyDto,@Headers('idempotency-key') key?:string){
    return this.service.createThresholdPolicy(this.context(req),dto,key??null);
  }

  @Post('threshold-policies/:policyId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.alerts.manage')
  @RequireFactoryScope()
  transitionPolicy(@Req() req:UtilityClosureRequest,@Param('policyId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionUtilityThresholdPolicyDto){
    return this.service.transitionThresholdPolicy(this.context(req),id,dto);
  }

  @Get('threshold-alerts')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.alerts.read')
  @RequireFactoryScope()
  listAlerts(@Req() req:UtilityClosureRequest,@Query('limit') limit?:string,@Query('status') status?:string){
    return this.service.listThresholdAlerts(this.context(req),limit===undefined?undefined:Number(limit),status);
  }

  @Post('threshold-alerts/:alertId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('utilities.alerts.manage')
  @RequireFactoryScope()
  transitionAlert(@Req() req:UtilityClosureRequest,@Param('alertId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionUtilityEventDto){
    return this.service.transitionThresholdAlert(this.context(req),id,dto);
  }

  private context(req:UtilityClosureRequest):UtilityContext{
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId)throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
