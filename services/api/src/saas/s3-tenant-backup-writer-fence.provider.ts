import { createHash, createHmac } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_MULTIPART_BYTES = 4 * 1024 * 1024;
const MAX_MULTIPART_UPLOADS = 10000;
const MAX_MULTIPART_PAGES = 100;
const MULTIPART_PAGE_SIZE = 1000;
const CATEGORIES = new Set(Object.values(SaasTransferDatasetCategory));

interface PolicyConfig {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  timeoutMs: number;
}

type JsonObject = Record<string, unknown>;
interface BucketPolicy extends JsonObject {
  Version: string;
  Statement: JsonObject[];
}
interface ReadPolicy {
  exists: boolean;
  policy: BucketPolicy;
}
interface MultipartInventory {
  count: number;
  digest: string;
}
export interface S3TenantBackupWriterFenceEvidence {
  providerFenceReference: string;
  providerPolicyDigest: string;
  scopePrefixDigest: string;
  multipartInventoryDigest: string;
  pendingMultipartUploads: number;
}
export interface S3TenantBackupWriterFenceReleasePlan {
  providerFenceReference: string;
  currentPolicyDigest: string;
  releasePolicyDigest: string;
  policyPresent: boolean;
}
export interface S3TenantBackupWriterFenceRemovalEvidence {
  providerFenceReference: string;
  providerPolicyDigest: string;
  policyAbsent: true;
  alreadyAbsent: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function queryEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalQuery(parameters: Array<[string, string]>): string {
  return parameters.map(([key, value]) => [queryEncode(key), queryEncode(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey < bKey ? -1 : aKey > bKey ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('&');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((entry) => canonicalJson(entry)).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function xmlText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'));
  if (!match) return null;
  const value = match[1]!.trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_all, decimal: string) => String.fromCodePoint(Number(decimal)));
  if (/&(?:#|[A-Za-z])/.test(value)) throw new ServiceUnavailableException('S3 provider returned malformed XML encoding');
  return value;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceUnavailableException('S3 provider returned an unreadable response');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ServiceUnavailableException('S3 provider response exceeded its configured safety bound');
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch {
    throw new ServiceUnavailableException('S3 provider response was incomplete or exceeded its safety bound');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function policyDigest(policy: BucketPolicy): string {
  return sha256(canonicalJson(policy));
}

function normalizePolicy(value: unknown): BucketPolicy {
  if (!isRecord(value)) throw new ServiceUnavailableException('S3 bucket policy is not a JSON object');
  const version = value.Version;
  if (version !== '2012-10-17' && version !== '2008-10-17') {
    throw new ServiceUnavailableException('S3 bucket policy has an unsupported or missing policy version');
  }
  const rawStatements = Array.isArray(value.Statement)
    ? value.Statement
    : isRecord(value.Statement) ? [value.Statement] : null;
  if (!rawStatements || rawStatements.some((statement) => !isRecord(statement))) {
    throw new ServiceUnavailableException('S3 bucket policy has a malformed Statement collection');
  }
  return { ...value, Version: version, Statement: rawStatements as JsonObject[] } as BucketPolicy;
}

function emptyPolicy(): BucketPolicy {
  return { Version: '2012-10-17', Statement: [] };
}

@Injectable()
export class S3TenantBackupWriterFenceProvider {
  constructor(private readonly config: ConfigService) {}

  /**
   * Installs a bucket-policy Deny for PutObject on exactly one tenant/category
   * prefix and independently reads the policy back. The separate policy
   * credential must have only reviewed policy-read/write and multipart-list
   * privileges. Policy mutation is disabled unless the bucket-policy owner has
   * explicitly asserted exclusive ownership through deployment configuration.
   */
  async installFence(input: {
    tenantId: string;
    category: SaasTransferDatasetCategory;
    fenceId: string;
  }): Promise<S3TenantBackupWriterFenceEvidence> {
    const storage = this.readConfiguration();
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const category = this.category(input?.category);
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const prefix = this.prefix(tenantId, category);
    const statement = this.fenceStatement(storage.bucket, tenantId, category, fenceId);
    const reference = this.reference(fenceId);
    const before = await this.getPolicy(storage);
    const existing = before.policy.Statement.find((entry) => entry.Sid === statement.Sid);

    let expectedPolicy = before.policy;
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(statement)) {
        throw new ConflictException('S3 bucket policy already uses the writer-fence statement ID for different content');
      }
    } else {
      const latest = await this.getPolicy(storage);
      if (latest.exists !== before.exists || policyDigest(latest.policy) !== policyDigest(before.policy)) {
        throw new ConflictException('S3 bucket policy changed during writer-fence preflight; no policy mutation was attempted');
      }
      expectedPolicy = {
        ...before.policy,
        Statement: [...before.policy.Statement, statement],
      };
      await this.putPolicy(storage, expectedPolicy);
    }

    const readback = await this.getPolicy(storage);
    const readbackStatement = readback.policy.Statement.find((entry) => entry.Sid === statement.Sid);
    if (!readback.exists || !readbackStatement || canonicalJson(readbackStatement) !== canonicalJson(statement)
      || policyDigest(readback.policy) !== policyDigest(expectedPolicy)) {
      throw new ServiceUnavailableException('S3 write-deny policy did not match the independently read-back policy; keep the application fence closed');
    }

    // Denying PutObject blocks new object puts and multipart upload/complete
    // actions covered by that authorization. Any already-open multipart upload
    // remains unresolved until it is reconciled; callers must not mark FENCED
    // while this count is non-zero.
    const multipart = await this.listMultipartUploads(storage, prefix);
    return {
      providerFenceReference: reference,
      providerPolicyDigest: policyDigest(readback.policy),
      scopePrefixDigest: sha256(prefix),
      multipartInventoryDigest: multipart.digest,
      pendingMultipartUploads: multipart.count,
    };
  }

  /** Read-only readiness check used before recording provider enforcement. */
  async inspectFence(input: {
    tenantId: string;
    category: SaasTransferDatasetCategory;
    fenceId: string;
  }): Promise<S3TenantBackupWriterFenceEvidence & { installed: boolean }> {
    const storage = this.readConfiguration();
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const category = this.category(input?.category);
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const statement = this.fenceStatement(storage.bucket, tenantId, category, fenceId);
    const policy = await this.getPolicy(storage);
    const installed = policy.exists && policy.policy.Statement.some((entry) =>
      entry.Sid === statement.Sid && canonicalJson(entry) === canonicalJson(statement));
    const prefix = this.prefix(tenantId, category);
    const multipart = await this.listMultipartUploads(storage, prefix);
    return {
      providerFenceReference: this.reference(fenceId),
      providerPolicyDigest: policyDigest(policy.policy),
      scopePrefixDigest: sha256(prefix),
      multipartInventoryDigest: multipart.digest,
      pendingMultipartUploads: multipart.count,
      installed,
    };
  }

  /** Plan a removal without mutating provider state; persist the planned digest first. */
  async planFenceRemoval(input: {
    tenantId: string;
    category: SaasTransferDatasetCategory;
    fenceId: string;
  }): Promise<S3TenantBackupWriterFenceReleasePlan> {
    const storage = this.readConfiguration();
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const category = this.category(input?.category);
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const statement = this.fenceStatement(storage.bucket, tenantId, category, fenceId);
    const current = await this.getPolicy(storage);
    const existing = current.policy.Statement.find((entry) => entry.Sid === statement.Sid);
    if (existing && canonicalJson(existing) !== canonicalJson(statement)) {
      throw new ConflictException('S3 bucket policy writer-fence statement was modified outside its reviewed lifecycle');
    }
    if (!existing) {
      return {
        providerFenceReference: this.reference(fenceId),
        currentPolicyDigest: policyDigest(current.policy),
        releasePolicyDigest: policyDigest(current.policy),
        policyPresent: false,
      };
    }
    const next: BucketPolicy = {
      ...current.policy,
      Statement: current.policy.Statement.filter((entry) => entry.Sid !== statement.Sid),
    };
    return {
      providerFenceReference: this.reference(fenceId),
      currentPolicyDigest: policyDigest(current.policy),
      releasePolicyDigest: policyDigest(next),
      policyPresent: true,
    };
  }

  /**
   * Removes only the exact writer-fence statement. expected digests bind the
   * mutation to the release plan committed in the durable lifecycle ledger.
   */
  async removeFence(input: {
    tenantId: string;
    category: SaasTransferDatasetCategory;
    fenceId: string;
    expectedCurrentPolicyDigest: string;
    expectedReleasePolicyDigest: string;
  }): Promise<S3TenantBackupWriterFenceRemovalEvidence> {
    const storage = this.readConfiguration();
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const category = this.category(input?.category);
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const expectedCurrent = this.digest(input?.expectedCurrentPolicyDigest, 'expectedCurrentPolicyDigest');
    const expectedRelease = this.digest(input?.expectedReleasePolicyDigest, 'expectedReleasePolicyDigest');
    const statement = this.fenceStatement(storage.bucket, tenantId, category, fenceId);
    const reference = this.reference(fenceId);
    const current = await this.getPolicy(storage);
    const existing = current.policy.Statement.find((entry) => entry.Sid === statement.Sid);

    if (!existing) {
      if (policyDigest(current.policy) !== expectedRelease) {
        throw new ConflictException('Writer-fence policy is absent but bucket policy digest does not match the durable release plan');
      }
      return {
        providerFenceReference: reference,
        providerPolicyDigest: policyDigest(current.policy),
        policyAbsent: true,
        alreadyAbsent: true,
      };
    }
    if (canonicalJson(existing) !== canonicalJson(statement)) {
      throw new ConflictException('S3 bucket policy writer-fence statement was modified outside its reviewed lifecycle');
    }
    if (policyDigest(current.policy) !== expectedCurrent) {
      throw new ConflictException('S3 bucket policy changed after release was sealed; the fence statement was not removed');
    }

    const next: BucketPolicy = {
      ...current.policy,
      Statement: current.policy.Statement.filter((entry) => entry.Sid !== statement.Sid),
    };
    if (policyDigest(next) !== expectedRelease) {
      throw new ConflictException('S3 writer-fence release plan no longer matches the current bucket policy');
    }
    const latest = await this.getPolicy(storage);
    if (!latest.exists || policyDigest(latest.policy) !== expectedCurrent) {
      throw new ConflictException('S3 bucket policy changed immediately before release; no policy mutation was attempted');
    }
    await this.putPolicy(storage, next);
    const readback = await this.getPolicy(storage);
    const stillPresent = readback.policy.Statement.some((entry) => entry.Sid === statement.Sid);
    if (stillPresent || policyDigest(readback.policy) !== expectedRelease) {
      throw new ServiceUnavailableException('S3 writer-fence removal could not be confirmed by policy read-back');
    }
    return {
      providerFenceReference: reference,
      providerPolicyDigest: policyDigest(readback.policy),
      policyAbsent: true,
      alreadyAbsent: false,
    };
  }

  private readConfiguration(): PolicyConfig {
    const required = (name: string): string => {
      const value = this.config.get<string>(name)?.trim();
      if (!value || /[\r\n]/.test(value)) throw new ServiceUnavailableException('S3 writer-fence policy configuration is incomplete or invalid');
      return value;
    };
    if (this.config.get<string>('FACTORYOS_BACKUP_STORAGE_POLICY_CONTROLLER_ENABLED') !== 'true'
      || this.config.get<string>('FACTORYOS_BACKUP_STORAGE_POLICY_OWNERSHIP_ACKNOWLEDGED') !== 'true') {
      throw new ServiceUnavailableException('S3 writer-fence policy mutation is disabled until exclusive bucket-policy ownership is reviewed');
    }
    const expectedReference = required('FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE');
    if (required('FACTORYOS_BACKUP_STORAGE_POLICY_CONFIG_REFERENCE') !== expectedReference) {
      throw new ServiceUnavailableException('S3 policy controller config reference does not match the reviewed backup storage target');
    }
    let endpoint: URL;
    try {
      endpoint = new URL(required('FACTORYOS_BACKUP_STORAGE_ENDPOINT'));
    } catch {
      throw new ServiceUnavailableException('S3 writer-fence endpoint is invalid');
    }
    const bucket = required('FACTORYOS_BACKUP_STORAGE_BUCKET');
    const region = required('FACTORYOS_BACKUP_STORAGE_REGION');
    const maxObjectTimeout = this.config.get<string>('FACTORYOS_BACKUP_STORAGE_TIMEOUT_MS');
    const timeoutMs = maxObjectTimeout === undefined || maxObjectTimeout.trim() === '' ? 10000 : Number(maxObjectTimeout);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash
      || (this.config.get<string>('NODE_ENV') === 'production' && endpoint.protocol !== 'https:')
      || !SAFE_BUCKET.test(bucket) || !SAFE_REGION.test(region)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw new ServiceUnavailableException('S3 writer-fence provider configuration is outside the supported safety bounds');
    }
    const sessionToken = this.config.get<string>('FACTORYOS_BACKUP_STORAGE_POLICY_SESSION_TOKEN')?.trim() || undefined;
    return {
      endpoint, bucket, region,
      accessKeyId: required('FACTORYOS_BACKUP_STORAGE_POLICY_ACCESS_KEY_ID'),
      secretAccessKey: required('FACTORYOS_BACKUP_STORAGE_POLICY_SECRET_ACCESS_KEY'),
      sessionToken, timeoutMs,
    };
  }

  private fenceStatement(bucket: string, tenantId: string, category: SaasTransferDatasetCategory, fenceId: string): JsonObject {
    return {
      Sid: 'FactoryOSBackupWriterFence' + fenceId.replace(/-/g, ''),
      Effect: 'Deny',
      Principal: '*',
      // Replication writes use a separate S3 authorization action; PutObject alone
      // does not fence an S3 replication role from recreating objects in this prefix.
      Action: ['s3:PutObject', 's3:ReplicateObject'],
      Resource: 'arn:aws:s3:::' + bucket + '/' + this.prefix(tenantId, category) + '*',
    };
  }

  private async getPolicy(storage: PolicyConfig): Promise<ReadPolicy> {
    const response = await this.request(storage, 'GET', [['policy', '']]);
    if (response.status === 200) {
      const body = await boundedText(response, MAX_POLICY_BYTES);
      let parsed: unknown;
      try { parsed = JSON.parse(body) as unknown; } catch {
        throw new ServiceUnavailableException('S3 bucket policy response is not valid JSON');
      }
      return { exists: true, policy: normalizePolicy(parsed) };
    }
    const body = await boundedText(response, MAX_POLICY_BYTES);
    if (response.status === 404 && xmlText(body, 'Code') === 'NoSuchBucketPolicy') {
      return { exists: false, policy: emptyPolicy() };
    }
    throw new ServiceUnavailableException('S3 bucket policy could not be read; policy mutation is blocked');
  }

  private async putPolicy(storage: PolicyConfig, policy: BucketPolicy): Promise<void> {
    const body = JSON.stringify(policy);
    if (Buffer.byteLength(body, 'utf8') > MAX_POLICY_BYTES) {
      throw new ConflictException('S3 bucket policy exceeds the supported request bound');
    }
    const response = await this.request(storage, 'PUT', [['policy', '']], body);
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 200 && response.status !== 204) {
      throw new ServiceUnavailableException('S3 provider did not accept the scoped writer-fence bucket policy');
    }
  }

  private async listMultipartUploads(storage: PolicyConfig, prefix: string): Promise<MultipartInventory> {
    const identities: string[] = [];
    const seenMarkers = new Set<string>();
    let keyMarker: string | null = null;
    let uploadIdMarker: string | null = null;
    for (let page = 1; page <= MAX_MULTIPART_PAGES; page += 1) {
      const query: Array<[string, string]> = [
        ['uploads', ''], ['prefix', prefix], ['max-uploads', String(MULTIPART_PAGE_SIZE)],
      ];
      if (keyMarker !== null) query.push(['key-marker', keyMarker]);
      if (uploadIdMarker !== null) query.push(['upload-id-marker', uploadIdMarker]);
      const response = await this.request(storage, 'GET', query);
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new ServiceUnavailableException('S3 multipart-upload inventory could not be verified');
      }
      const xml = await boundedText(response, MAX_MULTIPART_BYTES);
      for (const match of xml.matchAll(/<Upload(?:\s[^>]*)?>([\s\S]*?)<\/Upload>/gi)) {
        const key = xmlText(match[1]!, 'Key');
        const uploadId = xmlText(match[1]!, 'UploadId');
        if (!key || !uploadId || !key.startsWith(prefix) || key.length > 500 || uploadId.length > 1024) {
          throw new ServiceUnavailableException('S3 multipart-upload inventory returned an invalid or out-of-scope identity');
        }
        identities.push(key + '\u0000' + uploadId);
        if (identities.length > MAX_MULTIPART_UPLOADS) {
          throw new ConflictException('S3 prefix has too many unfinished multipart uploads to fence safely');
        }
      }
      const truncated = xmlText(xml, 'IsTruncated');
      if (truncated === 'false') break;
      if (truncated !== 'true') throw new ServiceUnavailableException('S3 multipart inventory has no valid IsTruncated marker');
      const nextKey = xmlText(xml, 'NextKeyMarker');
      const nextUpload = xmlText(xml, 'NextUploadIdMarker');
      if (!nextKey || nextKey.length > 500 || (nextKey === keyMarker && (nextUpload ?? null) === uploadIdMarker)) {
        throw new ServiceUnavailableException('S3 multipart inventory pagination marker is missing or repeated');
      }
      const marker = nextKey + '\u0000' + (nextUpload ?? '');
      if (seenMarkers.has(marker)) throw new ServiceUnavailableException('S3 multipart inventory repeated a pagination marker');
      seenMarkers.add(marker);
      keyMarker = nextKey;
      uploadIdMarker = nextUpload;
      if (page === MAX_MULTIPART_PAGES) throw new ConflictException('S3 multipart inventory exceeded its page bound');
    }
    identities.sort();
    return { count: identities.length, digest: sha256(JSON.stringify(identities)) };
  }

  private async request(
    storage: PolicyConfig,
    method: 'GET' | 'PUT',
    parameters: Array<[string, string]>,
    body?: string,
  ): Promise<Response> {
    const basePath = storage.endpoint.pathname === '/' ? '' : storage.endpoint.pathname.replace(/\/+$/, '');
    const canonicalUri = basePath + '/' + queryEncode(storage.bucket);
    const query = canonicalQuery(parameters);
    const target = new URL(storage.endpoint.origin);
    target.pathname = canonicalUri;
    target.search = query ? '?' + query : '';
    const payload = body ?? '';
    const payloadHash = sha256(Buffer.from(payload, 'utf8'));
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const canonicalHeaders: Record<string, string> = {
      host: target.host.toLowerCase(),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (body !== undefined) canonicalHeaders['content-type'] = 'application/json';
    if (storage.sessionToken) canonicalHeaders['x-amz-security-token'] = storage.sessionToken;
    const headerNames = Object.keys(canonicalHeaders).sort();
    const canonicalHeaderText = headerNames.map((name) =>
      name + ':' + canonicalHeaders[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
    const signedHeaders = headerNames.join(';');
    const canonicalRequest = [
      method, canonicalUri, query, canonicalHeaderText, signedHeaders, payloadHash,
    ].join('\n');
    const scope = dateStamp + '/' + storage.region + '/s3/aws4_request';
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest),
    ].join('\n');
    const signingKey = createHmac('sha256',
      createHmac('sha256',
        createHmac('sha256',
          createHmac('sha256', 'AWS4' + storage.secretAccessKey).update(dateStamp).digest(),
        ).update(storage.region).digest(),
      ).update('s3').digest(),
    ).update('aws4_request').digest();
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const headers: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'accept-encoding': 'identity',
      Authorization: 'AWS4-HMAC-SHA256 Credential=' + storage.accessKeyId + '/' + scope
        + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (storage.sessionToken) headers['x-amz-security-token'] = storage.sessionToken;
    try {
      return await globalThis.fetch(target, {
        method, headers, ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(storage.timeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException('S3 writer-fence provider request failed or timed out');
    }
  }

  private prefix(tenantId: string, category: SaasTransferDatasetCategory): string {
    return 'factoryos-backups/' + tenantId + '/' + category + '/';
  }

  private uuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value.toLowerCase();
  }

  private category(value: unknown): SaasTransferDatasetCategory {
    if (typeof value !== 'string' || !CATEGORIES.has(value as SaasTransferDatasetCategory)) {
      throw new BadRequestException('Unsupported backup writer-fence category');
    }
    return value as SaasTransferDatasetCategory;
  }

  private digest(value: unknown, field: string): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new BadRequestException(field + ' must be a lowercase SHA-256 digest');
    return value;
  }

  private reference(fenceId: string): string {
    return 's3-bucket-policy-fence.' + fenceId.replace(/-/g, '');
  }
}
