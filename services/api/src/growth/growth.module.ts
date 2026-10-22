import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { GrowthController } from './growth.controller';
import { GrowthService } from './growth.service';
import { GrowthSourceOfRecordService } from './growth-source-of-record.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [GrowthController],
  providers: [GrowthService, GrowthSourceOfRecordService],
  exports: [GrowthService],
})
export class GrowthModule {}
