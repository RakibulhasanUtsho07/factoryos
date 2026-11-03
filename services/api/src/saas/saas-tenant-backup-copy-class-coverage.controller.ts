import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasBackupCopyClassCoverageDto } from './dto/create-saas-backup-copy-class-coverage.dto';
import { ReviewSaasBackupCopyClassCoverageDto } from './dto/review-saas-backup-copy-class-coverage.dto';
import { SaasTenantBackupCopyClassCoverageService } from './saas-tenant-backup-copy-class-coverage.service';

type CoverageRequest = Request & { factoryos?: { userId: string | null; tenantId: string | null } };
@Controller('v2/saas/data-retention/backup-copy-classes')
export class SaasTenantBackupCopyClassCoverageController {
  constructor(private readonly coverage: SaasTenantBackupCopyClassCoverageService) {}
  @Post() @UseGuards(PermissionGuard) @RequirePermission('saas.data_retention.write')
  create(@Req() request: CoverageRequest, @Body() body: CreateSaasBackupCopyClassCoverageDto) {
    const context = this.context(request);
    return this.coverage.createDecision(context.tenantId, context.userId, body);
  }
  @Get(':categoryCode/current') @UseGuards(PermissionGuard) @RequirePermission('saas.data_retention.read')
  current(@Req() request: CoverageRequest, @Param('categoryCode') categoryCode: string) {
    const context = this.context(request);
    return this.coverage.listCurrent(context.tenantId, context.userId, categoryCode);
  }
  @Post(':decisionId/review') @UseGuards(PermissionGuard) @RequirePermission('saas.data_retention.approve')
  review(@Req() request: CoverageRequest, @Param('decisionId', new ParseUUIDPipe()) decisionId: string,
    @Body() body: ReviewSaasBackupCopyClassCoverageDto) {
    const context = this.context(request);
    return this.coverage.reviewDecision(context.tenantId, context.userId, decisionId, body);
  }
  private context(request: CoverageRequest): { tenantId: string; userId: string } {
    const tenantId = request.factoryos?.tenantId ?? null, userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) throw new UnauthorizedException('Authenticated tenant retention context is missing');
    return { tenantId, userId };
  }
}
