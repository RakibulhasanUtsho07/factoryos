import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SaasBillingService } from './saas-billing.service';
import { StripeBillingProviderError } from './stripe-billing.provider';

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
      { status: 'open', automaticTaxStatus: 'failed', automaticTaxEnabled: true },
    )).toThrow(ConflictException);
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: true },
      { status: 'open', automaticTaxStatus: 'requires_location_inputs', automaticTaxEnabled: true },
    )).toThrow(ConflictException);
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: true },
      { status: 'open', automaticTaxStatus: 'complete', automaticTaxEnabled: false },
    )).toThrow(ConflictException);
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: true },
      { status: 'open', automaticTaxStatus: 'complete', automaticTaxEnabled: true },
    )).not.toThrow();
    expect(() => (service as any).assertInvoiceTaxReady(
      { automatic_tax_enabled: false },
      { status: 'open', automaticTaxStatus: null, automaticTaxEnabled: false },
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
    expect(database.query).toHaveBeenCalledTimes(3);
    expect(stripe.createInvoice).not.toHaveBeenCalled();
    expect(database.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO saas_billing_close_runs'))).toBe(false);
  });

  it('reconciles provider discounts as an explicit variance against the immutable usage close', async () => {
    const { service, database, stripe, audit } = mocks();
    const closeId = '33333333-3333-4333-8333-333333333333';
    const snapshotHash = 'a'.repeat(64);
    const marker = 'FO33333333-bbbbbbbbbbbb';
    const close = {
      id: closeId, tenant_id: tenant, provider_account_id: '44444444-4444-4444-8444-444444444444',
      provider_account_version: 1, provider_code: 'stripe', provider_customer_id: 'cus_123abc',
      collection_method: 'charge_automatically', days_until_due: null, automatic_tax_enabled: false,
      tax_behavior: null, currency: 'USD', period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-10-02T00:00:00.000Z', usage_event_count: '1', adjustment_count: '0',
      usage_amount_minor: '225', adjustment_amount_minor: '0', expected_subtotal_minor: '225',
      lines: [{ key: 'usage:AI_INPUT_TOKEN:ai.runtime:PRODUCTION', marker, kind: 'USAGE',
        description: 'AI input usage', quantity: '1', eventCount: 1, amountMinor: '225', metricCode: 'AI_INPUT_TOKEN' }],
      snapshot_hash: snapshotHash, request_hash: 'b'.repeat(64), idempotency_key: 'close-1',
      closed_by: factoryUser, created_at: '2026-10-02T00:00:00Z',
    };
    const closeEvents = [{
      id: 'e1', tenant_id: tenant, close_id: closeId, event_type: 'INVOICE_ISSUED',
      provider_invoice_id: 'in_123abc', provider_invoice_status: 'open',
      idempotency_key: 'invoice-issued:' + closeId, request_hash: close.request_hash,
      error_code: null, evidence_hash: null, actor_user_id: factoryUser, created_at: '2026-10-02T01:00:00Z',
    }];
    const invoice = {
      id: 'in_123abc', customerId: 'cus_123abc', currency: 'USD', status: 'open',
      subtotalMinor: 225, taxMinor: 0, discountMinor: 10, totalMinor: 215,
      amountDueMinor: 215, amountPaidMinor: 0, amountRemainingMinor: 215,
      automaticTaxStatus: null, automaticTaxEnabled: false, collectionMethod: 'charge_automatically',
      metadata: { factoryos_tenant_id: tenant, factoryos_billing_close_id: closeId,
        factoryos_billing_snapshot_hash: snapshotHash },
      livemode: false, createdAt: 1790902800,
    };
    const reconciliation = {
      id: 'r1', tenant_id: tenant, close_id: closeId, provider_invoice_id: invoice.id,
      provider_invoice_status: 'open', provider_customer_id: invoice.customerId, currency: 'USD',
      expected_subtotal_minor: '225', provider_subtotal_minor: '225', provider_tax_minor: '0',
      provider_discount_minor: '10', provider_total_minor: '215', amount_due_minor: '215',
      amount_paid_minor: '0', automatic_tax_status: null, line_binding_valid: true, status: 'VARIANCE',
      provider_snapshot_hash: 'c'.repeat(64), report_hash: 'd'.repeat(64), request_hash: 'e'.repeat(64),
      idempotency_key: 'reconcile-discount-1', recorded_by: factoryUser, created_at: '2026-10-02T02:00:00Z',
    };

    database.query
      .mockResolvedValueOnce({ rows: [] }) // idempotency replay lookup
      .mockResolvedValueOnce({ rows: [close] })
      .mockResolvedValueOnce({ rows: closeEvents })
      .mockResolvedValueOnce({ rows: [reconciliation] })
      .mockResolvedValueOnce({ rows: [] }); // append-only RECONCILED receipt
    stripe.retrieveInvoice.mockResolvedValueOnce(invoice as never);
    stripe.listInvoiceLines.mockResolvedValueOnce([{
      id: 'ii_123abc', amountMinor: 225, currency: 'USD', description: 'AI input usage [ref ' + marker + ']',
    }] as never);

    const result = await service.reconcileInvoice(tenant, factoryUser, closeId, {
      idempotency_key: 'reconcile-discount-1',
    } as never);

    expect(result.idempotent).toBe(false);
    expect(result.reconciliation.status).toBe('VARIANCE');
    expect(result.reconciliation.providerDiscountMinor).toBe('10');
    expect(result.reconciliation.expectedSubtotalMinor).toBe('225');
    expect(result.reconciliation.providerTotalMinor).toBe('215');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'RECONCILE_PROVIDER_INVOICE',
      payload: expect.objectContaining({ status: 'VARIANCE', providerDiscountMinor: '10' }),
    }));
  });

  it('deduplicates Stripe webhook redelivery by provider event ID and payload digest', async () => {
    const { service, database, stripe } = mocks();
    const closeId = '33333333-3333-4333-8333-333333333333';
    const snapshotHash = 'a'.repeat(64);
    const close = {
      id: closeId, tenant_id: tenant, provider_customer_id: 'cus_123abc', snapshot_hash: snapshotHash,
    };
    const rawBody = Buffer.from('{"id":"evt_123abc","type":"invoice.paid"}', 'utf8');
    const webhook = {
      id: 'evt_123abc', type: 'invoice.paid', created: 1790902800, signatureTimestamp: 1790902800,
      data: { object: {
        id: 'in_123abc', customer: 'cus_123abc', status: 'paid',
        metadata: { factoryos_tenant_id: tenant, factoryos_billing_close_id: closeId,
          factoryos_billing_snapshot_hash: snapshotHash },
      } },
    };
    stripe.verifyWebhook.mockReturnValue(webhook as never);
    database.query.mockResolvedValue({ rows: [close] });

    let webhookInserted = false;
    const client = {
      query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>()
        .mockImplementation(async (...args: unknown[]) => {
          const sql = String(args[0]);
          if (sql.startsWith('SELECT payload_hash')) {
            return { rows: webhookInserted ? [{ payload_hash: (service as any).sha(rawBody) }] : [], rowCount: 0 };
          }
          if (sql.startsWith('INSERT INTO saas_billing_provider_webhook_events')) {
            if (webhookInserted) return { rows: [], rowCount: 0 };
            webhookInserted = true;
            return { rows: [{ id: 'webhook-receipt-1' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
    };
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (client: unknown) => Promise<unknown>;
      return callback(client);
    });

    const first = await service.receiveStripeWebhook('verified-signature', rawBody);
    const replay = await service.receiveStripeWebhook('verified-signature', rawBody);

    expect(first).toEqual({ accepted: true, duplicate: false });
    expect(replay).toEqual({ accepted: true, duplicate: true });
    expect(database.transaction).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledTimes(6);
  });

  it('preserves immutable failure evidence and records recovery under a distinct idempotency receipt', async () => {
    const { service, database, stripe } = mocks();
    const closeId = '33333333-3333-4333-8333-333333333333';
    const invoiceId = 'in_123abc';
    const idempotencyKey = 'payment-retry-recover-1';
    const requestHash = (service as any).hash({ tenantId: tenant, closeId, idempotencyKey });
    const close = {
      id: closeId, tenant_id: tenant, provider_account_id: '44444444-4444-4444-8444-444444444444',
      provider_account_version: 1, provider_code: 'stripe', provider_customer_id: 'cus_123abc',
      collection_method: 'charge_automatically', days_until_due: null, automatic_tax_enabled: false,
      tax_behavior: null, currency: 'USD', period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-10-02T00:00:00.000Z', usage_event_count: '1', adjustment_count: '0',
      usage_amount_minor: '125', adjustment_amount_minor: '0', expected_subtotal_minor: '125',
      lines: [], snapshot_hash: 'a'.repeat(64), request_hash: 'b'.repeat(64),
      idempotency_key: 'billing-close-1', closed_by: factoryUser, created_at: '2026-10-02T00:00:00.000Z',
    };
    const issuedEvent = {
      id: 'event-issued', tenant_id: tenant, close_id: closeId, event_type: 'INVOICE_ISSUED',
      provider_invoice_id: invoiceId, provider_invoice_status: 'open', idempotency_key: 'invoice-issued:' + closeId,
      request_hash: close.request_hash, error_code: null, evidence_hash: 'c'.repeat(64),
      actor_user_id: factoryUser, created_at: '2026-10-02T00:00:00.000Z',
    };
    const failureEvent = {
      id: 'event-failed', tenant_id: tenant, close_id: closeId, event_type: 'PAYMENT_FAILED',
      provider_invoice_id: invoiceId, provider_invoice_status: 'open', idempotency_key: 'payment-retry:' + idempotencyKey,
      request_hash: requestHash, error_code: 'STRIPE_card_declined', evidence_hash: null,
      actor_user_id: factoryUser, created_at: '2026-10-02T00:01:00.000Z',
    };
    const paidEvent = {
      ...failureEvent, id: 'event-paid', event_type: 'INVOICE_PAID',
      idempotency_key: 'payment-retry-paid:' + idempotencyKey,
      provider_invoice_status: 'paid', error_code: null,
    };
    const priorRows = [issuedEvent, failureEvent];
    database.query
      .mockResolvedValueOnce({ rows: [] }) // first request: no previous retry receipt
      .mockResolvedValueOnce({ rows: [close] }) // load immutable billing close
      .mockResolvedValueOnce({ rows: priorRows }) // invoice issue + previously failed payment
      .mockResolvedValueOnce({ rows: [] }) // append immutable failure receipt
      .mockResolvedValueOnce({ rows: [failureEvent] }) // replay sees previous failed request
      .mockResolvedValueOnce({ rows: [close] }) // reload close
      .mockResolvedValueOnce({ rows: priorRows }) // reload provider invoice history
      .mockResolvedValueOnce({ rows: [] }) // append paid recovery receipt
      .mockResolvedValueOnce({ rows: [paidEvent, ...priorRows] }); // response reads recovered state

    stripe.retrieveInvoice
      .mockResolvedValueOnce({
        id: invoiceId, customerId: 'cus_123abc', currency: 'USD', status: 'open',
        subtotalMinor: 125, taxMinor: 0, discountMinor: 0, totalMinor: 125,
        amountDueMinor: 125, amountPaidMinor: 0, amountRemainingMinor: 125,
        automaticTaxStatus: null, automaticTaxEnabled: false, collectionMethod: 'charge_automatically',
        metadata: { factoryos_tenant_id: tenant, factoryos_billing_close_id: closeId, factoryos_billing_snapshot_hash: close.snapshot_hash },
        livemode: false, createdAt: 1,
      })
      .mockResolvedValueOnce({
        id: invoiceId, customerId: 'cus_123abc', currency: 'USD', status: 'paid',
        subtotalMinor: 125, taxMinor: 0, discountMinor: 0, totalMinor: 125,
        amountDueMinor: 0, amountPaidMinor: 125, amountRemainingMinor: 0,
        automaticTaxStatus: null, automaticTaxEnabled: false, collectionMethod: 'charge_automatically',
        metadata: { factoryos_tenant_id: tenant, factoryos_billing_close_id: closeId, factoryos_billing_snapshot_hash: close.snapshot_hash },
        livemode: false, createdAt: 1,
      });
    stripe.payInvoice.mockRejectedValueOnce(new StripeBillingProviderError(402, 'card_declined'));

    await expect(service.retryPayment(tenant, factoryUser, closeId, {
      idempotency_key: idempotencyKey,
    } as never)).rejects.toThrow('Stripe payment retry failed with code card_declined');

    const recovered = await service.retryPayment(tenant, factoryUser, closeId, {
      idempotency_key: idempotencyKey,
    } as never);
    expect(recovered.idempotent).toBe(true);
    expect(recovered.close.status).toBe('PAID');
    expect(stripe.payInvoice).toHaveBeenCalledTimes(1);

    const receipts = database.query.mock.calls
      .filter((call) => String(call[0]).includes('INSERT INTO saas_billing_close_events'))
      .map((call) => call[1] as unknown[]);
    expect(receipts.some((values) => values[2] === 'PAYMENT_FAILED' && values[5] === 'payment-retry:' + idempotencyKey)).toBe(true);
    expect(receipts.some((values) => values[2] === 'INVOICE_PAID' && values[5] === 'payment-retry-paid:' + idempotencyKey)).toBe(true);
  });

  it('rejects provider invoice currency or collection method drift from a saved billing close', async () => {
    const { service } = mocks();
    const close = {
      id: '33333333-3333-4333-8333-333333333333',
      tenant_id: tenant,
      provider_customer_id: 'cus_123abc',
      provider_code: 'stripe',
      collection_method: 'send_invoice',
      currency: 'USD',
      snapshot_hash: 'a'.repeat(64),
    };
    const invoice = {
      id: 'in_123abc', customerId: 'cus_123abc', currency: 'EUR',
      collectionMethod: 'charge_automatically',
      metadata: {
        factoryos_tenant_id: tenant,
        factoryos_billing_close_id: close.id,
        factoryos_billing_snapshot_hash: close.snapshot_hash,
      },
    };
    await expect((service as any).assertInvoiceBelongsToClose(invoice, close))
      .rejects.toThrow('currency does not match');
    await expect((service as any).assertInvoiceBelongsToClose({
      ...invoice, currency: 'USD',
    }, close)).rejects.toThrow('collection method does not match');
  });

  it('does not silently acknowledge a malformed FactoryOS-linked invoice webhook', async () => {
    const { service, database, stripe } = mocks();
    stripe.verifyWebhook.mockReturnValueOnce({
      id: 'evt_123abc', type: 'invoice.paid', created: 1, signatureTimestamp: 1,
      data: { object: { id: 'in_123abc', metadata: { factoryos_tenant_id: tenant } } },
    });
    await expect(service.receiveStripeWebhook('sig', Buffer.from('{}')))
      .rejects.toThrow(ConflictException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('ignores unrelated Stripe invoice webhooks but rejects a missing linked close', async () => {
    const { service, database, stripe } = mocks();
    stripe.verifyWebhook.mockReturnValueOnce({
      id: 'evt_unrelated', type: 'invoice.paid', created: 1, signatureTimestamp: 1,
      data: { object: { id: 'in_unrelated', metadata: {} } },
    });
    await expect(service.receiveStripeWebhook('sig', Buffer.from('{}')))
      .resolves.toMatchObject({ accepted: true, ignored: true });
    expect(database.query).not.toHaveBeenCalled();

    stripe.verifyWebhook.mockReturnValueOnce({
      id: 'evt_linked', type: 'invoice.paid', created: 1, signatureTimestamp: 1,
      data: { object: {
        id: 'in_123abc',
        customer: 'cus_123abc',
        metadata: {
          factoryos_tenant_id: tenant,
          factoryos_billing_close_id: '33333333-3333-4333-8333-333333333333',
          factoryos_billing_snapshot_hash: 'a'.repeat(64),
        },
      } },
    });
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.receiveStripeWebhook('sig', Buffer.from('{}')))
      .rejects.toThrow('billing close that was not found');
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
    expect((service as any).closeState([
      { event_type: 'INVOICE_ISSUED' },
      { event_type: 'INVOICE_PAID' },
      { event_type: 'INVOICE_ISSUED' },
    ])).toBe('PAID');
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
