import { jest } from '@jest/globals';

import {
  OrderIdempotencyService,
} from './order-idempotency.service';

type MockQueryResult = {
  rowCount: number;
  rows: Array<Record<string, unknown>>;
};

type MockQuery = (
  ...args: unknown[]
) => Promise<MockQueryResult>;

type MockTransaction = <T>(
  callback: (
    client: {
      query: ReturnType<
        typeof createMockClient
      >['query'];
    },
  ) => Promise<T>,
) => Promise<T>;

function createMockClient() {
  const query =
    jest.fn<MockQuery>();

  return {
    query,
  };
}

function createMockDatabase(
  client: ReturnType<
    typeof createMockClient
  >,
) {
  const transaction =
    jest.fn<MockTransaction>(
      async <T>(
        callback: (
          client: {
            query: ReturnType<
              typeof createMockClient
            >['query'];
          },
        ) => Promise<T>,
      ): Promise<T> => {
        return callback(client);
      },
    );

  const query =
    jest.fn<MockQuery>();

  return {
    transaction,
    query,
  };
}

describe(
  'OrderIdempotencyService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const idempotencyKey =
      'order-idem-test-001';

    it(
      'should execute the handler and complete the key on first request',
      async () => {
        const client =
          createMockClient();

        /*
         * Query 1:
         * DELETE expired idempotency key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 2:
         * INSERT new idempotency key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: 'idem-row-001',
            },
          ],
        });

        /*
         * Query 3:
         * UPDATE idempotency row to COMPLETED.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 1,
          rows: [],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new OrderIdempotencyService(
            database as never,
          );

        const handler =
          jest.fn<
            (
              client: unknown,
            ) => Promise<{
              id: string;
              status: string;
            }>
          >();

        handler.mockResolvedValue({
          id: 'order-001',
          status: 'DRAFT',
        });

        const requestHash =
          service.createRequestHash({
            factory_id:
              'factory-001',
            order_number:
              'SO-001',
          });

        const result =
          await service.execute(
            tenantId,
            idempotencyKey,
            requestHash,
            handler,
          );

        expect(result).toEqual({
          replayed: false,
          result: {
            id: 'order-001',
            status: 'DRAFT',
          },
        });

        expect(
          database.transaction,
        ).toHaveBeenCalledTimes(1);

        expect(
          database.transaction.mock
            .calls[0][0],
        ).toBeDefined();

        expect(handler)
          .toHaveBeenCalledTimes(1);

        expect(
          client.query,
        ).toHaveBeenCalledTimes(3);
      },
    );

    it(
      'should replay the stored result for the same key and hash',
      async () => {
        const client =
          createMockClient();

        /*
         * Query 1:
         * DELETE expired idempotency key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 2:
         * INSERT conflicts with existing key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 3:
         * Load existing completed key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: 'idem-row-001',
              request_hash:
                'HASH',
              status:
                'COMPLETED',
              response_payload: {
                id: 'order-001',
                status: 'DRAFT',
              },
              resource_id:
                'order-001',
              expires_at:
                '2099-01-01T00:00:00Z',
            },
          ],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new OrderIdempotencyService(
            database as never,
          );

        const handler =
          jest.fn<
            (
              client: unknown,
            ) => Promise<{
              id: string;
            }>
          >();

        const result =
          await service.execute(
            tenantId,
            idempotencyKey,
            'HASH',
            handler,
          );

        expect(result).toEqual({
          replayed: true,
          result: {
            id: 'order-001',
            status: 'DRAFT',
          },
        });

        expect(handler)
          .not.toHaveBeenCalled();

        expect(
          database.transaction,
        ).toHaveBeenCalledTimes(1);

        expect(
          client.query,
        ).toHaveBeenCalledTimes(3);
      },
    );

    it(
      'should reject the same key when the request hash is different',
      async () => {
        const client =
          createMockClient();

        /*
         * Query 1:
         * DELETE expired idempotency key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 2:
         * INSERT conflicts with existing key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 3:
         * Existing key has a different request hash.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: 'idem-row-001',
              request_hash:
                'ORIGINAL_HASH',
              status:
                'COMPLETED',
              response_payload: {
                id: 'order-001',
              },
              resource_id:
                'order-001',
              expires_at:
                '2099-01-01T00:00:00Z',
            },
          ],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new OrderIdempotencyService(
            database as never,
          );

        const handler =
          jest.fn<
            (
              client: unknown,
            ) => Promise<{
              id: string;
            }>
          >();

        await expect(
          service.execute(
            tenantId,
            idempotencyKey,
            'DIFFERENT_HASH',
            handler,
          ),
        ).rejects.toThrow(
          'Idempotency-Key was already used with a different request',
        );

        expect(handler)
          .not.toHaveBeenCalled();

        expect(
          client.query,
        ).toHaveBeenCalledTimes(3);
      },
    );

    it(
      'should reject a currently processing request with the same key and hash',
      async () => {
        const client =
          createMockClient();

        /*
         * Query 1:
         * DELETE expired idempotency key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 2:
         * INSERT conflicts with existing key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 3:
         * Existing request is still PROCESSING.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: 'idem-row-001',
              request_hash:
                'HASH',
              status:
                'PROCESSING',
              response_payload:
                null,
              resource_id:
                null,
              expires_at:
                '2099-01-01T00:00:00Z',
            },
          ],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new OrderIdempotencyService(
            database as never,
          );

        const handler =
          jest.fn<
            (
              client: unknown,
            ) => Promise<{
              id: string;
            }>
          >();

        await expect(
          service.execute(
            tenantId,
            idempotencyKey,
            'HASH',
            handler,
          ),
        ).rejects.toThrow(
          'A request with this Idempotency-Key is already being processed',
        );

        expect(handler)
          .not.toHaveBeenCalled();

        expect(
          client.query,
        ).toHaveBeenCalledTimes(3);
      },
    );

    it(
      'should propagate handler failure and must not mark the request completed',
      async () => {
        const client =
          createMockClient();

        /*
         * Query 1:
         * DELETE expired idempotency key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 0,
          rows: [],
        });

        /*
         * Query 2:
         * INSERT new idempotency key.
         */
        client.query.mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: 'idem-row-001',
            },
          ],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new OrderIdempotencyService(
            database as never,
          );

        const handler =
          jest.fn<
            (
              client: unknown,
            ) => Promise<{
              id: string;
            }>
          >();

        handler.mockRejectedValue(
          new Error(
            'ORDER_CREATE_FAILED',
          ),
        );

        await expect(
          service.execute(
            tenantId,
            idempotencyKey,
            'HASH',
            handler,
          ),
        ).rejects.toThrow(
          'ORDER_CREATE_FAILED',
        );

        expect(handler)
          .toHaveBeenCalledTimes(1);

        /*
         * Only DELETE + INSERT happened.
         * The COMPLETED UPDATE must not run
         * after handler failure.
         *
         * In the real DatabaseService.transaction()
         * the complete transaction is rolled back.
         */
        expect(
          client.query,
        ).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'should generate the same hash regardless of object key order',
      () => {
        const client =
          createMockClient();

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new OrderIdempotencyService(
            database as never,
          );

        const hashA =
          service.createRequestHash({
            factory_id:
              'factory-001',
            order_number:
              'SO-001',
            customer_name:
              'Customer A',
          });

        const hashB =
          service.createRequestHash({
            customer_name:
              'Customer A',
            order_number:
              'SO-001',
            factory_id:
              'factory-001',
          });

        expect(hashA)
          .toBe(hashB);

        expect(hashA)
          .toMatch(/^[a-f0-9]{64}$/);
      },
    );
  },
);
