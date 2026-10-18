import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [DatabaseModule, IamModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
