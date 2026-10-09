import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    IamModule,
  ],

  controllers: [
    PolicyController,
  ],

  providers: [
    PolicyService,
  ],

  exports: [
    PolicyService,
  ],
})
export class PolicyModule {}
