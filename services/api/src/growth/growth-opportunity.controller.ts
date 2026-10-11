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

import { CreateGrowthOpportunityDto } from './dto/create-growth-opportunity.dto';
import { RecordGrowthOpportunityDecisionDto } from './dto/record-growth-opportunity-decision.dto';
import { RecordGrowthOpportunityOutcomeDto } from './dto/record-growth-opportunity-outcome.dto';
import { GrowthOpportunityService } from './growth-opportunity.service';

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

@Controller('v2/growth/opportunities')
export class GrowthOpportunityController {
  constructor(private readonly opportunities: GrowthOpportunityService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.opportunities.write')
  @RequireFactoryScope()
  async create(@Req() request: FactoryOsRequest, @Body() body: CreateGrowthOpportunityDto) {
    const context = this.getContext(request);
    return this.opportunities.createOpportunity(context.tenantId, context.factoryId, context.userId, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.opportunities.read')
  @RequireFactoryScope()
  async list(
    @Req() request: FactoryOsRequest,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const context = this.getContext(request);
    return this.opportunities.listOpportunities(context.tenantId, context.factoryId, context.userId, {
      category,
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    });
  }

  @Get(':opportunityId')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.opportunities.read')
  @RequireFactoryScope()
  async get(@Req() request: FactoryOsRequest, @Param('opportunityId') opportunityId: string) {
    const context = this.getContext(request);
    return this.opportunities.getOpportunity(context.tenantId, context.factoryId, context.userId, opportunityId);
  }

  @Post(':opportunityId/decisions')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.opportunities.decisions.write')
  @RequireFactoryScope()
  async decide(
    @Req() request: FactoryOsRequest,
    @Param('opportunityId') opportunityId: string,
    @Body() body: RecordGrowthOpportunityDecisionDto,
  ) {
    const context = this.getContext(request);
    return this.opportunities.recordDecision(context.tenantId, context.factoryId, context.userId, opportunityId, body);
  }

  @Post(':opportunityId/outcomes')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.opportunities.outcomes.write')
  @RequireFactoryScope()
  async recordOutcome(
    @Req() request: FactoryOsRequest,
    @Param('opportunityId') opportunityId: string,
    @Body() body: RecordGrowthOpportunityOutcomeDto,
  ) {
    const context = this.getContext(request);
    return this.opportunities.recordOutcome(context.tenantId, context.factoryId, context.userId, opportunityId, body);
  }

  private getContext(request: FactoryOsRequest): { userId: string; tenantId: string; factoryId: string } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException('Authenticated growth factory context is missing');
    }
    return { userId, tenantId, factoryId };
  }
}
