import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { SaasUsageController } from './saas-usage.controller';
import { SaasUsageService } from './saas-usage.service';

@Module({
 imports:[DatabaseModule,AuditModule,IamModule],
 controllers:[SaasUsageController],
 providers:[SaasUsageService],
 exports:[SaasUsageService],
})
export class SaasModule {}
