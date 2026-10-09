import { OutboxEvent } from './outbox.publisher';

export interface OutboxConsumer<TResult = unknown> {
  readonly consumerName: string;
  readonly eventType: string;

  consume(event: OutboxEvent): Promise<TResult>;
}