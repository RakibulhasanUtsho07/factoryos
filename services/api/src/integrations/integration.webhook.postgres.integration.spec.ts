import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { IntegrationService } from './integration.service';
import { createWebhookSignature } from './integration-contract';
import { createIntegrationDatabase } from '../database/integration-database.adapter';

interface IntegrationFixture {
  tenant_id: string;
  factory_id: string;
  creator_user_id: string;
  reviewer_user_id: string;
}

describe('Signed webhook integration PostgreSQL boundary', () => {
  const runId = randomUUID();
  const secret = 'integration-webhook-ci-secret-value-012345';
  let adminPool: Pool;
  let appPool: Pool;
  let service: IntegrationService;
  let fixture: IntegrationFixture;
  let connectorId: string;

  const payloadSchema = {
    type: 'object',
    properties: {
      work_order: { type: 'string', minLength: 1, maxLength: 80 },
      good_quantity: { type: 'integer', minimum: 0, maximum: 100000 },
    },
    required: ['work_order', 'good_quantity'],
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for webhook PostgreSQL integration tests');
    if (!adminDatabaseUrl) throw new Error('TEST_ADMIN_DATABASE_URL is required for webhook PostgreSQL integration tests');

    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    appPool = new Pool({ connectionString: databaseUrl });

    const fixtureResult = await adminPool.query<IntegrationFixture>(
      'SELECT o.tenant_id::text AS tenant_id,o.factory_id::text AS factory_id,' +
      'm1.user_id::text AS creator_user_id,m2.user_id::text AS reviewer_user_id ' +
      'FROM orders o ' +
      'INNER JOIN tenant_memberships m1 ON m1.tenant_id=o.tenant_id AND m1.status=$1 ' +
      'INNER JOIN users u1 ON u1.id=m1.user_id AND u1.status=$1 ' +
      'INNER JOIN tenant_memberships m2 ON m2.tenant_id=o.tenant_id AND m2.status=$1 AND m2.user_id<>m1.user_id ' +
      'INNER JOIN users u2 ON u2.id=m2.user_id AND u2.status=$1 ' +
      'WHERE o.factory_id IS NOT NULL ORDER BY o.created_at DESC,m1.created_at,m2.created_at LIMIT 1',
      ['ACTIVE'],
    );
    if (!fixtureResult.rows[0]) {
      throw new Error('A tenant/factory with two active members is required for maker-checker integration verification');
    }
    fixture = fixtureResult.rows[0];

    const database = createIntegrationDatabase(appPool);
    const config = { get: (key: string) => key === 'WEBHOOK_SECRET_INTEGRATION_CI' ? secret : undefined };
    service = new IntegrationService(database as never, config as never);

    const registered = await service.registerConnector(
      fixture.creator_user_id,
      fixture.tenant_id,
      fixture.factory_id,
      {
        display_name: 'Webhook integration ' + runId,
        source_system: 'CI_INTEGRATION',
        secret_reference: 'env://WEBHOOK_SECRET_INTEGRATION_CI',
        schema_version: 1,
        allowed_event_types: ['MES.PRODUCTION.COUNTED'],
        payload_schema: payloadSchema,
      },
      'connector-registration-' + runId,
    );
    connectorId = registered.id;
    expect(registered.status).toBe('PENDING_REVIEW');

    const activated = await service.transitionConnector(
      fixture.reviewer_user_id,
      fixture.tenant_id,
      fixture.factory_id,
      connectorId,
      'ACTIVATE',
      'CI maker-checker approval',
    );
    expect(activated.status).toBe('ACTIVE');
  });

  afterAll(async () => {
    if (appPool) await appPool.end();
    if (adminPool) await adminPool.end();
    // Keep accepted events, immutable receipts and connector history in the disposable CI database.
  });

  it('persists a signed event and its immutable receipt, and safely acknowledges a duplicate', async () => {
    const eventId = 'ci-webhook-' + runId;
    const body = {
      event_type: 'MES.PRODUCTION.COUNTED',
      schema_version: 1,
      payload: { work_order: 'WO-' + runId, good_quantity: 7 },
    };
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createWebhookSignature(secret, timestamp, eventId, rawBody);
    const request = { rawBody, body };

    const accepted = await service.receiveWebhook(connectorId, request, timestamp, eventId, signature);
    expect(accepted).toEqual(expect.objectContaining({ accepted: true, duplicate: false }));
    const acceptedEventId = accepted.event_id;

    const repeatedTimestamp = (Number(timestamp) + 1).toString();
    const repeatedSignature = createWebhookSignature(secret, repeatedTimestamp, eventId, rawBody);
    const repeated = await service.receiveWebhook(connectorId, request, repeatedTimestamp, eventId, repeatedSignature);
    expect(repeated).toEqual({ accepted: true, duplicate: true, event_id: acceptedEventId });

    const event = await adminPool.query<{
      status: string;
      event_type: string;
      event_version: number;
      payload: Record<string, unknown>;
    }>(
      'SELECT status,event_type,event_version,payload FROM outbox_events WHERE id=$1 AND tenant_id=$2',
      [acceptedEventId, fixture.tenant_id],
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.event_type).toBe('INTEGRATION.WEBHOOK_RECEIVED');
    expect(Number(event.rows[0]?.event_version)).toBe(1);
    expect(event.rows[0]?.payload.source_event_type).toBe('MES.PRODUCTION.COUNTED');
    expect(event.rows[0]?.payload.source_schema_version).toBe(1);

    const receipts = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM integration_webhook_receipts WHERE tenant_id=$1 AND connector_id=$2 AND external_event_id=$3',
      [fixture.tenant_id, connectorId, eventId],
    );
    expect(Number(receipts.rows[0]?.count)).toBe(1);
  });

  it('rejects invalid signatures and prevents an event id from being reused for different content', async () => {
    const eventId = 'ci-webhook-conflict-' + runId;
    const body = {
      event_type: 'MES.PRODUCTION.COUNTED',
      schema_version: 1,
      payload: { work_order: 'WO-' + runId, good_quantity: 7 },
    };
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createWebhookSignature(secret, timestamp, eventId, rawBody);
    const accepted = await service.receiveWebhook(connectorId, { rawBody, body }, timestamp, eventId, signature);

    await expect(service.receiveWebhook(
      connectorId,
      { rawBody, body },
      timestamp,
      eventId,
      'sha256=' + '0'.repeat(64),
    )).rejects.toThrow('Webhook signature verification failed');

    const changedBody = {
      event_type: 'MES.PRODUCTION.COUNTED',
      schema_version: 1,
      payload: { work_order: 'WO-' + runId, good_quantity: 8 },
    };
    const changedRawBody = Buffer.from(JSON.stringify(changedBody), 'utf8');
    const changedSignature = createWebhookSignature(secret, timestamp, eventId, changedRawBody);
    await expect(service.receiveWebhook(
      connectorId,
      { rawBody: changedRawBody, body: changedBody },
      timestamp,
      eventId,
      changedSignature,
    )).rejects.toThrow('already accepted with a different payload');

    const receipts = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM integration_webhook_receipts WHERE tenant_id=$1 AND connector_id=$2 AND external_event_id=$3',
      [fixture.tenant_id, connectorId, eventId],
    );
    expect(accepted.duplicate).toBe(false);
    expect(Number(receipts.rows[0]?.count)).toBe(1);
  });
});
