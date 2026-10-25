import { BadRequestException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { verifyWmsPodObjectDigest } from './wms-pod-storage';

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
});
