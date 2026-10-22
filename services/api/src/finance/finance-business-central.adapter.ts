import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import https, { type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { validateFinanceSecretReference } from './finance-contract';
import {
  normalizeFinanceErpOpaqueReference,
  type FinanceErpFileDownload,
  type FinanceErpTransferAdapter,
  type FinanceErpUploadResult,
} from './finance-erp-transfer.adapters';

export const FINANCE_SECRET_MANAGER = Symbol('FINANCE_SECRET_MANAGER');
export const FINANCE_BUSINESS_CENTRAL_HTTP_CLIENT = Symbol('FINANCE_BUSINESS_CENTRAL_HTTP_CLIENT');

/**
 * A deployment-owned secret-manager integration (Vault, cloud secret manager,
 * or workload-identity-backed broker). It returns a short-lived provider access
 * token; connector code never receives a client password or stores secret bytes.
 */
export interface FinanceSecretManager {
  resolveBearerToken(
    secretReference: string,
    context: { tenant_id: string; factory_id: string; connector_id: string },
  ): Promise<string>;
}

export interface FinanceJsonHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  bearerToken?: string;
  /** Explicit auth header for Vault API calls; provider tokens otherwise use Bearer auth. */
  authHeader?: { name: 'Authorization' | 'X-Vault-Token'; value: string };
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface FinanceJsonHttpClient {
  request<T>(input: FinanceJsonHttpRequest): Promise<T>;
}

type ResolvedAddress = { address: string; family: number };
type FinanceDnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

function csvSet(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function inIpv4Range(address: string, prefix: number[], maskBits: number): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const value = octets.reduce((acc, part) => (acc * 256) + part, 0);
  const base = prefix.reduce((acc, part) => (acc * 256) + part, 0);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return ((value >>> 0) & mask) === ((base >>> 0) & mask);
}

/** Conservative global-unicast check. Unknown address forms fail closed. */
export function isFinancePublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const blocked: Array<[number[], number]> = [
      [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10],
      [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
      [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24],
      [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
      [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
    ];
    return !blocked.some(([prefix, bits]) => inIpv4Range(address, prefix, bits));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.includes('%') || normalized.startsWith('::ffff:') ||
      normalized.startsWith('2001:db8:') || normalized.startsWith('2001:10:') ||
      normalized.startsWith('2002:') || normalized.startsWith('3fff:') ||
      normalized === '::' || normalized === '::1') return false;
  // 2000::/3 is global-unicast space; reject IETF protocol-assignment space too.
  const parts = normalized.split(':');
  const firstHextet = Number.parseInt(parts[0] || '0', 16);
  const secondHextet = Number.parseInt(parts[1] || '0', 16);
  if (firstHextet === 0x2001 && secondHextet <= 0x01ff) return false;
  return Number.isInteger(firstHextet) && firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

/**
 * Resolve once and pin one vetted public IP to the TLS request. A DNS answer
 * containing even one private/reserved address is rejected (rebinding defense).
 */
export async function resolveFinancePinnedAddress(
  hostname: string,
  allowedHosts: ReadonlySet<string>,
  allowedIps: ReadonlySet<string>,
  lookup: FinanceDnsLookup = async (host) => {
    const answers = await dns.lookup(host, { all: true, verbatim: true });
    return answers.map((item) => ({ address: item.address, family: item.family }));
  },
): Promise<ResolvedAddress> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || isIP(host) !== 0 || !allowedHosts.has(host)) {
    throw new Error('FINANCE_ERP_HOST_NOT_ALLOWLISTED');
  }
  if (allowedIps.size === 0) throw new Error('FINANCE_ERP_IP_ALLOWLIST_REQUIRED');
  const answers = await lookup(host);
  if (answers.length === 0) throw new Error('FINANCE_ERP_DNS_EMPTY');
  for (const answer of answers) {
    if (!isFinancePublicAddress(answer.address)) throw new Error('FINANCE_ERP_DNS_RESOLVED_NON_PUBLIC_ADDRESS');
    if (!allowedIps.has(answer.address.toLowerCase())) throw new Error('FINANCE_ERP_RESOLVED_IP_NOT_ALLOWLISTED');
  }
  return answers[0];
}

function financeLookupForPinnedAddress(address: ResolvedAddress): NonNullable<RequestOptions['lookup']> {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    void hostname;
    const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
    if (typeof options === 'object' && options !== null && 'all' in options &&
        (options as { all?: boolean }).all) {
      cb(null, [{ address: address.address, family: address.family }]);
    } else {
      cb(null, address.address, address.family);
    }
  }) as NonNullable<RequestOptions['lookup']>;
}

