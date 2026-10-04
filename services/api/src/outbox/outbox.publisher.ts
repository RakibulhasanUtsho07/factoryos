import { Injectable, Logger } from '@nestjs/common';

export interface OutboxEvent {
  id: string;
  tenantId: string;
  factoryId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxPublisher {
  private readonly logger =
    new Logger(OutboxPublisher.name);

  async publish(
    event: OutboxEvent,
  ): Promise<void> {
    /*
     * ----------------------------------------------------------
     * DEVELOPMENT FAILURE INJECTION
     * ----------------------------------------------------------
     *
     * This is ONLY for local testing.
     *
     * When:
     *
     *   OUTBOX_TEST_FORCE_FAILURE=true
     *
     * the publisher deliberately fails.
     *
     * This lets us verify:
     *
     * PROCESSING
     *    ↓
     * FAILED
     *    ↓
     * retry
     *    ↓
     * PUBLISHED
     *
     * Production should never enable this.
     */
    const forceFailure =
      process.env.NODE_ENV === 'development' &&
      process.env.OUTBOX_TEST_FORCE_FAILURE ===
        'true';

    if (forceFailure) {
      this.logger.warn(
        `TEST FAILURE INJECTION: refusing to publish outbox event ${event.id}`,
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
     * For now we simulate successful event publication
     * through structured logging.
     *
     * Later this boundary can connect to:
     * - Kafka
     * - RabbitMQ
     * - NATS
     * - Azure Service Bus
     * - AWS EventBridge
     */
    this.logger.log(
      JSON.stringify({
        type: 'OUTBOX_EVENT_PUBLISHED',

        event_id: event.id,

        tenant_id: event.tenantId,

        factory_id: event.factoryId,

        aggregate_type:
          event.aggregateType,

        aggregate_id:
          event.aggregateId,

        event_type:
          event.eventType,

        event_version:
          event.eventVersion,

        payload:
          event.payload,
      }),
    );
  }
}