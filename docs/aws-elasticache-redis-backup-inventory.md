# AWS ElastiCache Redis OSS / Valkey backup inventory

**Status:** node-based, read-only provider inventory implementation with mocked AWS API contracts. It is not a snapshot deletion adapter, a serverless-cache inventory, an AOF/RDB file inventory for self-managed Redis, a live-provider staging attestation, or approval to erase cache data.

## Scope

Implementation: `services/api/src/saas/aws-elasticache-redis-backup-inventory.ts`

This reader captures the following native ElastiCache control-plane surfaces for each explicitly supplied AWS account/region scope:

- `DescribeCacheClusters`: node-based cache cluster identity, Redis OSS/Valkey engine and version, state, replication-group association, node type/count, snapshot retention/window and create time. Memcached clusters are counted separately and excluded from this Redis/Valkey catalog.
- `DescribeReplicationGroups`: replication-group state, Multi-AZ/automatic failover settings, cluster-mode state, snapshot configuration, member cluster IDs, shard IDs and node-role metadata. Network endpoints and connection strings are intentionally omitted.
- `DescribeGlobalReplicationGroups`: global datastore status and its regional replication-group member IDs, regions, roles and states. Global records returned in multiple regions are reconciled; conflicting catalog versions block the result. Every advertised member region must be present in the requested scope list before the global replication catalog is called complete.
- `DescribeSnapshots`: node-based Redis OSS/Valkey automatic and manual snapshot name, status/source, engine/version, associated replication-group/cache-cluster IDs, creation timestamp and per-node snapshot creation metadata.

The adapter uses the ElastiCache Query API version `2015-02-02`, AWS SigV4-signed HTTPS POST, and a separate STS `GetCallerIdentity` check for every supplied account/region scope. The caller supplies credentials from the already-assumed, dedicated reader role; the API verifies the account and exact role name before making any ElastiCache request.

## Identity and safety model

- The only ElastiCache operations implemented are `DescribeCacheClusters`, `DescribeReplicationGroups`, `DescribeGlobalReplicationGroups`, and `DescribeSnapshots`. No create, modify, failover, copy, restore or delete operation exists in this module.
- Deployment templates are in `deploy/aws/elasticache-redis-backup-inventory-reader-role-policy.template.json`, `deploy/aws/elasticache-redis-backup-inventory-reader-role-trust.template.json`, and `deploy/aws/elasticache-redis-backup-inventory-source-role-policy.template.json`.
- The role policy allows only the four inventory Describe actions and explicitly denies every other action. The trust template binds the designated source role and a unique ExternalId. Replace placeholders under the cloud-owner process; independently review the final effective trust, permission policy, boundary, SCP and session-policy interactions.
- Credentials and session tokens remain in memory and are never returned in inventory records, query receipts or logs.
- Raw resource descriptions, network endpoints, security-group identifiers, parameter values, ACLs, cache contents, backup payloads and object URLs are not captured.
- Responses are bounded to 4 MiB, request timeouts are bounded, pagination follows every continuation marker, repeated/oversized markers fail closed, and request/page/item limits are global across all supplied scopes. Empty continuation pages still consume the shared budget.
- STS account and assumed-role mismatches, AWS AccessDenied, malformed result containers, truncation, missing generation timestamps and a global datastore member in an unscanned region produce explicit blockers; they are not converted into empty success.
- Each page receives a local SHA-256 receipt reference. It is not AWS-signed evidence, CloudTrail evidence or proof that the account's complete enabled-region list was supplied.

## Snapshot identity limitation

The ElastiCache `DescribeSnapshots` API exposes a provider snapshot name and its create-time metadata, not a version ID equivalent to an S3 object version. The inventory creates an opaque correlation reference over partition, account, region, snapshot name and normalized create time. It labels that identity `SNAPSHOT_NAME_AND_CREATE_TIME`, preserves the original name separately, and never treats the digest as a provider-native immutable delete selector. If the timestamp is absent, the result is PARTIAL. Re-creating a snapshot name or a provider-side replacement cannot be safely handled as a destructive exact-generation identity by this inventory.

Automatic and manual source values are preserved as returned by the provider rather than interpreted as a deletion or retention decision. Retention days and snapshot windows are recorded as configuration metadata only; this code does not decide whether a snapshot is legally or operationally expired.

## Explicitly uncovered surfaces

The result permanently reports these coverage boundaries:

1. `serverless_cache_and_snapshot_surfaces_enumerated = false`. Serverless caches and serverless snapshots use separate ElastiCache Describe APIs and a separate pagination/protocol path. This node-based reader does not imply their coverage.
2. `self_managed_redis_aof_rdb_and_volume_backup_surfaces_enumerated = false`. This reader does not access Redis AOF/RDB files, container volumes, EBS snapshots, filesystem backups, Redis AOF rewrites, or self-managed Redis/Valkey deployments.
3. Global Datastore topology is captured only for members in the explicitly requested account/region scope. A global member in an unrequested region creates a blocker and is returned in `unscanned_global_member_scopes`.
4. Snapshot export/copy destinations, cross-account S3 exports, AWS Backup-managed copies, filesystem/block-volume snapshots, and external disaster-recovery copies are not described by these ElastiCache APIs and remain separate copy classes.
5. The output is not a restore test, a replication-lag measurement, a durability proof, an immutable provider inventory manifest, or a whole-tenant erasure receipt.

Consequently, `whole_cache_backup_coverage_complete`, `provider_mutation_performed`, `delete_api_available`, and `deletion_authorized` are always false. A COMPLETE status means only that the node-based API catalogs for the supplied and identity-verified scopes were exhausted without identified blockers; it must not be interpreted as whole ElastiCache or whole-tenant backup coverage.

## IAM permissions and provider facts

AWS documents `DescribeSnapshots` as the API for Valkey or Redis OSS cluster/replication-group snapshots, with Marker pagination and MaxRecords constrained to 20–50. `DescribeReplicationGroups` returns node-based Redis OSS/Valkey replication groups with Marker pagination and MaxRecords 20–100. `DescribeGlobalReplicationGroups` returns global datastore member information when `ShowMemberInfo=true`. Serverless cache and snapshot APIs are distinct operations.

- [ElastiCache snapshot and restore](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/backups.html)
- [DescribeSnapshots API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeSnapshots.html)
- [DescribeReplicationGroups API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeReplicationGroups.html)
- [DescribeGlobalReplicationGroups API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeGlobalReplicationGroups.html)
- [DescribeServerlessCaches API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeServerlessCaches.html)
- [DescribeServerlessCacheSnapshots API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeServerlessCacheSnapshots.html)

## Tests and acceptance boundary

Focused suite: `services/api/src/saas/aws-elasticache-redis-backup-inventory.spec.ts`.

The mocked API tests cover signed query requests, per-scope STS identity validation, cluster/replication/global-datastore/snapshot normalization, global datastore member reconciliation, empty continuation pages, repeated markers, denied snapshot enumeration, missing snapshot generation timestamps, out-of-scope regions and shared request-budget exhaustion.

These are mocked AWS responses only. The feature has not connected to an AWS account, created or assumed a live role, inspected production ElastiCache or serverless caches, tested snapshot restore, checked real regional failover, or exercised actual AOF/RDB/volume backups. Provider activation remains blocked pending cloud-owner role provisioning, independent effective-policy review, representative staging capture in all enabled regions, a controlled restore and separately reviewed evidence for serverless/self-managed/copy-destination surfaces.

**Issue #298 remains OPEN. AS-137 / NFR-PROD-14 remain PARTIAL.** This inventory does not authorize deletion or change the tenant-erasure status.
