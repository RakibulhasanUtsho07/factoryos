import { BadGatewayException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StripeInvoice {
  id: string;
  customerId: string;
  currency: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  subtotalMinor: number;
  taxMinor: number;
  discountMinor: number;
  totalMinor: number;
  amountDueMinor: number;
  amountPaidMinor: number;
  amountRemainingMinor: number;
  automaticTaxStatus: string | null;
  automaticTaxEnabled: boolean;
  collectionMethod: 'charge_automatically' | 'send_invoice';
  metadata: Record<string, string>;
  livemode: boolean;
  createdAt: number | null;
}

export interface StripeInvoiceLine {
  id: string;
  amountMinor: number;
  currency: string;
  description: string;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  signatureTimestamp: number;
  data: { object: Record<string, unknown> };
}

export class StripeBillingProviderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly providerCode: string,
  ) {
    super('Stripe billing provider request failed');
    this.name = 'StripeBillingProviderError';
  }
}

@Injectable()
export class StripeBillingProvider {
  constructor(private readonly config: ConfigService) {}

  async verifyCustomer(customerId: string): Promise<{ id: string }> {
    const value = await this.request('/customers/' + encodeURIComponent(customerId), 'GET');
    if (!isRecord(value) || value.id !== customerId || value.deleted === true) {
      throw new BadGatewayException('Stripe customer is missing, deleted, or does not match the requested ID');
    }
    return { id: customerId };
  }

  async createInvoice(input: {
    customerId: string;
    currency: string;
    collectionMethod: 'charge_automatically' | 'send_invoice';
    daysUntilDue: number | null;
    automaticTaxEnabled: boolean;
    tenantId: string;
    closeId: string;
    snapshotHash: string;
    subscription?: {
      id: string;
      version: number;
      planCode: string;
      planVersion: number;
      snapshotHash: string;
    } | null;
  }, idempotencyKey: string): Promise<StripeInvoice> {
    const params: Record<string, unknown> = {
      customer: input.customerId,
      currency: input.currency.toLowerCase(),
      collection_method: input.collectionMethod,
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      automatic_tax: { enabled: input.automaticTaxEnabled },
      metadata: {
        factoryos_tenant_id: input.tenantId,
        factoryos_billing_close_id: input.closeId,
        factoryos_billing_snapshot_hash: input.snapshotHash,
        ...(input.subscription ? {
          factoryos_subscription_id: input.subscription.id,
          factoryos_subscription_version: String(input.subscription.version),
          factoryos_subscription_plan_code: input.subscription.planCode,
          factoryos_subscription_plan_version: String(input.subscription.planVersion),
          factoryos_subscription_snapshot_hash: input.subscription.snapshotHash,
        } : {}),
      },
    };
    if (input.collectionMethod === 'send_invoice') params.days_until_due = input.daysUntilDue;
    return this.normalizeInvoice(await this.request('/invoices', 'POST', params, idempotencyKey));
  }

  async createInvoiceItem(input: {
    invoiceId: string;
    customerId: string;
    currency: string;
    amountMinor: number;
    description: string;
    taxBehavior: 'exclusive' | 'inclusive' | null;
    metadata: Record<string, string>;
  }, idempotencyKey: string): Promise<{ id: string }> {
    const params: Record<string, unknown> = {
      customer: input.customerId,
      invoice: input.invoiceId,
      currency: input.currency.toLowerCase(),
      amount: input.amountMinor,
      description: input.description,
      metadata: input.metadata,
    };
    if (input.taxBehavior) params.tax_behavior = input.taxBehavior;
    const value = await this.request('/invoiceitems', 'POST', params, idempotencyKey);
    if (!isRecord(value) || typeof value.id !== 'string') {
      throw new BadGatewayException('Stripe did not return an invoice-item ID');
    }
    return { id: value.id };
  }

