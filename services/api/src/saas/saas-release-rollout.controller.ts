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
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateSaasReleaseRolloutDto, SaasReleaseChannel } from './dto/create-saas-release-rollout.dto';
import { PromoteSaasReleaseRolloutDto } from './dto/promote-saas-release-rollout.dto';
import { RollbackSaasReleaseRolloutDto } from './dto/rollback-saas-release-rollout.dto';
import { TransitionSaasReleaseRolloutDto } from './dto/transition-saas-release-rollout.dto';
import { SaasReleaseRolloutService } from './saas-release-rollout.service';

type ReleaseRequest = Request & {
  factoryos?: {
    userId: string | null;
    tenantId: string | null;
  };
};

@Controller('v2/saas/releases')
export class SaasReleaseRolloutController {
  constructor(private readonly service: SaasReleaseRolloutService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.write')
  async create(@Req() request: ReleaseRequest, @Body() body: CreateSaasReleaseRolloutDto) {
    const context = this.context(request);
    return this.service.createRollout(context.tenantId, context.userId, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.read')
  async list(@Req() request: ReleaseRequest) {
    const context = this.context(request);
    return this.service.listLatest(context.tenantId, context.userId);
  }

  @Get('resolve')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.read')
  async resolve(
    @Req() request: ReleaseRequest,
    @Query('channel') channel: SaasReleaseChannel,
    @Query('factory_id') factoryId?: string,
    @Query('module_key') moduleKey?: string,
    @Query('agent_key') agentKey?: string,
    @Query('subject_key') subjectKey?: string,
  ) {
    const context = this.context(request);
    return this.service.resolveEffectiveRelease(context.tenantId, context.userId, {
      channel,
      factoryId,
      moduleKey,
      agentKey,
      subjectKey: subjectKey ?? '',
    });
  }

  @Get(':rolloutKey/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.read')
  async history(@Req() request: ReleaseRequest, @Param('rolloutKey') rolloutKey: string) {
    const context = this.context(request);
    return this.service.listHistory(context.tenantId, context.userId, rolloutKey);
  }

  @Post(':rolloutKey/promotions')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.promote')
  async promote(
    @Req() request: ReleaseRequest,
    @Param('rolloutKey') rolloutKey: string,
    @Body() body: PromoteSaasReleaseRolloutDto,
  ) {
    const context = this.context(request);
    return this.service.promoteRollout(context.tenantId, context.userId, rolloutKey, body);
  }

  @Post(':rolloutKey/rollback')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.rollback')
  async rollback(
    @Req() request: ReleaseRequest,
    @Param('rolloutKey') rolloutKey: string,
    @Body() body: RollbackSaasReleaseRolloutDto,
  ) {
    const context = this.context(request);
    return this.service.rollback(context.tenantId, context.userId, rolloutKey, body);
  }

  @Post(':rolloutKey/transitions')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.control')
  async transition(
    @Req() request: ReleaseRequest,
    @Param('rolloutKey') rolloutKey: string,
    @Body() body: TransitionSaasReleaseRolloutDto,
  ) {
    const context = this.context(request);
    return this.service.transition(context.tenantId, context.userId, rolloutKey, body);
  }

  private context(request: ReleaseRequest): { tenantId: string; userId: string } {
    // The authenticated context is authoritative; caller-supplied IDs are ignored.
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) {
      throw new UnauthorizedException('Authenticated SaaS release context is missing');
    }
    return { tenantId, userId };
  }
}
