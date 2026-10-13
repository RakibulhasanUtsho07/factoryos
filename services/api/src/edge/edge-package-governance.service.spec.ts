import { createHash, generateKeyPairSync } from 'node:crypto';

import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import { EdgePackageControlAction, EdgePackageControlTargetKind } from './dto/set-edge-package-control.dto';
import { EdgePackageGovernanceService } from './edge-package-governance.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const deviceId = '7c042d3b-efc0-4e1c-a532-720dbe6b154e';
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createHash('sha256').update(
  keyPair.publicKey.export({ type: 'spki', format: 'der' }),
).digest('hex');

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '5c04a5f9-c131-422a-a488-d3d2e22f8f3d',
    key_id: 'edge-signing-v2',
    public_key_pem: publicKeyPem,
    fingerprint_sha256: fingerprint,
    status: 'ACTIVE',
    replaces_key_id: null,
    created_at: '2026-10-12T12:00:00.000Z',
    revoked_at: null,
    revoke_reason: null,
    ...overrides,
  };
}

function controlRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f8bbf928-f14f-47a5-b86c-43a047a77ae0',
    package_id: 'quality-defect',
    package_version: '*',
    target_kind: EdgePackageControlTargetKind.FACTORY,
    target_key: '*',
    status: 'PAUSED',
    reason: 'Pause until plant safety review completes',
    created_at: '2026-10-12T12:00:00.000Z',
    updated_at: '2026-10-12T12:00:00.000Z',
    revoked_at: null,
    ...overrides,
  };
}

