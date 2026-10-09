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

import {
  CbbChangeService,
} from './cbb.change.service';

import {
  CbbPromotionService,
} from './cbb.promotion.service';

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
    CbbChangeService,
    CbbPromotionService,
  ],

  exports: [
    CbbService,
    CbbChangeService,
    CbbPromotionService,
  ],
})
export class CbbModule {}