import { jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import { EdgeDeviceHealthService } from './edge-device-health.service';
import {
  EdgeDriftSeverity,
  EdgeDriftSignalType,
  EdgeRuntimeHealthStatus,
  type EdgeDeviceHealthReportDto,
} from './dto/edge-device-health.dto';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const deviceId = '7c042d3b-efc0-4e1c-a532-720dbe6b154e';
const credentialId = '5c04a5f9-c131-422a-a488-d3d2e22f8f3d';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const reportId = '8b5eac9a-6d7e-4aa1-8d62-d2e8c1d60226';
const reportBaseTime = Date.now() - 60_000;
const reportTime = new Date(reportBaseTime).toISOString();
const lastSyncTime = new Date(reportBaseTime - 60_000).toISOString();
const driftTime = new Date(reportBaseTime - 30_000).toISOString();

function report(overrides: Record<string, unknown> = {}): EdgeDeviceHealthReportDto {
  return {
    health_event_id: reportId,
    reported_at: reportTime,
    agent_version: '1.0.0',
    runtime_status: EdgeRuntimeHealthStatus.DEGRADED,
    pending_batches: 2,
    pending_bytes: 1024,
    last_successful_sync_at: lastSyncTime,
    model_versions: { 'quality-defect': '1.2.0' },
    drift_signals: [
      {
        signal_id: 'd88de39a-74a9-45e6-9427-7f0d4886bca7',
        model_key: 'quality-defect',
        signal_type: EdgeDriftSignalType.LOW_CONFIDENCE,
        severity: EdgeDriftSeverity.WARNING,
        detected_at: driftTime,
        observed_score: 0.64,
        baseline_score: 0.85,
      },
    ],
    capabilities: { cpu: 'arm64', memory_mb: 512 },
    ...overrides,
  } as EdgeDeviceHealthReportDto;
}

function storedReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cba7f8c6-bf14-4d6c-84f7-9cf4da799c99',
    health_event_id: reportId,
    reported_at: reportTime,
    agent_version: '1.0.0',
    runtime_status: EdgeRuntimeHealthStatus.DEGRADED,
    pending_batches: 2,
    pending_bytes: '1024',
    last_successful_sync_at: lastSyncTime,
    model_versions: { 'quality-defect': '1.2.0' },
    drift_signals: report().drift_signals,
    capabilities: { cpu: 'arm64', memory_mb: 512 },
    received_at: new Date(reportBaseTime + 1000).toISOString(),
    request_hash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('EdgeDeviceHealthService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(callback: (client: unknown) => Promise<unknown>, context?: unknown) => Promise<unknown>>(),
  };
  const client = {
    query: jest.fn<(query: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(),
  };
  const iamService = {
    authorize: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  const auditService = {
    record: jest.fn<(...args: unknown[]) => Promise<string>>(),
  };
  let service: EdgeDeviceHealthService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    client.query.mockReset();
    database.transaction.mockReset();
    database.transaction.mockImplementation(async (callback) => callback(client));
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new EdgeDeviceHealthService(
      database as never,
      iamService as never,
      auditService as never,
    );
  });

  it('persists a device health report with versions and drift summaries, without raw data in audit', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ id: credentialId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [storedReport()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.recordReport(
      tenantId,
      factoryId,
      deviceId,
      credentialId,
      report(),
      { requestId: userId },
    );

    expect(result.idempotent).toBe(false);
    expect(result.report).toMatchObject({
      healthEventId: reportId,
      runtimeStatus: EdgeRuntimeHealthStatus.DEGRADED,
      pendingBatches: 2,
      pendingBytes: 1024,
      modelVersions: { 'quality-defect': '1.2.0' },
      driftSignals: [{ severity: 'WARNING', observed_score: 0.64 }],
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO edge_device_health_reports'),
      expect.arrayContaining([
        tenantId,
        factoryId,
        deviceId,
        credentialId,
        reportId,
      ]),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'EDGE_DEVICE_HEALTH',
        action: 'REPORT_HEALTH',
        payload: {
          healthEventId: reportId,
          runtimeStatus: 'DEGRADED',
          pendingBatches: 2,
          pendingBytes: 1024,
          modelCount: 1,
          driftSignalCount: 1,
        },
      }),
    );
    const auditInput = auditService.record.mock.calls[0]?.[0] as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(auditInput?.payload).not.toHaveProperty('modelVersions');
    expect(auditInput?.payload).not.toHaveProperty('driftSignals');
  });

  it('returns the previous report on exact replay and rejects conflicting event-id reuse', async () => {
    const normalizer = service as unknown as {
      normalizeReport: (input: EdgeDeviceHealthReportDto) => Record<string, unknown>;
      hash: (value: unknown) => string;
    };
    const normalized = normalizer.normalizeReport(report());
    const requestHash = normalizer.hash({ tenantId, factoryId, deviceId, ...normalized });
    const prior = storedReport({ request_hash: requestHash });

    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ id: credentialId }] })
      .mockResolvedValueOnce({ rows: [prior] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      service.recordReport(tenantId, factoryId, deviceId, credentialId, report()),
    ).resolves.toMatchObject({ idempotent: true, report: { healthEventId: reportId } });
    expect(auditService.record).not.toHaveBeenCalled();

    client.query.mockReset();
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ id: credentialId }] })
      .mockResolvedValueOnce({ rows: [storedReport({ request_hash: 'b'.repeat(64) })] });
    await expect(
      service.recordReport(tenantId, factoryId, deviceId, credentialId, report()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechecks credential revocation inside the transaction before inserting health', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.recordReport(tenantId, factoryId, deviceId, credentialId, report()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('rejects credentials in capability metadata and drift signals for unknown models', async () => {
    await expect(
      service.recordReport(
        tenantId,
        factoryId,
        deviceId,
        credentialId,
        report({ capabilities: { api_token: 'never-store-this' } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.recordReport(
        tenantId,
        factoryId,
        deviceId,
        credentialId,
        report({
          drift_signals: [{
            signal_id: 'd88de39a-74a9-45e6-9427-7f0d4886bca7',
            model_key: 'missing-model',
            signal_type: EdgeDriftSignalType.INPUT_DRIFT,
            severity: EdgeDriftSeverity.WARNING,
            detected_at: '2026-10-12T07:59:30.000Z',
          }],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('checks IAM permission before listing scoped health history', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: deviceId }] })
      .mockResolvedValueOnce({ rows: [storedReport()] });
    const result = await service.listReports(
      tenantId,
      factoryId,
      userId,
      deviceId,
      10,
      0,
    );
    expect(result.reports).toHaveLength(1);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'edge.devices.health.read',
      factoryId,
    );
    expect(database.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM edge_device_health_reports'),
      [tenantId, factoryId, deviceId, 11, 0],
      { tenantId, userId },
    );
  });
});
