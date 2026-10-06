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
  FeatureFlagService,
} from './feature-flag.service';

@Module({
  imports: [
    DatabaseModule,

    AuditModule,
  ],

  providers: [
    FeatureFlagService,
  ],

  exports: [
    FeatureFlagService,
  ],
})
export class FeatureFlagsModule {}