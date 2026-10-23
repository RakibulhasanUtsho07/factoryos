import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { EhsController } from './ehs.controller';
import { EhsClosureController } from './ehs-closure.controller';
import { EhsService } from './ehs.service';
import { EhsClosureService } from './ehs-closure.service';

@Module({
  imports:[DatabaseModule,IamModule,AuditModule],
  controllers:[EhsController,EhsClosureController],
  providers:[EhsService,EhsClosureService],
  exports:[EhsService,EhsClosureService],
})
export class EhsModule {}
