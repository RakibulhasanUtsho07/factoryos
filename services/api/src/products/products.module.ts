import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { ProductsController } from './products.controller';
import { ProductDefinitionsService } from './products.service';
@Module({
  imports:[DatabaseModule,AuditModule,IamModule],
  controllers:[ProductsController],
  providers:[ProductDefinitionsService],
  exports:[ProductDefinitionsService],
})
export class ProductDefinitionsModule {}
