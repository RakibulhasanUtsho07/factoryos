import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SaasTenantBackupWriterInventoryService } from './saas-tenant-backup-writer-inventory.service';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';

const tenant = 'd1000000-0000-4000-8000-000000000001';
const actor = 'd2000000-0000-4000-8000-000000000001';
const reviewer = 'd2000000-0000-4000-8000-000000000002';
const snapshotId = 'd3000000-0000-4000-8000-000000000001';
const scopeDigest = 'c'.repeat(64);
const oneEntry = {
  producerId: 'backup-worker',
  providerPrincipalReference: 'aws-role-backup-writer',
  accessPathCode: 'APP_WORKER' as const,
  permissionScopeDigest: scopeDigest,
};
const manifestDigest = createHash('sha256').update(JSON.stringify([oneEntry]), 'utf8').digest('hex');

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: snapshotId, tenant_id: tenant, category_code: Category.BUSINESS_DATA,
    revision: 1, inventory_reference: 'inventory.snapshot.v1', manifest_digest: manifestDigest,
    entry_count: 1, status: 'ACCEPTED', idempotency_key: 'inventory-v1', request_hash: 'd'.repeat(64),
    registered_by_user_id: actor, reviewed_by_user_id: reviewer, review_reason: 'Reviewed against provider access inventory',
    reviewed_at: new Date(0).toISOString(), created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}
function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    entry_ordinal: 1, producer_id: oneEntry.producerId,
    provider_principal_reference: oneEntry.providerPrincipalReference,
    access_path_code: oneEntry.accessPathCode,
    permission_scope_digest: oneEntry.permissionScopeDigest,
    ...overrides,
  };
}
function setup(handler: (sql: string, values: unknown[]) => unknown = () => []) {
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => ({
      rows: handler(sql, values) as never[], rowCount: 0,
    })),
  };
  const database = {
    transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(client)),
    query: jest.fn(async (sql: string, values: unknown[] = []) => ({
      rows: handler(sql, values) as never[], rowCount: 0,
    })),
  };
  const iam = { authorize: jest.fn(async () => undefined) };
  const audit = { recordWithClient: jest.fn(async () => 'audit-event') };
  return {
    service: new SaasTenantBackupWriterInventoryService(database as never, iam as never, audit as never),
    database, client, iam, audit,
  };
}

describe('SaasTenantBackupWriterInventoryService', () => {
  it('rejects duplicate producer/principal/access-path identities before database mutation', async () => {
    const { service, database } = setup();
    await expect(service.createSnapshot(tenant, actor, {
      category_code: Category.BUSINESS_DATA,
      inventory_reference: 'inventory.snapshot.v1',
      idempotency_key: 'inventory-v1',
      entries: [
        { producer_id: oneEntry.producerId, provider_principal_reference: oneEntry.providerPrincipalReference,
          access_path_code: oneEntry.accessPathCode, permission_scope_digest: scopeDigest },
        { producer_id: oneEntry.producerId, provider_principal_reference: oneEntry.providerPrincipalReference,
          access_path_code: oneEntry.accessPathCode, permission_scope_digest: 'e'.repeat(64) },
      ],
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('normalizes entry order before hashing an accepted snapshot', async () => {
    const row = snapshotRow();
    const reversed = [
      entryRow({ entry_ordinal: 2, producer_id: 'backup-scheduler', provider_principal_reference: 'aws-role-scheduled-backup', access_path_code: 'SCHEDULED_JOB' }),
      entryRow({ entry_ordinal: 1 }),
    ];
    const normalized = [
      { producerId: 'backup-scheduler', providerPrincipalReference: 'aws-role-scheduled-backup',
        accessPathCode: 'SCHEDULED_JOB', permissionScopeDigest: scopeDigest },
      oneEntry,
    ].sort((a, b) => a.producerId.localeCompare(b.producerId)
      || a.providerPrincipalReference.localeCompare(b.providerPrincipalReference)
      || a.accessPathCode.localeCompare(b.accessPathCode)
      || a.permissionScopeDigest.localeCompare(b.permissionScopeDigest));
    row.entry_count = 2;
    row.manifest_digest = createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
    const { service, database } = setup((sql) => {
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_snapshots')) return [row];
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_entries')) return reversed;
      return [];
    });
    // Both inventory reads are tenant-scoped; an accepted snapshot must verify its full entry manifest.
    await expect(service.requireCurrentAcceptedSnapshot(tenant, Category.BUSINESS_DATA))
      .resolves.toEqual(expect.objectContaining({ snapshotId, entryCount: 2, manifestDigest: row.manifest_digest }));
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the latest snapshot is pending or rejected', async () => {
    for (const status of ['PENDING', 'REJECTED']) {
      const { service, database } = setup((sql) => {
        if (sql.includes('FROM saas_tenant_backup_writer_inventory_snapshots')) return [snapshotRow({ status })];
        return [];
      });
      await expect(service.requireCurrentAcceptedSnapshot(tenant, Category.BUSINESS_DATA))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(database.query).toHaveBeenCalledTimes(1);
    }
  });

  it('detects row-count or manifest tampering before a snapshot can be used for fencing', async () => {
    const { service } = setup((sql) => {
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_snapshots')) return [snapshotRow({ manifest_digest: 'f'.repeat(64) })];
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_entries')) return [entryRow()];
      return [];
    });
    await expect(service.requireCurrentAcceptedSnapshot(tenant, Category.BUSINESS_DATA))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not allow a submitter to self-approve their writer inventory', async () => {
    const row = snapshotRow({ status: 'PENDING', reviewed_by_user_id: null, review_reason: null, reviewed_at: null });
    const { service, database, client } = setup((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND snapshot_id=$2 FOR UPDATE')) {
        return [row];
      }
      return [];
    });
    await expect(service.reviewSnapshot(tenant, actor, snapshotId, {
      decision: 'ACCEPT', reason: 'Self review is prohibited',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE saas_tenant_backup_writer_inventory_snapshots'))).toBe(false);
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not accept a snapshot whose stored digest differs from its immutable entries', async () => {
    const row = snapshotRow({ status: 'PENDING', reviewed_by_user_id: null, review_reason: null, reviewed_at: null, manifest_digest: 'f'.repeat(64) });
    const { service, client } = setup((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND snapshot_id=$2 FOR UPDATE')) return [row];
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND category_code=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE')) {
        return [{ revision: 1, snapshot_id: snapshotId }];
      }
      if (sql.includes('FROM saas_tenant_backup_writer_inventory_entries')) return [entryRow()];
      return [];
    });
    await expect(service.reviewSnapshot(tenant, reviewer, snapshotId, {
      decision: 'ACCEPT', reason: 'Review attempted on modified manifest',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE saas_tenant_backup_writer_inventory_snapshots'))).toBe(false);
  });
});
