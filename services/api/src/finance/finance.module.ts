import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { FinanceConnectorsController, FinanceReportingController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [FinanceConnectorsController, FinanceReportingController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
