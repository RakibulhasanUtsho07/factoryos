import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryService } from './inventory.service';
import { InventoryLocationService } from './inventory.location.service';
import { InventoryReservationService } from './inventory.reservation.service';
import { TraceabilityService } from './traceability.service';
import { WmsFulfillmentService } from './wms-fulfillment.service';
import { GoodsReceiptService } from '../procurement/goods-receipt.service';
import { ProcurementService } from '../procurement/procurement.service';
import { ProductDefinitionsService } from '../products/products.service';
import { OrderIdempotencyService } from '../orders/order-idempotency.service';
import { OrdersService } from '../orders/orders.service';
import { ProductionWorkOrdersService } from '../production/production-work-orders.service';
import { QualityService } from '../quality/quality.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;

postgresDescribe('Inventory locations and bin balances PostgreSQL integration', () => {
  const tenantId = randomUUID();
  const userId = randomUUID();
  let adminPool!: Pool;
  let database!: DatabaseService;
  let locationService!: InventoryLocationService;
  let inventoryService!: InventoryService;
  let reservationService!: InventoryReservationService;
  let traceabilityService!: TraceabilityService;
  let fulfillmentService!: WmsFulfillmentService;
  let podStorageVerifier!: { verifyObjectDigest: ReturnType<typeof jest.fn> };
  const factoryIds: string[] = [];
  const extraUserIds: string[] = [];
  const traceId = randomUUID();
  const requestId = randomUUID();

  beforeAll(async () => {
    const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error('TEST_ADMIN_DATABASE_URL is required');
    if (!appUrl) throw new Error('DATABASE_URL is required');

    adminPool = new Pool({ connectionString: adminUrl });
    const config = {
      get: (key: string) => key === 'DATABASE_URL' ? appUrl : undefined,
    } as ConfigService;
    database = new DatabaseService(config);
    await database.onModuleInit();

    await adminPool.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES ($1, $2, 'Inventory location test tenant', 'ACTIVE')`,
      [tenantId, 'inventory-location-' + tenantId.slice(0, 8)],
    );
    await adminPool.query(
      `INSERT INTO users (id, external_subject, email, display_name, status)
       VALUES ($1, $2, $3, 'Inventory location test actor', 'ACTIVE')`,
      [userId, 'inventory-location-' + userId, 'inventory-location-' + userId + '@factoryos.test'],
    );

    const audit = { record: async () => randomUUID() } as unknown as AuditService;
    locationService = new InventoryLocationService(database, audit);
    inventoryService = new InventoryService(database, audit);
    reservationService = new InventoryReservationService(database, audit);
    traceabilityService = new TraceabilityService(database);
    podStorageVerifier = {
      verifyObjectDigest: jest.fn(async (_objectKey: string, expectedSha256: string) => ({
        sha256: expectedSha256.toLowerCase(),
        byteLength: 14,
      })),
    };
    fulfillmentService = new WmsFulfillmentService(database, podStorageVerifier as never);
  }, 60_000);

  afterAll(async () => {
    if (adminPool && factoryIds.length) {
      for (const factoryId of factoryIds) {
        await adminPool.query('ALTER TABLE quality_audit_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_rework_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_defect_links DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_rework_orders DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_ncr_action_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_ncr_actions DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_ncrs DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_dispositions DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_holds DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_inspection_results DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_defect_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_defects DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_inspection_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE quality_inspections DISABLE TRIGGER USER');
        await adminPool.query(
          'ALTER TABLE inventory_reservations DISABLE TRIGGER USER',
        );
        await adminPool.query('ALTER TABLE inventory_reservation_consumptions DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_reservation_consumption_traceability_allocations DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_reservation_traceability_allocations DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_traceability_location_balances DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE traceability_units DISABLE TRIGGER USER');
        // Label issue records are append-only in production; disable their guard only
        // for isolated integration-fixture cleanup at the end of this suite.
        await adminPool.query('ALTER TABLE traceability_label_issues DISABLE TRIGGER USER');
        // Label templates are immutable too; disable that guard only in teardown.
        await adminPool.query('ALTER TABLE traceability_label_templates DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_genealogy_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE traceability_unit_status_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_shipment_delivery_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_traceability_recall_case_units DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_traceability_recall_cases DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_shipments DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE order_lines DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE orders DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_packing_contents DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_packing_containers DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_traceability_recall_notification_acknowledgements DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_traceability_recall_notification_intents DISABLE TRIGGER USER');
        await adminPool.query(
          'ALTER TABLE inventory_location_transfers DISABLE TRIGGER USER',
        );
        await adminPool.query(
          'ALTER TABLE inventory_movements DISABLE TRIGGER USER',
        );
        await adminPool.query(
          'ALTER TABLE inventory_locations DISABLE TRIGGER USER',
        );
        await adminPool.query('ALTER TABLE production_output_postings DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE work_order_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE work_order_operations DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE work_order_material_reservations DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE work_order_material_requirements DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE work_orders DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE order_production_reports DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE goods_receipt_lines DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE goods_receipts DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE purchase_order_status_history DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE purchase_order_lines DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE purchase_orders DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_routing_steps DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_bom_lines DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_versions DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_definition_idempotency DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_definitions DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE manufacturing_work_centres DISABLE TRIGGER USER');
        try {
          // Quality rows are append-only during normal operation. Triggers are disabled
          // only for cleanup of this isolated PostgreSQL integration fixture.
          await adminPool.query('DELETE FROM quality_audit_events WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_rework_events WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_defect_links WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_rework_orders WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_ncr_action_events WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_ncr_actions WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_ncrs WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_dispositions WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_holds WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_inspection_results WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_defect_events WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_defects WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_inspection_events WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query(
            'DELETE FROM inventory_location_transfers WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            `DELETE FROM inventory_reservation_consumption_traceability_allocations
             WHERE tenant_id=$1 AND factory_id=$2 AND consumption_id IN (
               SELECT id FROM inventory_reservation_consumptions WHERE tenant_id=$1 AND factory_id=$2
             )`,
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservation_consumptions WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservation_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_traceability_location_balances WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_shipment_delivery_events WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_shipments WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_packing_contents WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM product_genealogy_events WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM traceability_label_issues WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_traceability_recall_notification_acknowledgements WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_traceability_recall_notification_intents WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_traceability_recall_case_units WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_traceability_recall_cases WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM traceability_unit_status_events WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_packing_containers WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query('DELETE FROM production_output_postings WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query(
            'DELETE FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query('DELETE FROM order_production_reports WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM work_order_events WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM work_order_material_reservations WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM work_order_material_requirements WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM work_order_operations WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM work_orders WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM order_idempotency_keys WHERE tenant_id=$1', [tenantId]);
          await adminPool.query('DELETE FROM order_lines WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM orders WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM goods_receipt_lines WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM goods_receipts WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM purchase_order_status_history WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM purchase_order_lines WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM purchase_orders WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM product_routing_steps WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM product_bom_lines WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM product_versions WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM product_definition_idempotency WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM product_definitions WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query('DELETE FROM manufacturing_work_centres WHERE tenant_id=$1 AND factory_id=$2', [tenantId, factoryId]);
          await adminPool.query(
            'DELETE FROM traceability_label_templates WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_material_allocation_policies WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservations WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_movements WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM outbox_events WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_location_balances WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_stock_balances WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_items WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            `DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND location_type = 'BIN'`,
            [tenantId, factoryId],
          );
          await adminPool.query(
            `DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND location_type IN ('WAREHOUSE', 'STAGING')`,
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND is_default = TRUE',
            [tenantId, factoryId],
          );
          // location/transfer audit records hold a restrictive FK to the factory.
          // Remove only this isolated test factory's evidence before deleting its fixture.
          await adminPool.query(
            'DELETE FROM audit_events WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM factories WHERE tenant_id = $1 AND id = $2',
            [tenantId, factoryId],
          );
        } finally {
          await adminPool.query('ALTER TABLE quality_inspections ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_inspection_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_defects ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_defect_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_inspection_results ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_holds ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_dispositions ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_ncrs ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_ncr_actions ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_ncr_action_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_rework_orders ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_defect_links ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_rework_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE quality_audit_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_traceability_location_balances ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_units ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_label_issues ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_label_templates ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_genealogy_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_unit_status_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_shipment_delivery_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_shipments ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE order_lines ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE orders ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_packing_contents ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_packing_containers ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservation_traceability_allocations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservation_consumption_traceability_allocations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservation_consumptions ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_location_transfers ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_movements ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_locations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE production_output_postings ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE work_order_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE work_order_operations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE work_order_material_reservations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE work_order_material_requirements ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE work_orders ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE order_production_reports ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE goods_receipt_lines ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE goods_receipts ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE purchase_order_status_history ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE purchase_order_lines ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE purchase_orders ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_routing_steps ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_bom_lines ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_versions ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_definition_idempotency ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_definitions ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE manufacturing_work_centres ENABLE TRIGGER USER');
        }
      }
    }
    if (adminPool) {
      await adminPool.query('ALTER TABLE suppliers DISABLE TRIGGER USER');
      try {
        await adminPool.query('DELETE FROM suppliers WHERE tenant_id = $1', [tenantId]);
      } finally {
        await adminPool.query('ALTER TABLE suppliers ENABLE TRIGGER USER');
      }
      await adminPool.query('DELETE FROM audit_events WHERE tenant_id=$1 AND factory_id IS NULL', [tenantId]);
      await adminPool.query('DELETE FROM outbox_events WHERE tenant_id=$1 AND factory_id IS NULL', [tenantId]);
      // Production/order replay acceptance persists tenant-scoped idempotency rows.
      // Remove those dependent rows before deleting the isolated tenant fixture.
      await adminPool.query('DELETE FROM order_idempotency_keys WHERE tenant_id = $1', [tenantId]);
      for (const extraUserId of extraUserIds) {
        await adminPool.query('DELETE FROM users WHERE id = $1', [extraUserId]);
      }
      await adminPool.query('DELETE FROM users WHERE id = $1', [userId]);
      await adminPool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await database?.onModuleDestroy();
    await adminPool?.end();
  }, 60_000);

  async function createStockFixture(quantity = '12.0000') {
    const factoryResult = await adminPool.query<{ id: string }>(
      `
      INSERT INTO factories (tenant_id, code, name, status)
      VALUES ($1, $2, 'Location test factory', 'ACTIVE')
      RETURNING id::text AS id
      `,
      [tenantId, 'LOC-' + randomUUID().slice(0, 8)],
    );
    const factoryId = factoryResult.rows[0]?.id;
    if (!factoryId) throw new Error('Location test factory fixture missing');
    factoryIds.push(factoryId);

    const itemResult = await adminPool.query<{ id: string }>(
      `
      INSERT INTO inventory_items (tenant_id, factory_id, sku, name, unit, created_by_user_id)
      VALUES ($1, $2, $3, 'Location test item', 'PCS', $4)
      RETURNING id::text AS id
      `,
      [tenantId, factoryId, 'LOC-SKU-' + randomUUID().slice(0, 8), userId],
    );
    const itemId = itemResult.rows[0]?.id;
    if (!itemId) throw new Error('Location test item fixture missing');

    await adminPool.query(
      `
      INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand)
      VALUES ($1, $2, $3, $4::numeric)
      `,
      [tenantId, factoryId, itemId, quantity],
    );

    const defaultResult = await adminPool.query<{ id: string }>(
      `
      SELECT id::text AS id FROM inventory_locations
      WHERE tenant_id = $1 AND factory_id = $2 AND is_default = TRUE
      `,
      [tenantId, factoryId],
    );
    if (!defaultResult.rows[0]) throw new Error('New factory did not receive the default location');
    return { factoryId, itemId, defaultLocationId: defaultResult.rows[0].id };
  }

  async function createWarehouseAndBins(factoryId: string) {
    const warehouse = await locationService.createLocation(
      userId, tenantId, factoryId,
      { location_code: 'WH-' + randomUUID().slice(0, 8), name: 'Main warehouse', location_type: 'WAREHOUSE' },
      requestId, traceId,
    );
    const binA = await locationService.createLocation(
      userId, tenantId, factoryId,
      { location_code: 'BIN-A-' + randomUUID().slice(0, 8), name: 'Fabric bin A', location_type: 'BIN', parent_location_id: warehouse.id },
      requestId, traceId,
    );
    const binB = await locationService.createLocation(
      userId, tenantId, factoryId,
      { location_code: 'BIN-B-' + randomUUID().slice(0, 8), name: 'Fabric bin B', location_type: 'BIN', parent_location_id: warehouse.id },
      requestId, traceId,
    );
    return { warehouse, binA, binB };
  }

  async function readAggregate(factoryId: string, itemId: string) {
    const result = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      `
      SELECT quantity_on_hand::text AS quantity_on_hand,
             quantity_reserved::text AS quantity_reserved
      FROM inventory_stock_balances
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
      `,
      [tenantId, factoryId, itemId],
    );
    return result.rows[0];
  }

  async function readBinTotals(factoryId: string, itemId: string) {
    const result = await adminPool.query<{ sum: string; count: number }>(
      `
      SELECT COALESCE(SUM(quantity_on_hand), 0)::text AS sum, COUNT(*)::int AS count
      FROM inventory_location_balances
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
      `,
      [tenantId, factoryId, itemId],
    );
    return result.rows[0];
  }

  it('seeds new factories with a default location and maintains bin totals across idempotent transfers', async () => {
    const fixture = await createStockFixture();
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);

    const locationEvent = await adminPool.query<{ aggregate_type: string }>(
      `
      SELECT aggregate_type FROM outbox_events
      WHERE tenant_id = $1 AND factory_id = $2
        AND aggregate_id = $3 AND event_type = 'INVENTORY.LOCATION_CREATED'
      ORDER BY created_at DESC LIMIT 1
      `,
      [tenantId, fixture.factoryId, binA.id],
    );
    expect(locationEvent.rows[0]?.aggregate_type).toBe('INVENTORY_LOCATION');

    const payload = {
      source_location_id: fixture.defaultLocationId,
      destination_location_id: binA.id,
      quantity: 7,
      notes: 'Put stock away after receiving',
    };
    const moved = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      payload, 'location-transfer-001', requestId, traceId,
    );
    expect(moved.quantity).toBe('7.0000');
    expect(moved.source_quantity_after).toBe('5.0000');
    expect(moved.destination_quantity_after).toBe('7.0000');
    expect(moved.replayed).toBe(false);

    const transferEvent = await adminPool.query<{ aggregate_type: string }>(
      `
      SELECT aggregate_type FROM outbox_events
      WHERE tenant_id = $1 AND factory_id = $2
        AND aggregate_id = $3 AND event_type = 'INVENTORY.STOCK_LOCATION_TRANSFERRED'
      ORDER BY created_at DESC LIMIT 1
      `,
      [tenantId, fixture.factoryId, fixture.itemId],
    );
    expect(transferEvent.rows[0]?.aggregate_type).toBe('INVENTORY_ITEM');

    const replay = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      payload, 'location-transfer-001', requestId, traceId,
    );
    expect(replay.id).toBe(moved.id);
    expect(replay.replayed).toBe(true);
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { ...payload, quantity: 6 }, 'location-transfer-001', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const bins = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    const binAResult = bins.find((row) => row.location_id === binA.id);
    const defaultResult = bins.find((row) => row.location_id === fixture.defaultLocationId);
    expect(binAResult?.quantity_on_hand).toBe('7.0000');
    expect(defaultResult?.quantity_on_hand).toBe('5.0000');
    expect(bins.find((row) => row.location_id === binB.id)?.quantity_on_hand).toBe('0.0000');

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('12.0000');
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);
    expect(totals?.count).toBe(2);

    const transfers = await locationService.listTransfers(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.id).toBe(moved.id);

    const metadata = await adminPool.query<{ rls: boolean; forced: boolean }>(
      `
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      WHERE c.oid = 'inventory_location_balances'::regclass
      `,
    );
    expect(metadata.rows[0]).toEqual({ rls: true, forced: true });

    await expect(adminPool.query(
      'UPDATE inventory_location_transfers SET notes = $1 WHERE id = $2',
      ['tampered', moved.id],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('pins a reservation to a BIN, prevents transfers through reserved stock and consumes from the same BIN', async () => {
    const fixture = await createStockFixture('12.0000');
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
      },
      'bin-reservation-seed-transfer', requestId, traceId,
    );

    const reservePayload = { quantity: 5, location_id: binA.id };
    const reservation = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      reservePayload, 'bin-reservation-create', requestId, traceId,
    );
    expect(reservation).toMatchObject({
      status: 'RESERVED',
      location_id: binA.id,
      quantity: '5.0000',
      replayed: false,
    });

    const replay = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      reservePayload, 'bin-reservation-create', requestId, traceId,
    );
    expect(replay).toMatchObject({ id: reservation.id, replayed: true, location_id: binA.id });

    const beforeTransfer = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(beforeTransfer.find((row) => row.location_id === binA.id)).toMatchObject({
      quantity_on_hand: '7.0000',
      location_quantity_reserved: '5.0000',
      location_quantity_available: '2.0000',
    });

    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: binB.id,
        quantity: 3,
      },
      'bin-reservation-blocked-transfer', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const consumed = await reservationService.transitionReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId, reservation.id,
      { target_status: 'CONSUMED' },
      'bin-reservation-consume', requestId, traceId,
    );
    expect(consumed).toMatchObject({
      status: 'CONSUMED',
      location_id: binA.id,
      consumed_movement_id: expect.any(String),
    });

    const movement = await adminPool.query<{ location_id: string | null }>(
      'SELECT location_id::text AS location_id FROM inventory_movements WHERE id = $1',
      [consumed.consumed_movement_id],
    );
    expect(movement.rows[0]?.location_id).toBe(binA.id);

    const releasedReservation = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { quantity: 1, location_id: binA.id }, 'bin-reservation-release-create', requestId, traceId,
    );
    const released = await reservationService.transitionReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId, releasedReservation.id,
      { target_status: 'RELEASED' },
      'bin-reservation-release', requestId, traceId,
    );
    expect(released.status).toBe('RELEASED');

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate).toMatchObject({
      quantity_on_hand: '7.0000',
      quantity_reserved: '0.0000',
    });
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const after = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(after.find((row) => row.location_id === binA.id)).toMatchObject({
      quantity_on_hand: '2.0000',
      location_quantity_reserved: '0.0000',
      location_quantity_available: '2.0000',
    });
  });

  it('rejects direct bin reserved-balance drift that has no matching active reservation', async () => {
    const fixture = await createStockFixture('12.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
      },
      'reserved-balance-guard-' + randomUUID(), requestId, traceId,
    );

    await expect(adminPool.query(
      `UPDATE inventory_location_balances
       SET quantity_reserved = quantity_reserved + 1
       WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3 AND location_id = $4`,
      [tenantId, fixture.factoryId, fixture.itemId, binA.id],
    )).rejects.toMatchObject({ code: '23514' });

    const balance = await adminPool.query<{ quantity_reserved: string }>(
      `SELECT quantity_reserved::text AS quantity_reserved
       FROM inventory_location_balances
       WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3 AND location_id = $4`,
      [tenantId, fixture.factoryId, fixture.itemId, binA.id],
    );
    expect(balance.rows[0]?.quantity_reserved).toBe('0.0000');
  });

  it('keeps location balances aligned when receipts/issues target a bin or use the legacy aggregate path', async () => {
    const fixture = await createStockFixture();
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
      },
      'location-transfer-002', requestId, traceId,
    );

    const issued = await inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'ISSUE', quantity: 2, location_id: binA.id },
      'bin-issue-001', requestId, traceId,
    );
    expect(issued.location_id).toBe(binA.id);
    expect(issued.quantity_after).toBe('10.0000');

    const receipt = await inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'RECEIPT', quantity: 1.5, location_id: binB.id },
      'bin-receipt-001', requestId, traceId,
    );
    expect(receipt.location_id).toBe(binB.id);
    expect(receipt.quantity_after).toBe('11.5000');

    await inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'ISSUE', quantity: 3 },
      'aggregate-issue-001', requestId, traceId,
    );

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('8.5000');
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const binRows = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(binRows.find((row) => row.location_id === binA.id)?.quantity_on_hand).toBe('5.0000');
    expect(binRows.find((row) => row.location_id === binB.id)?.quantity_on_hand).toBe('1.5000');
    expect(binRows.find((row) => row.location_id === fixture.defaultLocationId)?.quantity_on_hand).toBe('2.0000');
  });

  it('rejects invalid parent scope, insufficient source stock, and transfers that would encroach on reserved stock', async () => {
    const fixture = await createStockFixture('12.0000');
    const otherFactoryResult = await adminPool.query<{ id: string }>(
      `
      INSERT INTO factories (tenant_id, code, name, status)
      VALUES ($1, $2, 'Other location test factory', 'ACTIVE')
      RETURNING id::text AS id
      `,
      [tenantId, 'LOC-OTHER-' + randomUUID().slice(0, 8)],
    );
    const otherFactoryId = otherFactoryResult.rows[0]?.id;
    if (!otherFactoryId) throw new Error('Cross-scope factory fixture missing');
    factoryIds.push(otherFactoryId);

    const otherWarehouse = await locationService.createLocation(
      userId, tenantId, otherFactoryId,
      { location_code: 'OTHER-WH-' + randomUUID().slice(0, 8), name: 'Other warehouse', location_type: 'WAREHOUSE' },
      requestId, traceId,
    );
    await expect(locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      { location_code: 'BAD-BIN-' + randomUUID().slice(0, 8), name: 'Cross-factory bin', location_type: 'BIN', parent_location_id: otherWarehouse.id },
      requestId, traceId,
    )).rejects.toBeInstanceOf(BadRequestException);

    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 13,
      },
      'location-overdraw-001', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    await adminPool.query(
      'UPDATE inventory_stock_balances SET quantity_reserved = 10 WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3',
      [tenantId, fixture.factoryId, fixture.itemId],
    );
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 3,
      },
      'location-reserved-001', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
  });
  it('enforces directed put-away/pick policies without stealing reserved stock', async () => {
    const fixture = await createStockFixture('12.0000');
    const { warehouse, binA, binB } = await createWarehouseAndBins(fixture.factoryId);
    const staging = await locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      {
        location_code: 'STAGE-' + randomUUID().slice(0, 8),
        name: 'Production staging',
        location_type: 'STAGING',
      },
      requestId, traceId,
    );

    expect(warehouse).toMatchObject({ putaway_enabled: false, picking_enabled: false });
    expect(binA).toMatchObject({ putaway_enabled: true, picking_enabled: true });
    await locationService.updateLocationPolicy(
      userId, tenantId, fixture.factoryId, binA.id,
      { putaway_priority: 50 }, requestId, traceId,
    );
    await locationService.updateLocationPolicy(
      userId, tenantId, fixture.factoryId, binB.id,
      { putaway_priority: 10, picking_priority: 5 }, requestId, traceId,
    );

    const targets = await locationService.listPutawayTargets(tenantId, fixture.factoryId, fixture.itemId);
    expect(targets[0]).toMatchObject({ location_id: binB.id, putaway_priority: 10 });

    const putawayKey = 'directed-putaway-' + randomUUID();
    const putaway = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
        movement_purpose: 'PUT_AWAY',
        notes: 'Directed put-away after receipt',
      },
      putawayKey, requestId, traceId,
    );
    expect(putaway).toMatchObject({
      movement_purpose: 'PUT_AWAY',
      source_quantity_after: '5.0000',
      destination_quantity_after: '7.0000',
    });
    const putawayReplay = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
        movement_purpose: 'PUT_AWAY',
        notes: 'Directed put-away after receipt',
      },
      putawayKey, requestId, traceId,
    );
    expect(putawayReplay).toMatchObject({ id: putaway.id, replayed: true, movement_purpose: 'PUT_AWAY' });
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
        notes: 'Directed put-away after receipt',
      },
      putawayKey, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const reservation = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { quantity: 5, location_id: binA.id },
      'directed-pick-reserve-' + randomUUID(), requestId, traceId,
    );
    const sources = await locationService.listPickSources(tenantId, fixture.factoryId, fixture.itemId);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      location_id: binA.id,
      quantity_on_hand: '7.0000',
      quantity_reserved: '5.0000',
      quantity_available: '2.0000',
    });

    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 3,
        movement_purpose: 'PICK',
      },
      'directed-pick-over-reservation-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const picked = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 2,
        movement_purpose: 'PICK',
        notes: 'Move only unreserved stock to staging',
      },
      'directed-pick-' + randomUUID(), requestId, traceId,
    );
    expect(picked).toMatchObject({
      movement_purpose: 'PICK',
      source_quantity_after: '5.0000',
      destination_quantity_after: '2.0000',
    });

    await expect(locationService.updateLocationPolicy(
      userId, tenantId, fixture.factoryId, binA.id,
      { picking_enabled: false }, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(adminPool.query(
      `UPDATE inventory_locations SET status = 'DISABLED'
       WHERE tenant_id = $1 AND factory_id = $2 AND id = $3`,
      [tenantId, fixture.factoryId, binA.id],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'RECEIPT', quantity: 1, location_id: warehouse.id },
      'warehouse-direct-receipt-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const consumed = await reservationService.transitionReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId, reservation.id,
      { target_status: 'CONSUMED' },
      'directed-pick-consume-' + randomUUID(), requestId, traceId,
    );
    expect(consumed).toMatchObject({ status: 'CONSUMED', location_id: binA.id });

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate).toMatchObject({
      quantity_on_hand: '7.0000',
      quantity_reserved: '0.0000',
    });
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const after = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(after.find((row) => row.location_id === fixture.defaultLocationId)?.quantity_on_hand).toBe('5.0000');
    expect(after.find((row) => row.location_id === binA.id)).toMatchObject({
      quantity_on_hand: '0.0000',
      location_quantity_reserved: '0.0000',
    });
    expect(after.find((row) => row.location_id === staging.id)?.quantity_on_hand).toBe('2.0000');

    const moves = await locationService.listTransfers(tenantId, fixture.factoryId, fixture.itemId);
    expect(moves.filter((move) => move.movement_purpose === 'PUT_AWAY')).toHaveLength(1);
    expect(moves.filter((move) => move.movement_purpose === 'PICK')).toHaveLength(1);
  });


  it('puts away, transfers and picks finished-good lots without losing location-level identity', async () => {
    const fixture = await createStockFixture('5.0000');
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);
    const staging = await locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      {
        location_code: 'FG-STAGE-' + randomUUID().slice(0, 8),
        name: 'Finished goods staging',
        location_type: 'STAGING',
      },
      requestId, traceId,
    );

    const createdLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT',
        product_role: 'FINISHED_GOOD',
        unit_code: 'FG-LOT-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId,
        quantity: 5,
        unit: 'PCS',
        external_reference: 'wms-finished-good-putaway-test',
      } as never,
      'fg-lot-register-' + randomUUID(), requestId, traceId,
    );
    const finishedLotId = createdLot.id;
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1, $2, $3, $4, $5, 5.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLotId, fixture.defaultLocationId],
    );

    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 1,
        movement_purpose: 'PUT_AWAY',
      },
      'fg-lot-missing-id-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(adminPool.query(
      `INSERT INTO inventory_location_transfers (
         tenant_id, factory_id, item_id, source_location_id, destination_location_id,
         quantity, source_quantity_before, source_quantity_after,
         destination_quantity_before, destination_quantity_after,
         idempotency_key, request_hash, created_by_user_id, correlation_id,
         movement_purpose
       ) VALUES ($1,$2,$3,$4,$5,1,5,4,0,1,$6,$7,$8,$9,'PUT_AWAY')`,
      [
        tenantId, fixture.factoryId, fixture.itemId, fixture.defaultLocationId, binA.id,
        'fg-lot-db-bypass-' + randomUUID(), 'a'.repeat(64), userId, traceId,
      ],
    )).rejects.toMatchObject({ code: '23514' });

    const putAwayPayload = {
      source_location_id: fixture.defaultLocationId,
      destination_location_id: binA.id,
      quantity: 3,
      movement_purpose: 'PUT_AWAY' as const,
      traceability_unit_id: finishedLotId,
    };
    const putAwayKey = 'fg-lot-putaway-' + randomUUID();
    const putAway = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      putAwayPayload, putAwayKey, requestId, traceId,
    );
    expect(putAway).toMatchObject({
      movement_purpose: 'PUT_AWAY',
      traceability_unit_id: finishedLotId,
      source_quantity_after: '2.0000',
      destination_quantity_after: '3.0000',
      replayed: false,
    });
    const putAwayReplay = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      putAwayPayload, putAwayKey, requestId, traceId,
    );
    expect(putAwayReplay).toMatchObject({ id: putAway.id, traceability_unit_id: finishedLotId, replayed: true });

    const moved = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: binB.id,
        quantity: 1,
        traceability_unit_id: finishedLotId,
      },
      'fg-lot-bin-transfer-' + randomUUID(), requestId, traceId,
    );
    expect(moved.traceability_unit_id).toBe(finishedLotId);

    const picked = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 1,
        movement_purpose: 'PICK',
        traceability_unit_id: finishedLotId,
      },
      'fg-lot-pick-' + randomUUID(), requestId, traceId,
    );
    expect(picked).toMatchObject({ movement_purpose: 'PICK', traceability_unit_id: finishedLotId });

    const identityBalances = await adminPool.query<{
      location_id: string; quantity_on_hand: string; quantity_reserved: string;
    }>(
      `SELECT location_id::text AS location_id, quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4
       ORDER BY location_id`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLotId],
    );
    expect(identityBalances.rows).toHaveLength(4);
    expect(identityBalances.rows.reduce((sum, row) => sum + Number(row.quantity_on_hand), 0)).toBeCloseTo(5, 4);
    expect(identityBalances.rows.every((row) => row.quantity_reserved === '0.0000')).toBe(true);
    expect(identityBalances.rows.find((row) => row.location_id === fixture.defaultLocationId)?.quantity_on_hand).toBe('2.0000');
    expect(identityBalances.rows.find((row) => row.location_id === binA.id)?.quantity_on_hand).toBe('1.0000');
    expect(identityBalances.rows.find((row) => row.location_id === binB.id)?.quantity_on_hand).toBe('1.0000');
    expect(identityBalances.rows.find((row) => row.location_id === staging.id)?.quantity_on_hand).toBe('1.0000');

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('5.0000');
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const movements = await locationService.listTransfers(tenantId, fixture.factoryId, fixture.itemId);
    expect(movements.filter((move) => move.traceability_unit_id === finishedLotId)).toHaveLength(3);
  });


  it('packs a finished-good lot into a carton and pallet, then dispatches once with stock and customer traceability', async () => {
    const fixture = await createStockFixture('5.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    const finishedLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT',
        product_role: 'FINISHED_GOOD',
        unit_code: 'FG-SHIP-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId,
        quantity: 5,
        unit: 'PCS',
        external_reference: 'wms-finished-good-putaway-test',
      } as never,
      'fg-ship-register-' + randomUUID(), requestId, traceId,
    );
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1,$2,$3,$4,$5,5.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, fixture.defaultLocationId],
    );
    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 5,
        movement_purpose: 'PUT_AWAY',
        traceability_unit_id: finishedLot.id,
      },
      'fg-ship-putaway-' + randomUUID(), requestId, traceId,
    );

    const carton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 3,
      },
      'wms-carton-create-' + randomUUID(), requestId, traceId,
    );
    const cartonId = carton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 3 },
      'wms-carton-content-' + randomUUID(), requestId, traceId,
    );
    const duplicateCarton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-DUP-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 3,
      },
      'wms-carton-dup-create-' + randomUUID(), requestId, traceId,
    );
    await expect(fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, duplicateCarton.container.container_unit_id as string,
      { source_unit_id: finishedLot.id, quantity: 3 },
      'wms-carton-dup-content-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    // Container capacity is an independent guard from available stock.
    await expect(fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 0.1 },
      'wms-carton-over-capacity-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    const packingCommitmentClient = await adminPool.connect();
    try {
      await packingCommitmentClient.query('BEGIN');
      await packingCommitmentClient.query(
        `UPDATE inventory_traceability_location_balances
         SET quantity_on_hand=2.0000, version=version+1, updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
           AND traceability_unit_id=$4 AND location_id=$5`,
        [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
      );
      await expect(packingCommitmentClient.query('COMMIT'))
        .rejects.toThrow(/active carton packing commitments/i);
      await packingCommitmentClient.query('ROLLBACK').catch(() => undefined);
    } finally {
      packingCommitmentClient.release();
    }
    const afterRejectedIssue = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT quantity_on_hand::text AS quantity_on_hand
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
         AND traceability_unit_id=$4 AND location_id=$5`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
    );
    expect(afterRejectedIssue.rows[0]?.quantity_on_hand).toBe('5.0000');
    const cartonSealKey = 'wms-carton-seal-' + randomUUID();
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId, cartonSealKey, requestId, traceId,
    );
    const cartonSealReplay = await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId, cartonSealKey, requestId, traceId,
    );
    expect(cartonSealReplay.replayed).toBe(true);

    const pallet = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'PALLET',
        container_code: 'PALLET-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 3,
      },
      'wms-pallet-create-' + randomUUID(), requestId, traceId,
    );
    const palletId = pallet.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, palletId,
      { source_unit_id: cartonId, quantity: 3 },
      'wms-pallet-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, palletId, 'wms-pallet-seal-' + randomUUID(), requestId, traceId,
    );
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId,
      {
        shipment_code: 'SHIP-CARTON-BLOCK-' + randomUUID().slice(0, 5),
        customer_name: 'Acceptance Customer',
        customer_order_reference: 'ORDER-CARTON-BLOCK-' + randomUUID().slice(0, 5),
      },
      'wms-carton-dispatch-block-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const dispatchKey = 'wms-dispatch-' + randomUUID();
    const dispatchPayload = {
      shipment_code: 'SHIP-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer',
      customer_order_reference: 'CUSTOMER-ORDER-' + randomUUID().slice(0, 8),
      carrier_name: 'Acceptance Carrier',
      tracking_reference: 'TRACK-' + randomUUID().slice(0, 8),
    };
    const dispatched = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId, dispatchPayload,
      dispatchKey, requestId, traceId,
    );
    expect(dispatched).toMatchObject({ replayed: false, shipment: {
      container_unit_id: palletId,
      item_id: fixture.itemId,
      quantity: '3.0000',
      customer_name: dispatchPayload.customer_name,
      customer_order_reference: dispatchPayload.customer_order_reference,
      status: 'DISPATCHED',
    }});
    const replayed = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId, dispatchPayload,
      dispatchKey, requestId, traceId,
    );
    expect(replayed).toMatchObject({ replayed: true, shipment: { shipment_unit_id: dispatched.shipment.shipment_unit_id } });
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId,
      { ...dispatchPayload, shipment_code: 'SHIP-REPLAY-BLOCK' },
      'wms-dispatch-duplicate-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const locationTotals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('2.0000');
    expect(locationTotals?.sum).toBe(aggregate?.quantity_on_hand);
    const identityBalance = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4 AND location_id=$5`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
    );
    expect(identityBalance.rows[0]?.quantity_on_hand).toBe('2.0000');

    const shipmentRow = await adminPool.query<{
      status: string; customer_order_reference: string; quantity: string; inventory_movement_id: string;
    }>(
      `SELECT status, customer_order_reference, quantity::text AS quantity, inventory_movement_id::text AS inventory_movement_id
       FROM wms_shipments WHERE tenant_id=$1 AND factory_id=$2 AND shipment_unit_id=$3`,
      [tenantId, fixture.factoryId, dispatched.shipment.shipment_unit_id],
    );
    expect(shipmentRow.rows[0]).toMatchObject({
      status: 'DISPATCHED',
      customer_order_reference: dispatchPayload.customer_order_reference,
      quantity: '3.0000',
      inventory_movement_id: dispatched.shipment.inventory_movement_id,
    });
    const shipmentList = await fulfillmentService.listShipments(
      userId, tenantId, fixture.factoryId, { search: dispatchPayload.customer_order_reference },
    );
    expect(shipmentList.shipments).toHaveLength(1);
    expect(shipmentList.shipments[0]).toMatchObject({
      shipment_unit_id: dispatched.shipment.shipment_unit_id,
      shipment_code: dispatchPayload.shipment_code.toUpperCase(),
      customer_name: dispatchPayload.customer_name,
      customer_order_reference: dispatchPayload.customer_order_reference,
      quantity: '3.0000',
      status: 'DISPATCHED',
      traceability_status: 'SHIPPED',
    });
    const movement = await adminPool.query<{
      movement_type: string; quantity_delta: string; reference_type: string; reference_id: string;
    }>(
      `SELECT movement_type, quantity_delta::text AS quantity_delta, reference_type, reference_id::text AS reference_id
       FROM inventory_movements WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [dispatched.shipment.inventory_movement_id, tenantId, fixture.factoryId],
    );
    expect(movement.rows[0]).toMatchObject({
      movement_type: 'ISSUE', quantity_delta: '-3.0000', reference_type: 'WMS_SHIPMENT',
      reference_id: dispatched.shipment.shipment_unit_id,
    });
    const genealogy = await adminPool.query(
      `SELECT relationship_type FROM product_genealogy_events
       WHERE tenant_id=$1 AND factory_id=$2 AND source_unit_id=$3 AND target_unit_id=$4`,
      [tenantId, fixture.factoryId, palletId, dispatched.shipment.shipment_unit_id],
    );
    expect(genealogy.rows.map(row => row.relationship_type)).toContain('SHIPPED_AS');
    const statuses = await adminPool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM traceability_units
       WHERE tenant_id=$1 AND factory_id=$2 AND id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [palletId, cartonId, dispatched.shipment.shipment_unit_id, finishedLot.id]],
    );
    expect(statuses.rows.find(row => row.id === palletId)?.status).toBe('SHIPPED');
    expect(statuses.rows.find(row => row.id === cartonId)?.status).toBe('SHIPPED');
    expect(statuses.rows.find(row => row.id === dispatched.shipment.shipment_unit_id)?.status).toBe('SHIPPED');
    expect(statuses.rows.find(row => row.id === finishedLot.id)?.status).toBe('ACTIVE');
    const packageStatuses = await adminPool.query<{ container_unit_id: string; status: string }>(
      `SELECT container_unit_id::text AS container_unit_id, status FROM wms_packing_containers
       WHERE tenant_id=$1 AND factory_id=$2 AND container_unit_id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [palletId, cartonId]],
    );
    expect(packageStatuses.rows.find(row => row.container_unit_id === palletId)?.status).toBe('DISPATCHED');
    expect(packageStatuses.rows.find(row => row.container_unit_id === cartonId)?.status).toBe('DISPATCHED');

    // A caller from another tenant must not learn container or customer shipment details.
    const foreignTenantId = randomUUID();
    await expect(fulfillmentService.getContainer(
      userId, foreignTenantId, fixture.factoryId, palletId,
    )).rejects.toThrow(/not found in this factory/i);
    const foreignShipments = await fulfillmentService.listShipments(
      userId, foreignTenantId, fixture.factoryId, { search: dispatchPayload.customer_order_reference },
    );
    expect(foreignShipments.shipments).toHaveLength(0);

    await expect(fulfillmentService.dispatchContainer(
      userId, foreignTenantId, fixture.factoryId, palletId,
      dispatchPayload, 'wms-foreign-dispatch-' + randomUUID(), requestId, traceId,
    )).rejects.toThrow(/not found in this factory/i);

    const emptyCarton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-EMPTY-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 1,
      },
      'wms-carton-empty-create-' + randomUUID(), requestId, traceId,
    );
    await expect(fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId,
      emptyCarton.container.container_unit_id as string,
      'wms-carton-empty-seal-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId,
      emptyCarton.container.container_unit_id as string,
      {
        shipment_code: 'SHIP-EMPTY-' + randomUUID().slice(0, 8),
        customer_name: 'Acceptance Customer',
        customer_order_reference: 'ORDER-EMPTY-' + randomUUID().slice(0, 8),
      },
      'wms-carton-empty-dispatch-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    // The previously packed lot has exactly two units left. Exercise the late-failure
    // path after stock and shipment rows have been written, and prove transaction rollback.
    const remainderCarton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-REMAINDER-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 2,
      },
      'wms-carton-remainder-create-' + randomUUID(), requestId, traceId,
    );
    const remainderCartonId = remainderCarton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      { source_unit_id: finishedLot.id, quantity: 2 },
      'wms-carton-remainder-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      'wms-carton-remainder-seal-' + randomUUID(), requestId, traceId,
    );

    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      {
        shipment_code: 'SHIP-CARRIER-PAIR-' + randomUUID().slice(0, 8),
        customer_name: 'Acceptance Customer',
        customer_order_reference: 'ORDER-CARRIER-PAIR-' + randomUUID().slice(0, 8),
        carrier_name: 'Acceptance Carrier',
      } as never,
      'wms-carrier-missing-tracking-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(BadRequestException);

    // The dispatch lookup and database index normalize carrier/tracking case.
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      {
        shipment_code: 'SHIP-CARRIER-DUP-' + randomUUID().slice(0, 8),
        customer_name: 'Acceptance Customer',
        customer_order_reference: 'ORDER-CARRIER-DUP-' + randomUUID().slice(0, 8),
        carrier_name: dispatchPayload.carrier_name.toLowerCase(),
        tracking_reference: dispatchPayload.tracking_reference.toLowerCase(),
      },
      'wms-carrier-duplicate-tracking-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const rollbackPayload = {
      shipment_code: 'SHIP-ROLLBACK-' + randomUUID().slice(0, 8),
      customer_name: 'Rollback Acceptance Customer',
      customer_order_reference: 'ORDER-ROLLBACK-' + randomUUID().slice(0, 8),
    };
    const fulfillmentInternals = fulfillmentService as unknown as {
      insertOutbox: (...args: unknown[]) => Promise<void>;
    };
    const originalInsertOutbox = fulfillmentInternals.insertOutbox.bind(fulfillmentService);
    const outboxSpy = jest.spyOn(fulfillmentInternals, 'insertOutbox').mockImplementation(async (...args: unknown[]) => {
      if (args[5] === 'WMS.SHIPMENT_DISPATCHED') {
        throw new Error('forced WMS shipment outbox failure for rollback acceptance');
      }
      return originalInsertOutbox(...args);
    });
    try {
      await expect(fulfillmentService.dispatchContainer(
        userId, tenantId, fixture.factoryId, remainderCartonId, rollbackPayload,
        'wms-dispatch-rollback-' + randomUUID(), requestId, traceId,
      )).rejects.toThrow(/forced WMS shipment outbox failure/i);
    } finally {
      outboxSpy.mockRestore();
    }

    const afterRollbackAggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    expect(afterRollbackAggregate?.quantity_on_hand).toBe('2.0000');
    const afterRollbackLotBalance = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT quantity_on_hand::text AS quantity_on_hand
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
         AND traceability_unit_id=$4 AND location_id=$5`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
    );
    expect(afterRollbackLotBalance.rows[0]?.quantity_on_hand).toBe('2.0000');
    const afterRollbackContainer = await adminPool.query<{ status: string }>(
      `SELECT status FROM wms_packing_containers
       WHERE tenant_id=$1 AND factory_id=$2 AND container_unit_id=$3`,
      [tenantId, fixture.factoryId, remainderCartonId],
    );
    expect(afterRollbackContainer.rows[0]?.status).toBe('SEALED');
    const rolledBackShipmentCount = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wms_shipments
       WHERE tenant_id=$1 AND factory_id=$2
         AND (container_unit_id=$3 OR shipment_code=$4)`,
      [tenantId, fixture.factoryId, remainderCartonId, rollbackPayload.shipment_code],
    );
    expect(rolledBackShipmentCount.rows[0]?.count).toBe('0');
    const rolledBackMovementCount = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements
       WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='WMS_SHIPMENT'
         AND notes=$3`,
      [tenantId, fixture.factoryId, 'WMS customer dispatch ' + rollbackPayload.shipment_code],
    );
    expect(rolledBackMovementCount.rows[0]?.count).toBe('0');

    // Partial-quantity fulfilment can continue as a second shipment, but it must
    // consume only the remaining two units and leave the stock ledger at zero.
    const remainderPayload = {
      shipment_code: 'SHIP-REMAINDER-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer',
      customer_order_reference: 'CUSTOMER-ORDER-REMAINDER-' + randomUUID().slice(0, 8),
    };
    const remainderKey = 'wms-dispatch-remainder-' + randomUUID();
    const remainderDispatch = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      remainderPayload, remainderKey, requestId, traceId,
    );
    expect(remainderDispatch).toMatchObject({
      replayed: false,
      shipment: { container_unit_id: remainderCartonId, quantity: '2.0000', status: 'DISPATCHED' },
    });
    const remainderReplay = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      remainderPayload, remainderKey, requestId, traceId,
    );
    expect(remainderReplay).toMatchObject({
      replayed: true, shipment: { shipment_unit_id: remainderDispatch.shipment.shipment_unit_id },
    });

    const finalAggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const finalLocationTotals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(finalAggregate?.quantity_on_hand).toBe('0.0000');
    expect(finalLocationTotals?.sum).toBe(finalAggregate?.quantity_on_hand);
    const finalLotBalance = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT COALESCE(sum(quantity_on_hand),0)::text AS quantity_on_hand
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id],
    );
    expect(finalLotBalance.rows[0]?.quantity_on_hand).toBe('0.0000');
    const allShipments = await adminPool.query<{ quantity: string }>(
      `SELECT quantity::text AS quantity FROM wms_shipments
       WHERE tenant_id=$1 AND factory_id=$2
         AND container_unit_id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [palletId, remainderCartonId]],
    );
    expect(allShipments.rows.map(row => Number(row.quantity)).reduce((sum, q) => sum + q, 0)).toBe(5);
    const finalLotStatus = await adminPool.query<{ status: string }>(
      `SELECT status FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [finishedLot.id, tenantId, fixture.factoryId],
    );
    expect(finalLotStatus.rows[0]?.status).toBe('SHIPPED');

    const recallImpact = await traceabilityService.recallImpact(
      userId, tenantId, fixture.factoryId, finishedLot.id, 12, 200,
    );
    expect(recallImpact).toMatchObject({
      requested_unit: { id: finishedLot.id, unit_code: finishedLot.unit_code },
      side_effects: { stock_changed: false, statuses_changed: false, records_created: false },
    });
    const impactShipmentIds = recallImpact.affected_shipments.map(
      (shipment: { shipment_unit_id: string }) => shipment.shipment_unit_id,
    );
    expect(impactShipmentIds).toEqual(expect.arrayContaining([
      dispatched.shipment.shipment_unit_id,
      remainderDispatch.shipment.shipment_unit_id,
    ]));
    expect(recallImpact.impacted_units.map((unit: { id: string }) => unit.id)).toEqual(
      expect.arrayContaining([cartonId, palletId, remainderCartonId,
        dispatched.shipment.shipment_unit_id, remainderDispatch.shipment.shipment_unit_id]),
    );

    // The recall preview is bounded and read-only; callers must not mistake it for a recall decision.
    const boundedImpact = await traceabilityService.recallImpact(
      userId, tenantId, fixture.factoryId, finishedLot.id, 12, 1,
    );
    expect(boundedImpact).toMatchObject({
      impact_truncated: true,
      impact_node_limit_reached: true,
      impacted_unit_count: 0,
    });
    const depthBoundedImpact = await traceabilityService.recallImpact(
      userId, tenantId, fixture.factoryId, finishedLot.id, 1, 200,
    );
    expect(depthBoundedImpact.impact_depth_truncated).toBe(true);
    expect(depthBoundedImpact.impact_truncated).toBe(true);
    const afterImpactAggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    expect(afterImpactAggregate?.quantity_on_hand).toBe(finalAggregate?.quantity_on_hand);
    const afterImpactStatus = await adminPool.query<{ status: string }>(
      `SELECT status FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [finishedLot.id, tenantId, fixture.factoryId],
    );
    expect(afterImpactStatus.rows[0]?.status).toBe(finalLotStatus.rows[0]?.status);
    await expect(traceabilityService.recallImpact(
      userId, randomUUID(), fixture.factoryId, finishedLot.id, 12, 200,
    )).rejects.toThrow(/not found in this factory/i);
  });

  it('declares an idempotent recall case only for complete downstream genealogy and preserves stock', async () => {
    const fixture = await createStockFixture('2.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    const finishedLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT', product_role: 'FINISHED_GOOD',
        unit_code: 'FG-RECALL-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId, quantity: 2, unit: 'PCS',
        external_reference: 'wms-recall-declaration-acceptance',
      } as never,
      'fg-recall-register-' + randomUUID(), requestId, traceId,
    );
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1,$2,$3,$4,$5,2.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, fixture.defaultLocationId],
    );
    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId, destination_location_id: binA.id,
        quantity: 2, movement_purpose: 'PUT_AWAY', traceability_unit_id: finishedLot.id,
      },
      'fg-recall-putaway-' + randomUUID(), requestId, traceId,
    );

    const carton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-RECALL-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId, location_id: binA.id, capacity_quantity: 2,
      },
      'wms-recall-carton-create-' + randomUUID(), requestId, traceId,
    );
    const cartonId = carton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 2 },
      'wms-recall-carton-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId,
      'wms-recall-carton-seal-' + randomUUID(), requestId, traceId,
    );
    const pallet = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'PALLET',
        container_code: 'PALLET-RECALL-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId, location_id: binA.id, capacity_quantity: 2,
      },
      'wms-recall-pallet-create-' + randomUUID(), requestId, traceId,
    );
    const palletId = pallet.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, palletId,
      { source_unit_id: cartonId, quantity: 2 },
      'wms-recall-pallet-content-' + randomUUID(), requestId, traceId,
    );

    const aggregateBefore = await readAggregate(fixture.factoryId, fixture.itemId);
    const binsBefore = await readBinTotals(fixture.factoryId, fixture.itemId);
    const casesBefore = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wms_traceability_recall_cases
       WHERE tenant_id=$1 AND factory_id=$2`,
      [tenantId, fixture.factoryId],
    );

    await expect(traceabilityService.declareRecall(
      userId, tenantId, fixture.factoryId, finishedLot.id,
      { reason: 'bounded recall requires complete genealogy', depth: 1, limit: 200 },
      'wms-recall-depth-block-' + randomUUID(), requestId, traceId,
    )).rejects.toThrow(/truncated at the requested depth/i);
    await expect(traceabilityService.declareRecall(
      userId, tenantId, fixture.factoryId, finishedLot.id,
      { reason: 'bounded recall requires all affected units', depth: 12, limit: 1 },
      'wms-recall-node-block-' + randomUUID(), requestId, traceId,
    )).rejects.toThrow(/configured node bound/i);
    const casesAfterRejected = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wms_traceability_recall_cases
       WHERE tenant_id=$1 AND factory_id=$2`,
      [tenantId, fixture.factoryId],
    );
    expect(casesAfterRejected.rows[0]?.count).toBe(casesBefore.rows[0]?.count);
    const statusesAfterRejected = await adminPool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM traceability_units
       WHERE tenant_id=$1 AND factory_id=$2 AND id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [finishedLot.id, cartonId, palletId]],
    );
    expect(statusesAfterRejected.rows).toHaveLength(3);
    expect(statusesAfterRejected.rows.every((row) => row.status === 'ACTIVE')).toBe(true);

    const idempotencyKey = 'wms-recall-declare-' + randomUUID();
    const declared = await traceabilityService.declareRecall(
      userId, tenantId, fixture.factoryId, finishedLot.id,
      { reason: 'Confirmed quality defect in finished-good lot', depth: 12, limit: 200 },
      idempotencyKey, requestId, traceId,
    );
    expect(declared.replayed).toBe(false);
    expect(declared.recall_case).toMatchObject({
      source_unit_id: finishedLot.id,
      reason: 'Confirmed quality defect in finished-good lot',
      impacted_unit_count: 3,
    });
    expect(declared.units.map((row) => row.unit_id)).toEqual(
      expect.arrayContaining([finishedLot.id, cartonId, palletId]),
    );
    expect(declared.units.every((row) => row.unit_action === 'RECALLED')).toBe(true);

    const persistedStatuses = await adminPool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM traceability_units
       WHERE tenant_id=$1 AND factory_id=$2 AND id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [finishedLot.id, cartonId, palletId]],
    );
    expect(persistedStatuses.rows).toHaveLength(3);
    expect(persistedStatuses.rows.every((row) => row.status === 'RECALLED')).toBe(true);

    const statusEventsBeforeReplay = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM traceability_unit_status_events
       WHERE tenant_id=$1 AND factory_id=$2 AND unit_id=ANY($3::uuid[]) AND to_status='RECALLED'`,
      [tenantId, fixture.factoryId, [finishedLot.id, cartonId, palletId]],
    );
    expect(statusEventsBeforeReplay.rows[0]?.count).toBe('3');

    const replay = await traceabilityService.declareRecall(
      userId, tenantId, fixture.factoryId, finishedLot.id,
      { reason: 'Confirmed quality defect in finished-good lot', depth: 12, limit: 200 },
      idempotencyKey, requestId, traceId,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.recall_case.id).toBe(declared.recall_case.id);

    const notificationKey = 'wms-recall-notify-' + randomUUID();
    const notificationIntent = await traceabilityService.createRecallNotificationIntent(
      userId, tenantId, fixture.factoryId, declared.recall_case.id,
      {
        recipient_type: 'CUSTOMER',
        recipient_reference: 'CUSTOMER-' + randomUUID().slice(0, 8),
        channel: 'PORTAL',
        reason: 'Notify customer for recall case',
      },
      notificationKey, requestId, traceId,
    );
    expect(notificationIntent.replayed).toBe(false);
    expect(notificationIntent.dispatch_status).toBe('INTENT_RECORDED_NOT_DELIVERY_CONFIRMED');
    const notificationReplay = await traceabilityService.createRecallNotificationIntent(
      userId, tenantId, fixture.factoryId, declared.recall_case.id,
      {
        recipient_type: 'CUSTOMER',
        recipient_reference: notificationIntent.recipient_reference,
        channel: 'PORTAL',
        reason: 'Notify customer for recall case',
      },
      notificationKey, requestId, traceId,
    );
    expect(notificationReplay.replayed).toBe(true);
    expect(notificationReplay.id).toBe(notificationIntent.id);
    await expect(traceabilityService.createRecallNotificationIntent(
      userId, tenantId, fixture.factoryId, declared.recall_case.id,
      {
        recipient_type: 'CUSTOMER',
        recipient_reference: notificationIntent.recipient_reference,
        channel: 'EMAIL',
        reason: 'Notify customer for recall case',
      },
      notificationKey, requestId, traceId,
    )).rejects.toThrow(/different recall notification request/i);

    const acknowledgementKey = 'wms-recall-ack-' + randomUUID();
    const acknowledgement = await traceabilityService.recordRecallNotificationAcknowledgement(
      userId, tenantId, fixture.factoryId, declared.recall_case.id, notificationIntent.id,
      {
        outcome: 'RECEIVED',
        notes: 'Customer service operator reported receipt',
        evidence_reference: 'TICKET-' + randomUUID().slice(0, 8),
      },
      acknowledgementKey, requestId, traceId,
    );
    expect(acknowledgement.replayed).toBe(false);
    expect(acknowledgement.acknowledgement_source).toBe('OPERATOR_REPORTED');
    expect(acknowledgement.externally_authenticated).toBe(false);
    const acknowledgementReplay = await traceabilityService.recordRecallNotificationAcknowledgement(
      userId, tenantId, fixture.factoryId, declared.recall_case.id, notificationIntent.id,
      {
        outcome: 'RECEIVED',
        notes: 'Customer service operator reported receipt',
        evidence_reference: acknowledgement.evidence_reference,
      },
      acknowledgementKey, requestId, traceId,
    );
    expect(acknowledgementReplay.replayed).toBe(true);
    expect(acknowledgementReplay.id).toBe(acknowledgement.id);
    await expect(traceabilityService.recordRecallNotificationAcknowledgement(
      userId, tenantId, fixture.factoryId, declared.recall_case.id, notificationIntent.id,
      { outcome: 'ACTION_IN_PROGRESS' },
      acknowledgementKey, requestId, traceId,
    )).rejects.toThrow(/different recall acknowledgement/i);

    const notificationList = await traceabilityService.listRecallNotificationIntents(
      userId, tenantId, fixture.factoryId, declared.recall_case.id,
    );
    expect(notificationList.items).toHaveLength(1);
    expect(notificationList.items[0]).toMatchObject({
      id: notificationIntent.id,
      acknowledgement_outcome: 'RECEIVED',
      acknowledgement_source: 'OPERATOR_REPORTED',
      dispatch_status: 'INTENT_RECORDED_NOT_DELIVERY_CONFIRMED',
      acknowledgement_externally_authenticated: false,
    });
    await expect(traceabilityService.listRecallNotificationIntents(
      userId, randomUUID(), fixture.factoryId, declared.recall_case.id,
    )).rejects.toThrow(/not found in this factory/i);

    const statusEventsAfterReplay = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM traceability_unit_status_events
       WHERE tenant_id=$1 AND factory_id=$2 AND unit_id=ANY($3::uuid[]) AND to_status='RECALLED'`,
      [tenantId, fixture.factoryId, [finishedLot.id, cartonId, palletId]],
    );
    expect(statusEventsAfterReplay.rows[0]?.count).toBe('3');
    await expect(traceabilityService.declareRecall(
      userId, tenantId, fixture.factoryId, finishedLot.id,
      { reason: 'Different reason', depth: 12, limit: 200 },
      idempotencyKey, requestId, traceId,
    )).rejects.toThrow(/different recall declaration/i);

    const aggregateAfter = await readAggregate(fixture.factoryId, fixture.itemId);
    const binsAfter = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregateAfter?.quantity_on_hand).toBe(aggregateBefore?.quantity_on_hand);
    expect(binsAfter?.sum).toBe(binsBefore?.sum);

    const foreignTenantId = randomUUID();
    await expect(traceabilityService.declareRecall(
      userId, foreignTenantId, fixture.factoryId, finishedLot.id,
      { reason: 'foreign scope test', depth: 12, limit: 200 },
      'wms-recall-foreign-' + randomUUID(), requestId, traceId,
    )).rejects.toThrow(/not found in this factory/i);
  });

  it('binds shipment to the exact customer order line and records immutable proof-of-delivery events', async () => {
    // Keep one unit outside the shipment so the source lot remains ACTIVE after
    // dispatch and exercises the intended ACTIVE -> RECALLED transition below.
    const fixture = await createStockFixture('3.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    const finishedLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT', product_role: 'FINISHED_GOOD',
        unit_code: 'FG-ORDER-POD-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId, quantity: 3, unit: 'PCS',
        external_reference: 'wms-order-pod-acceptance',
      } as never,
      'fg-order-pod-register-' + randomUUID(), requestId, traceId,
    );
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1,$2,$3,$4,$5,3.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, fixture.defaultLocationId],
    );
    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId, destination_location_id: binA.id,
        quantity: 2, movement_purpose: 'PUT_AWAY', traceability_unit_id: finishedLot.id,
      },
      'fg-order-pod-putaway-' + randomUUID(), requestId, traceId,
    );
    const carton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON', container_code: 'CARTON-ORDER-POD-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId, location_id: binA.id, capacity_quantity: 2,
      },
      'wms-order-pod-carton-create-' + randomUUID(), requestId, traceId,
    );
    const cartonId = carton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 2 },
      'wms-order-pod-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId,
      'wms-order-pod-seal-' + randomUUID(), requestId, traceId,
    );

    const itemResult = await adminPool.query<{ sku: string; name: string; unit: string }>(
      `SELECT sku, name, unit FROM inventory_items
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [fixture.itemId, tenantId, fixture.factoryId],
    );
    const item = itemResult.rows[0];
    expect(item).toBeDefined();
    const createOrderLine = async (quantity: number, reference: string) => {
      const orderNumber = 'SO-WMS-POD-' + randomUUID().slice(0, 8);
      const order = await adminPool.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, factory_id, order_number, customer_name, customer_reference, status, order_date, currency, created_by_user_id)
         VALUES ($1,$2,$3,'Acceptance Customer',$4,'CONFIRMED',CURRENT_DATE,'BDT',$5)
         RETURNING id::text AS id`,
        [tenantId, fixture.factoryId, orderNumber, reference, userId],
      );
      const orderId = order.rows[0]?.id;
      if (!orderId) throw new Error('WMS shipment acceptance order was not created');
      const line = await adminPool.query<{ id: string }>(
        `INSERT INTO order_lines (tenant_id, factory_id, order_id, line_number, product_code, product_name, inventory_item_id, quantity, unit)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7::numeric,$8) RETURNING id::text AS id`,
        [tenantId, fixture.factoryId, orderId, item!.sku, item!.name, fixture.itemId, quantity.toFixed(4), item!.unit],
      );
      const orderLineId = line.rows[0]?.id;
      if (!orderLineId) throw new Error('WMS shipment acceptance order line was not created');
      return { orderId, orderLineId, orderNumber, reference };
    };

    const tooSmallReference = 'CUSTOMER-ORDER-TOO-SMALL-' + randomUUID().slice(0, 8);
    const tooSmallOrder = await createOrderLine(1, tooSmallReference);
    const tooSmallPayload = {
      shipment_code: 'SHIP-ORDER-TOO-SMALL-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer', customer_order_reference: tooSmallReference,
      order_id: tooSmallOrder.orderId, order_line_id: tooSmallOrder.orderLineId,
    };
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId, tooSmallPayload,
      'wms-order-pod-overship-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    const balanceAfterRejectedOrder = await readAggregate(fixture.factoryId, fixture.itemId);
    // Rejected order-line validation must not consume any of the initial three units.
    expect(balanceAfterRejectedOrder?.quantity_on_hand).toBe('3.0000');

    const validReference = 'CUSTOMER-ORDER-VALID-' + randomUUID().slice(0, 8);
    const validOrder = await createOrderLine(2, validReference);
    const invalidCustomerPayload = {
      shipment_code: 'SHIP-ORDER-CUSTOMER-MISMATCH-' + randomUUID().slice(0, 8),
      customer_name: 'Different Customer', customer_order_reference: validReference,
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
    };
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId, invalidCustomerPayload,
      'wms-order-pod-customer-mismatch-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const payload = {
      shipment_code: 'SHIP-ORDER-POD-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer', customer_order_reference: validReference,
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
      carrier_name: 'Acme Logistics',
      tracking_reference: 'ACME-TRACK-' + randomUUID().slice(0, 8),
    };
    const dispatch = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId, payload,
      'wms-order-pod-dispatch-' + randomUUID(), requestId, traceId,
    );
    expect(dispatch).toMatchObject({
      replayed: false,
      shipment: { order_id: validOrder.orderId, order_line_id: validOrder.orderLineId, quantity: '2.0000', status: 'DISPATCHED' },
    });
    const storedOrderBinding = await adminPool.query<{ order_id: string; order_line_id: string; customer_order_reference: string }>(
      `SELECT order_id::text AS order_id, order_line_id::text AS order_line_id, customer_order_reference
       FROM wms_shipments WHERE shipment_unit_id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [dispatch.shipment.shipment_unit_id, tenantId, fixture.factoryId],
    );
    expect(storedOrderBinding.rows[0]).toEqual({
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId, customer_order_reference: validReference,
    });

    // The server assigns event_at once; an identical retry with the timestamp omitted must replay.
    const transitPayload = { event_type: 'IN_TRANSIT' as const, notes: 'Shipment handed to carrier' };
    const transitKey = 'wms-delivery-transit-' + randomUUID();
    const transit = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      transitPayload, transitKey, requestId, traceId,
    );
    expect(transit).toMatchObject({ replayed: false, event: { event_type: 'IN_TRANSIT', source_system: 'MANUAL' } });
    const transitReplay = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      transitPayload, transitKey, requestId, traceId,
    );
    expect(transitReplay).toMatchObject({ replayed: true, event: { id: transit.event.id } });
    expect(transitReplay.event.event_at).toBe(transit.event.event_at);
    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { ...transitPayload, notes: 'Changed payload must not replay' },
      transitKey, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { event_type: 'DELIVERED', event_at: new Date().toISOString() },
      'wms-delivery-no-proof-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(BadRequestException);

    const deliveredAt = new Date().toISOString();
    const signedAt = new Date(Date.now() - 60_000).toISOString();
    const proofPayload = {
      event_type: 'DELIVERED' as const, event_at: deliveredAt,
      recipient_name: 'Acceptance Recipient', proof_type: 'SIGNATURE' as const,
      proof_reference: 'pod/' + tenantId.toLowerCase() + '/' + fixture.factoryId.toLowerCase() + '/' + dispatch.shipment.shipment_unit_id.toLowerCase() + '/' + randomUUID() + '.png',
      proof_sha256: 'a'.repeat(64), signed_at: signedAt, notes: 'POD acceptance evidence',
    };
    const proofKey = 'wms-delivery-proof-' + randomUUID();
    const proof = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      proofPayload, proofKey, requestId, traceId,
    );
    expect(proof).toMatchObject({
      replayed: false,
      event: {
        event_type: 'DELIVERED', recipient_name: 'Acceptance Recipient', proof_type: 'SIGNATURE',
        proof_reference: proofPayload.proof_reference, proof_sha256: 'a'.repeat(64),
      },
    });
    expect(new Date(proof.event.signed_at as string).getTime()).toBe(new Date(signedAt).getTime());
    const proofReplay = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      proofPayload, proofKey, requestId, traceId,
    );
    expect(proofReplay).toMatchObject({ replayed: true, event: { id: proof.event.id } });
    expect(podStorageVerifier.verifyObjectDigest).toHaveBeenCalledWith(proofPayload.proof_reference, proofPayload.proof_sha256);
    expect(podStorageVerifier.verifyObjectDigest).toHaveBeenCalledTimes(1);
    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { event_type: 'IN_TRANSIT', event_at: new Date().toISOString() },
      'wms-delivery-terminal-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const deliveryHistory = await fulfillmentService.listDeliveryEvents(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
    );
    expect(deliveryHistory.events).toHaveLength(2);
    expect(deliveryHistory.events.map((event: { event_type: string }) => event.event_type)).toEqual(['IN_TRANSIT', 'DELIVERED']);
    expect(deliveryHistory.events[1]).toMatchObject({
      proof_reference: proofPayload.proof_reference, proof_sha256: 'a'.repeat(64), recipient_name: 'Acceptance Recipient',
    });
    const shipmentList = await fulfillmentService.listShipments(
      userId, tenantId, fixture.factoryId, { search: validReference },
    );
    expect(shipmentList.shipments[0]).toMatchObject({
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
      latest_delivery_event_type: 'DELIVERED',
      carrier_name: payload.carrier_name,
      tracking_reference: payload.tracking_reference,
    });

    // Cross-feature SRS regression: the same order-bound shipment, persisted POD
    // metadata, recall assessment/declaration and lifecycle-aware label snapshots
    // must agree on the persisted shipment and identity state.
    const labelTemplate = await traceabilityService.createLabelTemplate(
      userId, tenantId, fixture.factoryId,
      {
        template_code: 'WP02-E2E-' + randomUUID().slice(0, 8),
        name: 'WP02 end-to-end lifecycle label',
        symbology: 'QR',
        supported_unit_types: ['LOT', 'SHIPMENT'],
        label_layout: {
          page: { width_mm: 50, height_mm: 30 },
          fields: ['unit_code', 'barcode_value', 'status'],
        },
      } as never,
      requestId, traceId,
    );
    const labelBeforeRecall = await traceabilityService.issueLabel(
      userId, tenantId, fixture.factoryId,
      { unit_id: finishedLot.id, template_id: labelTemplate.id, copy_count: 1 } as never,
      'wp02-e2e-label-before-' + randomUUID(), requestId, traceId,
    );
    expect(labelBeforeRecall.print_contract.identity_payload).toMatchObject({
      unit_id: finishedLot.id,
      status: 'ACTIVE',
    });

    const impact = await traceabilityService.recallImpact(
      userId, tenantId, fixture.factoryId, finishedLot.id, 12, 200,
    );
    expect(impact.affected_shipment_count).toBe(1);
    expect(impact.affected_shipments[0]).toMatchObject({
      shipment_unit_id: dispatch.shipment.shipment_unit_id,
      container_unit_id: cartonId,
      order_id: validOrder.orderId,
      order_line_id: validOrder.orderLineId,
      carrier_name: payload.carrier_name,
      tracking_reference: payload.tracking_reference,
      latest_delivery_event_type: 'DELIVERED',
      pod_reference: proofPayload.proof_reference,
      pod_sha256: 'a'.repeat(64),
    });
    expect(impact).toMatchObject({
      impact_truncated: false,
      provenance_truncated: false,
      side_effects: { stock_changed: false, statuses_changed: false, records_created: false },
    });

    const stockBeforeRecall = await readAggregate(fixture.factoryId, fixture.itemId);
    const binsBeforeRecall = await readBinTotals(fixture.factoryId, fixture.itemId);
    const recallKey = 'wp02-e2e-recall-' + randomUUID();
    const recall = await traceabilityService.declareRecall(
      userId, tenantId, fixture.factoryId, finishedLot.id,
      { reason: 'E2E regression: delivered shipment requires recall review', depth: 12, limit: 200 },
      recallKey, requestId, traceId,
    );
    expect(recall.replayed).toBe(false);
    const recallActions = new Map(recall.units.map((row: { unit_id: string; unit_action: string }) => [row.unit_id, row.unit_action]));
    expect(recallActions.get(finishedLot.id)).toBe('RECALLED');
    expect(recallActions.get(cartonId)).toBe('SHIPPED_REVIEW_REQUIRED');
    expect(recallActions.get(dispatch.shipment.shipment_unit_id)).toBe('SHIPPED_REVIEW_REQUIRED');

    const labelAfterRecall = await traceabilityService.issueLabel(
      userId, tenantId, fixture.factoryId,
      { unit_id: finishedLot.id, template_id: labelTemplate.id, copy_count: 1 } as never,
      'wp02-e2e-label-after-' + randomUUID(), requestId, traceId,
    );
    expect(labelAfterRecall.print_contract.identity_payload).toMatchObject({
      unit_id: finishedLot.id,
      status: 'RECALLED',
    });
    const shippedLabelAfterRecall = await traceabilityService.issueLabel(
      userId, tenantId, fixture.factoryId,
      { unit_id: dispatch.shipment.shipment_unit_id, template_id: labelTemplate.id, copy_count: 1 } as never,
      'wp02-e2e-shipment-label-after-recall-' + randomUUID(), requestId, traceId,
    );
    expect(shippedLabelAfterRecall.print_contract.identity_payload).toMatchObject({
      unit_id: dispatch.shipment.shipment_unit_id,
      status: 'SHIPPED',
    });

    const persistedLifecycle = await adminPool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM traceability_units
       WHERE tenant_id=$1 AND factory_id=$2 AND id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [finishedLot.id, cartonId, dispatch.shipment.shipment_unit_id]],
    );
    expect(persistedLifecycle.rows).toHaveLength(3);
    expect(persistedLifecycle.rows.find((row) => row.id === finishedLot.id)?.status).toBe('RECALLED');
    expect(persistedLifecycle.rows.find((row) => row.id === cartonId)?.status).toBe('SHIPPED');
    expect(persistedLifecycle.rows.find((row) => row.id === dispatch.shipment.shipment_unit_id)?.status).toBe('SHIPPED');
    const stockAfterRecall = await readAggregate(fixture.factoryId, fixture.itemId);
    const binsAfterRecall = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(stockAfterRecall?.quantity_on_hand).toBe(stockBeforeRecall?.quantity_on_hand);
    expect(binsAfterRecall?.sum).toBe(binsBeforeRecall?.sum);

    const foreignTenantId = randomUUID();
    await expect(fulfillmentService.listDeliveryEvents(
      userId, foreignTenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
    )).rejects.toThrow(/not found in this factory/i);
  });

  it('runs GRN-to-work-order output through put-away, shipment POD, recall and reverse genealogy', async () => {
    // The journey begins with no finished goods. The lot shipped below is
    // created only by the approved BOM/routing work-order output transaction.
    const fixture = await createStockFixture('0.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
    const audit = { record: async () => randomUUID() } as unknown as AuditService;
    const procurementService = new ProcurementService(database);
    const goodsReceiptService = new GoodsReceiptService(database);
    const productDefinitionsService = new ProductDefinitionsService(database, audit);
    const workOrdersService = new ProductionWorkOrdersService(database, audit, reservationService);
    const ordersService = new OrdersService(
      database, audit, new OrderIdempotencyService(database), reservationService,
    );
    const qualityService = new QualityService(database);

    const approverId = randomUUID();
    extraUserIds.push(approverId);
    await adminPool.query(
      `INSERT INTO users (id, external_subject, email, display_name, status)
       VALUES ($1, $2, $3, 'Factory E2E acceptance approver', 'ACTIVE')`,
      [approverId, 'factory-e2e-approver-' + approverId, 'factory-e2e-approver-' + approverId + '@factoryos.test'],
    );

    const materialItemResult = await adminPool.query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, factory_id, sku, name, unit, created_by_user_id)
       VALUES ($1,$2,$3,'E2E raw material','PCS',$4) RETURNING id::text AS id`,
      [tenantId, fixture.factoryId, 'RAW-E2E-' + suffix, userId],
    );
    const materialItemId = materialItemResult.rows[0]?.id;
    if (!materialItemId) throw new Error('Factory E2E raw material fixture was not created');
    await adminPool.query(
      `INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand)
       VALUES ($1,$2,$3,0.0000)`,
      [tenantId, fixture.factoryId, materialItemId],
    );

    const supplier = await procurementService.createSupplier(
      userId, tenantId,
      { code: 'SUP-E2E-' + suffix, name: 'Factory E2E Raw Material Supplier' } as never,
      requestId, traceId,
    );
    const po = await procurementService.createPurchaseOrder(
      userId, tenantId, fixture.factoryId,
      {
        supplier_id: supplier.id, po_number: 'PO-E2E-' + suffix,
        lines: [{
          line_number: 1, inventory_item_id: materialItemId,
          description: 'E2E material for approved work order',
          quantity: 3, unit: 'PCS', unit_price: 1,
        }],
      } as never,
      'factory-e2e-po-' + suffix, requestId, traceId,
    );
    const poLineId = (po.lines as Array<{ id: string }>)[0]?.id;
    if (!poLineId) throw new Error('Factory E2E purchase-order line was not created');
    const submittedPo = await procurementService.transitionPurchaseOrder(
      userId, tenantId, fixture.factoryId, po.id, 'SUBMITTED',
      Number(po.version), 'Submit the E2E material order', requestId, traceId,
    );
    const approvedPo = await procurementService.transitionPurchaseOrder(
      approverId, tenantId, fixture.factoryId, po.id, 'APPROVED',
      Number(submittedPo.version), 'Approve the E2E material order', requestId, traceId,
    );
    expect(approvedPo.status).toBe('APPROVED');
    const receipt = await goodsReceiptService.postGoodsReceipt(
      userId, tenantId, fixture.factoryId, po.id,
      {
        location_id: binA.id,
        supplier_delivery_reference: 'SUP-DELIVERY-E2E-' + suffix,
        notes: 'Factory E2E acceptance receipt',
        lines: [{ purchase_order_line_id: poLineId, received_quantity: 3, rejected_quantity: 0 }],
      } as never,
      'factory-e2e-grn-' + suffix, requestId, traceId,
    );
    expect(receipt.status).toBe('POSTED');
    expect(receipt.lines[0]?.accepted_quantity).toBe('3.0000');
    const materialLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT', product_role: 'MATERIAL',
        unit_code: 'MAT-E2E-' + suffix, inventory_item_id: materialItemId,
        goods_receipt_line_id: receipt.lines[0].id,
        quantity: 3, unit: 'PCS', external_reference: 'factory-e2e-grn-' + receipt.id,
      } as never,
      'factory-e2e-material-lot-' + suffix, requestId, traceId,
    );
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1,$2,$3,$4,$5,3.0000)`,
      [tenantId, fixture.factoryId, materialItemId, materialLot.id, binA.id],
    );

    // Assert the traceability identity is linked to the exact accepted supplier/GRN
    // line, rather than deriving provenance from a free-form external reference.
    const materialLotProvenance = await adminPool.query<{
      supplier_id: string; goods_receipt_id: string; goods_receipt_line_id: string;
      receipt_status: string; accepted_quantity: string;
    }>(`
      SELECT po.supplier_id::text AS supplier_id,
        gr.id::text AS goods_receipt_id, grl.id::text AS goods_receipt_line_id,
        gr.status AS receipt_status, grl.accepted_quantity::text AS accepted_quantity
      FROM traceability_units tu
      JOIN goods_receipt_lines grl
        ON grl.id=tu.goods_receipt_line_id AND grl.tenant_id=tu.tenant_id AND grl.factory_id=tu.factory_id
      JOIN goods_receipts gr
        ON gr.id=tu.goods_receipt_id AND gr.id=grl.goods_receipt_id
          AND gr.tenant_id=tu.tenant_id AND gr.factory_id=tu.factory_id
      JOIN purchase_orders po
        ON po.id=gr.purchase_order_id AND po.tenant_id=gr.tenant_id AND po.factory_id=gr.factory_id
      WHERE tu.id=$1 AND tu.tenant_id=$2 AND tu.factory_id=$3
        AND tu.inventory_item_id=$4
    `, [materialLot.id, tenantId, fixture.factoryId, materialItemId]);
    expect(materialLotProvenance.rows).toEqual([{
      supplier_id: supplier.id,
      goods_receipt_id: receipt.id,
      goods_receipt_line_id: receipt.lines[0].id,
      receipt_status: 'POSTED',
      accepted_quantity: '3.0000',
    }]);

    // Preserve PR #244's distinct incoming-quality gate inside this same
    // persisted journey: supplier HOLD must block BOM reservation/release until
    // an explicit quality disposition releases the accepted GRN line.
    const incomingQualityContext = {
      userId, tenantId, factoryId: fixture.factoryId, requestId, traceId,
    };
    const incomingInspection = await qualityService.createInspection(
      incomingQualityContext,
      {
        inspection_type: 'SUPPLIER',
        target_type: 'GOODS_RECEIPT_LINE',
        target_id: receipt.lines[0].id,
        sample_quantity: 1,
        notes: 'Incoming supplier quality gate in the consolidated factory journey',
      } as never,
      'factory-e2e-incoming-inspection-' + suffix,
    );
    const heldIncomingInspection = await qualityService.decideInspection(
      incomingQualityContext, incomingInspection.id,
      {
        expected_version: Number(incomingInspection.row_version),
        action: 'HOLD',
        reason: 'Block material allocation pending incoming inspection disposition',
      } as never,
      'factory-e2e-incoming-inspection-hold-' + suffix,
    );
    expect(heldIncomingInspection.status).toBe('ON_HOLD');

    const finishedItemResult = await adminPool.query<{ sku: string; name: string; unit: string }>(
      `SELECT sku, name, unit FROM inventory_items WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [fixture.itemId, tenantId, fixture.factoryId],
    );
    const finishedItem = finishedItemResult.rows[0];
    if (!finishedItem) throw new Error('Factory E2E finished-good inventory item was not created');
    const productEnvelope = await productDefinitionsService.createProduct(
      userId, tenantId, fixture.factoryId,
      {
        inventory_item_id: fixture.itemId, product_code: finishedItem.sku,
        product_name: 'Factory E2E Finished Good', product_type: 'STANDARD', base_unit: 'PCS',
      } as never,
      'factory-e2e-product-' + suffix, requestId, traceId,
    );
    const productId = productEnvelope.product.id as string;
    const plannedStart = new Date().toISOString().slice(0, 10);
    const versionEnvelope = await productDefinitionsService.createVersion(
      userId, tenantId, fixture.factoryId, productId,
      { effective_from: plannedStart, expected_yield_percent: 100, change_summary: 'Factory E2E approved manufacturing baseline' } as never,
      'factory-e2e-product-version-' + suffix, requestId, traceId,
    );
    const workCentreEnvelope = await productDefinitionsService.createWorkCentre(
      userId, tenantId, fixture.factoryId,
      { code: 'WC-E2E-' + suffix, name: 'E2E assembly work centre', capacity_units_per_hour: 100 } as never,
      'factory-e2e-work-centre-' + suffix, requestId, traceId,
    );
    const bom = await productDefinitionsService.replaceBom(
      userId, tenantId, fixture.factoryId, productId, versionEnvelope.version.id,
      {
        expected_version: Number(versionEnvelope.version.row_version),
        lines: [{ line_number: 1, component_item_id: materialItemId, quantity_per: 1, unit: 'PCS', wastage_percent: 0 }],
      } as never, requestId, traceId,
    );
    const route = await productDefinitionsService.replaceRouting(
      userId, tenantId, fixture.factoryId, productId, versionEnvelope.version.id,
      {
        expected_version: Number(bom.row_version),
        steps: [{
          step_number: 1, operation_code: 'ASSEMBLY', operation_name: 'E2E assembly',
          work_centre_id: workCentreEnvelope.work_centre.id,
          setup_minutes: 1, run_minutes_per_unit: 1, queue_minutes: 0, transfer_minutes: 0,
          is_quality_gate: false,
        }],
      } as never, requestId, traceId,
    );
    const approvedVersion = await productDefinitionsService.approveVersion(
      approverId, tenantId, fixture.factoryId, productId, versionEnvelope.version.id,
      { expected_version: Number(route.row_version) } as never,
      'factory-e2e-approve-version-' + suffix, requestId, traceId,
    );
    expect(approvedVersion.version.state).toBe('APPROVED');

    const salesOrderReference = 'SO-E2E-' + suffix;
    const sourceOrder = await ordersService.createOrder(
      userId, tenantId,
      {
        factory_id: fixture.factoryId,
        order_number: salesOrderReference,
        customer_name: 'Factory E2E Production Customer',
        customer_reference: salesOrderReference,
        currency: 'BDT',
        lines: [{
          line_number: 1,
          product_code: finishedItem.sku,
          product_name: 'Factory E2E Finished Good',
          quantity: 3,
          unit: 'PCS',
          inventory_item_id: fixture.itemId,
          unit_price: 0,
        }],
      } as never,
      randomUUID(), traceId, 'factory-e2e-order-' + suffix,
    );
    const sourceOrderId = sourceOrder.id as string;
    if (!sourceOrderId) throw new Error('Factory E2E production order was not created');
    const sourceLineResult = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM order_lines WHERE tenant_id=$1 AND factory_id=$2 AND order_id=$3',
      [tenantId, fixture.factoryId, sourceOrderId],
    );
    const sourceOrderLineId = sourceLineResult.rows[0]?.id;
    if (!sourceOrderLineId) throw new Error('Factory E2E production order line was not created');
    const draftWorkOrder = await workOrdersService.createWorkOrder(
      userId, tenantId, fixture.factoryId,
      { order_line_id: sourceOrderLineId, target_quantity: 3, planned_start_date: plannedStart } as never,
      'factory-e2e-create-work-order-' + suffix, requestId, traceId,
    );

    // A production-managed order line must pass confirmation with zero finished-good
    // stock and no ORDER_LINE reservation. The BOM work-order reservation is the
    // sole material-allocation boundary for this make-to-order journey.
    const confirmedOrder = await ordersService.transitionOrderStatus(
      userId, tenantId, sourceOrderId, 'CONFIRMED', randomUUID(), traceId,
      1,
    );
    expect(confirmedOrder.status).toBe('CONFIRMED');
    const makeToOrderGuard = await adminPool.query<{
      status: string; finished_stock: string; reserved: string; reservation_count: string;
    }>(`
      SELECT o.status, b.quantity_on_hand::text AS finished_stock,
        b.quantity_reserved::text AS reserved,
        (SELECT count(*)::text FROM inventory_reservations r
          WHERE r.tenant_id=ol.tenant_id AND r.factory_id=ol.factory_id
            AND r.reference_type='ORDER_LINE' AND r.reference_id=ol.id) AS reservation_count
      FROM orders o
      JOIN order_lines ol ON ol.order_id=o.id AND ol.tenant_id=o.tenant_id AND ol.factory_id=o.factory_id
      JOIN inventory_stock_balances b ON b.item_id=ol.inventory_item_id
        AND b.tenant_id=ol.tenant_id AND b.factory_id=ol.factory_id
      WHERE o.id=$1 AND o.tenant_id=$2 AND o.factory_id=$3
    `, [sourceOrderId, tenantId, fixture.factoryId]);
    expect(makeToOrderGuard.rows[0]).toEqual({
      status: 'CONFIRMED', finished_stock: '0.0000', reserved: '0.0000', reservation_count: '0',
    });
    const inProgressOrder = await ordersService.transitionOrderStatus(
      userId, tenantId, sourceOrderId, 'IN_PROGRESS', randomUUID(), traceId,
      Number(confirmedOrder.version),
    );
    expect(inProgressOrder.status).toBe('IN_PROGRESS');

    await expect(workOrdersService.transitionWorkOrder(
      userId, tenantId, fixture.factoryId, draftWorkOrder.id, 'RELEASE',
      { expected_version: Number(draftWorkOrder.row_version) } as never,
      'factory-e2e-release-held-material-' + suffix, requestId, traceId,
    )).rejects.toThrow(/Insufficient eligible FIFO lot\/serial stock.*held, damaged, quarantined.*excluded/i);
    const blockedIncomingRelease = await adminPool.query<{ active_hold_count: number }>(
      `SELECT count(*)::int AS active_hold_count FROM quality_holds
       WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id=$3 AND status='ACTIVE'`,
      [tenantId, fixture.factoryId, incomingInspection.id],
    );
    expect(blockedIncomingRelease.rows[0]?.active_hold_count).toBe(1);

    const inspectionBeforeIncomingRelease = await qualityService.getInspection(
      incomingQualityContext, incomingInspection.id,
    );
    expect(inspectionBeforeIncomingRelease.status).toBe('ON_HOLD');
    const releasedIncomingInspection = await qualityService.disposeInspection(
      incomingQualityContext,
      incomingInspection.id,
      {
        expected_version: Number(inspectionBeforeIncomingRelease.row_version),
        action: 'RELEASE',
        reason: 'Incoming quality review accepted the supplier material',
      } as never,
      'factory-e2e-incoming-inspection-release-' + suffix,
    );
    expect(releasedIncomingInspection.disposition.action).toBe('RELEASE');
    const releasedIncomingHold = await adminPool.query<{
      active_hold_count: number; released_hold_count: number;
    }>(
      `SELECT count(*) FILTER (WHERE status='ACTIVE')::int AS active_hold_count,
         count(*) FILTER (WHERE status='RELEASED')::int AS released_hold_count
       FROM quality_holds WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id=$3`,
      [tenantId, fixture.factoryId, incomingInspection.id],
    );
    expect(releasedIncomingHold.rows[0]).toEqual({ active_hold_count: 0, released_hold_count: 1 });

    let workOrder = await workOrdersService.transitionWorkOrder(
      userId, tenantId, fixture.factoryId, draftWorkOrder.id, 'RELEASE',
      { expected_version: Number(draftWorkOrder.row_version) } as never,
      'factory-e2e-release-work-order-' + suffix, requestId, traceId,
    );
    expect(workOrder.status).toBe('RELEASED');
    const initialOperation = workOrder.operations[0] as { id: string; row_version: number };
    if (!initialOperation?.id) throw new Error('Factory E2E work order has no routing operation');
    workOrder = await workOrdersService.reportOperationEvent(
      userId, tenantId, fixture.factoryId, workOrder.id, initialOperation.id,
      {
        command: 'START', expected_work_order_version: Number(workOrder.row_version),
        expected_operation_version: Number(initialOperation.row_version),
      } as never,
      'factory-e2e-start-operation-' + suffix, requestId, traceId,
    );
    const activeOperation = workOrder.operations[0] as { id: string; row_version: number };
    // A sales order cannot be completed before its production output is accepted.
    await expect(ordersService.transitionOrderStatus(
      userId, tenantId, sourceOrderId, 'COMPLETED', randomUUID(), traceId,
      Number(inProgressOrder.version),
    )).rejects.toBeInstanceOf(ConflictException);

    const outputKey = 'factory-e2e-output-' + suffix;
    const outputInput = {
      operation_id: activeOperation.id,
      expected_work_order_version: Number(workOrder.row_version),
      expected_operation_version: Number(activeOperation.row_version),
      good_quantity: 3,
      scrap_quantity: 0,
      notes: 'Factory E2E finished-good output',
    };
    const output = await workOrdersService.reportOutput(
      userId, tenantId, fixture.factoryId, workOrder.id,
      outputInput as never, outputKey, requestId, traceId,
    );
    const replayedOutput = await workOrdersService.reportOutput(
      userId, tenantId, fixture.factoryId, workOrder.id,
      outputInput as never, outputKey, randomUUID(), traceId,
    );
    expect(replayedOutput.replayed).toBe(true);
    expect(replayedOutput.production_report_id).toBe(output.production_report_id);
    expect(replayedOutput.production_output_posting_id).toBe(output.production_output_posting_id);
    await expect(workOrdersService.reportOutput(
      userId, tenantId, fixture.factoryId, workOrder.id,
      { ...outputInput, good_quantity: 2, scrap_quantity: 1, scrap_reason: 'changed replay payload', notes: 'changed replay payload' } as never,
      outputKey, randomUUID(), traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    // Changed-payload reuse of the same idempotency key must surface as a conflict;
    // neither the original production report nor its posting may be duplicated.
    const changedReplayCounts = await adminPool.query<{ report_count: number; posting_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM order_production_reports
          WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id=$3) AS report_count,
         (SELECT count(*)::int FROM production_output_postings
          WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id=$3) AS posting_count`,
      [tenantId, fixture.factoryId, workOrder.id],
    );
    expect(changedReplayCounts.rows[0]).toEqual({ report_count: 1, posting_count: 1 });
    expect(output.finished_good_traceability_unit_id).toEqual(expect.any(String));
    const outputOperation = output.operations[0] as { id: string; row_version: number };
    workOrder = await workOrdersService.reportOperationEvent(
      userId, tenantId, fixture.factoryId, workOrder.id, outputOperation.id,
      {
        command: 'COMPLETE', expected_work_order_version: Number(output.row_version),
        expected_operation_version: Number(outputOperation.row_version),
      } as never,
      'factory-e2e-complete-operation-' + suffix, requestId, traceId,
    );
    workOrder = await workOrdersService.transitionWorkOrder(
      userId, tenantId, fixture.factoryId, workOrder.id, 'COMPLETE',
      { expected_version: Number(workOrder.row_version) } as never,
      'factory-e2e-complete-work-order-' + suffix, requestId, traceId,
    );
    expect(workOrder.status).toBe('COMPLETED');
    const consumedMaterials = await adminPool.query<{ status: string; quantity: string }>(
      `SELECT ir.status, ir.quantity::text AS quantity
       FROM work_order_material_reservations mr
       JOIN inventory_reservations ir ON ir.id=mr.reservation_id AND ir.tenant_id=mr.tenant_id AND ir.factory_id=mr.factory_id
       WHERE mr.tenant_id=$1 AND mr.factory_id=$2 AND mr.work_order_id=$3`,
      [tenantId, fixture.factoryId, workOrder.id],
    );
    expect(consumedMaterials.rows).toHaveLength(1);
    expect(consumedMaterials.rows[0]).toMatchObject({ status: 'CONSUMED', quantity: '3.0000' });

    const persistedProductionState = await adminPool.query<{
      material_on_hand: string; material_reserved: string;
      finished_on_hand: string; finished_reserved: string;
      output_count: string; output_quantity: string;
      consumption_count: string; consumed_quantity: string;
      genealogy_count: string; genealogy_quantity: string;
    }>(`
      SELECT material_balance.quantity_on_hand::text AS material_on_hand,
        material_balance.quantity_reserved::text AS material_reserved,
        finished_balance.quantity_on_hand::text AS finished_on_hand,
        finished_balance.quantity_reserved::text AS finished_reserved,
        (SELECT count(*)::text FROM production_output_postings p
          WHERE p.work_order_id=wo.id AND p.tenant_id=wo.tenant_id AND p.factory_id=wo.factory_id) AS output_count,
        (SELECT COALESCE(sum(p.good_quantity),0)::text FROM production_output_postings p
          WHERE p.work_order_id=wo.id AND p.tenant_id=wo.tenant_id AND p.factory_id=wo.factory_id) AS output_quantity,
        (SELECT count(*)::text FROM inventory_reservation_consumptions c
          JOIN work_order_material_reservations mr ON mr.reservation_id=c.reservation_id
            AND mr.tenant_id=c.tenant_id AND mr.factory_id=c.factory_id
          WHERE mr.work_order_id=wo.id AND c.item_id=$4
            AND c.tenant_id=wo.tenant_id AND c.factory_id=wo.factory_id) AS consumption_count,
        (SELECT COALESCE(sum(c.quantity),0)::text FROM inventory_reservation_consumptions c
          JOIN work_order_material_reservations mr ON mr.reservation_id=c.reservation_id
            AND mr.tenant_id=c.tenant_id AND mr.factory_id=c.factory_id
          WHERE mr.work_order_id=wo.id AND c.item_id=$4
            AND c.tenant_id=wo.tenant_id AND c.factory_id=wo.factory_id) AS consumed_quantity,
        (SELECT count(*)::text FROM product_genealogy_events g
          WHERE g.source_unit_id=$5 AND g.target_unit_id=$6
            AND g.tenant_id=wo.tenant_id AND g.factory_id=wo.factory_id
            AND g.relationship_type='CONSUMED_INTO') AS genealogy_count,
        (SELECT COALESCE(sum(g.quantity),0)::text FROM product_genealogy_events g
          WHERE g.source_unit_id=$5 AND g.target_unit_id=$6
            AND g.tenant_id=wo.tenant_id AND g.factory_id=wo.factory_id
            AND g.relationship_type='CONSUMED_INTO') AS genealogy_quantity
      FROM work_orders wo
      JOIN inventory_stock_balances material_balance
        ON material_balance.item_id=$4 AND material_balance.tenant_id=wo.tenant_id AND material_balance.factory_id=wo.factory_id
      JOIN inventory_stock_balances finished_balance
        ON finished_balance.item_id=wo.finished_item_id AND finished_balance.tenant_id=wo.tenant_id AND finished_balance.factory_id=wo.factory_id
      WHERE wo.id=$1 AND wo.tenant_id=$2 AND wo.factory_id=$3
    `, [workOrder.id, tenantId, fixture.factoryId, materialItemId, materialLot.id, output.finished_good_traceability_unit_id]);
    expect(persistedProductionState.rows).toEqual([{
      material_on_hand: '0.0000', material_reserved: '0.0000',
      finished_on_hand: '3.0000', finished_reserved: '0.0000',
      output_count: '1', output_quantity: '3.0000',
      consumption_count: '1', consumed_quantity: '3.0000',
      genealogy_count: '1', genealogy_quantity: '3.0000',
    }]);

    let finishedLot = await traceabilityService.getUnit(
      userId, tenantId, fixture.factoryId, output.finished_good_traceability_unit_id,
    );
    const reverseTrace = await traceabilityService.trace(
      userId, tenantId, fixture.factoryId, finishedLot.id, 'REVERSE', 12, 200,
    );
    expect(reverseTrace.units.some((unit: { id: string }) => unit.id === materialLot.id)).toBe(true);
    expect(reverseTrace.relationships.some((edge: { source_unit_id: string; target_unit_id: string }) =>
      edge.source_unit_id === materialLot.id && edge.target_unit_id === finishedLot.id)).toBe(true);
    const forwardTrace = await traceabilityService.trace(
      userId, tenantId, fixture.factoryId, materialLot.id, 'FORWARD', 12, 200,
    );
    expect(forwardTrace.units.some((unit: { id: string }) => unit.id === finishedLot.id)).toBe(true);

    // The produced lot enters a persisted quality hold. Rework consumes the
    // quarantined source quantity, records explicit recovered + scrap amounts,
    // and releases only a separately identified lot after independent inspection.
    const quarantinedSourceUnitId = finishedLot.id;
    const qualityContext = {
      userId, tenantId, factoryId: fixture.factoryId, requestId, traceId,
    };
    const qualityVerifierContext = {
      userId: approverId, tenantId, factoryId: fixture.factoryId, requestId, traceId,
    };
    const sourceInspection = await qualityService.createInspection(
      qualityContext,
      {
        inspection_type: 'INVENTORY',
        target_type: 'TRACEABILITY_UNIT',
        target_id: finishedLot.id,
        sample_quantity: 3,
        notes: 'Factory E2E final visual and dimensional inspection',
      } as never,
      'factory-e2e-quality-inspection-' + suffix,
    );
    let heldInspection = await qualityService.decideInspection(
      qualityContext, sourceInspection.id,
      { expected_version: Number(sourceInspection.row_version), action: 'START' } as never,
      'factory-e2e-quality-start-' + suffix,
    );
    const sourceDefect = await qualityService.recordDefect(
      qualityContext, sourceInspection.id,
      {
        defect_code: 'E2E-SURFACE-DEFECT',
        severity: 'MAJOR',
        affected_quantity: 3,
        description: 'Acceptance fixture: surface defect requiring controlled rework',
        evidence: { fixture: 'factory-e2e', inspection: 'final-visual' },
      } as never,
      'factory-e2e-quality-defect-' + suffix,
    );
    heldInspection = await qualityService.decideInspection(
      qualityContext, sourceInspection.id,
      {
        expected_version: Number(heldInspection.row_version),
        action: 'HOLD',
        reason: 'Quarantine lot while disposition is decided',
      } as never,
      'factory-e2e-quality-hold-' + suffix,
    );
    expect(heldInspection.status).toBe('ON_HOLD');
    expect(heldInspection.holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'ACTIVE', traceability_unit_id: finishedLot.id }),
    ]));

    const qualityDisposition = await qualityService.disposeInspection(
      qualityContext, sourceInspection.id,
      {
        expected_version: Number(heldInspection.row_version),
        action: 'REWORK',
        reason: 'Recover conforming quantity; record actual scrap separately',
      } as never,
      'factory-e2e-quality-disposition-rework-' + suffix,
    );
    expect(qualityDisposition.disposition).toMatchObject({
      action: 'REWORK',
      status: 'RECORDED',
    });

    let reworkOrder = await qualityService.createReworkOrder(
      qualityContext, sourceDefect.id,
      {
        input_quantity: 3,
        source_traceability_unit_id: finishedLot.id,
        reason: 'Rework quarantined finished-good lot under approved disposition',
        instructions: 'Recover 2.0000 PCS and record 1.0000 PCS as scrap',
        evidence: { route: 'factory-e2e', work_order_id: workOrder.id },
      } as never,
      'factory-e2e-quality-rework-create-' + suffix,
    );
    reworkOrder = await qualityService.transitionReworkOrder(
      qualityContext, reworkOrder.id,
      {
        expected_version: Number(reworkOrder.row_version), action: 'APPROVE',
        reason: 'Quality owner approves controlled rework',
        evidence: { approval: 'E2E quality approver' },
      } as never,
      'factory-e2e-quality-rework-approve-' + suffix,
    );
    reworkOrder = await qualityService.transitionReworkOrder(
      qualityContext, reworkOrder.id,
      {
        expected_version: Number(reworkOrder.row_version), action: 'START',
        reason: 'Begin rework and consume the quarantined source quantity',
        evidence: { source_unit_id: finishedLot.id },
      } as never,
      'factory-e2e-quality-rework-start-' + suffix,
    );

    const recoveredUnit = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT',
        product_role: 'FINISHED_GOOD',
        unit_code: 'FG-E2E-REWORK-' + suffix,
        inventory_item_id: fixture.itemId,
        quantity: 2,
        unit: 'PCS',
        external_reference: 'factory-e2e-quality-rework-' + reworkOrder.id,
      } as never,
      'factory-e2e-quality-rework-output-' + suffix, requestId, traceId,
    );
    const followUpInspection = await qualityService.createInspection(
      qualityContext,
      {
        inspection_type: 'INVENTORY',
        target_type: 'TRACEABILITY_UNIT',
        target_id: recoveredUnit.id,
        sample_quantity: 2,
        notes: 'Independent follow-up inspection for recovered rework output',
      } as never,
      'factory-e2e-quality-followup-' + suffix,
    );

    // An invalid recovered/scrap split must not complete the order or post output.
    await expect(qualityService.transitionReworkOrder(
      qualityContext, reworkOrder.id,
      {
        expected_version: Number(reworkOrder.row_version), action: 'COMPLETE',
        reason: 'Injected invalid completion split',
        recovered_quantity: 2, scrap_quantity: 0,
        output_traceability_unit_id: recoveredUnit.id,
        follow_up_inspection_id: followUpInspection.id,
        evidence: { attempt: 'rollback-guard' },
      } as never,
      'factory-e2e-quality-rework-invalid-complete-' + suffix,
    )).rejects.toThrow(/Recovered plus scrap quantity must exactly equal rework input quantity/i);
    const unchangedRework = await qualityService.getReworkOrder(qualityContext, reworkOrder.id);
    expect(unchangedRework).toMatchObject({ status: 'IN_PROGRESS', row_version: Number(reworkOrder.row_version) });
    const noPrematureOutput = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id=$3",
      [tenantId, fixture.factoryId, reworkOrder.id],
    );
    expect(noPrematureOutput.rows[0]?.count).toBe(0);

    reworkOrder = await qualityService.transitionReworkOrder(
      qualityContext, reworkOrder.id,
      {
        expected_version: Number(reworkOrder.row_version), action: 'COMPLETE',
        reason: 'Record measured recovered and scrap quantities',
        recovered_quantity: 2, scrap_quantity: 1,
        output_traceability_unit_id: recoveredUnit.id,
        follow_up_inspection_id: followUpInspection.id,
        evidence: { recovered_quantity: '2.0000', scrap_quantity: '1.0000', scale_record: 'E2E-QA-01' },
      } as never,
      'factory-e2e-quality-rework-complete-' + suffix,
    );
    // A quarantined source and ACTIVE recovered lot alone must not authorize
    // a REWORKED_INTO edge; it stays blocked until the specific rework is VERIFIED
    // by another actor and the follow-up inspection is PASSED.
    await expect(traceabilityService.recordGenealogyEvent(
      userId, tenantId, fixture.factoryId,
      {
        source_unit_id: quarantinedSourceUnitId,
        target_unit_id: recoveredUnit.id,
        relationship_type: 'REWORKED_INTO',
        quantity: 2,
        notes: 'Negative acceptance: rework is completed but not yet verified',
        evidence: { rework_order_id: reworkOrder.id },
      } as never,
      'factory-e2e-rework-genealogy-premature-' + suffix, requestId, traceId,
    )).rejects.toThrow(/REWORKED_INTO requires matching VERIFIED rework and passed follow-up inspection/i);

    let followUp = await qualityService.decideInspection(
      qualityContext, followUpInspection.id,
      { expected_version: Number(followUpInspection.row_version), action: 'START' } as never,
      'factory-e2e-quality-followup-start-' + suffix,
    );
    followUp = await qualityService.decideInspection(
      qualityContext, followUpInspection.id,
      {
        expected_version: Number(followUp.row_version), action: 'PASS',
        reason: 'Independent inspection accepted the recovered output',
      } as never,
      'factory-e2e-quality-followup-pass-' + suffix,
    );
    expect(followUp.status).toBe('PASSED');

    const verificationPayload = {
      expected_version: Number(reworkOrder.row_version),
      action: 'VERIFY',
      reason: 'Independent QA verifies recovered output and scrap accounting',
      evidence: { verification_sheet: 'FACTORY-E2E-QA-01', verifier: 'independent-approver' },
    };

    // Inject a database failure at the final genealogy outbox write, after
    // output stock, movement, lot balance, quality evidence, genealogy edge and
    // genealogy audit have all been attempted in this same transaction. The
    // snapshot below must prove that every write is rolled back together.
    const beforeInjectedFailure = await adminPool.query<{
      rework_event_count: number;
      rework_outbox_count: number;
      rework_audit_count: number;
      item_stock_quantity: string;
      item_stock_version: number;
      recovered_traceability_quantity: string;
      rework_output_movement_count: number;
      rework_inventory_outbox_count: number;
      rework_genealogy_count: number;
      rework_genealogy_audit_count: number;
      rework_genealogy_outbox_count: number;
      defect_status: string;
      defect_version: number;
      rework_defect_event_count: number;
      rework_defect_audit_count: number;
      rework_defect_outbox_count: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM quality_rework_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND rework_order_id::text=$3::text) AS rework_event_count,
        (SELECT count(*)::int FROM outbox_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND aggregate_type='QUALITY_REWORK'
            AND aggregate_id::text=$3::text AND event_type='QUALITY.REWORK_CHANGED') AS rework_outbox_count,
        (SELECT count(*)::int FROM quality_audit_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND action_type='QUALITY_REWORK_EVENT'
            AND payload->>'rework_order_id'=$3::text) AS rework_audit_count,
        (SELECT quantity_on_hand::text FROM inventory_stock_balances
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND item_id::text=$4::text) AS item_stock_quantity,
        (SELECT version::int FROM inventory_stock_balances
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND item_id::text=$4::text) AS item_stock_version,
        (SELECT COALESCE(sum(quantity_on_hand),0)::numeric(18,4)::text
          FROM inventory_traceability_location_balances
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND item_id::text=$4::text AND traceability_unit_id::text=$6::text) AS recovered_traceability_quantity,
        (SELECT count(*)::int FROM inventory_movements
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id::text=$3::text) AS rework_output_movement_count,
        (SELECT count(*)::int FROM outbox_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND event_type='INVENTORY.STOCK_RECEIVED'
            AND payload->>'quality_rework_order_id'=$3::text) AS rework_inventory_outbox_count,
        (SELECT count(*)::int FROM product_genealogy_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND source_unit_id::text=$5::text AND target_unit_id::text=$6::text
            AND relationship_type='REWORKED_INTO'
            AND idempotency_key='quality-rework-genealogy:' || $3::text) AS rework_genealogy_count,
        (SELECT count(*)::int FROM audit_events a
          JOIN product_genealogy_events e ON e.tenant_id=a.tenant_id AND e.factory_id=a.factory_id
            AND a.resource_type='PRODUCT_GENEALOGY_EVENT' AND a.resource_id=e.id AND a.action='RECORDED'
          WHERE e.tenant_id::text=$1::text AND e.factory_id::text=$2::text
            AND e.source_unit_id::text=$5::text AND e.target_unit_id::text=$6::text
            AND e.relationship_type='REWORKED_INTO'
            AND e.idempotency_key='quality-rework-genealogy:' || $3::text) AS rework_genealogy_audit_count,
        (SELECT count(*)::int FROM outbox_events o
          JOIN product_genealogy_events e ON e.tenant_id=o.tenant_id AND e.factory_id=o.factory_id
            AND o.aggregate_type='PRODUCT_GENEALOGY_EVENT' AND o.aggregate_id=e.id
            AND o.event_type='TRACEABILITY.GENEALOGY_RECORDED'
          WHERE e.tenant_id::text=$1::text AND e.factory_id::text=$2::text
            AND e.source_unit_id::text=$5::text AND e.target_unit_id::text=$6::text
            AND e.relationship_type='REWORKED_INTO'
            AND e.idempotency_key='quality-rework-genealogy:' || $3::text) AS rework_genealogy_outbox_count,
        (SELECT status FROM quality_defects
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND id::text=$7::text) AS defect_status,
        (SELECT row_version::int FROM quality_defects
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND id::text=$7::text) AS defect_version,
        (SELECT count(*)::int FROM quality_defect_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND defect_id::text=$7::text AND action='RESOLVED') AS rework_defect_event_count,
        (SELECT count(*)::int FROM quality_audit_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND defect_id::text=$7::text AND action_type='DEFECT_RESOLVED') AS rework_defect_audit_count,
        (SELECT count(*)::int FROM outbox_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND aggregate_type='QUALITY_DEFECT' AND aggregate_id::text=$7::text
            AND event_type='QUALITY.DEFECT_CHANGED' AND payload->>'action'='DEFECT_RESOLVED') AS rework_defect_outbox_count`,
      [tenantId, fixture.factoryId, reworkOrder.id, fixture.itemId, quarantinedSourceUnitId, recoveredUnit.id, sourceDefect.id],
    );
    // Fail at the final DEFECT_RESOLVED outbox write, after rework output stock,
    // movement, lot balance, quality evidence, genealogy edge/audit/outbox, and
    // the defect row/event/audit have been attempted in this same transaction.
    // The before/after snapshot must prove that every write rolls back together.
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION factoryos_test_fail_quality_rework_defect_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'QUALITY.DEFECT_CHANGED'
          AND NEW.aggregate_type = 'QUALITY_DEFECT'
          AND NEW.aggregate_id::text = '${sourceDefect.id}'
          AND NEW.payload->>'action' = 'DEFECT_RESOLVED' THEN
          RAISE EXCEPTION 'INJECTED_QUALITY_REWORK_DEFECT_OUTBOX_FAILURE';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await adminPool.query('DROP TRIGGER IF EXISTS zz_test_fail_quality_rework_defect_outbox ON outbox_events');
    await adminPool.query(`
      CREATE TRIGGER zz_test_fail_quality_rework_defect_outbox
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION factoryos_test_fail_quality_rework_defect_outbox()
    `);
    try {
      await expect(qualityService.transitionReworkOrder(
        qualityVerifierContext, reworkOrder.id, verificationPayload as never,
        'factory-e2e-quality-rework-verify-injected-failure-' + suffix,
      )).rejects.toThrow(/INJECTED_QUALITY_REWORK_DEFECT_OUTBOX_FAILURE/i);
    } finally {
      await adminPool.query('DROP TRIGGER IF EXISTS zz_test_fail_quality_rework_defect_outbox ON outbox_events');
      await adminPool.query('DROP FUNCTION IF EXISTS factoryos_test_fail_quality_rework_defect_outbox()');
    }
    const afterInjectedFailure = await adminPool.query<{
      rework_event_count: number;
      rework_outbox_count: number;
      rework_audit_count: number;
      item_stock_quantity: string;
      item_stock_version: number;
      recovered_traceability_quantity: string;
      rework_output_movement_count: number;
      rework_inventory_outbox_count: number;
      rework_genealogy_count: number;
      rework_genealogy_audit_count: number;
      rework_genealogy_outbox_count: number;
      defect_status: string;
      defect_version: number;
      rework_defect_event_count: number;
      rework_defect_audit_count: number;
      rework_defect_outbox_count: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM quality_rework_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND rework_order_id::text=$3::text) AS rework_event_count,
        (SELECT count(*)::int FROM outbox_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND aggregate_type='QUALITY_REWORK'
            AND aggregate_id::text=$3::text AND event_type='QUALITY.REWORK_CHANGED') AS rework_outbox_count,
        (SELECT count(*)::int FROM quality_audit_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND action_type='QUALITY_REWORK_EVENT'
            AND payload->>'rework_order_id'=$3::text) AS rework_audit_count,
        (SELECT quantity_on_hand::text FROM inventory_stock_balances
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND item_id::text=$4::text) AS item_stock_quantity,
        (SELECT version::int FROM inventory_stock_balances
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND item_id::text=$4::text) AS item_stock_version,
        (SELECT COALESCE(sum(quantity_on_hand),0)::numeric(18,4)::text
          FROM inventory_traceability_location_balances
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND item_id::text=$4::text AND traceability_unit_id::text=$6::text) AS recovered_traceability_quantity,
        (SELECT count(*)::int FROM inventory_movements
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id::text=$3::text) AS rework_output_movement_count,
        (SELECT count(*)::int FROM outbox_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND event_type='INVENTORY.STOCK_RECEIVED'
            AND payload->>'quality_rework_order_id'=$3::text) AS rework_inventory_outbox_count,
        (SELECT count(*)::int FROM product_genealogy_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND source_unit_id::text=$5::text AND target_unit_id::text=$6::text
            AND relationship_type='REWORKED_INTO'
            AND idempotency_key='quality-rework-genealogy:' || $3::text) AS rework_genealogy_count,
        (SELECT count(*)::int FROM audit_events a
          JOIN product_genealogy_events e ON e.tenant_id=a.tenant_id AND e.factory_id=a.factory_id
            AND a.resource_type='PRODUCT_GENEALOGY_EVENT' AND a.resource_id=e.id AND a.action='RECORDED'
          WHERE e.tenant_id::text=$1::text AND e.factory_id::text=$2::text
            AND e.source_unit_id::text=$5::text AND e.target_unit_id::text=$6::text
            AND e.relationship_type='REWORKED_INTO'
            AND e.idempotency_key='quality-rework-genealogy:' || $3::text) AS rework_genealogy_audit_count,
        (SELECT count(*)::int FROM outbox_events o
          JOIN product_genealogy_events e ON e.tenant_id=o.tenant_id AND e.factory_id=o.factory_id
            AND o.aggregate_type='PRODUCT_GENEALOGY_EVENT' AND o.aggregate_id=e.id
            AND o.event_type='TRACEABILITY.GENEALOGY_RECORDED'
          WHERE e.tenant_id::text=$1::text AND e.factory_id::text=$2::text
            AND e.source_unit_id::text=$5::text AND e.target_unit_id::text=$6::text
            AND e.relationship_type='REWORKED_INTO'
            AND e.idempotency_key='quality-rework-genealogy:' || $3::text) AS rework_genealogy_outbox_count,
        (SELECT status FROM quality_defects
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND id::text=$7::text) AS defect_status,
        (SELECT row_version::int FROM quality_defects
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND id::text=$7::text) AS defect_version,
        (SELECT count(*)::int FROM quality_defect_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND defect_id::text=$7::text AND action='RESOLVED') AS rework_defect_event_count,
        (SELECT count(*)::int FROM quality_audit_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND defect_id::text=$7::text AND action_type='DEFECT_RESOLVED') AS rework_defect_audit_count,
        (SELECT count(*)::int FROM outbox_events
          WHERE tenant_id::text=$1::text AND factory_id::text=$2::text
            AND aggregate_type='QUALITY_DEFECT' AND aggregate_id::text=$7::text
            AND event_type='QUALITY.DEFECT_CHANGED' AND payload->>'action'='DEFECT_RESOLVED') AS rework_defect_outbox_count`,
      [tenantId, fixture.factoryId, reworkOrder.id, fixture.itemId, quarantinedSourceUnitId, recoveredUnit.id, sourceDefect.id],
    );
    expect(afterInjectedFailure.rows[0]).toEqual(beforeInjectedFailure.rows[0]);
    const afterFailedVerify = await qualityService.getReworkOrder(qualityContext, reworkOrder.id);
    expect(afterFailedVerify).toMatchObject({
      status: 'COMPLETED',
      row_version: Number(reworkOrder.row_version),
    });
    const noFailedOutputMovement = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM inventory_movements WHERE tenant_id::text=$1::text AND factory_id::text=$2::text AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id::text=$3::text",
      [tenantId, fixture.factoryId, reworkOrder.id],
    );
    expect(noFailedOutputMovement.rows[0]?.count).toBe(0);

    const verifiedRework = await qualityService.transitionReworkOrder(
      qualityVerifierContext, reworkOrder.id, verificationPayload as never,
      'factory-e2e-quality-rework-verify-' + suffix,
    );
    expect(verifiedRework).toMatchObject({
      status: 'VERIFIED',
      input_quantity: '3.0000',
      recovered_quantity: '2.0000',
      scrap_quantity: '1.0000',
      output_traceability_unit_id: recoveredUnit.id,
      follow_up_inspection_id: followUpInspection.id,
    });
    const replayedReworkVerification = await qualityService.transitionReworkOrder(
      qualityVerifierContext, reworkOrder.id, verificationPayload as never,
      'factory-e2e-quality-rework-verify-' + suffix,
    );
    expect(replayedReworkVerification.replayed).toBe(true);

    const persistedReworkGenealogy = await adminPool.query<{
      relationship_type: string; quantity: string; unit: string; audit_count: number; outbox_count: number;
    }>(
      `SELECT e.relationship_type,e.quantity::text AS quantity,e.unit,
        (SELECT count(*)::int FROM audit_events a
          WHERE a.tenant_id=e.tenant_id AND a.factory_id=e.factory_id
            AND a.resource_type='PRODUCT_GENEALOGY_EVENT' AND a.resource_id=e.id AND a.action='RECORDED') AS audit_count,
        (SELECT count(*)::int FROM outbox_events o
          WHERE o.tenant_id=e.tenant_id AND o.factory_id=e.factory_id
            AND o.aggregate_type='PRODUCT_GENEALOGY_EVENT' AND o.aggregate_id=e.id
            AND o.event_type='TRACEABILITY.GENEALOGY_RECORDED') AS outbox_count
       FROM product_genealogy_events e
       WHERE e.tenant_id=$1 AND e.factory_id=$2 AND e.source_unit_id=$3 AND e.target_unit_id=$4
         AND e.relationship_type='REWORKED_INTO'
         AND e.idempotency_key=$5`,
      [tenantId, fixture.factoryId, quarantinedSourceUnitId, recoveredUnit.id, 'quality-rework-genealogy:' + reworkOrder.id],
    );
    expect(persistedReworkGenealogy.rows).toEqual([{
      relationship_type: 'REWORKED_INTO', quantity: '2.0000', unit: 'PCS', audit_count: 1, outbox_count: 1,
    }]);

    const persistedDefectTrace = await qualityService.getDefectTraceability(qualityContext, sourceDefect.id);
    expect(persistedDefectTrace.links).toEqual(expect.arrayContaining([
      expect.objectContaining({
        link_type: 'TRACEABILITY_UNIT',
        target_id: quarantinedSourceUnitId,
      }),
      expect.objectContaining({
        link_type: 'REWORK_OUTPUT',
        target_id: recoveredUnit.id,
        rework_order_id: reworkOrder.id,
        affected_quantity: '2.0000',
      }),
    ]));
    expect(persistedDefectTrace.rework_orders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: reworkOrder.id,
        status: 'VERIFIED',
        input_quantity: '3.0000',
        recovered_quantity: '2.0000',
        scrap_quantity: '1.0000',
        output_traceability_unit_id: recoveredUnit.id,
      }),
    ]));

    const reworkMovements = await adminPool.query<{
      reference_type: string; movement_count: number; quantity_delta: string;
    }>(
      `SELECT reference_type, count(*)::int AS movement_count,
              sum(quantity_delta)::numeric(18,4)::text AS quantity_delta
       FROM inventory_movements
       WHERE tenant_id=$1 AND factory_id=$2 AND reference_id=$3
         AND reference_type IN ('QUALITY_REWORK_INPUT','QUALITY_REWORK_OUTPUT')
       GROUP BY reference_type ORDER BY reference_type`,
      [tenantId, fixture.factoryId, reworkOrder.id],
    );
    expect(reworkMovements.rows).toEqual([
      { reference_type: 'QUALITY_REWORK_INPUT', movement_count: 1, quantity_delta: '-3.0000' },
      { reference_type: 'QUALITY_REWORK_OUTPUT', movement_count: 1, quantity_delta: '2.0000' },
    ]);
    const recoveredStock = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3',
      [tenantId, fixture.factoryId, fixture.itemId],
    );
    expect(recoveredStock.rows[0]?.quantity_on_hand).toBe('2.0000');

    const persistedSourceInspection = await qualityService.getInspection(qualityContext, sourceInspection.id);
    expect(persistedSourceInspection).toMatchObject({ status: 'ON_HOLD' });
    expect(persistedSourceInspection.defects[0]).toMatchObject({ status: 'RESOLVED' });
    expect(persistedSourceInspection.dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'REWORK', status: 'RECORDED', quantity: null }),
    ]));
    expect(persistedSourceInspection.holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'ACTIVE', traceability_unit_id: quarantinedSourceUnitId }),
    ]));
    const quarantinedSource = await traceabilityService.getUnit(
      userId, tenantId, fixture.factoryId, quarantinedSourceUnitId,
    );

    expect(quarantinedSource.status).toBe('QUARANTINED');

    // Exercise the separate, item-level SCRAP disposition path too. This uses
    // a dedicated test item so scrap can remove its entire balance without
    // touching the recovered lot that must continue to shipment.
    const scrapItemResult = await adminPool.query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, factory_id, sku, name, unit, created_by_user_id)
       VALUES ($1,$2,$3,'E2E nonconforming scrap item','PCS',$4) RETURNING id::text AS id`,
      [tenantId, fixture.factoryId, 'SCRAP-E2E-' + suffix, userId],
    );
    const scrapItemId = scrapItemResult.rows[0]?.id;
    if (!scrapItemId) throw new Error('Factory E2E scrap item fixture was not created');
    await adminPool.query(
      `INSERT INTO inventory_stock_balances (tenant_id,factory_id,item_id,quantity_on_hand)
       VALUES ($1,$2,$3,1.0000)`,
      [tenantId, fixture.factoryId, scrapItemId],
    );
    await adminPool.query(
      `INSERT INTO inventory_location_balances (tenant_id,factory_id,item_id,location_id,quantity_on_hand)
       VALUES ($1,$2,$3,$4,1.0000)`,
      [tenantId, fixture.factoryId, scrapItemId, binA.id],
    );
    const scrapInspection = await qualityService.createInspection(
      qualityContext,
      {
        inspection_type: 'INVENTORY',
        target_type: 'INVENTORY_ITEM',
        target_id: scrapItemId,
        sample_quantity: 1,
        notes: 'Factory E2E unrecoverable item inspection for explicit SCRAP disposition',
      } as never,
      'factory-e2e-quality-scrap-inspection-' + suffix,
    );
    let heldScrapInspection = await qualityService.decideInspection(
      qualityContext, scrapInspection.id,
      { expected_version: Number(scrapInspection.row_version), action: 'START' } as never,
      'factory-e2e-quality-scrap-start-' + suffix,
    );
    const scrapDefect = await qualityService.recordDefect(
      qualityContext, scrapInspection.id,
      {
        defect_code: 'E2E-UNRECOVERABLE-DEFECT',
        severity: 'MAJOR',
        affected_quantity: 1,
        description: 'Acceptance fixture: material is not recoverable and must be scrapped',
        evidence: { fixture: 'factory-e2e', disposition: 'SCRAP' },
      } as never,
      'factory-e2e-quality-scrap-defect-' + suffix,
    );
    heldScrapInspection = await qualityService.decideInspection(
      qualityContext, scrapInspection.id,
      {
        expected_version: Number(heldScrapInspection.row_version),
        action: 'HOLD',
        reason: 'Quarantine unrecoverable item before approved scrap',
      } as never,
      'factory-e2e-quality-scrap-hold-' + suffix,
    );
    expect(heldScrapInspection.holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'ACTIVE', inventory_item_id: scrapItemId }),
    ]));
    const scrapDispositionResult = await qualityService.disposeInspection(
      qualityContext, scrapInspection.id,
      {
        expected_version: Number(heldScrapInspection.row_version),
        action: 'SCRAP',
        quantity: 1,
        reason: 'Approved full-balance scrap for unrecoverable nonconforming item',
      } as never,
      'factory-e2e-quality-scrap-disposition-' + suffix,
    );
    expect(scrapDispositionResult.disposition).toMatchObject({
      action: 'SCRAP',
      status: 'PENDING_INVENTORY',
      quantity: '1.0000',
    });
    expect(scrapDispositionResult.next_inventory_action).toMatchObject({
      method: 'POST',
      movement_type: 'ISSUE',
      reference_type: 'QUALITY_DISPOSITION',
      reference_id: scrapDispositionResult.disposition.id,
      quantity: '1.0000',
    });
    const scrapMovement = await inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, scrapItemId,
      {
        movement_type: 'ISSUE',
        quantity: 1,
        location_id: binA.id,
        reference_type: 'QUALITY_DISPOSITION',
        reference_id: scrapDispositionResult.disposition.id,
        notes: 'Factory E2E approved SCRAP disposition',
      } as never,
      'factory-e2e-quality-scrap-movement-' + suffix,
      requestId,
      traceId,
    );
    expect(scrapMovement).toMatchObject({
      movement_type: 'ISSUE',
      quantity_delta: '-1.0000',
      reference_type: 'QUALITY_DISPOSITION',
      reference_id: scrapDispositionResult.disposition.id,
    });
    const completedScrapInspection = await qualityService.getInspection(qualityContext, scrapInspection.id);
    expect(completedScrapInspection).toMatchObject({ status: 'DISPOSITIONED' });
    expect(completedScrapInspection.defects[0]).toMatchObject({
      id: scrapDefect.id,
      status: 'SCRAPPED',
    });
    expect(completedScrapInspection.holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'DISPOSED', inventory_item_id: scrapItemId }),
    ]));
    expect(completedScrapInspection.dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: scrapDispositionResult.disposition.id,
        action: 'SCRAP',
        status: 'COMPLETED',
        inventory_movement_id: scrapMovement.id,
        quantity: '1.0000',
      }),
    ]));
    const scrappedBalance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3',
      [tenantId, fixture.factoryId, scrapItemId],
    );
    expect(scrappedBalance.rows[0]?.quantity_on_hand).toBe('0.0000');
    const scrapMovementCount = await adminPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory_movements
       WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='QUALITY_DISPOSITION'
         AND reference_id=$3 AND movement_type='ISSUE'`,
      [tenantId, fixture.factoryId, scrapDispositionResult.disposition.id],
    );
    expect(scrapMovementCount.rows[0]?.count).toBe(1);

    // Downstream warehouse operations now use the separately accepted recovered lot,
    // never the quarantined source lot that was consumed into rework/scrap.
    finishedLot = await traceabilityService.getUnit(
      userId, tenantId, fixture.factoryId, recoveredUnit.id,
    );

    const foreignProductionTenantId = randomUUID();
    await expect(traceabilityService.getUnit(
      userId, foreignProductionTenantId, fixture.factoryId, finishedLot.id,
    )).rejects.toThrow(/not found in this factory/i);
    await expect(workOrdersService.getWorkOrder(
      userId, foreignProductionTenantId, fixture.factoryId, workOrder.id,
    )).rejects.toThrow(/not found in this factory/i);

    const e2ePutAway = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId, destination_location_id: binA.id,
        quantity: 2, movement_purpose: 'PUT_AWAY', traceability_unit_id: finishedLot.id,
      },
      'factory-e2e-output-putaway-' + suffix, requestId, traceId,
    );
    expect(e2ePutAway).toMatchObject({
      movement_purpose: 'PUT_AWAY',
      traceability_unit_id: finishedLot.id,
      source_quantity_after: '0.0000',
      destination_quantity_after: '2.0000',
    });

    const pickStaging = await locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      {
        location_code: 'FG-PICK-STAGE-' + suffix,
        name: 'Factory E2E finished goods pick staging',
        location_type: 'STAGING',
      },
      requestId, traceId,
    );
    const e2ePickKey = 'factory-e2e-output-pick-' + suffix;
    const e2ePick = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: pickStaging.id,
        quantity: 2,
        movement_purpose: 'PICK',
        traceability_unit_id: finishedLot.id,
      },
      e2ePickKey, requestId, traceId,
    );
    expect(e2ePick).toMatchObject({
      movement_purpose: 'PICK',
      traceability_unit_id: finishedLot.id,
      source_quantity_after: '0.0000',
      destination_quantity_after: '2.0000',
    });
    const persistedPick = await adminPool.query<{ movement_purpose: string; traceability_unit_id: string }>(
      `SELECT movement_purpose, traceability_unit_id::text AS traceability_unit_id
       FROM inventory_location_transfers
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND idempotency_key=$4`,
      [tenantId, fixture.factoryId, fixture.itemId, e2ePickKey],
    );
    expect(persistedPick.rows).toEqual([{
      movement_purpose: 'PICK',
      traceability_unit_id: finishedLot.id,
    }]);

    const carton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON', container_code: 'CARTON-ORDER-POD-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId, location_id: pickStaging.id, capacity_quantity: 2,
      },
      'wms-order-pod-carton-create-' + randomUUID(), requestId, traceId,
    );
    const cartonId = carton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 2 },
      'wms-order-pod-content-' + randomUUID(), requestId, traceId,
    );
    const sourcePackingCount = await adminPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM wms_packing_contents WHERE tenant_id=$1 AND factory_id=$2 AND source_unit_id=$3',
      [tenantId, fixture.factoryId, quarantinedSourceUnitId],
    );
    expect(sourcePackingCount.rows[0]?.count).toBe(0);
    const recoveredPackingCount = await adminPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM wms_packing_contents WHERE tenant_id=$1 AND factory_id=$2 AND source_unit_id=$3',
      [tenantId, fixture.factoryId, recoveredUnit.id],
    );
    expect(recoveredPackingCount.rows[0]?.count).toBe(1);
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId,
      'wms-order-pod-seal-' + randomUUID(), requestId, traceId,
    );

    const pallet = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'PALLET',
        container_code: 'PALLET-ORDER-POD-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: pickStaging.id,
        capacity_quantity: 2,
      },
      'wms-order-pod-pallet-create-' + randomUUID(), requestId, traceId,
    );
    const palletId = pallet.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, palletId,
      { source_unit_id: cartonId, quantity: 2 },
      'wms-order-pod-pallet-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, palletId,
      'wms-order-pod-pallet-seal-' + randomUUID(), requestId, traceId,
    );

    const itemResult = await adminPool.query<{ sku: string; name: string; unit: string }>(
      `SELECT sku, name, unit FROM inventory_items
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [fixture.itemId, tenantId, fixture.factoryId],
    );
    const item = itemResult.rows[0];
    expect(item).toBeDefined();
    const createOrderLine = async (quantity: number, reference: string) => {
      const orderNumber = 'SO-WMS-POD-' + randomUUID().slice(0, 8);
      const order = await adminPool.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, factory_id, order_number, customer_name, customer_reference, status, order_date, currency, created_by_user_id)
         VALUES ($1,$2,$3,'Acceptance Customer',$4,'CONFIRMED',CURRENT_DATE,'BDT',$5)
         RETURNING id::text AS id`,
        [tenantId, fixture.factoryId, orderNumber, reference, userId],
      );
      const orderId = order.rows[0]?.id;
      if (!orderId) throw new Error('WMS shipment acceptance order was not created');
      const line = await adminPool.query<{ id: string }>(
        `INSERT INTO order_lines (tenant_id, factory_id, order_id, line_number, product_code, product_name, inventory_item_id, quantity, unit)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7::numeric,$8) RETURNING id::text AS id`,
        [tenantId, fixture.factoryId, orderId, item!.sku, item!.name, fixture.itemId, quantity.toFixed(4), item!.unit],
      );
      const orderLineId = line.rows[0]?.id;
      if (!orderLineId) throw new Error('WMS shipment acceptance order line was not created');
      return { orderId, orderLineId, orderNumber, reference };
    };

    const tooSmallReference = 'CUSTOMER-ORDER-TOO-SMALL-' + randomUUID().slice(0, 8);
    const tooSmallOrder = await createOrderLine(1, tooSmallReference);
    const tooSmallPayload = {
      shipment_code: 'SHIP-ORDER-TOO-SMALL-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer', customer_order_reference: tooSmallReference,
      order_id: tooSmallOrder.orderId, order_line_id: tooSmallOrder.orderLineId,
    };
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId, tooSmallPayload,
      'wms-order-pod-overship-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    const balanceAfterRejectedOrder = await readAggregate(fixture.factoryId, fixture.itemId);
    // Rejected order-line validation must not consume any of the two recovered units.
    // The upstream shared journey scrapped 1.0000 from the original 3.0000 output.
    expect(balanceAfterRejectedOrder?.quantity_on_hand).toBe('2.0000');

    // Ship the recovered output against the very same production-managed sales
    // order line that was confirmed above with no finished-good stock.
    const validReference = salesOrderReference;
    const validOrder = {
      orderId: sourceOrderId,
      orderLineId: sourceOrderLineId,
      orderNumber: salesOrderReference,
      reference: validReference,
    };
    const invalidCustomerPayload = {
      shipment_code: 'SHIP-ORDER-CUSTOMER-MISMATCH-' + randomUUID().slice(0, 8),
      customer_name: 'Different Customer', customer_order_reference: validReference,
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
    };
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId, invalidCustomerPayload,
      'wms-order-pod-customer-mismatch-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const payload = {
      shipment_code: 'SHIP-ORDER-POD-' + randomUUID().slice(0, 8),
      customer_name: 'Factory E2E Production Customer', customer_order_reference: validReference,
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
      carrier_name: 'Acme Logistics',
      tracking_reference: 'ACME-TRACK-' + randomUUID().slice(0, 8),
    };
    const dispatch = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId, payload,
      'wms-order-pod-dispatch-' + randomUUID(), requestId, traceId,
    );
    expect(dispatch).toMatchObject({
      replayed: false,
      shipment: {
        order_id: sourceOrderId, order_line_id: sourceOrderLineId,
        customer_name: 'Factory E2E Production Customer',
        customer_order_reference: salesOrderReference,
        quantity: '2.0000', status: 'DISPATCHED',
      },
    });
    const storedOrderBinding = await adminPool.query<{ order_id: string; order_line_id: string; customer_order_reference: string }>(
      `SELECT order_id::text AS order_id, order_line_id::text AS order_line_id, customer_order_reference
       FROM wms_shipments WHERE shipment_unit_id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [dispatch.shipment.shipment_unit_id, tenantId, fixture.factoryId],
    );
    expect(storedOrderBinding.rows[0]).toEqual({
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId, customer_order_reference: validReference,
    });

    // The server assigns event_at once; an identical retry with the timestamp omitted must replay.
    const transitPayload = { event_type: 'IN_TRANSIT' as const, notes: 'Shipment handed to carrier' };
    const transitKey = 'wms-delivery-transit-' + randomUUID();
    const transit = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      transitPayload, transitKey, requestId, traceId,
    );
    expect(transit).toMatchObject({ replayed: false, event: { event_type: 'IN_TRANSIT', source_system: 'MANUAL' } });
    const transitReplay = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      transitPayload, transitKey, requestId, traceId,
    );
    expect(transitReplay).toMatchObject({ replayed: true, event: { id: transit.event.id } });
    expect(transitReplay.event.event_at).toBe(transit.event.event_at);
    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { ...transitPayload, notes: 'Changed payload must not replay' },
      transitKey, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { event_type: 'DELIVERED', event_at: new Date().toISOString() },
      'wms-delivery-no-proof-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(BadRequestException);

    const deliveredAt = new Date().toISOString();
    const signedAt = new Date(Date.now() - 60_000).toISOString();
    const proofPayload = {
      event_type: 'DELIVERED' as const, event_at: deliveredAt,
      recipient_name: 'Acceptance Recipient', proof_type: 'SIGNATURE' as const,
      proof_reference: 'pod/' + tenantId.toLowerCase() + '/' + fixture.factoryId.toLowerCase() + '/' + dispatch.shipment.shipment_unit_id.toLowerCase() + '/' + randomUUID() + '.png',
      proof_sha256: 'a'.repeat(64), signed_at: signedAt, notes: 'POD acceptance evidence',
    };
    const proofKey = 'wms-delivery-proof-' + randomUUID();
    const proof = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      proofPayload, proofKey, requestId, traceId,
    );
    expect(proof).toMatchObject({
      replayed: false,
      event: {
        event_type: 'DELIVERED', recipient_name: 'Acceptance Recipient', proof_type: 'SIGNATURE',
        proof_reference: proofPayload.proof_reference, proof_sha256: 'a'.repeat(64),
      },
    });
    expect(new Date(proof.event.signed_at as string).getTime()).toBe(new Date(signedAt).getTime());
    const proofReplay = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      proofPayload, proofKey, requestId, traceId,
    );
    expect(proofReplay).toMatchObject({ replayed: true, event: { id: proof.event.id } });
    expect(podStorageVerifier.verifyObjectDigest).toHaveBeenCalledWith(proofPayload.proof_reference, proofPayload.proof_sha256);
    expect(podStorageVerifier.verifyObjectDigest).toHaveBeenCalledTimes(1);
    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { event_type: 'IN_TRANSIT', event_at: new Date().toISOString() },
      'wms-delivery-terminal-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const deliveryHistory = await fulfillmentService.listDeliveryEvents(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
    );
    expect(deliveryHistory.events).toHaveLength(2);
    expect(deliveryHistory.events.map((event: { event_type: string }) => event.event_type)).toEqual(['IN_TRANSIT', 'DELIVERED']);
    expect(deliveryHistory.events[1]).toMatchObject({
      proof_reference: proofPayload.proof_reference, proof_sha256: 'a'.repeat(64), recipient_name: 'Acceptance Recipient',
    });
    const shipmentList = await fulfillmentService.listShipments(
      userId, tenantId, fixture.factoryId, { search: validReference },
    );
    expect(shipmentList.shipments[0]).toMatchObject({
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
      latest_delivery_event_type: 'DELIVERED',
      carrier_name: payload.carrier_name,
      tracking_reference: payload.tracking_reference,
    });

    // Cross-feature SRS regression: the same order-bound shipment, persisted POD
    // metadata, recall assessment/declaration and lifecycle-aware label snapshots
    // must agree on the persisted shipment and identity state.
    const labelTemplate = await traceabilityService.createLabelTemplate(
      userId, tenantId, fixture.factoryId,
      {
        template_code: 'WP02-E2E-' + randomUUID().slice(0, 8),
        name: 'WP02 end-to-end lifecycle label',
        symbology: 'QR',
        supported_unit_types: ['LOT', 'SHIPMENT'],
        label_layout: {
          page: { width_mm: 50, height_mm: 30 },
          fields: ['unit_code', 'barcode_value', 'status'],
        },
      } as never,
      requestId, traceId,
    );
    const labelBeforeRecall = await traceabilityService.issueLabel(
      userId, tenantId, fixture.factoryId,
      { unit_id: finishedLot.id, template_id: labelTemplate.id, copy_count: 1 } as never,
      'wp02-e2e-label-before-' + randomUUID(), requestId, traceId,
    );
    expect(labelBeforeRecall.print_contract.identity_payload).toMatchObject({
      unit_id: finishedLot.id,
      // This journey issues the label after dispatch and POD; the persisted lot
      // must already be SHIPPED before recall changes it to RECALLED.
      status: 'SHIPPED',
    });

    const impact = await traceabilityService.recallImpact(
      userId, tenantId, fixture.factoryId, materialLot.id, 12, 200,
    );
    expect(impact.affected_shipment_count).toBe(1);
    expect(impact.impacted_units.map((unit: { id: string }) => unit.id)).toEqual(expect.arrayContaining([cartonId, palletId]));
    expect(impact.affected_shipments[0]).toMatchObject({
      shipment_unit_id: dispatch.shipment.shipment_unit_id,
      container_unit_id: palletId,
      order_id: validOrder.orderId,
      order_line_id: validOrder.orderLineId,
      carrier_name: payload.carrier_name,
      tracking_reference: payload.tracking_reference,
      latest_delivery_event_type: 'DELIVERED',
      pod_reference: proofPayload.proof_reference,
      pod_sha256: 'a'.repeat(64),
    });
    expect(impact).toMatchObject({
      impact_truncated: false,
      provenance_truncated: false,
      side_effects: { stock_changed: false, statuses_changed: false, records_created: false },
    });

    const stockBeforeRecall = await readAggregate(fixture.factoryId, fixture.itemId);
    const binsBeforeRecall = await readBinTotals(fixture.factoryId, fixture.itemId);
    const recallKey = 'wp02-e2e-recall-' + randomUUID();
    const recall = await traceabilityService.declareRecall(
      userId, tenantId, fixture.factoryId, materialLot.id,
      { reason: 'E2E regression: delivered shipment requires recall review', depth: 12, limit: 200 },
      recallKey, requestId, traceId,
    );
    expect(recall.replayed).toBe(false);
    const recallActions = new Map(recall.units.map((row: { unit_id: string; unit_action: string }) => [row.unit_id, row.unit_action]));
    expect(recallActions.get(quarantinedSourceUnitId)).toBe('RECALLED');
    // The recovered lot has already shipped. Recall must preserve that logistics fact
    // and create a customer/site review action instead of rewriting SHIPPED to RECALLED.
    expect(recallActions.get(finishedLot.id)).toBe('SHIPPED_REVIEW_REQUIRED');
    expect(recallActions.get(cartonId)).toBe('SHIPPED_REVIEW_REQUIRED');
    expect(recallActions.get(palletId)).toBe('SHIPPED_REVIEW_REQUIRED');
    expect(recallActions.get(dispatch.shipment.shipment_unit_id)).toBe('SHIPPED_REVIEW_REQUIRED');

    const labelAfterRecall = await traceabilityService.issueLabel(
      userId, tenantId, fixture.factoryId,
      { unit_id: finishedLot.id, template_id: labelTemplate.id, copy_count: 1 } as never,
      'wp02-e2e-label-after-' + randomUUID(), requestId, traceId,
    );
    expect(labelAfterRecall.print_contract.identity_payload).toMatchObject({
      unit_id: finishedLot.id,
      status: 'SHIPPED',
    });
    const shippedLabelAfterRecall = await traceabilityService.issueLabel(
      userId, tenantId, fixture.factoryId,
      { unit_id: dispatch.shipment.shipment_unit_id, template_id: labelTemplate.id, copy_count: 1 } as never,
      'wp02-e2e-shipment-label-after-recall-' + randomUUID(), requestId, traceId,
    );
    expect(shippedLabelAfterRecall.print_contract.identity_payload).toMatchObject({
      unit_id: dispatch.shipment.shipment_unit_id,
      status: 'SHIPPED',
    });

    const persistedLifecycle = await adminPool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM traceability_units
       WHERE tenant_id=$1 AND factory_id=$2 AND id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [materialLot.id, quarantinedSourceUnitId, finishedLot.id, cartonId, palletId, dispatch.shipment.shipment_unit_id]],
    );
    expect(persistedLifecycle.rows).toHaveLength(6);
    expect(persistedLifecycle.rows.find((row) => row.id === materialLot.id)?.status).toBe('RECALLED');
    expect(persistedLifecycle.rows.find((row) => row.id === quarantinedSourceUnitId)?.status).toBe('RECALLED');
    expect(persistedLifecycle.rows.find((row) => row.id === finishedLot.id)?.status).toBe('SHIPPED');
    expect(persistedLifecycle.rows.find((row) => row.id === cartonId)?.status).toBe('SHIPPED');
    expect(persistedLifecycle.rows.find((row) => row.id === palletId)?.status).toBe('SHIPPED');
    expect(persistedLifecycle.rows.find((row) => row.id === dispatch.shipment.shipment_unit_id)?.status).toBe('SHIPPED');
    const stockAfterRecall = await readAggregate(fixture.factoryId, fixture.itemId);
    const binsAfterRecall = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(stockAfterRecall?.quantity_on_hand).toBe(stockBeforeRecall?.quantity_on_hand);
    expect(binsAfterRecall?.sum).toBe(binsBeforeRecall?.sum);

    // Continue the same recall through its durable notification-intent and
    // operator-reported acknowledgement ledger; neither action may touch stock.
    const notificationKey = 'wp02-e2e-recall-notification-' + randomUUID();
    const notificationPayload = {
      recipient_type: 'CUSTOMER' as const,
      recipient_reference: validReference,
      channel: 'MANUAL' as const,
      reason: 'E2E recall follow-up intent for the delivered order-bound shipment',
    };
    const notification = await traceabilityService.createRecallNotificationIntent(
      userId, tenantId, fixture.factoryId, recall.recall_case.id,
      notificationPayload as never, notificationKey, requestId, traceId,
    );
    expect(notification).toMatchObject({
      recall_case_id: recall.recall_case.id,
      recipient_type: 'CUSTOMER',
      recipient_reference: validReference,
      channel: 'MANUAL',
      dispatch_status: 'INTENT_RECORDED_NOT_DELIVERY_CONFIRMED',
      replayed: false,
    });
    const notificationReplay = await traceabilityService.createRecallNotificationIntent(
      userId, tenantId, fixture.factoryId, recall.recall_case.id,
      notificationPayload as never, notificationKey, requestId, traceId,
    );
    expect(notificationReplay).toMatchObject({ id: notification.id, replayed: true });

    const acknowledgementKey = 'wp02-e2e-recall-ack-' + randomUUID();
    const acknowledgementPayload = {
      outcome: 'ACTION_IN_PROGRESS' as const,
      notes: 'Site operator reports that affected stock isolation is in progress',
    };
    const acknowledgement = await traceabilityService.recordRecallNotificationAcknowledgement(
      userId, tenantId, fixture.factoryId, recall.recall_case.id, notification.id,
      acknowledgementPayload as never, acknowledgementKey, requestId, traceId,
    );
    expect(acknowledgement).toMatchObject({
      recall_case_id: recall.recall_case.id,
      notification_intent_id: notification.id,
      outcome: 'ACTION_IN_PROGRESS',
      acknowledgement_source: 'OPERATOR_REPORTED',
      externally_authenticated: false,
      replayed: false,
    });
    const acknowledgementReplay = await traceabilityService.recordRecallNotificationAcknowledgement(
      userId, tenantId, fixture.factoryId, recall.recall_case.id, notification.id,
      acknowledgementPayload as never, acknowledgementKey, requestId, traceId,
    );
    expect(acknowledgementReplay).toMatchObject({ id: acknowledgement.id, replayed: true });

    const notificationHistory = await traceabilityService.listRecallNotificationIntents(
      userId, tenantId, fixture.factoryId, recall.recall_case.id,
    );
    expect(notificationHistory.items).toHaveLength(1);
    expect(notificationHistory.items[0]).toMatchObject({
      id: notification.id,
      acknowledgement_id: acknowledgement.id,
      acknowledgement_outcome: 'ACTION_IN_PROGRESS',
      acknowledgement_source: 'OPERATOR_REPORTED',
      dispatch_status: 'INTENT_RECORDED_NOT_DELIVERY_CONFIRMED',
      acknowledgement_externally_authenticated: false,
    });
    const stockAfterNotification = await readAggregate(fixture.factoryId, fixture.itemId);
    const binsAfterNotification = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(stockAfterNotification?.quantity_on_hand).toBe(stockBeforeRecall?.quantity_on_hand);
    expect(binsAfterNotification?.sum).toBe(binsBeforeRecall?.sum);

    const foreignTenantId = randomUUID();
    await expect(fulfillmentService.listDeliveryEvents(
      userId, foreignTenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
    )).rejects.toThrow(/not found in this factory/i);
  });

});
