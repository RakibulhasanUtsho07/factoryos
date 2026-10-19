import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { OtDeviceController } from './ot-device.controller';
import { OtDeviceService } from './ot-device.service';

@Module({
  imports: [DatabaseModule, IamModule, AuditModule],
  controllers: [OtDeviceController],
  providers: [OtDeviceService],
  exports: [OtDeviceService],
})
export class OtDeviceModule {}
