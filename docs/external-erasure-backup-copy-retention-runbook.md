# External Erasure: Backup and Historical-Copy Retention Runbook

**Status:** Operational acceptance contract; not a record of a completed production purge.  
**Release gate:** AS-137 / NFR-PROD-14 remains **PARTIAL** until every required copy class has a reviewed adapter or provider procedure, approved retention policy, and controlled staging evidence.

## Purpose and boundary

The live-keyspace erasure adapters do not prove that historical or secondary copies have been removed. In particular, Redis `BGREWRITEAOF` only addresses the current AOF file after the adapter deletes its planned keys; it is not evidence that AOF backups, RDB files, volume snapshots, replicas, point-in-time recovery archives, or exported copies have been purged. Likewise, deleting an object from the configured WMS POD bucket does not by itself prove that provider-managed snapshots or other systems no longer contain it.

This runbook governs discovery, retention decisions, deletion, verification, and evidence for historical and secondary copies. It does not authorize changing legal retention policy, bypassing a legal hold, or claiming provider behavior that has not been independently established.

## Copy inventory

Before enabling a store/category target for production erasure, the data owner and infrastructure owner must map the data lineage and enumerate applicable copy classes. The inventory must explicitly assess:

1. **Redis persistence:** current AOF, AOF rewrite/temp files, retained AOF backups, RDB snapshots, managed-service backups, point-in-time recovery archives, and any copied persistence files.
2. **Infrastructure copies:** filesystem snapshots, block-volume snapshots, disk images, crash-consistent copies, immutable/WORM snapshots, backup vault copies, and disaster-recovery copies.
3. **Replication and failover:** replicas, read replicas, replica snapshots, failover nodes, standby regions, and any service-managed copies not visible in the primary adapter.
4. **Object storage:** object versions, delete markers, versioned buckets, lifecycle archives, replication targets, backup buckets, and exported/downloaded artifacts.
5. **Other tenant-derived stores:** legacy/external caches, search indexes, vector stores, learning artifacts, external providers, analytics/materialized views, and copies owned by downstream processors.
6. **Operational exports:** temporary exports, restore-test data, staging fixtures derived from real data, and administrator-created copies. Synthetic CI fixtures must be identified separately from customer data.

Do not assume a class is absent merely because it is not returned by the live-store adapter. For every class, record one of: supported and enumerated; explicitly not applicable with evidence; or unresolved/unsupported. An unresolved or unenumerated class blocks a whole-tenant **VERIFIED** outcome.

Each copy identity should use a stable opaque provider/resource locator plus an immutable version, snapshot, generation, or backup identifier where available. Record the tenant/request binding, data category, provider and account/region boundary, copy class, policy version, creation/expiry metadata, legal-hold disposition, responsible owner, adapter/procedure version, and evidence reference. Do not put credentials, connection strings, tokens, raw customer payloads, or encryption keys into manifests, logs, tickets, or evidence packs.

## Legal holds and retention policy

- A designated legal/compliance owner must approve the legal basis, jurisdiction, minimum/maximum retention, expiry trigger, deletion method, exception process, and policy version for each copy class before production enforcement.
- Do **not** invent a universal retention duration. A missing, ambiguous, or unapproved policy means the copy cannot be automatically deleted or declared expired.
- A matching active legal hold takes precedence over routine erasure for the categories and copies it covers. Mark the specific copy as retained/blocked with a reason and review reference; keep the request incomplete and escalate the overlap. Do not remove or narrow a hold merely to make an erasure pass.
- If an immutable backup cannot be selectively purged, follow the approved provider-specific retention/cryptographic-erasure policy. Record the enforced expiry and scope, restrict restore/use as policy permits, and schedule a fresh inventory and verification after expiry. Do not treat “will expire later” as “deleted now.”
- Before any restore or disaster-recovery operation, determine whether it can reintroduce erased tenant data. A restore process must reapply the applicable erasure/tombstone ledger before the restored environment can serve tenant traffic. Capture evidence that this control ran successfully.
- Retention policy changes do not retroactively rewrite completed evidence. Preserve the policy version and approval that governed each decision.

