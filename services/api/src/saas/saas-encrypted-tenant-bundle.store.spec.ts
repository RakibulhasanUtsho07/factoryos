import { jest } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SaasEncryptedTenantBundleStore } from './saas-encrypted-tenant-bundle.store';

describe('SaasEncryptedTenantBundleStore', () => {
  let directory: string;
  const key = Buffer.alloc(32, 17).toString('base64');
  let service: SaasEncryptedTenantBundleStore;
  let config: { get: ReturnType<typeof jest.fn> };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'factoryos-tenant-bundle-'));
    config = {
      get: jest.fn((name: string) => {
        if (name === 'SAAS_TRANSFER_BUNDLE_DIR') return directory;
        if (name === 'SAAS_TRANSFER_ENCRYPTION_KEY_BASE64') return key;
        return undefined;
      }),
    };
    service = new SaasEncryptedTenantBundleStore(config as never);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('compresses, encrypts, hashes and streams back the exact plaintext', async () => {
    const plaintext = Buffer.from(JSON.stringify({
      format: 'FACTORYOS_TENANT_EXPORT',
      datasets: { AUDIT_LOG: [{ action: 'CREATED', sequence: 1 }] },
    }));
    async function* chunks() {
      yield plaintext.subarray(0, 17);
      yield plaintext.subarray(17);
    }

    const stored = await service.put(chunks());
    expect(stored.reference).toMatch(/^bundle-.*\.fosx$/);
    expect(stored.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.bytes).toBeGreaterThan(plaintext.length);

    const encrypted = await readFile(join(directory, stored.reference));
    expect(encrypted.includes(plaintext)).toBe(false);
    const decrypted: Buffer[] = [];
    for await (const chunk of service.read(stored.reference, stored.digest)) decrypted.push(chunk);
    expect(Buffer.concat(decrypted)).toEqual(plaintext);
  });

  it('rejects a changed expected digest before returning plaintext', async () => {
    const stored = await service.put((async function* () { yield Buffer.from('sensitive export'); })());
    await expect(async () => {
      for await (const _ of service.read(stored.reference, 'f'.repeat(64))) {
        // Digest failure should occur before the first plaintext chunk.
      }
    }).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects malformed references instead of allowing path traversal', async () => {
    await expect(async () => {
      for await (const _ of service.read('../secrets', 'a'.repeat(64))) {
        // The iterator must reject before file access.
      }
    }).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed if secure storage or encryption-key configuration is missing', async () => {
    const unconfigured = new SaasEncryptedTenantBundleStore({ get: () => undefined } as never);
    await expect(unconfigured.put((async function* () { yield Buffer.from('{}'); })()))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not accept a base64 key whose decoded length is not 32 bytes', async () => {
    const badKeyService = new SaasEncryptedTenantBundleStore({
      get: (name: string) => name === 'SAAS_TRANSFER_BUNDLE_DIR' ? directory : Buffer.alloc(16).toString('base64'),
    } as never);
    await expect(badKeyService.put((async function* () { yield Buffer.from('{}'); })()))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
