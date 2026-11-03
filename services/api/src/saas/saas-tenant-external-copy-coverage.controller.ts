import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasExternalCopyCoverageDto } from './dto/create-saas-external-copy-coverage.dto';
import { ReviewSaasExternalCopyCoverageDto } from './dto/review-saas-external-copy-coverage.dto';
import { SaasTenantExternalCopyCoverageService } from './saas-tenant-external-copy-coverage.service';
type CoverageRequest=Request&{factoryos?:{userId:string|null;tenantId:string|null}};
@Controller('v2/saas/data-retention/external-copy-coverage')
export class SaasTenantExternalCopyCoverageController {
 constructor(private readonly coverage:SaasTenantExternalCopyCoverageService){}
 @Post() @UseGuards(PermissionGuard) @RequirePermission('saas.data_retention.write')
 create(@Req() request:CoverageRequest,@Body() body:CreateSaasExternalCopyCoverageDto){
  const c=this.context(request);return this.coverage.createDecision(c.tenantId,c.userId,body);
 }
 @Get(':categoryCode/current') @UseGuards(PermissionGuard) @RequirePermission('saas.data_retention.read')
 current(@Req() request:CoverageRequest,@Param('categoryCode') categoryCode:string){
  const c=this.context(request);return this.coverage.listCurrent(c.tenantId,c.userId,categoryCode);
 }
 @Post(':decisionId/review') @UseGuards(PermissionGuard) @RequirePermission('saas.data_retention.approve')
 review(@Req() request:CoverageRequest,@Param('decisionId',new ParseUUIDPipe()) decisionId:string,@Body() body:ReviewSaasExternalCopyCoverageDto){
  const c=this.context(request);return this.coverage.reviewDecision(c.tenantId,c.userId,decisionId,body);
 }
 private context(request:CoverageRequest):{tenantId:string;userId:string}{
  const tenantId=request.factoryos?.tenantId??null,userId=request.factoryos?.userId??null;
  if(!tenantId||!userId)throw new UnauthorizedException('Authenticated tenant retention context is missing');
  return {tenantId,userId};
 }
}