## Execution procedure

### 1. Bind the request and freeze the copy set

Verify the authorized tenant, erasure request/version, requested categories, source-export digest, active legal holds, and the policy version. Establish an immutable run ID and a controlled execution window. Do not derive the tenant scope from a user-supplied provider locator alone.

Enumerate all copies under the approved scope, including all pages and regions. Reconcile provider inventory totals and pagination/completeness indicators. If enumeration is partial, access is denied, a required region is unreachable, a provider's semantics are unknown, or the identity set changes unexpectedly, stop destructive execution and record the unresolved condition.

### 2. Seal the plan before mutation

Persist the exact resource identities, stable version/generation references, applicable content digests, policy versions, and planned-copy count before any deletion call. Use the resource-level ledger and append-only transitions defined by [the external-erasure resource ledger](external-erasure-resource-ledger.md). Never silently widen a sealed plan during retry; a newly discovered copy requires a separately reviewed plan/attempt bound to the same approved request or a new request version as appropriate.

### 3. Apply the approved retention disposition

For each planned copy, choose one of these evidence-backed outcomes:

- **Delete now:** policy authorizes deletion, no applicable hold prevents it, the provider supports a reviewed and tenant-safe operation, and the resource is within the sealed plan.
- **Retain/blocked:** a legal hold, mandatory retention, immutable lock, provider restriction, or unresolved ownership prevents deletion. Record a precise reason and next review/expiry trigger. The request remains incomplete.
- **Unsupported/unresolved:** the provider or copy class cannot be fully enumerated or safely mutated. Fail closed; do not substitute a best-effort primary-only deletion and call it whole-store erasure.
- **Retryable failure:** preserve the request fence and the sealed identities; recover the same plan. Do not remove a cache fence or invent success receipts to restore normal writes.

Use provider-supported deletion/expiry controls and the least-privileged identity that can perform the reviewed task. Do not disable immutability, replication, audit logging, or retention safeguards outside an explicitly approved policy procedure.

### 4. Verify independently

After deletion, query the provider through an independent read/list path and enumerate the complete relevant boundary again (including regions, versions, backup catalogues, replicas, or vault copies where applicable). Compare observed residual identities/counts and copy digests with the sealed manifest. Verify the expected expiry/deletion status against provider semantics; an accepted API request alone is insufficient.

Record provider-issued receipts only when the provider actually supplies them. Adapter-generated correlation identifiers are not provider-issued receipts. If the provider exposes no signed receipt, record the exact API outcome, timestamp, resource/version identity, response classification, and independent read-back evidence, and label the proof type accurately.

A zero-residual result from the primary cache or object store proves only that enumerated boundary. It does not establish historical-backup purge unless those backup systems were separately inventoried and verified. Any residual, inaccessible copy, ambiguous version, failed independent check, or unsupported class prevents a whole-request **VERIFIED** result.

### 5. Restore and expiry re-checks

For retention-locked or time-based copies, maintain a due review keyed by the approved expiry timestamp and policy version. After the expiry/deletion window, perform a new provider inventory and independent absence check. If the provider retains the copy longer than expected, escalate and keep the result incomplete. Where a backup is restored, run and evidence the erasure replay/tombstone reconciliation before reopening tenant access.

## Required evidence pack

Retain a tenant-scoped, access-controlled evidence pack containing:

- Request/version/run ID and authorized categories; approval and legal-hold decision references.
- Approved retention-policy identifier/version and owner sign-off; never raw secrets.
- Copy-class inventory, provider/account/region boundary, enumeration timestamps, pagination/completeness evidence, and any documented not-applicable decisions.
- Sealed manifest digest, planned count, opaque resource/version identifiers, optional SHA-256 content digests, and adapter/procedure version.
- Per-copy intent and outcome, retry/exception reason, provider receipt type, independent verification result, residual count/list digest, expiry follow-up date, and actor/system identity.
- Evidence of restore reconciliation and any provider escalation or policy exception.

