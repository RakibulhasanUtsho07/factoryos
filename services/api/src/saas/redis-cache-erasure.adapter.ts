import { createHash } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  canonicalizeSaasExternalPropagationResources,
  digestSaasExternalPropagationResources,
} from './saas-tenant-propagation.adapters';
import type {
  SaasExternalPropagationContext,
  SaasExternalPropagationDeleteReceipt,
  SaasExternalPropagationPlan,
  SaasExternalPropagationResourceIdentity,
  SaasExternalPropagationVerification,
  SaasTenantExternalDataPropagationAdapter,
  SaasTenantExternalDataTarget,
} from './saas-tenant-propagation.adapters';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import {
  assertTenantCachePhysicalKey,
  isSupportedCacheCategory,
  REDIS_CACHE_ADAPTER_KEY,
  REDIS_CACHE_ADAPTER_VERSION,
  REDIS_CACHE_CONFIG_REFERENCE,
  REDIS_CACHE_RESOURCE_KIND,
  tenantCacheCategoryPrefix,
  tenantCacheFenceKey,
  tenantCacheFenceOwner,
} from './tenant-cache.contract';
import { RedisTenantCacheClient } from './redis-tenant-cache.client';

const STORE_KIND = 'CACHE' as const;
const PAGE_SIZE = 1000;
const DB_BATCH_SIZE = 500;
const MAX_PLAN_KEYS = 100000;
const MAX_SCAN_PAGES = 100000;
const READ_CONCURRENCY = 8;
const AOF_REWRITE_TIMEOUT_MS = 30000;
const AOF_REWRITE_POLL_MS = 100;
const HEX_DIGEST = /^[a-f0-9]{64}$/;

const ACQUIRE_FENCES = `
for i = 1, #KEYS do
  local current = redis.call('GET', KEYS[i])
  if current and current ~= ARGV[i] then
    return i
  end
end
for i = 1, #KEYS do
  if not redis.call('GET', KEYS[i]) then
    redis.call('SET', KEYS[i], ARGV[i])
  end
end
return 0
`;

const RELEASE_FENCES_IF_OWNED = `
for i = 1, #KEYS do
  local current = redis.call('GET', KEYS[i])
  if current and current ~= ARGV[i] then
    return 0
  end
end
local released = 0
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[i] then
    released = released + redis.call('DEL', KEYS[i])
  end
end
return released
`;

/**
 * Atomic compare-and-delete prevents a writer that bypasses the shared client
 * (or an out-of-band mutation) from changing a value between digest recheck and
 * DEL. Only string values are part of this namespace contract; unknown types
 * are rejected, never silently deleted.
 */
const DELETE_IF_VALUE_MATCHES = `
local keyType = redis.call('TYPE', KEYS[1]).ok
if keyType == 'none' then
  return 0
end
if keyType ~= 'string' then
  return -2
end
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
if current ~= ARGV[1] then
  return -1
end
return redis.call('DEL', KEYS[1])
`;

@Injectable()
export class RedisCacheErasureAdapter implements SaasTenantExternalDataPropagationAdapter {
  readonly storeKind = STORE_KIND;
  readonly adapterKey = REDIS_CACHE_ADAPTER_KEY;
  readonly adapterVersion = REDIS_CACHE_ADAPTER_VERSION;

  constructor(private readonly config: ConfigService, private readonly redis: RedisTenantCacheClient) {}

  async isConfigured(target: SaasTenantExternalDataTarget): Promise<boolean> {
    if (target.storeKind !== STORE_KIND || target.adapterKey !== REDIS_CACHE_ADAPTER_KEY
      || !target.required || !Array.isArray(target.categories) || target.categories.length === 0
      || !target.categories.every(isSupportedCacheCategory)) {
      return false;
    }
    const expected = this.config.get<string>(REDIS_CACHE_CONFIG_REFERENCE)?.trim();
    if (!expected || target.configReference.trim() !== expected) return false;
    try {
      await this.redis.assertStandalonePrimary();
      return true;
    } catch {
      return false;
    }
  }

