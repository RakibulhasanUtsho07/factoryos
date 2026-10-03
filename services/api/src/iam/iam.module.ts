import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';

import { PermissionGuard } from './guards/permission.guard';
import { IamController } from './iam.controller';
import { IamService } from './iam.service';

@Module({
  imports: [
    AuditModule,
  ],

  controllers: [
    IamController,
  ],

  providers: [
    IamService,
    PermissionGuard,
  ],

  exports: [
    IamService,
    PermissionGuard,
  ],
})
export class IamModule {}