import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface WmsPodStorageConfigReader {
  get<T = string>(propertyPath: string): T | undefined;
}

interface S3PodConfiguration {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
  maxBytes: number;
  timeoutMs: number;
}

export interface VerifiedPodObject {
  sha256: string;
  byteLength: number;
}

export interface UploadedVerifiedPodObject extends VerifiedPodObject {
  contentType: 'image/jpeg' | 'image/png' | 'application/pdf';
}

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function requiredConfig(config: WmsPodStorageConfigReader, name: string): string {
  const value = config.get<string>(name);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ServiceUnavailableException(
      'POD object storage is not configured; delivered carrier events are disabled',
    );
  }
  return value.trim();
}

function boundedInteger(
  config: WmsPodStorageConfigReader,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = config.get<string>(name);
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ServiceUnavailableException('POD object storage configuration is invalid');
  }
  return value;
}

function readConfiguration(config: WmsPodStorageConfigReader): S3PodConfiguration {
  const endpointInput = requiredConfig(config, 'WMS_POD_STORAGE_ENDPOINT');
  const bucket = requiredConfig(config, 'WMS_POD_STORAGE_BUCKET');
  const region = requiredConfig(config, 'WMS_POD_STORAGE_REGION');
  const accessKeyId = requiredConfig(config, 'WMS_POD_STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = requiredConfig(config, 'WMS_POD_STORAGE_SECRET_ACCESS_KEY');
  const sessionToken = config.get<string>('WMS_POD_STORAGE_SESSION_TOKEN')?.trim() || undefined;
  const nodeEnvironment = config.get<string>('NODE_ENV') ?? 'development';

  let endpoint: URL;
  try {
    endpoint = new URL(endpointInput);
  } catch {
    throw new ServiceUnavailableException('POD object storage endpoint is invalid');
  }
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    (nodeEnvironment === 'production' && endpoint.protocol !== 'https:')
  ) {
    throw new ServiceUnavailableException(
      'POD object storage endpoint must be a credential-free HTTPS URL in production',
    );
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ServiceUnavailableException('POD object storage bucket name is invalid');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(region)) {
    throw new ServiceUnavailableException('POD object storage region is invalid');
  }
  if (/[\r\n]/.test(accessKeyId + secretAccessKey + (sessionToken ?? ''))) {
    throw new ServiceUnavailableException('POD object storage credentials are invalid');
  }

  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    maxBytes: boundedInteger(config, 'WMS_POD_STORAGE_MAX_BYTES', 10 * 1024 * 1024, 1, 25 * 1024 * 1024),
    timeoutMs: boundedInteger(config, 'WMS_POD_STORAGE_TIMEOUT_MS', 5000, 1000, 30000),
  };
}

function assertSafeObjectKey(objectKey: string): void {
  if (
    objectKey.length < 1 ||
    objectKey.length > 500 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(objectKey) ||
    objectKey.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new BadRequestException('proof_reference must be a safe relative storage object key');
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) {
      throw new ServiceUnavailableException('POD storage returned an invalid content length');
    }
    if (Number(contentLength) > maxBytes) {
      throw new UnprocessableEntityException('POD object exceeds the configured byte limit');
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ServiceUnavailableException('POD storage returned no readable object body');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UnprocessableEntityException('POD object exceeds the configured byte limit');
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('POD storage object could not be read completely');
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    throw new UnprocessableEntityException('POD object must not be empty');
  }
  return Buffer.concat(chunks, total);
}

/**
 * Reads one object from the configured S3-compatible bucket using SigV4 and
 * independently verifies SHA-256 over the returned bytes. The request target
 * comes only from trusted server configuration plus a validated relative key;
 * carrier payloads cannot choose an arbitrary URL or cause redirect following.
 */
/**
 * Reads and hashes the current persisted bytes for one safe object key. A 404
 * is exposed as null only by the explicit IfPresent variant, for idempotent
 * erasure recovery after a previously-issued DELETE.
 */
