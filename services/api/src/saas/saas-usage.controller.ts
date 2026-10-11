import { Body, Controller, Get, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasMeterRateDto } from './dto/create-saas-meter-rate.dto';
import { CreateSaasUsageAdjustmentDto } from './dto/create-saas-usage-adjustment.dto';
import { ReconcileSaasUsageDto } from './dto/reconcile-saas-usage.dto';
import { RecordSaasUsageEventDto } from './dto/record-saas-usage-event.dto';
import { SaasUsageService } from './saas-usage.service';

type SaasRequest = Request & { factoryos?: { userId:string|null; tenantId:string|null; factoryId:string|null } };
@Controller('v2/saas/usage')
export class SaasUsageController {
 constructor(private readonly service:SaasUsageService){}
 @Post('rates') @UseGuards(PermissionGuard) @RequirePermission('saas.rates.write')
 async createRate(@Req() req:SaasRequest,@Body() body:CreateSaasMeterRateDto){const c=this.context(req);return this.service.createRateCard(c.tenantId,c.userId,body);}
 @Get('rates') @UseGuards(PermissionGuard) @RequirePermission('saas.usage.read')
 async listRates(@Req() req:SaasRequest,@Query('metric_code') metric?:string){const c=this.context(req);return this.service.listRateCards(c.tenantId,c.userId,metric);}
 @Post('events') @UseGuards(PermissionGuard) @RequirePermission('saas.usage.write')
 async recordUsage(@Req() req:SaasRequest,@Body() body:RecordSaasUsageEventDto){const c=this.context(req);return this.service.recordUsageEvent(c.tenantId,c.factoryId,c.userId,body);}
 @Get('report') @UseGuards(PermissionGuard) @RequirePermission('saas.usage.read')
 async usageReport(@Req() req:SaasRequest,@Query('from') from:string,@Query('to') to:string){const c=this.context(req);return this.service.getUsageReport(c.tenantId,c.factoryId,c.userId,from,to);}
 @Post('adjustments') @UseGuards(PermissionGuard) @RequirePermission('saas.adjustments.write')
 async adjustment(@Req() req:SaasRequest,@Body() body:CreateSaasUsageAdjustmentDto){const c=this.context(req);return this.service.createAdjustment(c.tenantId,c.factoryId,c.userId,body);}
 @Post('reconciliations') @UseGuards(PermissionGuard) @RequirePermission('saas.reconciliation.write')
 async reconcile(@Req() req:SaasRequest,@Body() body:ReconcileSaasUsageDto){const c=this.context(req);return this.service.reconcileInvoice(c.tenantId,c.factoryId,c.userId,body);}
 @Get('reconciliations') @UseGuards(PermissionGuard) @RequirePermission('saas.usage.read')
 async listReconciliations(@Req() req:SaasRequest,@Query('limit') l?:string,@Query('offset') o?:string){const c=this.context(req);return this.service.listReconciliations(c.tenantId,c.factoryId,c.userId,l===undefined?25:Number(l),o===undefined?0:Number(o));}
 private context(req:SaasRequest):{tenantId:string;userId:string;factoryId:string|null}{const tenantId=req.factoryos?.tenantId??null,userId=req.factoryos?.userId??null,factoryId=req.factoryos?.factoryId??null;if(!tenantId||!userId)throw new UnauthorizedException('Authenticated SaaS tenant context is missing');return {tenantId,userId,factoryId};}
}
