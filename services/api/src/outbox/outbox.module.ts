import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { InboxService } from './inbox.service';

import { OutboxDispatcherService } from './outbox.dispatcher.service';

import { OutboxPublisher } from './outbox.publisher';

@Module({
  imports: [
    DatabaseModule,
  ],
  providers: [
    InboxService,
    OutboxPublisher,
    OutboxDispatcherService,
  ],
  exports: [
    InboxService,
    OutboxDispatcherService,
  ],
})
export class OutboxModule {}