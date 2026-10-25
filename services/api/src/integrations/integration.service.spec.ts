import { BadRequestException, HttpException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { jest } from '@jest/globals';
import {
  createWebhookSignature,
  integrationRequestHash,
} from './integration-contract';
import { IntegrationService } from './integration.service';

describe('IntegrationService signed webhook ingress', () => {
  const secret = 'factoryos-webhook-test-secret-0123456789';
  const tenantId = '9ba278d1-166b-4bf0-a3bc-5b427a983391';
  const factoryId = 'a3e61b54-3b8a-4c35-bf0b-0c2d58b0534d';
  const connectorId = '4b6d2019-a69d-43d1-a9d2-ec97a71e2c49';
  const payloadSchema = {
    type: 'object',
    properties: {
      order_number: { type: 'string', minLength: 1, maxLength: 40 },
      quantity: { type: 'integer', minimum: 1 },
    },
    required: ['order_number', 'quantity'],
  };

  const connector = {
    id: connectorId,
    tenant_id: tenantId,
    factory_id: factoryId,
    display_name: 'MES webhook',
    source_system: 'MES',
    connector_type: 'SIGNED_WEBHOOK',
    status: 'ACTIVE',
    secret_reference: 'env://WEBHOOK_SECRET_MES',
    schema_version: 1,
    allowed_event_types: ['ORDER.CONFIRMED'],
    payload_schema: payloadSchema,
    created_by_user_id: '822753dc-ef72-44a0-a23d-04748105c92a',
    reviewed_by_user_id: 'b1a13175-599e-46e9-b82a-e92965b1db6f',
    reviewed_at: new Date(),
    paused_at: null,
    decision_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  function setup(existingReceipt?: {
    outbox_event_id: string;
    payload_sha256: string;
    event_type: string;
    schema_version: number;
  }, options: {
    rateLimit?: string;
    requestCount?: number;
    sourceSystem?: string;
    allowedEventTypes?: string[];
    payloadSchema?: Record<string, unknown>;
    shipmentRows?: Array<{ shipment_unit_id: string; shipment_code: string; status: string }>;
  } = {}) {
    const testConnector = {
      ...connector,
      source_system: options.sourceSystem ?? connector.source_system,
      allowed_event_types: options.allowedEventTypes ?? connector.allowed_event_types,
      payload_schema: options.payloadSchema ?? connector.payload_schema,
    };
    let transactionCount = 0;
    const clientQuery = jest.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('INSERT INTO public.integration_webhook_rate_limits')) {
        return { rows: [{ request_count: options.requestCount ?? 1 }], rowCount: 1 };
      }
      if (sql.includes('FROM wms_shipments') && sql.includes('tracking_reference')) {
        const rows = options.shipmentRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('INSERT INTO wms_shipment_delivery_events')) {
        return { rows: [{ id: 'ddf352b2-bc42-41f8-b2a9-477bd220d3c1' }], rowCount: 1 };
      }
      if (sql.includes('FROM integration_webhook_receipts')) {
        return { rows: existingReceipt ? [existingReceipt] : [], rowCount: existingReceipt ? 1 : 0 };
      }
      if (sql.includes('FROM integration_connectors') && sql.includes('FOR UPDATE')) {
        return { rows: [{ status: 'ACTIVE', secret_reference: testConnector.secret_reference, schema_version: testConnector.schema_version }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery };
    const database = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('factoryos_resolve_integration_webhook')) {
          return { rows: [{ tenant_id: tenantId, factory_id: factoryId }], rowCount: 1 };
        }
        return { rows: [testConnector], rowCount: 1 };
      }),
      transaction: jest.fn(async (...args: unknown[]) => {
        transactionCount += 1;
        const callback = args[0] as (value: typeof client) => Promise<unknown>;
        return callback(client);
      }),
    };
    const config = { get: jest.fn((key: string) => key === 'WEBHOOK_SECRET_MES' ? secret : key === 'WEBHOOK_RATE_LIMIT_PER_MINUTE' ? options.rateLimit : undefined) };
    return {
      service: new IntegrationService(database as never, config as never),
      database,
      clientQuery,
      get transactionCount() { return transactionCount; },
    };
  }

  function signedRequest(eventId: string, bodyInput?: Record<string, unknown>, timestampInput?: string) {
    const body = bodyInput ?? {
      event_type: 'ORDER.CONFIRMED',
      schema_version: 1,
      payload: { order_number: 'SO-100', quantity: 12 },
    };
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const timestamp = timestampInput ?? Math.floor(Date.now() / 1000).toString();
    return {
      request: { rawBody, body },
      timestamp,
      eventId,
      signature: createWebhookSignature(secret, timestamp, eventId, rawBody),
    };
  }

  it('atomically queues an accepted event and stores one receipt', async () => {
    const harness = setup();
    const signed = signedRequest('mes-event-101');
    const result = await harness.service.receiveWebhook(
      connectorId,
      signed.request,
      signed.timestamp,
      signed.eventId,
      signed.signature,
    );
    expect(result).toEqual(expect.objectContaining({ accepted: true, duplicate: false }));
    expect(harness.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO outbox_events'))).toBe(true);
    expect(harness.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO integration_webhook_receipts'))).toBe(true);
    const outboxInsert = harness.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO outbox_events'));
    const outboxValues = outboxInsert?.[1] as unknown[] | undefined;
    const queuedPayload = JSON.parse(String(outboxValues?.[7])) as Record<string, unknown>;
    const envelope = signed.request.body as { event_type: string; schema_version: number; payload: Record<string, unknown> };
    expect(queuedPayload.request_fingerprint_sha256).toBe(integrationRequestHash({
      event_type: envelope.event_type, schema_version: envelope.schema_version,
      correlation_id: null, payload: envelope.payload,
    }));
    expect(harness.transactionCount).toBe(2);
  });

  it('acknowledges the same external event again without creating a second outbox event', async () => {
    const signed = signedRequest('mes-event-102');
    const envelope = signed.request.body as {
      event_type: string;
      schema_version: number;
      payload: Record<string, unknown>;
    };
    const payloadHash = integrationRequestHash({
      event_type: envelope.event_type,
      schema_version: envelope.schema_version,
      correlation_id: null,
      payload: envelope.payload,
    });
    const harness = setup({
      outbox_event_id: '1f9de978-f66f-43c9-8683-d6d06ac0c5ab',
      payload_sha256: payloadHash,
      event_type: envelope.event_type,
      schema_version: envelope.schema_version,
    });
    const result = await harness.service.receiveWebhook(
      connectorId,
      signed.request,
      signed.timestamp,
      signed.eventId,
      signed.signature,
    );
    expect(result).toEqual({
      accepted: true,
      duplicate: true,
      event_id: '1f9de978-f66f-43c9-8683-d6d06ac0c5ab',
    });
    expect(harness.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO outbox_events'))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO integration_webhook_receipts'))).toBe(false);
    expect(harness.transactionCount).toBe(2);
  });

  it('rejects non-canonical whitespace in provider event IDs instead of normalizing an idempotency key', async () => {
    const harness = setup();
    const signed = signedRequest('mes-event-noncanonical');
    await expect(harness.service.receiveWebhook(
      connectorId, signed.request, signed.timestamp, signed.eventId + ' ', signed.signature,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.transactionCount).toBe(0);
    expect(harness.database.query).not.toHaveBeenCalled();
  });

  it('rejects a modified signature before opening the webhook intake transaction', async () => {
    const harness = setup();
    const signed = signedRequest('mes-event-103');
    await expect(harness.service.receiveWebhook(
      connectorId,
      signed.request,
      signed.timestamp,
      signed.eventId,
      'sha256=' + '0'.repeat(64),
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(harness.transactionCount).toBe(0);
  });


  it('rejects signed events that are not registered in the connector allowlist before creating an outbox event', async () => {
    const harness = setup();
    const unregistered = signedRequest('mes-event-unregistered', {
      event_type: 'ORDER.CANCELLED',
      schema_version: 1,
      payload: { order_number: 'SO-100', quantity: 12 },
    });
    await expect(harness.service.receiveWebhook(
      connectorId,
      unregistered.request,
      unregistered.timestamp,
      unregistered.eventId,
      unregistered.signature,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(harness.transactionCount).toBe(1);
    expect(harness.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO outbox_events'))).toBe(false);
  });

  it('rejects stale signatures and schema-version mismatch as non-retryable client errors', async () => {
    const harness = setup();
    const staleTime = (Math.floor(Date.now() / 1000) - 600).toString();
    const stale = signedRequest('mes-event-104', undefined, staleTime);
    await expect(harness.service.receiveWebhook(
      connectorId,
      stale.request,
      stale.timestamp,
      stale.eventId,
      stale.signature,
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const wrongVersion = signedRequest('mes-event-105', {
      event_type: 'ORDER.CONFIRMED',
      schema_version: 2,
      payload: { order_number: 'SO-100', quantity: 12 },
    });
    await expect(harness.service.receiveWebhook(
      connectorId,
      wrongVersion.request,
      wrongVersion.timestamp,
      wrongVersion.eventId,
      wrongVersion.signature,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(harness.transactionCount).toBe(1);
  });

  it('returns HTTP 429 when a connector exceeds its configured signed-request rate', async () => {
    const harness = setup(undefined, { rateLimit: '1', requestCount: 2 });
    const signed = signedRequest('mes-event-over-rate-limit');
    await expect(harness.service.receiveWebhook(
      connectorId, signed.request, signed.timestamp, signed.eventId, signed.signature,
    )).rejects.toMatchObject({ status: 429 });
    expect(harness.transactionCount).toBe(1);
    expect(harness.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO outbox_events'))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO integration_webhook_receipts'))).toBe(false);
  });

  const carrierPayloadSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      carrier_name: { type: 'string', minLength: 1, maxLength: 255 },
      tracking_reference: { type: 'string', minLength: 1, maxLength: 255 },
      event_type: { type: 'string', enum: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED'] },
      event_at: { type: 'string', minLength: 1, maxLength: 64 },
      recipient_name: { type: 'string', minLength: 1, maxLength: 255 },
      proof_type: { type: 'string', enum: ['SIGNATURE', 'PHOTO', 'DOCUMENT', 'OTP', 'CUSTOMER_ACKNOWLEDGEMENT'] },
      proof_reference: { type: 'string', minLength: 1, maxLength: 500 },
      proof_sha256: { type: 'string', minLength: 64, maxLength: 64 },
      signed_at: { type: 'string', minLength: 1, maxLength: 64 },
      notes: { type: 'string', maxLength: 2000 },
    },
    required: ['carrier_name', 'tracking_reference', 'event_type', 'event_at'],
  };

  it('commits a signed carrier delivery event to the WMS timeline with the webhook receipt', async () => {
    const shipmentUnitId = '51c58ea7-1207-4ac2-8b68-a4e13883cf81';
    const harness = setup(undefined, {
      sourceSystem: 'WMS_CARRIER',
      allowedEventTypes: ['WMS.SHIPMENT_DELIVERY'],
      payloadSchema: carrierPayloadSchema,
      shipmentRows: [{ shipment_unit_id: shipmentUnitId, shipment_code: 'SHIP-CARRIER-1', status: 'DISPATCHED' }],
    });
    const signed = signedRequest('carrier-event-101', {
      event_type: 'WMS.SHIPMENT_DELIVERY',
      schema_version: 1,
      payload: {
        carrier_name: 'Acme Logistics',
        tracking_reference: 'ACME-TRACK-101',
        event_type: 'IN_TRANSIT',
        event_at: new Date().toISOString(),
      },
    });
    const result = await harness.service.receiveWebhook(
      connectorId, signed.request, signed.timestamp, signed.eventId, signed.signature,
    );
    expect(result).toEqual(expect.objectContaining({ accepted: true, duplicate: false }));
    const deliveryInsert = harness.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO wms_shipment_delivery_events'));
    expect(deliveryInsert).toBeDefined();
    expect(String(deliveryInsert?.[0])).toContain("'CARRIER_WEBHOOK'");
    expect(String(deliveryInsert?.[0])).toContain('recorded_by_user_id,correlation_id');
    expect(deliveryInsert?.[1]).toEqual(expect.arrayContaining([
      tenantId, factoryId, shipmentUnitId, 'IN_TRANSIT',
    ]));
    const shipmentLookup = harness.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM wms_shipments') && String(sql).includes('tracking_reference=$4'));
    expect(shipmentLookup?.[1]).toEqual([tenantId, factoryId, 'Acme Logistics', 'ACME-TRACK-101']);
    expect(harness.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO outbox_events") &&
      String(sql).includes("'WMS.SHIPMENT_DELIVERY_EVENT_RECORDED'"))).toBe(true);
    expect(harness.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO integration_webhook_receipts'))).toBe(true);
  });

  it('rejects carrier DELIVERED events without complete proof-of-delivery metadata', async () => {
    const harness = setup(undefined, {
      sourceSystem: 'WMS_CARRIER',
      allowedEventTypes: ['WMS.SHIPMENT_DELIVERY'],
      payloadSchema: carrierPayloadSchema,
      shipmentRows: [{ shipment_unit_id: '51c58ea7-1207-4ac2-8b68-a4e13883cf81', shipment_code: 'SHIP-CARRIER-2', status: 'DISPATCHED' }],
    });
    const signed = signedRequest('carrier-event-missing-pod', {
      event_type: 'WMS.SHIPMENT_DELIVERY',
      schema_version: 1,
      payload: {
        carrier_name: 'Acme Logistics',
        tracking_reference: 'ACME-TRACK-102',
        event_type: 'DELIVERED',
        event_at: new Date().toISOString(),
      },
    });
    await expect(harness.service.receiveWebhook(
      connectorId, signed.request, signed.timestamp, signed.eventId, signed.signature,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO wms_shipment_delivery_events'))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO integration_webhook_receipts'))).toBe(false);
  });

  it('does not resolve carrier tracking references outside the connector factory shipment scope', async () => {
    const harness = setup(undefined, {
      sourceSystem: 'WMS_CARRIER',
      allowedEventTypes: ['WMS.SHIPMENT_DELIVERY'],
      payloadSchema: carrierPayloadSchema,
      shipmentRows: [],
    });
    const signed = signedRequest('carrier-event-unknown-tracking', {
      event_type: 'WMS.SHIPMENT_DELIVERY',
      schema_version: 1,
      payload: {
        carrier_name: 'Acme Logistics',
        tracking_reference: 'OTHER-FACTORY-TRACKING',
        event_type: 'IN_TRANSIT',
        event_at: new Date().toISOString(),
      },
    });
    await expect(harness.service.receiveWebhook(
      connectorId, signed.request, signed.timestamp, signed.eventId, signed.signature,
    )).rejects.toMatchObject({ status: 404 });
    expect(harness.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO wms_shipment_delivery_events'))).toBe(false);
  });

});
