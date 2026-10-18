import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { CommercialService } from './commercial.service';
import { QuotationsController, CommercialRulesController, CommercialExchangeRatesController } from './commercial.controller';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [QuotationsController, CommercialRulesController, CommercialExchangeRatesController],
  providers: [CommercialService],
  exports: [CommercialService],
})
export class CommercialModule {}
