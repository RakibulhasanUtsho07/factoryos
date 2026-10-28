# S3 Tenant Backup Version Erasure Adapter

**Status:** Version-level deletion primitive implemented and unit-tested; target activation is deliberately disabled until runtime writer-fence integration exists. Production/staging acceptance is not yet demonstrated.  
**Adapter:** \`BACKUP / s3.tenant-backup.v1\`  
**Release gate:** This adapter does not by itself close AS-137 / NFR-PROD-14.

## Supported boundary

The adapter is intended only for a dedicated S3-compatible archive bucket where every backup object is a tenant-exclusive copy and uses this exact key layout:

\`\`\`text
factoryos-backups/{tenant UUID}/{DATASET_CATEGORY}/{opaque backup object path}
\`\`\`

The selected categories are taken from the reviewed target. Every discovered object key must fall under exactly one of the requested tenant/category prefixes and conform to the opaque-key restrictions. A backup object containing multiple tenants is not eligible: the adapter cannot selectively erase one tenant from a monolithic dump.

The bucket must have **versioning enabled and Object Lock enabled**. The adapter fails closed if either state cannot be independently established. For each data version it retrieves and checks the provider legal-hold status, checks retention mode/expiry, and streams the persisted version bytes through SHA-256 before sealing the plan. Delete markers are included as separate identities so that their removal does not conceal older versions from the inventory.

## Execution contract

1. **Readiness:** \`FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE\` must exactly match the required target's reviewed configuration reference. Endpoint, bucket, region, and credentials are deployment-provided; production requires HTTPS. Secret values must be delivered through an approved secret manager/workload identity, never committed to repository files.
2. **Enumeration:** signed \`ListObjectVersions\` requests cover every requested category prefix and every page. Missing/repeated markers, unsupported key/version shapes, provider errors, or more than 20,000 versions fail closed. The adapter doesn't reinterpret a failed or partial listing as an empty archive.
3. **Retention protection:** each non-marker version must have a readable legal-hold and retention response. Active legal holds and unexpired provider-enforced retention block preparation. Unknown/malformed protection states also block the operation. Delete markers have no object body and are represented separately.
4. **Sealed plan:** the plan includes the exact key and version ID for each object version/delete marker, with a SHA-256 digest for every data version. The generic erasure service seals this manifest and persists delete-intent evidence before calling the adapter.
5. **Preflight:** before the first destructive call, the adapter re-enumerates the scope, checks every planned version still exists, rechecks retention/legal-hold state, and rehashes every planned data version. This avoids partially deleting a plan when a later resource was already changed or newly locked. Each data version is checked again immediately before its own deletion.
6. **Deletion:** \`DELETE ?versionId=...\` targets exact planned versions and markers, rather than inserting new delete markers. An absent resource during recovery is idempotently accounted for; provider failures block progress.
7. **Verification:** the generic service checks the returned manifest/count, then a fresh full version inventory is compared with the sealed scope. Any residual version/marker, including a late-arriving version, prevents whole-request verification.

The adapter-generated \`s3-backup-version-delete.*\` reference is a correlation identifier; it is **not** a provider-issued, signed per-object deletion receipt.

## Bounds and configuration

- Page size: 1,000 versions; maximum total plan: 20,000 versions.
- Database manifest batch size: 250 identities.
- Content digest is streamed, not buffered as a whole file. The maximum per object is \`FACTORYOS_BACKUP_STORAGE_MAX_OBJECT_BYTES\`, default 1 GiB and capped at 5 GiB; request timeout is bounded to 1–30 seconds.
- The adapter accepts only the exact category allowlist from the common transfer-category enum and the exact reviewed target/config binding.
- Key references and version IDs must fit the repository's resource-ledger constraints. Unsupported provider IDs fail closed instead of being truncated or normalized.
- Object Lock retention checks are provider-specific APIs. A provider that does not implement the required versioning, Object Lock, legal-hold, retention, listing, version-read and exact-version-delete behavior cannot be activated.

## Tests and limits

\`s3-tenant-backup-erasure.adapter.spec.ts\` simulates tenant-scoped multi-version archives, delete markers, content mutation, late-arriving residual versions, active legal holds, unexpired retention, unavailable inventory and unsupported configuration. These tests verify the adapter contract only; they are not a live S3 provider certification.

This adapter **does not** erase or verify copies outside the configured bucket/keyspace. It does not cover monolithic database dumps, PostgreSQL base backups or WAL/PITR archives, Redis AOF/RDB files, filesystem/block-volume snapshots, provider-managed backup vaults, replicas/failover regions, immutable external copies, or backups whose contents are not tenant-exclusive. Those copy classes require their own enumerator, retention semantics, deletion method, independent verification and controlled acceptance.

Do not activate a required production BACKUP target until the exact provider and deployed bucket have passed controlled staging acceptance with synthetic data, including Object Lock API behavior, versioned deletion, pagination failures, late writes, legal holds, expiry and residual verification. Keep AS-137 / NFR-PROD-14 **PARTIAL** until all remaining copy classes and release gates are accepted.


## Required writer-fence control (not yet implemented by this adapter)

S3 Object Lock protects already-written object versions; it does not stop an authorized backup producer from creating a new version while or after an erasure is running. The adapter's fresh post-delete inventory catches versions created before that inventory, but cannot prevent a write made after the final scan and before the request's terminal state is committed.

Therefore, **the adapter's `isConfigured()` intentionally returns false, so the API cannot activate the BACKUP target until a provider/control-plane write-freeze mechanism is implemented and verified for every writer to the selected tenant/category prefixes**. The freeze must be acquired before the authoritative inventory, remain held through delete/independent verification and durable completion, and have a reviewed recovery path for process crashes. A manual pause or a configuration flag is not a machine-verifiable fence by itself. If the deployment cannot prove this control for every producer identity, do not activate or use this adapter for a production whole-tenant erasure. The missing runtime fence integration remains a release gap and AS-137 / NFR-PROD-14 remain PARTIAL.


The durable application-side lifecycle contract is documented in [the tenant backup writer-fence ledger](s3-tenant-backup-writer-fence.md). This ledger blocks new in-repository writer permits and preserves unresolved upload operations across a crash; it does not replace provider-level bucket-policy enforcement or a complete producer identity inventory. The adapter remains fail-closed until provider-control-plane enforcement, every backup producer, writer-generation rotation and restore/tombstone replay are integrated and independently accepted.
