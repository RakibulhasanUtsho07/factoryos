import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import {
  FINANCE_ERP_TRANSFER,
  FINANCE_SECRET_MANAGER,
  MicrosoftDynamics365BusinessCentralFinanceAdapter,
} from './finance-business-central.adapter';
import { VaultFinanceSecretManager } from './finance-vault-secret-manager';
import { FinanceConnectorsController, FinanceReportingController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [FinanceConnectorsController, FinanceReportingController],
  providers: [
    FinanceService,
    {
      provide: FINANCE_SECRET_MANAGER,
      useClass: VaultFinanceSecretManager,
    },
    {
      provide: FINANCE_ERP_TRANSFER,
      useClass: MicrosoftDynamics365BusinessCentralFinanceAdapter,
    },
  ],
  exports: [FinanceService],
})
export class FinanceModule {}
