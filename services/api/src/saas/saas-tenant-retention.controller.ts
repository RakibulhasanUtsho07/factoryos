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
import { SaasTenantPropagationService } from './saas-tenant-propagation.service';
import { PropagateSaasTenantErasureDto } from './dto/propagate-saas-tenant-erasure.dto';
import { RegisterSaasExternalDataTargetDto } from './dto/register-saas-external-data-target.dto';
import { ReviewSaasExternalDataTargetDto } from './dto/review-saas-external-data-target.dto';
import { CreateSaasFinanceRetentionPolicyDto } from './dto/create-saas-finance-retention-policy.dto';
import { ReviewSaasFinanceRetentionPolicyDto } from './dto/review-saas-finance-retention-policy.dto';
import { RunSaasFinanceRetentionDto } from './dto/run-saas-finance-retention.dto';
import { SaasTenantFinanceRetentionService } from './saas-tenant-finance-retention.service';

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
    private readonly propagation: SaasTenantPropagationService,
    private readonly financeRetention: SaasTenantFinanceRetentionService,
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

  @Get('runs')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listRetentionRuns(
    @Req() request: RetentionRequest,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('mode') mode?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.context(request);
    return this.execution.listRetentionRuns(context.tenantId, context.userId, { category, status, mode, limit });
  }

  @Get('erasure-requests/:requestId/runs')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listErasureRuns(
    @Req() request: RetentionRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.context(request);
    return this.execution.listErasureRuns(context.tenantId, context.userId, requestId, limit);
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

  @Post('external-targets')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.write')
  registerExternalTarget(@Req() request: RetentionRequest, @Body() body: RegisterSaasExternalDataTargetDto) {
    const context = this.context(request);
    return this.propagation.registerTarget(context.tenantId, context.userId, body);
  }

  @Get('external-targets')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listExternalTargets(@Req() request: RetentionRequest) {
    const context = this.context(request);
    return this.propagation.listTargets(context.tenantId, context.userId);
  }

  @Post('external-targets/:targetId/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.approve')
  reviewExternalTarget(
    @Req() request: RetentionRequest,
    @Param('targetId') targetId: string,
    @Body() body: ReviewSaasExternalDataTargetDto,
  ) {
    const context = this.context(request);
    return this.propagation.reviewTarget(context.tenantId, context.userId, targetId, body);
  }

  @Post('erasure-requests/:requestId/propagate')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.propagate')
  propagateErasure(
    @Req() request: RetentionRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: PropagateSaasTenantErasureDto,
  ) {
    const context = this.context(request);
    return this.propagation.propagateErasure(context.tenantId, context.userId, requestId, body);
  }

  @Get('erasure-requests/:requestId/propagation-runs')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listPropagationRuns(
    @Req() request: RetentionRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.context(request);
    return this.propagation.listPropagationRuns(context.tenantId, context.userId, requestId, limit);
  }

  @Post('finance-policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.write')
  createFinanceRetentionPolicy(@Req() request: RetentionRequest, @Body() body: CreateSaasFinanceRetentionPolicyDto) {
    const context = this.context(request);
    return this.financeRetention.createPolicy(context.tenantId, context.userId, body);
  }

  @Get('finance-policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listFinanceRetentionPolicies(@Req() request: RetentionRequest) {
    const context = this.context(request);
    return this.financeRetention.listPolicies(context.tenantId, context.userId);
  }

  @Post('finance-policies/:version/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.finance_review')
  reviewFinanceRetentionPolicy(
    @Req() request: RetentionRequest,
    @Param('version') version: string,
    @Body() body: ReviewSaasFinanceRetentionPolicyDto,
  ) {
    const context = this.context(request);
    return this.financeRetention.reviewPolicy(context.tenantId, context.userId, Number(version), body);
  }

  @Post('finance-policies/:version/run')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.finance_execute')
  runFinanceRetentionPolicy(
    @Req() request: RetentionRequest,
    @Param('version') version: string,
    @Body() body: RunSaasFinanceRetentionDto,
  ) {
    const context = this.context(request);
    return this.financeRetention.runPolicy(context.tenantId, context.userId, Number(version), body);
  }

  @Get('finance-runs')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.data_retention.read')
  listFinanceRetentionRuns(@Req() request: RetentionRequest, @Query('limit') limit?: string) {
    const context = this.context(request);
    return this.financeRetention.listRuns(context.tenantId, context.userId, limit);
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
