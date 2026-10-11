import { jest } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasTenantPostgresDatasetSource } from './saas-tenant-postgres-dataset-source';
import { DatabaseService } from '../database/database.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const otherTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orderId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

describe('SaasTenantPostgresDatasetSource', () => {
  function createSource(rowTenantId?: string) {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('FROM public.orders AS dataset_row')) {
          return {
            rows: rowTenantId
              ? [{
                  id: orderId,
                  tenant_id: rowTenantId,
                  order_number: 'ORD-TRANSFER-001',
                  version: '2',
                  notes: null,
                }]
              : [],
          };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const database = {
      getClient: jest.fn(async () => client),
    } as unknown as DatabaseService;
    return { source: new SaasTenantPostgresDatasetSource(database), client, calls, database };
  }

  it('uses a read-only repeatable-read transaction, tenant RLS context and explicit keyset predicates', async () => {
    const { source, client, calls } = createSource(tenantId);
    const rows: unknown[] = [];
    for await (const row of source.readDataset(
      tenantId,
      '1.0.0',
      SaasTransferDatasetCategory.BUSINESS_DATA,
    )) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: orderId,
      tenant_id: tenantId,
      order_number: 'ORD-TRANSFER-001',
      version: '2',
      notes: null,
      __factoryos_table: 'orders',
    });
    expect(calls[0]?.sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1]?.sql).toContain("set_config('app.tenant_id', $1, true)");
    expect(calls[1]?.values).toEqual([tenantId, '']);
    const query = calls.find((item) => item.sql.includes('FROM public.orders AS dataset_row'));
    expect(query?.sql).toContain('dataset_row.tenant_id = $1::uuid');
    expect(query?.sql).toContain('dataset_row.id > $2::uuid');
    expect(query?.values).toEqual([tenantId, null, 500]);
    expect(calls.some((item) => item.sql === 'COMMIT')).toBe(true);
    expect(calls.some((item) => item.sql === 'ROLLBACK')).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('fails closed for integration metadata and file references until those schemas have explicit adapters', async () => {
    const { source, database } = createSource();
    await expect(async () => {
      for await (const _row of source.readDataset(
        tenantId,
        '1.0.0',
        SaasTransferDatasetCategory.FILE_REFERENCES,
      )) {
        // The unsupported category must fail before producing records.
      }
    }).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(database.getClient).not.toHaveBeenCalled();
  });

  it('rejects a row whose tenant scope violates the explicit query scope', async () => {
    const { source, client } = createSource(otherTenantId);
    await expect(async () => {
      for await (const _row of source.readDataset(
        tenantId,
        '1.0.0',
        SaasTransferDatasetCategory.BUSINESS_DATA,
      )) {
        // The mocked database simulates a broken RLS/query invariant.
      }
    }).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed tenant and schema identifiers before opening a connection', async () => {
    const { source, database } = createSource();
    await expect(async () => {
      for await (const _row of source.readDataset(
        'not-a-uuid',
        '1.0.0',
        SaasTransferDatasetCategory.AUDIT_LOG,
      )) {
        // No row should be emitted.
      }
    }).rejects.toBeInstanceOf(BadRequestException);
    await expect(async () => {
      for await (const _row of source.readDataset(
        tenantId,
        'latest',
        SaasTransferDatasetCategory.AUDIT_LOG,
      )) {
        // No row should be emitted.
      }
    }).rejects.toBeInstanceOf(BadRequestException);
    expect(database.getClient).not.toHaveBeenCalled();
  });
});
