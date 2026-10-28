# Tenant-scoped Redis cache and erasure

## Contract

This introduces a concrete, narrowly-scoped Redis cache runtime for tenant-derived cache data. It is intentionally not a general Redis management API.

- Provider config: `FACTORYOS_CACHE_CONFIG_REFERENCE` is an opaque deployment reference and must exactly match a reviewed `CACHE / cache.redis.v1` target. `FACTORYOS_CACHE_URL` resolves from deployment secret configuration; production requires `rediss://`.
- Supported topology for erasure: one standalone Redis primary, `cluster_enabled:0`, no attached replicas, and `maxmemory_policy:noeviction`. Cluster, replica, sentinel/failover or other topologies are not considered completely inventoried by this adapter and fail closed.
- Data namespace: `factoryos:tenant:{tenant UUID}:{DATASET_CATEGORY}:{sha256(logical key)}`. The raw caller key is never written as a Redis key or included in the sealed erasure manifest.
- Application access: all supported tenant cache reads/writes go through `TenantCacheService`. New direct Redis writes to this namespace are a contract violation.
- Values: only UTF-8 strings up to 1 MiB; optional TTL from 1 second through 30 days. The erasure adapter rejects hash/list/set/zset/stream or other non-string values rather than guessing how to delete them.
- Enumeration: bounded SCAN pagination, exact category prefix/key-shape validation, duplicate-resistant identity manifests, 100,000-key cap and per-value SHA-256 readback.
- Erasure: atomically fence every requested tenant/category before inventory; atomically compare value bytes and delete the exact key; do not delete changed data. The fence does not auto-expire and remains after successful erasure so compliant writes cannot silently repopulate that request's erased scope.
- Verification: a fresh full category inventory after deletion; any residual or out-of-band writer is reported instead of returning zero residuals.
- Recovery: read-only; it re-establishes/validates the request fence and rejects unsupported or changed resource values before a retry.

## Write fencing / operations

The cache write script checks the category fence in the same Lua operation that commits SET, and reads similarly check the fence while fetching a value. Therefore compliant reads/writes cannot race through the fence acquisition. This fence is held in Redis and deliberately uses no TTL; using an evicting policy could drop it, so `maxmemory-policy=noeviction` is required.

If an erase run is interrupted, leave its fence in place and recover the same immutable erasure request. Do not manually delete a fence to restore writes until the erasure request is formally canceled and an independent review confirms the exact target/request binding. If the configured Redis endpoint is unavailable or the topology/ACL cannot run PING, INFO, ROLE, SCAN, TYPE, GET, SET/DEL and Lua scripts, the adapter is unconfigured or the operation fails closed.

## Receipt semantics and limitations

Redis does not issue a provider-signed per-key deletion receipt for the Lua compare-and-delete path. The `redis-cache-delete.*` field is a deterministic adapter correlation reference backed by the sealed value digest and compare-and-delete result; it is not a Redis-issued receipt.

This adapter inventories only the configured standalone database and explicitly rejects Redis Cluster or enumerated replicas. Any other shared cache provider, tenant key namespace, Redis logical database, module data structure or persistence/backup copy is a separate store/adapter responsibility. The APP's existing caches (if any) must use `TenantCacheService`; migrate each actual writer before registering a required production CACHE target.

CI evidence is limited to an isolated Redis 7.4 service and synthetic tenant keys. It is not production credential validation, staging acceptance, a production erasure, or proof that backups/replicas/external providers have been erased. AS-137 / NFR-PROD-14 remain PARTIAL until all required store classes have approved adapters and controlled staging evidence.
