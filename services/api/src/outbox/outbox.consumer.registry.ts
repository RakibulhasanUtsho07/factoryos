import {
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import {
  assertValidOutboxEvent,
} from './outbox-event.contract';

import type {
  OutboxEvent,
} from './outbox-event.contract';

import {
  OutboxConsumer,
} from './outbox.consumer';

import {
  OrderCreatedConsumer,
} from './order-created.consumer';
import {
  EhsLifecycleNotificationConsumer,
  UtilityThresholdNotificationConsumer,
} from '../notifications/notification-outbox.consumers';

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
    @Optional() private readonly utilityThresholdNotificationConsumer?: UtilityThresholdNotificationConsumer,
    @Optional() private readonly ehsLifecycleNotificationConsumer?: EhsLifecycleNotificationConsumer,
  ) {
    this.register(this.orderCreatedConsumer);
    // Keep tests and legacy isolated consumers compatible; Nest injects these
    // providers in the full application module and registers both event types.
    if (this.utilityThresholdNotificationConsumer) this.register(this.utilityThresholdNotificationConsumer);
    if (this.ehsLifecycleNotificationConsumer) this.register(this.ehsLifecycleNotificationConsumer);
  }

  private register(
    consumer:
      OutboxConsumer<unknown>,
  ): void {
    const key =
      consumer.eventType;

    if (
      this.consumers.has(key)
    ) {
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
    /*
     * ----------------------------------------------------------
     * CONSUMER CONTRACT GATE
     * ----------------------------------------------------------
     *
     * Re-validate at the consumer boundary.
     *
     * The publisher is a separate boundary, so consumers must
     * never assume that an event reaching them is already safe.
     */
    const validatedEvent =
      assertValidOutboxEvent(
        event,
      );

    const consumer =
      this.consumers.get(
        validatedEvent.eventType,
      );

    if (!consumer) {
      this.logger.debug(
        `No local consumer registered for event type ${validatedEvent.eventType}`,
      );

      return {
        handled: false,
        consumerName: null,
      };
    }

    await consumer.consume(
      validatedEvent,
    );

    return {
      handled: true,
      consumerName:
        consumer.consumerName,
    };
  }
}