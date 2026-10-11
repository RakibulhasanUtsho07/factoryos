import { jest } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SaasSandboxDataMode, SaasSandboxPurpose } from './dto/create-saas-sandbox-environment.dto';
import { SaasSandboxService } from './saas-sandbox.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const environmentId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

describe('SaasSandboxService', () => {
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<string>>() };
  let service: SaasSandboxService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.record.mockResolvedValue('audit-event-id');
    service = new SaasSandboxService(database as never, iam as never, audit as never);
  });

  it('rejects customer rows or other arbitrary fields in a synthetic dataset manifest', async () => {
    await expect(service.createEnvironment(tenantId, actorUserId, {
      environment_code: 'DEMO',
      display_name: 'Demo sandbox',
      purpose: SaasSandboxPurpose.DEMO,
      data_mode: SaasSandboxDataMode.SYNTHETIC,
      dataset_manifest: {
        generator: 'factoryos-fixture-generator',
        generator_version: '1.0.0',
        schema_version: 'factory.v1',
        record_count: 3,
        rows: [{ email: 'worker@example.test' }],
      },
      idempotency_key: 'sandbox-manifest-reject',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).toHaveBeenCalledWith(actorUserId, tenantId, 'saas.sandboxes.write');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects masked data without an assessed low/medium residual risk and reviewed fields', async () => {
    await expect(service.createEnvironment(tenantId, actorUserId, {
      environment_code: 'MASKED',
      display_name: 'Masked evaluation',
      purpose: SaasSandboxPurpose.EVALUATION,
      data_mode: SaasSandboxDataMode.MASKED,
      dataset_manifest: {
        dataset_reference: 'warehouse-snapshot:batch-42',
        schema_version: 'factory.v1',
        record_count: 12,
        masking_policy_version: 'mask-v2',
        masked_at: '2026-10-10T00:00:00.000Z',
        checksum_sha256: 'a'.repeat(64),
      },
      privacy_assessment: {
        data_minimization_status: 'ASSESSED',
        residual_risk: 'HIGH',
        reviewed_fields: ['worker_id'],
        assessed_at: '2026-10-10T00:00:00.000Z',
      },
      idempotency_key: 'sandbox-risk-reject',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed tenant scope before touching IAM or storage', async () => {
    await expect(service.listEnvironments('not-a-tenant', actorUserId)).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('fails closed when the target environment is not active', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{ data_mode: SaasSandboxDataMode.SYNTHETIC, status: 'SUSPENDED', approval_expires_at: null }],
    });
    await expect(service.assertSandboxUsable(tenantId, environmentId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed if masked-data approval has expired despite an ACTIVE stored status', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        data_mode: SaasSandboxDataMode.MASKED,
        status: 'ACTIVE',
        approval_expires_at: '2020-01-01T00:00:00.000Z',
      }],
    });
    await expect(service.assertSandboxUsable(tenantId, environmentId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows synthetic sandbox access only with an active tenant-scoped record', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{ data_mode: SaasSandboxDataMode.SYNTHETIC, status: 'ACTIVE', approval_expires_at: null }],
    });
    await expect(service.assertSandboxUsable(tenantId, environmentId)).resolves.toBeUndefined();
    expect(database.query.mock.calls[0]?.[2]).toEqual({ tenantId });
  });

  it('allows masked sandbox access only while explicit approval remains in date', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        data_mode: SaasSandboxDataMode.MASKED,
        status: 'ACTIVE',
        approval_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    await expect(service.assertSandboxUsable(tenantId, environmentId)).resolves.toBeUndefined();
  });
});
