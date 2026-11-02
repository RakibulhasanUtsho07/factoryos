# AWS ElastiCache node-based and serverless backup inventory

**Status:** read-only provider inventory implementation with mocked AWS API contracts. The reader enumerates node-based Redis OSS/Valkey resources and snapshots plus ElastiCache Serverless cache/snapshot catalogs for explicitly supplied, identity-verified account/region scopes. This is not a deletion adapter, export-destination inventory, AOF/RDB or volume-file inventory, live-provider staging attestation, restore test, or approval to erase cache data.

## Scope

Implementation: `services/api/src/saas/aws-elasticache-redis-backup-inventory.ts`

For every explicitly supplied AWS account/region scope, the reader captures:

### Node-based Redis OSS / Valkey

- `DescribeCacheClusters`: node-based cache cluster identity, Redis OSS/Valkey engine and version, state, replication-group association, node type/count, snapshot retention/window and create time. Memcached clusters are counted separately and excluded from this Redis/Valkey catalog.
- `DescribeReplicationGroups`: replication-group state, Multi-AZ/automatic failover settings, cluster-mode state, snapshot configuration, member cluster IDs, shard IDs and node-role metadata. Network endpoints and connection strings are intentionally omitted.
- `DescribeGlobalReplicationGroups`: global datastore status and its regional replication-group member IDs, regions, roles and states. Global records returned in multiple regions are reconciled; conflicting catalog versions block the result. Every advertised member region must be present in the requested scope list before the global replication catalog is called complete.
- `DescribeSnapshots`: node-based Redis OSS/Valkey automatic and manual snapshot name, status/source, engine/version, associated replication-group/cache-cluster IDs, creation timestamp and per-node snapshot creation metadata.

### ElastiCache Serverless

- `DescribeServerlessCaches`: Serverless cache name and provider ARN, Redis OSS/Valkey/Serverless Memcached engine, major/full engine versions, status, create time, configured snapshot retention days, daily snapshot window and storage-encryption type. No endpoints, KMS key IDs, security groups, parameter data or cache content are retained.
- `DescribeServerlessCacheSnapshots`: snapshot name and provider ARN, owning cache name and embedded engine/version metadata, manual/automatic snapshot type, status, create and expiry timestamps, and reported bytes used for cache. The output uses a digest of the provider snapshot ARN as a local correlation reference and labels the identity `PROVIDER_SNAPSHOT_ARN`; it does not use that digest as a delete selector.

The node-based APIs use Marker pagination; the Serverless APIs use NextToken pagination. The collector has separate exhausted-pagination implementations for both contracts. Empty continuation pages are followed, repeated or oversized continuation tokens fail closed, and page/request/item limits are shared across all node-based and Serverless queries.

## Identity and safety model

- The adapter uses ElastiCache Query API version `2015-02-02`, AWS SigV4-signed HTTPS POST, and a separate STS `GetCallerIdentity` check for every supplied account/region scope. The caller supplies credentials from the already-assumed, dedicated `FactoryOSElasticacheBackupReader` role; the API verifies the account and exact role name before any ElastiCache request.
- The only ElastiCache operations implemented are `DescribeCacheClusters`, `DescribeReplicationGroups`, `DescribeGlobalReplicationGroups`, `DescribeSnapshots`, `DescribeServerlessCaches`, and `DescribeServerlessCacheSnapshots`. No create, modify, failover, copy, export, restore or delete operation exists in this module.
- Deployment templates are in `deploy/aws/elasticache-redis-backup-inventory-reader-role-policy.template.json`, `deploy/aws/elasticache-redis-backup-inventory-reader-role-trust.template.json`, and `deploy/aws/elasticache-redis-backup-inventory-source-role-policy.template.json`.
- The reader policy allows only the six inventory Describe actions and explicitly denies every other action. The trust template binds the designated source role and a unique ExternalId. Replace placeholders under the cloud-owner process; independently review the final effective trust, permissions, boundary, SCP and session-policy interactions.
- Credentials and session tokens remain in memory and are never returned in inventory records, query receipts or logs.
- Raw resource descriptions, network endpoints, security-group identifiers, parameter values, ACLs, cache contents, backup payloads and object URLs are not captured.
- Responses are bounded to 4 MiB, request timeouts are bounded, pagination follows every continuation marker/token, repeated/oversized continuation values fail closed, and request/page/item limits are global across all supplied scopes. Empty continuation pages still consume the shared budget.
- STS account and assumed-role mismatches, AWS AccessDenied, malformed result containers, truncation, missing required generation timestamps, malformed/out-of-scope ARNs, and an unscanned Global Datastore region produce explicit blockers; they are not converted into empty success. A retained Serverless snapshot remains independently inventoryable by its provider ARN even when its source cache no longer appears in the live cache catalog.
- Each page receives a local SHA-256 receipt reference. It is not AWS-signed evidence, CloudTrail evidence or proof that the account's complete enabled-region list was supplied.

