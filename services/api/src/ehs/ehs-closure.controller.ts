import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CreateEhsChemicalSdsDto, CreateEhsContractorInductionDto, CreateEhsEmergencyDrillDto,
  RecordEhsDrillAttendanceDto, RecordEhsDrillResponseDto, TransitionEhsChemicalSdsDto,
  TransitionEhsContractorInductionDto, TransitionEhsEmergencyDrillDto,
} from './ehs-closure.dto';
import { EhsClosureService } from './ehs-closure.service';
import type { EhsContext } from './ehs.service';

interface EhsClosureRequestContext {
  requestId?:string|null;traceId?:string|null;userId:string|null;tenantId:string|null;factoryId:string|null;
}
type EhsClosureRequest=Request&{factoryos?:EhsClosureRequestContext};

@Controller('ehs')
export class EhsClosureController {
  constructor(private readonly service:EhsClosureService){}

  @Get('drills')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.drills.read')
  @RequireFactoryScope()
  listDrills(@Req() req:EhsClosureRequest,@Query('limit') limit?:string,@Query('status') status?:string){
    return this.service.listDrills(this.context(req),limit===undefined?undefined:Number(limit),status);
  }

  @Post('drills')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.drills.manage')
  @RequireFactoryScope()
  createDrill(@Req() req:EhsClosureRequest,@Body() dto:CreateEhsEmergencyDrillDto,@Headers('idempotency-key') key?:string){
    return this.service.createDrill(this.context(req),dto,key??null);
  }

  @Post('drills/:drillId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.drills.manage')
  @RequireFactoryScope()
  transitionDrill(@Req() req:EhsClosureRequest,@Param('drillId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsEmergencyDrillDto){
    return this.service.transitionDrill(this.context(req),id,dto);
  }

  @Get('drills/:drillId/attendance')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.drills.read')
  @RequireFactoryScope()
  listAttendance(@Req() req:EhsClosureRequest,@Param('drillId',new ParseUUIDPipe()) id:string,@Query('limit') limit?:string){
    return this.service.listDrillAttendance(this.context(req),id,limit===undefined?undefined:Number(limit));
  }

  @Post('drills/:drillId/attendance')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.drills.manage')
  @RequireFactoryScope()
  recordAttendance(@Req() req:EhsClosureRequest,@Param('drillId',new ParseUUIDPipe()) id:string,@Body() dto:RecordEhsDrillAttendanceDto,@Headers('idempotency-key') key?:string){
    return this.service.recordDrillAttendance(this.context(req),id,dto,key??null);
  }

  @Get('drills/:drillId/responses')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.drills.read')
  @RequireFactoryScope()
  listResponses(@Req() req:EhsClosureRequest,@Param('drillId',new ParseUUIDPipe()) id:string,@Query('limit') limit?:string){
    return this.service.listDrillResponses(this.context(req),id,limit===undefined?undefined:Number(limit));
  }

  @Post('drills/:drillId/responses')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.drills.manage')
  @RequireFactoryScope()
  recordResponse(@Req() req:EhsClosureRequest,@Param('drillId',new ParseUUIDPipe()) id:string,@Body() dto:RecordEhsDrillResponseDto,@Headers('idempotency-key') key?:string){
    return this.service.recordDrillResponse(this.context(req),id,dto,key??null);
  }

  @Get('chemicals')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.chemicals.read')
  @RequireFactoryScope()
  listChemicalSds(@Req() req:EhsClosureRequest,@Query('limit') limit?:string,@Query('status') status?:string){
    return this.service.listChemicalSds(this.context(req),limit===undefined?undefined:Number(limit),status);
  }

  @Post('chemicals')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.chemicals.manage')
  @RequireFactoryScope()
  createChemicalSds(@Req() req:EhsClosureRequest,@Body() dto:CreateEhsChemicalSdsDto,@Headers('idempotency-key') key?:string){
    return this.service.createChemicalSds(this.context(req),dto,key??null);
  }

  @Post('chemicals/:chemicalId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.chemicals.manage')
  @RequireFactoryScope()
  transitionChemicalSds(@Req() req:EhsClosureRequest,@Param('chemicalId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsChemicalSdsDto){
    return this.service.transitionChemicalSds(this.context(req),id,dto);
  }

  @Get('contractors/inductions')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.contractors.read')
  @RequireFactoryScope()
  listContractorInductions(@Req() req:EhsClosureRequest,@Query('limit') limit?:string,@Query('status') status?:string){
    return this.service.listContractorInductions(this.context(req),limit===undefined?undefined:Number(limit),status);
  }

  @Post('contractors/inductions')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.contractors.manage')
  @RequireFactoryScope()
  createContractorInduction(@Req() req:EhsClosureRequest,@Body() dto:CreateEhsContractorInductionDto,@Headers('idempotency-key') key?:string){
    return this.service.createContractorInduction(this.context(req),dto,key??null);
  }

  @Post('contractors/inductions/:inductionId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('ehs.contractors.manage')
  @RequireFactoryScope()
  transitionContractorInduction(@Req() req:EhsClosureRequest,@Param('inductionId',new ParseUUIDPipe()) id:string,@Body() dto:TransitionEhsContractorInductionDto){
    return this.service.transitionContractorInduction(this.context(req),id,dto);
  }

  private context(req:EhsClosureRequest):EhsContext{
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId)throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