  async findInvoicesForClose(closeId: string): Promise<StripeInvoice[]> {
    if (!/^[0-9a-f-]{36}$/i.test(closeId)) {
      throw new BadGatewayException('FactoryOS billing-close ID is invalid');
    }
    const query = "metadata['factoryos_billing_close_id']:'" + closeId + "'";
    const result = await this.request('/invoices/search', 'GET', { query, limit: 10 });
    if (!isRecord(result) || !Array.isArray(result.data)) {
      throw new BadGatewayException('Stripe invoice search returned an invalid response');
    }
    if (result.has_more === true && result.data.length >= 10) {
      throw new BadGatewayException('Stripe returned too many invoices for one FactoryOS billing-close marker');
    }
    return result.data.map((invoice) => this.normalizeInvoice(invoice));
  }

  async retrieveInvoice(invoiceId: string): Promise<StripeInvoice> {
    return this.normalizeInvoice(await this.request('/invoices/' + encodeURIComponent(invoiceId), 'GET'));
  }

  async finalizeInvoice(invoiceId: string, idempotencyKey: string): Promise<StripeInvoice> {
    return this.normalizeInvoice(await this.request(
      '/invoices/' + encodeURIComponent(invoiceId) + '/finalize',
      'POST',
      { auto_advance: false },
      idempotencyKey,
    ));
  }

  async sendInvoice(invoiceId: string, idempotencyKey: string): Promise<StripeInvoice> {
    return this.normalizeInvoice(await this.request(
      '/invoices/' + encodeURIComponent(invoiceId) + '/send',
      'POST',
      {},
      idempotencyKey,
    ));
  }

  async payInvoice(invoiceId: string, idempotencyKey: string): Promise<StripeInvoice> {
    return this.normalizeInvoice(await this.request(
      '/invoices/' + encodeURIComponent(invoiceId) + '/pay',
      'POST',
      {},
      idempotencyKey,
    ));
  }

