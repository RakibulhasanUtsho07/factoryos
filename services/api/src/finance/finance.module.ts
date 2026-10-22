import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import {
  FINANCE_SECRET_MANAGER,
  MicrosoftDynamics365BusinessCentralFinanceAdapter,
} from './finance-business-central.adapter';
import { FINANCE_ERP_TRANSFER } from './finance-erp-transfer.adapters';
import { VaultFinanceSecretManager } from './finance-vault-secret-manager';
import { FinanceConnectorsController, FinanceReportingController } from './finance.controller';
import { FINANCE_SFTP_TRANSPORT } from './finance-file-transfer.adapters';
import { OpenSshFinanceSftpTransport } from './finance-openssh-sftp.transport';
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
    {
      provide: FINANCE_SFTP_TRANSPORT,
      useClass: OpenSshFinanceSftpTransport,
    },
  ],
  exports: [FinanceService],
})
export class FinanceModule {}
