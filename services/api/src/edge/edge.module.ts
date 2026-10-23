import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { EdgeDeviceCredentialService } from './edge-device-credential.service';
import { EdgeDeviceGatewayController } from './edge-device-gateway.controller';
import { EdgeDeviceGatewayService } from './edge-device-gateway.service';

@Module({
  imports: [AuditModule, DatabaseModule, IamModule],
  controllers: [EdgeDeviceGatewayController],
  providers: [EdgeDeviceGatewayService, EdgeDeviceCredentialService],
  exports: [EdgeDeviceGatewayService],
})
export class EdgeModule {}
