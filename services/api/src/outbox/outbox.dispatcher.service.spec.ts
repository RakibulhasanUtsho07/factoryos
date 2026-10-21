import {
  randomUUID,
} from 'node:crypto';

import {
  OutboxDispatcherService,
} from './outbox.dispatcher.service';
import { HttpMetricsService } from '../observability/http-metrics.service';

type QueryCall = {
  sql: string;

  params:
    readonly unknown[];
};

describe(
  'OutboxDispatcherService',
  () => {
    it('aggregates queue freshness only through tenant-context queries without tenant labels', async () => {
      const firstTenant = randomUUID();
      const secondTenant = randomUUID();
      const contexts: Array<{ tenantId?: string } | undefined> = [];
      const database = {
        query: async (sql: string, _params: readonly unknown[] = [], context?: { tenantId?: string }) => {
          if (context) contexts.push(context);
          if (context?.tenantId === firstTenant) {
            return { rows: [
              { status: 'PENDING', event_count: '2', oldest_age_seconds: '9', seconds_since_last_publish: '50' },
              { status: null, event_count: '0', oldest_age_seconds: '0', seconds_since_last_publish: '50' },
            ] };
          }
          if (context?.tenantId === secondTenant) {
            return { rows: [
              { status: 'FAILED', event_count: '1', oldest_age_seconds: '90', seconds_since_last_publish: '7' },
            ] };
          }
          throw new Error('Unexpected unscoped queue metrics query');
        },
      };
      const metrics = new HttpMetricsService();
      const dispatcher = new OutboxDispatcherService(
        database as never,
        {} as never,
        {} as never,
        undefined,
        metrics,
      );
      const internal = dispatcher as unknown as {
        collectQueueMetrics: (tenants: { id: string }[]) => Promise<void>;
      };

      await internal.collectQueueMetrics([{ id: firstTenant }, { id: secondTenant }]);

      expect(contexts).toEqual([{ tenantId: firstTenant }, { tenantId: secondTenant }]);
      const output = metrics.renderPrometheus();
      expect(output).toContain('factoryos_outbox_events{status="PENDING"} 2');
      expect(output).toContain('factoryos_outbox_events{status="FAILED"} 1');
      expect(output).toContain('factoryos_outbox_oldest_age_seconds{status="FAILED"} 90');
      expect(output).toContain('factoryos_outbox_freshness_seconds_since_last_publish 7');
      expect(output).not.toContain(firstTenant);
      expect(output).not.toContain(secondTenant);
    });

    it('marks queue metrics collection failed when any tenant snapshot fails', async () => {
      const tenantId = randomUUID();
      const metrics = new HttpMetricsService();
      metrics.recordOutboxQueueSnapshot([{ status: 'PENDING', count: 4, oldestAgeSeconds: 30 }], 10);
      const database = {
        query: async () => { throw new Error('synthetic database error'); },
      };
      const dispatcher = new OutboxDispatcherService(
        database as never,
        {} as never,
        {} as never,
        undefined,
        metrics,
      );
      const internal = dispatcher as unknown as {
        collectQueueMetrics: (tenants: { id: string }[]) => Promise<void>;
      };

      await internal.collectQueueMetrics([{ id: tenantId }]);

      const output = metrics.renderPrometheus();
      expect(output).toContain('factoryos_outbox_metrics_collection_success 0');
      expect(output).toContain('factoryos_outbox_metrics_collection_errors_total 1');
      expect(output).toContain('factoryos_outbox_events{status="PENDING"} 4');
      expect(output).not.toContain(tenantId);
    });

    it(
      'should fail when markPublished updates zero rows',
      async () => {
        const queryCalls:
          QueryCall[] = [];

        const eventId =
          randomUUID();

        const tenantId =
          randomUUID();

        const database = {
          query: async (
            sql: string,

            params:
              readonly unknown[] =
                [],
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

              tenantId: string,
            ) => Promise<void>;
          };

        await expect(
          internal.markPublished(
            eventId,

            tenantId,
          ),
        ).rejects.toThrow(
          'OUTBOX_MARK_PUBLISHED_FAILED',
        );

        expect(
          queryCalls,
        ).toHaveLength(1);

        expect(
          queryCalls[0]
            .sql,
        ).toMatch(
          /RETURNING\s+id/i,
        );

        expect(
          queryCalls[0]
            .sql,
        ).toMatch(
          /status\s*=\s*'PUBLISHED'/i,
        );

        expect(
          queryCalls[0]
            .params[0],
        ).toBe(
          eventId,
        );

        expect(
          queryCalls[0]
            .params[1],
        ).toBe(
          tenantId,
        );

        expect(
          typeof
            queryCalls[0]
              .params[2],
        ).toBe(
          'string',
        );
      },
    );

    it(
      'should succeed when exactly one row is marked PUBLISHED',
      async () => {
        const queryCalls:
          QueryCall[] = [];

        const eventId =
          randomUUID();

        const tenantId =
          randomUUID();

        const database = {
          query: async (
            sql: string,

            params:
              readonly unknown[] =
                [],
          ) => {
            queryCalls.push({
              sql,

              params,
            });

            return {
              rowCount: 1,

              rows: [
                {
                  id:
                    eventId,
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

              tenantId: string,
            ) => Promise<void>;
          };

        await expect(
          internal.markPublished(
            eventId,

            tenantId,
          ),
        ).resolves.toBeUndefined();

        expect(
          queryCalls,
        ).toHaveLength(1);

        expect(
          queryCalls[0]
            .sql,
        ).toMatch(
          /RETURNING\s+id/i,
        );

        expect(
          queryCalls[0]
            .sql,
        ).toMatch(
          /status\s*=\s*'PUBLISHED'/i,
        );

        expect(
          queryCalls[0]
            .params[0],
        ).toBe(
          eventId,
        );

        expect(
          queryCalls[0]
            .params[1],
        ).toBe(
          tenantId,
        );

        expect(
          typeof
            queryCalls[0]
              .params[2],
        ).toBe(
          'string',
        );
      },
    );
  },
);