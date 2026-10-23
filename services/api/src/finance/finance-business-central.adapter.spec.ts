import { describe, expect, it } from '@jest/globals';
import {
  isFinancePublicAddress,
  MicrosoftDynamics365BusinessCentralFinanceAdapter,
  PinnedFinanceJsonHttpClient,
  resolveFinancePinnedAddress,
  type FinanceJsonHttpClient,
  type FinanceJsonHttpRequest,
  type FinanceSecretManager,
} from './finance-business-central.adapter';

const COMPANY_ID = '11111111-2222-4333-8444-555555555555';
const PROVIDER_CONFIGURATION = {
  provider: 'MICROSOFT_DYNAMICS_365_BUSINESS_CENTRAL_FINANCE_EXCHANGE_V1',
  company_id: COMPANY_ID,
};

class FakeSecrets implements FinanceSecretManager {
  readonly calls: Array<{ reference: string; context: { tenant_id: string; factory_id: string; connector_id: string } }> = [];
  async resolveBearerToken(reference: string, context: { tenant_id: string; factory_id: string; connector_id: string }) {
    this.calls.push({ reference, context });
    return 'test-bearer-token-not-a-real-credential';
  }
}

class FakeHttp implements FinanceJsonHttpClient {
  readonly requests: FinanceJsonHttpRequest[] = [];
  responses: unknown[] = [];
  async request<T>(input: FinanceJsonHttpRequest): Promise<T> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }
}

function makeAdapter(http = new FakeHttp(), secrets = new FakeSecrets()) {
  return { adapter: new MicrosoftDynamics365BusinessCentralFinanceAdapter(secrets, http), http, secrets };
}

const inputContext = {
  tenant_id: 'tenant-01',
  factory_id: 'factory-01',
  connector_id: 'connector-01',
};

