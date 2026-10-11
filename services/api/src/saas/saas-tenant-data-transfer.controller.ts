import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasSchemaCompatibilityRuleDto } from './dto/create-saas-schema-compatibility-rule.dto';
import { CreateSaasTenantExportDto } from './dto/create-saas-tenant-export.dto';
import { AttestSaasTenantExportDto } from './dto/attest-saas-tenant-export.dto';
import { ValidateSaasTenantMigrationDto } from './dto/validate-saas-tenant-migration.dto';
import { TransitionSaasTenantMigrationDto } from './dto/transition-saas-tenant-migration.dto';
import { SaasTenantDataTransferService } from './saas-tenant-data-transfer.service';

type DataTransferRequest = Request & {
  factoryos?: {
    userId: string | null;
    tenantId: string | null;
  };
};

@Controller('v2/saas/data-transfers')
export class SaasTenantDataTransferController {
  constructor(private readonly service: SaasTenantDataTransferService) {}

  @Post('compatibility-rules')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.write')
  async registerCompatibilityRule(
    @Req() request: DataTransferRequest,
    @Body() body: CreateSaasSchemaCompatibilityRuleDto,
  ) {
    const context = this.context(request);
    return this.service.registerCompatibilityRule(context.tenantId, context.userId, body);
  }

  @Get('compatibility-rules')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.read')
  async listCompatibilityRules(@Req() request: DataTransferRequest) {
    const context = this.context(request);
    return this.service.listCompatibilityRules(context.tenantId, context.userId);
  }

  @Post('exports')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.write')
  async createExport(@Req() request: DataTransferRequest, @Body() body: CreateSaasTenantExportDto) {
    const context = this.context(request);
    return this.service.createExport(context.tenantId, context.userId, body);
  }

  @Post('exports/:transferId/attest')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.execute')
  async attestExport(
    @Req() request: DataTransferRequest,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Body() body: AttestSaasTenantExportDto,
  ) {
    const context = this.context(request);
    return this.service.attestExport(context.tenantId, context.userId, transferId, body);
  }

  @Post('migrations/validate')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.write')
  async validateMigration(@Req() request: DataTransferRequest, @Body() body: ValidateSaasTenantMigrationDto) {
    const context = this.context(request);
    return this.service.validateMigration(context.tenantId, context.userId, body);
  }

  @Post('migrations/:transferId/transitions')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.execute')
  async transitionMigration(
    @Req() request: DataTransferRequest,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Body() body: TransitionSaasTenantMigrationDto,
  ) {
    const context = this.context(request);
    return this.service.transitionMigration(context.tenantId, context.userId, transferId, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.read')
  async listLatest(@Req() request: DataTransferRequest, @Query('operation_type') operationType?: 'EXPORT' | 'MIGRATION') {
    const context = this.context(request);
    return this.service.listLatest(context.tenantId, context.userId, operationType);
  }

  @Get(':transferId/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_transfers.read')
  async history(
    @Req() request: DataTransferRequest,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
  ) {
    const context = this.context(request);
    return this.service.history(context.tenantId, context.userId, transferId);
  }

  private context(request: DataTransferRequest): { tenantId: string; userId: string } {
    // Verified identity is authoritative. Tenant and actor headers/body fields are never trusted.
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) {
      throw new UnauthorizedException('Authenticated tenant data transfer context is missing');
    }
    return { tenantId, userId };
  }
}
