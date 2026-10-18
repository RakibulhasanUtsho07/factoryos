import {
  BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CreateEhsCorrectiveActionDto, CreateEhsIncidentDto, CreateEhsPermitDto, ListEhsQueryDto,
  TransitionEhsCorrectiveActionDto, TransitionEhsIncidentDto, TransitionEhsPermitDto,
} from './ehs.dto';
import { EhsContext, EhsService } from './ehs.service';

interface EhsRequestContext {
  requestId?:string|null;traceId?:string|null;userId:string|null;tenantId:string|null;factoryId:string|null;
}
type EhsRequest=Request&{factoryos?:EhsRequestContext};

@Controller('ehs')
export class EhsController{
  constructor(private readonly service:EhsService){}

  @Get('permits')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.permits.read')
  @RequireFactoryScope()
  listPermits(@Req() req:EhsRequest,@Query() query:ListEhsQueryDto){return this.service.listPermits(this.context(req),query);}

  @Post('permits')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.permits.manage')
  @RequireFactoryScope()
  createPermit(@Req() req:EhsRequest,@Body() dto:CreateEhsPermitDto,@Headers('idempotency-key') key?:string){
    return this.service.createPermit(this.context(req),dto,key??null);
  }

  @Post('permits/:permitId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.permits.execute')
  @RequireFactoryScope()
  transitionPermit(@Req() req:EhsRequest,@Param('permitId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsPermitDto){
    if(dto.action==='APPROVE'||dto.action==='REJECT')throw new BadRequestException('Use the independent permit decision endpoint for approve/reject');
    return this.service.transitionPermit(this.context(req),id,dto);
  }

  @Post('permits/:permitId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.permits.approve')
  @RequireFactoryScope()
  decidePermit(@Req() req:EhsRequest,@Param('permitId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsPermitDto){
    if(dto.action!=='APPROVE'&&dto.action!=='REJECT')throw new BadRequestException('Decision action must be APPROVE or REJECT');
    return this.service.transitionPermit(this.context(req),id,dto);
  }

  @Get('incidents')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.incidents.read')
  @RequireFactoryScope()
  listIncidents(@Req() req:EhsRequest,@Query() query:ListEhsQueryDto){return this.service.listIncidents(this.context(req),query);}

  @Post('incidents')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.incidents.report')
  @RequireFactoryScope()
  createIncident(@Req() req:EhsRequest,@Body() dto:CreateEhsIncidentDto,@Headers('idempotency-key') key?:string){
    return this.service.createIncident(this.context(req),dto,key??null);
  }

  @Post('incidents/:incidentId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.incidents.manage')
  @RequireFactoryScope()
  transitionIncident(@Req() req:EhsRequest,@Param('incidentId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsIncidentDto){
    return this.service.transitionIncident(this.context(req),id,dto);
  }

  @Get('incidents/:incidentId/corrective-actions')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.incidents.read')
  @RequireFactoryScope()
  listActions(@Req() req:EhsRequest,@Param('incidentId',new ParseUUIDPipe()) id:string,@Query('limit') limit?:string){
    return this.service.listCorrectiveActions(this.context(req),id,limit===undefined?undefined:Number(limit));
  }

  @Post('corrective-actions')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.incidents.manage')
  @RequireFactoryScope()
  createAction(@Req() req:EhsRequest,@Body() dto:CreateEhsCorrectiveActionDto,@Headers('idempotency-key') key?:string){
    return this.service.createCorrectiveAction(this.context(req),dto,key??null);
  }

  @Post('corrective-actions/:actionId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.incidents.manage')
  @RequireFactoryScope()
  transitionAction(@Req() req:EhsRequest,@Param('actionId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsCorrectiveActionDto){
    if(dto.action==='VERIFY')throw new BadRequestException('Use the independent corrective-action verification endpoint');
    return this.service.transitionCorrectiveAction(this.context(req),id,dto);
  }

  @Post('corrective-actions/:actionId/verify')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.corrective_actions.verify')
  @RequireFactoryScope()
  verifyAction(@Req() req:EhsRequest,@Param('actionId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsCorrectiveActionDto){
    if(dto.action!=='VERIFY')throw new BadRequestException('Action must be VERIFY');
    return this.service.transitionCorrectiveAction(this.context(req),id,dto);
  }

  private context(req:EhsRequest):EhsContext{
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId)throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
