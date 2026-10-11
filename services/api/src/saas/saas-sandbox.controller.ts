import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequirePermission } from '../iam/require-permission.decorator';
import { ApproveSaasSandboxMaskedDataDto } from './dto/approve-saas-sandbox-masked-data.dto';
import { CreateSaasSandboxEnvironmentDto } from './dto/create-saas-sandbox-environment.dto';
import { TransitionSaasSandboxEnvironmentDto } from './dto/transition-saas-sandbox-environment.dto';
import { SaasSandboxService } from './saas-sandbox.service';

type SandboxRequest = Request & {
  factoryos?: {
    userId: string | null;
    tenantId: string | null;
  };
};

@Controller('v2/saas/sandboxes')
export class SaasSandboxController {
  constructor(private readonly service: SaasSandboxService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.sandboxes.write')
  async create(@Req() request: SandboxRequest, @Body() body: CreateSaasSandboxEnvironmentDto) {
    const context = this.context(request);
    return this.service.createEnvironment(context.tenantId, context.userId, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.sandboxes.read')
  async list(@Req() request: SandboxRequest) {
    const context = this.context(request);
    return this.service.listEnvironments(context.tenantId, context.userId);
  }

  @Get(':id/events')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.sandboxes.read')
  async events(
    @Req() request: SandboxRequest,
    @Param('id', new ParseUUIDPipe()) environmentId: string,
  ) {
    const context = this.context(request);
    return this.service.listEvents(context.tenantId, context.userId, environmentId);
  }

  @Post(':id/approve-masked-data')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.sandboxes.approve_masked_data')
  async approveMaskedData(
    @Req() request: SandboxRequest,
    @Param('id', new ParseUUIDPipe()) environmentId: string,
    @Body() body: ApproveSaasSandboxMaskedDataDto,
  ) {
    const context = this.context(request);
    return this.service.approveMaskedData(context.tenantId, context.userId, environmentId, body);
  }

  @Post(':id/transitions')
  @UseGuards(PermissionGuard)
  @RequirePermission('saas.sandboxes.control')
  async transition(
    @Req() request: SandboxRequest,
    @Param('id', new ParseUUIDPipe()) environmentId: string,
    @Body() body: TransitionSaasSandboxEnvironmentDto,
  ) {
    const context = this.context(request);
    return this.service.transition(context.tenantId, context.userId, environmentId, body);
  }

  private context(request: SandboxRequest): { tenantId: string; userId: string } {
    // Verified request identity is authoritative; caller-supplied headers are never trusted.
    const tenantId = request.factoryos?.tenantId ?? null;
    const userId = request.factoryos?.userId ?? null;
    if (!tenantId || !userId) {
      throw new UnauthorizedException('Authenticated SaaS sandbox context is missing');
    }
    return { tenantId, userId };
  }
}
