import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SaasBillingService } from './saas-billing.service';

const tenant = '11111111-1111-4111-8111-111111111111';
const factoryUser = '22222222-2222-4222-8222-222222222222';

function mocks() {
  const defaultLockClient = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValue({ rows: [{ pg_advisory_unlock: true }] }),
    release: jest.fn<(...args: unknown[]) => void>(),
  };
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    getClient: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(defaultLockClient as never),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<string>>() };
  const stripe = {
    verifyCustomer: jest.fn<(...args: unknown[]) => Promise<{ id: string }>>(),
    createInvoice: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    createInvoiceItem: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    retrieveInvoice: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    finalizeInvoice: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    sendInvoice: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    payInvoice: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    listInvoiceLines: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(),
    verifyWebhook: jest.fn<(...args: unknown[]) => unknown>(),
  };
  return {
    database, iam, audit, stripe,
    service: new SaasBillingService(database as never, iam as never, audit as never, stripe as never),
  };
}

describe('SaasBillingService', () => {
  it('holds a tenant ledger advisory lock for a billing snapshot and always releases the connection', async () => {
    const { service, database } = mocks();
    const client = {
      query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] }),
      release: jest.fn<(...args: unknown[]) => void>(),
    };
    database.getClient.mockResolvedValueOnce(client as never);

    await expect((service as any).withTenantLedgerLock(tenant, async () => 'snapshot'))
      .resolves.toBe('snapshot');

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      ['saas-billing-ledger:' + tenant],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
      ['saas-billing-ledger:' + tenant],
    );
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('blocks invoice sending and charging until provider automatic tax is complete', () => {
    const { service } = mocks();
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: true },
      { status: 'open', automaticTaxStatus: 'failed' },
    )).toThrow(ConflictException);
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: true },
      { status: 'open', automaticTaxStatus: 'requires_location_inputs' },
    )).toThrow(ConflictException);
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: true },
      { status: 'open', automaticTaxStatus: 'complete' },
    )).not.toThrow();
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: false },
      { status: 'open', automaticTaxStatus: null },
    )).not.toThrow();
  });

  it('validates provider account tax and collection boundaries before touching the database', () => {
    const { service, database } = mocks();
    expect(() => (service as any).normalizeAccount({
      provider_code: 'stripe',
      provider_customer_id: 'cus_123abc',
      currency: 'USD',
      collection_method: 'charge_automatically',
      days_until_due: null,
      automatic_tax_enabled: false,
      tax_behavior: 'exclusive',
      expected_version: 0,
      idempotency_key: 'billing-account-1',
    })).toThrow(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('replays the same provider-account idempotency key without calling the provider twice', async () => {
    const { service, database, stripe } = mocks();
    const input = {
      provider_code: 'stripe',
      provider_customer_id: 'cus_123abc',
      currency: 'USD',
      collection_method: 'send_invoice',
      days_until_due: 30,
      automatic_tax_enabled: true,
      tax_behavior: 'exclusive',
      expected_version: 0,
      idempotency_key: 'billing-account-replay',
    };
    const normalized = (service as any).normalizeAccount(input);
    const requestHash = (service as any).hash({
      tenantId: tenant, ...normalized.content, expectedVersion: normalized.expected_version,
    });
    database.query.mockResolvedValueOnce({ rows: [{
      id: '33333333-3333-4333-8333-333333333333',
      tenant_id: tenant,
      provider_account_id: '44444444-4444-4444-8444-444444444444',
      account_version: 1,
      action: 'CREATED',
      provider_code: 'stripe',
      provider_customer_id: 'cus_123abc',
      currency: 'USD',
      collection_method: 'send_invoice',
      days_until_due: 30,
      automatic_tax_enabled: true,
      tax_behavior: 'exclusive',
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      actor_user_id: factoryUser,
      created_at: '2026-10-23T00:00:00.000Z',
    }] });

    const result = await service.configureProviderAccount(tenant, factoryUser, input as never);
    expect(result.idempotent).toBe(true);
    expect(result.account.providerCustomerId).toBe('cus_123abc');
    expect(stripe.verifyCustomer).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('blocks billing close when any in-period usage event remains unpriced', async () => {
    const { service, database, stripe } = mocks();
    const account = {
      id: '33333333-3333-4333-8333-333333333333', tenant_id: tenant, provider_code: 'stripe',
      provider_customer_id: 'cus_123abc', currency: 'USD', collection_method: 'charge_automatically',
      days_until_due: null, automatic_tax_enabled: false, tax_behavior: null, version: 1,
      idempotency_key: 'account-v1', request_hash: 'a'.repeat(64), created_by: factoryUser,
      updated_by: factoryUser, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    };
    database.query
      .mockResolvedValueOnce({ rows: [] }) // idempotency lookup
      .mockResolvedValueOnce({ rows: [] }) // period/currency uniqueness lookup
      .mockResolvedValueOnce({ rows: [account] }) // provider account
      .mockResolvedValueOnce({ rows: [{
        metric_code: 'AI_INPUT_TOKEN',
        capability_code: 'ai.runtime.inference',
        workload_class: 'PRODUCTION',
        currency: 'USD',
        event_count: '1',
        total_quantity: '1250.000000',
        total_cost_minor: '0',
        unpriced_count: '1',
      }] });

    await expect(service.createBillingClose(tenant, factoryUser, {
      period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-10-02T00:00:00.000Z',
      currency: 'USD',
      idempotency_key: 'close-unpriced-event',
    } as never)).rejects.toThrow(ConflictException);
    expect(database.query).toHaveBeenCalledTimes(4);
    expect(stripe.createInvoice).not.toHaveBeenCalled();
    expect(database.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO saas_billing_close_runs'))).toBe(false);
  });

  it('labels close estimates as not an issued invoice and keeps reconciliation separate', () => {
    const { service } = mocks();
    const row = {
      id: '33333333-3333-4333-8333-333333333333',
      tenant_id: tenant,
      provider_account_id: '44444444-4444-4444-8444-444444444444',
      provider_account_version: 1,
      provider_code: 'stripe',
      provider_customer_id: 'cus_123abc',
      collection_method: 'charge_automatically',
      days_until_due: null,
      automatic_tax_enabled: false,
      tax_behavior: null,
      currency: 'USD',
      period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-10-02T00:00:00.000Z',
      usage_event_count: '3',
      adjustment_count: '1',
      usage_amount_minor: '250',
      adjustment_amount_minor: '-25',
      expected_subtotal_minor: '225',
      lines: [],
      snapshot_hash: 'a'.repeat(64),
      request_hash: 'b'.repeat(64),
      idempotency_key: 'billing-close-1',
      closed_by: factoryUser,
      created_at: '2026-10-02T00:00:00.000Z',
    };
    expect((service as any).closeState([{ event_type: 'CLOSE_PREPARED' }])).toBe('PREPARED');
    expect((service as any).mapReconciliation({
      id: 'r', close_id: row.id, provider_invoice_id: 'in_123abc', provider_invoice_status: 'paid',
      provider_customer_id: row.provider_customer_id, currency: row.currency, expected_subtotal_minor: '225',
      provider_subtotal_minor: '225', provider_tax_minor: '0', provider_discount_minor: '0',
      provider_total_minor: '225', amount_due_minor: '0', amount_paid_minor: '225',
      automatic_tax_status: 'complete', line_binding_valid: true, status: 'MATCHED_PAID',
      provider_snapshot_hash: 'c'.repeat(64), report_hash: 'd'.repeat(64), request_hash: 'e'.repeat(64),
      idempotency_key: 'billing-reconcile-1', recorded_by: factoryUser, created_at: '2026-10-02T00:00:00Z',
    })).toMatchObject({
      providerInvoiceId: 'in_123abc',
      status: 'MATCHED_PAID',
      expectedSubtotalMinor: '225',
      providerTaxMinor: '0',
    });
  });
});