/** HTTPS JSON client with exact host/IP allowlists, DNS pinning and no redirects. */
@Injectable()
export class PinnedFinanceJsonHttpClient implements FinanceJsonHttpClient {
  constructor(
    private readonly allowedHosts: ReadonlySet<string> = csvSet(process.env.FINANCE_ERP_ALLOWED_HOSTS),
    private readonly allowedIps: ReadonlySet<string> = csvSet(process.env.FINANCE_ERP_ALLOWED_IPS),
    private readonly dnsLookup: FinanceDnsLookup = async (host) => {
      const answers = await dns.lookup(host, { all: true, verbatim: true });
      return answers.map((item) => ({ address: item.address, family: item.family }));
    },
  ) {}

  async request<T>(input: FinanceJsonHttpRequest): Promise<T> {
    const url = new URL(input.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('FINANCE_ERP_HTTPS_ENDPOINT_REQUIRED');
    }
    const authHeader = input.authHeader ?? (input.bearerToken
      ? { name: 'Authorization' as const, value: 'Bearer ' + input.bearerToken }
      : null);
    if (!authHeader || !authHeader.value || /[\\r\\n\\u0000-\\u001f\\u007f]/.test(authHeader.value)) {
      throw new Error('FINANCE_ERP_AUTH_HEADER_INVALID');
    }
    const pinned = await resolveFinancePinnedAddress(url.hostname, this.allowedHosts, this.allowedIps, this.dnsLookup);
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8');
    if (body && body.length > 3 * 1024 * 1024) throw new Error('FINANCE_ERP_REQUEST_TOO_LARGE');

    return new Promise<T>((resolve, reject) => {
      const requestOptions: RequestOptions = {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        method: input.method,
        path: url.pathname + url.search,
        headers: {
          Accept: 'application/json',
          [authHeader.name]: authHeader.value,
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        },
        servername: url.hostname,
        agent: false,
        lookup: financeLookupForPinnedAddress(pinned),
      };
      const req = https.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy(new Error('FINANCE_ERP_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // Never echo provider response bodies, endpoint tokens, or Authorization headers.
            reject(new Error(status >= 300 && status < 400
              ? 'FINANCE_ERP_REDIRECT_REJECTED'
              : 'FINANCE_ERP_PROVIDER_HTTP_' + status));
            return;
          }
          const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
          if (!contentType.includes('application/json')) {
            reject(new Error('FINANCE_ERP_RESPONSE_NOT_JSON'));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            reject(new Error('FINANCE_ERP_RESPONSE_JSON_INVALID'));
          }
        });
      });
      req.setTimeout(10_000, () => req.destroy(new Error('FINANCE_ERP_REQUEST_TIMEOUT')));
      req.on('error', (error) => reject(error));
      if (body) req.write(body);
      req.end();
    });
  }
}

type BusinessCentralBatch = {
  id: unknown;
  externalBatchRef: unknown;
  fileName: unknown;
  format: unknown;
  contentBase64: unknown;
  sourceOccurredAt?: unknown;
};
type BusinessCentralResponse = { value?: unknown; id?: unknown; payloadSha256?: unknown; bytesWritten?: unknown };

const BUSINESS_CENTRAL_PROVIDER = 'MICROSOFT_DYNAMICS_365_BUSINESS_CENTRAL_FINANCE_EXCHANGE_V1';

function requireCompanyId(configuration: Record<string, unknown>): string {
  if (configuration.provider !== BUSINESS_CENTRAL_PROVIDER ||
      typeof configuration.company_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(configuration.company_id)) {
    throw new Error('FINANCE_BUSINESS_CENTRAL_CONFIGURATION_INVALID');
  }
  return configuration.company_id;
}