export async function readWmsPodObjectDigestIfPresent(
  config: WmsPodStorageConfigReader,
  objectKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VerifiedPodObject | null> {
  assertSafeObjectKey(objectKey);
  const storage = readConfiguration(config);
  const basePath = storage.endpoint.pathname === '/'
    ? ''
    : storage.endpoint.pathname.replace(/\\/+$/, '');
  const encodedKey = objectKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const canonicalUri = basePath + '/' + encodeURIComponent(storage.bucket) + '/' + encodedKey;
  const target = new URL(storage.endpoint.origin);
  target.pathname = canonicalUri;
  const headers = signedPodS3Headers(storage, 'GET', target, canonicalUri, '');

  let response: Response;
  try {
    response = await fetcher(target, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(storage.timeoutMs),
    });
  } catch {
    throw new ServiceUnavailableException('Unable to retrieve POD object from configured storage');
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ServiceUnavailableException('POD storage rejected object retrieval; check storage access policy');
  }
  const bytes = await readBoundedResponse(response, storage.maxBytes);
  return { sha256: sha256Hex(bytes), byteLength: bytes.byteLength };
}

export async function readWmsPodObjectDigest(
  config: WmsPodStorageConfigReader,
  objectKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VerifiedPodObject> {
  const result = await readWmsPodObjectDigestIfPresent(config, objectKey, fetcher);
  if (!result) throw new UnprocessableEntityException('POD object was not found in configured storage');
  return result;
}

/**
 * Independently hashes persisted bytes and compares them with the digest
 * supplied by the trusted caller. The S3 ETag is never treated as a content hash.
 */
export async function verifyWmsPodObjectDigest(
  config: WmsPodStorageConfigReader,
  objectKey: string,
  expectedSha256: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VerifiedPodObject> {
  assertSafeObjectKey(objectKey);
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    throw new BadRequestException('proof_sha256 must be SHA-256 hex');
  }
  const result = await readWmsPodObjectDigest(config, objectKey, fetcher);
  const expected = Buffer.from(expectedSha256.toLowerCase(), 'hex');
  const actual = Buffer.from(result.sha256, 'hex');
  if (!timingSafeEqual(actual, expected)) {
    throw new UnprocessableEntityException('Stored POD object SHA-256 does not match the signed carrier digest');
  }
  return result;
}

function validatePodContentType(bytes: Buffer, declaredContentType: string): UploadedVerifiedPodObject['contentType'] {
  let detected: UploadedVerifiedPodObject['contentType'] | null = null;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    detected = 'image/jpeg';
  } else if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    detected = 'image/png';
  } else if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    detected = 'application/pdf';
  }

  if (!detected || detected !== declaredContentType.trim().toLowerCase()) {
    throw new BadRequestException('POD uploads must be a valid JPEG, PNG or PDF whose bytes match the declared content type');
  }
  return detected;
}

/**
 * Uploads bounded POD bytes to the configured S3-compatible bucket with SigV4,
 * then performs a separate GET and hashes the bytes returned by storage. The
 * caller must generate a tenant/factory/shipment-scoped object key; this helper
 * never accepts a caller-controlled URL or follows redirects.
 */
export async function uploadWmsPodObjectAndVerify(
  config: WmsPodStorageConfigReader,
  objectKey: string,
  bytes: Buffer,
  declaredContentType: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<UploadedVerifiedPodObject> {
  assertSafeObjectKey(objectKey);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new UnprocessableEntityException('POD upload must contain a non-empty file');
  }
  const contentType = validatePodContentType(bytes, declaredContentType);
  const storage = readConfiguration(config);
  if (bytes.byteLength > storage.maxBytes) {
    throw new UnprocessableEntityException('POD object exceeds the configured byte limit');
  }

  const basePath = storage.endpoint.pathname === '/'
    ? ''
    : storage.endpoint.pathname.replace(/\/+$/, '');
  const encodedKey = objectKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const canonicalUri = basePath + '/' + encodeURIComponent(storage.bucket) + '/' + encodedKey;
  const target = new URL(storage.endpoint.origin);
  target.pathname = canonicalUri;
  const payloadHash = sha256Hex(bytes);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeadersByName: Record<string, string> = {
    host: target.host.toLowerCase(),
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (storage.sessionToken) canonicalHeadersByName['x-amz-security-token'] = storage.sessionToken;
  const signedHeaderNames = Object.keys(canonicalHeadersByName).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => name + ':' + canonicalHeadersByName[name]!.trim().replace(/\s+/g, ' ') + '\n')
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + storage.region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const dateKey = hmac('AWS4' + storage.secretAccessKey, dateStamp);
  const regionKey = hmac(dateKey, storage.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = 'AWS4-HMAC-SHA256 Credential=' +
    storage.accessKeyId + '/' + scope +
    ', SignedHeaders=' + signedHeaders +
    ', Signature=' + signature;
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'accept-encoding': 'identity',
    Authorization: authorization,
  };
  if (storage.sessionToken) headers['x-amz-security-token'] = storage.sessionToken;

  let response: Response;
  try {
    response = await fetcher(target, {
      method: 'PUT',
      headers,
      body: bytes as unknown as BodyInit,
      redirect: 'error',
      signal: AbortSignal.timeout(storage.timeoutMs),
    });
  } catch {
    throw new ServiceUnavailableException('Unable to upload POD object to configured storage');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ServiceUnavailableException('POD storage rejected object upload; check storage write policy');
  }
  await response.body?.cancel().catch(() => undefined);

  // Do not trust the local upload digest or S3 ETag as proof of persisted bytes.
  // Read the exact object back and independently hash the response body.
  const verified = await verifyWmsPodObjectDigest(config, objectKey, payloadHash, fetcher);
  if (verified.byteLength !== bytes.byteLength) {
    throw new UnprocessableEntityException('Stored POD object length differs from the uploaded file');
  }
  return { ...verified, contentType };
}

