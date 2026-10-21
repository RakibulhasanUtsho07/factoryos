import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { CreateGenealogyEventDto, CreateTraceabilityLabelTemplateDto, CreateTraceabilityUnitDto } from './dto/traceability.dto';
import { CreateRfidReadBatchDto, SyncOfflineBatchDto } from './dto/wms-mobile.dto';
import { InventoryLocationService } from './inventory.location.service';
import { InventoryService } from './inventory.service';
import { TraceabilityService } from './traceability.service';
import { WmsMobileService } from './wms.mobile.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;

postgresDescribe('WMS mobile offline sync, labels, genealogy and RFID PostgreSQL contracts', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
  let adminPool!: Pool;
  let appPool!: Pool;
  let tenantId!: string;
  let factoryId!: string;
  let database!: ReturnType<typeof createIntegrationDatabase>;
  let inventoryService!: InventoryService;
  let locationService!: InventoryLocationService;
  let traceabilityService!: TraceabilityService;
  let mobileService!: WmsMobileService;

  const itemIds: string[] = [];
  const unitIds: string[] = [];
  const templateIds: string[] = [];
  const deviceIds: string[] = [];
  const correlationIds: string[] = [];

  const correlation = () => {
    const id = randomUUID();
    correlationIds.push(id);
    return id;
  };

  const createItem = async (quantityOnHand: string) => {
    const created = await adminPool.query<{ id: string }>(`
      INSERT INTO inventory_items (
        tenant_id, factory_id, sku, name, unit, created_by_user_id
      ) VALUES ($1,$2,$3,'WMS mobile contract item','PCS',$4)
      RETURNING id::text AS id
    `, [tenantId, factoryId, 'WMS-MOBILE-' + randomUUID(), TEST_USER_ID]);
    const itemId = created.rows[0]?.id;
    if (!itemId) throw new Error('WMS mobile integration item was not created');
    itemIds.push(itemId);
    await adminPool.query(`
      INSERT INTO inventory_stock_balances (
        tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
      ) VALUES ($1,$2,$3,$4::numeric,0)
    `, [tenantId, factoryId, itemId, quantityOnHand]);
    return itemId;
  };

  const createTemplate = async (supportedUnitTypes: string[]) => {
    const template = await traceabilityService.createLabelTemplate(
      TEST_USER_ID, tenantId, factoryId,
      {
        template_code: 'WMS-MOBILE-' + randomUUID().slice(0, 8),
        name: 'WMS mobile configurable label',
        symbology: 'QR',
        supported_unit_types: supportedUnitTypes,
        label_layout: {
          page: { width_mm: 50, height_mm: 30 },
          fields: ['unit_code', 'barcode_value', 'product_role', 'expires_at'],
        },
      } as CreateTraceabilityLabelTemplateDto,
      null, correlation(),
    );
    templateIds.push(String(template.id));
    return template;
  };

  const createUnit = async (input: {
    unitType: 'LOT' | 'BUNDLE';
    productRole: 'MATERIAL' | 'PACKAGING';
    code: string;
    barcode: string;
    itemId?: string;
    quantity: number;
    templateId?: string;
    rfidEpc?: string;
  }) => {
    const dto: CreateTraceabilityUnitDto = {
      unit_type: input.unitType,
      product_role: input.productRole,
      unit_code: input.code,
      barcode_value: input.barcode,
      inventory_item_id: input.itemId,
      quantity: input.quantity,
      unit: 'PCS',
      label_template_id: input.templateId,
      rfid_epc: input.rfidEpc,
      external_reference: input.itemId ? 'WMS-MOBILE-SUPPLIER-' + input.code : undefined,
    } as CreateTraceabilityUnitDto;
    const result = await traceabilityService.createUnit(
      TEST_USER_ID, tenantId, factoryId, dto,
      'wms-mobile-unit-' + randomUUID(), null, correlation(),
    );
    unitIds.push(String(result.id));
    return result;
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl || !adminDatabaseUrl) {
      throw new Error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required');
    }
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    appPool = new Pool({ connectionString: databaseUrl });
    const context = await adminPool.query<{ tenant_id: string; factory_id: string }>(`
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id
      FROM tenants t
      JOIN factories f ON f.tenant_id = t.id
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at, f.created_at
      LIMIT 1
    `);
    if (!context.rows[0]) throw new Error('No active tenant/factory exists for WMS mobile integration tests');
    tenantId = context.rows[0].tenant_id;
    factoryId = context.rows[0].factory_id;
    const actor = await adminPool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [TEST_USER_ID]);
    if (!actor.rows[0]) throw new Error('WMS mobile test actor is missing');

    database = createIntegrationDatabase(appPool);
    const audit = { record: async () => undefined } as unknown as AuditService;
    inventoryService = new InventoryService(database as never, audit);
    locationService = new InventoryLocationService(database as never, audit);
    traceabilityService = new TraceabilityService(database as never);
    mobileService = new WmsMobileService(database as never, inventoryService);
  });

  afterAll(async () => {
    try {
      if (adminPool) {
        const triggerTables = [
          'rfid_read_observations', 'rfid_read_batches',
          'mobile_offline_sync_attempts', 'mobile_offline_sync_receipts',
          'traceability_label_issues', 'product_genealogy_events', 'traceability_units',
          'traceability_label_templates', 'inventory_movements',
          'inventory_traceability_location_balances', 'inventory_location_transfers',
          'inventory_location_balances', 'inventory_stock_balances', 'inventory_items',
          'outbox_events', 'audit_events',
        ];
        for (const table of triggerTables) {
          await adminPool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        }
        try {
          await adminPool.query(
            'DELETE FROM audit_events WHERE correlation_id = ANY($1::uuid[])',
            [correlationIds],
          );
          await adminPool.query(
            'DELETE FROM outbox_events WHERE correlation_id = ANY($1::uuid[])',
            [correlationIds],
          );
          await adminPool.query(
            'DELETE FROM rfid_read_observations WHERE batch_id IN (SELECT id FROM rfid_read_batches WHERE item_id = ANY($1::uuid[]))',
            [itemIds],
          );
          await adminPool.query('DELETE FROM rfid_read_batches WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query(
            'DELETE FROM mobile_offline_sync_attempts WHERE receipt_id IN (SELECT id FROM mobile_offline_sync_receipts WHERE device_id = ANY($1::text[]))',
            [deviceIds],
          );
          await adminPool.query('DELETE FROM mobile_offline_sync_receipts WHERE device_id = ANY($1::text[])', [deviceIds]);
          await adminPool.query('DELETE FROM traceability_label_issues WHERE unit_id = ANY($1::uuid[])', [unitIds]);
          await adminPool.query(
            'DELETE FROM product_genealogy_events WHERE source_unit_id = ANY($1::uuid[]) OR target_unit_id = ANY($1::uuid[])',
            [unitIds],
          );
          await adminPool.query('DELETE FROM traceability_units WHERE id = ANY($1::uuid[])', [unitIds]);
          await adminPool.query('DELETE FROM traceability_label_templates WHERE id = ANY($1::uuid[])', [templateIds]);
          await adminPool.query('DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_traceability_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_location_transfers WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
        } finally {
          for (const table of triggerTables.reverse()) {
            await adminPool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
          }
        }
      }
    } finally {
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
    }
  });

  it('replays offline queue entries, records stale-version conflict/rejection, and reconciles final stock once', async () => {
    const itemId = await createItem('10.0000');
    const initial = await adminPool.query<{ version: string }>(
      'SELECT version::text AS version FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    const initialVersion = initial.rows[0]?.version;
    if (!initialVersion) throw new Error('Offline sync initial balance version was not found');
    const deviceId = 'WMS-DEVICE-' + randomUUID();
    deviceIds.push(deviceId);
    const clientTransactionId = randomUUID();
    const accepted: SyncOfflineBatchDto = {
      device_id: deviceId,
      transactions: [{
        client_transaction_id: clientTransactionId,
        operation: 'STOCK_MOVEMENT',
        item_id: itemId,
        movement_type: 'ISSUE',
        quantity: 2,
        expected_balance_version: initialVersion,
        notes: 'Offline pick confirmed from local queue',
      }],
    };

    const first = await mobileService.syncOfflineBatch(
      TEST_USER_ID, tenantId, factoryId, accepted, null, correlation(),
    );
    expect(first).toMatchObject({ received_count: 1, applied_count: 1, conflict_count: 0, rejected_count: 0 });
    expect(first.results[0]).toMatchObject({ status: 'APPLIED', replayed: false });

    const replay = await mobileService.syncOfflineBatch(
      TEST_USER_ID, tenantId, factoryId, accepted, null, correlation(),
    );
    expect(replay.results[0]).toMatchObject({ status: 'APPLIED', replayed: true });

    const staleTx: SyncOfflineBatchDto = {
      device_id: deviceId,
      transactions: [{
        client_transaction_id: randomUUID(),
        operation: 'STOCK_MOVEMENT',
        item_id: itemId,
        movement_type: 'ISSUE',
        quantity: 1,
        expected_balance_version: initialVersion,
      }],
    };
    const stale = await mobileService.syncOfflineBatch(
      TEST_USER_ID, tenantId, factoryId, staleTx, null, correlation(),
    );
    expect(stale.results[0]).toMatchObject({ status: 'CONFLICT', replayed: false });

    const unknownItemTx: SyncOfflineBatchDto = {
      device_id: deviceId,
      transactions: [{
        client_transaction_id: randomUUID(),
        operation: 'STOCK_MOVEMENT',
        item_id: randomUUID(),
        movement_type: 'ISSUE',
        quantity: 1,
        expected_balance_version: '1',
      }],
    };
    const rejected = await mobileService.syncOfflineBatch(
      TEST_USER_ID, tenantId, factoryId, unknownItemTx, null, correlation(),
    );
    expect(rejected.results[0]).toMatchObject({ status: 'REJECTED', replayed: false });

    const final = await adminPool.query<{ quantity_on_hand: string; version: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand, version::text AS version FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(final.rows[0]?.quantity_on_hand).toBe('8.0000');
    const movements = await adminPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM inventory_movements WHERE item_id = $1 AND movement_type = 'ISSUE'",
      [itemId],
    );
    expect(movements.rows[0]?.count).toBe('1');
    const attempts = await adminPool.query<{ outcome: string; count: string }>(`
      SELECT outcome, count(*)::text AS count
      FROM mobile_offline_sync_attempts
      WHERE device_id = $1
      GROUP BY outcome ORDER BY outcome
    `, [deviceId]);
    expect(attempts.rows).toEqual([
      { outcome: 'APPLIED', count: '1' },
      { outcome: 'CONFLICT', count: '1' },
      { outcome: 'REJECTED', count: '1' },
      { outcome: 'REPLAYED', count: '1' },
    ]);
  });

  it('issues labels for identities, resolves the same barcode into genealogy, and suppresses repeated RFID reads', async () => {
    const itemId = await createItem('3.0000');
    const template = await createTemplate(['LOT', 'BUNDLE']);
    const lotCode = 'MOBILE-LOT-' + randomUUID().slice(0, 8);
    const rfidEpc = 'E200-MOBILE-' + randomUUID().slice(0, 10).toUpperCase();
    const lot = await createUnit({
      unitType: 'LOT', productRole: 'MATERIAL', code: lotCode,
      barcode: 'QR-' + lotCode, itemId, quantity: 3,
      templateId: String(template.id), rfidEpc,
    });
    const bundleCode = 'MOBILE-BUNDLE-' + randomUUID().slice(0, 8);
    const bundle = await createUnit({
      unitType: 'BUNDLE', productRole: 'PACKAGING', code: bundleCode,
      barcode: 'QR-' + bundleCode, quantity: 1, templateId: String(template.id),
    });

    const issue = await traceabilityService.issueLabel(
      TEST_USER_ID, tenantId, factoryId,
      { unit_id: String(lot.id), template_id: String(template.id), copy_count: 2 },
      'mobile-label-issue-' + randomUUID(), null, correlation(),
    );
    expect(issue).toMatchObject({
      unit_id: lot.id,
      template_id: template.id,
      symbology: 'QR',
      barcode_value: 'QR-' + lotCode,
      copy_count: 2,
      replayed: false,
    });
    expect((issue.print_contract as { encoded_value: string }).encoded_value).toBe('QR-' + lotCode);

    const replay = await traceabilityService.issueLabel(
      TEST_USER_ID, tenantId, factoryId,
      { unit_id: String(lot.id), template_id: String(template.id), copy_count: 2 },
      'mobile-label-issue-' + 'same-key-not-used', null, correlation(),
    );
    // A different idempotency key creates a separate immutable issue event; both
    // remain attached to the same stable traceability identity.
    expect(replay.unit_id).toBe(lot.id);

    const resolved = await traceabilityService.resolveLabel(
      TEST_USER_ID, tenantId, factoryId, 'QR-' + lotCode,
    );
    expect((resolved.identity as { id: string; rfid_epc: string }).id).toBe(lot.id);
    expect((resolved.identity as { rfid_epc: string }).rfid_epc).toBe(rfidEpc);

    await traceabilityService.recordGenealogyEvent(
      TEST_USER_ID, tenantId, factoryId,
      {
        source_unit_id: String(lot.id), target_unit_id: String(bundle.id),
        relationship_type: 'PACKED_INTO', quantity: 1, notes: 'Offline mobile pack action',
      } as CreateGenealogyEventDto,
      'mobile-genealogy-' + randomUUID(), null, correlation(),
    );
    const forward = await traceabilityService.trace(
      TEST_USER_ID, tenantId, factoryId, String(lot.id), 'FORWARD',
    );
    expect((forward.relationships as Array<{ target_unit_id: string }>).some((e) => e.target_unit_id === bundle.id)).toBe(true);

    const locationResult = await adminPool.query<{ id: string }>(`
      SELECT id::text AS id FROM inventory_locations
      WHERE tenant_id = $1 AND factory_id = $2 AND is_default = TRUE AND status = 'ACTIVE'
      LIMIT 1
    `, [tenantId, factoryId]);
    const locationId = locationResult.rows[0]?.id;
    if (!locationId) throw new Error('Factory default stock location was not found');

    const rfidBatch: CreateRfidReadBatchDto = {
      reader_id: randomUUID(),
      session_id: randomUUID(),
      item_id: itemId,
      location_id: locationId,
      reads: [rfidEpc, rfidEpc, rfidEpc],
    };
    const rfidKey = 'mobile-rfid-' + randomUUID();
    const reconciled = await mobileService.ingestRfidReadBatch(
      TEST_USER_ID, tenantId, factoryId, rfidBatch, rfidKey, null, correlation(),
    );
    expect(reconciled).toMatchObject({
      expected_quantity: '3.0000',
      observed_quantity: '3.0000',
      variance_quantity: '0.0000',
      reconciliation_status: 'MATCHED',
      duplicate_reads_suppressed: 2,
      matched_tag_count: 1,
      excluded_tag_count: 0,
      replayed: false,
    });
    const rfidReplay = await mobileService.ingestRfidReadBatch(
      TEST_USER_ID, tenantId, factoryId, rfidBatch, rfidKey, null, correlation(),
    );
    expect(rfidReplay).toMatchObject({ id: reconciled.id, duplicate_reads_suppressed: 2, replayed: true });

    const varianceBatch: CreateRfidReadBatchDto = {
      ...rfidBatch, session_id: randomUUID(), reads: ['UNKNOWN-EPC-' + randomUUID().slice(0, 8)],
    };
    const variance = await mobileService.ingestRfidReadBatch(
      TEST_USER_ID, tenantId, factoryId, varianceBatch, 'mobile-rfid-variance-' + randomUUID(), null, correlation(),
    );
    expect(variance).toMatchObject({
      expected_quantity: '3.0000',
      observed_quantity: '0.0000',
      variance_quantity: '-3.0000',
      reconciliation_status: 'VARIANCE',
      excluded_tag_count: 1,
    });
  });
});
