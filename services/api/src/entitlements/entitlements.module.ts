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
  EntitlementService,
} from './entitlement.service';

@Module({
  imports: [
    DatabaseModule,

    AuditModule,
  ],

  providers: [
    EntitlementService,
  ],

  exports: [
    EntitlementService,
  ],
})
export class EntitlementsModule {}