import { jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import { EdgeDeviceGatewayService } from './edge-device-gateway.service';
import { EdgeDeviceProtocol } from './dto/register-edge-device.dto';
import {
  EdgeObservationQuality,
  EdgeObservationSourceMode,
} from './dto/sync-edge-observations.dto';
import { EdgeDeviceStatus } from './dto/set-edge-device-status.dto';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const deviceId = '7c042d3b-efc0-4e1c-a532-720dbe6b154e';

function registerInput(overrides: Record<string, unknown> = {}) {
  return {
    device_key: 'line-1.press-01',
    display_name: 'Press 01',
    protocol: EdgeDeviceProtocol.MQTT,
    device_group: 'line-1',
    capability_profile: { cpu: 'arm64', memory_mb: 512 },
    ...overrides,
  };
}

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: deviceId,
    tenant_id: tenantId,
    factory_id: factoryId,
    device_key: 'line-1.press-01',
    display_name: 'Press 01',
    protocol: EdgeDeviceProtocol.MQTT,
    device_group: 'line-1',
    capability_profile: { cpu: 'arm64', memory_mb: 512 },
    status: EdgeDeviceStatus.ACTIVE,
    registration_hash: 'a'.repeat(64),
    created_by: userId,
    last_seen_at: null,
    last_sync_at: null,
    created_at: '2026-10-12T00:00:00.000Z',
    updated_at: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'f663a312-a4c4-4b33-980c-6e9b9be1cd1c',
    signal_key: 'press.temperature',
    observed_at: '2026-10-12T08:00:00.000Z',
    source_mode: EdgeObservationSourceMode.EDGE_OFFLINE,
    quality: EdgeObservationQuality.GOOD,
    payload: { value: 61.25, unit: 'C' },
    ...overrides,
  };
}

function syncInput(overrides: Record<string, unknown> = {}) {
  return {
    batch_key: 'reconnect-20261012-001',
    observations: [observation()],
    ...overrides,
  };
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '3be5f2ce-799c-4305-a1d0-f6a83f80ba5e',
    batch_key: 'reconnect-20261012-001',
    request_hash: 'b'.repeat(64),
    observations_received: 1,
    observations_inserted: 1,
    observations_deduplicated: 0,
    received_at: '2026-10-12T08:01:00.000Z',
    ...overrides,
  };
}

