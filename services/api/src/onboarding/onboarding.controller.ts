import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { SaveOnboardingStepDto } from './dto/save-onboarding-step.dto';
import { OnboardingService } from './onboarding.service';

interface OnboardingRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: OnboardingRequestContext;
};

@Controller('onboarding')
@UseGuards(PermissionGuard)
@RequirePermission('factory.onboarding.manage')
@RequireFactoryScope()
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('steps')
  async listSteps(@Req() request: FactoryOsRequest) {
    const context = this.requireContext(request);
    return this.onboardingService.listSteps(
      context.userId,
      context.tenantId,
      context.factoryId,
    );
  }

  @Put('steps/:stepKey')
  async saveStep(
    @Req() request: FactoryOsRequest,
    @Param('stepKey') stepKey: string,
    @Body() body: SaveOnboardingStepDto,
  ) {
    const context = this.requireContext(request);
    return this.onboardingService.saveStep(
      context.userId,
      context.tenantId,
      context.factoryId,
      stepKey,
      body.payload,
      context.requestId,
      context.traceId,
    );
  }

  private requireContext(request: FactoryOsRequest) {
    const context = request.factoryos;
    if (!context?.userId || !context.tenantId || !context.factoryId) {
      throw new UnauthorizedException('Verified user, tenant and factory context are required');
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
