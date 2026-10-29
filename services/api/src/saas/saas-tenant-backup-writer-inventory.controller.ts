import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasBackupWriterInventorySnapshotDto } from './dto/create-saas-backup-writer-inventory-snapshot.dto';
import { ReviewSaasBackupWriterInventorySnapshotDto } from './dto/review-saas-backup-writer-inventory-snapshot.dto';
import { SaasTenantBackupWriterInventoryService } from './saas-tenant-backup-writer-inventory.service';

type InventoryRequest = Request & {
  factoryos?: { userId: string | null; tenantId: string | null };
};

@Controller('v2/saas/data-retention/backup-writer-inventories')
export class SaasTenantBackupWriterInventoryController {
  constructor(private readonly inventory: SaasTenantBackupWriterInventoryService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.write')
  createSnapshot(@Req() request: InventoryRequest, @Body() body: CreateSaasBackupWriterInventorySnapshotDto) {
    const context = this.context(request);
    return this.inventory.createSnapshot(context.tenantId, context.userId, body);
  }

  @Get(':categoryCode/latest')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  latestSnapshot(@Req() request: InventoryRequest, @Param('categoryCode') categoryCode: string) {
    const context = this.context(request);
    return this.inventory.latestSnapshot(context.tenantId, context.userId, categoryCode);
  }

  @Get(':categoryCode/current')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  currentSnapshot(@Req() request: InventoryRequest, @Param('categoryCode') categoryCode: string) {
    const context = this.context(request);
    return this.inventory.currentSnapshot(context.tenantId, context.userId, categoryCode);
  }

  @Post(':snapshotId/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.approve')
  reviewSnapshot(
    @Req() request: InventoryRequest,
    @Param('snapshotId', new ParseUUIDPipe()) snapshotId: string,
    @Body() body: ReviewSaasBackupWriterInventorySnapshotDto,
  ) {
    const context = this.context(request);
    return this.inventory.reviewSnapshot(context.tenantId, context.userId, snapshotId, body);
  }

  private context(request: InventoryRequest): { tenantId: string; userId: string } {
    // Verified identity is authoritative; caller-supplied tenant/actor values are ignored.
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) {
      throw new UnauthorizedException('Authenticated tenant retention context is missing');
    }
    return { tenantId, userId };
  }
}
