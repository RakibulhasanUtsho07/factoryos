import { ConflictException, BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { DatabaseService } from '../database/database.service';
import { InventoryReservationService } from '../inventory/inventory.reservation.service';
import { CreateOrderProductionReportDto } from './dto/create-order-production-report.dto';
import { OrderProductionReportService } from './order-production-report.service';

describe('OrderProductionReportService PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let pool!: Pool;
  let appPool!: Pool;
  let database!: DatabaseService;
  let service!: OrderProductionReportService;
  let tenantId!: string;
  let factoryId!: string;
  const fixtures: Array<{ orderId: string; lineId: string; itemId: string }> = [];

  const createFixture = async (
    status = 'IN_PROGRESS',
    targetQuantity = '10.0000',
  ): Promise<{ orderId: string; lineId: string; itemId: string }> => {
    const itemId = randomUUID();
    await pool.query(
      `
      INSERT INTO inventory_items (
        id, tenant_id, factory_id, sku, name, unit, status, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, 'Production report finished-good fixture', 'PCS', 'ACTIVE', $5)
      `,
      [itemId, tenantId, factoryId, `PRODUCTION-REPORT-ITEM-${randomUUID()}`, TEST_USER_ID],
    );
    await pool.query(
      `
      INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand)
      VALUES ($1, $2, $3, 0)
      `,
      [tenantId, factoryId, itemId],
    );

    const orderResult = await pool.query<{ id: string }>(
      `
      INSERT INTO orders (
        tenant_id, factory_id, order_number, status, order_date, currency, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, CURRENT_DATE, 'BDT', $5)
      RETURNING id::text AS id
      `,
      [tenantId, factoryId, `PRODUCTION-REPORT-${randomUUID()}`, status, TEST_USER_ID],
    );
    const orderId = orderResult.rows[0]?.id;
    if (!orderId) throw new Error('Production-report order fixture was not created');

    const lineResult = await pool.query<{ id: string }>(
      `
      INSERT INTO order_lines (
        tenant_id, factory_id, order_id, line_number,
        product_code, product_name, quantity, unit, inventory_item_id
      )
      VALUES ($1, $2, $3, 1, 'FINISHED-GOOD', 'Finished good fixture', $4::numeric, 'PCS', $5)
      RETURNING id::text AS id
      `,
      [tenantId, factoryId, orderId, targetQuantity, itemId],
    );
    const lineId = lineResult.rows[0]?.id;
    if (!lineId) throw new Error('Production-report line fixture was not created');

    const fixture = { orderId, lineId, itemId };
    fixtures.push(fixture);
    return fixture;
  };

  const createReport = (
    fixture: { orderId: string; lineId: string },
    dto: Omit<CreateOrderProductionReportDto, 'order_line_id'> & { order_line_id?: string },
    idempotencyKey: string,
  ) => service.createReport(
    TEST_USER_ID,
    tenantId,
    factoryId,
    fixture.orderId,
    { ...dto, order_line_id: dto.order_line_id ?? fixture.lineId },
    idempotencyKey,
    randomUUID(),
    randomUUID(),
  );

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    if (!adminUrl) throw new Error('TEST_ADMIN_DATABASE_URL is required');

    pool = new Pool({ connectionString: adminUrl });
    appPool = new Pool({ connectionString: databaseUrl });

    const contextResult = await pool.query<{ tenant_id: string; factory_id: string }>(
      `
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id
      FROM tenants t
      JOIN factories f ON f.tenant_id = t.id
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at, f.created_at
      LIMIT 1
      `,
    );
    if (!contextResult.rows[0]) throw new Error('No active tenant/factory fixture is available');
    tenantId = contextResult.rows[0].tenant_id;
    factoryId = contextResult.rows[0].factory_id;

    const user = await pool.query('SELECT 1 FROM users WHERE id = $1', [TEST_USER_ID]);
    if (user.rowCount !== 1) throw new Error(`Missing integration test user: ${TEST_USER_ID}`);

    database = createIntegrationDatabase(appPool) as never;
    const auditService = { record: async () => 'audit-event-id' } as unknown as AuditService;
    const inventoryService = new InventoryReservationService(database, auditService);
    service = new OrderProductionReportService(database, auditService, inventoryService);
  });

  afterAll(async () => {
    if (pool && fixtures.length) {
      const orderIds = fixtures.map((fixture) => fixture.orderId);
      const itemIds = fixtures.map((fixture) => fixture.itemId);
      // The output ledger and stock movement are immutable during normal operation.
      // Only this test's random fixture rows are removed with user triggers disabled.
      const triggerTables = [
        'order_production_reports',
        'production_output_postings',
        'inventory_movements',
        'inventory_stock_balances',
        'inventory_location_balances',
      ];
      for (const table of triggerTables) {
        await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      }
      try {
        await pool.query(
          `DELETE FROM outbox_events
           WHERE tenant_id = $1 AND factory_id = $2
             AND (aggregate_id = ANY($3::uuid[]) OR aggregate_id = ANY($4::uuid[]))`,
          [tenantId, factoryId, orderIds, itemIds],
        );
        await pool.query(
          `DELETE FROM production_output_postings
           WHERE tenant_id = $1 AND factory_id = $2
             AND production_report_id IN (
               SELECT id FROM order_production_reports
               WHERE tenant_id = $1 AND factory_id = $2 AND order_id = ANY($3::uuid[])
             )`,
          [tenantId, factoryId, orderIds],
        );
        await pool.query(
          `DELETE FROM inventory_movements
           WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])
             AND reference_type = 'PRODUCTION_OUTPUT'`,
          [tenantId, factoryId, itemIds],
        );
        await pool.query(
          'DELETE FROM order_production_reports WHERE tenant_id = $1 AND factory_id = $2 AND order_id = ANY($3::uuid[])',
          [tenantId, factoryId, orderIds],
        );
        await pool.query(
          'DELETE FROM order_lines WHERE tenant_id = $1 AND factory_id = $2 AND order_id = ANY($3::uuid[])',
          [tenantId, factoryId, orderIds],
        );
        await pool.query(
          'DELETE FROM orders WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])',
          [tenantId, factoryId, orderIds],
        );
        await pool.query(
          'DELETE FROM inventory_location_balances WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, itemIds],
        );
        await pool.query(
          'DELETE FROM inventory_stock_balances WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, itemIds],
        );
        await pool.query(
          'DELETE FROM inventory_items WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])',
          [tenantId, factoryId, itemIds],
        );
      } finally {
        for (const table of triggerTables.reverse()) {
          await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
        }
      }
    }
    await appPool?.end();
    await pool?.end();
  });

  it('records good and scrap quantities once, calculates yield, and replays identical retries', async () => {
    const fixture = await createFixture();
    const dto = {
      order_line_id: fixture.lineId,
      good_quantity: 3,
      scrap_quantity: 1,
      scrap_reason: 'Surface defect',
      notes: 'First quality checkpoint',
    };

    const created = await service.createReport(
      TEST_USER_ID, tenantId, factoryId, fixture.orderId, dto, 'yield-report-001', randomUUID(), randomUUID(),
    );
    expect(created.good_quantity).toBe('3.0000');
    expect(created.scrap_quantity).toBe('1.0000');
    expect(created.cumulative_good_quantity).toBe('3.0000');
    expect(created.cumulative_scrap_quantity).toBe('1.0000');
    expect(created.yield_percent).toBe('75.0000');
    expect(created.replayed).toBe(false);
    expect(created.finished_good_traceability_unit_id).toBeTruthy();
    expect(created.scrap_traceability_unit_id).toBeTruthy();

    const linkedOutput = await pool.query<{
      finished_good_traceability_unit_id: string | null;
      scrap_traceability_unit_id: string | null;
      finished_good_report_id: string | null;
      finished_good_role: string | null;
      finished_good_quantity: string | null;
      finished_good_item_matches: boolean;
      finished_good_tracked_quantity: string | null;
      scrap_role: string | null;
      scrap_quantity: string | null;
      scrap_item_id: string | null;
      scrap_kind: string | null;
      scrap_report_id: string | null;
    }>(`
      SELECT p.traceability_unit_id::text AS finished_good_traceability_unit_id,
        p.scrap_traceability_unit_id::text AS scrap_traceability_unit_id,
        fg.production_report_id::text AS finished_good_report_id,
        fg.product_role AS finished_good_role,
        fg.quantity::text AS finished_good_quantity,
        fg.inventory_item_id = p.finished_item_id AS finished_good_item_matches,
        (SELECT COALESCE(SUM(tlb.quantity_on_hand), 0)::text
         FROM inventory_traceability_location_balances tlb
         WHERE tlb.tenant_id = p.tenant_id AND tlb.factory_id = p.factory_id
           AND tlb.item_id = p.finished_item_id AND tlb.traceability_unit_id = fg.id) AS finished_good_tracked_quantity,
        scrap.product_role AS scrap_role,
        scrap.quantity::text AS scrap_quantity,
        scrap.inventory_item_id::text AS scrap_item_id,
        scrap.attributes->>'kind' AS scrap_kind,
        scrap.attributes->>'production_report_id' AS scrap_report_id
      FROM production_output_postings p
      JOIN traceability_units fg
        ON fg.id = p.traceability_unit_id
       AND fg.tenant_id = p.tenant_id AND fg.factory_id = p.factory_id
      JOIN traceability_units scrap
        ON scrap.id = p.scrap_traceability_unit_id
       AND scrap.tenant_id = p.tenant_id AND scrap.factory_id = p.factory_id
      WHERE p.tenant_id = $1 AND p.factory_id = $2 AND p.production_report_id = $3
    `, [tenantId, factoryId, created.id]);
    expect(linkedOutput.rows).toHaveLength(1);
    expect(linkedOutput.rows[0]).toMatchObject({
      finished_good_traceability_unit_id: created.finished_good_traceability_unit_id,
      scrap_traceability_unit_id: created.scrap_traceability_unit_id,
      finished_good_report_id: created.id,
      finished_good_role: 'FINISHED_GOOD',
      finished_good_quantity: '3.0000',
      finished_good_item_matches: true,
      finished_good_tracked_quantity: '3.0000',
      scrap_role: 'OTHER',
      scrap_quantity: '1.0000',
      scrap_item_id: null,
      scrap_kind: 'PRODUCTION_SCRAP',
      scrap_report_id: created.id,
    });

    const replay = await service.createReport(
      TEST_USER_ID, tenantId, factoryId, fixture.orderId, dto, 'yield-report-001', randomUUID(), randomUUID(),
    );
    expect(replay.id).toBe(created.id);
    expect(replay.cumulative_good_quantity).toBe(created.cumulative_good_quantity);
    expect(replay.finished_good_traceability_unit_id).toBe(created.finished_good_traceability_unit_id);
    expect(replay.scrap_traceability_unit_id).toBe(created.scrap_traceability_unit_id);
    expect(replay.replayed).toBe(true);

    await expect(service.createReport(
      TEST_USER_ID, tenantId, factoryId, fixture.orderId,
      { ...dto, good_quantity: 2, scrap_quantity: 2 },
      'yield-report-001', randomUUID(), randomUUID(),
    )).rejects.toBeInstanceOf(ConflictException);

    const events = await pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count FROM outbox_events
      WHERE tenant_id = $1 AND factory_id = $2
        AND aggregate_id = $3 AND event_type = 'ORDER.PRODUCTION_REPORTED'
      `,
      [tenantId, factoryId, fixture.orderId],
    );
    expect(events.rows[0]?.count).toBe(1);

    const listed = await service.listReports(TEST_USER_ID, tenantId, factoryId, fixture.orderId, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
  });

  it('requires valid output and scrap reason while allowing scrap to be separately accounted for', async () => {
    const fixture = await createFixture();
    await expect(createReport(
      fixture, { good_quantity: 0, scrap_quantity: 0 }, 'yield-empty-001',
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(createReport(
      fixture, { good_quantity: 0, scrap_quantity: 1 }, 'yield-no-reason-001',
    )).rejects.toBeInstanceOf(BadRequestException);

    await createReport(
      fixture,
      { good_quantity: 7, scrap_quantity: 3, scrap_reason: 'Initial rejected finish' },
      'yield-part-001',
    );
    const completedGood = await createReport(
      fixture,
      { good_quantity: 3, scrap_quantity: 2, scrap_reason: 'Additional rejected finish' },
      'yield-part-002',
    );
    expect(completedGood.cumulative_good_quantity).toBe('10.0000');
    expect(completedGood.cumulative_scrap_quantity).toBe('5.0000');
    expect(completedGood.yield_percent).toBe('66.6667');

    await expect(createReport(
      fixture, { good_quantity: 0.1, scrap_quantity: 0 }, 'yield-over-001',
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('serializes concurrent reports so total output cannot exceed the order-line target', async () => {
    const fixture = await createFixture('IN_PROGRESS', '10.0000');
    const results = await Promise.allSettled([
      createReport(fixture, { good_quantity: 6, scrap_quantity: 0 }, 'yield-race-a'),
      createReport(fixture, { good_quantity: 6, scrap_quantity: 0 }, 'yield-race-b'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const total = await pool.query<{ quantity: string }>(
      `
      SELECT (SUM(good_quantity) + SUM(scrap_quantity))::text AS quantity
      FROM order_production_reports
      WHERE tenant_id = $1 AND factory_id = $2 AND order_line_id = $3
      `,
      [tenantId, factoryId, fixture.lineId],
    );
    expect(Number(total.rows[0]?.quantity)).toBe(6);
  });

  it('rejects reports outside IN_PROGRESS and protects report facts against direct database mutation', async () => {
    const fixture = await createFixture('CONFIRMED');
    await expect(createReport(
      fixture, { good_quantity: 1, scrap_quantity: 0 }, 'yield-wrong-state',
    )).rejects.toBeInstanceOf(ConflictException);

    const active = await createFixture();
    const report = await createReport(
      active, { good_quantity: 1, scrap_quantity: 0 }, 'yield-immutable-001',
    );
    await expect(pool.query(
      'UPDATE order_production_reports SET notes = $1 WHERE id = $2',
      ['tampered', report.id],
    )).rejects.toThrow(/append-only/);
    await expect(pool.query(
      'DELETE FROM order_production_reports WHERE id = $1',
      [report.id],
    )).rejects.toThrow(/append-only/);

    const inserted = await pool.query<{ forced: boolean }>(
      `
      SELECT c.relforcerowsecurity AS forced
      FROM pg_class c
      WHERE c.oid = 'order_production_reports'::regclass
      `,
    );
    expect(inserted.rows[0]?.forced).toBe(true);
  });

  it('rejects direct SQL attempts to exceed the output target or provide forged cumulative totals', async () => {
    const fixture = await createFixture('IN_PROGRESS', '2.0000');
    await createReport(fixture, { good_quantity: 1, scrap_quantity: 0 }, 'yield-direct-guard-001');

    await expect(pool.query(
      `
      INSERT INTO order_production_reports (
        tenant_id, factory_id, order_id, order_line_id,
        good_quantity, scrap_quantity, cumulative_good_quantity, cumulative_scrap_quantity,
        idempotency_key, request_hash, created_by_user_id, correlation_id
      )
      VALUES ($1, $2, $3, $4, 2, 0, 3, 0, $5, repeat('a', 64), $6, $7)
      `,
      [tenantId, factoryId, fixture.orderId, fixture.lineId, 'yield-direct-raw', TEST_USER_ID, randomUUID()],
    )).rejects.toThrow(/exceeds the order-line target/);
  });
});
