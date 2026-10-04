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

  /*
   * Local development publisher.
   *
   * This is intentionally an internal publisher boundary.
   * Later this can be replaced with Kafka, RabbitMQ,
   * NATS, Azure Service Bus, AWS EventBridge, etc.
   */
  async publish(
    event: OutboxEvent,
  ): Promise<void> {
    this.logger.log(
      JSON.stringify({
        type: 'OUTBOX_EVENT_PUBLISHED',
        event_id: event.id,
        tenant_id: event.tenantId,
        factory_id: event.factoryId,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        event_type: event.eventType,
        event_version: event.eventVersion,
        payload: event.payload,
      }),
    );
  }
}