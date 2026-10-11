import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasMeterRateDto } from './dto/create-saas-meter-rate.dto';
import { CreateSaasUsageAdjustmentDto } from './dto/create-saas-usage-adjustment.dto';
import { ReconcileSaasUsageDto } from './dto/reconcile-saas-usage.dto';
import { RecordSaasUsageEventDto } from './dto/record-saas-usage-event.dto';
import { CreateSaasUsageBudgetDto } from './dto/create-saas-usage-budget.dto';
import { SetSaasWorkloadControlDto } from './dto/set-saas-workload-control.dto';
import { RecordSaasProviderCostEventDto } from './dto/record-saas-provider-cost-event.dto';
import { ReconcileSaasProviderCostInvoiceDto } from './dto/reconcile-saas-provider-cost-invoice.dto';
import { AcknowledgeSaasBudgetAlertDto } from './dto/acknowledge-saas-budget-alert.dto';
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
 @Post('budgets') @UseGuards(PermissionGuard) @RequirePermission('saas.budgets.write')
 async createBudget(@Req() req:SaasRequest,@Body() body:CreateSaasUsageBudgetDto){const c=this.context(req);return this.service.createBudget(c.tenantId,c.factoryId,c.userId,body);}
 @Get('budgets') @UseGuards(PermissionGuard) @RequirePermission('saas.budgets.read')
 async listBudgets(@Req() req:SaasRequest){const c=this.context(req);return this.service.listBudgets(c.tenantId,c.factoryId,c.userId);}
 @Post('budgets/evaluate') @UseGuards(PermissionGuard) @RequirePermission('saas.budgets.read')
 async evaluateBudgets(@Req() req:SaasRequest,@Query('as_of') asOf?:string){const c=this.context(req);return this.service.evaluateBudgets(c.tenantId,c.factoryId,c.userId,asOf);}
 @Get('budgets/evaluations') @UseGuards(PermissionGuard) @RequirePermission('saas.budgets.read')
 async listBudgetEvaluations(@Req() req:SaasRequest,@Query('limit') l?:string,@Query('offset') o?:string){const c=this.context(req);return this.service.listBudgetEvaluations(c.tenantId,c.factoryId,c.userId,l===undefined?25:Number(l),o===undefined?0:Number(o));}
 @Post('workloads/control') @UseGuards(PermissionGuard) @RequirePermission('saas.workloads.control')
 async workloadControl(@Req() req:SaasRequest,@Body() body:SetSaasWorkloadControlDto){const c=this.context(req);return this.service.setWorkloadControl(c.tenantId,c.factoryId,c.userId,body);}
 @Get('workloads/controls') @UseGuards(PermissionGuard) @RequirePermission('saas.budgets.read')
 async workloadControls(@Req() req:SaasRequest){const c=this.context(req);return this.service.listWorkloadControls(c.tenantId,c.factoryId,c.userId);}
 @Get('alerts') @UseGuards(PermissionGuard) @RequirePermission('saas.alerts.read')
 async budgetAlerts(@Req() req:SaasRequest,@Query('limit') l?:string,@Query('offset') o?:string,@Query('unread_only') unread?:string){const c=this.context(req);if(unread!==undefined&&unread!=='true'&&unread!=='false')throw new UnauthorizedException('unread_only must be true or false');return this.service.listBudgetAlerts(c.tenantId,c.factoryId,c.userId,l===undefined?25:Number(l),o===undefined?0:Number(o),unread==='true');}
 @Post('alerts/:id/acknowledgements') @UseGuards(PermissionGuard) @RequirePermission('saas.alerts.ack')
 async acknowledgeAlert(@Req() req:SaasRequest,@Param('id') id:string,@Body() body:AcknowledgeSaasBudgetAlertDto){const c=this.context(req);return this.service.acknowledgeBudgetAlert(c.tenantId,c.factoryId,c.userId,id,body);}
 @Post('provider-cost-events') @UseGuards(PermissionGuard) @RequirePermission('saas.provider_costs.write')
 async providerCostEvent(@Req() req:SaasRequest,@Body() body:RecordSaasProviderCostEventDto){const c=this.context(req);return this.service.recordProviderCostEvent(c.tenantId,c.factoryId,c.userId,body);}
 @Post('provider-cost-reconciliations') @UseGuards(PermissionGuard) @RequirePermission('saas.provider_costs.reconcile')
 async reconcileProviderInvoice(@Req() req:SaasRequest,@Body() body:ReconcileSaasProviderCostInvoiceDto){const c=this.context(req);return this.service.reconcileProviderCostInvoice(c.tenantId,c.factoryId,c.userId,body);}
 @Get('provider-cost-reconciliations') @UseGuards(PermissionGuard) @RequirePermission('saas.provider_costs.read')
 async providerReconciliationHistory(@Req() req:SaasRequest,@Query('limit') l?:string,@Query('offset') o?:string){const c=this.context(req);return this.service.listProviderCostReconciliations(c.tenantId,c.factoryId,c.userId,l===undefined?25:Number(l),o===undefined?0:Number(o));}
 private context(req:SaasRequest):{tenantId:string;userId:string;factoryId:string|null}{const tenantId=req.factoryos?.tenantId??null,userId=req.factoryos?.userId??null,factoryId=req.factoryos?.factoryId??null;if(!tenantId||!userId)throw new UnauthorizedException('Authenticated SaaS tenant context is missing');return {tenantId,userId,factoryId};}
}
