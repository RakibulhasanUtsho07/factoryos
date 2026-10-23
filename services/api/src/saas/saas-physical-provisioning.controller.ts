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
import { ExecuteSaasPhysicalOperationDto } from './dto/execute-saas-physical-operation.dto';
import { SaasPhysicalProvisioningService } from './saas-physical-provisioning.service';

type PhysicalOperationRequest = Request & {
  factoryos?: { userId: string | null; tenantId: string | null };
};

@Controller('v2/saas/physical-provisioning')
export class SaasPhysicalProvisioningController {
  constructor(private readonly service: SaasPhysicalProvisioningService) {}

  @Post('sandboxes/:id/provision')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.sandboxes.control')
  async provisionSandbox(
    @Req() request: PhysicalOperationRequest,
    @Param('id', new ParseUUIDPipe()) sandboxId: string,
    @Body() body: ExecuteSaasPhysicalOperationDto,
  ) {
    const context = this.context(request);
    return this.service.provisionSandbox(context.tenantId, context.userId, sandboxId, body);
  }

  @Post('deployment-profiles/:id/provision')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.deployment_profiles.control')
  async provisionDeploymentProfile(
    @Req() request: PhysicalOperationRequest,
    @Param('id', new ParseUUIDPipe()) profileVersionId: string,
    @Body() body: ExecuteSaasPhysicalOperationDto,
  ) {
    const context = this.context(request);
    return this.service.provisionDeploymentProfile(context.tenantId, context.userId, profileVersionId, body);
  }

  @Post('releases/:rolloutKey/deploy')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.releases.promote')
  async deployRelease(
    @Req() request: PhysicalOperationRequest,
    @Param('rolloutKey') rolloutKey: string,
    @Body() body: ExecuteSaasPhysicalOperationDto,
  ) {
    const context = this.context(request);
    return this.service.deployRelease(context.tenantId, context.userId, rolloutKey, body);
  }

  @Get('runs')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.physical_provisioning.read')
  async runs(
    @Req() request: PhysicalOperationRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const context = this.context(request);
    return this.service.listRuns(
      context.tenantId,
      context.userId,
      limit === undefined ? 25 : Number(limit),
      offset === undefined ? 0 : Number(offset),
    );
  }

  @Get('runs/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.physical_provisioning.read')
  async run(
    @Req() request: PhysicalOperationRequest,
    @Param('id', new ParseUUIDPipe()) runId: string,
  ) {
    const context = this.context(request);
    return this.service.getRun(context.tenantId, context.userId, runId);
  }

  private context(request: PhysicalOperationRequest): { tenantId: string; userId: string } {
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) throw new UnauthorizedException('Authenticated physical-provisioning context is missing');
    return { tenantId, userId };
  }
}
