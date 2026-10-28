import { BadRequestException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  deleteWmsPodObjectAndVerifyGone, listWmsPodTenantObjects,
  uploadWmsPodObjectAndVerify, verifyWmsPodObjectDigest,
} from './wms-pod-storage';

type ConfigValues = Record<string, string | undefined>;

function testConfig(overrides: ConfigValues = {}) {
  const values: ConfigValues = {
    NODE_ENV: 'test',
    WMS_POD_STORAGE_ENDPOINT: 'https://storage.example.test',
    WMS_POD_STORAGE_BUCKET: 'factoryos-pod',
    WMS_POD_STORAGE_REGION: 'us-east-1',
    WMS_POD_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    WMS_POD_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    WMS_POD_STORAGE_MAX_BYTES: '10485760',
    WMS_POD_STORAGE_TIMEOUT_MS: '5000',
    ...overrides,
  };
  return { get: (name: string) => values[name] } as never;
}

describe('WMS tenant-scoped POD inventory', () => {
  it('follows signed ListObjectsV2 continuation tokens until the complete inventory is read', async () => {
    const tenantId = 'a8000000-0000-4000-8000-000000000001';
    const keyOne = 'pod/' + tenantId
      + '/a8000000-0000-4000-8000-000000000002'
      + '/a8000000-0000-4000-8000-000000000003'
      + '/a8000000-0000-4000-8000-000000000004';
    const keyTwo = 'pod/' + tenantId
      + '/a8000000-0000-4000-8000-000000000002'
      + '/a8000000-0000-4000-8000-000000000003'
      + '/a8000000-0000-4000-8000-000000000005';
    const fetcher = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<VersioningConfiguration/>', { status: 200 }))
      .mockResolvedValueOnce(new Response(
        '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>opaque+/=</NextContinuationToken>'
          + '<Contents><Key>' + keyOne + '</Key></Contents></ListBucketResult>',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated>'
          + '<Contents><Key>' + keyTwo + '</Key></Contents></ListBucketResult>',
        { status: 200 },
      ));

    expect(await listWmsPodTenantObjects(testConfig(), tenantId, fetcher)).toEqual([keyOne, keyTwo]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [secondPageUrl, secondPageInit] = fetcher.mock.calls[2] as unknown as [URL, RequestInit];
    expect(secondPageUrl.search).toContain('continuation-token=opaque%2B%2F%3D');
    expect(secondPageInit.method).toBe('GET');
    expect(secondPageInit.redirect).toBe('error');
    expect((secondPageInit.headers as Record<string, string>).Authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
  });

  it('fails closed rather than accepting a malformed tenant inventory page', async () => {
    const tenantId = 'a9000000-0000-4000-8000-000000000001';
    const fetcher = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<VersioningConfiguration/>', { status: 200 }))
      .mockResolvedValueOnce(new Response(
        '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
        { status: 200 },
      ));
    await expect(listWmsPodTenantObjects(testConfig(), tenantId, fetcher))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('WMS proof-of-delivery object verification', () => {
  it('signs a bounded S3-compatible GET and verifies the actual bytes', async () => {
    const bytes = Buffer.from('verified POD content', 'utf8');
    const expected = createHash('sha256').update(bytes).digest('hex');
    const fetcher = jest.fn(async () => new Response(bytes, { status: 200 }));
    const result = await verifyWmsPodObjectDigest(
      testConfig(),
      'pod/shipment-100/photo.png',
      expected,
      fetcher as never,
    );
    expect(result).toEqual({ sha256: expected, byteLength: bytes.byteLength });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://storage.example.test/factoryos-pod/pod/shipment-100/photo.png');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/us-east-1\/s3\/aws4_request,/,
    );
    expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a digest that does not match the fetched proof bytes', async () => {
    const fetcher = jest.fn(async () => new Response(Buffer.from('actual object bytes'), { status: 200 }));
    const expected = createHash('sha256').update('different bytes').digest('hex');
    await expect(verifyWmsPodObjectDigest(
      testConfig(),
      'pod/shipment-100/proof.png',
      expected,
      fetcher as never,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('fails closed when storage configuration is incomplete', async () => {
    const fetcher = jest.fn(async () => new Response(Buffer.from('not used'), { status: 200 }));
    await expect(verifyWmsPodObjectDigest(
      testConfig({ WMS_POD_STORAGE_SECRET_ACCESS_KEY: undefined }),
      'pod/shipment-100/proof.png',
      createHash('sha256').update('not used').digest('hex'),
      fetcher as never,
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects traversal-like object keys before issuing a request', async () => {
    const fetcher = jest.fn(async () => new Response(Buffer.from('not used'), { status: 200 }));
    await expect(verifyWmsPodObjectDigest(
      testConfig(),
      'pod/../other-tenant/secret.png',
      'a'.repeat(64),
      fetcher as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects objects above the configured byte limit', async () => {
    const fetcher = jest.fn(async () => new Response(Buffer.from('too large'), {
      status: 200,
      headers: { 'content-length': '9' },
    }));
    await expect(verifyWmsPodObjectDigest(
      testConfig({ WMS_POD_STORAGE_MAX_BYTES: '4' }),
      'pod/shipment-100/proof.png',
      createHash('sha256').update('too large').digest('hex'),
      fetcher as never,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('requires HTTPS when production mode is enabled', async () => {
    const fetcher = jest.fn(async () => new Response(Buffer.from('not used'), { status: 200 }));
    await expect(verifyWmsPodObjectDigest(
      testConfig({ NODE_ENV: 'production', WMS_POD_STORAGE_ENDPOINT: 'http://storage.example.test' }),
      'pod/shipment-100/proof.png',
      createHash('sha256').update('not used').digest('hex'),
      fetcher as never,
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uploads a supported POD file with SigV4 then GETs and verifies the persisted bytes', async () => {
    const bytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x01,0x02]);
    const expected = createHash('sha256').update(bytes).digest('hex');
    const fetcher = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }));
    const result = await uploadWmsPodObjectAndVerify(
      testConfig(), 'pod/tenant/factory/shipment/object-1', bytes, 'image/png', fetcher as never,
    );
    expect(result).toEqual({ sha256: expected, byteLength: bytes.byteLength, contentType: 'image/png' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(putUrl)).toBe('https://storage.example.test/factoryos-pod/pod/tenant/factory/shipment/object-1');
    expect(putInit.method).toBe('PUT');
    expect(putInit.redirect).toBe('error');
    expect(Buffer.from(putInit.body as Uint8Array)).toEqual(bytes);
    const putHeaders = putInit.headers as Record<string, string>;
    expect(putHeaders['content-type']).toBe('image/png');
    expect(putHeaders['x-amz-content-sha256']).toBe(expected);
    expect(putHeaders.Authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date');
    const [, getInit] = fetcher.mock.calls[1] as unknown as [URL, RequestInit];
    expect(getInit.method).toBe('GET');
    expect(getInit.redirect).toBe('error');
  });

  it('fails closed when read-back bytes differ after upload', async () => {
    const uploaded = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x01,0x02]);
    const stored = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x01,0x03]);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(stored, { status: 200, headers: { 'content-length': String(stored.byteLength) } }));
    await expect(uploadWmsPodObjectAndVerify(
      testConfig(), 'pod/tenant/factory/shipment/object-2', uploaded, 'image/png', fetcher as never,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects mismatched content signatures and configured byte limits before network access', async () => {
    const fetcher = jest.fn(async () => new Response(null, { status: 200 }));
    await expect(uploadWmsPodObjectAndVerify(
      testConfig(), 'pod/tenant/factory/shipment/object-3', Buffer.from('not a PNG'), 'image/png', fetcher as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(fetcher).not.toHaveBeenCalled();
    const bytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
    await expect(uploadWmsPodObjectAndVerify(
      testConfig({ WMS_POD_STORAGE_MAX_BYTES: '8' }),
      'pod/tenant/factory/shipment/object-4', bytes, 'image/png', fetcher as never,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(fetcher).not.toHaveBeenCalled();
  });


  it.each(['Enabled', 'Suspended'])(
    'blocks object deletion when bucket versioning is %s',
    async (versioningStatus) => {
      const tenantId = 'a4000000-0000-4000-8000-000000000001';
      const objectKey = 'pod/' + tenantId
        + '/a4000000-0000-4000-8000-000000000002'
        + '/a4000000-0000-4000-8000-000000000003'
        + '/a4000000-0000-4000-8000-000000000004';
      const fetcher = jest.fn(async () => new Response(
        '<VersioningConfiguration><Status>' + versioningStatus + '</Status></VersioningConfiguration>',
        { status: 200, headers: { 'content-type': 'application/xml' } },
      ));

      await expect(deleteWmsPodObjectAndVerifyGone(
        testConfig(), tenantId, objectKey, 'a'.repeat(64), fetcher as never,
      )).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toContain('?versioning=');
      expect(init.method).toBe('GET');
    },
  );

  it('blocks deletion when bucket versioning cannot be independently read', async () => {
    const tenantId = 'a5000000-0000-4000-8000-000000000001';
    const objectKey = 'pod/' + tenantId
      + '/a5000000-0000-4000-8000-000000000002'
      + '/a5000000-0000-4000-8000-000000000003'
      + '/a5000000-0000-4000-8000-000000000004';
    const fetcher = jest.fn(async () => new Response(null, { status: 403 }));

    await expect(deleteWmsPodObjectAndVerifyGone(
      testConfig(), tenantId, objectKey, 'a'.repeat(64), fetcher as never,
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

});
