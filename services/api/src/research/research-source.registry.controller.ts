import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateResearchSourceDto } from './dto/create-research-source.dto';
import { CreateResearchSourceAssessmentDto } from './dto/create-research-source-assessment.dto';
import { IngestResearchSourceTextDto } from './dto/ingest-research-source-text.dto';
import { ResearchSourceRegistryService } from './research-source.registry.service';
import { ResearchDocumentExtractionService } from './research-document-extraction.service';

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

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('v2/research/sources')
export class ResearchSourceRegistryController {
  constructor(
    private readonly sourceRegistry: ResearchSourceRegistryService,
    private readonly documentExtraction: ResearchDocumentExtractionService,
  ) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('research.sources.write')
  @RequireFactoryScope()
  async registerSource(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateResearchSourceDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.sourceRegistry.registerSource(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('research.sources.read')
  @RequireFactoryScope()
  async listSources(
    @Req() request: FactoryOsRequest,
    @Query('source_key') sourceKey?: string,
    @Query('source_type') sourceType?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.sourceRegistry.listSources(
      context.tenantId,
      context.factoryId,
      context.userId,
      {
        sourceKey,
        sourceType,
        limit: limit === undefined ? undefined : Number(limit),
      },
    );
  }

  @Post(':sourceId/assessments')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.sources.assess')
  @RequireFactoryScope()
  async createAssessment(
    @Req() request: FactoryOsRequest,
    @Param('sourceId') sourceId: string,
    @Body() body: CreateResearchSourceAssessmentDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.sourceRegistry.createAssessment(
      context.tenantId,
      context.factoryId,
      context.userId,
      sourceId,
      body,
    );
  }

  @Get(':sourceId/assessments')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.sources.read')
  @RequireFactoryScope()
  async listAssessments(
    @Req() request: FactoryOsRequest,
    @Param('sourceId') sourceId: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.sourceRegistry.listAssessments(
      context.tenantId,
      context.factoryId,
      context.userId,
      sourceId,
      limit === undefined ? 25 : Number(limit),
    );
  }

  @Post(':sourceId/content')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.sources.ingest')
  @RequireFactoryScope()
  async ingestPlainText(
    @Req() request: FactoryOsRequest,
    @Param('sourceId') sourceId: string,
    @Body() body: IngestResearchSourceTextDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.sourceRegistry.ingestPlainText(
      context.tenantId,
      context.factoryId,
      context.userId,
      sourceId,
      body,
    );
  }

  @Post(':sourceId/document')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.sources.ingest')
  @RequireFactoryScope()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  async ingestDocument(
    @Req() request: FactoryOsRequest,
    @Param('sourceId') sourceId: string,
    @UploadedFile() file?: { buffer: Buffer; size: number; mimetype: string; originalname: string },
  ) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Upload a PDF or DOCX using multipart field "file"');
    }

    const context = this.getAuthenticatedFactoryContext(request);
    const extracted = this.documentExtraction.extract(file.buffer);
    return this.sourceRegistry.ingestPlainText(
      context.tenantId,
      context.factoryId,
      context.userId,
      sourceId,
      { content: extracted.text },
      {
        sourceFormat: extracted.format,
        originalFileSha256: extracted.originalFileSha256,
        parserVersion: 'factoryos-document-extractor-v1',
      },
    );
  }

  @Get(':sourceId/content')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.sources.content.read')
  @RequireFactoryScope()
  async getApprovedTextContent(
    @Req() request: FactoryOsRequest,
    @Param('sourceId') sourceId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.sourceRegistry.getApprovedTextContent(
      context.tenantId,
      context.factoryId,
      context.userId,
      sourceId,
    );
  }

  private getAuthenticatedFactoryContext(
    request: FactoryOsRequest,
  ): {
    userId: string;
    tenantId: string;
    factoryId: string;
  } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException(
        'Authenticated research factory context is missing',
      );
    }
    return { userId, tenantId, factoryId };
  }
}
