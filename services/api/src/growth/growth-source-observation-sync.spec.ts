import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { GrowthService } from './growth.service';
import { GrowthSourceOfRecordService } from './growth-source-of-record.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const OTHER_USER_ID = 'ae5826b7-e1ef-4f91-b4b9-c79b7aeae324';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const OPPORTUNITY_ID = 'a9816b59-9f47-4bcb-b594-8ef2b23c0cb8';
const SOURCE_ID = '139e9b4d-c14f-45ec-a2da-471df53c74c3';
const IDEMPOTENCY_KEY = 'sync-run-2026-10';
const ADAPTER_VERSION = 'factoryos.growth.source-of-record.v1';

describe('GrowthSourceOfRecordService source KPI synchronization', () => {
  let service: GrowthSourceOfRecordService;
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let client: { query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn().mockImplementation(async (_options: unknown, callback: (tx: unknown) => Promise<unknown>) => callback(client)),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new GrowthSourceOfRecordService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
      { recordExperimentResult: jest.fn() } as unknown as GrowthService,
    );
  });

  function dto(metric_keys = ['production.good_quantity']) {
    return {
      source_kind: 'PRODUCTION_OUTPUT' as const,
      source_record_ids: [SOURCE_ID],
      metric_keys,
      idempotency_key: IDEMPOTENCY_KEY,
    };
  }

  function sourceRow() {
    return {
      id: SOURCE_ID,
      created_at: '2026-10-18T14:00:00.000Z',
      unit: 'PCS',
      good_quantity: '970.0000',
      scrap_quantity: '30.0000',
      yield_percentage: '97.0000',
      cumulative_yield_percentage: '95.5000',
      request_hash: 'a'.repeat(64),
    };
  }

  function successResponses() {
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACCEPTED' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sourceRow()] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it('records source-derived values, canonical units, timestamps and immutable revision fingerprints', async () => {
    successResponses();
    const result = await service.syncObservations(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto(), null, null,
    );

    expect(result.replayed).toBe(false);
    expect(result.adapter_version).toBe(ADAPTER_VERSION);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      source_kind: 'PRODUCTION_OUTPUT',
      metric_key: 'production.good_quantity',
      unit: 'PCS',
      value: '970.00000000',
      observed_at: '2026-10-18T14:00:00.000Z',
      source_record_ref: `production-output:${SOURCE_ID}`,
      source_revision_hash: 'a'.repeat(64),
    });

    const observationInsert = client.query.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO growth_kpi_source_observations'));
    expect(observationInsert).toBeDefined();
    if (!observationInsert) throw new Error('Expected source observation insert');
    const values = observationInsert[1] as unknown[];
    const observationId = values[0] as string;
    const evidenceId = values[16] as string;
    expect(observationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.observations[0].id).toBe(observationId);
    expect(result.observations[0].evidence_id).toBe(evidenceId);
    expect(values[5]).toBe('PRODUCTION_OUTPUT');
    expect(values[6]).toBe(ADAPTER_VERSION);
    expect(values[8]).toBe('PCS');
    expect(values[9]).toBe('970.00000000');
    expect(values[10]).toBe('2026-10-18T14:00:00.000Z');
    expect(values[11]).toBe(`production-output:${SOURCE_ID}`);
    expect(values[12]).toBe('a'.repeat(64));
    expect(values[15]).toBe(SOURCE_ID);

    const evidenceInsert = client.query.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO growth_opportunity_evidence('));
    if (!evidenceInsert) throw new Error('Expected source evidence insert');
    expect(evidenceInsert[1]).toContain(`factoryos://growth/source-observations/${observationId}`);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SOURCE_OF_RECORD_KPI_SYNC',
      payload: expect.objectContaining({ adapterVersion: ADAPTER_VERSION, observationCount: 1 }),
    }));
  });

  it('uses a stable input fingerprint independent of the actor', async () => {
    successResponses();
    await service.syncObservations(USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto(), null, null);
    const firstRun = client.query.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO growth_kpi_source_sync_runs'));
    const firstHash = (firstRun?.[1] as unknown[])[7];

    client.query.mockReset();
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACCEPTED' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sourceRow()] })
      .mockResolvedValueOnce({ rows: [] });
    await service.syncObservations(OTHER_USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto(), null, null);
    const secondRun = client.query.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO growth_kpi_source_sync_runs'));
    expect((secondRun?.[1] as unknown[])[7]).toBe(firstHash);

    const canonical = JSON.stringify({
      schema_version: 1,
      adapter_version: ADAPTER_VERSION,
      tenant_id: TENANT_ID,
      factory_id: FACTORY_ID,
      opportunity_id: OPPORTUNITY_ID,
      source_kind: 'PRODUCTION_OUTPUT',
      source_record_ids: [SOURCE_ID],
      metric_keys: ['production.good_quantity'],
    });
    expect(firstHash).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('rejects cross-adapter metrics before opening a transaction', async () => {
    await expect(service.syncObservations(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID,
      dto(['finance.actual_revenue']), null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('refuses source record IDs that are not found in the active factory ledger', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACCEPTED' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.syncObservations(
      USER_ID, TENANT_ID, FACTORY_ID, OPPORTUNITY_ID, dto(), null, null,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(client.query.mock.calls.some(call => String(call[0]).includes('INSERT INTO growth_kpi_source_observations'))).toBe(false);
  });
});
