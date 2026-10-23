import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { NotificationsController } from './notifications.controller';
import { NotificationInboxService } from './notification-inbox.service';

@Module({
  imports:[DatabaseModule,IamModule,AuditModule],
  controllers:[NotificationsController],
  providers:[NotificationInboxService],
  exports:[NotificationInboxService],
})
export class NotificationsModule {}
