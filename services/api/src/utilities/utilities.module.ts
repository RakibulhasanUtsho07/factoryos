import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { UtilitiesController } from './utilities.controller';
import { UtilitiesService } from './utilities.service';

@Module({
  imports:[DatabaseModule,IamModule,AuditModule],
  controllers:[UtilitiesController],
  providers:[UtilitiesService],
  exports:[UtilitiesService],
})
export class UtilitiesModule {}
