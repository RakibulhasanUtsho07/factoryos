import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query,
  Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateResearchClaimDto } from './dto/create-research-claim.dto';
import { CreateResearchClaimLinkDto } from './dto/create-research-claim-link.dto';
import { CreateResearchRelevanceDto } from './dto/create-research-relevance.dto';
import { CreateResearchReleaseDto } from './dto/create-research-release.dto';
import { CreateResearchSourceDto } from './dto/create-research-source.dto';
import { DecideResearchRelevanceDto } from './dto/decide-research-relevance.dto';
import { DecideResearchClaimDto } from './dto/decide-research-claim.dto';
import { DecideResearchSourceDto } from './dto/decide-research-source.dto';
import { PromoteResearchReleaseDto } from './dto/promote-research-release.dto';
import { ResearchService } from './research.service';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & { factoryos?: FactoryOsRequestContext };

@Controller('research')
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Post('sources')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.write')
  createSource(@Req() req: FactoryOsRequest, @Body() body: CreateResearchSourceDto): Promise<unknown>  {
    const c = this.context(req);
    return this.research.createSource(c.userId, c.tenantId, body, c.requestId, c.traceId);
  }

  @Get('sources')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.read')
  listSources(
    @Req() req: FactoryOsRequest,
    @Query('search') search?: string,
    @Query('access_status') access_status?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.research.listSources(c.tenantId, {
      search,
      access_status,
      limit: rawLimit === undefined ? 50 : Number(rawLimit),
    });
  }

  @Post('sources/:sourceId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  decideSource(
    @Req() req: FactoryOsRequest,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body() body: DecideResearchSourceDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.research.decideSource(c.userId, c.tenantId, sourceId, body, c.requestId, c.traceId);
  }

  @Post('sources/:sourceId/claims')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.write')
  createClaim(
    @Req() req: FactoryOsRequest,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body() body: CreateResearchClaimDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.research.createClaim(c.userId, c.tenantId, sourceId, body, c.requestId, c.traceId);
  }

  @Get('claims')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.read')
  listClaims(
    @Req() req: FactoryOsRequest,
    @Query('status') status?: string,
    @Query('topic') topic?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.research.listClaims(c.tenantId, {
      status,
      topic,
      limit: rawLimit === undefined ? 50 : Number(rawLimit),
    });
  }

  @Post('claims/:claimId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  decideClaim(
    @Req() req: FactoryOsRequest,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body() body: DecideResearchClaimDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.research.decideClaim(c.userId, c.tenantId, claimId, body, c.requestId, c.traceId);
  }

  @Post('claims/:claimId/links')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.write')
  linkClaims(
    @Req() req: FactoryOsRequest,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body() body: CreateResearchClaimLinkDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.research.linkClaims(c.userId, c.tenantId, claimId, body);
  }

  @Post('releases')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.write')
  createRelease(@Req() req: FactoryOsRequest, @Body() body: CreateResearchReleaseDto): Promise<unknown>  {
    const c = this.context(req);
    return this.research.createRelease(c.userId, c.tenantId, body, c.requestId, c.traceId);
  }

  @Get('releases')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.read')
  listReleases(@Req() req: FactoryOsRequest, @Query('limit') rawLimit?: string): Promise<unknown>  {
    const c = this.context(req);
    return this.research.listReleases(c.tenantId, rawLimit === undefined ? 50 : Number(rawLimit));
  }

  @Post('releases/:releaseId/promote')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  promoteRelease(
    @Req() req: FactoryOsRequest,
    @Param('releaseId', new ParseUUIDPipe()) releaseId: string,
    @Body() body: PromoteResearchReleaseDto,
  ): Promise<unknown>  {
    const c = this.context(req);
    return this.research.promoteRelease(c.userId, c.tenantId, releaseId, body, c.requestId, c.traceId);
  }

  @Post('claims/:claimId/relevance')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.write')
  @RequireFactoryScope()
  createRelevance(
    @Req() req: FactoryOsRequest,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Body() body: CreateResearchRelevanceDto,
  ): Promise<unknown>  {
    const c = this.factoryContext(req);
    return this.research.createRelevance(c.userId, c.tenantId, c.factoryId, claimId, body, c.requestId, c.traceId);
  }

  @Post('relevance/:mappingId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  @RequireFactoryScope()
  decideRelevance(
    @Req() req: FactoryOsRequest,
    @Param('mappingId', new ParseUUIDPipe()) mappingId: string,
    @Body() body: DecideResearchRelevanceDto,
  ): Promise<unknown>  {
    const c = this.factoryContext(req);
    return this.research.decideRelevance(
      c.userId, c.tenantId, c.factoryId, mappingId, body, c.requestId, c.traceId,
    );
  }

  @Get('relevance')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.read')
  @RequireFactoryScope()
  listRelevance(@Req() req: FactoryOsRequest, @Query('limit') rawLimit?: string): Promise<unknown>  {
    const c = this.factoryContext(req);
    return this.research.listRelevance(c.tenantId, c.factoryId, rawLimit === undefined ? 50 : Number(rawLimit));
  }

  private context(req: FactoryOsRequest) {
    const c = req.factoryos;
    if (!c?.userId || !c.tenantId) {
      throw new UnauthorizedException('Authenticated user and tenant context are required');
    }
    return {
      userId: c.userId, tenantId: c.tenantId,
      requestId: c.requestId ?? null, traceId: c.traceId ?? null,
    };
  }

  private factoryContext(req: FactoryOsRequest) {
    const c = req.factoryos;
    if (!c?.userId || !c.tenantId || !c.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId: c.userId, tenantId: c.tenantId, factoryId: c.factoryId,
      requestId: c.requestId ?? null, traceId: c.traceId ?? null,
    };
  }
}
