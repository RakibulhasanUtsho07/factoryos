import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';
import type { SaasExternalPropagationContext } from './saas-tenant-propagation.adapters';
import { RedisCacheErasureAdapter } from './redis-cache-erasure.adapter';
import { tenantCachePhysicalKey, tenantCacheFenceKey } from './tenant-cache.contract';

const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'a2000000-0000-4000-8000-000000000002';
const requestId = 'a3000000-0000-4000-8000-000000000003';
const runId = 'a4000000-0000-4000-8000-000000000004';
const logicalKey = 'profile:user@example.test';

describe('RedisCacheErasureAdapter', () => {
  let values: Map<string, Buffer>;
  let keyTypes: Map<string, string>;
  let fences: Map<string, string>;
  let fakeClient: {
    scan: jest.Mock;
    type: jest.Mock;
    eval: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    sendCommand: jest.Mock;
  };
  let redis: {
    getClient: jest.Mock;
    assertStandalonePrimary: jest.Mock;
    getBytes: jest.Mock;
  };
  let adapter: RedisCacheErasureAdapter;
  let scanMode: 'normal' | 'duplicate' | 'malformed' | 'buffer-cursor';

  const target = {
    tenantId: tenantA,
    targetId: 'cache-primary',
    storeKind: 'CACHE' as const,
    adapterKey: 'cache.redis.v1',
    configReference: 'cache-config-v1',
    categories: [Category.BUSINESS_DATA],
    required: true,
  };

  const context = (overrides: Partial<SaasExternalPropagationContext> = {}): SaasExternalPropagationContext => ({
    tenantId: tenantA,
    requestId,
    requestVersion: 2,
    runId,
    categories: [Category.BUSINESS_DATA],
    sourceExportDigest: 'a'.repeat(64),
    sourceManifest: { categories: ['BUSINESS_DATA'] },
    idempotencyKey: 'tenant-cache-erasure-v1',
    target,
    ...overrides,
  });

  const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

  beforeEach(() => {
    values = new Map();
    keyTypes = new Map();
    fences = new Map();
    scanMode = 'normal';

    fakeClient = {
      scan: jest.fn(async (_cursor: unknown, options: { MATCH: string }) => {
        if (scanMode === 'malformed') return { cursor: 'not-a-cursor', keys: [] };
        const prefix = options.MATCH.slice(0, -1);
        const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
        const cursor = scanMode === 'buffer-cursor' ? Buffer.from('0') : '0';
        return { cursor, keys: scanMode === 'duplicate' ? [...keys, ...keys] : keys };
      }),
      type: jest.fn(async (key: string) => keyTypes.get(key) ?? (values.has(key) ? 'string' : 'none')),
      eval: jest.fn(async (script: string, options: { keys: string[]; arguments: Array<string | Buffer> }) => {
        if (script.trim() === 'return 1') return 1;

        if (script.includes('local keyType = redis.call')) {
          const key = options.keys[0];
          const type = keyTypes.get(key) ?? (values.has(key) ? 'string' : 'none');
          if (type === 'none') return 0;
          if (type !== 'string') return -2;
          const current = values.get(key);
          if (!current) return 0;
          const expected = Buffer.isBuffer(options.arguments[0])
            ? options.arguments[0] as Buffer
            : Buffer.from(String(options.arguments[0]), 'utf8');
          if (!current.equals(expected)) return -1;
          values.delete(key);
          keyTypes.delete(key);
          return 1;
        }

        if (script.includes('for i = 1, #KEYS do') && script.includes("redis.call('SET', KEYS[i], ARGV[i])")) {
          for (let i = 0; i < options.keys.length; i += 1) {
            const current = fences.get(options.keys[i]);
            if (current && current !== String(options.arguments[i])) return i + 1;
          }
          for (let i = 0; i < options.keys.length; i += 1) {
            if (!fences.has(options.keys[i])) fences.set(options.keys[i], String(options.arguments[i]));
          }
          return 0;
        }

        throw new Error('unexpected Lua script in test');
      }),
      get: jest.fn(async (key: string) => {
        const value = values.get(key);
        return value ?? fences.get(key) ?? null;
      }),
      set: jest.fn(async (key: string, value: string) => {
        fences.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => Number(values.delete(key) || fences.delete(key))),
      sendCommand: jest.fn(async (args: string[]) => {
        if (args[0] === 'BGREWRITEAOF') return 'Background append only file rewriting started';
        if (args[0] === 'INFO' && args[1] === 'persistence') {
          return 'aof_rewrite_in_progress:0\naof_rewrite_scheduled:0\naof_last_bgrewrite_status:ok\n';
        }
        throw new Error('unexpected Redis command in test: ' + args.join(' '));
      }),
    };

    redis = {
      getClient: jest.fn(async () => fakeClient),
      assertStandalonePrimary: jest.fn(async () => undefined),
      getBytes: jest.fn(async (key: string) => values.get(key) ?? null),
    };
    adapter = new RedisCacheErasureAdapter(
      new ConfigService({ FACTORYOS_CACHE_CONFIG_REFERENCE: 'cache-config-v1' }),
      redis as never,
    );
  });

  it('seals only the exact tenant/category scope and de-duplicates legal SCAN duplicates', async () => {
    const keyA = tenantCachePhysicalKey(tenantA, Category.BUSINESS_DATA, logicalKey);
    const keyB = tenantCachePhysicalKey(tenantB, Category.BUSINESS_DATA, logicalKey);
    values.set(keyA, Buffer.from('tenant-a-secret'));
    values.set(keyB, Buffer.from('tenant-b-secret'));
    scanMode = 'duplicate';

    const plan = await adapter.prepare(context());
    expect(plan).toMatchObject({
      plannedCopies: '1',
      adapterVersion: '1.0.0',
      resourceClass: 'REDIS_CACHE_STRING',
      resources: [{
        resourceKind: 'REDIS_CACHE_STRING',
        resourceReference: keyA,
        resourceVersionReference: null,
        resourceContentDigest: digest('tenant-a-secret'),
      }],
    });
    expect(JSON.stringify(plan)).not.toContain('user@example.test');

    await adapter.recover({ ...context(), plan });
    const deletion = await adapter.erase({ ...context(), plan });
    const verification = await adapter.verify({ ...context(), plan, deletion });
    expect(verification).toMatchObject({
      verifiedManifestDigest: plan.manifestDigest,
      residualCopies: '0',
      residualReferences: [],
    });
    expect(values.has(keyA)).toBe(false);
    expect(values.get(keyB)?.toString('utf8')).toBe('tenant-b-secret');
  });

  it('accepts only decimal ASCII cursor bytes returned by binary-safe RESP mapping', async () => {
    const key = tenantCachePhysicalKey(tenantA, Category.BUSINESS_DATA, logicalKey);
    values.set(key, Buffer.from('payload'));
    scanMode = 'buffer-cursor';
    const plan = await adapter.prepare(context());
    expect(plan.plannedCopies).toBe('1');
    expect(plan.resources[0].resourceReference).toBe(key);
  });

  it('blocks deletion if the value changes after the sealed manifest was prepared', async () => {
    const key = tenantCachePhysicalKey(tenantA, Category.BUSINESS_DATA, logicalKey);
    values.set(key, Buffer.from('before'));
    const plan = await adapter.prepare(context());
    values.set(key, Buffer.from('changed'));

    await expect(adapter.erase({ ...context(), plan })).rejects.toBeInstanceOf(ConflictException);
    expect(values.get(key)?.toString('utf8')).toBe('changed');
  });

  it('uses atomic compare-and-delete to block a value change between digest read and DEL', async () => {
    const key = tenantCachePhysicalKey(tenantA, Category.BUSINESS_DATA, logicalKey);
    values.set(key, Buffer.from('before'));
    const plan = await adapter.prepare(context());
    const realEval = fakeClient.eval;
    fakeClient.eval = jest.fn(async (script: string, options: { keys: string[]; arguments: Array<string | Buffer> }) => {
      if (script.includes('local keyType = redis.call')) values.set(key, Buffer.from('raced-change'));
      return realEval(script, options);
    });

    await expect(adapter.erase({ ...context(), plan })).rejects.toBeInstanceOf(ConflictException);
    expect(values.get(key)?.toString('utf8')).toBe('raced-change');
  });

  it('reports newly appearing in-namespace keys as residuals', async () => {
    const key = tenantCachePhysicalKey(tenantA, Category.BUSINESS_DATA, logicalKey);
    values.set(key, Buffer.from('before'));
    const plan = await adapter.prepare(context());
    const deletion = {
      deletedCopies: plan.plannedCopies,
      manifestDigest: plan.manifestDigest,
      providerReceiptReference: 'test-delete-reference',
    };
    values.delete(key);
    const lateKey = tenantCachePhysicalKey(tenantA, Category.BUSINESS_DATA, 'late-entry');
    values.set(lateKey, Buffer.from('late'));

    const result = await adapter.verify({ ...context(), plan, deletion });
    expect(result).toMatchObject({
      residualCopies: '1',
      residualReferences: [lateKey],
    });
  });

  it('fails closed on a malformed SCAN cursor and unsupported key shapes', async () => {
    scanMode = 'malformed';
    await expect(adapter.prepare(context())).rejects.toBeInstanceOf(ConflictException);

    scanMode = 'normal';
    const badKey = 'factoryos:tenant:' + tenantA + ':BUSINESS_DATA:email-person@example.test';
    values.set(badKey, Buffer.from('opaque'));
    await expect(adapter.prepare(context())).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses unsupported Redis value types rather than deleting unknown keyspaces', async () => {
    const key = tenantCachePhysicalKey(tenantA, Category.BUSINESS_DATA, logicalKey);
    values.set(key, Buffer.from('bytes'));
    keyTypes.set(key, 'hash');

    await expect(adapter.prepare(context())).rejects.toBeInstanceOf(ConflictException);
    expect(values.has(key)).toBe(true);
  });

  it('requires matching target config and the registered CACHE scope', async () => {
    expect(await adapter.isConfigured(target)).toBe(true);
    expect(await adapter.isConfigured({ ...target, configReference: 'other-config' })).toBe(false);
    expect(await adapter.isConfigured({ ...target, adapterKey: 'cache.other.v1' })).toBe(false);
    await expect(adapter.prepare(context({
      target: { ...target, categories: [Category.AUDIT_LOG] },
    }))).rejects.toBeInstanceOf(ConflictException);
    expect(redis.assertStandalonePrimary).toHaveBeenCalled();
  });

  it('binds category fences to the erasure request and refuses a competing request', async () => {
    const fence = tenantCacheFenceKey(tenantA, Category.BUSINESS_DATA);
    fences.set(fence, 'different-erasure-request');
    await expect(adapter.prepare(context())).rejects.toBeInstanceOf(ConflictException);
    expect(values.size).toBe(0);
  });
});
