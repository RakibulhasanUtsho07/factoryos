import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';

import { ScimService, SCIM_PATCH_SCHEMA } from './scim.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const identityId = '22222222-2222-4222-8222-222222222222';
const membershipId = '33333333-3333-4333-8333-333333333333';
const rawToken = 'fos_scim_' + tenantId + '.' + 'A'.repeat(43);
const tokenHash = createHash('sha256').update(rawToken).digest('hex');
const issuer = 'https://idp.example.test/tenant';

const deactivationPatch = {
  schemas: [SCIM_PATCH_SCHEMA],
  Operations: [{ op: 'replace', path: 'active', value: false }],
};

describe('SCIM tenant-scoped user deprovisioning', () => {
  const clientQuery = jest.fn(async (sql: string) => {
    if (sql.includes('FROM public.auth_identities')) {
      return {
        rows: [{
          identity_id: identityId,
          user_id: '44444444-4444-4444-8444-444444444444',
          issuer,
          subject: 'idp-subject-1',
          email: 'user@example.test',
          display_name: 'Test User',
          membership_id: membershipId,
          membership_status: 'ACTIVE',
          updated_at: new Date('2026-11-03T10:00:00.000Z'),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE public.tenant_memberships')) {
      return {
        rows: [{ updated_at: new Date('2026-11-03T10:05:00.000Z') }],
        rowCount: 1,
      };
    }
    throw new Error('Unexpected SQL in SCIM unit test');
  });

  const client = { query: clientQuery };
  const database = {
    query: jest.fn(async () => ({
      rows: [{ tenant_id: tenantId, issuer, scopes: ['Users:write'] }],
      rowCount: 1,
    })),
    transaction: jest.fn(async (callback: (client: never) => Promise<unknown>) => callback(client as never)),
  };
  const auditService = {
    recordWithClient: jest.fn(async () => 'audit-event-id'),
  };
  const configService = {
    get: jest.fn(() => 'true'),
  };

  const service = new ScimService(
    database as never,
    auditService as never,
    configService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM public.auth_identities')) {
        return {
          rows: [{
            identity_id: identityId,
            user_id: '44444444-4444-4444-8444-444444444444',
            issuer,
            subject: 'idp-subject-1',
            email: 'user@example.test',
            display_name: 'Test User',
            membership_id: membershipId,
            membership_status: 'ACTIVE',
            updated_at: new Date('2026-11-03T10:00:00.000Z'),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE public.tenant_memberships')) {
        return {
          rows: [{ updated_at: new Date('2026-11-03T10:05:00.000Z') }],
          rowCount: 1,
        };
      }
      throw new Error('Unexpected SQL in SCIM unit test');
    });
    database.query.mockResolvedValue({
      rows: [{ tenant_id: tenantId, issuer, scopes: ['Users:write'] }],
      rowCount: 1,
    } as never);
    configService.get.mockReturnValue('true');
  });

  it('fails closed while the optional SCIM adapter is disabled', async () => {
    configService.get.mockReturnValue('false');
    await expect(service.deprovisionUser(
      'Bearer ' + rawToken,
      identityId,
      deactivationPatch,
    )).rejects.toThrow('Not Found');
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed bearer credentials before database access', async () => {
    await expect(service.deprovisionUser(
      'Bearer not-a-scim-token',
      identityId,
      deactivationPatch,
    )).rejects.toThrow('Invalid SCIM bearer credential');
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects any SCIM operation other than active=false', async () => {
    await expect(service.deprovisionUser(
      'Bearer ' + rawToken,
      identityId,
      {
        schemas: [SCIM_PATCH_SCHEMA],
        Operations: [{ op: 'replace', path: 'active', value: true }],
      },
    )).rejects.toThrow('Only replace active=false is supported');
    expect(database.query).not.toHaveBeenCalled();
  });

  it('authenticates a tenant-bound hashed token and removes only that tenant membership', async () => {
    const result = await service.deprovisionUser(
      'Bearer ' + rawToken,
      identityId,
      deactivationPatch,
    );

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('token_sha256 = $2'),
      [tenantId, tokenHash],
      { tenantId },
    );
    expect(database.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { tenantId },
    );
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(clientQuery.mock.calls[0][0]).toContain('tm.tenant_id = $1::uuid');
    expect(clientQuery.mock.calls[1][0]).toContain("status = 'REMOVED'");
    expect(auditService.recordWithClient).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        tenantId,
        actorUserId: null,
        action: 'SCIM_DEPROVISION',
        resourceId: membershipId,
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      id: identityId,
      externalId: 'idp-subject-1',
      active: false,
      factoryos: { tenantScoped: true, membershipStatus: 'REMOVED', changed: true, auditEventId: 'audit-event-id' },
    }));
  });

  it('keeps the target idempotent and does not emit a second audit event', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM public.auth_identities')) {
        return {
          rows: [{
            identity_id: identityId,
            user_id: '44444444-4444-4444-8444-444444444444',
            issuer,
            subject: 'idp-subject-1',
            email: 'user@example.test',
            display_name: 'Test User',
            membership_id: membershipId,
            membership_status: 'REMOVED',
            updated_at: new Date('2026-11-03T10:00:00.000Z'),
          }],
          rowCount: 1,
        };
      }
      throw new Error('An already removed membership must not be updated');
    });

    const result = await service.deprovisionUser(
      'Bearer ' + rawToken,
      identityId,
      deactivationPatch,
    );

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(auditService.recordWithClient).not.toHaveBeenCalled();
    expect(result.factoryos).toEqual({
      tenantScoped: true,
      membershipStatus: 'REMOVED',
      changed: false,
      auditEventId: null,
    });
  });

  it('rejects credentials without the Users:write scope', async () => {
    database.query.mockResolvedValue({
      rows: [{ tenant_id: tenantId, issuer, scopes: ['Users:read'] }],
      rowCount: 1,
    } as never);

    await expect(service.deprovisionUser(
      'Bearer ' + rawToken,
      identityId,
      deactivationPatch,
    )).rejects.toThrow('Users:write');
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
