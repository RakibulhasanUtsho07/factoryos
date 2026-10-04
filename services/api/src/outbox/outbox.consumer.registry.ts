import {
  Injectable,
  Logger,
} from '@nestjs/common';

import {
  OutboxConsumer,
} from './outbox.consumer';

import {
  OutboxEvent,
} from './outbox.publisher';
import { OrderCreatedConsumer } from './order-created.consumer';


@Injectable()
export class OutboxConsumerRegistry {
  private readonly logger =
    new Logger(
      OutboxConsumerRegistry.name,
    );

  private readonly consumers =
    new Map<
      string,
      OutboxConsumer<unknown>
    >();

  constructor(
    private readonly orderCreatedConsumer: OrderCreatedConsumer,
  ) {
    this.register(
      this.orderCreatedConsumer,
    );
  }

  private register(
    consumer: OutboxConsumer<unknown>,
  ): void {
    const key =
      consumer.eventType;

    if (this.consumers.has(key)) {
      throw new Error(
        `Duplicate outbox consumer registration: ${key}`,
      );
    }

    this.consumers.set(
      key,
      consumer,
    );
  }

  async dispatch(
    event: OutboxEvent,
  ): Promise<{
    handled: boolean;
    consumerName: string | null;
  }> {
    const consumer =
      this.consumers.get(
        event.eventType,
      );

    if (!consumer) {
      this.logger.debug(
        `No local consumer registered for event type ${event.eventType}`,
      );

      return {
        handled: false,
        consumerName: null,
      };
    }

    await consumer.consume(
      event,
    );

    return {
      handled: true,
      consumerName:
        consumer.consumerName,
    };
  }
}