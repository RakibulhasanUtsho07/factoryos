import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { RedisTenantCacheClient } from './redis-tenant-cache.client';
import { RedisCacheErasureAdapter } from './redis-cache-erasure.adapter';
import { TenantCacheService } from './tenant-cache.service';
import { tenantCacheCategoryPrefix, tenantCacheFenceKey } from './tenant-cache.contract';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';
import type { SaasExternalPropagationContext } from './saas-tenant-propagation.adapters';

const enabled = Boolean(
  process.env.FACTORYOS_CACHE_URL?.trim()
  && process.env.FACTORYOS_CACHE_CONFIG_REFERENCE?.trim(),
);
const cacheDescribe = enabled ? describe : describe.skip;

cacheDescribe('Redis tenant-cache erasure against an isolated Redis server', () => {
  const config = new ConfigService({
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    FACTORYOS_CACHE_URL: process.env.FACTORYOS_CACHE_URL,
    FACTORYOS_CACHE_CONFIG_REFERENCE: process.env.FACTORYOS_CACHE_CONFIG_REFERENCE,
    FACTORYOS_CACHE_CONNECT_TIMEOUT_MS: process.env.FACTORYOS_CACHE_CONNECT_TIMEOUT_MS ?? '5000',
  });
  const redis = new RedisTenantCacheClient(config);
  const cache = new TenantCacheService(redis);
  const adapter = new RedisCacheErasureAdapter(config, redis);
  const tenants = new Set<string>();
  let client: Awaited<ReturnType<RedisTenantCacheClient['getClient']>>;

  function newTenant(): string {
    const id = randomUUID();
    tenants.add(id);
    return id;
  }

  function context(tenantId: string): SaasExternalPropagationContext {
    const target = {
      tenantId,
      targetId: 'cache-primary',
      storeKind: 'CACHE' as const,
      adapterKey: 'cache.redis.v1',
      configReference: process.env.FACTORYOS_CACHE_CONFIG_REFERENCE!.trim(),
      categories: [Category.BUSINESS_DATA],
      required: true,
    };
    return {
      tenantId,
      requestId: randomUUID(),
      requestVersion: 1,
      runId: randomUUID(),
      categories: [Category.BUSINESS_DATA],
      sourceExportDigest: 'a'.repeat(64),
      sourceManifest: { categories: ['BUSINESS_DATA'] },
      idempotencyKey: 'redis-cache-erasure.' + randomUUID(),
      target,
    };
  }

  async function cleanupTenant(tenantId: string): Promise<void> {
    const keys = new Set<string>();
    for (const category of Object.values(Category)) {
      let cursor = '0';
      do {
        const result = await client.scan(cursor, {
          MATCH: tenantCacheCategoryPrefix(tenantId, category as Category) + '*',
          COUNT: 500,
        });
        cursor = String(result.cursor);
        for (const key of result.keys) keys.add(Buffer.isBuffer(key) ? key.toString('utf8') : String(key));
      } while (cursor !== '0');
      await client.del(tenantCacheFenceKey(tenantId, category as Category));
    }
    if (keys.size) await client.del([...keys]);
  }

  beforeAll(async () => {
    if (!enabled) return;
    client = await redis.getClient();
    await redis.assertStandalonePrimary();
  });

  afterEach(async () => {
    if (!enabled || !client?.isReady) return;
    for (const tenantId of tenants) await cleanupTenant(tenantId);
    tenants.clear();
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
  });

  it('erases tenant A while preserving tenant B and permanently fences compliant writes', async () => {
    const tenantA = newTenant();
    const tenantB = newTenant();
    const ctx = context(tenantA);
    await cache.set(tenantA, Category.BUSINESS_DATA, 'profile:private-id', 'tenant-a-value');
    await cache.set(tenantB, Category.BUSINESS_DATA, 'profile:private-id', 'tenant-b-value');

    expect(await adapter.isConfigured(ctx.target)).toBe(true);
    const plan = await adapter.prepare(ctx);
    expect(plan).toMatchObject({
      plannedCopies: '1',
      adapterVersion: '1.0.0',
      resourceClass: 'REDIS_CACHE_STRING',
      resources: [{
        resourceKind: 'REDIS_CACHE_STRING',
        resourceContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    expect(JSON.stringify(plan)).not.toContain('private-id');
    await expect(cache.set(tenantA, Category.BUSINESS_DATA, 'late-write', 'blocked'))
      .rejects.toBeInstanceOf(ConflictException);

    const deletion = await adapter.erase({ ...ctx, plan });
    const verification = await adapter.verify({ ...ctx, plan, deletion });
    expect(verification).toMatchObject({
      verifiedManifestDigest: plan.manifestDigest,
      residualCopies: '0',
      residualReferences: [],
    });
    expect(await cache.get(tenantA, Category.BUSINESS_DATA, 'profile:private-id')).toBeNull();
    expect(await cache.get(tenantB, Category.BUSINESS_DATA, 'profile:private-id')).toBe('tenant-b-value');
  });

  it('refuses to delete a value changed after manifest sealing', async () => {
    const tenantId = newTenant();
    const ctx = context(tenantId);
    await cache.set(tenantId, Category.BUSINESS_DATA, 'protected', 'before');
    const plan = await adapter.prepare(ctx);
    const key = plan.resources[0].resourceReference;
    await client.set(key, 'changed-out-of-band');

    await expect(adapter.erase({ ...ctx, plan })).rejects.toBeInstanceOf(ConflictException);
    expect(await redis.getBytes(key)).toEqual(Buffer.from('changed-out-of-band'));
  });

  it('independently reports a late out-of-band key as a residual', async () => {
    const tenantId = newTenant();
    const ctx = context(tenantId);
    await cache.set(tenantId, Category.BUSINESS_DATA, 'planned', 'before');
    const plan = await adapter.prepare(ctx);
    const deletion = {
      deletedCopies: plan.plannedCopies,
      manifestDigest: plan.manifestDigest,
      providerReceiptReference: 'test-only-delete-correlation',
    };
    // Simulate a writer that bypasses TenantCacheService. A final inventory
    // detects this instead of treating the category fence as universal.
    await client.set(
      tenantCacheCategoryPrefix(tenantId, Category.BUSINESS_DATA)
        + 'b'.repeat(64),
      'late-out-of-band-value',
    );

    const verification = await adapter.verify({ ...ctx, plan, deletion });
    expect(verification.residualCopies).toBe('2');
    expect(verification.residualReferences.length).toBeGreaterThan(0);
  });

  it('fails closed on unsupported key shapes and non-string data', async () => {
    const tenantId = newTenant();
    const ctx = context(tenantId);
    const badKey = tenantCacheCategoryPrefix(tenantId, Category.BUSINESS_DATA) + 'plaintext-key';
    await client.set(badKey, 'unreviewed');
    await expect(adapter.prepare(ctx)).rejects.toBeInstanceOf(ConflictException);

    await client.del(badKey);
    const hashKey = tenantCacheCategoryPrefix(tenantId, Category.BUSINESS_DATA) + 'c'.repeat(64);
    await client.hSet(hashKey, { field: 'value' });
    await expect(adapter.prepare(ctx)).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not accept a mismatched deployment config reference', async () => {
    const tenantId = newTenant();
    const ctx = context(tenantId);
    expect(await adapter.isConfigured({ ...ctx.target, configReference: 'another-cache-config' })).toBe(false);
    await expect(adapter.prepare({
      ...ctx,
      target: { ...ctx.target, configReference: 'another-cache-config' },
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
