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
import { CreateSaasRetentionPolicyDto } from './dto/create-saas-retention-policy.dto';
import { CreateSaasDataLegalHoldDto } from './dto/create-saas-data-legal-hold.dto';
import { ReleaseSaasDataLegalHoldDto } from './dto/release-saas-data-legal-hold.dto';
import { CreateSaasTenantErasureRequestDto } from './dto/create-saas-tenant-erasure-request.dto';
import { ReviewSaasTenantErasureRequestDto } from './dto/review-saas-tenant-erasure-request.dto';
import { CreateSaasExportPreservationAttestationDto } from './dto/create-saas-export-preservation-attestation.dto';
import { RunSaasRetentionPolicyDto } from './dto/run-saas-retention-policy.dto';
import { ExecuteSaasTenantErasureDto } from './dto/execute-saas-tenant-erasure.dto';
import { SaasTenantRetentionService } from './saas-tenant-retention.service';
import { SaasTenantGovernanceExecutionService } from './saas-tenant-governance-execution.service';

type RetentionRequest = Request & {
  factoryos?: {
    userId: string | null;
    tenantId: string | null;
  };
};

@Controller('v2/saas/data-retention')
export class SaasTenantRetentionController {
  constructor(
    private readonly service: SaasTenantRetentionService,
    private readonly execution: SaasTenantGovernanceExecutionService,
  ) {}

  @Post('policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.write')
  createPolicy(@Req() request: RetentionRequest, @Body() body: CreateSaasRetentionPolicyDto) {
    const context = this.context(request);
    return this.service.createPolicy(context.tenantId, context.userId, body);
  }

  @Get('policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listPolicies(@Req() request: RetentionRequest) {
    const context = this.context(request);
    return this.service.listPolicies(context.tenantId, context.userId);
  }

  @Get('policies/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listPolicyHistory(@Req() request: RetentionRequest, @Query('categoryCode') categoryCode?: string) {
    const context = this.context(request);
    return this.service.listPoliciesHistory(context.tenantId, context.userId, categoryCode);
  }

  @Post('legal-holds')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.write')
  createLegalHold(@Req() request: RetentionRequest, @Body() body: CreateSaasDataLegalHoldDto) {
    const context = this.context(request);
    return this.service.createLegalHold(context.tenantId, context.userId, body);
  }

  @Get('legal-holds')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listLegalHolds(
    @Req() request: RetentionRequest,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.context(request);
    return this.service.listLegalHolds(context.tenantId, context.userId, status, limit);
  }

  @Post('legal-holds/:holdId/release')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.approve')
  releaseLegalHold(
    @Req() request: RetentionRequest,
    @Param('holdId', new ParseUUIDPipe()) holdId: string,
    @Body() body: ReleaseSaasDataLegalHoldDto,
  ) {
    const context = this.context(request);
    return this.service.releaseLegalHold(context.tenantId, context.userId, holdId, body);
  }

  @Post('erasure-requests')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.write')
  createErasureRequest(@Req() request: RetentionRequest, @Body() body: CreateSaasTenantErasureRequestDto) {
    const context = this.context(request);
    return this.service.createErasureRequest(context.tenantId, context.userId, body);
  }

  @Get('erasure-requests')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listErasureRequests(
    @Req() request: RetentionRequest,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.context(request);
    return this.service.listErasureRequests(context.tenantId, context.userId, status, limit);
  }

  @Post('erasure-requests/:requestId/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.approve')
  reviewErasureRequest(
    @Req() request: RetentionRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: ReviewSaasTenantErasureRequestDto,
  ) {
    const context = this.context(request);
    return this.service.reviewErasureRequest(context.tenantId, context.userId, requestId, body);
  }

  @Post('exports/:transferId/preservation-attestation')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.approve')
  attestExportPreservation(
    @Req() request: RetentionRequest,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Body() body: CreateSaasExportPreservationAttestationDto,
  ) {
    const context = this.context(request);
    return this.service.attestExportPreservation(context.tenantId, context.userId, transferId, body);
  }

  @Post('policies/:categoryCode/run')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.execute')
  runRetentionPolicy(
    @Req() request: RetentionRequest,
    @Param('categoryCode') categoryCode: string,
    @Body() body: RunSaasRetentionPolicyDto,
  ) {
    const context = this.context(request);
    return this.execution.runRetentionPolicy(context.tenantId, context.userId, categoryCode, body);
  }

  @Post('erasure-requests/:requestId/execute')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.execute')
  executeErasure(
    @Req() request: RetentionRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: ExecuteSaasTenantErasureDto,
  ) {
    const context = this.context(request);
    return this.execution.executeErasure(context.tenantId, context.userId, requestId, body);
  }

  private context(request: RetentionRequest): { tenantId: string; userId: string } {
    // Verified identity is authoritative. Tenant/actor headers and request bodies are never trusted.
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) {
      throw new UnauthorizedException('Authenticated tenant retention context is missing');
    }
    return { tenantId, userId };
  }
}
