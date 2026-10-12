import {
  Body,
  Controller,
  Headers,
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
import { RegisterEdgeDeviceDto } from './dto/register-edge-device.dto';
import { IssueEdgeDeviceCredentialDto } from './dto/issue-edge-device-credential.dto';
import { SetEdgeDeviceStatusDto } from './dto/set-edge-device-status.dto';
import { SyncEdgeObservationsDto } from './dto/sync-edge-observations.dto';
import { EdgeDeviceHealthReportDto } from './dto/edge-device-health.dto';
import { EdgeDeviceGatewayService } from './edge-device-gateway.service';
import { EdgeDeviceCredentialService } from './edge-device-credential.service';
import { EdgeDeviceHealthService } from './edge-device-health.service';

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

@Controller('v2/edge')
export class EdgeDeviceGatewayController {
  constructor(
    private readonly edgeService: EdgeDeviceGatewayService,
    private readonly credentialService: EdgeDeviceCredentialService,
    private readonly healthService: EdgeDeviceHealthService,
  ) {}

  @Post('devices')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.write')
  @RequireFactoryScope()
  async registerDevice(
    @Req() request: FactoryOsRequest,
    @Body() body: RegisterEdgeDeviceDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.edgeService.registerDevice(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
      context.auditContext,
    );
  }

  @Post('devices/:deviceId/credentials')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.credentials.manage')
  @RequireFactoryScope()
  async issueDeviceCredential(
    @Req() request: FactoryOsRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: IssueEdgeDeviceCredentialDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.credentialService.issueCredential(
      context.tenantId,
      context.factoryId,
      context.userId,
      deviceId,
      body,
      context.auditContext,
    );
  }

  @Post('devices/:deviceId/credentials/:credentialId/revoke')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.credentials.manage')
  @RequireFactoryScope()
  async revokeDeviceCredential(
    @Req() request: FactoryOsRequest,
    @Param('deviceId') deviceId: string,
    @Param('credentialId') credentialId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.credentialService.revokeCredential(
      context.tenantId,
      context.factoryId,
      context.userId,
      deviceId,
      credentialId,
      context.auditContext,
    );
  }

  /**
   * Machine-to-machine ingress. It deliberately does not use the human
   * permission guard: the opaque device token determines tenant, factory,
   * device, and credential identity; the service re-checks credential status
   * within the ingestion transaction.
   */
  @Post('device-ingest/:deviceId')
  async ingestAsDevice(
    @Req() request: FactoryOsRequest,
    @Headers('authorization') authorization: string | undefined,
    @Param('deviceId') deviceId: string,
    @Body() body: SyncEdgeObservationsDto,
  ) {
    const authenticated = await this.credentialService.authenticateDeviceToken(
      authorization,
      deviceId,
    );
    return this.edgeService.syncObservations(
      authenticated.tenantId,
      authenticated.factoryId,
      null,
      authenticated.deviceId,
      body,
      {
        requestId: request.factoryos?.requestId ?? null,
        correlationId: request.factoryos?.traceId ?? null,
      },
      authenticated.credentialId,
    );
  }

  /**
   * Device-signed operational report. All model/drift fields are treated as
   * telemetry asserted by the edge runtime, never as verified model decisions.
   */
  @Post('device-health/:deviceId')
  async reportDeviceHealth(
    @Req() request: FactoryOsRequest,
    @Headers('authorization') authorization: string | undefined,
    @Param('deviceId') deviceId: string,
    @Body() body: EdgeDeviceHealthReportDto,
  ) {
    const authenticated = await this.credentialService.authenticateDeviceToken(
      authorization,
      deviceId,
    );
    return this.healthService.recordReport(
      authenticated.tenantId,
      authenticated.factoryId,
      authenticated.deviceId,
      authenticated.credentialId,
      body,
      {
        requestId: request.factoryos?.requestId ?? null,
        correlationId: request.factoryos?.traceId ?? null,
      },
    );
  }

  @Get('devices/:deviceId/health')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.health.read')
  @RequireFactoryScope()
  async listDeviceHealth(
    @Req() request: FactoryOsRequest,
    @Param('deviceId') deviceId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.healthService.listReports(
      context.tenantId,
      context.factoryId,
      context.userId,
      deviceId,
      limit === undefined ? 25 : Number(limit),
      offset === undefined ? 0 : Number(offset),
    );
  }

  @Get('devices')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.read')
  @RequireFactoryScope()
  async listDevices(
    @Req() request: FactoryOsRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.edgeService.listDevices(
      context.tenantId,
      context.factoryId,
      context.userId,
      limit === undefined ? 25 : Number(limit),
      offset === undefined ? 0 : Number(offset),
    );
  }

  @Post('devices/:deviceId/status')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.devices.control')
  @RequireFactoryScope()
  async setDeviceStatus(
    @Req() request: FactoryOsRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: SetEdgeDeviceStatusDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.edgeService.setDeviceStatus(
      context.tenantId,
      context.factoryId,
      context.userId,
      deviceId,
      body,
      context.auditContext,
    );
  }

  @Post('devices/:deviceId/sync')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.telemetry.ingest')
  @RequireFactoryScope()
  async syncObservations(
    @Req() request: FactoryOsRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: SyncEdgeObservationsDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.edgeService.syncObservations(
      context.tenantId,
      context.factoryId,
      context.userId,
      deviceId,
      body,
      context.auditContext,
    );
  }

  @Get('devices/:deviceId/observations')
  @UseGuards(PermissionGuard)
  @RequirePermission('edge.telemetry.read')
  @RequireFactoryScope()
  async listObservations(
    @Req() request: FactoryOsRequest,
    @Param('deviceId') deviceId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.edgeService.listObservations(
      context.tenantId,
      context.factoryId,
      context.userId,
      deviceId,
      limit === undefined ? 25 : Number(limit),
      offset === undefined ? 0 : Number(offset),
    );
  }

  private getAuthenticatedFactoryContext(request: FactoryOsRequest) {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException(
        'Authenticated edge factory context is missing',
      );
    }
    return {
      userId,
      tenantId,
      factoryId,
      auditContext: {
        requestId: request.factoryos?.requestId ?? null,
        correlationId: request.factoryos?.traceId ?? null,
      },
    };
  }
}
