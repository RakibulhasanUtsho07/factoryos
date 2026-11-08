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
  const qualityInspectionIds: string[] = [];

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
        await adminPool.query('ALTER TABLE quality_holds DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_inspection_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_audit_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_inspections DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_location_balances DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_stock_balances DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_items DISABLE TRIGGER USER');
        try {
          if (qualityInspectionIds.length > 0) {
            await adminPool.query(
              'DELETE FROM quality_audit_events WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id = ANY($3::uuid[])',
              [tenantId, factoryId, qualityInspectionIds],
            );
            await adminPool.query(
              `DELETE FROM outbox_events
               WHERE tenant_id=$1 AND factory_id=$2 AND aggregate_type='QUALITY_INSPECTION'
                 AND aggregate_id = ANY($3::uuid[]) AND event_type='QUALITY.INSPECTION_CHANGED'`,
              [tenantId, factoryId, qualityInspectionIds],
            );
            await adminPool.query(
              'DELETE FROM quality_inspection_events WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id = ANY($3::uuid[])',
              [tenantId, factoryId, qualityInspectionIds],
            );
            await adminPool.query(
              'DELETE FROM quality_holds WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id = ANY($3::uuid[])',
              [tenantId, factoryId, qualityInspectionIds],
            );
            await adminPool.query(
              'DELETE FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND id = ANY($3::uuid[])',
              [tenantId, factoryId, qualityInspectionIds],
            );
          }
          // Stock-balance INSERT synchronizes the item's initial quantity into
          // the default UNASSIGNED inventory location. Remove that dependent
          // location row before its stock/item parents during fixture cleanup.
          await adminPool.query('DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
        } finally {
          await adminPool.query('ALTER TABLE inventory_items ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_stock_balances ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_location_balances ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_inspections ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_audit_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_inspection_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_holds ENABLE TRIGGER USER');
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
    expect(result.expected_quantity_basis).toBe('APPROVED_PO_OPEN_QUANTITY_MINUS_POSTED_GRN_RECEIVED_MATCHING_ITEM_UOM');
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

  it('fails available stock closed for an active item-wide quality hold and restores it only after evidenced release', async () => {
    const created = await adminPool.query<{ id: string }>(`
      INSERT INTO inventory_items (
        tenant_id, factory_id, sku, name, unit, created_by_user_id
      )
      VALUES ($1, $2, $3, 'Quality-held availability item', 'PCS', $4)
      RETURNING id::text AS id
    `, [tenantId, factoryId, 'WMS-AVAIL-HOLD-' + randomUUID(), TEST_USER_ID]);
    const itemId = created.rows[0]?.id;
    if (!itemId) throw new Error('WMS quality-hold item fixture was not created');
    itemIds.push(itemId);

    await adminPool.query(`
      INSERT INTO inventory_stock_balances (
        tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
      )
      VALUES ($1, $2, $3, 12.0000, 0.0000)
    `, [tenantId, factoryId, itemId]);

    const inspectionId = randomUUID();
    const correlationId = randomUUID();
    qualityInspectionIds.push(inspectionId);
    const qualityClient = await adminPool.connect();
    try {
      await qualityClient.query('BEGIN');
      await qualityClient.query(
        `SELECT set_config('app.tenant_id',$1,TRUE), set_config('app.user_id',$2,TRUE)`,
        [tenantId, TEST_USER_ID],
      );
      await qualityClient.query(
        `INSERT INTO quality_inspections (
           id, tenant_id, factory_id, inspection_type, target_type, target_id,
           inventory_item_id, traceability_unit_id, status, idempotency_key, request_hash,
           created_by_user_id, updated_by_user_id, correlation_id
         ) VALUES ($1,$2,$3,'INVENTORY','INVENTORY_ITEM',$4,$4,NULL,'OPEN',$5,repeat('a',64),$6,$6,$7::uuid)`,
        [
          inspectionId, tenantId, factoryId, itemId,
          'wms-availability-inspection-' + inspectionId, TEST_USER_ID, correlationId,
        ],
      );
      await qualityClient.query(
        `INSERT INTO quality_inspection_events (
           tenant_id, factory_id, inspection_id, version, from_status, to_status, action, reason,
           idempotency_key, request_hash, actor_user_id, correlation_id
         ) VALUES ($1,$2,$3,1,NULL,'OPEN','CREATED',$4,$5,repeat('b',64),$6,$7::uuid)`,
        [
          tenantId, factoryId, inspectionId, 'Item availability quality-hold integration fixture',
          'wms-availability-inspection-created-' + inspectionId, TEST_USER_ID, correlationId,
        ],
      );
      await qualityClient.query(
        `INSERT INTO quality_audit_events (
           tenant_id, factory_id, inspection_id, action_type, payload, actor_user_id, correlation_id
         ) VALUES ($1,$2,$3,'INSPECTION_CREATED',$4::jsonb,$5,$6::uuid)`,
        [
          tenantId, factoryId, inspectionId,
          JSON.stringify({ target_type: 'INVENTORY_ITEM', target_id: itemId, status: 'OPEN' }),
          TEST_USER_ID, correlationId,
        ],
      );
      await qualityClient.query(
        `INSERT INTO outbox_events (
           tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
         ) VALUES ($1,$2,'QUALITY_INSPECTION',$3,'QUALITY.INSPECTION_CHANGED',$4::jsonb)`,
        [
          tenantId, factoryId, inspectionId,
          JSON.stringify({ inspection_id: inspectionId, action: 'INSPECTION_CREATED', status: 'OPEN', correlation_id: correlationId }),
        ],
      );
      await qualityClient.query(
        `INSERT INTO quality_holds (
           tenant_id, factory_id, inspection_id, inventory_item_id, reason, created_by_user_id, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::uuid)`,
        [tenantId, factoryId, inspectionId, itemId, 'Active item-wide quality hold', TEST_USER_ID, correlationId],
      );
      await qualityClient.query('COMMIT');
    } catch (error) {
      await qualityClient.query('ROLLBACK');
      throw error;
    } finally {
      qualityClient.release();
    }

    const held = await service.getAvailabilityExposure(TEST_USER_ID, tenantId, factoryId, itemId);
    expect(held.quantity_on_hand).toBe('12.0000');
    expect(held.allocated_quantity).toBe('0.0000');
    expect(held.available_quantity).toBe('0.0000');
    expect(held.quarantined_quantity).toBe('12.0000');
    expect(held.damaged_quantity).toBe('0.0000');
    expect(held.expired_quantity).toBe('0.0000');
    expect(held.condition_evidence_scope).toBe('ITEM_WIDE_QUALITY_HOLD');

    const releaseClient = await adminPool.connect();
    try {
      await releaseClient.query('BEGIN');
      await releaseClient.query(
        `SELECT set_config('app.tenant_id',$1,TRUE), set_config('app.user_id',$2,TRUE)`,
        [tenantId, TEST_USER_ID],
      );
      const released = await releaseClient.query(
        `UPDATE quality_holds
         SET status='RELEASED', released_by_user_id=$1, released_at=clock_timestamp(),
             release_reason=$2, updated_at=clock_timestamp()
         WHERE tenant_id=$3 AND factory_id=$4 AND inspection_id=$5 AND status='ACTIVE'`,
        [TEST_USER_ID, 'Released after availability regression assertion', tenantId, factoryId, inspectionId],
      );
      expect(released.rowCount).toBe(1);
      await releaseClient.query('COMMIT');
    } catch (error) {
      await releaseClient.query('ROLLBACK');
      throw error;
    } finally {
      releaseClient.release();
    }

    const restored = await service.getAvailabilityExposure(TEST_USER_ID, tenantId, factoryId, itemId);
    expect(restored.available_quantity).toBe('12.0000');
    expect(restored.quarantined_quantity).toBe('0.0000');
    expect(restored.condition_evidence_scope).toBe('NO_TRACEABILITY_CONDITION_EVIDENCE');
  });

  it('does not disclose an inventory item outside the selected factory scope', async () => {
    await expect(
      service.getAvailabilityExposure(TEST_USER_ID, tenantId, factoryId, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