function endpointBase(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      isIP(url.hostname) !== 0) {
    throw new Error('FINANCE_BUSINESS_CENTRAL_ENDPOINT_INVALID');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function joinProviderPath(base: URL, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') ||
      path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('FINANCE_BUSINESS_CENTRAL_PATH_INVALID');
  }
  const result = new URL(base.toString());
  result.pathname = base.pathname + path;
  result.search = '';
  result.hash = '';
  return result.toString();
}

function safeProviderFilename(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) ||
      value === '.' || value === '..') {
    throw new Error('FINANCE_BUSINESS_CENTRAL_FILENAME_INVALID');
  }
  return value;
}

function canonicalBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length < 4 || value.length > 2796204 ||
      value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('FINANCE_BUSINESS_CENTRAL_BASE64_INVALID');
  }
  const content = Buffer.from(value, 'base64');
  if (content.length < 1 || content.length > 2 * 1024 * 1024 || content.toString('base64') !== value) {
    throw new Error('FINANCE_BUSINESS_CENTRAL_PAYLOAD_SIZE_OR_ENCODING_INVALID');
  }
  return content;
}

function stableIdempotencyKey(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]))).digest('hex');
}

/**
 * Microsoft Dynamics 365 Business Central adapter for the reviewed FactoryOS
 * Finance Exchange AL API extension. This is intentionally not a journal-posting
 * adapter: it only fetches exchange files, acknowledges receipt/quarantine, and
 * uploads export artifacts to the provider's idempotent exchange staging API.
 *
 * Required AL extension API contract and setup are documented in
 * docs/finance-erp-production-connectors.md.
 */
@Injectable()
export class MicrosoftDynamics365BusinessCentralFinanceAdapter implements FinanceErpTransferAdapter {
  constructor(
    @Optional() @Inject(FINANCE_SECRET_MANAGER) private readonly secrets?: FinanceSecretManager,
    @Optional() @Inject(FINANCE_BUSINESS_CENTRAL_HTTP_CLIENT) private readonly http?: FinanceJsonHttpClient,
  ) {}

  private async accessToken(secretReference: string, context: {
    tenant_id: string; factory_id: string; connector_id: string;
  }): Promise<string> {
    const validated = validateFinanceSecretReference(secretReference);
    if (!validated) throw new Error('FINANCE_SECRET_REFERENCE_REQUIRED');
    if (!this.secrets) throw new Error('FINANCE_SECRET_MANAGER_NOT_CONFIGURED');
    const token = await this.secrets.resolveBearerToken(validated, context);
    if (typeof token !== 'string' || token.trim().length < 8 || token.length > 8192 ||
        /[\\r\\n\\u0000-\\u001f\\u007f]/.test(token)) {
      throw new Error('FINANCE_SECRET_MANAGER_RETURNED_INVALID_ACCESS_TOKEN');
    }
    return token.trim();
  }

  private client(): FinanceJsonHttpClient {
    return this.http ?? new PinnedFinanceJsonHttpClient();
  }

  async downloadNext(input: Parameters<FinanceErpTransferAdapter['downloadNext']>[0]): Promise<FinanceErpFileDownload | null> {
    const companyId = requireCompanyId(input.configuration);
    const base = endpointBase(input.endpoint_url);
    const token = await this.accessToken(input.secret_reference, input);
    const path = '/api/factoryos/finance/v1.0/companies(' + companyId + ')/financeBatches/next';
    const response = await this.client().request<BusinessCentralResponse>({
      url: joinProviderPath(base, path), method: 'GET', bearerToken: token,
    });
    if (!response || !Array.isArray(response.value) || response.value.length > 1) {
      throw new Error('FINANCE_BUSINESS_CENTRAL_BATCH_RESPONSE_INVALID');
    }
    if (response.value.length === 0) return null;
    const batch = response.value[0] as BusinessCentralBatch;
    const providerReference = normalizeFinanceErpOpaqueReference(batch?.id, 'provider_reference');
    const sourceBatchRef = normalizeFinanceErpOpaqueReference(batch?.externalBatchRef, 'source_batch_ref');
    const fileName = safeProviderFilename(batch?.fileName);
    if (batch?.format !== 'CSV' && batch?.format !== 'JSON') {
      throw new Error('FINANCE_BUSINESS_CENTRAL_FORMAT_INVALID');
    }
    const content = canonicalBase64(batch?.contentBase64);
    let sourceOccurredAt: string | undefined;
    if (batch.sourceOccurredAt !== undefined && batch.sourceOccurredAt !== null) {
      if (typeof batch.sourceOccurredAt !== 'string' || !Number.isFinite(Date.parse(batch.sourceOccurredAt))) {
        throw new Error('FINANCE_BUSINESS_CENTRAL_SOURCE_TIMESTAMP_INVALID');
      }
      sourceOccurredAt = new Date(batch.sourceOccurredAt).toISOString();
    }
    return {
      source_batch_ref: sourceBatchRef,
      file_name: fileName,
      format: batch.format,
      content,
      provider_reference: providerReference,
      ...(sourceOccurredAt ? { source_occurred_at: sourceOccurredAt } : {}),
    };
  }

