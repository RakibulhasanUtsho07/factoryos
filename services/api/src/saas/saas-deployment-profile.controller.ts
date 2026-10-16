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
import { CreateSaasDeploymentProfileDto, SaasDeploymentProfileScopeType } from './dto/create-saas-deployment-profile.dto';
import { TransitionSaasDeploymentProfileDto } from './dto/transition-saas-deployment-profile.dto';
import { SaasDeploymentProfileService } from './saas-deployment-profile.service';

type DeploymentProfileRequest = Request & {
  factoryos?: {
    userId: string | null;
    tenantId: string | null;
  };
};

@Controller('v2/saas/deployment-profiles')
export class SaasDeploymentProfileController {
  constructor(private readonly service: SaasDeploymentProfileService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.write')
  async create(@Req() request: DeploymentProfileRequest, @Body() body: CreateSaasDeploymentProfileDto) {
    const context = this.context(request);
    return this.service.createAssignment(context.tenantId, context.userId, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.read')
  async list(@Req() request: DeploymentProfileRequest, @Query('factory_id') factoryId?: string) {
    const context = this.context(request);
    return this.service.listLatest(context.tenantId, context.userId, factoryId);
  }

  @Get('effective')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.read')
  async effective(@Req() request: DeploymentProfileRequest, @Query('factory_id') factoryId?: string) {
    const context = this.context(request);
    return this.service.resolveEffective(context.tenantId, context.userId, factoryId);
  }

  @Get('tenant/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.read')
  async tenantHistory(@Req() request: DeploymentProfileRequest) {
    const context = this.context(request);
    return this.service.history(context.tenantId, context.userId, SaasDeploymentProfileScopeType.TENANT);
  }

  @Get('factories/:factoryId/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.read')
  async factoryHistory(
    @Req() request: DeploymentProfileRequest,
    @Param('factoryId', new ParseUUIDPipe()) factoryId: string,
  ) {
    const context = this.context(request);
    return this.service.history(context.tenantId, context.userId, SaasDeploymentProfileScopeType.FACTORY, factoryId);
  }

  @Post('tenant/transitions')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.control')
  async transitionTenant(
    @Req() request: DeploymentProfileRequest,
    @Body() body: TransitionSaasDeploymentProfileDto,
  ) {
    const context = this.context(request);
    return this.service.transition(context.tenantId, context.userId, SaasDeploymentProfileScopeType.TENANT, undefined, body);
  }

  @Post('factories/:factoryId/transitions')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.control')
  async transitionFactory(
    @Req() request: DeploymentProfileRequest,
    @Param('factoryId', new ParseUUIDPipe()) factoryId: string,
    @Body() body: TransitionSaasDeploymentProfileDto,
  ) {
    const context = this.context(request);
    return this.service.transition(context.tenantId, context.userId, SaasDeploymentProfileScopeType.FACTORY, factoryId, body);
  }

  private context(request: DeploymentProfileRequest): { tenantId: string; userId: string } {
    // Verified authentication context is authoritative; tenant/user headers and body identifiers are ignored.
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) {
      throw new UnauthorizedException('Authenticated deployment profile context is missing');
    }
    return { tenantId, userId };
  }
}
