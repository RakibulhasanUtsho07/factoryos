import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { ProductsController } from './products.controller';
import { EngineeringChangeController } from './engineering-change.controller';
import { EngineeringChangeService } from './engineering-change.service';
import { ProductDefinitionsService } from './products.service';
@Module({
  imports:[DatabaseModule,AuditModule,IamModule],
  controllers:[ProductsController,EngineeringChangeController],
  providers:[ProductDefinitionsService,EngineeringChangeService],
  exports:[ProductDefinitionsService],
})
export class ProductDefinitionsModule {}