describe('EdgeDeviceGatewayService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(callback: (client: unknown) => Promise<unknown>, context?: unknown) => Promise<unknown>>(),
  };
  const iamService = {
    authorize: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  const auditService = {
    record: jest.fn<(...args: unknown[]) => Promise<string>>(),
  };
  const client = {
    query: jest.fn<(query: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(),
  };
  let service: EdgeDeviceGatewayService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    client.query.mockReset();
    database.transaction.mockReset();
    database.transaction.mockImplementation(async (callback) => callback(client));
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new EdgeDeviceGatewayService(
      database as never,
      iamService as never,
      auditService as never,
    );
  });

  it('registers a factory-scoped device and records only redacted audit metadata', async () => {
    database.query.mockResolvedValueOnce({ rows: [deviceRow()] });

    const result = await service.registerDevice(
      tenantId,
      factoryId,
      userId,
      registerInput() as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.device.deviceKey).toBe('line-1.press-01');
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'edge.devices.write',
      factoryId,
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'EDGE_DEVICE_REGISTRY',
        action: 'REGISTER',
        payload: expect.objectContaining({
          deviceKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          protocol: 'MQTT',
        }),
      }),
    );
    const auditInput = auditService.record.mock.calls[0]?.[0] as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(auditInput?.payload).not.toHaveProperty('deviceKey');
    expect(auditInput?.payload).not.toHaveProperty('capabilityProfile');
  });

  it('replays an identical device registration idempotently', async () => {
    const normalized = (
      service as unknown as { normalizeDevice: (value: never) => Record<string, unknown> }
    ).normalizeDevice(registerInput() as never);
    const registrationHash = (
      service as unknown as { hash: (value: unknown) => string }
    ).hash({ tenantId, factoryId, ...normalized });

    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [deviceRow({ registration_hash: registrationHash })],
      });

    const result = await service.registerDevice(
      tenantId,
      factoryId,
      userId,
      registerInput() as never,
    );

    expect(result.idempotent).toBe(true);
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('rejects a conflicting registration for an existing device key', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [deviceRow({ registration_hash: 'c'.repeat(64) })] });

    await expect(
      service.registerDevice(tenantId, factoryId, userId, registerInput() as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not access the database when IAM denies device registration', async () => {
    iamService.authorize.mockRejectedValueOnce(new ForbiddenException('denied'));

    await expect(
      service.registerDevice(tenantId, factoryId, userId, registerInput() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects credential material from the device capability profile', async () => {
    await expect(
      service.registerDevice(
        tenantId,
        factoryId,
        userId,
        registerInput({ capability_profile: { access_token: 'do-not-store' } }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('validates pagination bounds before querying device data', async () => {
    await expect(
      service.listDevices(tenantId, factoryId, userId, 1000, 0),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('synchronizes offline observations atomically and deduplicates stable event identities', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'f2e5c8c4-a5e6-4906-a11d-b46c6b512f69' }] })
      .mockResolvedValueOnce({ rows: [batchRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.syncObservations(
      tenantId,
      factoryId,
      userId,
      deviceId,
      syncInput() as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.summary.observationsInserted).toBe(1);
    expect(result.summary.observationsDeduplicated).toBe(0);
    expect(client.query).toHaveBeenCalledTimes(5);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'EDGE_TELEMETRY_SYNC',
        action: 'INGEST_BATCH',
        payload: expect.objectContaining({
          observationsReceived: 1,
          observationsInserted: 1,
          observationsDeduplicated: 0,
        }),
      }),
    );
  });

  it('deduplicates an identical event replayed in a different batch', async () => {
    const payload = syncInput({ batch_key: 'reconnect-20261012-002' });
    const normalized = (
      service as unknown as { normalizeBatch: (value: never) => { batchKey: string; observations: Array<Record<string, unknown>> } }
    ).normalizeBatch(payload as never);
    const event = normalized.observations[0];
    if (!event) throw new Error('Expected normalized event');
    const eventHash = (
      service as unknown as { hash: (value: unknown) => string }
    ).hash({ tenantId, factoryId, deviceId, ...event });

    client.query
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ request_hash: eventHash }] })
      .mockResolvedValueOnce({
        rows: [batchRow({
          batch_key: 'reconnect-20261012-002',
          observations_inserted: 0,
          observations_deduplicated: 1,
        })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.syncObservations(
      tenantId,
      factoryId,
      userId,
      deviceId,
      payload as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.summary.observationsInserted).toBe(0);
    expect(result.summary.observationsDeduplicated).toBe(1);
    expect(client.query).toHaveBeenCalledTimes(6);
  });

  it('returns the stored summary for an identical batch replay without reinserting events', async () => {
    const normalized = (
      service as unknown as { normalizeBatch: (value: never) => { batchKey: string; observations: unknown[] } }
    ).normalizeBatch(syncInput() as never);
    const requestHash = (
      service as unknown as { hash: (value: unknown) => string }
    ).hash({
      tenantId,
      factoryId,
      deviceId,
      batchKey: normalized.batchKey,
      observations: normalized.observations,
    });
    client.query
      .mockResolvedValueOnce({ rows: [deviceRow({ status: EdgeDeviceStatus.PAUSED })] })
      .mockResolvedValueOnce({ rows: [batchRow({ request_hash: requestHash })] });

    const result = await service.syncObservations(
      tenantId,
      factoryId,
      userId,
      deviceId,
      syncInput() as never,
    );

    expect(result.idempotent).toBe(true);
    expect(result.summary.observationsInserted).toBe(1);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('fails closed when a batch key is reused for different content', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [batchRow({ request_hash: 'd'.repeat(64) })] });

    await expect(
      service.syncObservations(
        tenantId,
        factoryId,
        userId,
        deviceId,
        syncInput() as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a new sync batch for a paused device', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [deviceRow({ status: EdgeDeviceStatus.PAUSED })] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.syncObservations(
        tenantId,
        factoryId,
        userId,
        deviceId,
        syncInput() as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('records machine-ingested observations against the active device credential, not a human user', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'active-credential-id' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'new-observation-id' }] })
      .mockResolvedValueOnce({ rows: [batchRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.syncObservations(
      tenantId,
      factoryId,
      null,
      deviceId,
      syncInput() as never,
      {},
      '5c04a5f9-c131-422a-a488-d3d2e22f8f3d',
    );

    expect(result.idempotent).toBe(false);
    expect(client.query.mock.calls[3]?.[0]).toContain('recorded_by_credential_id');
    expect(client.query.mock.calls[3]?.[1]?.[11]).toBeNull();
    expect(client.query.mock.calls[3]?.[1]?.[12]).toBe('5c04a5f9-c131-422a-a488-d3d2e22f8f3d');
    expect(client.query.mock.calls[4]?.[0]).toContain('recorded_by_credential_id');
    expect(client.query.mock.calls[4]?.[1]?.[8]).toBeNull();
    expect(client.query.mock.calls[4]?.[1]?.[9]).toBe('5c04a5f9-c131-422a-a488-d3d2e22f8f3d');
    expect(iamService.authorize).not.toHaveBeenCalled();
  });

  it('refuses telemetry ingestion if the credential is revoked during reconnect', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.syncObservations(
        tenantId,
        factoryId,
        null,
        deviceId,
        syncInput() as never,
        {},
        '5c04a5f9-c131-422a-a488-d3d2e22f8f3d',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(iamService.authorize).not.toHaveBeenCalled();
  });

  it('rejects duplicate event IDs inside one batch before starting a transaction', async () => {
    await expect(
      service.syncObservations(
        tenantId,
        factoryId,
        userId,
        deviceId,
        syncInput({ observations: [observation(), observation()] }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects credential-like keys in telemetry payloads', async () => {
    await expect(
      service.syncObservations(
        tenantId,
        factoryId,
        userId,
        deviceId,
        syncInput({
          observations: [observation({ payload: { temperature: 20, api_key: 'secret' } })],
        }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('does not allow a revoked device to be reactivated', async () => {
    client.query.mockResolvedValueOnce({
      rows: [deviceRow({ status: EdgeDeviceStatus.REVOKED })],
    });

    await expect(
      service.setDeviceStatus(
        tenantId,
        factoryId,
        userId,
        deviceId,
        { status: EdgeDeviceStatus.ACTIVE } as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
