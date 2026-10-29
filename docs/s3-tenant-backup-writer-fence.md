# Tenant backup writer-fence ledger

**Status:** Application-side durable lifecycle and an S3 bucket-policy apply/read-back adapter are implemented in this branch. Provider activation, producer integration and actual-provider acceptance remain release blockers.

## Scope and lifecycle

This ledger protects one (tenant UUID, DATASET_CATEGORY) backup prefix. Each backup-producing process must register a unique operation ID and current writer epoch before any provider I/O, then finalize only after the provider outcome is known.

- DRAINING: persistently deny new application writer permits; reconcile in-flight writes.
- FENCING: all recorded application writes are terminal; install the provider-side deny policy.
- FENCED: persist provider policy reference, policy digest, and complete writer inventory digest/count.
- ERASING: permit only the reviewed exact-resource erasure execution.
- ERASURE_VERIFIED: require matching manifest evidence and zero residual copies.
- RECOVERY_REQUIRED: preserve the deny gate through ambiguous process/provider/ledger outcomes.
- RELEASED: records the reviewed release intent, tombstone replay and next writer epoch. The next epoch remains blocked until provider policy removal/read-back is confirmed and `provider_release_confirmed_at` is durably recorded.

The PostgreSQL tenant-row lock serializes writer-operation registration against fence creation. Triggers repeat the core checks for direct SQL writes, including rejecting a writer epoch that differs from the latest released fence generation. Migration 222 records both relations in the ownership-review ledger; the canonical PostgreSQL migration manifest and SQL contract cover drain blocking, provider evidence, zero-residual verification, independent release, epoch advancement, RLS and cross-tenant invisibility. Governance inventory and ownership-review records protect this evidence from generic tenant erasure.

### Application writer registration gate

The application-side `beginWriteOperation` gate requires the current independently accepted writer-principal inventory and rejects a producer ID that is absent from that snapshot. It then rechecks the exact snapshot revision/status under the tenant lock before recording the operation, preventing a stale snapshot check from authorizing a registration after the inventory changes. Regression tests cover missing inventory registration, an unreviewed producer, and a changed snapshot.

This check is an application allowlist, **not workload-identity authentication**. A caller that can impersonate an approved producer ID is not cryptographically bound to the provider principal here, and it does not stop external jobs or direct S3 credentials from bypassing the service. Complete real producer adoption, workload-identity binding and provider IAM coverage remain separate release blockers.

## Crash and ambiguity behavior

An upload with an unknown provider result stays ACTIVE. There is no TTL or automatic expiry that could let an erasure run overtake an object write that might still commit. DRAINING cannot advance while any operation is ACTIVE. Recovery requires a provider-backed attestation and a new inventory; the coordinator never removes a provider deny policy itself.

The S3 provider adapter installs an explicit bucket-policy Deny for `s3:PutObject`, `s3:ReplicateObject` and `s3:ReplicateDelete` against exactly `factoryos-backups/{tenant UUID}/{DATASET_CATEGORY}/*`, preserves unrelated policy statements, re-reads the policy after mutation, checks the full policy digest, and inventories unfinished multipart uploads. It uses separate policy credentials from the object-erasure credential. The coordinator advances to `FENCED` only after provider read-back succeeds, all application writer outcomes are terminal, multipart-upload inventory is empty, and reviewed writer-inventory evidence is supplied. Release planning records the expected policy digest durably before removing only the exact fence statement.

This is a provider-neutral S3 API integration, not proof that every S3-compatible provider implements bucket-policy semantics identically. Policy mutation remains disabled by default and requires explicit configuration plus an infrastructure-owner acknowledgement that this service is the exclusive bucket-policy writer. The controller cannot enforce exclusive ownership outside this service or perform a provider IAM/Access Point principal inventory. Real-provider policy semantics, account-level access points, replication/service principals, policy drift, race-free deployment ownership, and every producer identity must be reviewed and tested in staging. Therefore, the S3 BACKUP adapter remains fail-closed until those gates are independently accepted.

## Explicit blockers

The service is only the durable application-side coordinator. At this commit, the provider adapter exists but actual policy mutation is disabled unless `FACTORYOS_BACKUP_STORAGE_POLICY_CONTROLLER_ENABLED=true`, `FACTORYOS_BACKUP_STORAGE_POLICY_OWNERSHIP_ACKNOWLEDGED=true`, a matching `FACTORYOS_BACKUP_STORAGE_POLICY_CONFIG_REFERENCE` and separate policy credentials are provided. These settings are an operational assertion, not an independently verified lock on provider policy changes. The repository's backup-producing and out-of-process identities have not all been proven to use this coordinator. The S3 BACKUP adapter remains inactive by default. `isConfigured()` can pass only when the provider controller, the writer-inventory/ownership/staging/restore evidence references, versioning and Object Lock checks all pass; configured references are assertions and do not independently prove provider acceptance. The propagation runner now acquires/read-backs the fence before inventory and keeps it through verification. The runner does not auto-release it; independent tombstone replay, reviewer and next-epoch evidence are still required.

