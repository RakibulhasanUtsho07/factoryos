import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { InboxService } from './inbox.service';
import { OrderCreatedConsumer } from './order-created.consumer';
import { OutboxConsumerRegistry } from './outbox.consumer.registry';
import { OutboxController } from './outbox.controller';
import { OutboxDlqService } from './outbox-dlq.service';
import { OutboxDispatcherService } from './outbox.dispatcher.service';
import { OutboxPublisher } from './outbox.publisher';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    IamModule,
  ],

  controllers: [
    OutboxController,
  ],

  providers: [
    InboxService,
    OrderCreatedConsumer,
    OutboxConsumerRegistry,
    OutboxPublisher,
    OutboxDlqService,
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