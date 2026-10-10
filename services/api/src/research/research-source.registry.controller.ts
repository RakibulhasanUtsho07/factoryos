import {
  Body,
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateResearchSourceDto } from './dto/create-research-source.dto';
import { ResearchSourceRegistryService } from './research-source.registry.service';

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
