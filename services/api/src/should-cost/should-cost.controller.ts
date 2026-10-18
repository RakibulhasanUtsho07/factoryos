import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, ForbiddenException, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateShouldCostAssessmentDto, CreateShouldCostProfileDto, ListShouldCostAssessmentsDto, ListShouldCostProfilesDto, TransitionShouldCostProfileDto } from './dto/should-cost.dto';
import { ShouldCostService } from './should-cost.service';
interface ShouldCostRequestContext { requestId:string|null; traceId:string|null; userId:string|null; tenantId:string|null; factoryId:string|null; }
type ShouldCostRequest=Request&{factoryos?:ShouldCostRequestContext};
function context(request:ShouldCostRequest) {
 const userId=request.factoryos?.userId??null,tenantId=request.factoryos?.tenantId??null,factoryId=request.factoryos?.factoryId??null;
 if(!userId||!tenantId||!factoryId) throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
 return {userId,tenantId,factoryId,eventContext:{requestId:request.factoryos?.requestId??null,traceId:request.factoryos?.traceId??null}};
}
function assertFactoryBody(bodyFactoryId:string,factoryId:string) {
 if(bodyFactoryId.toLowerCase()!==factoryId.toLowerCase()) throw new ForbiddenException('factory_id must match authenticated factory scope');
}
@Controller('should-cost/profiles')
export class ShouldCostProfilesController {
 constructor(private readonly service:ShouldCostService) {}
 @Post() @UseGuards(PermissionGuard) @RequirePermission('should_cost.profiles.write') @RequireFactoryScope()
 async create(@Req() req:ShouldCostRequest,@Body() body:CreateShouldCostProfileDto,@Headers('idempotency-key') key?:string) {
  const ctx=context(req);assertFactoryBody(body.factory_id,ctx.factoryId);
  return this.service.createProfile(ctx.userId,ctx.tenantId,ctx.factoryId,body,key??null,ctx.eventContext);
 }
 @Get() @UseGuards(PermissionGuard) @RequirePermission('should_cost.profiles.read') @RequireFactoryScope()
 async list(@Req() req:ShouldCostRequest,@Query() query:ListShouldCostProfilesDto) {
  const ctx=context(req);return this.service.listProfiles(ctx.userId,ctx.tenantId,ctx.factoryId,query);
 }
 @Get(':profileId') @UseGuards(PermissionGuard) @RequirePermission('should_cost.profiles.read') @RequireFactoryScope()
 async get(@Req() req:ShouldCostRequest,@Param('profileId',new ParseUUIDPipe()) id:string) {
  const ctx=context(req);return this.service.getProfile(ctx.userId,ctx.tenantId,ctx.factoryId,id);
 }
 @Post(':profileId/submit') @UseGuards(PermissionGuard) @RequirePermission('should_cost.profiles.submit') @RequireFactoryScope()
 async submit(@Req() req:ShouldCostRequest,@Param('profileId',new ParseUUIDPipe()) id:string,@Body() body:TransitionShouldCostProfileDto) {
  const ctx=context(req);return this.service.transitionProfile(ctx.userId,ctx.tenantId,ctx.factoryId,id,'SUBMIT',body,ctx.eventContext);
 }
 @Post(':profileId/approve') @UseGuards(PermissionGuard) @RequirePermission('should_cost.profiles.approve') @RequireFactoryScope()
 async approve(@Req() req:ShouldCostRequest,@Param('profileId',new ParseUUIDPipe()) id:string,@Body() body:TransitionShouldCostProfileDto) {
  const ctx=context(req);return this.service.transitionProfile(ctx.userId,ctx.tenantId,ctx.factoryId,id,'APPROVE',body,ctx.eventContext);
 }
 @Post(':profileId/reject') @UseGuards(PermissionGuard) @RequirePermission('should_cost.profiles.approve') @RequireFactoryScope()
 async reject(@Req() req:ShouldCostRequest,@Param('profileId',new ParseUUIDPipe()) id:string,@Body() body:TransitionShouldCostProfileDto) {
  const ctx=context(req);return this.service.transitionProfile(ctx.userId,ctx.tenantId,ctx.factoryId,id,'REJECT',body,ctx.eventContext);
 }
}
@Controller('should-cost/assessments')
export class ShouldCostAssessmentsController {
 constructor(private readonly service:ShouldCostService) {}
 @Post() @UseGuards(PermissionGuard) @RequirePermission('should_cost.assessments.calculate') @RequireFactoryScope()
 async create(@Req() req:ShouldCostRequest,@Body() body:CreateShouldCostAssessmentDto,@Headers('idempotency-key') key?:string) {
  const ctx=context(req);return this.service.createAssessment(ctx.userId,ctx.tenantId,ctx.factoryId,body,key??null,ctx.eventContext);
 }
 @Get() @UseGuards(PermissionGuard) @RequirePermission('should_cost.assessments.read') @RequireFactoryScope()
 async list(@Req() req:ShouldCostRequest,@Query() query:ListShouldCostAssessmentsDto) {
  const ctx=context(req);return this.service.listAssessments(ctx.userId,ctx.tenantId,ctx.factoryId,query);
 }
 @Get(':assessmentId') @UseGuards(PermissionGuard) @RequirePermission('should_cost.assessments.read') @RequireFactoryScope()
 async get(@Req() req:ShouldCostRequest,@Param('assessmentId',new ParseUUIDPipe()) id:string) {
  const ctx=context(req);return this.service.getAssessment(ctx.userId,ctx.tenantId,ctx.factoryId,id);
 }
}
