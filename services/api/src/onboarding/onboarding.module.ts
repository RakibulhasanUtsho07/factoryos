import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { IamModule } from '../iam/iam.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [AuditModule, IamModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
