import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { UtilitiesController } from './utilities.controller';
import { UtilitiesClosureController } from './utilities-closure.controller';
import { UtilitiesService } from './utilities.service';
import { UtilitiesClosureService } from './utilities-closure.service';

@Module({
  imports:[DatabaseModule,IamModule,AuditModule],
  controllers:[UtilitiesController,UtilitiesClosureController],
  providers:[UtilitiesService,UtilitiesClosureService],
  exports:[UtilitiesService,UtilitiesClosureService],
})
export class UtilitiesModule {}
