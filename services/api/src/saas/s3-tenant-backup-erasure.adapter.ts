import { createHash, createHmac } from 'node:crypto';
import { ConflictException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3TenantBackupWriterFenceProvider } from './s3-tenant-backup-writer-fence.provider';
import { SaasTenantBackupWriterInventoryService } from './saas-tenant-backup-writer-inventory.service';
import type {
  SaasExternalPropagationContext,
  SaasExternalPropagationDeleteReceipt,
  SaasExternalPropagationPlan,
  SaasExternalPropagationResourceIdentity,
  SaasExternalPropagationVerification,
  SaasTenantExternalDataPropagationAdapter,
  SaasTenantExternalDataTarget,
} from './saas-tenant-propagation.adapters';
import { digestSaasExternalPropagationResources } from './saas-tenant-propagation.adapters';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

const STORE_KIND = 'BACKUP' as const;
const ADAPTER_KEY = 's3.tenant-backup.v1';
const ADAPTER_VERSION = '1.0.0';
const CONFIG_REFERENCE = 'FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE';
const RESOURCE_VERSION = 'S3_BACKUP_OBJECT_VERSION';
const RESOURCE_DELETE_MARKER = 'S3_BACKUP_DELETE_MARKER';
const PAGE_SIZE = 1000;
const DB_BATCH_SIZE = 250;
const MAX_VERSIONS = 20000;
const MAX_PAGES = 1000;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_MAX_OBJECT_BYTES = 1024 * 1024 * 1024;
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/;
const SAFE_VERSION = /^(?:null|[A-Za-z0-9][A-Za-z0-9._:/-]{0,199})$/;
function isSafeVersionReference(value: string): boolean {
  return SAFE_VERSION.test(value) && !value.includes('://')
    && !/(secret|password|credential|access[-_]?key|token)/i.test(value);
}
const CATEGORY_VALUES = new Set(Object.values(SaasTransferDatasetCategory));

interface BackupS3Config {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  maxObjectBytes: number;
  timeoutMs: number;
}

interface VersionIdentity {
  key: string;
  versionId: string;
  deleteMarker: boolean;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function queryEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalQuery(parameters: Array<[string, string]>): string {
  return parameters
    .map(([name, value]) => [queryEncode(name), queryEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName < rightName ? -1 : leftName > rightName ? 1
        : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([name, value]) => name + '=' + value)
    .join('&');
}

function decodeXmlText(value: string): string {
  const decoded = value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)));
  if (/&(?:#|[A-Za-z])/.test(decoded)) {
    throw new ServiceUnavailableException('Backup storage returned malformed XML entity encoding');
  }
  return decoded;
}

function xmlText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'));
  return match ? decodeXmlText(match[1]!.trim()) : null;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceUnavailableException('Backup storage response had no readable body');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ServiceUnavailableException('Backup storage response exceeded its size limit');
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch {
    throw new ServiceUnavailableException('Backup storage response was incomplete or exceeded its size limit');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function readConfiguration(config: ConfigService): BackupS3Config {
  const required = (name: string): string => {
    const value = config.get<string>(name)?.trim();
    if (!value || /[\r\n]/.test(value)) throw new ServiceUnavailableException('Backup storage configuration is incomplete or invalid');
    return value;
  };
  const endpointValue = required('FACTORYOS_BACKUP_STORAGE_ENDPOINT');
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new ServiceUnavailableException('Backup storage endpoint is invalid');
  }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || (config.get<string>('NODE_ENV') === 'production' && endpoint.protocol !== 'https:')) {
    throw new ServiceUnavailableException('Backup storage endpoint must be a credential-free HTTPS URL in production');
  }
  const bucket = required('FACTORYOS_BACKUP_STORAGE_BUCKET');
  const region = required('FACTORYOS_BACKUP_STORAGE_REGION');
  const accessKeyId = required('FACTORYOS_BACKUP_STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = required('FACTORYOS_BACKUP_STORAGE_SECRET_ACCESS_KEY');
  const maxObjectBytesRaw = config.get<string>('FACTORYOS_BACKUP_STORAGE_MAX_OBJECT_BYTES');
  const timeoutRaw = config.get<string>('FACTORYOS_BACKUP_STORAGE_TIMEOUT_MS');
  const maxObjectBytes = maxObjectBytesRaw === undefined || maxObjectBytesRaw.trim() === ''
    ? DEFAULT_MAX_OBJECT_BYTES : Number(maxObjectBytesRaw);
  const timeoutMs = timeoutRaw === undefined || timeoutRaw.trim() === '' ? 10000 : Number(timeoutRaw);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(region)
    || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > MAX_OBJECT_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new ServiceUnavailableException('Backup storage configuration is outside supported safety bounds');
  }
  const sessionToken = config.get<string>('FACTORYOS_BACKUP_STORAGE_SESSION_TOKEN')?.trim() || undefined;
  return { endpoint, bucket, region, accessKeyId, secretAccessKey, sessionToken, maxObjectBytes, timeoutMs };
}