  async listInvoiceLines(invoiceId: string): Promise<StripeInvoiceLine[]> {
    const lines: StripeInvoiceLine[] = [];
    let startingAfter: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const query: Record<string, unknown> = { limit: 100 };
      if (startingAfter) query.starting_after = startingAfter;
      const response = await this.request(
        '/invoices/' + encodeURIComponent(invoiceId) + '/lines',
        'GET',
        query,
      );
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new BadGatewayException('Stripe returned an invalid invoice-lines response');
      }
      for (const value of response.data) {
        if (!isRecord(value) || typeof value.id !== 'string' || typeof value.description !== 'string') {
          throw new BadGatewayException('Stripe returned an invalid invoice line');
        }
        lines.push({
          id: value.id,
          amountMinor: safeInteger(value.amount, 'invoice line amount'),
          currency: stringValue(value.currency, 'invoice line currency').toUpperCase(),
          description: value.description,
        });
      }
      if (response.has_more !== true) return lines;
      const last = response.data[response.data.length - 1];
      if (!isRecord(last) || typeof last.id !== 'string') {
        throw new BadGatewayException('Stripe pagination did not return a cursor');
      }
      startingAfter = last.id;
    }
    throw new BadGatewayException('Stripe invoice contains more lines than the supported safe reconciliation limit');
  }

  verifyWebhook(signatureHeader: string | undefined, rawBody: Buffer): StripeWebhookEvent {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim();
    if (!secret) throw new ServiceUnavailableException('Stripe webhook verification is not configured');
    if (!Buffer.isBuffer(rawBody) || rawBody.length < 2 || rawBody.length > 3 * 1024 * 1024) {
      throw new UnauthorizedException('Stripe webhook body is missing or outside the allowed size');
    }
    if (!signatureHeader || signatureHeader.length > 4096) {
      throw new UnauthorizedException('Stripe webhook signature is missing');
    }

    let timestamp: number | null = null;
    const signatures: string[] = [];
    for (const piece of signatureHeader.split(',')) {
      const separator = piece.indexOf('=');
      if (separator < 1) continue;
      const key = piece.slice(0, separator).trim();
      const value = piece.slice(separator + 1).trim();
      if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
      if (key === 'v1' && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase());
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (timestamp === null || Math.abs(nowSeconds - timestamp) > 300 || signatures.length === 0) {
      throw new UnauthorizedException('Stripe webhook signature timestamp or format is invalid');
    }

    const expected = createHmac('sha256', secret)
      .update(String(timestamp) + '.', 'utf8')
      .update(rawBody)
      .digest();
    const matched = signatures.some((hex) => {
      const actual = Buffer.from(hex, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (!matched) throw new UnauthorizedException('Stripe webhook signature verification failed');

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException('Stripe webhook body is not valid JSON');
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(parsed.id)
      || typeof parsed.type !== 'string' || !isRecord(parsed.data) || !isRecord(parsed.data.object)) {
      throw new UnauthorizedException('Stripe webhook envelope is invalid');
    }
    return {
      id: parsed.id,
      type: parsed.type,
      created: typeof parsed.created === 'number' ? parsed.created : timestamp,
      signatureTimestamp: timestamp,
      data: { object: parsed.data.object },
    };
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    parameters: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<unknown> {
    const { secret } = this.configuredSecretKey();
    if (idempotencyKey && (idempotencyKey.length < 1 || idempotencyKey.length > 255)) {
      throw new BadGatewayException('Stripe idempotency key is outside the provider limit');
    }

    const url = new URL('https://api.stripe.com/v1' + path);
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      appendFormValue(encoded, key, value);
    }
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + secret,
      Accept: 'application/json',
    };
    const configuredApiVersion = this.config.get<string>('STRIPE_API_VERSION')?.trim();
    if (configuredApiVersion) headers['Stripe-Version'] = configuredApiVersion;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const options: RequestInit = { method, headers, signal: AbortSignal.timeout(15000) };
    if (method === 'GET') {
      encoded.forEach((value, key) => url.searchParams.append(key, value));
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = encoded.toString();
    }

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new ServiceUnavailableException('Stripe billing provider could not be reached; retry with the same idempotency key');
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      throw new BadGatewayException('Stripe billing provider returned an unreadable response');
    }
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : {};
      const code = typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)
        ? error.code : 'STRIPE_REQUEST_FAILED';
      if (response.status === 429 || response.status >= 500) {
        throw new StripeBillingProviderError(response.status, code);
      }
      throw new StripeBillingProviderError(response.status, code);
    }
    return body;
  }

  private configuredSecretKey(): { secret: string; mode: 'test' | 'live' } {
    const secret = this.config.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (!secret) throw new ServiceUnavailableException('Stripe billing provider is not configured');

    const mode = /^(?:sk|rk)_test_/.test(secret) ? 'test'
      : /^(?:sk|rk)_live_/.test(secret) ? 'live' : null;
    if (!mode) {
      throw new ServiceUnavailableException('Stripe secret key must use a recognizable test/live key prefix so invoice mode can be verified');
    }
    if (mode === 'test' && this.config.get<string>('NODE_ENV')?.trim().toLowerCase() === 'production') {
      throw new ServiceUnavailableException('Stripe test-mode credentials are forbidden in production');
    }
    return { secret, mode };
  }

  private normalizeInvoice(value: unknown): StripeInvoice {
    if (!isRecord(value) || typeof value.id !== 'string' || !/^in_[A-Za-z0-9]+$/.test(value.id)) {
      throw new BadGatewayException('Stripe returned an invalid invoice object');
    }
    const customer = typeof value.customer === 'string'
      ? value.customer
      : isRecord(value.customer) && typeof value.customer.id === 'string'
        ? value.customer.id : null;
    if (!customer || !/^cus_[A-Za-z0-9]+$/.test(customer)) {
      throw new BadGatewayException('Stripe invoice does not have a valid customer binding');
    }
    const status = value.status;
    if (status !== 'draft' && status !== 'open' && status !== 'paid' && status !== 'void' && status !== 'uncollectible') {
      throw new BadGatewayException('Stripe invoice has an unsupported lifecycle status');
    }
    if (!isRecord(value.automatic_tax) || typeof value.automatic_tax.enabled !== 'boolean') {
      throw new BadGatewayException('Stripe invoice is missing a valid automatic-tax state');
    }
    if (value.collection_method !== 'charge_automatically' && value.collection_method !== 'send_invoice') {
      throw new BadGatewayException('Stripe invoice is missing a supported collection method');
    }
    const totalTaxes = Array.isArray(value.total_taxes) ? value.total_taxes
      : Array.isArray(value.total_tax_amounts) ? value.total_tax_amounts : null;
    if (totalTaxes === null) {
      throw new BadGatewayException('Stripe invoice response omitted both supported tax-total fields');
    }
    const taxMinor = totalTaxes.reduce((sum: number, entry: unknown) => {
      if (!isRecord(entry)) throw new BadGatewayException('Stripe invoice contains invalid tax detail');
      const amount = safeInteger(entry.amount, 'invoice tax amount');
      return safeAdd(sum, amount, 'invoice tax total');
    }, 0);
    const discounts = Array.isArray(value.total_discount_amounts) ? value.total_discount_amounts : [];
    const discountMinor = discounts.reduce((sum: number, entry: unknown) => {
      if (!isRecord(entry)) throw new BadGatewayException('Stripe invoice contains invalid discount detail');
      return safeAdd(sum, safeInteger(entry.amount, 'invoice discount amount'), 'invoice discount total');
    }, 0);
    const metadata: Record<string, string> = {};
    if (isRecord(value.metadata)) {
      for (const [key, item] of Object.entries(value.metadata)) if (typeof item === 'string') metadata[key] = item;
    }
    if (typeof value.livemode !== 'boolean') throw new BadGatewayException('Stripe invoice is missing live-mode state');
    const { mode } = this.configuredSecretKey();
    if (value.livemode !== (mode === 'live')) {
      throw new BadGatewayException('Stripe invoice live-mode state does not match the configured credential mode');
    }
    if (typeof value.currency !== 'string' || !/^[a-z]{3}$/i.test(value.currency)) {
      throw new BadGatewayException('Stripe invoice currency is invalid');
    }
    return {
      id: value.id,
      customerId: customer,
      currency: value.currency.toUpperCase(),
      status,
      subtotalMinor: safeInteger(value.subtotal, 'invoice subtotal'),
      taxMinor,
      discountMinor,
      totalMinor: safeInteger(value.total, 'invoice total'),
      amountDueMinor: safeInteger(value.amount_due, 'invoice amount due'),
      amountPaidMinor: safeInteger(value.amount_paid, 'invoice amount paid'),
      amountRemainingMinor: safeInteger(value.amount_remaining, 'invoice amount remaining'),
      automaticTaxStatus: typeof value.automatic_tax.status === 'string' ? value.automatic_tax.status : null,
      automaticTaxEnabled: value.automatic_tax.enabled === true,
      collectionMethod: value.collection_method,
      metadata,
      livemode: value.livemode,
      createdAt: typeof value.created === 'number' && Number.isSafeInteger(value.created) ? value.created : null,
    };
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BadGatewayException('Stripe ' + field + ' is invalid');
  return value;
}

function safeInteger(value: unknown, field: string): number {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(numberValue)) throw new BadGatewayException('Stripe ' + field + ' is outside the safe integer range');
  return numberValue;
}

function safeAdd(left: number, right: number, field: string): number {
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new BadGatewayException('Stripe ' + field + ' is outside the safe integer range');
  }
  return Number(result);
}

function appendFormValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFormValue(params, key + '[' + index + ']', item));
    return;
  }
  if (typeof value === 'object') {
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      appendFormValue(params, key + '[' + nestedKey + ']', nestedValue);
    }
    return;
  }
  params.append(key, String(value));
}
