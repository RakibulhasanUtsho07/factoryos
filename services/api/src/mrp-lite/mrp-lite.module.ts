import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { MrpLiteController } from './mrp-lite.controller';
import { MrpLiteService } from './mrp-lite.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [MrpLiteController],
  providers: [MrpLiteService],
  exports: [MrpLiteService],
})
export class MrpLiteModule {}