/**
 * Injectable verification facade used by the shipment-delivery lifecycle.
 * Keeps the S3 adapter and ConfigService behind one explicit dependency so a
 * DELIVERED event cannot be persisted without verifying the stored object.
 */
@Injectable()
export class WmsPodStorageVerifier {
  constructor(private readonly config: ConfigService) {}

  verifyObjectDigest(objectKey: string, expectedSha256: string): Promise<VerifiedPodObject> {
    return verifyWmsPodObjectDigest(this.config, objectKey, expectedSha256);
  }
}


/**
 * Signs a bounded S3 request using the same path-style endpoint and credential
 * contract as the POD read/write helpers. Host is signed but supplied by fetch.
 */
function signedPodS3Headers(
  storage: S3PodConfiguration,
  method: 'GET' | 'DELETE',
  target: URL,
  canonicalUri: string,
  canonicalQuery: string,
): Record<string, string> {
  const payloadHash = sha256Hex(Buffer.alloc(0));
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeadersByName: Record<string, string> = {
    host: target.host.toLowerCase(),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (storage.sessionToken) {
    canonicalHeadersByName['x-amz-security-token'] = storage.sessionToken;
  }
  const signedHeaderNames = Object.keys(canonicalHeadersByName).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => name + ':' + canonicalHeadersByName[name]!.trim().replace(/\s+/g, ' ') + '\n')
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = dateStamp + '/' + storage.region + '/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
  ].join('\n');
  const dateKey = hmac('AWS4' + storage.secretAccessKey, dateStamp);
  const regionKey = hmac(dateKey, storage.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
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

function assertTenantPodObjectKey(tenantId: string, objectKey: string): void {
  const normalizedTenantId = tenantId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalizedTenantId)) {
    throw new BadRequestException('tenantId must be a UUID');
  }
  assertSafeObjectKey(objectKey);
  const tenantPrefix = 'pod/' + normalizedTenantId + '/';
  if (!objectKey.startsWith(tenantPrefix)) {
    throw new BadRequestException('POD object key is outside the requested tenant prefix');
  }
  const parts = objectKey.split('/');
  if (parts.length !== 5 || parts[0] !== 'pod' || parts.slice(1).some((part) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(part))) {
    throw new BadRequestException('POD object key must use the tenant/factory/shipment/object UUID hierarchy');
  }
}

