import { createHash, createHmac, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import {
  deleteWmsPodObjectAndVerifyGone, listWmsPodTenantObjects,
  uploadWmsPodObjectAndVerify, verifyWmsPodObjectDigest,
} from './wms-pod-storage';

type TestStorageEnv = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function requiredEnv(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error('Required S3 test-storage variable is missing: ' + name);
  return value.trim();
}

function requireStorageEnv(): TestStorageEnv {
  return {
    endpoint: requiredEnv('WMS_POD_STORAGE_ENDPOINT', process.env.WMS_POD_STORAGE_ENDPOINT),
    bucket: requiredEnv('WMS_POD_STORAGE_BUCKET', process.env.WMS_POD_STORAGE_BUCKET),
    region: requiredEnv('WMS_POD_STORAGE_REGION', process.env.WMS_POD_STORAGE_REGION),
    accessKeyId: requiredEnv('WMS_POD_STORAGE_ACCESS_KEY_ID', process.env.WMS_POD_STORAGE_ACCESS_KEY_ID),
    secretAccessKey: requiredEnv('WMS_POD_STORAGE_SECRET_ACCESS_KEY', process.env.WMS_POD_STORAGE_SECRET_ACCESS_KEY),
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * Creates the bucket against the local S3-compatible test server using SigV4.
 * This setup request is deliberately separate from the production adapter;
 * the test then validates the adapter's own signed PUT and GET against storage.
 */
async function createTestBucket(): Promise<void> {
  const storage = requireStorageEnv();
  const target = new URL(storage.endpoint);
  target.pathname = '/' + encodeURIComponent(storage.bucket);
  target.search = '';
  const payloadHash = sha256(Buffer.alloc(0));
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeadersByName: Record<string, string> = {
    host: target.host.toLowerCase(),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaderNames = Object.keys(canonicalHeadersByName).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => name + ':' + canonicalHeadersByName[name]!.trim().replace(/\s+/g, ' ') + '\n')
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    'PUT', target.pathname, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = dateStamp + '/' + storage.region + '/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac('AWS4' + storage.secretAccessKey, dateStamp);
  const regionKey = hmac(dateKey, storage.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + storage.accessKeyId + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  const response = await fetch(target, {
    method: 'PUT',
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error('Could not create isolated POD test bucket (HTTP ' + response.status + '): ' + detail);
  }
  await response.body?.cancel().catch(() => undefined);
}

function testConfig() {
  const storage = requireStorageEnv();
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    WMS_POD_STORAGE_ENDPOINT: storage.endpoint,
    WMS_POD_STORAGE_BUCKET: storage.bucket,
    WMS_POD_STORAGE_REGION: storage.region,
    WMS_POD_STORAGE_ACCESS_KEY_ID: storage.accessKeyId,
    WMS_POD_STORAGE_SECRET_ACCESS_KEY: storage.secretAccessKey,
    WMS_POD_STORAGE_MAX_BYTES: '10485760',
    WMS_POD_STORAGE_TIMEOUT_MS: '5000',
  };
  return { get: <T = string>(name: string) => values[name] as T | undefined } as never;
}

jest.setTimeout(30000);

const storageVariableNames = [
  'WMS_POD_STORAGE_ENDPOINT',
  'WMS_POD_STORAGE_BUCKET',
  'WMS_POD_STORAGE_REGION',
  'WMS_POD_STORAGE_ACCESS_KEY_ID',
  'WMS_POD_STORAGE_SECRET_ACCESS_KEY',
] as const;
const anyStorageVariableProvided = storageVariableNames.some((name) =>
  Boolean(process.env[name]?.trim()),
);
// The dedicated API CI job supplies a complete ephemeral storage configuration.
// The PostgreSQL suite intentionally has no storage service, so it skips this
// suite only when *none* of the required settings are supplied. Partial config
// still runs and fails validation rather than silently hiding a broken setup.
const storageDescribe = anyStorageVariableProvided ? describe : describe.skip;

storageDescribe('WMS POD upload against a real S3-compatible test server', () => {
  beforeAll(async () => {
    await createTestBucket();
  });

  it('persists a POD object through signed PUT and verifies bytes returned by a separate GET', async () => {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
    ]);
    const expectedSha256 = sha256(bytes);
    const objectKey = 'pod/ci/' + randomUUID() + '/evidence.png';

    const uploaded = await uploadWmsPodObjectAndVerify(
      testConfig(), objectKey, bytes, 'image/png',
    );
    expect(uploaded).toEqual({
      sha256: expectedSha256,
      byteLength: bytes.byteLength,
      contentType: 'image/png',
    });

    // Independent GET in addition to the upload helper's mandatory read-back.
    const readBack = await verifyWmsPodObjectDigest(testConfig(), objectKey, expectedSha256);
    expect(readBack).toEqual({ sha256: expectedSha256, byteLength: bytes.byteLength });
  });

  it('rejects a digest that differs from the object actually stored by the test server', async () => {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x10, 0x11, 0x12, 0x13,
    ]);
    const objectKey = 'pod/ci/' + randomUUID() + '/mismatch.png';
    const uploaded = await uploadWmsPodObjectAndVerify(
      testConfig(), objectKey, bytes, 'image/png',
    );
    expect(uploaded.sha256).toBe(sha256(bytes));

    const wrongDigest = sha256(Buffer.from('deliberately different bytes'));
    await expect(verifyWmsPodObjectDigest(
      testConfig(), objectKey, wrongDigest,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});


storageDescribe('WMS POD scoped deletion against a real S3-compatible test server', () => {
  beforeAll(async () => {
    await createTestBucket();
  });

  it('enumerates every POD object for one tenant through signed ListObjectsV2 and sees deletion on a fresh list', async () => {
    const tenantId = 'a6000000-0000-4000-8000-000000000001';
    const otherTenantId = 'a7000000-0000-4000-8000-000000000001';
    const objectKey = 'pod/' + tenantId
      + '/a6000000-0000-4000-8000-000000000002'
      + '/a6000000-0000-4000-8000-000000000003'
      + '/' + randomUUID();
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x31, 0x32, 0x33, 0x34,
    ]);
    const digest = sha256(bytes);
    await uploadWmsPodObjectAndVerify(testConfig(), objectKey, bytes, 'image/png');

    expect(await listWmsPodTenantObjects(testConfig(), tenantId)).toEqual([objectKey]);
    expect(await listWmsPodTenantObjects(testConfig(), otherTenantId)).toEqual([]);

    await deleteWmsPodObjectAndVerifyGone(testConfig(), tenantId, objectKey, digest);
    expect(await listWmsPodTenantObjects(testConfig(), tenantId)).toEqual([]);
  });

  it('verifies object bytes and confirms deletion by independent GET', async () => {
    const tenantId = 'a1000000-0000-4000-8000-000000000001';
    const factoryId = 'a1000000-0000-4000-8000-000000000002';
    const shipmentId = 'a1000000-0000-4000-8000-000000000003';
    const objectId = randomUUID();
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x20, 0x21, 0x22, 0x23, 0x24,
    ]);
    const objectKey = 'pod/' + tenantId + '/' + factoryId + '/' + shipmentId + '/' + objectId;
    const digest = sha256(bytes);
    await uploadWmsPodObjectAndVerify(testConfig(), objectKey, bytes, 'image/png');

    const removed = await deleteWmsPodObjectAndVerifyGone(testConfig(), tenantId, objectKey, digest);
    expect(removed).toEqual({ sha256: digest, byteLength: bytes.byteLength, verifiedAbsent: true });
    await expect(verifyWmsPodObjectDigest(testConfig(), objectKey, digest))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects a different tenant prefix before making any storage request', async () => {
    const expectedTenantId = 'a2000000-0000-4000-8000-000000000001';
    const otherTenantId = 'a3000000-0000-4000-8000-000000000001';
    const objectKey = 'pod/' + otherTenantId
      + '/a2000000-0000-4000-8000-000000000002'
      + '/a2000000-0000-4000-8000-000000000003'
      + '/a2000000-0000-4000-8000-000000000004';
    const fetcher = jest.fn<typeof fetch>();
    await expect(deleteWmsPodObjectAndVerifyGone(
      testConfig(), expectedTenantId, objectKey, 'a'.repeat(64), fetcher,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
