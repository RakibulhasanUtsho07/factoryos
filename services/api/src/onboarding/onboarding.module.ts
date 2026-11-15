import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [AuditModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, PermissionGuard],
})
export class OnboardingModule {}
