import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { MrpLiteController } from './mrp-lite.controller';
import { MrpLiteService } from './mrp-lite.service';
import { MrpFiniteCapacityController } from './mrp-finite-capacity.controller';
import { MrpFiniteCapacityService } from './mrp-finite-capacity.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [MrpLiteController, MrpFiniteCapacityController],
  providers: [MrpLiteService, MrpFiniteCapacityService],
  exports: [MrpLiteService, MrpFiniteCapacityService],
})
export class MrpLiteModule {}
