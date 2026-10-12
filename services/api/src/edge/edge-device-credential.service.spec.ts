import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';

import { EdgeDeviceCredentialService } from './edge-device-credential.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const deviceId = '7c042d3b-efc0-4e1c-a532-720dbe6b154e';
const credentialId = '5c04a5f9-c131-422a-a488-d3d2e22f8f3d';
const secret = 'A'.repeat(43);
const token = `fos_edge_${tenantId}.${deviceId}.${secret}`;
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

describe('EdgeDeviceCredentialService', () => {
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
  let service: EdgeDeviceCredentialService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    database.transaction.mockReset();
    client.query.mockReset();
    database.transaction.mockImplementation(async (callback) => callback(client));
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new EdgeDeviceCredentialService(
      database as never,
      iamService as never,
      auditService as never,
    );
  });

  it('issues a one-time secret while persisting only its SHA-256 hash', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: deviceId, status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: credentialId,
          tenant_id: tenantId,
          factory_id: factoryId,
          device_id: deviceId,
          token_hint: 'A'.repeat(8),
          status: 'ACTIVE',
          expires_at: '2027-01-10T00:00:00.000Z',
          created_at: '2026-10-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.issueCredential(
      tenantId,
      factoryId,
      userId,
      deviceId,
      { valid_for_days: 90 },
    );

    expect(result.secretReturnedOnce).toBe(true);
    expect(result.credential.token).toMatch(
      new RegExp(`^fos_edge_${tenantId}\\.${deviceId}\\.[A-Za-z0-9_-]{43}$`),
    );
    const storedCredentials = client.query.mock.calls[2]?.[1] ?? [];
    expect(storedCredentials).toContain(
      createHash('sha256').update(result.credential.token, 'utf8').digest('hex'),
    );
    expect(storedCredentials).not.toContain(result.credential.token);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ISSUE',
        resourceType: 'EDGE_DEVICE_CREDENTIAL',
        payload: expect.not.objectContaining({ token: result.credential.token }),
      }),
    );
  });

  it('rotates an existing credential and revokes the old token before the new token is returned', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: deviceId, status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'old-credential-id' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: credentialId,
          tenant_id: tenantId,
          factory_id: factoryId,
          device_id: deviceId,
          token_hint: 'hint1234',
          status: 'ACTIVE',
          expires_at: '2027-01-10T00:00:00.000Z',
          created_at: '2026-10-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.issueCredential(tenantId, factoryId, userId, deviceId);

    expect(result.previousCredentialCount).toBe(1);
    expect(client.query.mock.calls[2]?.[0]).toContain("status = 'REVOKED'");
    expect(client.query.mock.calls[4]?.[1]?.[4]).toBe('ROTATED');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ROTATE' }),
    );
  });

  it('authorizes credential issuance before touching storage', async () => {
    iamService.authorize.mockRejectedValueOnce(new ForbiddenException('denied'));
    await expect(
      service.issueCredential(tenantId, factoryId, userId, deviceId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid credential lifetimes before opening a transaction', async () => {
    await expect(
      service.issueCredential(
        tenantId,
        factoryId,
        userId,
        deviceId,
        { valid_for_days: 0 },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('revokes an active credential and records an immutable lifecycle event', async () => {
    client.query
      .mockResolvedValueOnce({
        rows: [{
          id: credentialId,
          tenant_id: tenantId,
          factory_id: factoryId,
          device_id: deviceId,
          token_hint: 'secret123',
          status: 'ACTIVE',
          expires_at: '2027-01-10T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.revokeCredential(
      tenantId,
      factoryId,
      userId,
      deviceId,
      credentialId,
    );

    expect(result.idempotent).toBe(false);
    expect(result.credential.status).toBe('REVOKED');
    expect(client.query.mock.calls[2]?.[0]).toContain("'REVOKED'");
  });

  it('does not create another lifecycle event for an already revoked credential', async () => {
    client.query.mockResolvedValueOnce({
      rows: [{
        id: credentialId,
        tenant_id: tenantId,
        factory_id: factoryId,
        device_id: deviceId,
        token_hint: 'secret123',
        status: 'REVOKED',
        expires_at: '2027-01-10T00:00:00.000Z',
        revoked_at: '2026-10-11T00:00:00.000Z',
      }],
    });

    const result = await service.revokeCredential(
      tenantId, factoryId, userId, deviceId, credentialId,
    );
    expect(result.idempotent).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('requires a bearer device credential and never queries without one', async () => {
    await expect(
      service.authenticateDeviceToken(undefined, deviceId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects a token scoped to a different device before querying', async () => {
    const otherDevice = '88fd4dc8-b5bc-45b4-8109-c874af40cfe0';
    await expect(
      service.authenticateDeviceToken(`Bearer ${token}`, otherDevice),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('authenticates by hash within the token tenant and updates last-used metadata', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [{
          id: credentialId,
          tenant_id: tenantId,
          factory_id: factoryId,
          device_id: deviceId,
          token_hint: 'AAAAAAA',
          status: 'ACTIVE',
          expires_at: '2027-01-10T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.authenticateDeviceToken(`Bearer ${token}`, deviceId);

    expect(result).toEqual({
      credentialId,
      tenantId,
      factoryId,
      deviceId,
    });
    expect(database.query.mock.calls[0]?.[1]).toEqual([tenantId, deviceId, tokenHash]);
    expect(database.query.mock.calls[0]?.[2]).toEqual({ tenantId, userId: null });
    expect(database.query.mock.calls[1]?.[0]).toContain('last_used_at = NOW()');
  });

  it('fails closed for unknown, expired, revoked or paused device credentials', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      service.authenticateDeviceToken(`Bearer ${token}`, deviceId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
