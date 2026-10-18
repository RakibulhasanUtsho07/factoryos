import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  IntegrationConnectorDecisionDto,
  ListIntegrationConnectorsDto,
  RegisterIntegrationConnectorDto,
  RotateIntegrationSecretDto,
} from './dto/integration.dto';
import { IntegrationService } from './integration.service';

interface IntegrationRequestContext {
  requestId: string | null;
  traceId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type AuthenticatedIntegrationRequest = Request & { factoryos?: IntegrationRequestContext };
type WebhookRequest = Request & { rawBody?: Buffer; factoryos?: IntegrationRequestContext };

function scope(request: AuthenticatedIntegrationRequest) {
  const userId = request.factoryos?.userId ?? null;
  const tenantId = request.factoryos?.tenantId ?? null;
  const factoryId = request.factoryos?.factoryId ?? null;
  if (!userId || !tenantId || !factoryId) {
    throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
  }
  return { userId, tenantId, factoryId };
}

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationService) {}

  @Post('connectors')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.write')
  @RequireFactoryScope()
  async register(
    @Req() request: AuthenticatedIntegrationRequest,
    @Body() body: RegisterIntegrationConnectorDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const ctx = scope(request);
    return this.service.registerConnector(ctx.userId, ctx.tenantId, ctx.factoryId, body, idempotencyKey ?? null);
  }

  @Get('connectors')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.read')
  @RequireFactoryScope()
  async list(
    @Req() request: AuthenticatedIntegrationRequest,
    @Query() query: ListIntegrationConnectorsDto,
  ) {
    const ctx = scope(request);
    return this.service.listConnectors(ctx.userId, ctx.tenantId, ctx.factoryId, query.status);
  }

  @Get('connectors/:connectorId')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.read')
  @RequireFactoryScope()
  async get(
    @Req() request: AuthenticatedIntegrationRequest,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
  ) {
    const ctx = scope(request);
    return this.service.getConnector(ctx.userId, ctx.tenantId, ctx.factoryId, connectorId);
  }

  @Get('connectors/:connectorId/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.read')
  @RequireFactoryScope()
  async history(
    @Req() request: AuthenticatedIntegrationRequest,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
  ) {
    const ctx = scope(request);
    return this.service.listHistory(ctx.userId, ctx.tenantId, ctx.factoryId, connectorId);
  }

  @Post('connectors/:connectorId/activate')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.approve')
  @RequireFactoryScope()
  async activate(
    @Req() request: AuthenticatedIntegrationRequest,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body() body: IntegrationConnectorDecisionDto,
  ) {
    const ctx = scope(request);
    return this.service.transitionConnector(ctx.userId, ctx.tenantId, ctx.factoryId, connectorId, 'ACTIVATE', body.reason);
  }

  @Post('connectors/:connectorId/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.approve')
  @RequireFactoryScope()
  async reject(
    @Req() request: AuthenticatedIntegrationRequest,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body() body: IntegrationConnectorDecisionDto,
  ) {
    const ctx = scope(request);
    return this.service.transitionConnector(ctx.userId, ctx.tenantId, ctx.factoryId, connectorId, 'REJECT', body.reason);
  }

  @Post('connectors/:connectorId/pause')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.write')
  @RequireFactoryScope()
  async pause(
    @Req() request: AuthenticatedIntegrationRequest,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body() body: IntegrationConnectorDecisionDto,
  ) {
    const ctx = scope(request);
    return this.service.transitionConnector(ctx.userId, ctx.tenantId, ctx.factoryId, connectorId, 'PAUSE', body.reason);
  }

  @Post('connectors/:connectorId/resume')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.approve')
  @RequireFactoryScope()
  async resume(
    @Req() request: AuthenticatedIntegrationRequest,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body() body: IntegrationConnectorDecisionDto,
  ) {
    const ctx = scope(request);
    return this.service.transitionConnector(ctx.userId, ctx.tenantId, ctx.factoryId, connectorId, 'RESUME', body.reason);
  }

  @Post('connectors/:connectorId/rotate-secret')
  @UseGuards(PermissionGuard)
  @RequirePermission('integrations.connectors.approve')
  @RequireFactoryScope()
  async rotateSecret(
    @Req() request: AuthenticatedIntegrationRequest,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body() body: RotateIntegrationSecretDto,
  ) {
    const ctx = scope(request);
    return this.service.rotateSecret(ctx.userId, ctx.tenantId, ctx.factoryId, connectorId, body.secret_reference, body.reason);
  }

  @Post('webhooks/:connectorId')
  @HttpCode(202)
  async webhook(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Req() request: WebhookRequest,
    @Headers('x-factoryos-timestamp') timestamp?: string,
    @Headers('x-factoryos-event-id') externalEventId?: string,
    @Headers('x-factoryos-signature') signature?: string,
  ) {
    return this.service.receiveWebhook(connectorId, request, timestamp, externalEventId, signature);
  }
}
