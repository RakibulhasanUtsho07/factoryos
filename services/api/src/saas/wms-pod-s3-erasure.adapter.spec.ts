import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { WmsPodS3ErasureAdapter } from './wms-pod-s3-erasure.adapter';
import type { SaasExternalPropagationContext } from './saas-tenant-propagation.adapters';

const tenant = 'b1000000-0000-4000-8000-000000000001';
const otherTenant = 'b2000000-0000-4000-8000-000000000001';
const factory = 'b1000000-0000-4000-8000-000000000002';
const shipment = 'b1000000-0000-4000-8000-000000000003';
const objectId = 'b1000000-0000-4000-8000-000000000004';
const otherFactory = 'b2000000-0000-4000-8000-000000000002';
const otherShipment = 'b2000000-0000-4000-8000-000000000003';
const otherObject = 'b2000000-0000-4000-8000-000000000004';
const configReference = 'wms-pod-storage-erasure.v1';
const target = {
  tenantId: tenant,
  targetId: 'wms-pod-evidence',
  storeKind: 'OBJECT_STORAGE' as const,
  adapterKey: 'wms.pod.s3.v1',
  configReference,
  categories: ['EVIDENCE'] as never[],
  required: true,
};
const objectKey = 'pod/' + tenant + '/' + factory + '/' + shipment + '/' + objectId;
const otherObjectKey = 'pod/' + otherTenant + '/' + otherFactory + '/' + otherShipment + '/' + otherObject;
const bytes = Buffer.from('verified POD evidence bytes', 'utf8');
const digest = (input: Buffer) => createHash('sha256').update(input).digest('hex');

function createConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    WMS_POD_STORAGE_CONFIG_REFERENCE: configReference,
    WMS_POD_STORAGE_ENDPOINT: 'https://storage.example.test',
    WMS_POD_STORAGE_BUCKET: 'factoryos-pod',
    WMS_POD_STORAGE_REGION: 'us-east-1',
    WMS_POD_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    WMS_POD_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    WMS_POD_STORAGE_MAX_BYTES: '10485760',
    WMS_POD_STORAGE_TIMEOUT_MS: '5000',
    ...overrides,
  };
  return { get: (name: string) => values[name] } as unknown as ConfigService;
}

function listResponse(keys: string[]): Response {
  const contents = keys.map((key) => '<Contents><Key>' + key + '</Key></Contents>').join('');
  return new Response(
    '<ListBucketResult><IsTruncated>false</IsTruncated>' + contents + '</ListBucketResult>',
    { status: 200, headers: { 'content-type': 'application/xml' } },
  );
}

function s3Key(url: URL): string {
  return decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
}

describe('WmsPodS3ErasureAdapter', () => {
  let objects: Map<string, Buffer>;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let adapter: WmsPodS3ErasureAdapter;

  beforeEach(() => {
    objects = new Map([[objectKey, Buffer.from(bytes)], [otherObjectKey, Buffer.from('other tenant bytes')]]);
    adapter = new WmsPodS3ErasureAdapter(createConfig());
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const init = args[1] ?? {};
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      const method = init.method ?? 'GET';
      if (url.search === '?versioning=') {
        return new Response('<VersioningConfiguration/>', { status: 200 });
      }
      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        return listResponse([...objects.keys()].filter((key) => key.startsWith(prefix)).sort());
      }
      const key = s3Key(url);
      if (method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const value = objects.get(key);
      if (!value) return new Response(null, { status: 404 });
      return new Response(Buffer.from(value), {
        status: 200,
        headers: { 'content-length': String(value.byteLength) },
      });
    });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const context = (): SaasExternalPropagationContext => ({
    tenantId: tenant,
    requestId: 'b3000000-0000-4000-8000-000000000001',
    requestVersion: 1,
    runId: 'b4000000-0000-4000-8000-000000000001',
    categories: ['EVIDENCE'] as never[],
    sourceExportDigest: 'c'.repeat(64),
    sourceManifest: { categories: ['EVIDENCE'] },
    idempotencyKey: 'pod-erasure-test',
    target,
  });

  it('enumerates and content-digests only the selected tenant prefix, then deletes and verifies it empty', async () => {
    expect(await adapter.isConfigured(target)).toBe(true);
    const plan = await adapter.prepare(context());
    expect(plan).toMatchObject({
      plannedCopies: '1',
      adapterVersion: '1.0.0',
      resourceClass: 'WMS_POD_OBJECT',
      maxPageSize: 1000,
      maxBatchSize: 500,
      resources: [{
        resourceKind: 'WMS_POD_OBJECT',
        resourceReference: objectKey,
        resourceVersionReference: null,
        resourceContentDigest: digest(bytes),
      }],
    });

    await adapter.recover({ ...context(), plan });
    const deletion = await adapter.erase({ ...context(), plan });
    expect(deletion).toEqual({
      deletedCopies: '1',
      manifestDigest: plan.manifestDigest,
      providerReceiptReference: 'wms-pod-s3-delete.' + plan.manifestDigest.slice(0, 40),
    });
    expect(objects.has(objectKey)).toBe(false);
    expect(objects.has(otherObjectKey)).toBe(true);

    const verification = await adapter.verify({ ...context(), plan, deletion });
    expect(verification).toMatchObject({
      verifiedManifestDigest: plan.manifestDigest,
      residualCopies: '0',
      residualReferences: [],
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('list-type=2'))).toBe(true);
  });

  it('does not delete bytes that changed after the exact inventory was prepared', async () => {
    const plan = await adapter.prepare(context());
    objects.set(objectKey, Buffer.from('changed bytes after prepare'));

    await expect(adapter.erase({ ...context(), plan })).rejects.toBeInstanceOf(ConflictException);
    expect(objects.has(objectKey)).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('reports residual POD objects added after deletion rather than claiming verified absence', async () => {
    const plan = await adapter.prepare(context());
    const deletion = {
      deletedCopies: plan.plannedCopies,
      manifestDigest: plan.manifestDigest,
      providerReceiptReference: 'test.delete.receipt',
    };
    objects.delete(objectKey);
    const newObjectKey = 'pod/' + tenant + '/' + factory + '/' + shipment
      + '/b1000000-0000-4000-8000-000000000005';
    objects.set(newObjectKey, Buffer.from('late object'));

    const verification = await adapter.verify({ ...context(), plan, deletion });
    expect(verification).toMatchObject({
      verifiedManifestDigest: plan.manifestDigest,
      residualCopies: '1',
      residualReferences: [newObjectKey],
    });
  });

  it('refuses config references and dataset categories outside the reviewed POD evidence boundary', async () => {
    expect(await adapter.isConfigured({ ...target, configReference: 'other-secret-ref' })).toBe(false);
    expect(await adapter.isConfigured({ ...target, categories: ['BUSINESS_DATA'] as never[] })).toBe(false);
    await expect(adapter.prepare({
      ...context(),
      target: { ...target, categories: ['BUSINESS_DATA'] as never[] },
    })).rejects.toBeInstanceOf(ConflictException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
