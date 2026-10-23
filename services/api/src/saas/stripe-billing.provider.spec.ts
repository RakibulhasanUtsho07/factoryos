import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { StripeBillingProvider } from './stripe-billing.provider';

function config(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

describe('StripeBillingProvider', () => {
  it('verifies webhook signatures against the exact original body bytes', () => {
    const secret = 'whsec_test-only';
    const provider = new StripeBillingProvider(config({ STRIPE_WEBHOOK_SECRET: secret }) as never);
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = Buffer.from(JSON.stringify({
      id: 'evt_123abc',
      type: 'invoice.paid',
      created: timestamp,
      data: { object: { id: 'in_123abc' } },
    }), 'utf8');
    const signature = createHmac('sha256', secret)
      .update(String(timestamp) + '.', 'utf8')
      .update(raw)
      .digest('hex');

    const event = provider.verifyWebhook('t=' + timestamp + ',v1=' + signature, raw);
    expect(event.id).toBe('evt_123abc');
    expect(event.type).toBe('invoice.paid');
    expect(event.signatureTimestamp).toBe(timestamp);

    expect(() => provider.verifyWebhook(
      't=' + timestamp + ',v1=' + signature,
      Buffer.from(raw.toString('utf8').replace('invoice.paid', 'invoice.voided'), 'utf8'),
    )).toThrow(UnauthorizedException);
  });

  it('rejects missing secrets, stale signatures and malformed envelopes', () => {
    const unconfigured = new StripeBillingProvider(config({}) as never);
    expect(() => unconfigured.verifyWebhook('t=1,v1=' + 'a'.repeat(64), Buffer.from('{}')))
      .toThrow();

    const secret = 'whsec_test-only';
    const provider = new StripeBillingProvider(config({ STRIPE_WEBHOOK_SECRET: secret }) as never);
    const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const raw = Buffer.from('{}');
    const staleSignature = createHmac('sha256', secret)
      .update(String(oldTimestamp) + '.', 'utf8')
      .update(raw)
      .digest('hex');
    expect(() => provider.verifyWebhook('t=' + oldTimestamp + ',v1=' + staleSignature, raw))
      .toThrow(UnauthorizedException);

    const timestamp = Math.floor(Date.now() / 1000);
    const badEnvelope = Buffer.from(JSON.stringify({ id: 'evt_123abc', type: 'invoice.paid', data: {} }));
    const validEnvelopeSignature = createHmac('sha256', secret)
      .update(String(timestamp) + '.', 'utf8')
      .update(badEnvelope)
      .digest('hex');
    expect(() => provider.verifyWebhook('t=' + timestamp + ',v1=' + validEnvelopeSignature, badEnvelope))
      .toThrow(UnauthorizedException);
  });

  it('rejects a malformed provider invoice instead of assuming automatic collection or zero tax', () => {
    const provider = new StripeBillingProvider(config({ STRIPE_SECRET_KEY: 'sk_test_only' }) as never);
    const invoice = {
      id: 'in_123abc',
      customer: 'cus_123abc',
      currency: 'usd',
      status: 'draft',
      subtotal: 125,
      total: 125,
      amount_due: 125,
      amount_paid: 0,
      amount_remaining: 125,
      automatic_tax: { enabled: false, status: null },
      total_taxes: [],
      total_discount_amounts: [],
      metadata: {},
      livemode: false,
      created: 1,
    };
    expect(() => (provider as any).normalizeInvoice(invoice))
      .toThrow('supported collection method');
    expect(() => (provider as any).normalizeInvoice({
      ...invoice, collection_method: 'charge_automatically', total_taxes: undefined, total_tax_amounts: undefined,
    })).toThrow('omitted both supported tax-total fields');
  });

  it('blocks production use of test credentials and rejects invoice credential-mode drift', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    try {
      const productionProvider = new StripeBillingProvider(config({
        STRIPE_SECRET_KEY: 'sk_test_only',
        NODE_ENV: 'production',
      }) as never);
      await expect(productionProvider.verifyCustomer('cus_123abc'))
        .rejects.toThrow('test-mode credentials are forbidden in production');
      expect(fetchMock).not.toHaveBeenCalled();

      const testProvider = new StripeBillingProvider(config({
        STRIPE_SECRET_KEY: 'sk_test_only',
        NODE_ENV: 'test',
      }) as never);
      const validTestInvoice = {
        id: 'in_123abc',
        customer: 'cus_123abc',
        currency: 'usd',
        status: 'draft',
        subtotal: 125,
        total: 125,
        amount_due: 125,
        amount_paid: 0,
        amount_remaining: 125,
        automatic_tax: { enabled: false, status: null },
        total_taxes: [],
        total_discount_amounts: [],
        collection_method: 'charge_automatically',
        metadata: {},
        livemode: true,
        created: 1,
      };
      expect(() => (testProvider as any).normalizeInvoice(validTestInvoice))
        .toThrow('does not match the configured credential mode');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('uses server-side credentials and a stable provider idempotency key for invoice creation', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'in_123abc',
      customer: 'cus_123abc',
      currency: 'usd',
      status: 'draft',
      subtotal: 125,
      total: 125,
      amount_due: 125,
      amount_paid: 0,
      amount_remaining: 125,
      automatic_tax: { enabled: false, status: null },
      total_taxes: [],
      total_discount_amounts: [],
      collection_method: 'charge_automatically',
      metadata: { factoryos_billing_close_id: 'close' },
      livemode: false,
      created: Math.floor(Date.now() / 1000),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const provider = new StripeBillingProvider(config({ STRIPE_SECRET_KEY: 'sk_test_only' }) as never);
      const invoice = await provider.createInvoice({
        customerId: 'cus_123abc',
        currency: 'USD',
        collectionMethod: 'charge_automatically',
        daysUntilDue: null,
        automaticTaxEnabled: false,
        tenantId: '11111111-1111-4111-8111-111111111111',
        closeId: '22222222-2222-4222-8222-222222222222',
        snapshotHash: 'a'.repeat(64),
      }, 'factoryos-invoice-idempotency-test');
      expect(invoice.id).toBe('in_123abc');
      const [requestUrl, requestOptions] = fetchMock.mock.calls[0] ?? [];
      expect(String(requestUrl)).toBe('https://api.stripe.com/v1/invoices');
      const headers = new Headers((requestOptions as RequestInit | undefined)?.headers);
      expect(headers.get('Authorization')).toBe('Bearer sk_test_only');
      expect(headers.get('Idempotency-Key')).toBe('factoryos-invoice-idempotency-test');
      expect(String((requestOptions as RequestInit | undefined)?.body)).toContain('auto_advance=false');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