  async acknowledge(input: Parameters<FinanceErpTransferAdapter['acknowledge']>[0]): Promise<void> {
    const companyId = requireCompanyId(input.configuration);
    const base = endpointBase(input.endpoint_url);
    const token = await this.accessToken(input.secret_reference, input);
    const sourceBatchRef = normalizeFinanceErpOpaqueReference(input.source_batch_ref, 'source_batch_ref');
    const providerReference = normalizeFinanceErpOpaqueReference(input.provider_reference, 'provider_reference');
    if (!/^[a-f0-9]{64}$/.test(input.payload_sha256)) throw new Error('FINANCE_BUSINESS_CENTRAL_HASH_INVALID');
    const idempotencyKey = stableIdempotencyKey({
      tenant_id: input.tenant_id, factory_id: input.factory_id, connector_id: input.connector_id,
      source_batch_ref: sourceBatchRef, provider_reference: providerReference,
      payload_sha256: input.payload_sha256, disposition: input.disposition,
    });
    const path = '/api/factoryos/finance/v1.0/companies(' + companyId + ')/financeBatches(' +
      encodeURIComponent(providerReference) + ')/acknowledge';
    await this.client().request<unknown>({
      url: joinProviderPath(base, path), method: 'POST', bearerToken: token, idempotencyKey,
      body: {
        externalBatchRef: sourceBatchRef,
        payloadSha256: input.payload_sha256,
        disposition: input.disposition,
        idempotencyKey,
      },
    });
  }

  async upload(input: Parameters<FinanceErpTransferAdapter['upload']>[0]): Promise<FinanceErpUploadResult> {
    const companyId = requireCompanyId(input.configuration);
    const base = endpointBase(input.endpoint_url);
    const token = await this.accessToken(input.secret_reference, input);
    const fileName = safeProviderFilename(input.file_name);
    if (input.format !== 'CSV' && input.format !== 'JSON') throw new Error('FINANCE_BUSINESS_CENTRAL_FORMAT_INVALID');
    if (!Buffer.isBuffer(input.content) || input.content.length < 1 || input.content.length > 2 * 1024 * 1024 ||
        createHash('sha256').update(input.content).digest('hex') !== input.payload_sha256) {
      throw new Error('FINANCE_BUSINESS_CENTRAL_EXPORT_HASH_OR_SIZE_INVALID');
    }
    const idempotencyKey = stableIdempotencyKey({
      tenant_id: input.tenant_id, factory_id: input.factory_id, connector_id: input.connector_id,
      file_name: fileName, format: input.format, payload_sha256: input.payload_sha256,
    });
    const path = '/api/factoryos/finance/v1.0/companies(' + companyId + ')/financeExports';
    const response = await this.client().request<BusinessCentralResponse>({
      url: joinProviderPath(base, path), method: 'POST', bearerToken: token, idempotencyKey,
      body: {
        fileName,
        format: input.format,
        payloadSha256: input.payload_sha256,
        bytesWritten: input.content.length,
        contentBase64: input.content.toString('base64'),
        idempotencyKey,
      },
    });
    const providerReference = normalizeFinanceErpOpaqueReference(response?.id, 'provider_reference');
    if (response.payloadSha256 !== input.payload_sha256 ||
        response.bytesWritten !== input.content.length) {
      throw new Error('FINANCE_BUSINESS_CENTRAL_EXPORT_ACK_MISMATCH');
    }
    return {
      provider_reference: providerReference,
      payload_sha256: input.payload_sha256,
      bytes_written: input.content.length,
    };
  }
}