describe('Microsoft Dynamics 365 Business Central Finance Exchange v1 contract', () => {
  it('rejects non-global, link-local, metadata and reserved addresses', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.5', '169.254.169.254',
      '100.64.1.1', '198.51.100.10', '203.0.113.5', '224.0.0.1', '::1', '::ffff:8.8.8.8', '2001:db8::1',
    ]) expect(isFinancePublicAddress(address)).toBe(false);
    expect(isFinancePublicAddress('8.8.8.8')).toBe(true);
    expect(isFinancePublicAddress('1.1.1.1')).toBe(true);
    expect(isFinancePublicAddress('2001:4860:4860::8888')).toBe(true);
  });

  it('requires exact deployment hostname and every DNS answer to be explicitly IP-allowlisted', async () => {
    const lookup = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ];
    await expect(resolveFinancePinnedAddress('erp.example.com', new Set(['*.example.com']), new Set(['8.8.8.8', '1.1.1.1']), lookup))
      .rejects.toThrow('FINANCE_ERP_HOST_NOT_ALLOWLISTED');
    await expect(resolveFinancePinnedAddress('erp.example.com', new Set(['erp.example.com']), new Set(['8.8.8.8']), lookup))
      .rejects.toThrow('FINANCE_ERP_RESOLVED_IP_NOT_ALLOWLISTED');
    await expect(resolveFinancePinnedAddress('erp.example.com', new Set(['erp.example.com']), new Set(['8.8.8.8', '1.1.1.1']), async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ])).rejects.toThrow('FINANCE_ERP_DNS_RESOLVED_NON_PUBLIC_ADDRESS');
    await expect(resolveFinancePinnedAddress('erp.example.com', new Set(['erp.example.com']), new Set(), lookup))
      .rejects.toThrow('FINANCE_ERP_IP_ALLOWLIST_REQUIRED');
    await expect(resolveFinancePinnedAddress('erp.example.com', new Set(['erp.example.com']), new Set(['8.8.8.8', '1.1.1.1']), lookup))
      .resolves.toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('fails closed when runtime allowlists are not configured', async () => {
    const client = new PinnedFinanceJsonHttpClient(new Set(['erp.example.com']), new Set(), async () => [
      { address: '8.8.8.8', family: 4 },
    ]);
    await expect(client.request({
      url: 'https://erp.example.com/api/test',
      method: 'GET',
      bearerToken: 'short-token',
    })).rejects.toThrow('FINANCE_ERP_IP_ALLOWLIST_REQUIRED');
  });

  it('maps a provider batch to the governed file-import contract without trusting tenant scope in the payload', async () => {
    const { adapter, http, secrets } = makeAdapter();
    const content = Buffer.from('external_fact_id,amount\nAP-1,99.50\n', 'utf8');
    http.responses.push({
      value: [{
        id: 'bc-batch-01',
        externalBatchRef: 'finance-batch-01',
        fileName: 'ap-20261022.csv',
        format: 'CSV',
        contentBase64: content.toString('base64'),
        sourceOccurredAt: '2026-10-22T12:00:00Z',
        tenantId: 'attacker-selected-tenant-is-ignored',
      }],
    });

    const batch = await adapter.downloadNext({
      ...inputContext,
      endpoint_url: 'https://erp.example.com/v2.0/tenant/environment',
      secret_reference: 'vault://factoryos/prod/business-central',
      configuration: PROVIDER_CONFIGURATION,
    });

    expect(batch).toEqual({
      source_batch_ref: 'finance-batch-01',
      provider_reference: 'bc-batch-01',
      file_name: 'ap-20261022.csv',
      format: 'CSV',
      content,
      source_occurred_at: '2026-10-22T12:00:00.000Z',
    });
    expect(http.requests[0].url).toBe(
      'https://erp.example.com/v2.0/tenant/environment/api/factoryos/finance/v1.0/companies(' + COMPANY_ID + ')/financeBatches/next',
    );
    expect(http.requests[0].method).toBe('GET');
    expect(secrets.calls[0].reference).toBe('vault://factoryos/prod/business-central');
    expect(secrets.calls[0].context).toEqual(inputContext);
  });

  it('rejects malformed batch IDs, path-like filenames, unsupported formats and non-canonical base64', async () => {
    for (const value of [
      { id: 'https://erp.example/one', externalBatchRef: 'batch-1', fileName: 'input.csv', format: 'CSV', contentBase64: 'eA==' },
      { id: 'id-1', externalBatchRef: 'batch-1', fileName: '../input.csv', format: 'CSV', contentBase64: 'eA==' },
      { id: 'id-1', externalBatchRef: 'batch-1', fileName: 'input.csv', format: 'XML', contentBase64: 'eA==' },
      { id: 'id-1', externalBatchRef: 'batch-1', fileName: 'input.csv', format: 'CSV', contentBase64: 'not-base64' },
    ]) {
      const { adapter, http } = makeAdapter();
      http.responses.push({ value: [value] });
      await expect(adapter.downloadNext({
        ...inputContext,
        endpoint_url: 'https://erp.example.com',
        secret_reference: 'vault://finance/bc',
        configuration: PROVIDER_CONFIGURATION,
      })).rejects.toThrow();
    }
  });

  it('acknowledges only an opaque provider ID, with a deterministic idempotency key and hash-bound disposition', async () => {
    const { adapter, http } = makeAdapter();
    const acknowledgement = {
      ...inputContext,
      endpoint_url: 'https://erp.example.com',
      secret_reference: 'secret://finance/bc',
      configuration: PROVIDER_CONFIGURATION,
      source_batch_ref: 'batch-2026-10-22',
      provider_reference: 'bc-record-123',
      payload_sha256: 'a'.repeat(64),
      disposition: 'PROCESSED' as const,
    };
    http.responses.push({ accepted: true }, { accepted: true });
    await adapter.acknowledge(acknowledgement);
    await adapter.acknowledge(acknowledgement);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[0].method).toBe('POST');
    expect(http.requests[0].url).toContain('/financeBatches(bc-record-123)/acknowledge');
    expect(http.requests[0].idempotencyKey).toBe(http.requests[1].idempotencyKey);
    expect(http.requests[0].body).toMatchObject({
      externalBatchRef: acknowledgement.source_batch_ref,
      payloadSha256: acknowledgement.payload_sha256,
      disposition: 'PROCESSED',
    });
    await expect(adapter.acknowledge({ ...acknowledgement, provider_reference: 'https://evil.invalid' }))
      .rejects.toThrow('FINANCE_ERP_REFERENCE_INVALID');
  });

  it('uploads exports with a content-derived key and rejects acknowledgement mismatches', async () => {
    const { adapter, http } = makeAdapter();
    const content = Buffer.from('external_fact_id,amount\nAP-1,99.50\n', 'utf8');
    const digest = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');
    http.responses.push({ id: 'export-01', payloadSha256: digest, bytesWritten: content.length });
    const uploaded = await adapter.upload({
      ...inputContext,
      endpoint_url: 'https://erp.example.com/v2.0/tenant/environment',
      secret_reference: 'vault://finance/bc',
      configuration: PROVIDER_CONFIGURATION,
      file_name: 'finance-ap-abc123.csv',
      format: 'CSV',
      content,
      payload_sha256: digest,
    });
    expect(uploaded).toEqual({ provider_reference: 'export-01', payload_sha256: digest, bytes_written: content.length });
    expect(http.requests[0].url).toContain('/financeExports');
    expect(http.requests[0].idempotencyKey).toBeDefined();

    http.responses.push({ id: 'export-02', payloadSha256: 'b'.repeat(64), bytesWritten: content.length });
    await expect(adapter.upload({
      ...inputContext,
      endpoint_url: 'https://erp.example.com',
      secret_reference: 'vault://finance/bc',
      configuration: PROVIDER_CONFIGURATION,
      file_name: 'finance-ap-abc123.csv',
      format: 'CSV',
      content,
      payload_sha256: digest,
    })).rejects.toThrow('FINANCE_BUSINESS_CENTRAL_EXPORT_ACK_MISMATCH');
  });

  it('fails closed without a secret-manager binding and for non-HTTPS endpoints', async () => {
    const adapter = new MicrosoftDynamics365BusinessCentralFinanceAdapter(undefined, new FakeHttp());
    await expect(adapter.downloadNext({
      ...inputContext,
      endpoint_url: 'https://erp.example.com',
      secret_reference: 'vault://finance/bc',
      configuration: PROVIDER_CONFIGURATION,
    })).rejects.toThrow('FINANCE_SECRET_MANAGER_NOT_CONFIGURED');

    const { adapter: configuredAdapter } = makeAdapter();
    await expect(configuredAdapter.downloadNext({
      ...inputContext,
      endpoint_url: 'http://erp.example.com',
      secret_reference: 'vault://finance/bc',
      configuration: PROVIDER_CONFIGURATION,
    })).rejects.toThrow('FINANCE_BUSINESS_CENTRAL_ENDPOINT_INVALID');
  });
});
