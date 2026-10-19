import {
  Body,
  Controller,
  Get,
  Headers,
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
  IngestOtTelemetryBatchDto,
  OtDeviceTransitionDto,
  RegisterOtDeviceDto,
} from './dto/ot-device.dto';
import { OtDeviceService } from './ot-device.service';

interface OtRequestContext {
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type AuthenticatedOtRequest = Request & { factoryos?: OtRequestContext };

function scope(request: AuthenticatedOtRequest) {
  const userId = request.factoryos?.userId ?? null;
  const tenantId = request.factoryos?.tenantId ?? null;
  const factoryId = request.factoryos?.factoryId ?? null;
  if (!userId || !tenantId || !factoryId) {
    throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
  }
  return { userId, tenantId, factoryId };
}

@Controller('ot')
export class OtDeviceController {
  constructor(private readonly service: OtDeviceService) {}

  @Post('devices')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.devices.write')
  @RequireFactoryScope()
  register(
    @Req() request: AuthenticatedOtRequest,
    @Body() body: RegisterOtDeviceDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.register(scope(request), body, idempotencyKey);
  }

  @Get('devices')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.devices.read')
  @RequireFactoryScope()
  list(
    @Req() request: AuthenticatedOtRequest,
    @Query('status') status?: string,
    @Query('protocol') protocol?: string,
  ) {
    return this.service.listDevices(scope(request), { status, protocol });
  }

  @Get('devices/:deviceId')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.devices.read')
  @RequireFactoryScope()
  get(
    @Req() request: AuthenticatedOtRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
  ) {
    return this.service.getDevice(scope(request), deviceId);
  }

  @Get('devices/:deviceId/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.devices.read')
  @RequireFactoryScope()
  history(
    @Req() request: AuthenticatedOtRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
  ) {
    return this.service.listHistory(scope(request), deviceId);
  }

  @Post('devices/:deviceId/activate')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.devices.approve')
  @RequireFactoryScope()
  activate(
    @Req() request: AuthenticatedOtRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Body() body: OtDeviceTransitionDto,
  ) {
    return this.service.transition(scope(request), deviceId, 'ACTIVATE', body);
  }

  @Post('devices/:deviceId/pause')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.devices.write')
  @RequireFactoryScope()
  pause(
    @Req() request: AuthenticatedOtRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Body() body: OtDeviceTransitionDto,
  ) {
    return this.service.transition(scope(request), deviceId, 'PAUSE', body);
  }

  @Post('devices/:deviceId/revoke')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.devices.approve')
  @RequireFactoryScope()
  revoke(
    @Req() request: AuthenticatedOtRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Body() body: OtDeviceTransitionDto,
  ) {
    return this.service.transition(scope(request), deviceId, 'REVOKE', body);
  }

  @Post('devices/:deviceId/telemetry/batch')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.telemetry.ingest')
  @RequireFactoryScope()
  ingest(
    @Req() request: AuthenticatedOtRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Body() body: IngestOtTelemetryBatchDto,
  ) {
    return this.service.ingestTelemetry(scope(request), deviceId, body);
  }

  @Get('devices/:deviceId/telemetry')
  @UseGuards(PermissionGuard)
  @RequirePermission('ot.telemetry.read')
  @RequireFactoryScope()
  telemetry(
    @Req() request: AuthenticatedOtRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listTelemetry(scope(request), deviceId, limit);
  }
}
