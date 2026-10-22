import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { ProductsController } from './products.controller';
import { ProductChangeOrdersController } from './product-change-orders.controller';
import { ProductDefinitionsService } from './products.service';
import { ProductChangeOrdersService } from './product-change-orders.service';
@Module({
  imports:[DatabaseModule,AuditModule,IamModule],
  controllers:[ProductsController,ProductChangeOrdersController],
  providers:[ProductDefinitionsService,ProductChangeOrdersService],
  exports:[ProductDefinitionsService],
})
export class ProductDefinitionsModule {}