async function assertPodBucketUnversioned(
  storage: S3PodConfiguration,
  fetcher: typeof fetch,
): Promise<void> {
  const basePath = storage.endpoint.pathname === '/'
    ? ''
    : storage.endpoint.pathname.replace(/\/+$/, '');
  const canonicalUri = basePath + '/' + encodeURIComponent(storage.bucket);
  const canonicalQuery = 'versioning=';
  const target = new URL(storage.endpoint.origin);
  target.pathname = canonicalUri;
  target.search = '?' + canonicalQuery;

  let response: Response;
  try {
    response = await fetcher(target, {
      method: 'GET',
      headers: signedPodS3Headers(storage, 'GET', target, canonicalUri, canonicalQuery),
      redirect: 'error',
      signal: AbortSignal.timeout(storage.timeoutMs),
    });
  } catch {
    throw new ServiceUnavailableException('Unable to verify POD bucket versioning state');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ServiceUnavailableException('POD bucket versioning state could not be verified; deletion is blocked');
  }
  let xml: string;
  try {
    // Stream with a hard byte ceiling; do not buffer an untrusted provider response
    // and then check its size after allocating the complete body.
    xml = (await readBoundedResponse(response, 16384)).toString('utf8');
  } catch {
    throw new ServiceUnavailableException('POD bucket versioning response could not be read within its safety limit');
  }
  // S3 returns an empty VersioningConfiguration when bucket versioning is off.
  // Enabled, suspended, unknown or provider-specific configurations are blocked:
  // DELETE without versionId would only create a marker and leave old bytes behind.
  const emptyConfiguration =
    /<VersioningConfiguration\b[^>]*\/>/i.test(xml)
    || /<VersioningConfiguration\b[^>]*>\s*<\/VersioningConfiguration>/i.test(xml);
  if (!emptyConfiguration || /<Status>\s*(Enabled|Suspended)\s*<\/Status>/i.test(xml)) {
    throw new ServiceUnavailableException(
      'POD bucket must have independently verified, disabled object versioning before erasure',
    );
  }
}

const POD_LIST_PAGE_SIZE = 1000;
const POD_ERASURE_MAX_OBJECTS = 100000;
const POD_LIST_RESPONSE_MAX_BYTES = 1024 * 1024;

function awsQueryEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalS3Query(parameters: Array<[string, string]>): string {
  return parameters
    .map(([name, value]) => [awsQueryEncode(name), awsQueryEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName < rightName ? -1 : leftName > rightName ? 1
        : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([name, value]) => name + '=' + value)
    .join('&');
}

function decodeS3XmlText(value: string): string {
  const decoded = value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)));
  if (/&(?:#|[A-Za-z])/.test(decoded)) {
    throw new ServiceUnavailableException('POD storage returned malformed XML entity encoding');
  }
  return decoded;
}

function xmlText(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>','i'));
  return match ? decodeS3XmlText(match[1]!.trim()) : null;
}

/**
 * Lists every key in this tenant's POD namespace using signed ListObjectsV2.
 * Unknown key shapes, repeated continuation tokens, oversized pages and failed
 * pagination are errors, never silently treated as an empty/incomplete inventory.
 */
