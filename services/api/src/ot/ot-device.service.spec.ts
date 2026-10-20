import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { hashOtValue } from './ot-device.contract';
import { OtDeviceService } from './ot-device.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '8aaab63d-c447-46ce-950d-deebdd7f5f31';
const userId = '9aaab63d-c447-46ce-950d-deebdd7f5f32';
const deviceId = 'aaaaab63-c447-46ce-950d-deebdd7f5f33';

const registerInput = () => ({
  display_name: 'Machine 01',
  device_key: 'MACHINE-01',
  protocol: 'OPC_UA',
  connection_reference: 'config://PLC_A',
  secret_reference: 'env://OT_SECRET_PLC_A',
  metadata: { opcua: { allowed_node_ids: ['ns=2;s=Machine01.Temperature'] } },
});

const deviceRow = (overrides: Record<string, unknown> = {}) => ({
  id: deviceId,
  tenant_id: tenantId,
  factory_id: factoryId,
  display_name: 'Machine 01',
  device_key: 'MACHINE-01',
  protocol: 'OPC_UA',
  connection_reference: 'config://PLC_A',
  metadata: { opcua: { allowed_node_ids: ['ns=2;s=Machine01.Temperature'] } },
  status: 'ACTIVE',
  row_version: 4,
  created_at: '2026-10-19T10:00:00.000Z',
  updated_at: '2026-10-19T10:00:00.000Z',
  reviewed_at: '2026-10-19T10:00:00.000Z',
  paused_at: null,
  revoked_at: null,
  ...overrides,
});

describe('OtDeviceService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  let service: OtDeviceService;

  beforeEach(() => {
    jest.resetAllMocks();
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        ((client: unknown) => Promise<unknown>) | undefined;
      if (!callback) throw new Error('test transaction callback is required');
      return callback({ query: clientQuery } as never);
    });
    service = new OtDeviceService(database as never);
  });

  it('registers a device with a secret-manager reference but never returns the secret reference', async () => {
    const request = registerInput();
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'PENDING_REVIEW', row_version: 1, reviewed_at: null })] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.register(
      { tenantId, factoryId, userId },
      request as never,
      'ot-device-register-1',
    );

    expect(result).toMatchObject({
      id: deviceId,
      device_key: 'MACHINE-01',
      status: 'PENDING_REVIEW',
      row_version: 1,
    });
    expect(result).not.toHaveProperty('secret_reference');
    expect(result).not.toHaveProperty('secretReference');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('INSERT INTO ot_devices');
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      tenantId,
      userId,
      advisoryLockKey: expect.stringContaining('ot-device-registration:'),
    }));
  });

  it('returns an exact registration replay without a duplicate insert or audit event', async () => {
    const input = registerInput();
    const requestHash = hashOtValue({
      display_name: 'Machine 01',
      device_key: 'MACHINE-01',
      protocol: 'OPC_UA',
      connection_reference: 'config://PLC_A',
      secret_reference: 'env://OT_SECRET_PLC_A',
      metadata: normalizeOtObject(input.metadata),
    });
    clientQuery.mockResolvedValueOnce({ rows: [deviceRow({
      status: 'PENDING_REVIEW',
      row_version: 1,
      reviewed_at: null,
      request_hash: requestHash,
    })] });

    const result = await service.register({ tenantId, factoryId, userId }, input as never, 'ot-device-register-1');

    expect(result.status).toBe('PENDING_REVIEW');
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(String(clientQuery.mock.calls[0]?.[0])).toContain('idempotency_key');
  });

  it('rejects a changed registration body reused with an existing idempotency key', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [deviceRow({ request_hash: '0'.repeat(64) })] });
    await expect(service.register(
      { tenantId, factoryId, userId },
      registerInput() as never,
      'ot-device-register-1',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('uses optimistic row versions for lifecycle transitions', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'PAUSED', row_version: 5, paused_at: '2026-10-19T10:01:00.000Z' })] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.transition(
      { tenantId, factoryId, userId },
      deviceId,
      'PAUSE',
      { expected_version: 4, reason: 'scheduled maintenance' } as never,
    );

    expect(result).toMatchObject({ status: 'PAUSED', row_version: 5 });
    expect(String(clientQuery.mock.calls[1]?.[0])).toContain('row_version=$7');
  });

  it('rejects stale lifecycle commands without issuing an update', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [deviceRow({ row_version: 5 })] });
    await expect(service.transition(
      { tenantId, factoryId, userId },
      deviceId,
      'PAUSE',
      { expected_version: 4, reason: 'scheduled maintenance' } as never,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('classifies an identical source-event replay without adding a second ledger row', async () => {
    const payload = { temperature: 24.5 };
    const observedAt = '2026-10-19T10:00:00.000Z';
    const eventFingerprint = hashOtValue({
      source_event_id: 'event-1',
      event_type: 'TEMPERATURE',
      stream_key: 'line-1',
      source_sequence: 1,
      observed_at: observedAt,
      payload,
    });
    clientQuery
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-ledger-id', event_fingerprint_sha256: eventFingerprint }] });

    const result = await service.ingestTelemetry(
      { tenantId, factoryId, userId },
      deviceId,
      { events: [{
        source_event_id: 'event-1',
        event_type: 'TEMPERATURE',
        stream_key: 'line-1',
        source_sequence: 1,
        observed_at: observedAt,
        payload,
      }] } as never,
    );

    expect(result).toMatchObject({ accepted: 0, duplicate_replays: 1, sequence_gaps: 0, late: 0 });
    expect(result.items).toEqual([expect.objectContaining({ source_event_id: 'event-1', status: 'DUPLICATE_REPLAY' })]);
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects reuse of a telemetry source event ID with changed event contents', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-ledger-id', event_fingerprint_sha256: '0'.repeat(64) }] });
    await expect(service.ingestTelemetry(
      { tenantId, factoryId, userId },
      deviceId,
      { events: [{
        source_event_id: 'event-1',
        event_type: 'TEMPERATURE',
        stream_key: 'line-1',
        source_sequence: 1,
        observed_at: '2026-10-19T10:00:00.000Z',
        payload: { temperature: 999 },
      }] } as never,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects credential fields from telemetry instead of persisting accidental secrets', async () => {
    await expect(service.ingestTelemetry(
      { tenantId, factoryId, userId },
      deviceId,
      { events: [{
        source_event_id: 'event-credential',
        event_type: 'TEMPERATURE',
        stream_key: 'line-1',
        observed_at: '2026-10-19T10:00:00.000Z',
        payload: { temperature: 24.5, access_token: 'must-not-persist' },
      }] } as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when telemetry targets a device outside the active factory context', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] });
    await expect(service.ingestTelemetry(
      { tenantId, factoryId, userId },
      deviceId,
      { events: [{
        source_event_id: 'event-foreign',
        event_type: 'TEMPERATURE',
        stream_key: 'line-1',
        observed_at: '2026-10-19T10:00:00.000Z',
        payload: { temperature: 24.5 },
      }] } as never,
    )).rejects.toBeInstanceOf(NotFoundException); // unknown devices are deliberately not disclosed across tenant/factory scopes
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });
});
