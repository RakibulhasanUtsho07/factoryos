import {
  assertValidOutboxEvent,
  OutboxEventContractError,
} from './outbox-event.contract';

import type {
  OutboxEvent,
} from './outbox-event.contract';

describe(
  'Outbox event contract',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const factoryId =
      '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

    const orderId =
      '11111111-1111-4111-8111-111111111111';

    const lineId =
      '22222222-2222-4222-8222-222222222222';

    const userId =
      '921382b8-e83f-43ab-a576-e3db6a06b70c';

    function buildCreatedEvent(): OutboxEvent {
      return {
        id:
          '33333333-3333-4333-8333-333333333333',

        tenantId,

        factoryId,

        aggregateType:
          'ORDER',

        aggregateId:
          orderId,

        eventType:
          'ORDER.CREATED',

        eventVersion:
          1,

        payload: {
          order: {
            id:
              orderId,

            tenant_id:
              tenantId,

            factory_id:
              factoryId,

            order_number:
              'TEST-ORDER-001',

            status:
              'DRAFT',
          },

          lines: [
            {
              id:
                lineId,

              line_number:
                1,

              product_code:
                'FABRIC-001',

              quantity:
                '100',

              unit:
                'KG',
            },
          ],

          actor: {
            user_id:
              userId,
          },
        },
      };
    }

    it(
      'accepts a valid ORDER.CREATED v1 event',
      () => {
        const event =
          buildCreatedEvent();

        const result =
          assertValidOutboxEvent(
            event,
          );

        expect(
          result.eventType,
        ).toBe(
          'ORDER.CREATED',
        );

        expect(
          result.eventVersion,
        ).toBe(1);

        expect(
          Object.isFrozen(
            result,
          ),
        ).toBe(true);

        expect(
          Object.isFrozen(
            result.payload,
          ),
        ).toBe(true);

        expect(
          Object.isFrozen(
            (
              result.payload.order as Record<
                string,
                unknown
              >
            ),
          ),
        ).toBe(true);
      },
    );

    it(
      'rejects tenant mismatch',
      () => {
        const event =
          buildCreatedEvent();

        (
          event.payload.order as Record<
            string,
            unknown
          >
        ).tenant_id =
          '99999999-9999-4999-8999-999999999999';

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).toThrow(
          'ORDER_EVENT_TENANT_MISMATCH',
        );
      },
    );

    it(
      'rejects aggregate mismatch',
      () => {
        const event =
          buildCreatedEvent();

        (
          event.payload.order as Record<
            string,
            unknown
          >
        ).id =
          '44444444-4444-4444-8444-444444444444';

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).toThrow(
          'ORDER_EVENT_AGGREGATE_MISMATCH',
        );
      },
    );

    it(
      'rejects unsupported known ORDER event version',
      () => {
        const event =
          buildCreatedEvent();

        event.eventVersion =
          2;

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).toThrow(
          OutboxEventContractError,
        );

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).toThrow(
          'OUTBOX_EVENT_UNSUPPORTED_VERSION',
        );
      },
    );

    it(
      'accepts ORDER.CREATED snapshot with a non-DRAFT status',
      () => {
        const event =
          buildCreatedEvent();

        (
          event.payload.order as Record<
            string,
            unknown
          >
        ).status =
          'COMPLETED';

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).not.toThrow();
      },
    );

    it(
      'rejects ORDER lifecycle event when event type and status disagree',
      () => {
        const event =
          buildCreatedEvent();

        event.eventType =
          'ORDER.CONFIRMED';

        (
          event.payload.order as Record<
            string,
            unknown
          >
        ).previous_status =
          'DRAFT';

        (
          event.payload.order as Record<
            string,
            unknown
          >
        ).status =
          'IN_PROGRESS';

        (
          event.payload.order as Record<
            string,
            unknown
          >
        ).version =
          2;

        (
          event.payload.order as Record<
            string,
            unknown
          >
        ).updated_at =
          '2026-10-05T00:00:00.000Z';

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).toThrow(
          'ORDER_LIFECYCLE_EVENT_STATUS_MISMATCH',
        );
      },
    );

    it(
      'accepts an ORDER event with a minimal current-compatible payload',
      () => {
        const event: OutboxEvent = {
          id:
            '55555555-5555-4555-8555-555555555555',

          tenantId,

          factoryId,

          aggregateType:
            'ORDER',

          aggregateId:
            orderId,

          eventType:
            'ORDER.CREATED',

          eventVersion:
            1,

          payload: {
            order_number:
              'LEGACY-COMPAT-001',
          },
        };

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).not.toThrow();
      },
    );

    it(
      'accepts an unknown future event type with generic envelope validation',
      () => {
        const event =
          buildCreatedEvent();

        event.eventType =
          'ORDER.FUTURE_EVENT';

        event.payload = {
          value:
            'future-schema-payload',
        };

        expect(
          () =>
            assertValidOutboxEvent(
              event,
            ),
        ).not.toThrow();
      },
    );
  },
);