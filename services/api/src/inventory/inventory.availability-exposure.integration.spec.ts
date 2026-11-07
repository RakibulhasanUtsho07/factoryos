import { NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { InventoryService } from './inventory.service';

describe('Inventory WMS availability exposure PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let adminPool!: Pool;
  let appPool!: Pool;
  let database!: ReturnType<typeof createIntegrationDatabase>;
  let service!: InventoryService;
  let tenantId!: string;
  let factoryId!: string;
  const itemIds: string[] = [];

  const audit = { record: async () => undefined } as unknown as AuditService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl || !adminDatabaseUrl) {
      throw new Error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required');
    }

    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    appPool = new Pool({ connectionString: databaseUrl });

    const scope = await adminPool.query<{ tenant_id: string; factory_id: string }>(`
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id
      FROM tenants t
      JOIN factories f ON f.tenant_id = t.id
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at, f.created_at
      LIMIT 1
    `);
    if (!scope.rows[0]) throw new Error('No active tenant/factory is available for WMS availability integration tests');
    tenantId = scope.rows[0].tenant_id;
    factoryId = scope.rows[0].factory_id;

    const actor = await adminPool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [TEST_USER_ID]);
    if (!actor.rows[0]) throw new Error('WMS availability integration actor is missing');

    database = createIntegrationDatabase(appPool);
    service = new InventoryService(database as never, audit);
  });

  afterAll(async () => {
    try {
      if (adminPool && itemIds.length > 0) {
        await adminPool.query('ALTER TABLE inventory_stock_balances DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_items DISABLE TRIGGER USER');
        try {
          await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
        } finally {
          await adminPool.query('ALTER TABLE inventory_items ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_stock_balances ENABLE TRIGGER USER');
        }
      }
    } finally {
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
    }
  });

  it('executes the read-only source joins against a real factory-scoped inventory balance', async () => {
    const created = await adminPool.query<{ id: string }>(`
      INSERT INTO inventory_items (
        tenant_id, factory_id, sku, name, unit, created_by_user_id
      )
      VALUES ($1, $2, $3, 'Availability exposure integration item', 'PCS', $4)
      RETURNING id::text AS id
    `, [tenantId, factoryId, 'WMS-AVAIL-' + randomUUID(), TEST_USER_ID]);
    const itemId = created.rows[0]?.id;
    if (!itemId) throw new Error('WMS availability item fixture was not created');
    itemIds.push(itemId);

    await adminPool.query(`
      INSERT INTO inventory_stock_balances (
        tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
      )
      VALUES ($1, $2, $3, 12.0000, 0.0000)
    `, [tenantId, factoryId, itemId]);

    const result = await service.getAvailabilityExposure(TEST_USER_ID, tenantId, factoryId, itemId);

    expect(result.item_id).toBe(itemId);
    expect(result.quantity_on_hand).toBe('12.0000');
    expect(result.allocated_quantity).toBe('0.0000');
    expect(result.available_quantity).toBe('12.0000');
    expect(result.quarantined_quantity).toBe('0.0000');
    expect(result.damaged_quantity).toBe('0.0000');
    expect(result.expired_quantity).toBe('0.0000');
    expect(result.expected_quantity).toBe('0.0000');
    expect(result.expected_quantity_unit_mismatch_line_count).toBe(0);
    expect(result.expected_quantity_basis).toBe('APPROVED_PO_OPEN_QUANTITY_MINUS_POSTED_GRN_RECEIVED');
    expect(result.condition_evidence_scope).toBe('NO_TRACEABILITY_CONDITION_EVIDENCE');
    expect(result.first_affected_production_order).toBeNull();
    const transactionReadOnly = await database.transaction(
      { tenantId, userId: TEST_USER_ID, readOnly: true },
      async (client) => {
        const state = await client.query<{ transaction_read_only: string }>(
          'SHOW transaction_read_only',
        );
        return state.rows[0]?.transaction_read_only;
      },
    );
    expect(transactionReadOnly).toBe('on');
  });

  it('does not disclose an inventory item outside the selected factory scope', async () => {
    await expect(
      service.getAvailabilityExposure(TEST_USER_ID, tenantId, factoryId, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
