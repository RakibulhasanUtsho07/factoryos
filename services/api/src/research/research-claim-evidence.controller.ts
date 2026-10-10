import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateResearchClaimDto } from './dto/create-research-claim.dto';
import { CreateResearchClaimEvidenceDto } from './dto/create-research-claim-evidence.dto';
import { ValidateResearchCitationDto } from './dto/validate-research-citation.dto';
import { ResearchClaimEvidenceService } from './research-claim-evidence.service';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type FactoryOsRequest = Request & { factoryos?: FactoryOsRequestContext };

@Controller('v2/research/claims')
export class ResearchClaimEvidenceController {
  constructor(private readonly claimEvidence: ResearchClaimEvidenceService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('research.claims.write')
  @RequireFactoryScope()
  async createClaim(@Req() request: FactoryOsRequest, @Body() body: CreateResearchClaimDto) {
    const context = this.getContext(request);
    return this.claimEvidence.createClaim(context.tenantId, context.factoryId, context.userId, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('research.claims.read')
  @RequireFactoryScope()
  async listClaims(
    @Req() request: FactoryOsRequest,
    @Query('claim_key') claimKey?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.getContext(request);
    return this.claimEvidence.listClaims(
      context.tenantId,
      context.factoryId,
      context.userId,
      { claimKey, limit: limit === undefined ? undefined : Number(limit) },
    );
  }

  @Get(':claimId')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.claims.read')
  @RequireFactoryScope()
  async getClaimGraph(@Req() request: FactoryOsRequest, @Param('claimId') claimId: string) {
    const context = this.getContext(request);
    return this.claimEvidence.getClaimGraph(
      context.tenantId,
      context.factoryId,
      context.userId,
      claimId,
    );
  }

  @Post(':claimId/evidence')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.claims.evidence.write')
  @RequireFactoryScope()
  async linkEvidence(
    @Req() request: FactoryOsRequest,
    @Param('claimId') claimId: string,
    @Body() body: CreateResearchClaimEvidenceDto,
  ) {
    const context = this.getContext(request);
    return this.claimEvidence.linkEvidence(
      context.tenantId,
      context.factoryId,
      context.userId,
      claimId,
      body,
    );
  }

  @Post(':claimId/evidence/:evidenceId/validate')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.claims.validate')
  @RequireFactoryScope()
  async validateCitation(
    @Req() request: FactoryOsRequest,
    @Param('claimId') claimId: string,
    @Param('evidenceId') evidenceId: string,
    @Body() body: ValidateResearchCitationDto,
  ) {
    const context = this.getContext(request);
    return this.claimEvidence.validateCitation(
      context.tenantId,
      context.factoryId,
      context.userId,
      claimId,
      evidenceId,
      body,
    );
  }

  private getContext(request: FactoryOsRequest): { userId: string; tenantId: string; factoryId: string } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException('Authenticated research factory context is missing');
    }
    return { userId, tenantId, factoryId };
  }
}
