import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { EhsController } from './ehs.controller';
import { EhsService } from './ehs.service';

@Module({
  imports:[DatabaseModule,IamModule,AuditModule],
  controllers:[EhsController],
  providers:[EhsService],
  exports:[EhsService],
})
export class EhsModule {}
