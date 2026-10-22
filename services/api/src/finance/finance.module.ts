import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { MicrosoftDynamics365BusinessCentralFinanceAdapter } from './finance-business-central.adapter';
import { FINANCE_ERP_TRANSFER } from './finance-erp-transfer.adapters';
import { FinanceConnectorsController, FinanceReportingController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [FinanceConnectorsController, FinanceReportingController],
  providers: [
    FinanceService,
    {
      provide: FINANCE_ERP_TRANSFER,
      useClass: MicrosoftDynamics365BusinessCentralFinanceAdapter,
    },
  ],
  exports: [FinanceService],
})
export class FinanceModule {}
