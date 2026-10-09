import { Injectable } from '@nestjs/common';

import { PoolClient } from 'pg';

import {
  InboxExecutionResult,
  InboxService,
} from './inbox.service';

import {
  OutboxConsumer,
} from './outbox.consumer';

import {
  OutboxEvent,
} from './outbox.publisher';

export interface OrderCreatedProjectionResult {
  projectionId: string;
  orderId: string;
}

interface OrderCreatedPayload {
  order?: {
    id?: unknown;
    tenant_id?: unknown;
    factory_id?: unknown;
    order_number?: unknown;
    status?: unknown;
  };
}

@Injectable()
export class OrderCreatedConsumer
  implements
    OutboxConsumer<
      InboxExecutionResult<
        OrderCreatedProjectionResult
      >
    >
{
  readonly consumerName =
    'order-created-projection-v1';

  readonly eventType =
    'ORDER.CREATED';

  constructor(
    private readonly inboxService: InboxService,
  ) {}

  async consume(
    event: OutboxEvent,
  ): Promise<
    InboxExecutionResult<
      OrderCreatedProjectionResult
    >
  > {
    return this.inboxService.executeOnce(
      event.tenantId,
      this.consumerName,
      event.id,
      async (client) => {
        return this.applyProjection(
          client,
          event,
        );
      },
    );
  }

  private async applyProjection(
    client: PoolClient,
    event: OutboxEvent,
  ): Promise<OrderCreatedProjectionResult> {
    const payload =
      event.payload as OrderCreatedPayload;

    const order =
      payload.order;

    // ----------------------------------------------------------
    // Validate required payload fields.
    // ----------------------------------------------------------

    if (
      !order ||
      typeof order.id !== 'string' ||
      typeof order.tenant_id !== 'string' ||
      typeof order.factory_id !== 'string' ||
      typeof order.order_number !== 'string' ||
      typeof order.status !== 'string'
    ) {
      throw new Error(
        'ORDER_CREATED_INVALID_PAYLOAD',
      );
    }

    // ----------------------------------------------------------
    // Verify aggregate identity.
    // ----------------------------------------------------------

    if (
      order.id !== event.aggregateId
    ) {
      throw new Error(
        'ORDER_CREATED_PAYLOAD_AGGREGATE_MISMATCH',
      );
    }

    // ----------------------------------------------------------
    // Verify tenant identity.
    // ----------------------------------------------------------

    if (
      order.tenant_id !== event.tenantId
    ) {
      throw new Error(
        'ORDER_CREATED_PAYLOAD_TENANT_MISMATCH',
      );
    }

    // ----------------------------------------------------------
    // Verify factory identity.
    // ----------------------------------------------------------

    if (
      event.factoryId !== null &&
      order.factory_id !== event.factoryId
    ) {
      throw new Error(
        'ORDER_CREATED_PAYLOAD_FACTORY_MISMATCH',
      );
    }

    // ----------------------------------------------------------
    // Verify aggregate still exists.
    //
    // IMPORTANT:
    // Current aggregate state is NOT used for the projection
    // snapshot. We only verify tenant-scoped existence.
    // ----------------------------------------------------------

    const orderResult =
      await client.query<{
        id: string;
      }>(
        `
        SELECT
          id::text AS id

        FROM orders

        WHERE
          id = $1
          AND tenant_id = $2

        LIMIT 1
        `,
        [
          event.aggregateId,
          event.tenantId,
        ],
      );

    const existingOrder =
      orderResult.rows[0];

    if (!existingOrder) {
      throw new Error(
        'ORDER_CREATED_ORDER_NOT_FOUND_FOR_TENANT',
      );
    }

    // ----------------------------------------------------------
    // Persist historical event snapshot.
    //
    // These fields MUST come from the event payload.
    // ----------------------------------------------------------

    const projectionResult =
      await client.query<{
        id: string;
      }>(
        `
        INSERT INTO order_event_projections (
          tenant_id,
          event_id,
          order_id,
          factory_id,
          order_number,
          status,
          event_version
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )

        ON CONFLICT (event_id)
        DO NOTHING

        RETURNING
          id::text AS id
        `,
        [
          event.tenantId,
          event.id,
          event.aggregateId,
          order.factory_id,
          order.order_number,
          order.status,
          event.eventVersion,
        ],
      );

    const projection =
      projectionResult.rows[0];

    // ----------------------------------------------------------
    // Duplicate delivery.
    // ----------------------------------------------------------

    if (!projection) {
      const existingProjection =
        await client.query<{
          id: string;
        }>(
          `
          SELECT
            id::text AS id

          FROM order_event_projections

          WHERE
            event_id = $1

          LIMIT 1
          `,
          [
            event.id,
          ],
        );

      const existing =
        existingProjection.rows[0];

      if (!existing) {
        throw new Error(
          'ORDER_CREATED_PROJECTION_INSERT_FAILED',
        );
      }

      return {
        projectionId:
          existing.id,

        orderId:
          event.aggregateId,
      };
    }

    return {
      projectionId:
        projection.id,

      orderId:
        event.aggregateId,
    };
  }
}