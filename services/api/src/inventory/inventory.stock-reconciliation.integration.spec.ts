import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';
import { InventoryStockReconciliationService } from './inventory.stock-reconciliation.service';
import { InventoryCycleCountService } from './inventory.cycle-count.service';

describe('InventoryStockReconciliationService PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let adminPool!: Pool;
  let appPool!: Pool;
  let service!: InventoryStockReconciliationService;
  let cycleCountService!: InventoryCycleCountService;
  let reviewerUserId!: string;
  let tenantId!: string;
  let factoryId!: string;
  const itemIds: string[] = [];
  const locationIds: string[] = [];

  const createItem = async (
    quantityOnHand: string,
    quantityReserved: string,
  ): Promise<string> => {
    const itemResult = await adminPool.query<{ id: string }>(
      `
      INSERT INTO inventory_items (
        tenant_id, factory_id, sku, name, unit, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, 'PCS', $5)
      RETURNING id::text AS id
      `,
      [
        tenantId,
        factoryId,
        'RECON-' + randomUUID(),
        'Stock reconciliation integration fixture',
        TEST_USER_ID,
      ],
    );
    const itemId = itemResult.rows[0]?.id;
    if (!itemId) throw new Error('Reconciliation item fixture was not created');
    itemIds.push(itemId);

    await adminPool.query(
      `
      INSERT INTO inventory_stock_balances (
        tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
      )
      VALUES ($1, $2, $3, $4::numeric, $5::numeric)
      `,
      [tenantId, factoryId, itemId, quantityOnHand, quantityReserved],
    );
    return itemId;
  };

  const createBinWithBalance = async (
    itemId: string,
    binQuantity: string,
    defaultQuantity: string,
  ): Promise<{ binId: string; defaultLocationId: string }> => {
    const warehouse = await adminPool.query<{ id: string }>(
      `
      INSERT INTO inventory_locations (
        tenant_id, factory_id, location_code, name, location_type, created_by_user_id
      )
      VALUES ($1, $2, $3, 'Cycle-count fixture warehouse', 'WAREHOUSE', $4)
      RETURNING id::text AS id
      `,
      [tenantId, factoryId, 'CC-WH-' + randomUUID(), TEST_USER_ID],
    );
    const warehouseId = warehouse.rows[0]?.id;
    if (!warehouseId) throw new Error('Cycle-count warehouse fixture was not created');
    locationIds.push(warehouseId);

    const bin = await adminPool.query<{ id: string }>(
      `
      INSERT INTO inventory_locations (
        tenant_id, factory_id, parent_location_id,
        location_code, name, location_type, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, 'Cycle-count fixture bin', 'BIN', $5)
      RETURNING id::text AS id
      `,
      [tenantId, factoryId, warehouseId, 'CC-BIN-' + randomUUID(), TEST_USER_ID],
    );
    const binId = bin.rows[0]?.id;
    if (!binId) throw new Error('Cycle-count bin fixture was not created');
    locationIds.push(binId);

    const defaultLocation = await adminPool.query<{ id: string }>(
      `
      SELECT id::text AS id FROM inventory_locations
      WHERE tenant_id = $1 AND factory_id = $2 AND is_default = TRUE
      `,
      [tenantId, factoryId],
    );
    const defaultLocationId = defaultLocation.rows[0]?.id;
    if (!defaultLocationId) throw new Error('Default inventory location was not found');

    const fixtureClient = await adminPool.connect();
    try {
      await fixtureClient.query('BEGIN');
      await fixtureClient.query(
        `
        UPDATE inventory_location_balances
        SET quantity_on_hand = $1::numeric,
            version = version + 1,
            updated_at = clock_timestamp()
        WHERE tenant_id = $2 AND factory_id = $3
          AND item_id = $4 AND location_id = $5
        `,
        [defaultQuantity, tenantId, factoryId, itemId, defaultLocationId],
      );
      await fixtureClient.query(
        `
        INSERT INTO inventory_location_balances (
          tenant_id, factory_id, item_id, location_id,
          quantity_on_hand, quantity_reserved
        )
        VALUES ($1, $2, $3, $4, $5::numeric, 0)
        `,
        [tenantId, factoryId, itemId, binId, binQuantity],
      );
      await fixtureClient.query('COMMIT');
    } catch (error) {
      await fixtureClient.query('ROLLBACK');
      throw error;
    } finally {
      fixtureClient.release();
    }

    return { binId, defaultLocationId };
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl || !adminDatabaseUrl) {
      throw new Error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required');
    }

    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    appPool = new Pool({ connectionString: databaseUrl });

    const context = await adminPool.query<{
      tenant_id: string;
      factory_id: string;
    }>(
      `
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id
      FROM tenants t
      INNER JOIN factories f ON f.tenant_id = t.id
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at ASC, f.created_at ASC
      LIMIT 1
      `,
    );
    const row = context.rows[0];
    if (!row) throw new Error('No active tenant/factory exists for integration testing');
    tenantId = row.tenant_id;
    factoryId = row.factory_id;

    const actor = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM users WHERE id = $1 LIMIT 1',
      [TEST_USER_ID],
    );
    if (!actor.rows[0]) throw new Error('Stock reconciliation test user does not exist');

    const reviewer = await adminPool.query<{ id: string }>(
      `
      INSERT INTO users (external_subject, email, display_name, status)
      VALUES ($1, $2, 'Cycle Count Reviewer Fixture', 'ACTIVE')
      RETURNING id::text AS id
      `,
      [
        'cycle-count-reviewer-' + randomUUID(),
        'cycle-count-reviewer-' + randomUUID() + '@factoryos.test',
      ],
    );
    reviewerUserId = reviewer.rows[0]?.id ?? '';
    if (!reviewerUserId) throw new Error('Cycle-count reviewer fixture was not created');

    const database = createIntegrationDatabase(appPool);
    const audit = { record: async () => undefined } as unknown as AuditService;
    service = new InventoryStockReconciliationService(database as never, audit);
    cycleCountService = new InventoryCycleCountService(
      database as never,
      audit,
      service,
    );
  });

  afterAll(async () => {
    try {
      if (adminPool && itemIds.length > 0) {
        await adminPool.query(
          'ALTER TABLE inventory_cycle_count_proposals DISABLE TRIGGER USER',
        );
        await adminPool.query(
          'ALTER TABLE inventory_stock_reconciliations DISABLE TRIGGER USER',
        );
        await adminPool.query('ALTER TABLE inventory_movements DISABLE TRIGGER USER');
        try {
          await adminPool.query(
            `
            DELETE FROM outbox_events
            WHERE aggregate_id = ANY($1::uuid[])
               OR aggregate_id IN (
                 SELECT id FROM inventory_cycle_count_proposals
                 WHERE item_id = ANY($1::uuid[])
                 UNION
                 SELECT id FROM inventory_stock_reconciliations
                 WHERE item_id = ANY($1::uuid[])
               )
            `,
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_cycle_count_proposals WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_stock_reconciliations WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          for (const locationId of [...locationIds].reverse()) {
            await adminPool.query('DELETE FROM inventory_locations WHERE id = $1', [locationId]);
          }
          await adminPool.query(
            'DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_items WHERE id = ANY($1::uuid[])',
            [itemIds],
          );
        } finally {
          await adminPool.query(
            'ALTER TABLE inventory_movements ENABLE TRIGGER USER',
          );
          await adminPool.query(
            'ALTER TABLE inventory_stock_reconciliations ENABLE TRIGGER USER',
          );
          await adminPool.query(
            'ALTER TABLE inventory_cycle_count_proposals ENABLE TRIGGER USER',
          );
        }
      }
    } finally {
      if (adminPool && reviewerUserId) {
        await adminPool.query('DELETE FROM users WHERE id = $1', [reviewerUserId]);
      }
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
    }
  });

  it('writes a matching receipt for positive variance and safely replays the same key', async () => {
    const itemId = await createItem('8.0000', '2.0000');
    const input = {
      counted_quantity: 9.5,
      reason_code: 'OTHER' as const,
      notes: 'Verified count in storage aisle A',
    };
    const idempotencyKey = 'reconcile-positive-' + randomUUID();
    const first = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      input,
      idempotencyKey,
      randomUUID(),
      randomUUID(),
    );

    expect(first.replayed).toBe(false);
    expect(first.quantity_before).toBe('8.0000');
    expect(first.counted_quantity).toBe('9.5000');
    expect(first.quantity_delta).toBe('1.5000');
    expect(first.quantity_after).toBe('9.5000');
    expect(first.adjustment_movement_id).toBeTruthy();

    const replay = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      input,
      idempotencyKey,
      randomUUID(),
      randomUUID(),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);

    await expect(
      service.recordReconciliation(
        TEST_USER_ID, tenantId, factoryId, itemId,
        { counted_quantity: 5.25, reason_code: 'CYCLE_COUNT', notes: input.notes },
        'direct-cycle-count-bypass-' + randomUUID(), randomUUID(), randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('9.5000');

    const movement = await adminPool.query<{
      movement_type: string;
      quantity_delta: string;
      reference_type: string;
      reference_id: string;
    }>(
      `
      SELECT movement_type, quantity_delta::text AS quantity_delta,
             reference_type, reference_id::text AS reference_id
      FROM inventory_movements
      WHERE id = $1
      `,
      [first.adjustment_movement_id],
    );
    expect(movement.rows[0]).toMatchObject({
      movement_type: 'RECEIPT',
      quantity_delta: '1.5000',
      reference_type: 'STOCK_RECONCILIATION',
      reference_id: first.id,
    });

    await expect(
      service.recordReconciliation(
        TEST_USER_ID,
        tenantId,
        factoryId,
        itemId,
        { ...input, counted_quantity: 10 },
        idempotencyKey,
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('writes an issue for negative variance and refuses a count below reserved stock', async () => {
    const itemId = await createItem('10.0000', '2.0000');
    const result = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      { counted_quantity: 3, reason_code: 'OTHER' },
      'reconcile-negative-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );

    expect(result.quantity_delta).toBe('-7.0000');
    expect(result.adjustment_movement_id).toBeTruthy();
    const movement = await adminPool.query<{ movement_type: string }>(
      'SELECT movement_type FROM inventory_movements WHERE id = $1',
      [result.adjustment_movement_id],
    );
    expect(movement.rows[0]?.movement_type).toBe('ISSUE');

    await expect(
      service.recordReconciliation(
        TEST_USER_ID,
        tenantId,
        factoryId,
        itemId,
        { counted_quantity: 1.5, reason_code: 'LOSS' },
        'reconcile-below-reserved-' + randomUUID(),
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('3.0000');

    const records = await service.listReconciliations(tenantId, factoryId, itemId, 10);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(result.id);
  });

  it('submits a cycle count without touching stock and replays the same idempotency key', async () => {
    const itemId = await createItem('6.0000', '1.0000');
    const key = 'cycle-count-submit-' + randomUUID();
    const input = { counted_quantity: 5.25, notes: 'Aisle B manual count' };

    const first = await cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId, input, key, randomUUID(), randomUUID(),
    );
    const replay = await cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId, input, key, randomUUID(), randomUUID(),
    );
    expect(first.status).toBe('PENDING_REVIEW');
    expect(first.replayed).toBe(false);
    expect(first.ledger_quantity_at_count).toBe('6.0000');
    expect(first.balance_version_at_count).toBe('1');
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('6.0000');

    const changed = cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { counted_quantity: 5, notes: input.notes }, key, randomUUID(), randomUUID(),
    );
    await expect(changed).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires a different reviewer and atomically applies exactly one adjustment on approval', async () => {
    const itemId = await createItem('10.0000', '2.0000');
    const proposal = await cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { counted_quantity: 7, notes: 'Counted by operator A' },
      'cycle-count-approve-submit-' + randomUUID(), randomUUID(), randomUUID(),
    );

    await expect(
      cycleCountService.approveCycleCount(
        TEST_USER_ID, tenantId, factoryId, itemId, proposal.id, {},
        'cycle-count-self-approve-' + randomUUID(), randomUUID(), randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      adminPool.query(
        'UPDATE inventory_cycle_count_proposals SET ledger_quantity_at_count = 99 WHERE id = $1',
        [proposal.id],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    await expect(
      adminPool.query(
        `
        UPDATE inventory_cycle_count_proposals
        SET status = 'REJECTED',
            reviewed_by_user_id = created_by_user_id,
            reviewed_at = clock_timestamp(),
            review_decision = 'REJECT',
            review_idempotency_key = $1,
            review_request_hash = $2,
            review_note = 'attempted self-review'
        WHERE id = $3
        `,
        ['cycle-count-forged-review-' + randomUUID(), '0'.repeat(64), proposal.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const approvalKey = 'cycle-count-approve-' + randomUUID();
    const first = await cycleCountService.approveCycleCount(
      reviewerUserId, tenantId, factoryId, itemId, proposal.id,
      { review_note: 'Physical count evidence checked' },
      approvalKey, randomUUID(), randomUUID(),
    );
    const replay = await cycleCountService.approveCycleCount(
      reviewerUserId, tenantId, factoryId, itemId, proposal.id,
      { review_note: 'Physical count evidence checked' },
      approvalKey, randomUUID(), randomUUID(),
    );
    expect(first.replayed).toBe(false);
    expect(first.reason_code).toBe('CYCLE_COUNT');
    expect(first.quantity_delta).toBe('-3.0000');
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('7.0000');

    const proposalState = await adminPool.query<{
      status: string;
      reviewed_by_user_id: string;
      reconciliation_id: string;
    }>(
      `
      SELECT status, reviewed_by_user_id::text AS reviewed_by_user_id,
             reconciliation_id::text AS reconciliation_id
      FROM inventory_cycle_count_proposals WHERE id = $1
      `,
      [proposal.id],
    );
    expect(proposalState.rows[0]).toMatchObject({
      status: 'APPLIED',
      reviewed_by_user_id: reviewerUserId,
      reconciliation_id: first.id,
    });

    const issueCount = await adminPool.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM inventory_movements
      WHERE item_id = $1 AND reference_type = 'STOCK_RECONCILIATION'
      `,
      [itemId],
    );
    expect(issueCount.rows[0]?.count).toBe('1');
  });

  it('rejects a pending cycle count with a reason and leaves the balance unchanged', async () => {
    const itemId = await createItem('5.0000', '1.0000');
    const proposal = await cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { counted_quantity: 9 }, 'cycle-count-reject-submit-' + randomUUID(),
      randomUUID(), randomUUID(),
    );
    const rejectionKey = 'cycle-count-reject-' + randomUUID();
    const rejected = await cycleCountService.rejectCycleCount(
      reviewerUserId, tenantId, factoryId, itemId, proposal.id,
      { review_note: 'Count evidence needs recount' },
      rejectionKey, randomUUID(), randomUUID(),
    );
    const replay = await cycleCountService.rejectCycleCount(
      reviewerUserId, tenantId, factoryId, itemId, proposal.id,
      { review_note: 'Count evidence needs recount' },
      rejectionKey, randomUUID(), randomUUID(),
    );
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.replayed).toBe(false);
    expect(replay.replayed).toBe(true);

    await expect(
      cycleCountService.approveCycleCount(
        reviewerUserId, tenantId, factoryId, itemId, proposal.id, {},
        'cycle-count-approve-rejected-' + randomUUID(), randomUUID(), randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('5.0000');
  });

  it('refuses to apply a stale count if stock changes before approval', async () => {
    const itemId = await createItem('6.0000', '1.0000');
    const proposal = await cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { counted_quantity: 5, notes: 'Count captured before late receipt' },
      'cycle-count-stale-submit-' + randomUUID(), randomUUID(), randomUUID(),
    );

    await service.recordReconciliation(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { counted_quantity: 8, reason_code: 'OTHER', notes: 'Receipt arrived after counting' },
      'stock-changed-after-count-' + randomUUID(), randomUUID(), randomUUID(),
    );

    await expect(
      cycleCountService.approveCycleCount(
        reviewerUserId, tenantId, factoryId, itemId, proposal.id,
        { review_note: 'Trying to approve stale physical count' },
        'cycle-count-stale-approve-' + randomUUID(), randomUUID(), randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const storedProposal = await adminPool.query<{ status: string }>(
      'SELECT status FROM inventory_cycle_count_proposals WHERE id = $1',
      [proposal.id],
    );
    expect(storedProposal.rows[0]?.status).toBe('PENDING_REVIEW');

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('8.0000');
  });

  it('requires a variance reason and applies a bin-scoped count exactly once', async () => {
    const itemId = await createItem('10.0000', '1.0000');
    const { binId } = await createBinWithBalance(itemId, '4.0000', '6.0000');
    const submitKey = 'cycle-count-bin-submit-' + randomUUID();

    await expect(
      cycleCountService.submitCycleCount(
        TEST_USER_ID, tenantId, factoryId, itemId,
        { counted_quantity: 3, location_id: binId },
        submitKey, randomUUID(), randomUUID(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const proposal = await cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId,
      {
        counted_quantity: 3,
        location_id: binId,
        variance_reason_code: 'LOSS',
        notes: 'Physical bin recount',
      },
      submitKey, randomUUID(), randomUUID(),
    );
    expect(proposal.status).toBe('PENDING_REVIEW');
    expect(proposal.ledger_quantity_at_count).toBe('10.0000');
    expect(proposal.location_quantity_at_count).toBe('4.0000');
    expect(proposal.location_version_at_count).toBeDefined();
    expect(proposal.variance_reason_code).toBe('LOSS');

    await expect(
      adminPool.query(
        `UPDATE inventory_cycle_count_proposals
         SET location_version_at_count = location_version_at_count + 1
         WHERE id = $1`,
        [proposal.id],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const approvalKey = 'cycle-count-bin-approve-' + randomUUID();
    const decisions = await Promise.all([
      cycleCountService.approveCycleCount(
        reviewerUserId, tenantId, factoryId, itemId, proposal.id,
        { review_note: 'Independent reviewer verified the bin count' },
        approvalKey, randomUUID(), randomUUID(),
      ),
      cycleCountService.approveCycleCount(
        reviewerUserId, tenantId, factoryId, itemId, proposal.id,
        { review_note: 'Independent reviewer verified the bin count' },
        approvalKey, randomUUID(), randomUUID(),
      ),
    ]);
    expect(decisions.filter((decision) => !decision.replayed)).toHaveLength(1);
    expect(decisions.filter((decision) => decision.replayed)).toHaveLength(1);
    const first = decisions.find((decision) => !decision.replayed)!;
    const replay = decisions.find((decision) => decision.replayed)!;

    expect(first.quantity_before).toBe('10.0000');
    expect(first.counted_quantity).toBe('9.0000');
    expect(first.quantity_delta).toBe('-1.0000');
    expect(first.reason_code).toBe('LOSS');
    expect(first.location_id).toBe(binId);
    expect(first.location_quantity_before).toBe('4.0000');
    expect(first.location_counted_quantity).toBe('3.0000');
    expect(first.location_quantity_after).toBe('3.0000');
    expect(first.replayed).toBe(false);
    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);

    const aggregate = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    const binBalance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_location_balances WHERE item_id = $1 AND location_id = $2',
      [itemId, binId],
    );
    const movements = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM inventory_movements
       WHERE item_id = $1 AND reference_type = 'STOCK_RECONCILIATION'`,
      [itemId],
    );
    expect(aggregate.rows[0]?.quantity_on_hand).toBe('9.0000');
    expect(binBalance.rows[0]?.quantity_on_hand).toBe('3.0000');
    expect(movements.rows[0]?.count).toBe('1');
  });

  it('rejects approval when a bin version changes after count submission and rolls back all review effects', async () => {
    const itemId = await createItem('10.0000', '1.0000');
    const { binId, defaultLocationId } = await createBinWithBalance(itemId, '4.0000', '6.0000');
    const proposal = await cycleCountService.submitCycleCount(
      TEST_USER_ID, tenantId, factoryId, itemId,
      {
        counted_quantity: 5,
        location_id: binId,
        variance_reason_code: 'FOUND_STOCK',
      },
      'cycle-count-bin-stale-submit-' + randomUUID(), randomUUID(), randomUUID(),
    );

    const transferClient = await adminPool.connect();
    try {
      await transferClient.query('BEGIN');
      await transferClient.query(
        `UPDATE inventory_location_balances
         SET quantity_on_hand = quantity_on_hand + 1, version = version + 1,
             updated_at = clock_timestamp()
         WHERE item_id = $1 AND location_id = $2`,
        [itemId, binId],
      );
      await transferClient.query(
        `UPDATE inventory_location_balances
         SET quantity_on_hand = quantity_on_hand - 1, version = version + 1,
             updated_at = clock_timestamp()
         WHERE item_id = $1 AND location_id = $2`,
        [itemId, defaultLocationId],
      );
      await transferClient.query('COMMIT');
    } catch (error) {
      await transferClient.query('ROLLBACK');
      throw error;
    } finally {
      transferClient.release();
    }

    await expect(
      cycleCountService.approveCycleCount(
        reviewerUserId, tenantId, factoryId, itemId, proposal.id,
        { review_note: 'Reject a stale bin count' },
        'cycle-count-bin-stale-approve-' + randomUUID(), randomUUID(), randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const storedProposal = await adminPool.query<{ status: string }>(
      'SELECT status FROM inventory_cycle_count_proposals WHERE id = $1',
      [proposal.id],
    );
    const aggregate = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    const reconciliations = await adminPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM inventory_stock_reconciliations WHERE item_id = $1',
      [itemId],
    );
    expect(storedProposal.rows[0]?.status).toBe('PENDING_REVIEW');
    expect(aggregate.rows[0]?.quantity_on_hand).toBe('10.0000');
    expect(reconciliations.rows[0]?.count).toBe('0');
  });

  it('records zero variance without creating a no-op movement', async () => {
    const itemId = await createItem('4.0000', '1.0000');
    const result = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      { counted_quantity: 4, reason_code: 'OTHER' },
      'reconcile-zero-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );

    expect(result.quantity_delta).toBe('0.0000');
    expect(result.adjustment_movement_id).toBeNull();

    const movementCount = await adminPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM inventory_movements WHERE item_id = $1',
      [itemId],
    );
    expect(movementCount.rows[0]?.count).toBe('0');

    const records = await service.listReconciliations(tenantId, factoryId, itemId, 10);
    expect(records).toHaveLength(1);
    expect(records[0]?.adjustment_movement_id).toBeNull();
  });
});
