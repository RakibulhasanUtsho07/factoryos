import {
  Body,
  Controller,
  Get,
  Headers,
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
import { IssueEdgeDeviceCredentialDto } from './dto/issue-edge-device-credential.dto';
import { RegisterEdgeDeviceDto } from './dto/register-edge-device.dto';
import { SetEdgeDeviceStatusDto } from './dto/set-edge-device-status.dto';
import { SyncEdgeObservationsDto } from './dto/sync-edge-observations.dto';
import { EdgeDeviceCredentialService } from './edge-device-credential.service';
import { EdgeDeviceGatewayService } from './edge-device-gateway.service';

interface EdgeRequestContext {
  requestId: string;
  traceId: string;
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type EdgeRequest = Request & { factoryos?: EdgeRequestContext };

@Controller('v2/edge')
export class EdgeDeviceGatewayController {
  constructor(
    private readonly edgeService: EdgeDeviceGatewayService,
    private readonly credentialService: EdgeDeviceCredentialService,
  ) {}

  @Post('devices')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.write')
  @RequireFactoryScope()
  async registerDevice(@Req() request: EdgeRequest, @Body() body: RegisterEdgeDeviceDto) {
    const context = this.requireContext(request);
    return this.edgeService.registerDevice(
      context.tenantId, context.factoryId, context.userId, body, context.auditContext,
    );
  }

  @Get('devices')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.read')
  @RequireFactoryScope()
  async listDevices(
    @Req() request: EdgeRequest,
    @Query('limit') rawLimit?: string,
    @Query('offset') rawOffset?: string,
  ) {
    const context = this.requireContext(request);
    return this.edgeService.listDevices(
      context.tenantId, context.factoryId, context.userId,
      rawLimit === undefined ? 25 : Number(rawLimit),
      rawOffset === undefined ? 0 : Number(rawOffset),
    );
  }

  @Post('devices/:deviceId/status')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.control')
  @RequireFactoryScope()
  async setDeviceStatus(
    @Req() request: EdgeRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: SetEdgeDeviceStatusDto,
  ) {
    const context = this.requireContext(request);
    return this.edgeService.setDeviceStatus(
      context.tenantId, context.factoryId, context.userId, deviceId, body, context.auditContext,
    );
  }

  @Post('devices/:deviceId/credentials')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.credentials.manage')
  @RequireFactoryScope()
  async issueDeviceCredential(
    @Req() request: EdgeRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: IssueEdgeDeviceCredentialDto,
  ) {
    const context = this.requireContext(request);
    return this.credentialService.issueCredential(
      context.tenantId, context.factoryId, context.userId, deviceId, body, context.auditContext,
    );
  }

  @Post('devices/:deviceId/credentials/:credentialId/revoke')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.credentials.manage')
  @RequireFactoryScope()
  async revokeDeviceCredential(
    @Req() request: EdgeRequest,
    @Param('deviceId') deviceId: string,
    @Param('credentialId') credentialId: string,
  ) {
    const context = this.requireContext(request);
    return this.credentialService.revokeCredential(
      context.tenantId, context.factoryId, context.userId,
      deviceId, credentialId, context.auditContext,
    );
  }

  /**
   * Device ingress trusts the credential-bound scope, not caller-supplied tenant/factory headers.
   * The credential's active state is revalidated by the service inside ingestion transactions.
   */
  @Post('device-ingest/:deviceId')
  async ingestAsDevice(
    @Req() request: EdgeRequest,
    @Headers('authorization') authorization: string | undefined,
    @Param('deviceId') deviceId: string,
    @Body() body: SyncEdgeObservationsDto,
  ) {
    const authenticated = await this.credentialService.authenticateDeviceToken(authorization, deviceId);
    return this.edgeService.syncObservations(
      authenticated.tenantId, authenticated.factoryId, null, authenticated.deviceId, body,
      {
        requestId: request.factoryos?.requestId ?? null,
        correlationId: request.factoryos?.traceId ?? null,
      },
      authenticated.credentialId,
    );
  }

  @Post('devices/:deviceId/sync')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.telemetry.ingest')
  @RequireFactoryScope()
  async syncObservations(
    @Req() request: EdgeRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: SyncEdgeObservationsDto,
  ) {
    const context = this.requireContext(request);
    return this.edgeService.syncObservations(
      context.tenantId, context.factoryId, context.userId, deviceId, body, context.auditContext,
    );
  }

  @Get('devices/:deviceId/observations')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.telemetry.read')
  @RequireFactoryScope()
  async listObservations(
    @Req() request: EdgeRequest,
    @Param('deviceId') deviceId: string,
    @Query('limit') rawLimit?: string,
    @Query('offset') rawOffset?: string,
  ) {
    const context = this.requireContext(request);
    return this.edgeService.listObservations(
      context.tenantId, context.factoryId, context.userId, deviceId,
      rawLimit === undefined ? 25 : Number(rawLimit),
      rawOffset === undefined ? 0 : Number(rawOffset),
    );
  }

  private requireContext(request: EdgeRequest) {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Verified FactoryOS factory context is required');
    }
    return {
      userId: context.userId,
      tenantId: context.tenantId,
      factoryId: context.factoryId,
      auditContext: {
        requestId: context.requestId ?? null,
        correlationId: context.traceId ?? null,
      },
    };
  }
}
