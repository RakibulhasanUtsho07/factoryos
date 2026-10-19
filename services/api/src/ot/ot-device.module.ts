import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { OtDeviceController } from './ot-device.controller';
import { OtDeviceService } from './ot-device.service';

@Module({
  imports: [DatabaseModule, IamModule],
  controllers: [OtDeviceController],
  providers: [OtDeviceService],
  exports: [OtDeviceService],
})
export class OtDeviceModule {}
