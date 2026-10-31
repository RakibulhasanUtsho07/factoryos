import { isUtf8 } from 'node:buffer';
import { ConflictException, Injectable } from '@nestjs/common';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import {
  tenantCacheFenceKey,
  tenantCachePhysicalKey,
} from './tenant-cache.contract';
import { RedisTenantCacheClient } from './redis-tenant-cache.client';

const MAX_CACHE_VALUE_BYTES = 1024 * 1024;
const MAX_TTL_SECONDS = 60 * 60 * 24 * 30;

const READ_IF_UNFENCED = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return false
end
return redis.call('GET', KEYS[1])
`;

const WRITE_IF_UNFENCED = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local ttl = tonumber(ARGV[2])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1
`;

@Injectable()
export class TenantCacheService {
  constructor(private readonly redis: RedisTenantCacheClient) {}

  /**
   * Tenant cache access is category-scoped. Physical keys contain only a
   * SHA-256 digest of the caller key; the logical identifier is never logged or
   * written to Redis/erasure evidence.
   */
  async get(
    tenantId: string,
    category: SaasTransferDatasetCategory,
    logicalKey: string,
  ): Promise<string | null> {
    const key = tenantCachePhysicalKey(tenantId, category, logicalKey);
    const fence = tenantCacheFenceKey(tenantId, category);
    const client = await this.redis.getClient();
    const raw: unknown = await client.eval(READ_IF_UNFENCED, {
      keys: [key, fence],
      arguments: [],
    });
    if (raw === null || raw === false) return null;
    const value = Buffer.isBuffer(raw) ? raw
      : typeof raw === 'string' ? Buffer.from(raw, 'utf8') : null;
    if (!value || !isUtf8(value)) {
      throw new ConflictException('Tenant cache contains an invalid UTF-8 value; read is blocked');
    }
    return value.toString('utf8');
  }

  /**
   * Writes and erasure-fence acquisition are atomic with respect to each other.
   * A writer that runs before the fence is visible in SCAN; one that runs after
   * it is rejected. This prevents compliant application writers from repopulating
   * a sealed cache scope.
   */
  async set(
    tenantId: string,
    category: SaasTransferDatasetCategory,
    logicalKey: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CACHE_VALUE_BYTES) {
      throw new ConflictException('Tenant cache values must be UTF-8 strings no larger than 1 MiB');
    }
    if (ttlSeconds !== undefined
      && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS)) {
      throw new ConflictException('Tenant cache TTL must be an integer from 1 second to 30 days');
    }

    const key = tenantCachePhysicalKey(tenantId, category, logicalKey);
    const fence = tenantCacheFenceKey(tenantId, category);
    const client = await this.redis.getClient();
    const result: unknown = await client.eval(WRITE_IF_UNFENCED, {
      keys: [key, fence],
      arguments: [value, String(ttlSeconds ?? 0)],
    });
    if (result !== 1) {
      throw new ConflictException('Tenant cache category is fenced by an erasure operation');
    }
  }

  async delete(
    tenantId: string,
    category: SaasTransferDatasetCategory,
    logicalKey: string,
  ): Promise<void> {
    const key = tenantCachePhysicalKey(tenantId, category, logicalKey);
    const client = await this.redis.getClient();
    await client.del(key);
  }
}
