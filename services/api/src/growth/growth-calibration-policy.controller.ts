import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateGrowthCalibrationPolicyDto } from './dto/create-growth-calibration-policy.dto';
import { DecideGrowthCalibrationPolicyDto } from './dto/decide-growth-calibration-policy.dto';
import { GrowthCalibrationPolicyService } from './growth-calibration-policy.service';

interface GrowthPolicyRequestContext {
  requestId: string | null;
  traceId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type GrowthPolicyRequest = Request & { factoryos?: GrowthPolicyRequestContext };

@Controller('growth')
export class GrowthCalibrationPolicyController {
  constructor(private readonly policies: GrowthCalibrationPolicyService) {}

  @Post('calibration-policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.write')
  @RequireFactoryScope()
  create(
    @Req() req: GrowthPolicyRequest,
    @Body() body: CreateGrowthCalibrationPolicyDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.policies.createPolicy(c.userId, c.tenantId, c.factoryId, body, c.requestId, c.traceId);
  }

  @Get('calibration-policies')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.read')
  @RequireFactoryScope()
  list(
    @Req() req: GrowthPolicyRequest,
    @Query('domain') domain?: string,
    @Query('metric_key') metricKey?: string,
    @Query('model_version') modelVersion?: string,
    @Query('status') status?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.policies.listPolicies(c.tenantId, c.factoryId, {
      domain, metric_key: metricKey, model_version: modelVersion, status,
      limit: rawLimit === undefined ? 50 : Number(rawLimit),
    });
  }

  @Post('calibration-policies/:policyId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('growth.review')
  @RequireFactoryScope()
  decide(
    @Req() req: GrowthPolicyRequest,
    @Param('policyId', new ParseUUIDPipe()) policyId: string,
    @Body() body: DecideGrowthCalibrationPolicyDto,
  ): Promise<unknown> {
    const c = this.context(req);
    return this.policies.decidePolicy(c.userId, c.tenantId, c.factoryId, policyId, body, c.requestId, c.traceId);
  }

  private context(req: GrowthPolicyRequest) {
    const c = req.factoryos;
    if (!c?.userId || !c.tenantId || !c.factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId: c.userId, tenantId: c.tenantId, factoryId: c.factoryId,
      requestId: c.requestId ?? null, traceId: c.traceId ?? null,
    };
  }
}