function signRequest(
  storage: BackupS3Config,
  method: 'GET' | 'DELETE',
  target: URL,
  canonicalUri: string,
  query: string,
): Record<string, string> {
  const payloadHash = sha256(Buffer.alloc(0));
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const byName: Record<string, string> = {
    host: target.host.toLowerCase(),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (storage.sessionToken) byName['x-amz-security-token'] = storage.sessionToken;
  const names = Object.keys(byName).sort();
  const canonicalHeaders = names.map((name) => name + ':' + byName[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + storage.region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + storage.secretAccessKey, dateStamp), storage.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'accept-encoding': 'identity',
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + storage.accessKeyId + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  };
  if (storage.sessionToken) headers['x-amz-security-token'] = storage.sessionToken;
  return headers;
}

function tenantCategoryPrefix(tenantId: string, category: string): string {
  return 'factoryos-backups/' + tenantId.toLowerCase() + '/' + category + '/';
}

function assertSafeBackupKey(tenantId: string, categories: string[], key: string): void {
  if (key.length > 500 || !SAFE_REFERENCE.test(key) || key.includes('://')
    || /(secret|password|credential|access[-_]?key|token)/i.test(key)
    || key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ConflictException('Backup inventory returned an unsupported resource identity; erasure is blocked');
  }
  const matches = categories.filter((category) => key.startsWith(tenantCategoryPrefix(tenantId, category)));
  if (matches.length !== 1) throw new ConflictException('Backup inventory returned a key outside the exact tenant/category namespace');
  const finalSegments = key.split('/');
  if (finalSegments.length < 4) throw new ConflictException('Backup archive key does not identify a tenant-exclusive backup object');
}

@Injectable()
export class S3TenantBackupErasureAdapter implements SaasTenantExternalDataPropagationAdapter {
  readonly storeKind = STORE_KIND;
  readonly adapterKey = ADAPTER_KEY;
  readonly adapterVersion = ADAPTER_VERSION;

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(S3TenantBackupWriterFenceProvider)
    private readonly writerFenceProvider?: S3TenantBackupWriterFenceProvider,
    @Optional() @Inject(SaasTenantBackupWriterInventoryService)
    private readonly writerInventory?: SaasTenantBackupWriterInventoryService,
  ) {}

  async isConfigured(target: SaasTenantExternalDataTarget): Promise<boolean> {
    if (!this.supportsTarget(target) || !this.writerFenceProvider || !this.writerInventory) return false;
    const expectedReference = this.config.get<string>(CONFIG_REFERENCE)?.trim();
    if (!expectedReference || target.configReference.trim() !== expectedReference) return false;
    try {
      const storage = readConfiguration(this.config);
      await this.assertVersioningEnabled(storage);
      await this.assertObjectLockEnabled(storage);
      // These deployment-controlled evidence references and the reviewed inventory
      // are necessary preflight data, not independent proof of actual provider behavior.
      this.writerFenceProvider.getProviderAcceptanceReferences();
      for (const category of target.categories) {
        await this.writerInventory.requireCurrentAcceptedSnapshot(target.tenantId, category);
      }
      // Deliberately stay inactive until durable, independently reviewed provider
      // acceptance (including real staging evidence, IAM/access-point completeness,
      // policy ownership and restore replay) is represented and checked in the DB.
      // A set of environment flags/reference strings is not sufficient to enable erasure.
      return false;
    } catch {
      return false;
    }
  }

  async prepare(input: SaasExternalPropagationContext): Promise<SaasExternalPropagationPlan> {
    this.assertContext(input);
    const storage = readConfiguration(this.config);
    await this.assertVersioningEnabled(storage);
    await this.assertObjectLockEnabled(storage);
    const versions = await this.listAllVersions(storage, input.tenantId, input.categories);
    if (versions.length > MAX_VERSIONS) {
      throw new ConflictException('Tenant backup inventory exceeds the bounded 20,000-version erasure plan');
    }

    const resources: SaasExternalPropagationResourceIdentity[] = [];
    for (let offset = 0; offset < versions.length; offset += 4) {
      const batch = versions.slice(offset, offset + 4);
      const identities = await Promise.all(batch.map(async (version) => {
        assertSafeBackupKey(input.tenantId, input.categories, version.key);
        if (!isSafeVersionReference(version.versionId)) {
          throw new ConflictException('Backup inventory contains an unsupported version identifier');
        }
        if (version.deleteMarker) {
          return {
            resourceKind: RESOURCE_DELETE_MARKER,
            resourceReference: version.key,
            resourceVersionReference: version.versionId,
            resourceContentDigest: null,
          };
        }
        await this.assertVersionDeletable(storage, version);
        const contentDigest = await this.digestVersion(storage, version);
        return {
          resourceKind: RESOURCE_VERSION,
          resourceReference: version.key,
          resourceVersionReference: version.versionId,
          resourceContentDigest: contentDigest,
        };
      }));
      resources.push(...identities);
    }

    const manifestDigest = digestSaasExternalPropagationResources(resources);
    return {
      manifestDigest,
      plannedCopies: String(resources.length),
      planReference: 's3-backup-version-plan.' + manifestDigest.slice(0, 40),
      adapterVersion: this.adapterVersion,
      resourceClass: 'S3_TENANT_BACKUP_VERSION',
      maxPageSize: PAGE_SIZE,
      maxBatchSize: DB_BATCH_SIZE,
      policyVersions: {
        inventory: 's3-list-object-versions-tenant-prefix-v1',
        objectLock: 's3-object-lock-legal-hold-retention-check-v1',
        contentDigest: 'sha256-streamed-version-read-v1',
        deletion: 'version-id-specific-delete-and-full-residual-scan-v1',
      },
      resources,
    };
  }

  async erase(input: SaasExternalPropagationContext & { plan: SaasExternalPropagationPlan }): Promise<SaasExternalPropagationDeleteReceipt> {
    this.assertContext(input);
    this.assertPlan(input.tenantId, input.categories, input.plan);
    const storage = readConfiguration(this.config);
    await this.assertVersioningEnabled(storage);
    await this.assertObjectLockEnabled(storage);
    const current = await this.listAllVersions(storage, input.tenantId, input.categories);
    const plannedIdentityKeys = new Set(input.plan.resources.map((resource) => this.identityKey({
      key: resource.resourceReference,
      versionId: resource.resourceVersionReference!,
      deleteMarker: resource.resourceKind === RESOURCE_DELETE_MARKER,
    })));
    this.assertNoUnplannedVersions(current, plannedIdentityKeys);
    const currentIdentities = new Set(current.map((value) => this.identityKey(value)));

    // Preflight the complete sealed set before the first delete. If any object
    // changed or any lock appeared after prepare(), no earlier resource in the
    // same plan may already have been destructively removed.
    for (const resource of input.plan.resources) {
      const version: VersionIdentity = {
        key: resource.resourceReference,
        versionId: resource.resourceVersionReference!,
        deleteMarker: resource.resourceKind === RESOURCE_DELETE_MARKER,
      };
      if (!currentIdentities.has(this.identityKey(version)) || version.deleteMarker) continue;
      await this.assertVersionDeletable(storage, version);
      if (await this.digestVersion(storage, version) !== resource.resourceContentDigest) {
        throw new ConflictException('Backup object bytes changed after the sealed version inventory; deletion was blocked before mutation');
      }
    }
    // Detect versions added while the expensive digest/retention preflight ran.
    // A provider writer fence is still required for the remaining post-scan race.
    this.assertNoUnplannedVersions(
      await this.listAllVersions(storage, input.tenantId, input.categories),
      plannedIdentityKeys,
    );

    let accounted = 0;
    for (const resource of input.plan.resources) {
      const versionId = resource.resourceVersionReference!;
      const version: VersionIdentity = {
        key: resource.resourceReference,
        versionId,
        deleteMarker: resource.resourceKind === RESOURCE_DELETE_MARKER,
      };
      if (!currentIdentities.has(this.identityKey(version))) {
        accounted += 1;
        continue;
      }
      if (!version.deleteMarker) {
        await this.assertVersionDeletable(storage, version);
        const currentDigest = await this.digestVersion(storage, version);
        if (currentDigest !== resource.resourceContentDigest) {
          throw new ConflictException('Backup object bytes changed after the sealed version inventory; deletion was blocked');
        }
      }
      const response = await this.request(storage, 'DELETE', version.key, [['versionId', version.versionId]]);
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
        throw new ServiceUnavailableException('Backup provider did not confirm deletion of the exact object version');
      }
      accounted += 1;
    }

    return {
      deletedCopies: String(accounted),
      manifestDigest: input.plan.manifestDigest,
      // S3 does not issue one signed, per-resource receipt for this batched flow.
      providerReceiptReference: 's3-backup-version-delete.' + input.plan.manifestDigest.slice(0, 40),
    };
  }

  async verify(input: SaasExternalPropagationContext & {
    plan: SaasExternalPropagationPlan;
    deletion: SaasExternalPropagationDeleteReceipt;
  }): Promise<SaasExternalPropagationVerification> {
    this.assertContext(input);
    this.assertPlan(input.tenantId, input.categories, input.plan);
    if (input.deletion.manifestDigest !== input.plan.manifestDigest
      || input.deletion.deletedCopies !== input.plan.plannedCopies) {
      throw new ConflictException('Backup deletion result does not match the sealed version inventory');
    }
    const storage = readConfiguration(this.config);
    await this.assertVersioningEnabled(storage);
    await this.assertObjectLockEnabled(storage);
    const residuals = await this.listAllVersions(storage, input.tenantId, input.categories);
    return {
      verifiedManifestDigest: input.plan.manifestDigest,
      residualCopies: String(residuals.length),
      residualReferences: residuals.slice(0, 50).map((version) => version.key + ':version:' + version.versionId),
      verificationReference: 's3-backup-version-verify.' + input.plan.manifestDigest.slice(0, 40),
    };
  }

  async recover(input: SaasExternalPropagationContext & { plan?: SaasExternalPropagationPlan }): Promise<void> {
    this.assertContext(input);
    if (!input.plan) return;
    this.assertPlan(input.tenantId, input.categories, input.plan);
    const storage = readConfiguration(this.config);
    await this.assertVersioningEnabled(storage);
    await this.assertObjectLockEnabled(storage);
    const current = await this.listAllVersions(storage, input.tenantId, input.categories);
    const byIdentity = new Map(current.map((version) => [this.identityKey(version), version]));
    for (const resource of input.plan.resources) {
      const version: VersionIdentity = {
        key: resource.resourceReference,
        versionId: resource.resourceVersionReference!,
        deleteMarker: resource.resourceKind === RESOURCE_DELETE_MARKER,
      };
      if (!byIdentity.has(this.identityKey(version)) || version.deleteMarker) continue;
      await this.assertVersionDeletable(storage, version);
      if (await this.digestVersion(storage, version) !== resource.resourceContentDigest) {
        throw new ConflictException('Backup object version changed after the sealed plan; recovery is blocked');
      }
    }
  }

  private supportsTarget(target: SaasTenantExternalDataTarget): boolean {
    return target.storeKind === STORE_KIND && target.adapterKey === ADAPTER_KEY && target.required
      && Array.isArray(target.categories) && target.categories.length > 0
      && target.categories.every((category) => CATEGORY_VALUES.has(category));
  }

  private assertContext(input: SaasExternalPropagationContext & { plan?: SaasExternalPropagationPlan }): void {
    if (!this.supportsTarget(input.target) || input.target.tenantId.toLowerCase() !== input.tenantId.toLowerCase()
      || !input.categories.length || input.categories.some((category) => !CATEGORY_VALUES.has(category))
      || JSON.stringify([...input.categories].sort()) !== JSON.stringify([...input.target.categories].sort())
      || !input.target.required || this.config.get<string>(CONFIG_REFERENCE)?.trim() !== input.target.configReference.trim()) {
      throw new ConflictException('S3 backup erasure supports only its reviewed required tenant/category target');
    }
  }

  private assertPlan(tenantId: string, categories: string[], plan: SaasExternalPropagationPlan): void {
    if (plan.adapterVersion !== this.adapterVersion || plan.resourceClass !== 'S3_TENANT_BACKUP_VERSION'
      || !HEX_DIGEST.test(plan.manifestDigest) || Number(plan.plannedCopies) !== plan.resources.length
      || plan.resources.length > MAX_VERSIONS || digestSaasExternalPropagationResources(plan.resources) !== plan.manifestDigest) {
      throw new ConflictException('Backup erasure plan does not match the exact canonical version inventory');
    }
    const seen = new Set<string>();
    for (const resource of plan.resources) {
      assertSafeBackupKey(tenantId, categories, resource.resourceReference);
      if (!isSafeVersionReference(resource.resourceVersionReference ?? '')
        || ![RESOURCE_VERSION, RESOURCE_DELETE_MARKER].includes(resource.resourceKind)) {
        throw new ConflictException('Backup erasure plan contains an unsupported version identity');
      }
      if ((resource.resourceKind === RESOURCE_VERSION && (!resource.resourceContentDigest || !HEX_DIGEST.test(resource.resourceContentDigest)))
        || (resource.resourceKind === RESOURCE_DELETE_MARKER && resource.resourceContentDigest !== null
          && resource.resourceContentDigest !== undefined)) {
        throw new ConflictException('Backup erasure plan has an invalid content-digest contract');
      }
      const identity = resource.resourceKind + ':' + resource.resourceReference + ':' + resource.resourceVersionReference;
      if (seen.has(identity)) throw new ConflictException('Backup erasure plan contains a duplicate object version');
      seen.add(identity);
    }
  }

  private async assertVersioningEnabled(storage: BackupS3Config): Promise<void> {
    const response = await this.request(storage, 'GET', null, [['versioning', '']]);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableException('Backup bucket versioning state could not be verified');
    }
    const xml = await boundedText(response, 16384);
    if (!/<Status>\s*Enabled\s*<\/Status>/i.test(xml) || /<Status>\s*Suspended\s*<\/Status>/i.test(xml)) {
      throw new ServiceUnavailableException('Backup bucket must have object versioning enabled');
    }
  }

  private async assertObjectLockEnabled(storage: BackupS3Config): Promise<void> {
    const response = await this.request(storage, 'GET', null, [['object-lock', '']]);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableException('Backup object-lock configuration could not be verified');
    }
    const xml = await boundedText(response, 16384);
    if (!/<ObjectLockEnabled>\s*Enabled\s*<\/ObjectLockEnabled>/i.test(xml)) {
      throw new ServiceUnavailableException('Backup bucket must have Object Lock enabled for legal-hold and retention verification');
    }
  }

  private async listAllVersions(storage: BackupS3Config, tenantId: string, categories: string[]): Promise<VersionIdentity[]> {
    const all: VersionIdentity[] = [];
    const seen = new Set<string>();
    for (const category of [...categories].sort()) {
      const prefix = tenantCategoryPrefix(tenantId, category);
      let keyMarker: string | null = null;
      let versionMarker: string | null = null;
      const markers = new Set<string>();
      let page = 0;
      let truncated = true;
      while (truncated) {
        page += 1;
        if (page > MAX_PAGES) throw new ServiceUnavailableException('Backup version inventory exceeded the pagination bound');
        const parameters: Array<[string, string]> = [['versions', ''], ['max-keys', String(PAGE_SIZE)], ['prefix', prefix]];
        if (keyMarker !== null) parameters.push(['key-marker', keyMarker]);
        if (versionMarker !== null) parameters.push(['version-id-marker', versionMarker]);
        const response = await this.request(storage, 'GET', null, parameters);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ServiceUnavailableException('Backup provider rejected complete object-version enumeration');
        }
        const xml = await boundedText(response, RESPONSE_LIMIT);
        const entries: VersionIdentity[] = [];
        for (const match of xml.matchAll(/<(Version|DeleteMarker)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
          const key = xmlText(match[2]!, 'Key');
          const versionId = xmlText(match[2]!, 'VersionId');
          if (!key || versionId === null || versionId.length === 0) {
            throw new ServiceUnavailableException('Backup version inventory has an incomplete identity');
          }
          const identity: VersionIdentity = { key, versionId, deleteMarker: match[1]!.toLowerCase() === 'deletemarker' };
          assertSafeBackupKey(tenantId, categories, identity.key);
          if (!identity.key.startsWith(prefix) || !isSafeVersionReference(identity.versionId)) {
            throw new ServiceUnavailableException('Backup provider returned a version outside the approved tenant scope');
          }
          const keyForSet = this.identityKey(identity);
          if (seen.has(keyForSet)) throw new ServiceUnavailableException('Backup version inventory returned a duplicate identity');
          seen.add(keyForSet);
          entries.push(identity);
          all.push(identity);
          if (all.length > MAX_VERSIONS) throw new ConflictException('Tenant backup inventory exceeds the 20,000-version erasure bound');
        }
        const isTruncated = xmlText(xml, 'IsTruncated');
        if (isTruncated !== 'true' && isTruncated !== 'false') {
          throw new ServiceUnavailableException('Backup version inventory has no valid IsTruncated marker');
        }
        truncated = isTruncated === 'true';
        if (truncated) {
          const nextKey = xmlText(xml, 'NextKeyMarker');
          const nextVersion = xmlText(xml, 'NextVersionIdMarker');
          if (!nextKey || (nextKey === keyMarker && (nextVersion ?? null) === versionMarker)) {
            throw new ServiceUnavailableException('Backup version pagination markers are missing or repeated');
          }
          const marker = nextKey + '\u0000' + (nextVersion ?? '');
          if (markers.has(marker)) throw new ServiceUnavailableException('Backup version pagination repeated a marker pair');
          markers.add(marker);
          keyMarker = nextKey;
          versionMarker = nextVersion;
        }
      }
    }
    return all.sort((left, right) => {
      const a = left.key + '\u0000' + left.versionId + '\u0000' + left.deleteMarker;
      const b = right.key + '\u0000' + right.versionId + '\u0000' + right.deleteMarker;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  private async assertVersionDeletable(storage: BackupS3Config, version: VersionIdentity): Promise<void> {
    const legalHold = await this.request(storage, 'GET', version.key, [['legal-hold', ''], ['versionId', version.versionId]]);
    if (!legalHold.ok) {
      await legalHold.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableException('Backup object legal-hold state is unavailable; deletion is blocked');
    }
    const legalXml = await boundedText(legalHold, 16384);
    const hold = xmlText(legalXml, 'Status');
    if (hold !== 'ON' && hold !== 'OFF') throw new ServiceUnavailableException('Backup object legal-hold state is malformed');
    if (hold === 'ON') throw new ConflictException('Backup object version is protected by an active provider legal hold');

    const retention = await this.request(storage, 'GET', version.key, [['retention', ''], ['versionId', version.versionId]]);
    if (!retention.ok) {
      await retention.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableException('Backup object retention state is unavailable; deletion is blocked');
    }
    const retentionXml = await boundedText(retention, 16384);
    const mode = xmlText(retentionXml, 'Mode');
    const until = xmlText(retentionXml, 'RetainUntilDate');
    if ((mode === null) !== (until === null)) {
      throw new ServiceUnavailableException('Backup object retention response is incomplete');
    }
    if (mode !== null) {
      if (!['GOVERNANCE', 'COMPLIANCE'].includes(mode) || !until || !Number.isFinite(Date.parse(until))) {
        throw new ServiceUnavailableException('Backup object retention response is malformed');
      }
      if (Date.parse(until) > Date.now()) {
        throw new ConflictException('Backup object version is retained until its provider-enforced expiry');
      }
    } else if (!/<Retention(?:\s[^>]*)?(?:\/>|>\s*<\/Retention>)/i.test(retentionXml)) {
      throw new ServiceUnavailableException('Backup object retention response is not a recognized empty retention record');
    }
  }

  private async digestVersion(storage: BackupS3Config, version: VersionIdentity): Promise<string> {
    const response = await this.request(storage, 'GET', version.key, [['versionId', version.versionId]]);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConflictException('Backup object version is missing or unreadable; the sealed inventory cannot be verified');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ServiceUnavailableException('Backup provider returned no readable object body');
    const hash = createHash('sha256');
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > storage.maxObjectBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ConflictException('Backup object exceeds the configured streaming digest bound');
        }
        hash.update(next.value);
      }
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('Backup object version could not be streamed to completion');
    } finally {
      reader.releaseLock();
    }
    return hash.digest('hex');
  }

  private async request(
    storage: BackupS3Config,
    method: 'GET' | 'DELETE',
    objectKey: string | null,
    parameters: Array<[string, string]>,
  ): Promise<Response> {
    const basePath = storage.endpoint.pathname === '/' ? '' : storage.endpoint.pathname.replace(/\/+$/, '');
    const encodedKey = objectKey === null ? '' : '/' + objectKey.split('/').map(queryEncode).join('/');
    const canonicalUri = basePath + '/' + queryEncode(storage.bucket) + encodedKey;
    const query = canonicalQuery(parameters);
    const target = new URL(storage.endpoint.origin);
    target.pathname = canonicalUri;
    target.search = query ? '?' + query : '';
    try {
      return await globalThis.fetch(target, {
        method,
        headers: signRequest(storage, method, target, canonicalUri, query),
        redirect: 'error',
        signal: AbortSignal.timeout(storage.timeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException('Backup storage request failed or timed out');
    }
  }

  private assertNoUnplannedVersions(current: VersionIdentity[], planned: Set<string>): void {
    const unexpected = current.find((version) => !planned.has(this.identityKey(version)));
    if (unexpected) {
      throw new ConflictException('Backup inventory changed after the sealed plan; unplanned versions block deletion');
    }
  }

  private identityKey(value: VersionIdentity): string {
    return value.key + '\u0000' + value.versionId + '\u0000' + value.deleteMarker;
  }
}
