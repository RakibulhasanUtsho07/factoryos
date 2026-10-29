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

## Machine-enforced copy-class coverage

Every requested category must have a current, independently reviewed decision for each required store kind: `OBJECT_STORAGE`, `CACHE`, `SEARCH_INDEX`, `VECTOR_STORE`, `LEARNING_ARTIFACT`, `EXTERNAL_PROVIDER`, `REPLICA`, and `BACKUP`. Submit evidence through `POST /v2/saas/data-retention/external-copy-coverage`, inspect the current category matrix through `GET /v2/saas/data-retention/external-copy-coverage/:categoryCode/current`, and review via `POST /v2/saas/data-retention/external-copy-coverage/:decisionId/review`.

Each decision is revisioned, tenant-scoped, idempotent, digest-bound, and immutable after independent review. Evidence must be no more than 30 days old at submission and approval; accepted decisions expire within 90 days. `SUPPORTED` requires a current active required target/adapter. Every registered target whose categories overlap the erasure request must be active and marked required; an optional or inactive matching target blocks `VERIFIED` rather than being silently ignored. `NOT_APPLICABLE` is consistent only when no category-matching target is registered and must still have evidence plus data-owner, infrastructure-owner and policy references. `UNRESOLVED`, missing, pending, rejected, expired, tampered or contradictory decisions block erasure.

A database-level run fence takes the tenant lock and rejects inserts/updates/deletes to the coverage registry or required-target inventory while any propagation run is `RUNNING`. This closes the check-then-mutate window between an application-side recheck and a provider call; once the run is `PARTIAL` or terminal, reviewers can submit a new revision.

The accepted category/store-kind decisions and target bindings are included in the propagation manifest digest. The service rechecks coverage before adapter preparation/recovery, before mutation, before verification and during finalization under the tenant governance lock. A changed review revision or target inventory blocks additional mutation and prevents a run from reaching `VERIFIED`; a separately reviewed run is required. Human review of a reference/digest is a governance gate, not automatic authentication of source evidence.

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

At the current PR scope, the registered S3-compatible POD adapter covers only WMS POD evidence objects in the configured unversioned bucket. The registered BACKUP adapter provides a version-level S3 primitive for exact object versions and delete markers in a separate, tenant/category-exclusive S3-compatible archive under `factoryos-backups/{tenant UUID}/{DATASET_CATEGORY}/...`; it requires versioning and Object Lock to be enabled, inventories every version, checks each live version's provider legal-hold/retention state, hashes its persisted bytes, deletes explicit version IDs, and performs a fresh version inventory. Its `isConfigured()` remains fail-closed unless the durable writer-fence coordinator, reviewed writer inventory, and current provider-acceptance gates are valid. The propagation runner now acquires and reads back the fence before any target adapter inventory, and keeps it held through verification; production activation remains blocked until the acceptance records are backed by independently reviewed real-provider evidence and the complete external producer/principal set is covered. Its plan is bounded to 20,000 versions and the configured per-object streaming digest limit. See [the S3 tenant backup adapter contract](s3-tenant-backup-erasure-adapter.md). This is not an adapter for monolithic database dumps, PostgreSQL backup/PITR archives, RDB/AOF files, filesystem/volume snapshots, replicas, managed backup vaults, or other disaster-recovery copies. The Redis adapter covers only the new `TenantCacheService` namespace on a standalone primary with no replicas/cluster and reviewed AOF/noeviction settings. Its post-delete AOF rewrite is not a purge of separately retained AOF backups, filesystem or volume snapshots, backup vaults, or media copies.

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


### Durable application-side backup writer-fence ledger

Migration 222 and SaasTenantBackupWriterFenceService define tenant/category-scoped operation intents and a persistent lifecycle (DRAINING → FENCING → FENCED → ERASING → ERASURE_VERIFIED → RELEASED, with RECOVERY_REQUIRED for uncertainty). An ambiguous provider write remains active; no TTL automatically lets erasure overtake it. SQL triggers and RLS protect the fence and operation ledgers, and release evidence must include an independently reviewed tombstone-reconciled next writer epoch.

The durable ledger/state-machine, S3 bucket-policy apply/read-back provider, reviewed writer-inventory/acceptance registries, and propagation-runner acquisition checks are implemented in the current PR branch. They do not by themselves prove that every direct S3 credential, scheduled job, source replication identity, access point, or external backup system is covered. Independent real-provider staging, exclusive bucket-policy ownership, complete external writer/principal coverage, provider-backed recovery, delayed-retry reconciliation, and restore/tombstone replay remain open. Keep the S3 BACKUP target inactive until those gates have reviewed evidence.


### S3 bucket-policy writer-fence provider

The S3 control-plane adapter `S3TenantBackupWriterFenceProvider` applies a least-scope explicit `Deny` for `s3:PutObject`, `s3:ReplicateObject` and `s3:ReplicateDelete` under only the requested tenant/category prefix. Object replication and replicated delete-marker operations use distinct permissions, so all three actions are explicitly denied. It uses separate policy credentials; it does not reuse the object-erasure credential. It reads the existing bucket policy, preserves unrelated statements, detects policy changes on a second read before mutation, applies the policy, then performs an independent read-back and validates the complete canonical policy digest.

The post-apply read inventories unfinished multipart uploads under that prefix. A non-zero inventory means the policy may already be denying new writes, but the durable fence must remain at `FENCING`; reconcile the outstanding upload outcomes and retry before recording `FENCED`. Do not manually delete multipart state or bypass provider retention/legal-hold controls as an operational shortcut.

Before using this controller, the infrastructure owner must explicitly acknowledge that it is the exclusive bucket-policy writer for the bucket. `PutBucketPolicy` does not provide a compare-and-swap precondition; any out-of-band policy writer can race a read-modify-write operation. The API's second read catches some races but cannot establish exclusivity by itself. Use a separate least-privilege policy credential and matching reviewed config reference. Controller mutation is disabled by default in `.env.example`.

Release is deliberately ordered as: preview the exact policy with the fence statement removed; commit that policy digest, independent review and next writer epoch to the durable lifecycle; then remove only the matching statement; read back the final policy and verify the digest. If the process crashes after the durable release but before policy removal, retry reconciliation. The policy remaining installed causes temporary write unavailability, not an erasure race. Any unplanned policy digest, altered statement or failed read-back blocks the operation.

Important limitations remain: the adapter does not enumerate IAM users/roles, S3 Access Points, replication/service principals or out-of-process identities and cannot establish that every producer uses the application gate by itself. BACKUP remains inactive by default; it can pass `isConfigured()` only when every explicit acceptance gate is supplied. These references are operator assertions, not independent evidence. Real-provider staging must prove deny behavior for normal PutObject, CopyObject, multipart completion and replication/delete-marker paths, verify restore/tombstone replay and demonstrate that stale writer generations cannot recreate erased copies before production activation. The propagation runner acquires and reads back the fence before inventory and does not release it automatically; a separately reviewed release reconciler is still required.
