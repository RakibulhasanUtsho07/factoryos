import { ValidationPipe } from '@nestjs/common';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import { Pool } from 'pg';
import request from 'supertest';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { SyncOfflineBatchDto } from './dto/wms-mobile.dto';
import { InventoryService } from './inventory.service';
import { WmsMobileController } from './wms.mobile.controller';
import { WmsMobileService } from './wms.mobile.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;
const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TEST_AUTH_TOKEN = 'wms-offline-sync-postgres-test-only';

type WmsTestRequest = Request & {
  factoryos?: {
    requestId: string;
    traceId: string;
    userId: string;
    tenantId: string;
    factoryId: string;
  };
};

postgresDescribe('WMS mobile offline sync HTTP + PostgreSQL acceptance', () => {
  let app: INestApplication;
  let adminPool: Pool;
  let appPool: Pool;
  let tenantId: string;
  let factoryId: string;
  let mobileService: WmsMobileService;
  const itemIds: string[] = [];
  const deviceIds: string[] = [];
  const correlationIds: string[] = [];

  const createItem = async (quantityOnHand: string) => {
    const created = await adminPool.query<{ id: string }>(`
      INSERT INTO inventory_items (
        tenant_id, factory_id, sku, name, unit, created_by_user_id
      ) VALUES ($1,$2,$3,'WMS HTTP offline-sync acceptance item','PCS',$4)
      RETURNING id::text AS id
    `, [tenantId, factoryId, 'WMS-HTTP-OFFLINE-' + randomUUID(), TEST_USER_ID]);
    const itemId = created.rows[0]?.id;
    if (!itemId) throw new Error('WMS HTTP integration item was not created');
    itemIds.push(itemId);
    await adminPool.query(`
      INSERT INTO inventory_stock_balances (
        tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
      ) VALUES ($1,$2,$3,$4::numeric,0)
    `, [tenantId, factoryId, itemId, quantityOnHand]);
    return itemId;
  };

  const getBalance = async (itemId: string) => {
    const result = await adminPool.query<{
      quantity_on_hand: string;
      version: string;
    }>(`
      SELECT quantity_on_hand::text AS quantity_on_hand, version::text AS version
      FROM inventory_stock_balances
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
    `, [tenantId, factoryId, itemId]);
    const balance = result.rows[0];
    if (!balance) throw new Error('WMS HTTP integration stock balance was not found');
    return balance;
  };

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
    if (!scope.rows[0]) throw new Error('No active tenant/factory exists for WMS HTTP integration tests');
    tenantId = scope.rows[0].tenant_id;
    factoryId = scope.rows[0].factory_id;

    const actor = await adminPool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [TEST_USER_ID]);
    if (!actor.rows[0]) throw new Error('WMS HTTP integration test actor is missing');

    const database = createIntegrationDatabase(appPool);
    const audit = { record: async () => undefined } as unknown as AuditService;
    const inventoryService = new InventoryService(database as never, audit);
    mobileService = new WmsMobileService(database as never, inventoryService);

    // This guard is deliberately test-only: it injects a controlled request
    // context so this suite exercises real HTTP routing, DTO validation,
    // controller handling and PostgreSQL persistence without relying on a
    // deployed identity provider. Production authorization remains separate.
    const testGuard: CanActivate = {
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest<WmsTestRequest>();
        if (req.header('x-wms-test-auth') !== TEST_AUTH_TOKEN) return false;
        const requestId = randomUUID();
        const traceId = randomUUID();
        correlationIds.push(requestId, traceId);
        req.factoryos = { requestId, traceId, userId: TEST_USER_ID, tenantId, factoryId };
        return true;
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [WmsMobileController],
      providers: [
        { provide: WmsMobileService, useValue: mobileService },
        { provide: PermissionGuard, useValue: testGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }));
    await app.init();
  });

  afterAll(async () => {
    try {
      if (adminPool) {
        // The ledger and receipt tables are append-only in application use.
        // Disable user triggers only during teardown of these unique fixtures.
        const triggerTables = [
          'mobile_offline_sync_attempts',
          'mobile_offline_sync_receipts',
          'inventory_movements',
          'inventory_stock_balances',
          'inventory_items',
          'outbox_events',
          'audit_events',
        ];
        for (const table of triggerTables) {
          await adminPool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        }
        try {
          await adminPool.query('DELETE FROM audit_events WHERE correlation_id = ANY($1::uuid[])', [correlationIds]);
          await adminPool.query('DELETE FROM outbox_events WHERE correlation_id = ANY($1::uuid[])', [correlationIds]);
          await adminPool.query(
            'DELETE FROM mobile_offline_sync_attempts WHERE device_id = ANY($1::text[])',
            [deviceIds],
          );
          await adminPool.query(
            'DELETE FROM mobile_offline_sync_receipts WHERE device_id = ANY($1::text[])',
            [deviceIds],
          );
          await adminPool.query('DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
        } finally {
          for (const table of triggerTables.reverse()) {
            await adminPool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
          }
        }
      }
    } finally {
      if (app) await app.close();
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
    }
  });

  it('routes an offline issue through HTTP and replays after a deliberately discarded response without a second movement', async () => {
    const itemId = await createItem('10.0000');
    const initial = await getBalance(itemId);
    const deviceId = 'WMS-HTTP-RETRY-' + randomUUID();
    deviceIds.push(deviceId);
    const clientTransactionId = randomUUID();
    const batch: SyncOfflineBatchDto = {
      device_id: deviceId,
      transactions: [{
        client_transaction_id: clientTransactionId,
        operation: 'STOCK_MOVEMENT',
        item_id: itemId,
        movement_type: 'ISSUE',
        quantity: 2,
        expected_balance_version: initial.version,
        notes: 'HTTP acceptance fixture; response intentionally discarded before retry',
      }],
    };

    // Model a client that cannot use the first response: send the real HTTP
    // request, intentionally discard its body, then retry the exact payload.
    await request(app.getHttpServer())
      .post('/api/wms/mobile/offline-sync/batches')
      .set('x-wms-test-auth', TEST_AUTH_TOKEN)
      .send(batch)
      .expect(201);

    const retry = await request(app.getHttpServer())
      .post('/api/wms/mobile/offline-sync/batches')
      .set('x-wms-test-auth', TEST_AUTH_TOKEN)
      .send(batch)
      .expect(201);

    expect(retry.body).toMatchObject({
      device_id: deviceId,
      received_count: 1,
      applied_count: 1,
      conflict_count: 0,
      rejected_count: 0,
    });
    expect(retry.body.results[0]).toMatchObject({
      client_transaction_id: clientTransactionId,
      status: 'APPLIED',
      replayed: true,
    });

    const receipts = await adminPool.query<{
      id: string;
      result_status: string;
      result: { movement?: { id?: string } };
    }>(`
      SELECT id::text AS id, result_status, result
      FROM mobile_offline_sync_receipts
      WHERE tenant_id = $1 AND factory_id = $2
        AND device_id = $3 AND client_transaction_id = $4::uuid
    `, [tenantId, factoryId, deviceId, clientTransactionId]);
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]?.result_status).toBe('APPLIED');
    expect(retry.body.results[0]?.receipt_id).toBe(receipts.rows[0]?.id);
    const movementId = receipts.rows[0]?.result.movement?.id;
    expect(movementId).toEqual(expect.any(String));

    const balance = await getBalance(itemId);
    expect(balance.quantity_on_hand).toBe('8.0000');

    const movements = await adminPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM inventory_movements
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
        AND movement_type = 'ISSUE'
    `, [tenantId, factoryId, itemId]);
    expect(movements.rows[0]?.count).toBe('1');

    const receiptEvidence = await adminPool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM audit_events
          WHERE tenant_id = $1 AND factory_id = $2
            AND resource_type = 'MOBILE_OFFLINE_SYNC_RECEIPT'
            AND resource_id = $3::uuid AND action = 'RECORDED') AS audits,
        (SELECT count(*)::text FROM outbox_events
          WHERE tenant_id = $1 AND factory_id = $2
            AND aggregate_type = 'MOBILE_OFFLINE_SYNC_RECEIPT'
            AND aggregate_id = $3::uuid
            AND event_type = 'WMS.MOBILE_OFFLINE_SYNC_RESULT_RECORDED') AS outbox
    `, [tenantId, factoryId, receipts.rows[0]?.id]);
    expect(receiptEvidence.rows[0]).toEqual({ audits: '1', outbox: '1' });

    const attempts = await adminPool.query<{ outcome: string; count: string }>(`
      SELECT outcome, count(*)::text AS count
      FROM mobile_offline_sync_attempts
      WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3
      GROUP BY outcome ORDER BY outcome
    `, [tenantId, factoryId, deviceId]);
    expect(attempts.rows).toEqual([
      { outcome: 'APPLIED', count: '1' },
      { outcome: 'REPLAYED', count: '1' },
    ]);

    // A client transaction UUID cannot be reused with a different operation.
    const changedPayload: SyncOfflineBatchDto = {
      ...batch,
      transactions: [{ ...batch.transactions[0]!, quantity: 3 }],
    };
    const conflicting = await request(app.getHttpServer())
      .post('/api/wms/mobile/offline-sync/batches')
      .set('x-wms-test-auth', TEST_AUTH_TOKEN)
      .send(changedPayload)
      .expect(201);
    expect(conflicting.body.results[0]).toMatchObject({
      client_transaction_id: clientTransactionId,
      status: 'CONFLICT',
      replayed: false,
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    expect((await getBalance(itemId)).quantity_on_hand).toBe('8.0000');
    const finalMovements = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM inventory_movements WHERE item_id = $1',
      [itemId],
    );
    expect(finalMovements.rows[0]?.count).toBe('1');
    const finalReceipts = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM mobile_offline_sync_receipts WHERE device_id = $1',
      [deviceId],
    );
    expect(finalReceipts.rows[0]?.count).toBe('1');
  });

  it('rejects unauthenticated and malformed HTTP requests before touching stock', async () => {
    const batch = {
      device_id: 'WMS-HTTP-INVALID',
      transactions: [{
        client_transaction_id: randomUUID(),
        operation: 'STOCK_MOVEMENT',
        item_id: randomUUID(),
        movement_type: 'ISSUE',
        quantity: 1,
        expected_balance_version: '1',
        unexpected_field: 'must be rejected',
      }],
    };
    await request(app.getHttpServer())
      .post('/api/wms/mobile/offline-sync/batches')
      .send(batch)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/wms/mobile/offline-sync/batches')
      .set('x-wms-test-auth', TEST_AUTH_TOKEN)
      .send(batch)
      .expect(400);

    const receipts = await adminPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mobile_offline_sync_receipts WHERE device_id = 'WMS-HTTP-INVALID'",
    );
    expect(receipts.rows[0]?.count).toBe('0');
  });
});
