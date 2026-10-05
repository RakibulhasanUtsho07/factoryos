import {
  Injectable,
  Logger,
} from '@nestjs/common';

import {
  assertValidOutboxEvent,
} from './outbox-event.contract';

import type {
  OutboxEvent,
} from './outbox-event.contract';

export type {
  OutboxEvent,
} from './outbox-event.contract';

@Injectable()
export class OutboxPublisher {
  private readonly logger =
    new Logger(
      OutboxPublisher.name,
    );

  async publish(
    event: OutboxEvent,
  ): Promise<void> {
    /*
     * ----------------------------------------------------------
     * EVENT CONTRACT GATE
     * ----------------------------------------------------------
     *
     * Validate before the event crosses the publisher boundary.
     *
     * Validation also deep-freezes the event snapshot so local
     * consumers cannot mutate the event after validation.
     */
    const validatedEvent =
      assertValidOutboxEvent(
        event,
      );

    /*
     * ----------------------------------------------------------
     * DEVELOPMENT FAILURE INJECTION
     * ----------------------------------------------------------
     *
     * ONLY for local testing.
     */
    const forceFailure =
      process.env.NODE_ENV ===
        'development' &&
      process.env
        .OUTBOX_TEST_FORCE_FAILURE ===
        'true';

    if (forceFailure) {
      this.logger.warn(
        `TEST FAILURE INJECTION: refusing to publish outbox event ${validatedEvent.id}`,
      );

      throw new Error(
        'OUTBOX_TEST_FORCE_FAILURE is enabled',
      );
    }

    /*
     * ----------------------------------------------------------
     * Local development publisher
     * ----------------------------------------------------------
     *
     * Temporary transport boundary.
     *
     * Later this can connect to:
     * - Kafka
     * - RabbitMQ
     * - NATS
     * - Azure Service Bus
     * - AWS EventBridge
     */
    this.logger.log(
      JSON.stringify({
        type:
          'OUTBOX_EVENT_PUBLISHED',

        event_id:
          validatedEvent.id,

        tenant_id:
          validatedEvent.tenantId,

        factory_id:
          validatedEvent.factoryId,

        aggregate_type:
          validatedEvent.aggregateType,

        aggregate_id:
          validatedEvent.aggregateId,

        event_type:
          validatedEvent.eventType,

        event_version:
          validatedEvent.eventVersion,

        payload:
          validatedEvent.payload,
      }),
    );
  }
}