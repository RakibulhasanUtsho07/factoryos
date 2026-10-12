import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';

import { EdgeDeviceGatewayService } from './edge-device-gateway.service';
import { EdgeDeviceProtocol } from './dto/register-edge-device.dto';
import {
  EdgeObservationQuality,
  EdgeObservationSourceMode,
} from './dto/sync-edge-observations.dto';

interface ScopeRow {
  tenant_id: string;
  factory_id: string;
  user_id: string;
}

describe('EdgeDeviceGatewayService PostgreSQL integration', () => {
  let pool!: Pool;
  let client!: PoolClient;
  let service!: EdgeDeviceGatewayService;
  let tenantId!: string;
  let factoryId!: string;
  let userId!: string;

  beforeAll(async () => {
    const url = process.env.TEST_ADMIN_DATABASE_URL;
    if (!url) throw new Error('TEST_ADMIN_DATABASE_URL is required');

    pool = new Pool({ connectionString: url });
    client = await pool.connect();
    await client.query('BEGIN');

    const scope = await client.query<ScopeRow>(`
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id, u.id::text AS user_id
      FROM tenants t
      JOIN factories f ON f.tenant_id = t.id
      JOIN tenant_memberships tm ON tm.tenant_id = t.id AND tm.status = 'ACTIVE'
      JOIN users u ON u.id = tm.user_id AND u.status = 'ACTIVE'
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at, f.created_at, u.created_at
      LIMIT 1
    `);
    if (!scope.rows[0]) throw new Error('No active tenant/factory/user fixture');

    tenantId = scope.rows[0].tenant_id;
    factoryId = scope.rows[0].factory_id;
    userId = scope.rows[0].user_id;

    const database = {
      query: async (query: string, values?: unknown[], context?: { tenantId?: string; userId?: string | null }) => {
        if (context) {
          await client.query(
            `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
            [context.tenantId ?? '', context.userId ?? ''],
          );
        }
        return client.query(query, values);
      },
      transaction: async (
        callback: (transactionClient: unknown) => Promise<unknown>,
        context?: { tenantId?: string; userId?: string | null },
      ) => {
        if (context) {
          await client.query(
            `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
            [context.tenantId ?? '', context.userId ?? ''],
          );
        }
        return callback(client);
      },
    };
    const iam = {
      authorize: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    const audit = {
      record: jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('audit-id'),
    };
    service = new EdgeDeviceGatewayService(database as never, iam as never, audit as never);
  }, 60000);

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  it('persists device registration, reconnect deduplication, and append-only telemetry', async () => {
    const unique = randomUUID();
    const registration = {
      device_key: `edge-${unique}`,
      display_name: 'CI edge gateway',
      protocol: EdgeDeviceProtocol.GENERIC,
      capability_profile: { cpu: 'test-runner', memory_mb: 128 },
    };
    const created = await service.registerDevice(
      tenantId,
      factoryId,
      userId,
      registration as never,
    );

    expect(created.idempotent).toBe(false);
    const observation = {
      event_id: randomUUID(),
      signal_key: 'line.temperature',
      observed_at: new Date().toISOString(),
      source_mode: EdgeObservationSourceMode.EDGE_OFFLINE,
      quality: EdgeObservationQuality.GOOD,
      payload: { value: 27.5, unit: 'C' },
    };
    const batch = {
      batch_key: `reconnect-${unique}`,
      observations: [observation],
    };

    const first = await service.syncObservations(
      tenantId,
      factoryId,
      userId,
      created.device.id,
      batch as never,
    );
    const replay = await service.syncObservations(
      tenantId,
      factoryId,
      userId,
      created.device.id,
      batch as never,
    );

    expect(first.idempotent).toBe(false);
    expect(first.summary.observationsInserted).toBe(1);
    expect(replay.idempotent).toBe(true);
    expect(replay.summary.id).toBe(first.summary.id);

    const count = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM edge_observations WHERE tenant_id = $1 AND device_id = $2`,
      [tenantId, created.device.id],
    );
    expect(count.rows[0]?.count).toBe('1');

    await client.query('SAVEPOINT edge_observation_immutable');
    await expect(
      client.query(
        `UPDATE edge_observations SET quality = 'BAD' WHERE tenant_id = $1 AND device_id = $2`,
        [tenantId, created.device.id],
      ),
    ).rejects.toThrow('Edge observations and sync batches are append-only');
    await client.query('ROLLBACK TO SAVEPOINT edge_observation_immutable');
  });
});
