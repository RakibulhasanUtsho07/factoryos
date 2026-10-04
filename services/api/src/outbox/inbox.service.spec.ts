import { jest } from '@jest/globals';

import { InboxService } from './inbox.service';

type QueryResult = {
  rowCount: number;
  rows: Array<{
    id: string;
  }>;
};

type QueryFunction = (
  ...args: unknown[]
) => Promise<QueryResult>;

describe('InboxService', () => {
  const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  const consumerName = 'order-indexer-v1';
  const eventId = '61f6a0d0-86fb-47ac-ba52-f64757aa06b0';

  function createMockClient() {
    const query = jest.fn<QueryFunction>();

    return {
      query,
    };
  }

  function createService(
    client: ReturnType<typeof createMockClient>,
  ) {
    const transaction = jest.fn(
      async <T>(
        callback: (client: unknown) => Promise<T>,
      ): Promise<T> => {
        return callback(client);
      },
    );

    const database = {
      transaction,
    };

    return {
      service: new InboxService(database as never),
      database,
    };
  }

  it('should execute the handler on first delivery', async () => {
    const client = createMockClient();

    client.query
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: '7063f795-afa6-4bdb-bdcc-359720602e1a',
          },
        ],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [],
      });

    const { service, database } = createService(client);

    const handler = jest.fn<
      () => Promise<{ indexed: boolean }>
    >();

    handler.mockResolvedValue({
      indexed: true,
    });

    const result = await service.executeOnce(
      tenantId,
      consumerName,
      eventId,
      handler,
    );

    expect(result).toEqual({
      duplicate: false,
      result: {
        indexed: true,
      },
    });

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('should skip the handler on duplicate delivery', async () => {
    const client = createMockClient();

    client.query.mockResolvedValueOnce({
      rowCount: 0,
      rows: [],
    });

    const { service, database } = createService(client);

    const handler = jest.fn<
      () => Promise<{ indexed: boolean }>
    >();

    handler.mockResolvedValue({
      indexed: true,
    });

    const result = await service.executeOnce(
      tenantId,
      consumerName,
      eventId,
      handler,
    );

    expect(result).toEqual({
      duplicate: true,
      result: null,
    });

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('should not mark the inbox event processed when the handler fails', async () => {
    const client = createMockClient();

    client.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: '7063f795-afa6-4bdb-bdcc-359720602e1a',
        },
      ],
    });

    const { service, database } = createService(client);

    const handler = jest.fn<
      () => Promise<{ indexed: boolean }>
    >();

    handler.mockRejectedValue(
      new Error('BUSINESS_HANDLER_FAILED'),
    );

    await expect(
      service.executeOnce(
        tenantId,
        consumerName,
        eventId,
        handler,
      ),
    ).rejects.toThrow('BUSINESS_HANDLER_FAILED');

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});