  async prepare(input: SaasExternalPropagationContext): Promise<SaasExternalPropagationPlan> {
    this.assertSupportedContext(input);
    await this.redis.assertStandalonePrimary();
    const client = await this.redis.getClient();
    const owner = tenantCacheFenceOwner(input);
    await this.acquireFences(input.tenantId, input.categories, owner);

    try {
      const keySet = new Set<string>();
      for (const category of input.categories) {
        const keys = await this.scanTenantCategoryKeys(client, input.tenantId, category);
        for (const key of keys) {
          keySet.add(key);
          if (keySet.size > MAX_PLAN_KEYS) {
            throw new ConflictException('Tenant cache inventory exceeds the bounded erasure plan size');
          }
        }
      }
      const keys = [...keySet].sort();
      const resources: SaasExternalPropagationResourceIdentity[] = [];
      for (let offset = 0; offset < keys.length; offset += READ_CONCURRENCY) {
        const batch = keys.slice(offset, offset + READ_CONCURRENCY);
        const identities = await Promise.all(batch.map((key) => this.readIdentity(key)));
        resources.push(...identities.filter((resource): resource is SaasExternalPropagationResourceIdentity => resource !== null));
      }

      const canonical = canonicalizeSaasExternalPropagationResources(resources);
      const manifestDigest = digestSaasExternalPropagationResources(resources);
      return {
        manifestDigest,
        plannedCopies: String(canonical.length),
        planReference: 'redis-cache-plan.' + manifestDigest.slice(0, 40),
        adapterVersion: this.adapterVersion,
        resourceClass: REDIS_CACHE_RESOURCE_KIND,
        maxPageSize: PAGE_SIZE,
        maxBatchSize: DB_BATCH_SIZE,
        policyVersions: {
          namespace: 'tenant-category-sha256-v1',
          fencing: 'per-category-nonexpiring-lua-v1',
          valueDigest: 'redis-string-sha256-v1',
          deletion: 'binary-safe-compare-and-delete-lua-v1',
          topology: 'standalone-primary-no-replicas-noeviction-v1',
        },
        resources: canonical,
      };
    } catch (error) {
      // No provider object was mutated during prepare. Release only this
      // request's fences when inventory could not be sealed; if Redis is
      // unavailable or ownership changed, fail closed and leave any fence set.
      await this.releaseFencesIfOwned(input.tenantId, input.categories, owner).catch(() => undefined);
      throw error;
    }
  }

  async erase(
    input: SaasExternalPropagationContext & { plan: SaasExternalPropagationPlan },
  ): Promise<SaasExternalPropagationDeleteReceipt> {
    this.assertSupportedContext(input);
    this.assertPlan(input.tenantId, input.categories, input.plan);
    await this.redis.assertStandalonePrimary();
    const client = await this.redis.getClient();
    await this.acquireFences(input.tenantId, input.categories, tenantCacheFenceOwner(input));

    let accounted = 0;
    for (const resource of input.plan.resources) {
      const key = resource.resourceReference;
      const expectedDigest = resource.resourceContentDigest;
      if (typeof expectedDigest !== 'string' || !HEX_DIGEST.test(expectedDigest)) {
        throw new ConflictException('Redis cache manifest is missing a verified content digest');
      }

      const keyType = await client.type(key);
      if (keyType === 'none') {
        accounted += 1;
        continue;
      }
      if (keyType !== 'string') {
        throw new ConflictException('Redis cache namespace contains an unsupported non-string value type');
      }
      const bytes = await this.redis.getBytes(key);
      if (!bytes) {
        accounted += 1;
        continue;
      }
      if (this.digest(bytes) !== expectedDigest) {
        throw new ConflictException('Redis cache bytes changed after the sealed resource inventory was prepared');
      }

      const result: unknown = await client.eval(DELETE_IF_VALUE_MATCHES, {
        keys: [key],
        arguments: [bytes],
      });
      if (result === -1) {
        throw new ConflictException('Redis cache value changed during atomic compare-and-delete; deletion was blocked');
      }
      if (result === -2) {
        throw new ConflictException('Redis cache value type changed after the sealed inventory; deletion was blocked');
      }
      if (result !== 0 && result !== 1) {
        throw new ConflictException('Redis cache compare-and-delete returned an unsupported result');
      }
      accounted += 1;
    }

    // DEL appends tombstones to Redis AOF. Compact the active AOF after all
    // planned keys have been removed so historical SET records are not retained
    // in the current persistence log. AOF backups and media sanitization remain
    // separate BACKUP/provider duties.
    await this.rewriteAofAfterDeletion(client);

    return {
      // This is the number of sealed identities accounted for, including
      // identities already absent after a previously durable DELETE_REQUESTED.
      deletedCopies: String(accounted),
      manifestDigest: input.plan.manifestDigest,
      // Redis has no provider-issued per-operation delete receipt for this flow;
      // this is a deterministic correlation reference backed by CAS/read-back.
      providerReceiptReference: 'redis-cache-delete.' + input.plan.manifestDigest.slice(0, 40),
    };
  }

