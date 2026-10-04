import { randomUUID } from 'node:crypto';

import { OutboxDispatcherService } from './outbox.dispatcher.service';

type QueryCall = {
  sql: string;
  params: readonly unknown[];
};

describe(
  'OutboxDispatcherService',
  () => {
    it(
      'should fail when markPublished updates zero rows',
      async () => {
        const queryCalls: QueryCall[] = [];

        const eventId =
          randomUUID();

        const database = {
          query: async (
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            queryCalls.push({
              sql,
              params,
            });

            return {
              rowCount: 0,
              rows: [],
            };
          },
        };

        const dispatcher =
          new OutboxDispatcherService(
            database as never,
            {} as never,
            {} as never,
          );

        const internal =
          dispatcher as unknown as {
            markPublished: (
              eventId: string,
            ) => Promise<void>;
          };

        await expect(
          internal.markPublished(
            eventId,
          ),
        ).rejects.toThrow(
          'OUTBOX_MARK_PUBLISHED_FAILED',
        );

        expect(
          queryCalls.length,
        ).toBe(1);

        expect(
          queryCalls[0].sql,
        ).toContain(
          'RETURNING id',
        );

        expect(
          queryCalls[0].sql,
        ).toContain(
          "status = 'PUBLISHED'",
        );

        expect(
          queryCalls[0].params[0],
        ).toBe(eventId);

        expect(
          typeof queryCalls[0].params[1],
        ).toBe('string');
      },
    );

    it(
      'should succeed when exactly one row is marked PUBLISHED',
      async () => {
        const queryCalls: QueryCall[] = [];

        const eventId =
          randomUUID();

        const database = {
          query: async (
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            queryCalls.push({
              sql,
              params,
            });

            return {
              rowCount: 1,
              rows: [
                {
                  id: eventId,
                },
              ],
            };
          },
        };

        const dispatcher =
          new OutboxDispatcherService(
            database as never,
            {} as never,
            {} as never,
          );

        const internal =
          dispatcher as unknown as {
            markPublished: (
              eventId: string,
            ) => Promise<void>;
          };

        await expect(
          internal.markPublished(
            eventId,
          ),
        ).resolves.toBeUndefined();

        expect(
          queryCalls.length,
        ).toBe(1);

        expect(
          queryCalls[0].sql,
        ).toContain(
          'RETURNING id',
        );

        expect(
          queryCalls[0].sql,
        ).toContain(
          "status = 'PUBLISHED'",
        );

        expect(
          queryCalls[0].params[0],
        ).toBe(eventId);

        expect(
          typeof queryCalls[0].params[1],
        ).toBe('string');
      },
    );
  },
);