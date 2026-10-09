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
  EntitlementsController,
} from './entitlements.controller';

import {
  EntitlementService,
} from './entitlement.service';

import {
  FeatureFlagsModule,
} from './feature-flags.module';

@Module({
  imports: [
    DatabaseModule,

    AuditModule,

    IamModule,

    FeatureFlagsModule,
  ],

  controllers: [
    EntitlementsController,
  ],

  providers: [
    EntitlementService,
  ],

  exports: [
    EntitlementService,

    FeatureFlagsModule,
  ],
})
export class EntitlementsModule {}