  async verify(
    input: SaasExternalPropagationContext & {
      plan: SaasExternalPropagationPlan;
      deletion: SaasExternalPropagationDeleteReceipt;
    },
  ): Promise<SaasExternalPropagationVerification> {
    this.assertSupportedContext(input);
    this.assertPlan(input.tenantId, input.categories, input.plan);
    if (input.deletion.manifestDigest !== input.plan.manifestDigest
      || input.deletion.deletedCopies !== input.plan.plannedCopies) {
      throw new ConflictException('Redis cache deletion evidence does not match the sealed tenant inventory');
    }
    await this.redis.assertStandalonePrimary();
    const client = await this.redis.getClient();
    await this.acquireFences(input.tenantId, input.categories, tenantCacheFenceOwner(input));

    const residual = new Set<string>();
    for (const category of input.categories) {
      for (const key of await this.scanTenantCategoryKeys(client, input.tenantId, category)) {
        residual.add(key);
      }
    }
    const references = [...residual].sort();
    return {
      verifiedManifestDigest: input.plan.manifestDigest,
      residualCopies: String(references.length),
      residualReferences: references.slice(0, 50),
      verificationReference: 'redis-cache-verify.' + input.plan.manifestDigest.slice(0, 40),
    };
  }

  async recover(
    input: SaasExternalPropagationContext & { plan?: SaasExternalPropagationPlan },
  ): Promise<void> {
    this.assertSupportedContext(input);
    if (!input.plan) return;
    this.assertPlan(input.tenantId, input.categories, input.plan);
    await this.redis.assertStandalonePrimary();
    const client = await this.redis.getClient();
    await this.acquireFences(input.tenantId, input.categories, tenantCacheFenceOwner(input));

    for (const resource of input.plan.resources) {
      const expectedDigest = resource.resourceContentDigest;
      if (typeof expectedDigest !== 'string' || !HEX_DIGEST.test(expectedDigest)) {
        throw new ConflictException('Redis cache recovery plan lacks a content digest');
      }
      const keyType = await client.type(resource.resourceReference);
      if (keyType === 'none') continue;
      if (keyType !== 'string') {
        throw new ConflictException('Redis cache recovery found an unsupported value type; deletion remains blocked');
      }
      const current = await this.redis.getBytes(resource.resourceReference);
      if (current && this.digest(current) !== expectedDigest) {
        throw new ConflictException('Redis cache value changed after the sealed plan; provider deletion is blocked');
      }
    }
  }

  private assertSupportedContext(input: SaasExternalPropagationContext) {
    if (input.target.storeKind !== STORE_KIND || input.target.adapterKey !== REDIS_CACHE_ADAPTER_KEY
      || !input.target.required || !Array.isArray(input.categories) || input.categories.length === 0
      || !input.categories.every(isSupportedCacheCategory)
      || new Set(input.categories).size !== input.categories.length
      || !Array.isArray(input.target.categories) || !input.target.categories.every(isSupportedCacheCategory)
      || !input.categories.every((category) => input.target.categories.includes(category))) {
      throw new ConflictException('Redis cache erasure requires a reviewed required CACHE target covering the requested categories');
    }
    const expected = this.config.get<string>(REDIS_CACHE_CONFIG_REFERENCE)?.trim();
    if (!expected || input.target.configReference.trim() !== expected) {
      throw new ConflictException('Redis cache target config reference does not match the configured deployment boundary');
    }
  }

