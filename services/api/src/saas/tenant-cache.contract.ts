import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

export const REDIS_CACHE_ADAPTER_KEY = 'cache.redis.v1';
export const REDIS_CACHE_ADAPTER_VERSION = '1.0.0';
export const REDIS_CACHE_RESOURCE_KIND = 'REDIS_CACHE_STRING';
export const REDIS_CACHE_CONFIG_REFERENCE = 'FACTORYOS_CACHE_CONFIG_REFERENCE';

const DATA_NAMESPACE = 'factoryos:tenant:';
const FENCE_NAMESPACE = 'factoryos:tenant-erasure-fence:';
const LOGICAL_KEY_MAX_BYTES = 1024;

export function isSupportedCacheCategory(value: unknown): value is SaasTransferDatasetCategory {
  return typeof value === 'string'
    && Object.values(SaasTransferDatasetCategory).includes(value as SaasTransferDatasetCategory);
}

export function tenantCacheCategoryPrefix(
  tenantId: string,
  category: SaasTransferDatasetCategory,
): string {
  return DATA_NAMESPACE + normalizeTenantId(tenantId) + ':' + normalizeCategory(category) + ':';
}

/**
 * Logical application keys are never stored in Redis or the erasure ledger.
 * The stable physical suffix is a SHA-256 digest, preventing emails, names and
 * other caller-supplied identifiers from leaking through keyspace inventory.
 */
export function tenantCachePhysicalKey(
  tenantId: string,
  category: SaasTransferDatasetCategory,
  logicalKey: string,
): string {
  if (typeof logicalKey !== 'string' || logicalKey.length === 0
    || Buffer.byteLength(logicalKey, 'utf8') > LOGICAL_KEY_MAX_BYTES
    || logicalKey.includes('\u0000')) {
    throw new BadRequestException('Tenant cache key must be non-empty and at most 1024 UTF-8 bytes');
  }
  return tenantCacheCategoryPrefix(tenantId, category)
    + createHash('sha256').update(logicalKey, 'utf8').digest('hex');
}

export function tenantCacheFenceKey(
  tenantId: string,
  category: SaasTransferDatasetCategory,
): string {
  return FENCE_NAMESPACE + normalizeTenantId(tenantId) + ':' + normalizeCategory(category);
}

/**
 * A fence is owned by one durable propagation run/target identity. It does not
 * expire automatically: a timeout must not silently re-enable writes while a
 * partially completed erasure is waiting for recovery.
 */
export function tenantCacheFenceOwner(input: {
  tenantId: string;
  requestId: string;
  requestVersion: number;
  runId: string;
  idempotencyKey: string;
  targetId: string;
}): string {
  const digest = createHash('sha256').update(JSON.stringify([
    normalizeTenantId(input.tenantId),
    input.requestId.toLowerCase(),
    input.requestVersion,
    input.runId.toLowerCase(),
    input.idempotencyKey,
    input.targetId,
  ]), 'utf8').digest('hex');
  return 'erasure-fence.v1.' + digest;
}

export function assertTenantCachePhysicalKey(
  reference: string,
  tenantId: string,
  categories: SaasTransferDatasetCategory[],
): SaasTransferDatasetCategory {
  if (typeof reference !== 'string') {
    throw new Error('Redis cache manifest reference must be a string');
  }
  for (const category of categories) {
    const prefix = tenantCacheCategoryPrefix(tenantId, category);
    const suffix = reference.startsWith(prefix) ? reference.slice(prefix.length) : '';
    if (/^[a-f0-9]{64}$/.test(suffix)) return category;
  }
  throw new Error('Redis cache manifest contains an unsupported tenant key shape');
}

function normalizeTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !isUUID(tenantId)) {
    throw new BadRequestException('tenantId must be a UUID for tenant cache operations');
  }
  return tenantId.toLowerCase();
}

function normalizeCategory(category: SaasTransferDatasetCategory): string {
  if (!isSupportedCacheCategory(category)) {
    throw new BadRequestException('Tenant cache category is unsupported');
  }
  return category;
}
