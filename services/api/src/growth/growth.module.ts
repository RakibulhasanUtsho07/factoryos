import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { GrowthController } from './growth.controller';
import { GrowthService } from './growth.service';
import { GrowthSourceOfRecordService } from './growth-source-of-record.service';
import { GrowthCalibrationPolicyController } from './growth-calibration-policy.controller';
import { GrowthCalibrationPolicyService } from './growth-calibration-policy.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [GrowthController, GrowthCalibrationPolicyController],
  providers: [GrowthService, GrowthSourceOfRecordService, GrowthCalibrationPolicyService],
  exports: [GrowthService],
})
export class GrowthModule {}
