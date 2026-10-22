import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { AdvancedQualityController } from './advanced-quality.controller';
import { AdvancedQualityService } from './advanced-quality.service';
import { QualityController } from './quality.controller';
import { QualityService } from './quality.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [QualityController, AdvancedQualityController],
  providers: [QualityService, AdvancedQualityService],
  exports: [QualityService, AdvancedQualityService],
})
export class QualityModule {}