## Identity and completeness limitations

A node-based `DescribeSnapshots` record exposes a provider snapshot name and creation-time metadata, not an S3-style immutable version ID. The inventory creates an opaque correlation reference over partition, account, region, snapshot name and normalized create time. It labels that identity `SNAPSHOT_NAME_AND_CREATE_TIME`, preserves the source name separately, and never treats the digest as a provider-native immutable delete selector. Missing timestamps produce a blocker.

A Serverless snapshot exposes a provider ARN. The local `PROVIDER_SNAPSHOT_ARN` digest is a correlation reference only. The adapter does not invoke a delete API, and no deletion plan or authorization can be derived from an inventory read. Serverless cache metadata and snapshot expiration metadata are observed configuration/provider fields only; this code does not decide whether a backup is legally or operationally expired.

Node-based completeness and Serverless completeness are reported separately as `node_based_catalog_complete` and `serverless_catalog_complete`. Overall `status=COMPLETE` requires both catalogs to complete for every supplied, identity-verified scope without blockers. A denied or incomplete Serverless API does not erase a separately complete node-based result, but it makes the overall inventory PARTIAL. A COMPLETE result still means only that these two API families were exhausted for the explicitly supplied scopes; it does not prove all AWS accounts/regions or external copy classes were included.

## Explicitly uncovered surfaces

1. Self-managed Redis/Valkey AOF/RDB files, Redis rewrite output, container volumes, EBS snapshots, filesystem backups and volume-level backup chains.
2. Snapshot export/copy destinations, cross-account S3 exports, S3 object versions, AWS Backup-managed recovery points and copies, backup vaults, and external disaster-recovery destinations.
3. Backups retained by independent cache providers, replicas or downstream systems not represented by the supplied AWS account/region scopes.
4. A restore test, replication-lag measurement, Global Datastore failover rehearsal, durability proof, complete enabled-account/region discovery, legal retention decision, or whole-tenant erasure receipt.

Consequently, `whole_cache_backup_coverage_complete`, `provider_mutation_performed`, `delete_api_available`, and `deletion_authorized` are always false. The two API families do not enumerate the above copy classes. Do not infer whole-cache or whole-tenant erasure from this inventory.

## IAM permissions and provider facts

The role policy template allows exactly the six Describe actions above and explicitly denies other actions. AWS exposes Serverless cache and Serverless snapshot catalogs through distinct APIs, both using NextToken pagination. Snapshot records include a provider ARN, creation/expiry information and snapshot metadata; the Serverless cache catalog includes engine/version, status and snapshot-retention configuration.

- [ElastiCache snapshot and restore](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/backups.html)
- [DescribeSnapshots API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeSnapshots.html)
- [DescribeReplicationGroups API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeReplicationGroups.html)
- [DescribeGlobalReplicationGroups API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeGlobalReplicationGroups.html)
- [DescribeServerlessCaches API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeServerlessCaches.html)
- [DescribeServerlessCacheSnapshots API](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeServerlessCacheSnapshots.html)
- [Serverless cache snapshot data type](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_ServerlessCacheSnapshot.html)

## Tests and acceptance boundary

Focused suite: `services/api/src/saas/aws-elasticache-redis-backup-inventory.spec.ts`.

Mocked API tests cover signed query requests, per-scope STS identity validation, node cluster/replication/global-datastore/snapshot normalization, Serverless cache and snapshot normalization, Serverless NextToken pagination (including empty pages), repeated continuation markers/tokens, denied Serverless snapshot enumeration, missing snapshot generation timestamps, out-of-scope Global Datastore regions and shared request/page/item budget exhaustion.

These are mocked AWS responses only. The feature has not connected to an AWS account, created or assumed a live role, inspected production node-based or Serverless caches, executed a restore, checked real regional failover, or enumerated AOF/RDB/volume backups or copied recovery points. Provider activation remains blocked pending cloud-owner role provisioning, independent effective-policy review, complete account/region discovery, representative staging captures, a controlled restore and separately reviewed evidence for self-managed/copy-destination surfaces.

**Issue #298 remains OPEN. AS-137 / NFR-PROD-14 remain PARTIAL.** This inventory does not authorize deletion or change the tenant-erasure status.
