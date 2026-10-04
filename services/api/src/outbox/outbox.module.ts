import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { OutboxDispatcherService } from './outbox.dispatcher.service';
import { OutboxPublisher } from './outbox.publisher';

@Module({
  imports: [
    DatabaseModule,
  ],

  providers: [
    OutboxPublisher,
    OutboxDispatcherService,
  ],

  exports: [
    OutboxDispatcherService,
  ],
})
export class OutboxModule {}