  private assertPlan(
    tenantId: string,
    categories: SaasTransferDatasetCategory[],
    plan: SaasExternalPropagationPlan,
  ) {
    if (!plan || plan.adapterVersion !== this.adapterVersion
      || plan.resourceClass !== REDIS_CACHE_RESOURCE_KIND
      || !HEX_DIGEST.test(plan.manifestDigest)
      || Number(plan.plannedCopies) !== plan.resources.length
      || plan.resources.length > MAX_PLAN_KEYS
      || digestSaasExternalPropagationResources(plan.resources) !== plan.manifestDigest) {
      throw new ConflictException('Redis cache plan does not match the canonical content-digested inventory');
    }
    const seen = new Set<string>();
    for (const resource of plan.resources) {
      if (resource.resourceKind !== REDIS_CACHE_RESOURCE_KIND
        || resource.resourceVersionReference !== null
        || typeof resource.resourceContentDigest !== 'string'
        || !HEX_DIGEST.test(resource.resourceContentDigest)) {
        throw new ConflictException('Redis cache plan contains an invalid resource identity');
      }
      try {
        assertTenantCachePhysicalKey(resource.resourceReference, tenantId, categories);
      } catch {
        throw new ConflictException('Redis cache plan contains a non-tenant-scoped or unsupported key identity');
      }
      if (seen.has(resource.resourceReference)) {
        throw new ConflictException('Redis cache plan contains a duplicate key identity');
      }
      seen.add(resource.resourceReference);
    }
  }

  private async scanTenantCategoryKeys(
    client: Awaited<ReturnType<RedisTenantCacheClient['getClient']>>,
    tenantId: string,
    category: SaasTransferDatasetCategory,
  ): Promise<string[]> {
    const prefix = tenantCacheCategoryPrefix(tenantId, category);
    let cursor = '0';
    let pages = 0;
    const seenCursors = new Set<string>();
    const keys = new Set<string>();

    do {
      if (++pages > MAX_SCAN_PAGES) {
        throw new ConflictException('Redis cache SCAN exceeded its bounded page limit');
      }
      const result: unknown = await client.scan(cursor, { MATCH: prefix + '*', COUNT: PAGE_SIZE });
      if (!result || typeof result !== 'object') {
        throw new ConflictException('Redis cache SCAN returned a malformed page');
      }
      const page = result as { cursor?: unknown; keys?: unknown };
      const nextCursor = this.cursor(page.cursor);
      if (!Array.isArray(page.keys)) {
        throw new ConflictException('Redis cache SCAN page omitted its key array');
      }

      for (const rawKey of page.keys) {
        const key = this.redisText(rawKey);
        if (!key.startsWith(prefix)) {
          throw new ConflictException('Redis cache SCAN returned a key outside the requested tenant/category prefix');
        }
        try {
          assertTenantCachePhysicalKey(key, tenantId, [category]);
        } catch {
          throw new ConflictException('Redis cache namespace contains an unsupported key shape; inventory is incomplete');
        }
        keys.add(key);
        if (keys.size > MAX_PLAN_KEYS) {
          throw new ConflictException('Redis cache tenant/category inventory exceeds the bounded plan size');
        }
      }

      if (nextCursor !== '0') {
        if (seenCursors.has(nextCursor)) {
          throw new ConflictException('Redis cache SCAN repeated a non-terminal cursor');
        }
        seenCursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor !== '0');

    return [...keys].sort();
  }

  private async readIdentity(key: string): Promise<SaasExternalPropagationResourceIdentity | null> {
    const client = await this.redis.getClient();
    const keyType = await client.type(key);
    if (keyType === 'none') return null;
    if (keyType !== 'string') {
      throw new ConflictException('Redis cache namespace contains a non-string entry; inventory cannot be sealed');
    }
    const bytes = await this.redis.getBytes(key);
    if (!bytes) return null; // Key expired between SCAN and GET; it no longer exists.
    return {
      resourceKind: REDIS_CACHE_RESOURCE_KIND,
      resourceReference: key,
      resourceVersionReference: null,
      resourceContentDigest: this.digest(bytes),
    };
  }

  private async rewriteAofAfterDeletion(
    client: Awaited<ReturnType<RedisTenantCacheClient['getClient']>>,
  ): Promise<void> {
    const deadline = Date.now() + AOF_REWRITE_TIMEOUT_MS;

    // If a rewrite was already in progress, let it finish, then start another
    // one after deletion. A rewrite started before our DEL could leave a prior
    // SET in the base file and a DEL only in the tail.
    await this.waitForAofIdle(client, deadline, false);
    let started = false;
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
      try {
        const response: unknown = await client.sendCommand(['BGREWRITEAOF']);
        const text = this.redisText(response);
        if (!/started|scheduled/i.test(text)) {
          throw new ConflictException('Redis did not acknowledge an AOF rewrite after cache deletion');
        }
        started = true;
      } catch (error) {
        if (!/already in progress/i.test(error instanceof Error ? error.message : String(error))
          || attempt === 2) {
          throw new ConflictException('Redis cache deletion could not compact its active AOF persistence log');
        }
        await this.waitForAofIdle(client, deadline, false);
      }
    }
    if (!started) {
      throw new ConflictException('Redis did not start an AOF rewrite after cache deletion');
    }
    await this.waitForAofIdle(client, deadline);
  }

