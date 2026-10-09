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

import { CreatePolicyDto } from './dto/create-policy.dto';
import { CreateRiskClassDto } from './dto/create-risk-class.dto';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { EvaluatePolicyDto } from './dto/evaluate-policy.dto';
import { ListApprovalsDto } from './dto/list-approvals.dto';
import { ListPoliciesDto } from './dto/list-policies.dto';
import { ListRiskClassesDto } from './dto/list-risk-classes.dto';
import { PolicyService } from './policy.service';

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

@Controller('admin/v1')
export class PolicyController {
  constructor(
    private readonly policyService: PolicyService,
  ) {}

  // ============================================================
  // RISK CLASSES
  // ============================================================

  @Get('risk-classes')
  @UseGuards(PermissionGuard)
  @RequirePermission('risk_classes.read')
  async listRiskClasses(
    @Req() request: FactoryOsRequest,
    @Query() query: ListRiskClassesDto,
  ) {
    const { tenantId } = this.getAuthenticatedContext(request);

    return this.policyService.listRiskClasses(
      tenantId,
      {
        code: query.code,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      },
    );
  }

  @Get('risk-classes/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('risk_classes.read')
  async getRiskClass(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) riskClassId: string,
  ) {
    const { tenantId } = this.getAuthenticatedContext(request);

    return this.policyService.getRiskClass(
      tenantId,
      riskClassId,
    );
  }

  @Post('risk-classes')
  @UseGuards(PermissionGuard)
  @RequirePermission('risk_classes.write')
  async createRiskClass(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateRiskClassDto,
  ) {
    const { userId, tenantId } =
      this.getAuthenticatedContext(request);

    return this.policyService.createRiskClass(
      tenantId,
      userId,
      {
        code: body.code,
        name: body.name,
        description: body.description,
        defaultApprovalRequired:
          body.default_approval_required,
        status: body.status,
        effectiveFrom: body.effective_from,
        effectiveTo: body.effective_to,
      },
    );
  }

  // ============================================================
  // POLICIES
  // ============================================================

  @Get('policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('policies.read')
  async listPolicies(
    @Req() request: FactoryOsRequest,
    @Query() query: ListPoliciesDto,
  ) {
    const { tenantId } = this.getAuthenticatedContext(request);

    return this.policyService.listPolicies(
      tenantId,
      {
        key: query.key,
        action: query.action,
        effect: query.effect,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      },
    );
  }

  @Get('policies/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('policies.read')
  async getPolicy(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) policyId: string,
  ) {
    const { tenantId } = this.getAuthenticatedContext(request);

    return this.policyService.getPolicy(
      tenantId,
      policyId,
    );
  }

  @Post('policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('policies.write')
  async createPolicy(
    @Req() request: FactoryOsRequest,
    @Body() body: CreatePolicyDto,
  ) {
    const { userId, tenantId } =
      this.getAuthenticatedContext(request);

    return this.policyService.createPolicy(
      tenantId,
      userId,
      {
        key: body.key,
        action: body.action,
        resourceType: body.resource_type,
        effect: body.effect,
        riskClassId: body.risk_class_id,
        approvalRequired: body.approval_required,
        conditions: body.conditions,
        approvalRoute: body.approval_route,
        status: body.status,
        priority: body.priority,
        effectiveFrom: body.effective_from,
        effectiveTo: body.effective_to,
        changeReason: body.change_reason,
      },
    );
  }

  // Keep the runtime evaluator separate from the public
  // /api/v1/policies rule-promotion contract described by the SRS.
  @Post('policies/evaluate')
  @UseGuards(PermissionGuard)
  @RequirePermission('policies.evaluate')
  async evaluatePolicy(
    @Req() request: FactoryOsRequest,
    @Body() body: EvaluatePolicyDto,
  ) {
    const { tenantId } = this.getAuthenticatedContext(request);

    return this.policyService.evaluatePolicy(
      tenantId,
      {
        action: body.action,
        resourceType: body.resource_type,
        attributes: body.attributes,
        effectiveAt: body.effective_at,
      },
    );
  }

  // ============================================================
  // APPROVALS
  // ============================================================

  @Get('approvals')
  @UseGuards(PermissionGuard)
  @RequirePermission('approvals.read')
  async listApprovals(
    @Req() request: FactoryOsRequest,
    @Query() query: ListApprovalsDto,
  ) {
    const { tenantId } = this.getAuthenticatedContext(request);

    return this.policyService.listApprovals(
      tenantId,
      {
        status: query.status,
        action: query.action,
        limit: query.limit,
        offset: query.offset,
      },
    );
  }

  @Get('approvals/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('approvals.read')
  async getApproval(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) approvalId: string,
  ) {
    const { tenantId } = this.getAuthenticatedContext(request);

    return this.policyService.getApproval(
      tenantId,
      approvalId,
    );
  }

  @Post('approvals/:id/decide')
  @UseGuards(PermissionGuard)
  @RequirePermission('approvals.decide')
  async decideApproval(
    @Req() request: FactoryOsRequest,
    @Param('id', new ParseUUIDPipe()) approvalId: string,
    @Body() body: DecideApprovalDto,
  ) {
    const { tenantId, userId } =
      this.getAuthenticatedContext(request);

    return this.policyService.decideApproval(
      tenantId,
      userId,
      approvalId,
      body.decision,
      body.reason,
    );
  }

  private getAuthenticatedContext(
    request: FactoryOsRequest,
  ): {
    userId: string;
    tenantId: string;
  } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;

    if (!userId || !tenantId) {
      throw new UnauthorizedException(
        'Authenticated user context is missing',
      );
    }

    return {
      userId,
      tenantId,
    };
  }
}
