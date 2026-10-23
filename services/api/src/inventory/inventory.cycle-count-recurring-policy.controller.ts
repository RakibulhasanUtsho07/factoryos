import {
  BadRequestException,
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
import { CreateInventoryCycleCountRecurringPolicyDto } from './dto/create-inventory-cycle-count-recurring-policy.dto';
import { InventoryCycleCountRecurringPolicyService } from './inventory.cycle-count-recurring-policy.service';

interface RecurringPolicyRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type RecurringPolicyRequest = Request & { factoryos?: RecurringPolicyRequestContext };

@Controller('inventory/cycle-count-recurring-policies')
export class InventoryCycleCountRecurringPolicyController {
  constructor(private readonly policyService: InventoryCycleCountRecurringPolicyService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async createPolicy(
    @Req() request: RecurringPolicyRequest,
    @Body() body: CreateInventoryCycleCountRecurringPolicyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.policyService.createPolicy(
      context.userId, context.tenantId, context.factoryId, body,
      idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listPolicies(
    @Req() request: RecurringPolicyRequest,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    return this.policyService.listPolicies(
      context.userId, context.tenantId, context.factoryId,
      { status, limit: rawLimit === undefined ? 50 : Number(rawLimit) },
    );
  }

  /**
   * Deployment scheduler entry point. This route materializes due tasks; the
   * service does not pretend to run an in-process cron worker.
   */
  @Post('materialize-due')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async materializeDue(
    @Req() request: RecurringPolicyRequest,
    @Query('limit') rawLimit?: string,
  ) {
    const context = this.requireContext(request);
    if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return this.policyService.materializeDue(
      context.userId, context.tenantId, context.factoryId,
      rawLimit === undefined ? 50 : Number(rawLimit),
      context.requestId, context.traceId,
    );
  }

  @Post(':policyId/pause')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async pausePolicy(
    @Req() request: RecurringPolicyRequest,
    @Param('policyId', new ParseUUIDPipe()) policyId: string,
  ) {
    const context = this.requireContext(request);
    return this.policyService.pausePolicy(
      context.userId, context.tenantId, context.factoryId, policyId,
      context.requestId, context.traceId,
    );
  }

  @Post(':policyId/resume')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async resumePolicy(
    @Req() request: RecurringPolicyRequest,
    @Param('policyId', new ParseUUIDPipe()) policyId: string,
  ) {
    const context = this.requireContext(request);
    return this.policyService.resumePolicy(
      context.userId, context.tenantId, context.factoryId, policyId,
      context.requestId, context.traceId,
    );
  }

  @Post(':policyId/retire')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async retirePolicy(
    @Req() request: RecurringPolicyRequest,
    @Param('policyId', new ParseUUIDPipe()) policyId: string,
  ) {
    const context = this.requireContext(request);
    return this.policyService.retirePolicy(
      context.userId, context.tenantId, context.factoryId, policyId,
      context.requestId, context.traceId,
    );
  }

  private requireContext(request: RecurringPolicyRequest) {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Verified FactoryOS factory context is required');
    }
    return {
      userId: context.userId,
      tenantId: context.tenantId,
      factoryId: context.factoryId,
      requestId: context.requestId,
      traceId: context.traceId,
    };
  }
}
