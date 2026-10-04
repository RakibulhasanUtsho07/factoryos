import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { InboxService } from './inbox.service';

import { OrderCreatedConsumer } from './order-created.consumer';

import { OutboxConsumerRegistry } from './outbox.consumer.registry';

import { OutboxDispatcherService } from './outbox.dispatcher.service';

import { OutboxPublisher } from './outbox.publisher';

@Module({
  imports: [
    DatabaseModule,
  ],
  providers: [
    InboxService,
    OrderCreatedConsumer,
    OutboxConsumerRegistry,
    OutboxPublisher,
    OutboxDispatcherService,
  ],
  exports: [
    InboxService,
    OutboxConsumerRegistry,
    OutboxDispatcherService,
  ],
})
export class OutboxModule {}