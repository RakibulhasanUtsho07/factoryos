# Tenant-scoped Redis cache and erasure

## Contract

This introduces a concrete, narrowly-scoped Redis cache runtime for tenant-derived cache data. It is intentionally not a general Redis management API.

- Provider config: `FACTORYOS_CACHE_CONFIG_REFERENCE` is an opaque deployment reference and must exactly match a reviewed `CACHE / cache.redis.v1` target. `FACTORYOS_CACHE_URL` resolves from deployment secret configuration; production requires `rediss://`.
- Supported topology for erasure: one standalone Redis primary, `cluster_enabled:0`, no attached replicas, `maxmemory_policy:noeviction`, `appendonly=yes`, `appendfsync=always` with healthy AOF writes, and RDB snapshot schedule disabled. Cluster, replica, sentinel/failover or other topologies are not considered completely inventoried by this adapter and fail closed.
- Synchronous AOF is required for the non-expiring fence to survive a Redis crash/restart. Without fence durability, a restarted cache could silently accept new writes after the erasure request had been verified. After deleting the exact planned keys, the adapter runs and independently waits for a fresh `BGREWRITEAOF` so removed values are not left as historical SET records in the current AOF. Provider ACLs must allow the read-only topology/config probes plus this compaction operation.
- Data namespace: `factoryos:tenant:{tenant UUID}:{DATASET_CATEGORY}:{sha256(logical key)}`. The raw caller key is never written as a Redis key or included in the sealed erasure manifest.
- Application access: all supported tenant cache reads/writes go through `TenantCacheService`. `TenantCacheModule` keeps `RedisTenantCacheClient` private and exports only the tenant cache facade and the erasure adapter. A normal application module cannot inject the raw Redis client through Nest module visibility. New direct Redis writes to this namespace are a contract violation.
- CI access-boundary contract: `scripts/audit/tenant-cache-access-contract.test.mjs` scans production source and package manifests, allows the Redis driver only inside `RedisTenantCacheClient`, and checks that app-facing read/write methods use the atomic category-fence scripts. The tests intentionally exclude test fixtures; production source may not add a separate client or raw namespace writer without updating this reviewed boundary.
- Values: only UTF-8 strings up to 1 MiB; optional TTL from 1 second through 30 days. The erasure adapter rejects hash/list/set/zset/stream or other non-string values rather than guessing how to delete them.
- Enumeration: bounded SCAN pagination, exact category prefix/key-shape validation, duplicate-resistant identity manifests, 100,000-key cap and per-value SHA-256 readback.
- Erasure: atomically fence every requested tenant/category before inventory; atomically compare value bytes and delete the exact key; do not delete changed data. The fence does not auto-expire and remains after successful erasure so compliant writes cannot silently repopulate that request's erased scope.
- Verification: a fresh full category inventory after deletion; any residual or out-of-band writer is reported instead of returning zero residuals.
- Recovery: read-only; it re-establishes/validates the request fence and rejects unsupported or changed resource values before a retry.

## Write fencing / operations

The cache write script checks the category fence in the same Lua operation that commits SET, and reads similarly check the fence while fetching a value. Therefore compliant reads/writes cannot race through the fence acquisition. This fence is held in Redis and deliberately uses no TTL; using an evicting policy could drop it, so `maxmemory-policy=noeviction` is required. Synchronous append-only persistence (`appendonly=yes`, `appendfsync=always`) is also mandatory so process crashes do not discard a committed fence while leaving the cache service available to accept writes. RDB snapshots are disabled because they would be another unenumerated historical copy. A successful live-cache adapter receipt requires a post-delete AOF rewrite to complete; backups of AOF files, filesystem snapshots, immutable copies and physical-media sanitization remain outside this adapter.

If an erase run is interrupted, leave its fence in place and recover the same immutable erasure request. Do not manually delete a fence to restore writes until the erasure request is formally canceled and an independent review confirms the exact target/request binding. If the configured Redis endpoint is unavailable or the topology/ACL cannot run PING, INFO, ROLE, SCAN, TYPE, GET, SET/DEL and Lua scripts, the adapter is unconfigured or the operation fails closed.

## Receipt semantics and limitations

Redis does not issue a provider-signed per-key deletion receipt for the Lua compare-and-delete path. The `redis-cache-delete.*` field is a deterministic adapter correlation reference backed by the sealed value digest and compare-and-delete result; it is not a Redis-issued receipt.

This adapter inventories only the configured standalone database and explicitly rejects Redis Cluster or enumerated replicas. Any other shared cache provider, tenant key namespace, Redis logical database, module data structure or persistence/backup copy is a separate store/adapter responsibility. The APP's existing caches (if any) must use `TenantCacheService`; migrate each actual writer before registering a required production CACHE target.

CI evidence is limited to an isolated Redis 7.4 service and synthetic tenant keys. It is not production credential validation, staging acceptance, a production erasure, or proof that backups/replicas/external providers have been erased. AS-137 / NFR-PROD-14 remain PARTIAL until all required store classes have approved adapters and controlled staging evidence.

## Backup and historical-copy retention

Use the [external erasure backup-copy retention runbook](external-erasure-backup-copy-retention-runbook.md) to inventory and govern AOF/RDB backups, filesystem and volume snapshots, replica/failover copies, backup-vault and disaster-recovery copies, and legacy/external caches. The live-cache `BGREWRITEAOF` operation is not evidence that these separate copies were erased. Retention durations require approved legal/compliance policy; undocumented or unenumerated copies block whole-request verification.