Before activation, prove and complete the remaining acceptance gates: exclusive bucket-policy ownership with real-provider read-back; full IAM/Access Point/replication and out-of-process writer-principal inventory; enforcement of operation/epoch permits by every actual producer; uncertain multipart/upload and delayed replication retry recovery; policy-drift detection; independent tombstone replay and restore-after-replay staging. The application runner now acquires/rechecks the fence before inventory and holds it through zero-residual verification, but these code-level checks do not independently prove every external writer is covered. AS-137 / NFR-PROD-14 remain PARTIAL until controlled real-provider evidence and all other copy classes are accepted.


## S3 bucket-policy control-plane contract

The implementation lives in `services/api/src/saas/s3-tenant-backup-writer-fence.provider.ts` and `s3-tenant-backup-writer-fence.coordinator.ts`.

- Install reads the current bucket policy, rejects a conflicting statement ID, re-reads before mutation to detect a changed policy, adds only a scoped explicit Deny, then re-reads and compares the complete canonical policy digest.
- It enumerates all incomplete multipart uploads for the exact tenant/category prefix after applying the Deny. Any residual multipart upload keeps the durable fence at `FENCING`; callers must reconcile it before proceeding to `FENCED`.
- Release previews the policy without its fence statement and stores that resulting digest in the durable release intent before removing the exact statement. Policy removal uses both the original and expected result digests, preserves unrelated statements and verifies read-back. A separate durable confirmation is recorded only after the provider reports the fence absent and the complete policy digest matches the planned result. New writer permits and new erasure fences remain blocked until this confirmation exists; a crash or uncertain removal/read-back therefore preserves the application gate as well as the provider Deny. Retry reconciliation is idempotent.
- The bucket policy must have a single controlled writer. The current S3 API has no compare-and-swap precondition for `PutBucketPolicy`; an infrastructure owner must ensure no out-of-band policy writer races this controller. The immediate before-write re-read is a race detector, not a substitute for exclusive ownership.
- The bucket-policy Deny blocks direct object writes (`s3:PutObject`), S3 object replication writes (`s3:ReplicateObject`) and replicated delete-marker writes (`s3:ReplicateDelete`) under the matching resource prefix. It does not abort multipart uploads, inventory provider IAM/access-point permissions, revoke credentials or prove actual provider enforcement until a real-provider staging check passes. A source replication job that retries after release still requires separate queue/drift reconciliation. The propagation runner now acquires and reads back the category fence before any target adapter inventory, then rechecks the bound writer inventory and provider policy before backup preparation/recovery, deletion, and verification. The fence is not automatically released when the run completes. The S3 BACKUP erasure adapter remains fail-closed unless current provider acceptance, reviewed writer inventory, and runtime configuration are valid; production use still requires independent real-provider evidence and complete external producer/principal coverage.


The current configuration assertion does not establish exclusivity by itself; only infrastructure ownership controls and real-provider staging can prove the deployment has no competing bucket-policy writers.


Keep BACKUP inactive by default. Missing provider-control-plane settings or any missing/invalid acceptance reference causes `isConfigured()` to return false. Do not set the acceptance gates until the infrastructure owner has reviewed real-provider staging and complete producer inventory; they are evidence references, not proof by themselves.


## Reviewed writer-principal inventory snapshots

Migration `223_saas_backup_writer_principal_inventory.sql` adds a tenant-scoped, versioned inventory ledger. Submit a snapshot through `POST /v2/saas/data-retention/backup-writer-inventories`, inspect the latest pending/accepted/rejected revision with `GET /v2/saas/data-retention/backup-writer-inventories/{categoryCode}/latest`, read the current accepted snapshot with `GET /v2/saas/data-retention/backup-writer-inventories/{categoryCode}/current`, and review a submission through `POST /v2/saas/data-retention/backup-writer-inventories/{snapshotId}/review`. Submission and review require the `saas.data_retention.write` and `saas.data_retention.approve` permissions respectively; the submitter cannot approve their own snapshot.

A snapshot lists producer ID, provider-principal reference, access-path class and a SHA-256 digest of the permission scope. Entry identity and snapshot content are immutable after submission. Review recomputes the canonical, sorted entry digest and count; use is blocked when the latest revision is pending/rejected or its stored count/digest does not match its entries. The coordinator fetches this reviewed database snapshot rather than accepting caller-supplied digest/count, binds the exact snapshot ID and checks that it has not changed across provider policy installation.

**Scope warning:** a reviewed snapshot is a human-attested inventory, not proof that the full AWS IAM/service-principal/access-point/replication writer population was discovered. It cannot independently discover external producers, prevent out-of-band credentials, or prove that all jobs observe the application epoch gate. Real-provider staging, policy-ownership controls and external producer reconciliation remain separate acceptance gates; `S3TenantBackupErasureAdapter.isConfigured()` remains fail-closed.
