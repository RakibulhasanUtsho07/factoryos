import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { ResearchRetrievalDto } from './dto/research-retrieval.dto';
import { ResearchRetrievalService } from './research-retrieval.service';

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

@Controller('v2/research/retrieval')
export class ResearchRetrievalController {
  constructor(private readonly researchRetrieval: ResearchRetrievalService) {}

  @Post('search')
  @UseGuards(PermissionGuard)
  @RequirePermission('research.retrieval.search')
  @RequireFactoryScope()
  async search(@Req() request: FactoryOsRequest, @Body() body: ResearchRetrievalDto) {
    const context = request.factoryos;
    const userId = context?.userId ?? null;
    const tenantId = context?.tenantId ?? null;
    const factoryId = context?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException('Authenticated research factory context is missing');
    }
    return this.researchRetrieval.search(tenantId, factoryId, userId, body);
  }
}