Keep the manifest and audit trail protected from generic tenant-data erasure in accordance with the external-erasure resource ledger. Evidence should be sufficient for independent review without reproducing deleted customer content.

## Supported adapter boundary

At the current PR scope, the registered S3-compatible POD adapter covers only WMS POD evidence objects in the configured unversioned bucket. The registered BACKUP adapter provides a version-level S3 primitive for exact object versions and delete markers in a separate, tenant/category-exclusive S3-compatible archive under `factoryos-backups/{tenant UUID}/{DATASET_CATEGORY}/...`; it requires versioning and Object Lock to be enabled, inventories every version, checks each live version's provider legal-hold/retention state, hashes its persisted bytes, deletes explicit version IDs, and performs a fresh version inventory. Its `isConfigured()` deliberately returns false, so API target activation and propagation remain blocked until a runtime writer-fence coordinator is implemented. Its plan is bounded to 20,000 versions and the configured per-object streaming digest limit. See [the S3 tenant backup adapter contract](s3-tenant-backup-erasure-adapter.md). This is not an adapter for monolithic database dumps, PostgreSQL backup/PITR archives, RDB/AOF files, filesystem/volume snapshots, replicas, managed backup vaults, or other disaster-recovery copies. The Redis adapter covers only the new `TenantCacheService` namespace on a standalone primary with no replicas/cluster and reviewed AOF/noeviction settings. Its post-delete AOF rewrite is not a purge of separately retained AOF backups, filesystem or volume snapshots, backup vaults, or media copies.

The following required store classes still need complete reviewed, configured adapter/provider procedures and acceptance evidence before closure: `SEARCH_INDEX`, `VECTOR_STORE`, `LEARNING_ARTIFACT`, `EXTERNAL_PROVIDER`, and `REPLICA`, plus any legacy/external cache not proven to use the reviewed tenant-cache namespace. The `BACKUP` class has a partial S3 version-level primitive, but is **not production-accepted**: a provider/control-plane write-freeze for every backup writer is not implemented/verified here, and database/PITR backups, Redis persistence copies, filesystem/volume snapshots, backup vaults and DR copies remain outside the adapter. Do not register a required target as production-ready simply because a generic interface or synthetic test exists.

## Go-live checklist

- [ ] Data owner maps every required copy class and records evidence for any not-applicable class.
- [ ] Legal/compliance owner approves copy-class retention policy and hold handling; no duration is inferred by engineering.
- [ ] Infrastructure/provider owner verifies enumeration, expiry, versioning, replica, snapshot, restore and deletion semantics for the exact deployed configuration.
- [ ] Secret manager and production configuration are reviewed; evidence packs contain no credentials.
- [ ] The complete sealed-plan/delete/independent-verify flow passes against controlled staging with synthetic data and the actual provisioned topology.
- [ ] Failure-injection covers inaccessible inventories, active legal holds, immutable backups, partial pagination, provider errors, residual copies, retries, and restore/tombstone reconciliation.
- [ ] A reviewer confirms that no unsupported or retained copy is reported as deleted, and that all residual/expiry follow-ups have owners.
- [ ] Production rollout is separately approved. CI success alone is not production acceptance.

Until these criteria and all required external-store adapters pass, AS-137 / NFR-PROD-14 must remain **PARTIAL**. This document defines the operational bar; it does not assert that production secrets, provider backups, customer copies, or controlled staging have already been tested or erased.


### Additional release block: concurrent backup writers

The S3 tenant backup adapter does not itself pause external writers. Object Lock does not prevent a new object version from being created, and a post-delete inventory cannot prevent a write after its final scan. Before production acceptance, integrate and test a provider/control-plane fence that excludes **all** backup writer identities for the selected tenant/category scope from before enumeration through durable completion. The fence must survive process failure and have a reviewed recovery flow. A manual pause or static environment flag is not equivalent to a runtime fence. Until this exists, the S3 BACKUP adapter remains a tested primitive, not a production whole-tenant erasure capability.
