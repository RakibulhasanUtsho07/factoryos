# Tenant backup writer-fence ledger

**Status:** Application-side durable lifecycle is implemented in this branch. Provider-wide enforcement and producer integration remain release blockers.

## Scope and lifecycle

This ledger protects one (tenant UUID, DATASET_CATEGORY) backup prefix. Each backup-producing process must register a unique operation ID and current writer epoch before any provider I/O, then finalize only after the provider outcome is known.

- DRAINING: persistently deny new application writer permits; reconcile in-flight writes.
- FENCING: all recorded application writes are terminal; install the provider-side deny policy.
- FENCED: persist provider policy reference, policy digest, and complete writer inventory digest/count.
- ERASING: permit only the reviewed exact-resource erasure execution.
- ERASURE_VERIFIED: require matching manifest evidence and zero residual copies.
- RECOVERY_REQUIRED: preserve the deny gate through ambiguous process/provider/ledger outcomes.
- RELEASED: after independent review, provider release evidence, restore/tombstone replay and next writer epoch are recorded.

The PostgreSQL tenant-row lock serializes writer-operation registration against fence creation. Triggers repeat the core checks for direct SQL writes, including rejecting a writer epoch that differs from the latest released fence generation. Migration 222 records both relations in the ownership-review ledger; the canonical PostgreSQL migration manifest and SQL contract cover drain blocking, provider evidence, zero-residual verification, independent release, epoch advancement, RLS and cross-tenant invisibility. Governance inventory and ownership-review records protect this evidence from generic tenant erasure.

## Crash and ambiguity behavior

An upload with an unknown provider result stays ACTIVE. There is no TTL or automatic expiry that could let an erasure run overtake an object write that might still commit. DRAINING cannot advance while any operation is ACTIVE. Recovery requires a provider-backed attestation and a new inventory; the coordinator never removes a provider deny policy itself.

The provider controller must modify only its reviewed scope, read the policy back, inventory all principals and automated jobs that can write backup objects, and prove that stale writer generations cannot recreate erased data. This service accepts evidence records but does not independently authenticate a provider's policy response. Therefore, the S3 BACKUP adapter remains fail-closed until the provider controller and every producer are integrated and independently accepted.

## Explicit blockers

The service is only the durable application-side coordinator. At this commit, no provider control-plane adapter that applies and independently reads back the S3 write freeze is integrated, and the repository's backup-producing and out-of-process identities have not been proven to use this coordinator. The S3 BACKUP adapter must continue to return false from isConfigured(), fail-closed.

Before activation, integrate: least-privilege provider policy application/read-back; complete writer-principal inventory; every in-process and external producer operation/epoch gate; uncertain multipart/upload recovery; policy drift detection; tombstone replay; stale-generation rejection; controlled real-provider staging. AS-137 / NFR-PROD-14 remain PARTIAL until this and all other copy classes are accepted.
