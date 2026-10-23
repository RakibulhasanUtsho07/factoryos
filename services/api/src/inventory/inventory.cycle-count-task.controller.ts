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
import { CancelInventoryCycleCountTaskDto } from './dto/cancel-inventory-cycle-count-task.dto';
import { CreateInventoryCycleCountTaskDto } from './dto/create-inventory-cycle-count-task.dto';
import { InventoryCycleCountTaskService } from './inventory.cycle-count-task.service';

interface CycleCountTaskRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type CycleCountTaskRequest = Request & { factoryos?: CycleCountTaskRequestContext };

@Controller('inventory/cycle-count-tasks')
export class InventoryCycleCountTaskController {
  constructor(private readonly taskService: InventoryCycleCountTaskService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async createTask(
    @Req() request: CycleCountTaskRequest,
    @Body() body: CreateInventoryCycleCountTaskDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = this.requireContext(request);
    return this.taskService.createTask(
      context.userId, context.tenantId, context.factoryId, body,
      idempotencyKey ?? null, context.requestId, context.traceId,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.read')
  @RequireFactoryScope()
  async listTasks(
    @Req() request: CycleCountTaskRequest,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
    @Query('assigned_to_me') assignedToMe?: string,
  ) {
    const context = this.requireContext(request);
    if (assignedToMe !== undefined && !['true', 'false'].includes(assignedToMe)) {
      throw new BadRequestException('assigned_to_me must be true or false');
    }
    return this.taskService.listTasks(
      context.userId, context.tenantId, context.factoryId,
      {
        status,
        limit: rawLimit === undefined ? 50 : Number(rawLimit),
        assignedToMe: assignedToMe === 'true',
      },
    );
  }

  @Post(':taskId/start')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.reconcile')
  @RequireFactoryScope()
  async startTask(
    @Req() request: CycleCountTaskRequest,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    const context = this.requireContext(request);
    return this.taskService.startTask(
      context.userId, context.tenantId, context.factoryId, taskId,
      context.requestId, context.traceId,
    );
  }

  @Post(':taskId/cancel')
  @UseGuards(PermissionGuard)
  @RequirePermission('inventory.write')
  @RequireFactoryScope()
  async cancelTask(
    @Req() request: CycleCountTaskRequest,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() body: CancelInventoryCycleCountTaskDto,
  ) {
    const context = this.requireContext(request);
    return this.taskService.cancelTask(
      context.userId, context.tenantId, context.factoryId, taskId, body.cancellation_reason,
      context.requestId, context.traceId,
    );
  }

  private requireContext(request: CycleCountTaskRequest) {
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