export async function listWmsPodTenantObjects(
  config: WmsPodStorageConfigReader,
  tenantId: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string[]> {
  const normalizedTenantId = tenantId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalizedTenantId)) {
    throw new BadRequestException('tenantId must be a UUID');
  }
  const storage = readConfiguration(config);
  await assertPodBucketUnversioned(storage, fetcher);

  const basePath = storage.endpoint.pathname === '/'
    ? ''
    : storage.endpoint.pathname.replace(/\\/+$/, '');
  const canonicalUri = basePath + '/' + encodeURIComponent(storage.bucket);
  const prefix = 'pod/' + normalizedTenantId + '/';
  const objects: string[] = [];
  const knownKeys = new Set<string>();
  const seenTokens = new Set<string>();
  let continuationToken: string | null = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > Math.ceil(POD_ERASURE_MAX_OBJECTS / POD_LIST_PAGE_SIZE)) {
      throw new ServiceUnavailableException('POD inventory exceeded the configured page limit; erasure is blocked');
    }
    const parameters: Array<[string, string]> = [
      ['list-type', '2'],
      ['max-keys', String(POD_LIST_PAGE_SIZE)],
      ['prefix', prefix],
    ];
    if (continuationToken !== null) parameters.push(['continuation-token', continuationToken]);
    const canonicalQuery = canonicalS3Query(parameters);
    const target = new URL(storage.endpoint.origin);
    target.pathname = canonicalUri;
    target.search = '?' + canonicalQuery;

    let response: Response;
    try {
      response = await fetcher(target, {
        method: 'GET',
        headers: signedPodS3Headers(storage, 'GET', target, canonicalUri, canonicalQuery),
        redirect: 'error',
        signal: AbortSignal.timeout(storage.timeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException('POD tenant inventory could not be enumerated');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableException('POD storage rejected tenant inventory enumeration');
    }
    let xml: string;
    try {
      xml = (await readBoundedResponse(response, POD_LIST_RESPONSE_MAX_BYTES)).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('POD tenant inventory page exceeded its safety limit or was incomplete');
    }

    const contents = [...xml.matchAll(/<Contents(?:\\s[^>]*)?>([\\s\\S]*?)<\\/Contents>/gi)];
    for (const content of contents) {
      const key = xmlText(content[1]!, 'Key');
      if (!key || !key.startsWith(prefix)) {
        throw new ServiceUnavailableException('POD inventory returned an invalid key outside the tenant prefix');
      }
      try {
        assertTenantPodObjectKey(normalizedTenantId, key);
      } catch {
        throw new ServiceUnavailableException('POD inventory contains an unsupported tenant object key; erasure is blocked');
      }
      if (knownKeys.has(key)) {
        throw new ServiceUnavailableException('POD inventory pagination returned a duplicate object identity');
      }
      knownKeys.add(key);
      objects.push(key);
      if (objects.length > POD_ERASURE_MAX_OBJECTS) {
        throw new ServiceUnavailableException('POD tenant inventory exceeds the 100,000-object erasure limit');
      }
    }

    const isTruncated = xmlText(xml, 'IsTruncated');
    if (isTruncated !== 'true' && isTruncated !== 'false') {
      throw new ServiceUnavailableException('POD inventory page has no valid IsTruncated marker');
    }
    if (isTruncated === 'true') {
      const token = xmlText(xml, 'NextContinuationToken');
      if (!token || seenTokens.has(token) || token === continuationToken) {
        throw new ServiceUnavailableException('POD inventory pagination token is missing or repeated');
      }
      seenTokens.add(token);
      continuationToken = token;
    } else {
      continuationToken = null;
    }
  } while (continuationToken !== null);

  return objects.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/**
 * Deletes one previously identified tenant-scoped POD object from an
 * independently verified unversioned S3-compatible bucket. It verifies the
 * stored bytes before mutation and performs a separate GET after DELETE; this
 * primitive does not enumerate tenant data or by itself constitute an erasure
 * adapter or whole-tenant erasure receipt.
 */
export async function deleteWmsPodObjectAndVerifyGone(
  config: WmsPodStorageConfigReader,
  tenantId: string,
  objectKey: string,
  expectedSha256: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VerifiedPodObject & { verifiedAbsent: true }> {
  assertTenantPodObjectKey(tenantId, objectKey);
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    throw new BadRequestException('expectedSha256 must be SHA-256 hex');
  }

  const storage = readConfiguration(config);
  await assertPodBucketUnversioned(storage, fetcher);
  const before = await verifyWmsPodObjectDigest(config, objectKey, expectedSha256, fetcher);

  const basePath = storage.endpoint.pathname === '/'
    ? ''
    : storage.endpoint.pathname.replace(/\/+$/, '');
  const encodedKey = objectKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const canonicalUri = basePath + '/' + encodeURIComponent(storage.bucket) + '/' + encodedKey;
  const target = new URL(storage.endpoint.origin);
  target.pathname = canonicalUri;

  let deletion: Response;
  try {
    deletion = await fetcher(target, {
      method: 'DELETE',
      headers: signedPodS3Headers(storage, 'DELETE', target, canonicalUri, ''),
      redirect: 'error',
      signal: AbortSignal.timeout(storage.timeoutMs),
    });
  } catch {
    throw new ServiceUnavailableException('POD object deletion outcome is uncertain; provider reconciliation is required');
  }
  if (!deletion.ok) {
    await deletion.body?.cancel().catch(() => undefined);
    throw new ServiceUnavailableException('POD storage did not accept the object deletion request');
  }
  await deletion.body?.cancel().catch(() => undefined);

  let readBack: Response;
  try {
    readBack = await fetcher(target, {
      method: 'GET',
      headers: signedPodS3Headers(storage, 'GET', target, canonicalUri, ''),
      redirect: 'error',
      signal: AbortSignal.timeout(storage.timeoutMs),
    });
  } catch {
    throw new ServiceUnavailableException('POD deletion read-back failed; deletion is not verified');
  }
  if (readBack.status !== 404) {
    await readBack.body?.cancel().catch(() => undefined);
    throw new ServiceUnavailableException(
      readBack.ok
        ? 'POD object is still readable after deletion; deletion is not verified'
        : 'POD deletion read-back returned an indeterminate provider status',
    );
  }
  await readBack.body?.cancel().catch(() => undefined);
  return { ...before, verifiedAbsent: true };
}
