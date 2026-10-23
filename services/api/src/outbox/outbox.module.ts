import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EhsLifecycleNotificationConsumer, UtilityThresholdNotificationConsumer } from '../notifications/notification-outbox.consumers';
import { IamModule } from '../iam/iam.module';
import { ObservabilityModule } from '../observability/observability.module';

import { InboxService } from './inbox.service';
import { OrderCreatedConsumer } from './order-created.consumer';
import { OutboxConsumerRegistry } from './outbox.consumer.registry';
import { OutboxController } from './outbox.controller';
import { OutboxDlqService } from './outbox-dlq.service';
import { OutboxBusDlqService } from './outbox-bus-dlq.service';
import { OutboxDispatcherService } from './outbox.dispatcher.service';
import { KafkaEventBusAdapter } from './kafka-event-bus.adapter';
import { OutboxPublisher } from './outbox.publisher';

@Module({
  imports: [
    DatabaseModule,
    NotificationsModule,
    AuditModule,
    IamModule,
    ObservabilityModule,
  ],

  controllers: [
    OutboxController,
  ],

  providers: [
    InboxService,
    OrderCreatedConsumer,
    UtilityThresholdNotificationConsumer,
    EhsLifecycleNotificationConsumer,
    OutboxConsumerRegistry,
    KafkaEventBusAdapter,
    OutboxPublisher,
    OutboxDlqService,
    OutboxBusDlqService,
    OutboxDispatcherService,
  ],

  exports: [
    InboxService,
    OutboxConsumerRegistry,
    OutboxDispatcherService,
    OutboxDlqService,
  ],
})
export class OutboxModule {}