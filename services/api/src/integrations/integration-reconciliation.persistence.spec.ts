import type { PoolClient } from 'pg';
import {
  normalizeOperationalEvent,
  recordOperationalWebhookEvent,
  recordOperationalWebhookReplay,
  type OperationalWebhookInput,
} from './integration-reconciliation.store';

const baseInput = (
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<OperationalWebhookInput> = {},
): OperationalWebhookInput => ({
  tenantId: '9ba278d1-166b-4bf0-a3bc-5b427a983391',
  factoryId: 'a3e61b54-3b8a-4c35-bf0b-0c2d58b0534d',
  connectorId: '4b6d2019-a69d-43d1-a9d2-ec97a71e2c49',
  sourceSystem: 'MES',
  externalEventId: 'mes-event-200',
  eventType,
  schemaVersion: 1,
  payloadSha256: 'a'.repeat(64),
  correlationId: null,
  payload,
  ...overrides,
});

describe('operational reconciliation persistence behavior', () => {
  it('opens an actionable sequence-gap case without mutating prior source events', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('MAX(source_sequence)::text AS max_sequence')) {
        return { rows: [{ max_sequence: '1' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO integration_reconciliation_events')) {
        return { rows: [{ id: 'e0000000-0000-4000-8000-000000000003' }], rowCount: 1 };
      }
      if (sql.includes('SELECT DISTINCT source_sequence::text AS source_sequence')) {
        return { rows: [{ source_sequence: '1' }, { source_sequence: '3' }], rowCount: 2 };
      }
      if (sql.includes('MAX(watermark_through_sequence)::text AS watermark')) {
        return { rows: [{ watermark: null }], rowCount: 1 };
      }
      if (sql.includes('SELECT id::text AS id,case_key FROM integration_reconciliation_cases')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('COUNT(*)::text AS count')) {
        return { rows: [{ count: '1', event_ids: ['e0000000-0000-4000-8000-000000000001'], source_event_ids: ['mes-event-199'] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query } as unknown as PoolClient;
    const input = baseInput('PRODUCTION.OPERATION.COMPLETED', {
      occurred_at: '2026-10-18T08:00:00+06:00',
      stream_key: 'WO-100:OP-20',
      source_sequence: 3,
      work_order_id: 'WO-100',
      operation_id: '20',
      good_quantity: 12,
    });

    await recordOperationalWebhookEvent(client, input);

    const gap = calls.find((call) =>
      call.sql.includes('INSERT INTO integration_reconciliation_cases') &&
      call.values[5] === 'MISSING_SEQUENCE_RANGE',
    );
    expect(gap).toBeDefined();
    expect(JSON.parse(String(gap?.values[9]))).toEqual(expect.objectContaining({
      missing_from_sequence: 2,
      missing_through_sequence: 2,
      preceding_sequence: 1,
      following_sequence: 3,
      confirmed_by_watermark: false,
    }));
    expect(calls.some((call) => call.sql.includes('UPDATE integration_reconciliation_events'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('INSERT INTO integration_reconciliation_attempts') && call.values[7] === 'ACCEPTED')).toBe(true);
  });

  it('creates a review case when the same connector repeats a business key under a different event ID', async () => {
    const payload = {
      occurred_at: '2026-10-18T08:00:00Z',
      stream_key: 'WO-100:OP-20',
      reconciliation_key: 'WO-100:OP-20:COMPLETE:1',
      work_order_id: 'WO-100',
      operation_id: '20',
      good_quantity: 12,
      scrap_quantity: 1,
    };
    const comparison = normalizeOperationalEvent({
      eventType: 'PRODUCTION.OPERATION.COMPLETED',
      payload,
    })?.comparisonSha256;
    if (!comparison) throw new Error('expected normalized comparison hash');
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('INSERT INTO integration_reconciliation_events')) {
        return { rows: [{ id: 'e0000000-0000-4000-8000-000000000002' }], rowCount: 1 };
      }
      if (sql.includes('SELECT id::text AS id,external_event_id,comparison_sha256')) {
        return { rows: [{ id: 'e0000000-0000-4000-8000-000000000001', external_event_id: 'mes-event-199', comparison_sha256: comparison }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query } as unknown as PoolClient;
    await recordOperationalWebhookEvent(
      client,
      baseInput('PRODUCTION.OPERATION.COMPLETED', payload, { externalEventId: 'mes-event-200' }),
    );

    const duplicate = calls.find((call) =>
      call.sql.includes('INSERT INTO integration_reconciliation_cases') &&
      call.values[5] === 'DUPLICATE_BUSINESS_EVENT',
    );
    expect(duplicate).toBeDefined();
    expect(JSON.parse(String(duplicate?.values[9]))).toEqual(expect.objectContaining({
      comparison_match: true,
      source_event_ids: ['mes-event-199', 'mes-event-200'],
    }));
  });

  it('records a conflicting operational replay even when no prior operational projection exists', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    });
    const client = { query } as unknown as PoolClient;
    await recordOperationalWebhookReplay(
      client,
      baseInput('QUALITY.INSPECTION.RESULT', {
        occurred_at: '2026-10-18T08:00:00Z',
        reconciliation_key: 'inspection-500:result',
        inspection_id: 'inspection-500',
        result: 'FAIL',
      }),
      'CONFLICTING_DUPLICATE',
    );

    const attempt = calls.find((call) => call.sql.includes('INSERT INTO integration_reconciliation_attempts'));
    const conflictCase = calls.find((call) =>
      call.sql.includes('INSERT INTO integration_reconciliation_cases') &&
      call.values[5] === 'CONFLICTING_DUPLICATE',
    );
    expect(attempt?.values[3]).toBeNull();
    expect(attempt?.values[7]).toBe('CONFLICTING_DUPLICATE');
    expect(conflictCase?.values[3]).toBeNull();
    expect(JSON.parse(String(conflictCase?.values[9]))).toEqual(expect.objectContaining({
      accepted_operational_evidence_available: false,
    }));
  });
});
