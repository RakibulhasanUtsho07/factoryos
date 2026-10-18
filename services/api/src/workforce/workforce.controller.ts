import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  AssignWorkforceSkillDto,
  CreateWorkforceAssignmentDto,
  CreateWorkforceAttendanceEventDto,
  CreateWorkforceOvertimeDto,
  CreateWorkforceProductivityDto,
  CreateWorkforceShiftDto,
  CreateWorkforceSkillDto,
  CreateWorkforceWorkerDto,
  DecideWorkforceOvertimeDto,
  WorkforceAssignmentTransitionDto,
  WorkforceBiometricConsentDto,
  WorkforceDateQueryDto,
  WorkforceDateRangeQueryDto,
  WorkforceListQueryDto,
  WorkforceWorkerStatusDto,
} from './workforce.dto';
import { WorkforceContext, WorkforceService } from './workforce.service';

interface WorkforceRequestContext {
  requestId?: string | null;
  traceId?: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type WorkforceRequest = Request & { factoryos?: WorkforceRequestContext };

@Controller('workforce')
export class WorkforceController {
  constructor(private readonly service: WorkforceService) {}

  @Get('workers')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.workers.read')
  @RequireFactoryScope()
  listWorkers(@Req() request: WorkforceRequest, @Query() query: WorkforceListQueryDto) {
    return this.service.listWorkers(this.context(request), query);
  }

  @Post('workers')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.workers.manage')
  @RequireFactoryScope()
  createWorker(
    @Req() request: WorkforceRequest,
    @Body() dto: CreateWorkforceWorkerDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createWorker(this.context(request), dto, idempotencyKey ?? null);
  }

  @Post('workers/:workerId/status')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.workers.manage')
  @RequireFactoryScope()
  transitionWorker(
    @Req() request: WorkforceRequest,
    @Param('workerId', new ParseUUIDPipe()) workerId: string,
    @Body() dto: WorkforceWorkerStatusDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.transitionWorker(this.context(request), workerId, dto, idempotencyKey ?? null);
  }

  @Get('skills')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.skills.read')
  @RequireFactoryScope()
  listSkills(@Req() request: WorkforceRequest, @Query() query: WorkforceListQueryDto) {
    return this.service.listSkills(this.context(request), query);
  }

  @Post('skills')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.skills.manage')
  @RequireFactoryScope()
  createSkill(
    @Req() request: WorkforceRequest,
    @Body() dto: CreateWorkforceSkillDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createSkill(this.context(request), dto, idempotencyKey ?? null);
  }

  @Post('workers/:workerId/skills')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.skills.manage')
  @RequireFactoryScope()
  assignWorkerSkill(
    @Req() request: WorkforceRequest,
    @Param('workerId', new ParseUUIDPipe()) workerId: string,
    @Body() dto: AssignWorkforceSkillDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.assignWorkerSkill(this.context(request), workerId, dto, idempotencyKey ?? null);
  }

  @Post('workers/:workerId/biometric-consent')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.workers.manage')
  @RequireFactoryScope()
  recordBiometricConsent(
    @Req() request: WorkforceRequest,
    @Param('workerId', new ParseUUIDPipe()) workerId: string,
    @Body() dto: WorkforceBiometricConsentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.recordBiometricConsent(this.context(request), workerId, dto, idempotencyKey ?? null);
  }

  @Get('shifts')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.shifts.read')
  @RequireFactoryScope()
  listShifts(@Req() request: WorkforceRequest, @Query() query: WorkforceListQueryDto) {
    return this.service.listShifts(this.context(request), query);
  }

  @Post('shifts')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.shifts.manage')
  @RequireFactoryScope()
  createShift(
    @Req() request: WorkforceRequest,
    @Body() dto: CreateWorkforceShiftDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createShift(this.context(request), dto, idempotencyKey ?? null);
  }

  @Post('staffing')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.staffing.manage')
  @RequireFactoryScope()
  createAssignment(
    @Req() request: WorkforceRequest,
    @Body() dto: CreateWorkforceAssignmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createAssignment(this.context(request), dto, idempotencyKey ?? null);
  }

  @Post('staffing/:assignmentId/transition')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.staffing.manage')
  @RequireFactoryScope()
  transitionAssignment(
    @Req() request: WorkforceRequest,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() dto: WorkforceAssignmentTransitionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.transitionAssignment(this.context(request), assignmentId, dto, idempotencyKey ?? null);
  }

  @Get('staffing/coverage')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.staffing.read')
  @RequireFactoryScope()
  staffingCoverage(@Req() request: WorkforceRequest, @Query() query: WorkforceDateQueryDto) {
    return this.service.staffingCoverage(this.context(request), query);
  }

  @Post('attendance/events')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.attendance.capture')
  @RequireFactoryScope()
  captureAttendance(
    @Req() request: WorkforceRequest,
    @Body() dto: CreateWorkforceAttendanceEventDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.captureAttendance(this.context(request), dto, idempotencyKey ?? null);
  }

  @Get('attendance')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.attendance.read')
  @RequireFactoryScope()
  listAttendance(
    @Req() request: WorkforceRequest,
    @Query() query: WorkforceDateQueryDto,
    @Query('limit') rawLimit?: string,
  ) {
    return this.service.listAttendance(this.context(request), query, rawLimit === undefined ? undefined : Number(rawLimit));
  }

  @Post('overtime')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.overtime.request')
  @RequireFactoryScope()
  createOvertime(
    @Req() request: WorkforceRequest,
    @Body() dto: CreateWorkforceOvertimeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.createOvertime(this.context(request), dto, idempotencyKey ?? null);
  }

  @Get('overtime')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.attendance.read')
  @RequireFactoryScope()
  listOvertime(@Req() request: WorkforceRequest, @Query() query: WorkforceDateRangeQueryDto) {
    return this.service.listOvertime(this.context(request), query);
  }

  @Post('overtime/:overtimeId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.overtime.approve')
  @RequireFactoryScope()
  decideOvertime(
    @Req() request: WorkforceRequest,
    @Param('overtimeId', new ParseUUIDPipe()) overtimeId: string,
    @Body() dto: DecideWorkforceOvertimeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.decideOvertime(this.context(request), overtimeId, dto, idempotencyKey ?? null);
  }

  @Post('productivity/reports')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.productivity.capture')
  @RequireFactoryScope()
  captureProductivity(
    @Req() request: WorkforceRequest,
    @Body() dto: CreateWorkforceProductivityDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.captureProductivity(this.context(request), dto, idempotencyKey ?? null);
  }

  @Get('productivity/reports')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.productivity.read')
  @RequireFactoryScope()
  listProductivity(@Req() request: WorkforceRequest, @Query() query: WorkforceDateRangeQueryDto) {
    return this.service.listProductivity(this.context(request), query);
  }

  @Get('self/records')
  @UseGuards(PermissionGuard)
  @RequirePermission('workforce.self.read')
  @RequireFactoryScope()
  selfService(@Req() request: WorkforceRequest, @Query() query: WorkforceDateRangeQueryDto) {
    return this.service.selfService(this.context(request), query);
  }

  private context(request: WorkforceRequest): WorkforceContext {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
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