describe('EdgePackageGovernanceService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(callback: (client: unknown) => Promise<unknown>, context?: unknown) => Promise<unknown>>(),
  };
  const client = {
    query: jest.fn<(query: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(),
  };
  const iamService = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const auditService = { record: jest.fn<(...args: unknown[]) => Promise<string>>() };
  let service: EdgePackageGovernanceService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    client.query.mockReset();
    database.transaction.mockReset();
    database.transaction.mockImplementation(async callback => callback(client));
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new EdgePackageGovernanceService(database as never, iamService as never, auditService as never);
  });

  it('registers only Ed25519 public keys and stores the key lifecycle event atomically', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [keyRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await service.registerSigningKey(tenantId, factoryId, userId, {
      key_id: 'edge-signing-v2',
      public_key_pem: publicKeyPem,
    });
    expect(result.idempotent).toBe(false);
    expect(result.signingKey).toMatchObject({
      keyId: 'edge-signing-v2',
      fingerprintSha256: fingerprint,
      status: 'ACTIVE',
    });
    expect(result.signingKey).not.toHaveProperty('publicKeyPem');
    expect(client.query.mock.calls[1]?.[0]).toContain('INSERT INTO edge_package_signing_keys');
    expect(client.query.mock.calls[2]?.[0]).toContain('INSERT INTO edge_package_signing_key_events');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'EDGE_PACKAGE_SIGNING_KEY',
      action: 'REGISTER',
      payload: { keyId: 'edge-signing-v2', fingerprintSha256: fingerprint, replacesKeyId: null },
    }));
  });

  it('rejects private-key PEM and non-Ed25519 keys before opening a database transaction', async () => {
    const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await expect(service.registerSigningKey(tenantId, factoryId, userId, {
      key_id: 'bad-private-key',
      public_key_pem: privateKeyPem,
    })).rejects.toBeInstanceOf(BadRequestException);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPublic = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await expect(service.registerSigningKey(tenantId, factoryId, userId, {
      key_id: 'bad-rsa-key',
      public_key_pem: rsaPublic,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('adds a new rotation key without silently revoking the previous key', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [keyRow({ id: 'old-key-id', key_id: 'edge-signing-v1' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [keyRow({
        id: 'new-key-id',
        key_id: 'edge-signing-v2',
        replaces_key_id: 'old-key-id',
      })] })
      .mockResolvedValueOnce({ rows: [] });
    const newPair = generateKeyPairSync('ed25519');
    const nextPem = newPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const result = await service.registerSigningKey(tenantId, factoryId, userId, {
      key_id: 'edge-signing-v2',
      public_key_pem: nextPem,
      replaces_key_id: 'edge-signing-v1',
    });
    expect(result.previousKeyRemainsTrusted).toBe(true);
    expect(client.query.mock.calls[2]?.[0]).toContain('INSERT INTO edge_package_signing_keys');
    expect(client.query.mock.calls[3]?.[0]).toContain('INSERT INTO edge_package_signing_key_events');
    expect(client.query.mock.calls[3]?.[1]?.[4]).toBe('ROTATION_ADDED');
  });

  it('revokes a signing key once and treats repeated revocation as idempotent', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [keyRow()] })
      .mockResolvedValueOnce({ rows: [keyRow({ status: 'REVOKED', revoked_at: '2026-10-12T12:05:00.000Z', revoke_reason: 'Key compromised during security review' })] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await service.revokeSigningKey(tenantId, factoryId, userId, 'edge-signing-v2', {
      reason: 'Key compromised during security review',
    });
    expect(result.idempotent).toBe(false);
    expect(result.signingKey.status).toBe('REVOKED');
    expect(client.query.mock.calls[1]?.[0]).toContain("status='REVOKED'");
    expect(client.query.mock.calls[2]?.[0]).toContain('edge_package_signing_key_events');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'REVOKE' }));
  });

  it('exposes active and revoked public keys to an internal verifier bridge', async () => {
    database.query.mockResolvedValueOnce({ rows: [
      { key_id: 'active-key', public_key_pem: publicKeyPem, status: 'ACTIVE' },
      { key_id: 'revoked-key', public_key_pem: publicKeyPem, status: 'REVOKED' },
    ] });
    const keys = await service.getTrustedSigningKeys(tenantId, factoryId);
    expect(keys['active-key']).toEqual({ publicKeyPem, status: 'ACTIVE' });
    expect(keys['revoked-key']).toEqual({ publicKeyPem, status: 'REVOKED' });
    expect(database.query.mock.calls[0]?.[2]).toEqual({ tenantId });
  });

  it('returns a complete device verifier snapshot with active and revoked public keys only', async () => {
    database.query.mockResolvedValueOnce({ rows: [
      { key_id: 'active-key', public_key_pem: publicKeyPem, fingerprint_sha256: fingerprint, status: 'ACTIVE' },
      { key_id: 'revoked-key', public_key_pem: publicKeyPem, fingerprint_sha256: fingerprint, status: 'REVOKED' },
    ] });
    const snapshot = await service.getTrustedSigningKeySnapshot(tenantId, factoryId);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      tenantId,
      factoryId,
      checkedAt: expect.any(String),
      signingKeys: [
        { keyId: 'active-key', publicKeyPem, fingerprintSha256: fingerprint, status: 'ACTIVE' },
        { keyId: 'revoked-key', publicKeyPem, fingerprintSha256: fingerprint, status: 'REVOKED' },
      ],
    });
    expect(database.query.mock.calls[0]?.[0]).toContain('LIMIT 513');
    expect(database.query.mock.calls[0]?.[1]).toEqual([tenantId, factoryId]);
  });

  it('refuses an oversized signer snapshot instead of silently omitting historical revoked keys', async () => {
    database.query.mockResolvedValueOnce({ rows: Array.from({ length: 513 }, (_, index) => ({
      key_id: `key-${index}`,
      public_key_pem: publicKeyPem,
      fingerprint_sha256: fingerprint,
      status: 'ACTIVE',
    })) });
    await expect(service.getTrustedSigningKeySnapshot(tenantId, factoryId)).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates an immutable pause control for a registered factory scope', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [controlRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await service.setPackageControl(tenantId, factoryId, userId, {
      package_id: 'quality-defect',
      target_kind: EdgePackageControlTargetKind.FACTORY,
      action: EdgePackageControlAction.PAUSE,
      reason: 'Pause until plant safety review completes',
    });
    expect(result.idempotent).toBe(false);
    expect(result.control).toMatchObject({
      packageId: 'quality-defect',
      targetKind: 'FACTORY',
      targetKey: '*',
      status: 'PAUSED',
    });
    expect(client.query.mock.calls[1]?.[0]).toContain('INSERT INTO edge_package_controls');
    expect(client.query.mock.calls[2]?.[0]).toContain('edge_package_control_events');
  });

  it('does not allow a permanent revocation to be resumed', async () => {
    client.query.mockResolvedValueOnce({ rows: [controlRow({ status: 'REVOKED' })] });
    await expect(service.setPackageControl(tenantId, factoryId, userId, {
      package_id: 'quality-defect',
      target_kind: EdgePackageControlTargetKind.FACTORY,
      action: EdgePackageControlAction.RESUME,
      reason: 'Attempted resume after revoke',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('computes the strongest matching device, group, use-case, and factory control', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: deviceId, device_group: 'line-1', status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [
        controlRow({ target_kind: EdgePackageControlTargetKind.FACTORY, status: 'PAUSED', reason: 'Factory pause reason' }),
        controlRow({ id: 'a2bbbf0e-1499-4e99-93ee-78bc106eeed0', target_kind: EdgePackageControlTargetKind.DEVICE, target_key: deviceId, status: 'REVOKED', reason: 'Device package was revoked' }),
      ] });
    const result = await service.getEffectivePackageControl(
      tenantId, factoryId, deviceId, 'quality-defect', '1.2.0', 'inspection',
    );
    expect(result.status).toBe('REVOKED');
    expect(result.reason).toBe('Device package was revoked');
    expect(result.matchedControls).toHaveLength(2);
    expect(database.query.mock.calls[1]?.[1]).toEqual([
      tenantId, factoryId, deviceId, 'line-1', 'quality-defect', '1.2.0', 'inspection',
    ]);
  });

  it('checks IAM before any admin database access', async () => {
    iamService.authorize.mockRejectedValueOnce(new ForbiddenException('denied'));
    await expect(service.listPackageControls(tenantId, factoryId, userId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.query).not.toHaveBeenCalled();
  });
});
