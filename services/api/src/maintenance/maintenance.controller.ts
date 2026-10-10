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
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';

import { CreateMachineDto } from './dto/create-machine.dto';
import { ListMachineDowntimeDto } from './dto/list-machine-downtime.dto';
import { ListMachinesDto } from './dto/list-machines.dto';
import { LogMachineDowntimeDto } from './dto/log-machine-downtime.dto';
import { MaintenanceService } from './maintenance.service';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

interface AuthenticatedFactoryContext {
  requestId: string | null;
  traceId: string | null;
  userId: string;
  tenantId: string;
  factoryId: string;
}

@Controller('v1/maintenance')
export class MaintenanceController {
  constructor(
    private readonly maintenanceService: MaintenanceService,
  ) {}

  @Get('machines')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.machines.read')
  @RequireFactoryScope()
  async listMachines(
    @Req() request: FactoryOsRequest,
    @Query() query: ListMachinesDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.maintenanceService.listMachines(
      context.tenantId,
      context.factoryId,
      context.userId,
      query,
    );
  }

  @Post('machines')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.machines.write')
  @RequireFactoryScope()
  async createMachine(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateMachineDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.maintenanceService.createMachine(
      context.tenantId,
      context.factoryId,
      context.userId,
      body,
      context.requestId,
      context.traceId,
    );
  }

  @Get('downtime')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.downtime.read')
  @RequireFactoryScope()
  async listDowntime(
    @Req() request: FactoryOsRequest,
    @Query() query: ListMachineDowntimeDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.maintenanceService.listDowntime(
      context.tenantId,
      context.factoryId,
      context.userId,
      query,
    );
  }

  @Post('machines/:machineId/downtime')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.downtime.write')
  @RequireFactoryScope()
  async logDowntime(
    @Req() request: FactoryOsRequest,
    @Param('machineId', new ParseUUIDPipe()) machineId: string,
    @Body() body: LogMachineDowntimeDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.maintenanceService.logDowntime(
      context.tenantId,
      context.factoryId,
      context.userId,
      machineId,
      body,
      context.requestId,
      context.traceId,
    );
  }

  @Post('downtime/:eventId/close')
  @UseGuards(PermissionGuard)
  @RequirePermission('maintenance.downtime.write')
  @RequireFactoryScope()
  async closeDowntime(
    @Req() request: FactoryOsRequest,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.maintenanceService.closeDowntime(
      context.tenantId,
      context.factoryId,
      context.userId,
      eventId,
      context.requestId,
      context.traceId,
    );
  }

  private getAuthenticatedFactoryContext(
    request: FactoryOsRequest,
  ): AuthenticatedFactoryContext {
    const context = request.factoryos;
    const userId = context?.userId ?? null;
    const tenantId = context?.tenantId ?? null;
    const factoryId = context?.factoryId ?? null;

    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException(
        'Authenticated user, tenant, and authorized factory context are required',
      );
    }

    return {
      userId,
      tenantId,
      factoryId,
      requestId: context?.requestId ?? null,
      traceId: context?.traceId ?? null,
    };
  }
}
