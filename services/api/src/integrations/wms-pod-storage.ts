import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

interface ConfigReader {
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

function requiredConfig(config: ConfigReader, name: string): string {
  const value = config.get<string>(name);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ServiceUnavailableException(
      'POD object storage is not configured; delivered carrier events are disabled',
    );
  }
  return value.trim();
}

function boundedInteger(
  config: ConfigReader,
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

function readConfiguration(config: ConfigReader): S3PodConfiguration {
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
export async function verifyWmsPodObjectDigest(
  config: ConfigReader,
  objectKey: string,
  expectedSha256: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VerifiedPodObject> {
  assertSafeObjectKey(objectKey);
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    throw new BadRequestException('proof_sha256 must be SHA-256 hex');
  }

  const storage = readConfiguration(config);
  const basePath = storage.endpoint.pathname === '/'
    ? ''
    : storage.endpoint.pathname.replace(/\/+$/, '');
  const encodedKey = objectKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const canonicalUri = basePath + '/' + encodeURIComponent(storage.bucket) + '/' + encodedKey;
  const target = new URL(storage.endpoint.origin);
  target.pathname = canonicalUri;

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
    'GET',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = dateStamp + '/' + storage.region + '/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
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
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'accept-encoding': 'identity',
    Authorization: authorization,
  };
  if (storage.sessionToken) {
    headers['x-amz-security-token'] = storage.sessionToken;
  }

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
    throw new UnprocessableEntityException('POD object was not found in configured storage');
  }
  if (!response.ok) {
    throw new ServiceUnavailableException('POD storage rejected object retrieval; check storage access policy');
  }

  const bytes = await readBoundedResponse(response, storage.maxBytes);
  const actualSha256 = sha256Hex(bytes);
  const expected = Buffer.from(expectedSha256.toLowerCase(), 'hex');
  const actual = Buffer.from(actualSha256, 'hex');
  if (!timingSafeEqual(actual, expected)) {
    throw new UnprocessableEntityException('Stored POD object SHA-256 does not match the signed carrier digest');
  }
  return { sha256: actualSha256, byteLength: bytes.byteLength };
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
  config: ConfigReader,
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
