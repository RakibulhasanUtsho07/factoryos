import {
  assertPayloadSchema,
  assertValidWebhookSignature,
  createWebhookSignature,
  IntegrationContractError,
  integrationRequestHash,
  validateWebhookEnvelope,
  validateWebhookSecretReference,
} from './integration-contract';

describe('Integration webhook contract', () => {
  const schema = {
    type: 'object',
    properties: {
      order_number: { type: 'string', minLength: 1, maxLength: 40 },
      quantity: { type: 'integer', minimum: 1, maximum: 100000 },
      attributes: {
        type: 'object',
        properties: { source: { type: 'string', enum: ['ERP', 'MES'] } },
        required: ['source'],
      },
      tags: { type: 'array', items: { type: 'string', maxLength: 20 }, maxItems: 5 },
    },
    required: ['order_number', 'quantity'],
  } as const;

  it('accepts a payload that conforms to the registered schema and version', () => {
    const envelope = validateWebhookEnvelope({
      event_type: 'ORDER.CONFIRMED',
      schema_version: 3,
      correlation_id: 'd2719d9d-fd1f-4fe0-8b15-b06e7ad132f2',
      payload: { order_number: 'SO-7', quantity: 42, attributes: { source: 'ERP' }, tags: ['urgent'] },
    }, 3, schema as unknown as Record<string, unknown>);
    expect(envelope.event_type).toBe('ORDER.CONFIRMED');
    expect(envelope.payload.quantity).toBe(42);
  });

  it('rejects unsupported schema keywords and open-ended object schemas', () => {
    expect(() => assertPayloadSchema({ type: 'object', properties: {}, patternProperties: {} }))
      .toThrow('unsupported schema keyword');
    expect(() => assertPayloadSchema({ type: 'object', properties: {}, additionalProperties: true }))
      .toThrow('additionalProperties must be false');
  });

  it('rejects extra payload fields and missing required fields', () => {
    expect(() => validateWebhookEnvelope({
      event_type: 'ORDER.CREATED',
      schema_version: 3,
      payload: { order_number: 'SO-7', quantity: 1, tenant_id: 'forged' },
    }, 3, schema as unknown as Record<string, unknown>)).toThrow('is not allowed');
    expect(() => validateWebhookEnvelope({
      event_type: 'ORDER.CREATED',
      schema_version: 3,
      payload: { quantity: 1 },
    }, 3, schema as unknown as Record<string, unknown>)).toThrow('is required');
  });

  it('rejects mismatched schema versions, invalid event identifiers and unsafe schema shapes', () => {
    expect(() => validateWebhookEnvelope({
      event_type: 'order.created',
      schema_version: 3,
      payload: { order_number: 'SO-7', quantity: 1 },
    }, 3, schema as unknown as Record<string, unknown>)).toThrow('canonical uppercase');
    expect(() => validateWebhookEnvelope({
      event_type: 'ORDER.CREATED',
      schema_version: 2,
      payload: { order_number: 'SO-7', quantity: 1 },
    }, 3, schema as unknown as Record<string, unknown>)).toThrow('does not match');
    expect(() => assertPayloadSchema({ type: 'object', properties: { constructor: { type: 'string' } } }))
      .toThrow('unsafe property');
    let deeplyNestedSchema: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 9; depth += 1) {
      deeplyNestedSchema = { type: 'array', items: deeplyNestedSchema };
    }
    expect(() => assertPayloadSchema(deeplyNestedSchema)).toThrow('maximum schema depth');
  });

  it('signs exact raw bytes and binds the signature to timestamp and provider event id', () => {
    const secret = 'a'.repeat(40);
    const body = Buffer.from('{"event_type":"ORDER.CREATED","schema_version":1,"payload":{}}', 'utf8');
    const timestamp = '1792350000';
    const eventId = 'provider-delivery-102';
    const signature = createWebhookSignature(secret, timestamp, eventId, body);
    expect(assertValidWebhookSignature(secret, timestamp, eventId, signature, body, 1792350000000))
      .toBe(Number(timestamp));
    expect(() => assertValidWebhookSignature(secret, timestamp, eventId, signature, Buffer.from(body.toString() + ' '), 1792350000000))
      .toThrow('verification failed');
    expect(() => assertValidWebhookSignature(secret, timestamp, eventId + '-different', signature, body, 1792350000000))
      .toThrow('verification failed');
    expect(() => assertValidWebhookSignature(secret, timestamp, eventId, signature, body, 1792350360000))
      .toThrow('outside the allowed');
    expect(() => assertValidWebhookSignature(secret, 'yesterday', eventId, signature, body, 1792350000000))
      .toThrow('Unix seconds');
  });

  it('requires a bounded environment secret reference and never normalizes invalid secrets into valid references', () => {
    expect(validateWebhookSecretReference('env://WEBHOOK_SECRET_ERP_A')).toBe('WEBHOOK_SECRET_ERP_A');
    expect(() => validateWebhookSecretReference('vault://prod/team')).toThrow('env://WEBHOOK_SECRET_');
    expect(() => validateWebhookSecretReference('env://WEBHOOK_SECRET_x;DROP')).toThrow('env://WEBHOOK_SECRET_');
  });

  it('produces stable request hashes independent of JSON property order', () => {
    expect(integrationRequestHash({ a: 1, b: { d: 2, c: 3 } }))
      .toBe(integrationRequestHash({ b: { c: 3, d: 2 }, a: 1 }));
  });

  it('exposes typed contract failures without including payload values or secrets', () => {
    const error = new IntegrationContractError('TEST_CODE', 'safe validation message');
    expect(error.code).toBe('TEST_CODE');
    expect(error.message).toBe('safe validation message');
  });
});
