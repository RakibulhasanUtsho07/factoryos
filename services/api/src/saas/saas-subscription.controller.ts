import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasSubscriptionPlanDto } from './dto/create-saas-subscription-plan.dto';
import { StartSaasTrialDto } from './dto/start-saas-trial.dto';
import { TransitionSaasSubscriptionDto } from './dto/transition-saas-subscription.dto';
import { SetSaasEntitlementEnforcementModeDto } from './dto/set-saas-entitlement-enforcement-mode.dto';
import { SaasSubscriptionService } from './saas-subscription.service';

type SubscriptionRequest = Request & {
  factoryos?: {
    userId: string | null;
    tenantId: string | null;
  };
};

@Controller('v2/saas/subscriptions')
export class SaasSubscriptionController {
  constructor(private readonly service: SaasSubscriptionService) {}

  @Post('plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.subscription_plans.write')
  async createPlan(@Req() request: SubscriptionRequest, @Body() body: CreateSaasSubscriptionPlanDto) {
    const context = this.context(request);
    return this.service.createPlan(context.tenantId, context.userId, body);
  }

  @Get('plans')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.subscription_plans.read')
  async listPlans(@Req() request: SubscriptionRequest) {
    const context = this.context(request);
    return this.service.listPlans(context.tenantId, context.userId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.subscriptions.write')
  async startTrial(@Req() request: SubscriptionRequest, @Body() body: StartSaasTrialDto) {
    const context = this.context(request);
    return this.service.startTrial(context.tenantId, context.userId, body);
  }

  @Get('current')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.subscriptions.read')
  async current(@Req() request: SubscriptionRequest) {
    const context = this.context(request);
    return this.service.getCurrentSubscription(context.tenantId, context.userId);
  }

  @Get(':id/events')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.subscriptions.read')
  async events(@Req() request: SubscriptionRequest, @Param('id', new ParseUUIDPipe()) subscriptionId: string) {
    const context = this.context(request);
    return this.service.listEvents(context.tenantId, context.userId, subscriptionId);
  }

  @Post(':id/transitions')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.subscriptions.write')
  async transition(
    @Req() request: SubscriptionRequest,
    @Param('id', new ParseUUIDPipe()) subscriptionId: string,
    @Body() body: TransitionSaasSubscriptionDto,
  ) {
    const context = this.context(request);
    return this.service.transition(context.tenantId, context.userId, subscriptionId, body);
  }

  @Get('entitlement-mode')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.entitlement_modes.read')
  async entitlementMode(@Req() request: SubscriptionRequest) {
    const context = this.context(request);
    return this.service.getEntitlementEnforcementMode(context.tenantId, context.userId);
  }

  @Post('entitlement-mode')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.entitlement_modes.write')
  async migrateEntitlementMode(
    @Req() request: SubscriptionRequest,
    @Body() body: SetSaasEntitlementEnforcementModeDto,
  ) {
    const context = this.context(request);
    return this.service.setEntitlementEnforcementMode(context.tenantId, context.userId, body);
  }

  private context(request: SubscriptionRequest): { tenantId: string; userId: string } {
    // Only verified authentication context is trusted; request headers and requested context are ignored.
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) throw new UnauthorizedException('Authenticated SaaS subscription context is missing');
    return { tenantId, userId };
  }
}
