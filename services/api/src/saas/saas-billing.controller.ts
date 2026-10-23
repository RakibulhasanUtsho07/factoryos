import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { ConfigureSaasBillingProviderDto } from './dto/configure-saas-billing-provider.dto';
import { CreateSaasBillingCloseDto } from './dto/create-saas-billing-close.dto';
import { ReconcileSaasBillingCloseDto } from './dto/reconcile-saas-billing-close.dto';
import { RetrySaasBillingPaymentDto } from './dto/retry-saas-billing-payment.dto';
import { SaasBillingService } from './saas-billing.service';

type BillingRequest = Request & {
  factoryos?: { tenantId: string | null; userId: string | null };
  rawBody?: Buffer;
};

@Controller('v2/saas/billing')
export class SaasBillingController {
  constructor(private readonly service: SaasBillingService) {}

  @Post('provider-account')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.account.write')
  async configureAccount(@Req() request: BillingRequest, @Body() body: ConfigureSaasBillingProviderDto) {
    const context = this.context(request);
    return this.service.configureProviderAccount(context.tenantId, context.userId, body);
  }

  @Get('provider-account')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.read')
  async providerAccount(@Req() request: BillingRequest) {
    const context = this.context(request);
    return this.service.getProviderAccount(context.tenantId, context.userId);
  }

  @Post('closes')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.close')
  async createClose(@Req() request: BillingRequest, @Body() body: CreateSaasBillingCloseDto) {
    const context = this.context(request);
    return this.service.createBillingClose(context.tenantId, context.userId, body);
  }

  @Get('closes')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.read')
  async listCloses(@Req() request: BillingRequest, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const context = this.context(request);
    return this.service.listBillingCloses(context.tenantId, context.userId,
      limit === undefined ? 25 : Number(limit), offset === undefined ? 0 : Number(offset));
  }

  @Get('closes/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.read')
  async getClose(@Req() request: BillingRequest, @Param('id') closeId: string) {
    const context = this.context(request);
    return this.service.getBillingClose(context.tenantId, context.userId, closeId);
  }

  @Post('closes/:id/issue')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.issue')
  async issue(@Req() request: BillingRequest, @Param('id') closeId: string) {
    const context = this.context(request);
    return this.service.issueInvoice(context.tenantId, context.userId, closeId);
  }

  @Post('closes/:id/retry-payment')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.issue')
  async retryPayment(
    @Req() request: BillingRequest,
    @Param('id') closeId: string,
    @Body() body: RetrySaasBillingPaymentDto,
  ) {
    const context = this.context(request);
    return this.service.retryPayment(context.tenantId, context.userId, closeId, body);
  }

  @Post('closes/:id/reconcile')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.reconcile')
  async reconcile(
    @Req() request: BillingRequest,
    @Param('id') closeId: string,
    @Body() body: ReconcileSaasBillingCloseDto,
  ) {
    const context = this.context(request);
    return this.service.reconcileInvoice(context.tenantId, context.userId, closeId, body);
  }

  @Get('closes/:id/reconciliations')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.billing.read')
  async reconciliationHistory(
    @Req() request: BillingRequest,
    @Param('id') closeId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const context = this.context(request);
    return this.service.listReconciliations(context.tenantId, context.userId, closeId,
      limit === undefined ? 25 : Number(limit), offset === undefined ? 0 : Number(offset));
  }

  @Post('webhooks/stripe')
  @Public()
  async stripeWebhook(@Req() request: BillingRequest, @Headers('stripe-signature') signature?: string) {
    if (!request.rawBody) throw new UnauthorizedException('Raw Stripe webhook request body is required');
    return this.service.receiveStripeWebhook(signature, request.rawBody);
  }

  private context(request: BillingRequest): { tenantId: string; userId: string } {
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) throw new UnauthorizedException('Verified tenant billing identity is missing');
    return { tenantId, userId };
  }
}
