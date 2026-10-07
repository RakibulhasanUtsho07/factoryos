import {
  Module,
} from '@nestjs/common';

import {
  AuditModule,
} from '../audit/audit.module';

import {
  CbbModule,
} from '../cbb/cbb.module';

import {
  DatabaseModule,
} from '../database/database.module';

import {
  IamModule,
} from '../iam/iam.module';

import {
  PolicyModule,
} from '../policy/policy.module';

import {
  AiController,
} from './ai.controller';

import {
  AiRuntimeService,
} from './ai.runtime.service';

@Module({
  imports: [
    AuditModule,
    CbbModule,
    DatabaseModule,
    IamModule,
    PolicyModule,
  ],

  controllers: [
    AiController,
  ],

  providers: [
    AiRuntimeService,
  ],

  exports: [
    AiRuntimeService,
  ],
})
export class AiModule {}
