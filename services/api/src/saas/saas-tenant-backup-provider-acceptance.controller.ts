import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasBackupProviderAcceptanceDto } from './dto/create-saas-backup-provider-acceptance.dto';
import { ReviewSaasBackupProviderAcceptanceDto } from './dto/review-saas-backup-provider-acceptance.dto';
import { RevokeSaasBackupProviderAcceptanceDto } from './dto/revoke-saas-backup-provider-acceptance.dto';
import { SaasTenantBackupProviderAcceptanceService } from './saas-tenant-backup-provider-acceptance.service';

type AcceptanceRequest = Request & { factoryos?: { userId: string | null; tenantId: string | null } };

@Controller('v2/saas/data-retention/backup-provider-acceptances')
export class SaasTenantBackupProviderAcceptanceController {
  constructor(private readonly acceptance: SaasTenantBackupProviderAcceptanceService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.write')
  create(@Req() request: AcceptanceRequest, @Body() body: CreateSaasBackupProviderAcceptanceDto) {
    const context = this.context(request);
    return this.acceptance.createAcceptance(context.tenantId, context.userId, body);
  }

  @Get(':categoryCode/latest')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  latest(@Req() request: AcceptanceRequest, @Param('categoryCode') categoryCode: string) {
    const context = this.context(request);
    return this.acceptance.latestAcceptance(context.tenantId, context.userId, categoryCode);
  }

  @Get(':categoryCode/current')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  current(@Req() request: AcceptanceRequest, @Param('categoryCode') categoryCode: string) {
    const context = this.context(request);
    return this.acceptance.currentAcceptance(context.tenantId, context.userId, categoryCode);
  }

  @Post(':acceptanceId/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.approve')
  review(
    @Req() request: AcceptanceRequest,
    @Param('acceptanceId', new ParseUUIDPipe()) acceptanceId: string,
    @Body() body: ReviewSaasBackupProviderAcceptanceDto,
  ) {
    const context = this.context(request);
    return this.acceptance.reviewAcceptance(context.tenantId, context.userId, acceptanceId, body);
  }

  @Post(':acceptanceId/revoke')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.approve')
  revoke(
    @Req() request: AcceptanceRequest,
    @Param('acceptanceId', new ParseUUIDPipe()) acceptanceId: string,
    @Body() body: RevokeSaasBackupProviderAcceptanceDto,
  ) {
    const context = this.context(request);
    return this.acceptance.revokeAcceptance(context.tenantId, context.userId, acceptanceId, body);
  }

  private context(request: AcceptanceRequest): { tenantId: string; userId: string } {
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) throw new UnauthorizedException('Authenticated tenant retention context is missing');
    return { tenantId, userId };
  }
}
