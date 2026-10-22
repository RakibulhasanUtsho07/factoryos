import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { NotificationsController } from './notifications.controller';
import { NotificationInboxService } from './notification-inbox.service';

@Module({
  imports:[DatabaseModule,IamModule],
  controllers:[NotificationsController],
  providers:[NotificationInboxService],
  exports:[NotificationInboxService],
})
export class NotificationsModule {}
