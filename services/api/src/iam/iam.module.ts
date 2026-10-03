import { Module } from '@nestjs/common';

import { IamController } from './iam.controller';
import { IamService } from './iam.service';
import { PermissionGuard } from './guards/permission.guard';

@Module({
  controllers: [IamController],
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