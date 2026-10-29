# S3 backup provider acceptance registry

**Purpose:** Persist independently reviewed, provider-scope-bound staging evidence before any BACKUP erasure adapter can report itself configured. This registry is a governance gate, not provider discovery and not proof that an evidence artifact is genuine by itself.

## Required scenario matrix

Every submitted revision contains one immutable result and SHA-256 digest for each scenario below:

1. **POLICY_DENY_READBACK** — policy Deny is installed and independently read back.
2. **COPY_OBJECT_DURING_FENCE** — copy operations cannot reintroduce data into the fenced scope.
3. **MULTIPART_COMPLETION_DURING_FENCE** — pending multipart completion cannot publish a late object.
4. **REPLICATION_DELETE_MARKER** — replication and replicated delete-marker behavior are demonstrated.
5. **POLICY_DRIFT_DETECTED** — unexpected policy mutation is detected and leaves deletion blocked.
6. **CRASH_RECOVERY_DENY_PRESERVED** — crash/ambiguous provider outcomes preserve the deny.
7. **DELAYED_WRITER_REJECTED** — a delayed or retried producer cannot write after the fence.
8. **TOMBSTONE_REPLAY_BEFORE_RELEASE** — tombstones are replayed before a new writer epoch is released.
9. **INDEPENDENT_RESIDUAL_LISTING** — a separate read/list path confirms zero residual versions and delete markers.
10. **RESTORE_AFTER_TOMBSTONE_REPLAY** — restore/DR paths do not resurrect an erased copy.

All ten must be **PASS**; **FAIL** or **NOT_RUN** evidence is retained but cannot be approved. Evidence must have a safe opaque reference, a lowercase SHA-256 digest, an explicit runner identity reference, and an execution time no more than 30 days old at submission and approval. No secret, credential, signed URL, or raw access key belongs in the registry.

## Scope and lifecycle

The API captures the deployment-configured provider reference, provider-scope reference, configuration reference, adapter key/version and a digest over those exact values. The provider-scope reference must uniquely identify the provider account/project, region and dedicated bucket/container scope, without embedding credentials. Never re-use a scope reference for a different provider bucket or account.

Submitters need saas.data_retention.write. Approval/rejection and revocation need saas.data_retention.approve; a submitter cannot approve their own record. Only the latest revision for a tenant/category/provider scope can be reviewed. Accepted records expire after 90 days. Revocation is stored separately as an append-only fact and immediately causes runtime checks to fail.

Routes:
- POST /v2/saas/data-retention/backup-provider-acceptances
- GET /v2/saas/data-retention/backup-provider-acceptances/:categoryCode/latest
- GET /v2/saas/data-retention/backup-provider-acceptances/:categoryCode/current
- POST /v2/saas/data-retention/backup-provider-acceptances/:acceptanceId/review
- POST /v2/saas/data-retention/backup-provider-acceptances/:acceptanceId/revoke

## Runtime behavior and limitations

The S3 adapter checks the current accepted record during preflight and again before prepare, mutation and verification. It checks the evidence digest, all ten PASS outcomes, expiry, revocation, adapter version and exact configured scope. Missing settings, stale revisions, a newer pending/rejected record, changed scope, expiry, digest mismatch or revocation all keep the adapter inactive.

This does **not** perform IAM/Access Point discovery, prove exclusive bucket-policy ownership, provision workload identity, validate a compliance retention policy, or cover database WAL/PITR, Redis AOF/RDB, snapshots, backup vaults, replicas, external DR, search indexes, vector stores, learning artifacts or external caches. Human reviewers must validate the actual provider evidence in its source system; opaque references alone are not proof. Real-provider staging and the broader AS-137 / NFR-PROD-14 checklist remain mandatory. Do not promote the PR or mark those requirements PASS solely because CI passes.