  private async waitForAofIdle(
    client: Awaited<ReturnType<RedisTenantCacheClient['getClient']>>,
    deadline: number,
    requireSuccessfulRewrite = true,
  ): Promise<void> {
    while (Date.now() < deadline) {
      const info = this.redisText(await client.sendCommand(['INFO', 'persistence']));
      const rewriteActive = this.infoValue(info, 'aof_rewrite_in_progress');
      const rewriteScheduled = this.infoValue(info, 'aof_rewrite_scheduled');
      if (rewriteActive === '0' && rewriteScheduled === '0') {
        if (requireSuccessfulRewrite && this.infoValue(info, 'aof_last_bgrewrite_status') !== 'ok') {
          throw new ConflictException('Redis AOF rewrite did not complete successfully after cache deletion');
        }
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, AOF_REWRITE_POLL_MS));
    }
    throw new ConflictException('Timed out waiting for Redis AOF rewrite; cache erasure remains unverified');
  }

  private infoValue(info: string, field: string): string | null {
    for (const line of info.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator >= 0 && line.slice(0, separator) === field) {
        return line.slice(separator + 1).trim();
      }
    }
    return null;
  }

  private async acquireFences(
    tenantId: string,
    categories: SaasTransferDatasetCategory[],
    owner: string,
  ): Promise<void> {
    const client = await this.redis.getClient();
    const keys = categories.map((category) => tenantCacheFenceKey(tenantId, category));
    const result: unknown = await client.eval(ACQUIRE_FENCES, {
      keys,
      arguments: categories.map(() => owner),
    });
    if (result !== 0) {
      throw new ConflictException('Tenant cache category is fenced by another erasure request');
    }
  }

  private async releaseFencesIfOwned(
    tenantId: string,
    categories: SaasTransferDatasetCategory[],
    owner: string,
  ): Promise<void> {
    if (categories.length === 0) return;
    const client = await this.redis.getClient();
    await client.eval(RELEASE_FENCES_IF_OWNED, {
      keys: categories.map((category) => tenantCacheFenceKey(tenantId, category)),
      arguments: categories.map(() => owner),
    });
  }

  private cursor(value: unknown): string {
    // The Redis client maps RESP bulk strings to Buffer globally so cache
    // payload bytes remain lossless. SCAN's cursor is also a bulk string on
    // the wire; accept only ASCII decimal bytes before normalizing it.
    const cursor = Buffer.isBuffer(value) ? value.toString('ascii')
      : typeof value === 'number' ? String(value)
      : typeof value === 'string' ? value : '';
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) {
      throw new ConflictException('Redis cache SCAN returned an invalid cursor');
    }
    return cursor;
  }

  private redisText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    throw new ConflictException('Redis cache returned a key with an unsupported encoding');
  }

  private digest(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
