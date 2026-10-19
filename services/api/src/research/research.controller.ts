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
import { CreateResearchWatchlistDto } from './dto/create-research-watchlist.dto';
import { DecideResearchWatchlistDto } from './dto/decide-research-watchlist.dto';
import { DecideResearchRelevanceDto } from './dto/decide-research-relevance.dto';
import { DecideResearchClaimDto } from './dto/decide-research-claim.dto';
import { DecideResearchEvidenceSafetyDto } from './dto/decide-research-evidence-safety.dto';
import { DecideResearchSourceDto } from './dto/decide-research-source.dto';
import { PromoteResearchReleaseDto } from './dto/promote-research-release.dto';
import {
  CompleteResearchExtractionDto,
  CreateResearchIngestionJobDto,
  DecideResearchExtractionItemDto,
  FailResearchIngestionJobDto,
  PauseResearchIngestionJobDto,
  ResearchIngestionCheckpointDto,
} from './dto/research-ingestion.dto';
import { ResearchIngestionService } from './research-ingestion.service';
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
  constructor(
    private readonly research: ResearchService,
    private readonly ingestion: ResearchIngestionService,
  ) {}

  @Post('watchlists')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.write')
  createWatchlist(
    @Req() req: FactoryOsRequest,
    @Body() body: CreateResearchWatchlistDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.research.createWatchlist(c.userId, c.tenantId, body, c.requestId, c.traceId);
  }

  @Get('watchlists')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.read')
  listWatchlists(
    @Req() req: FactoryOsRequest,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.research.listWatchlists(c.tenantId, {
      status, limit: rawLimit === undefined ? 50 : Number(rawLimit),
    });
  }

  @Post('watchlists/:watchlistId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  decideWatchlist(
    @Req() req: FactoryOsRequest,
    @Param('watchlistId', new ParseUUIDPipe()) watchlistId: string,
    @Body() body: DecideResearchWatchlistDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.research.decideWatchlist(
      c.userId, c.tenantId, watchlistId, body, c.requestId, c.traceId,
    );
  }

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

  @Post('sources/:sourceId/ingestion-jobs')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.write')
  createIngestionJob(
    @Req() req: FactoryOsRequest,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body() body: CreateResearchIngestionJobDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.createJob(c.userId, c.tenantId, sourceId, body, c.requestId, c.traceId);
  }

  @Get('ingestion-jobs')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.read')
  listIngestionJobs(
    @Req() req: FactoryOsRequest,
    @Query('source_id') sourceId?: string,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.listJobs(c.tenantId, {
      source_id: sourceId, status, limit: rawLimit === undefined ? 50 : Number(rawLimit),
    });
  }

  // The ingestion worker uses a tenant-scoped lease. No raw source body is
  // accepted by this route; checkpoints are metadata-only and resumable.
  @Post('ingestion-jobs/claim-next')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.ingest')
  claimNextIngestionJob(
    @Req() req: FactoryOsRequest,
    @Query('lease_seconds') rawLeaseSeconds?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.claimNextJob(
      c.userId, c.tenantId, rawLeaseSeconds === undefined ? 300 : Number(rawLeaseSeconds), c.requestId, c.traceId,
    );
  }

  @Post('ingestion-jobs/:jobId/checkpoint')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.ingest')
  checkpointIngestionJob(
    @Req() req: FactoryOsRequest,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Body() body: ResearchIngestionCheckpointDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.checkpoint(c.userId, c.tenantId, jobId, body, c.requestId, c.traceId);
  }

  @Post('ingestion-jobs/:jobId/pause')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.ingest')
  pauseIngestionJob(
    @Req() req: FactoryOsRequest,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Body() body: PauseResearchIngestionJobDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.pauseJob(c.userId, c.tenantId, jobId, body, c.requestId, c.traceId);
  }

  @Post('ingestion-jobs/:jobId/failure')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.ingest')
  failIngestionJob(
    @Req() req: FactoryOsRequest,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Body() body: FailResearchIngestionJobDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.failJob(c.userId, c.tenantId, jobId, body, c.requestId, c.traceId);
  }

  @Post('ingestion-jobs/:jobId/extraction')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.ingest')
  completeResearchExtraction(
    @Req() req: FactoryOsRequest,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Body() body: CompleteResearchExtractionDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.completeExtraction(c.userId, c.tenantId, jobId, body, c.requestId, c.traceId);
  }

  @Post('ingestion-jobs/:jobId/extraction-items/:itemId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  decideResearchExtractionItem(
    @Req() req: FactoryOsRequest,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: DecideResearchExtractionItemDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.decideExtractionItem(c.userId, c.tenantId, jobId, itemId, body, c.requestId, c.traceId);
  }

  @Get('ingestion-jobs/:jobId/extraction')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  listResearchExtractionProvenance(
    @Req() req: FactoryOsRequest,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
  ): Promise<unknown> {
    const context = this.context(req);
    return this.ingestion.listExtractionProvenance(context.userId, context.tenantId, jobId);
  }

  @Get('ingestion-jobs/:jobId/events')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.read')
  listIngestionJobEvents(
    @Req() req: FactoryOsRequest,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.listJobEvents(c.userId, c.tenantId, jobId);
  }

  @Get('sources/:sourceId/content-purges')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  listResearchSourceContentPurges(
    @Req() req: FactoryOsRequest,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const context = this.context(req);
    return this.ingestion.listSourceContentPurges(
      context.userId, context.tenantId, sourceId,
      rawLimit === undefined ? 100 : Number(rawLimit),
    );
  }

  @Get('sources/:sourceId/rights-history')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  listSourceRightsHistory(
    @Req() req: FactoryOsRequest,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.ingestion.listSourceRightsHistory(
      c.userId, c.tenantId, sourceId, rawLimit === undefined ? 100 : Number(rawLimit),
    );
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

  @Post('claims/:claimId/assess-evidence')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  assessClaimEvidence(
    @Req() req: FactoryOsRequest,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.research.assessClaimEvidence(c.userId, c.tenantId, claimId, c.requestId, c.traceId);
  }

  @Get('claims/:claimId/evidence-assessments')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  listClaimEvidenceAssessments(
    @Req() req: FactoryOsRequest,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.research.listClaimEvidenceAssessments(
      c.userId, c.tenantId, claimId, rawLimit === undefined ? 50 : Number(rawLimit),
    );
  }

  @Post('claims/:claimId/evidence-assessments/:assessmentId/safety-decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  decideResearchEvidenceSafety(
    @Req() req: FactoryOsRequest,
    @Param('claimId', new ParseUUIDPipe()) claimId: string,
    @Param('assessmentId', new ParseUUIDPipe()) assessmentId: string,
    @Body() body: DecideResearchEvidenceSafetyDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.research.decideEvidenceSafety(
      c.userId, c.tenantId, claimId, assessmentId, body, c.requestId, c.traceId,
    );
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

  @Post('releases/:releaseId/evaluate')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.review')
  evaluateRelease(
    @Req() req: FactoryOsRequest,
    @Param('releaseId', new ParseUUIDPipe()) releaseId: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.research.evaluateRelease(c.userId, c.tenantId, releaseId, c.requestId, c.traceId);
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
