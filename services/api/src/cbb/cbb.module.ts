import {
  Module,
} from '@nestjs/common';

import {
  AuditModule,
} from '../audit/audit.module';

import {
  DatabaseModule,
} from '../database/database.module';

import {
  IamModule,
} from '../iam/iam.module';

import {
  CbbController,
} from './cbb.controller';

import {
  CbbService,
} from './cbb.service';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    IamModule,
  ],

  controllers: [
    CbbController,
  ],

  providers: [
    CbbService,
  ],

  exports: [
    CbbService,
  ],
})
export class CbbModule {}