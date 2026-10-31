# Production Backup, Restore and Disaster-Recovery Rehearsal

**Classification:** P0 release gate  
**Status:** repository workflow and isolated CI rehearsal are implemented; a production rehearsal remains an operator-run activity against explicitly approved infrastructure.

This runbook does not certify production DR by itself. A green CI run proves the tested workflow and synthetic PostgreSQL fixtures operated in an ephemeral environment; it does not prove the freshness of a real production backup, production storage/key custody, actual service recovery, or an owner-approved service objective.

## Release gate evidence

The rehearsal must preserve evidence for the exact candidate commit SHA:

- encrypted custom-format backup artifact location, SHA-256 checksum result and GPG encryption/readability checks;
- source and restore database identities and explicit confirmation that the restore target was empty before restore;
- PostgreSQL server, `pg_dump`, `pg_restore`, and GPG versions;
- backup and restore/smoke durations, source and restored durable-write watermarks, event/cutoff time, and observed RPO/RTO;
- exact ordered candidate migration manifest and SHA-256, number of migrations applied, migration output, and deliberate failed-transaction recovery result;
- application smoke, tenant-isolation negative test, and audit-continuity result;
- separate operator and approver identities, approval/change reference, decision, notes, and a digest of the immutable technical receipt.

Never put a backup archive, customer rows, database passwords, PGPASSFILE, private key or raw sensitive logs into a Git commit, PR comment or general CI artifact. Keep the encrypted artifact and authoritative evidence in approved restricted storage with access logs. The JSON technical receipt intentionally records a path and evidence digests, not database contents; it is not a replacement for the controlled change record.

## 1. Required recovery runner configuration

The manual workflow is `.github/workflows/production-dr-rehearsal.yml`. It is deliberately limited to a self-hosted Linux runner with labels `self-hosted`, `linux`, and `dr-isolated`, plus the GitHub environment `production-dr-rehearsal`.

Before enabling the workflow:

1. Provision an isolated recovery runner with PostgreSQL client tools, GnuPG, Bash, Node.js 24, core shell utilities, and access to approved restricted backup/evidence storage. Restrict outbound network access to the approved source/restore database, storage endpoint, GitHub Actions/check-out endpoints and the approved package registry needed to install/build the exact candidate; do not permit general data-plane access.
2. Configure protected runner variables `FACTORYOS_DR_PGSERVICEFILE_PATH`, `FACTORYOS_DR_PGPASSFILE_PATH`, and `FACTORYOS_DR_GNUPGHOME_PATH`. The service and pass files must be runner-local, readable only by the runner identity (mode `0600` or `0400`); the GPG keyring must contain the approved recovery recipient/key. Do not commit their contents.
3. Configure the protected environment secret `FACTORYOS_DR_APPLICATION_DATABASE_URL` with a low-privilege application-role URL for the **restore target**, never production. After SQL smoke, the helper compares this connection's database name/server address/port with the admin restore service identity, builds/runs the exact candidate API, and probes `/api/health/live` and `/api/health/ready`. The database role must be able to connect and query `SELECT 1`; the helper supplies a temporary random JWT secret, disables the outbox dispatcher, prints no URL, and never issues a token.
4. Configure the `production-dr-rehearsal` GitHub Environment with required reviewers/approval rules and restrict who may start the workflow. The operator identity is bound to the GitHub dispatcher; the approver name must match the independently recorded environment/change approval. The environment approval audit event is the authoritative approval record.
5. Create separate libpq source and restore service entries. Verify the restore entry points to a disposable isolated database, not production and not another tenant/customer. The workflow requires a separate service name; the script independently compares database name, server address and port, and refuses a non-empty user schema. A different service label alone is not proof of isolation.
6. Use a reviewed read-only smoke SQL file that checks schema readiness and representative application state; proves tenant-specific reads and a denied cross-tenant write using the application role/RLS; and verifies that audit events created before backup remain after restore. The release gate separately launches the candidate API and validates liveness/readiness against the restored target through the protected application URL. Use a reviewed durable-write watermark query that returns exactly one UTC RFC 3339 timestamp. Do not use `NOW()` alone as a watermark—it measures the query time, not the last durable business write.

## 2. Run the production workflow

Dispatch `Production Backup Restore and DR Rehearsal` for a **full 40-character candidate SHA**. Supply preconfigured source and isolated restore service names, absolute encrypted-backup and evidence paths on the approved runner, the approved GPG recipient, the candidate's ordered pending migration-manifest path, reviewed watermark SQL and smoke SQL paths, and a UTC incident/cutoff timestamp. Explicitly confirm the restore target is isolated, disposable and empty.

The script rejects missing configuration, identical source/target identities, non-empty targets, plaintext-style output extensions, overwritten backup/evidence paths, malformed or duplicate migration entries, and invalid timestamps. It requires a built candidate API and protected low-privilege application DB URL before starting in release-gate mode. It creates a mode-restricted temporary directory, encrypts a custom-format `pg_dump` through GPG, computes and verifies the SHA-256 checksum, decrypts the archive only into the private temporary directory to check archive readability, restores using `--exit-on-error --single-transaction`, and retains logs while removing temporary plaintext on exit. It does not drop/clean an unsuccessful target automatically; quarantine it and follow the incident plan.

### Candidate migration validation

The production workflow uses `FACTORYOS_MIGRATION_MANIFEST_MODE=PENDING`. After restoring the source snapshot, the script reads `schema_migrations`, derives the exact pending list from `scripts/audit/migration-manifest.txt` in the checked-out candidate, and compares that ordered list byte-for-byte (ignoring blank/comment lines) with the operator-supplied candidate manifest. A missing, extra, already-applied, reordered or duplicated candidate entry fails closed. The canonical inventory verifier must also pass. The candidates are applied only to the isolated restore, before the smoke tests.

The PostgreSQL CI workflow has a separate `IDEMPOTENT_REPLAY` mode that re-applies only the repository's explicitly listed late migrations already recorded in `schema_migrations`. This is an idempotency check for CI, not an acceptable production pending-migration manifest and not proof that every migration is safe to replay. The script's deliberate division-by-zero probe demonstrates transactional rollback of the fixture DDL/DML only; inspect each real migration's locking, transactionality, irreversible changes and external effects, and pre-approve its forward-fix/restore decision.

### Restore-time tenant-erasure tombstone replay

A database snapshot can predate a tenant erasure that completed after that snapshot. Restoring the database without replaying the authoritative erasure/tombstone ledger can therefore reintroduce tenant data. In `RELEASE_GATE` mode, the rehearsal now runs the reviewed replay procedure against the isolated restore target **after candidate migrations and before schema smoke, application smoke, or API readiness**. A replay failure leaves the target quarantined and prevents technical PASS.

Configure these protected `production-dr-rehearsal` Environment variables on the approved recovery runner:

- `FACTORYOS_DR_ERASURE_REPLAY_SQL_PATH`: absolute path to a reviewed, idempotent SQL replay script.
- `FACTORYOS_DR_ERASURE_VERIFY_SQL_PATH`: absolute path to a separate independent read-only verification SQL script.
- `FACTORYOS_DR_ERASURE_LEDGER_REFERENCE`: opaque identifier for the externally maintained, immutable erasure ledger snapshot.
- `FACTORYOS_DR_ERASURE_LEDGER_SHA256`: SHA-256 digest of the exact approved ledger snapshot.

The SQL files must be regular files on the protected runner, readable by the runner identity, not symlinks, and not group/world writable. The replay and verification paths must resolve to different files. Do not commit provider credentials, customer data or the external ledger payload. The operator must validate the ledger's signature/source, completeness and digest against its authoritative control plane before dispatch; the workflow records the supplied digest but does not independently authenticate that external authority.

The replay SQL receives these `psql` variables: `candidate_sha`, `target_database_identity`, `snapshot_watermark_utc`, `incident_cutoff_utc`, `ledger_reference`, and `ledger_sha256`. It must apply the erasure tombstones absent from the restored snapshot, idempotently, through a ledger watermark that covers the incident cutoff. It must emit exactly one line for each marker:

~~~text
FACTORYOS_ERASURE_REPLAY_STATUS=PASS
FACTORYOS_ERASURE_LEDGER_SHA256=<the supplied digest>
FACTORYOS_ERASURE_REPLAY_CANDIDATE_SHA=<the exact candidate SHA>
FACTORYOS_ERASURE_REPLAY_TARGET_IDENTITY=<the exact restore target identity>
FACTORYOS_ERASURE_LEDGER_WATERMARK_UTC=<UTC RFC3339 watermark>
FACTORYOS_ERASURE_REPLAYED_REQUESTS=<non-negative integer>
FACTORYOS_ERASURE_REPLAY_RESIDUALS=0
~~~

The ledger watermark must be at or after the incident cutoff and not in the future. The independent verifier runs in a PostgreSQL read-only session and must emit exactly one each of `FACTORYOS_ERASURE_VERIFY_STATUS=PASS`, `FACTORYOS_ERASURE_VERIFY_LEDGER_SHA256`, `FACTORYOS_ERASURE_VERIFY_CANDIDATE_SHA`, `FACTORYOS_ERASURE_VERIFY_TARGET_IDENTITY`, `FACTORYOS_ERASURE_VERIFY_REPLAYED_REQUESTS`, `FACTORYOS_ERASURE_VERIFY_RESIDUALS=0`, and `FACTORYOS_ERASURE_VERIFY_METHOD=INDEPENDENT_READ_ONLY`. All digest, candidate, target and request-count values must match the replay receipt. The replay and verifier SQL file hashes, ledger reference/digest/watermark, request count and residual count are included in the technical receipt; a PASS operator sign-off rejects missing evidence or any residual.

This is a restore-time database reconciliation hook, not a PostgreSQL WAL/PITR erasure adapter, backup-vault purge, or proof that S3, Redis persistence, snapshots, replicas, or external DR copies have been deleted. Provider-specific external copies still require their own reviewed inventory, retention/hold disposition, deletion/expiry procedure and independent residual verification. A successful replay is only as complete as the independently authenticated ledger and the approved SQL procedure.

## 3. RPO and RTO are measurements first

The script records source and restored watermarks and the supplied incident/cutoff time. Observed RPO is the difference between the explicit incident/cutoff time and the restored durable-write watermark. Observed RTO is measured from that same incident/cutoff epoch until candidate migrations, failed-transaction recovery, restored-schema/RLS/audit checks, and candidate API readiness have all completed. The helper also reports restore-and-verification-only duration separately. The supplied cutoff must not be in the future. A probe query that returns only the wall clock is not an acceptable business watermark.

The HLD suggestion of **RPO ≤ 300 seconds (5 minutes)** and **RTO ≤ 3,600 seconds (60 minutes)** is an illustrative baseline only. These values are **not contractual** unless the accountable service/data owner explicitly approves the objective for the applicable system and recovery class. Leave target approval disabled unless that written approval exists. When approved targets are supplied, the release-gate script fails if observed values exceed them. Document source backup cadence, WAL/PITR coverage, transaction loss semantics and the exact recovery start/stop events that were used for the measurement.

## 4. Evidence receipt and operator sign-off

In `RELEASE_GATE` mode, the helper writes a create-only JSON technical receipt at `FACTORYOS_RECOVERY_EVIDENCE_JSON` on both success and failure when the destination is available. The receipt binds the candidate SHA, migration-manifest digest/count/status, source/restore identities, encrypted archive checksum, test statuses, timestamps, measured RPO/RTO and target assessment. Existing receipts are never overwritten. A technically failed or interrupted run must stay `TECHNICAL_FAIL`; do not convert it to success manually.

After reviewing the evidence and environment approval, create a separate sign-off record. From the candidate checkout, run:

~~~sh
node scripts/recovery/record-dr-operator-signoff.mjs \
  --evidence /secure/restricted/dr-evidence/rehearsal-receipt.json \
  --decision PASS \
  --operator "operator identity" \
  --approver "independent approver identity" \
  --notes "Restore, migration, smoke, isolation, audit and recovery metrics reviewed." \
  --reference "approved change/incident reference"
~~~

Use `--decision FAIL` for a failed attempt and preserve the failure evidence. A `PASS` decision is rejected unless encryption, checksum, archive readability, restoration, candidate migration, failed-transaction recovery, application smoke, tenant isolation, audit continuity and numeric RPO/RTO evidence all pass. The sign-off file is create-only, records the evidence SHA-256 and must be retained alongside the environment approval event. Do not use the rehearsal's automatically populated placeholder identities as human approval.

## 5. Acceptance decision

The release owner must leave the gate blocked until:

- the exact candidate SHA's applicable API, PostgreSQL, web and dependency-security checks are green;
- a backup was made on approved restricted storage and its checksum/decryption/archive checks pass;
- the target was independently confirmed isolated/empty, and restore completed;
- candidate migration and failure-recovery checks pass on that restored snapshot;
- restored-schema smoke, application-role RLS read/write isolation, audit continuity, and candidate API liveness/readiness against the same independently identified restore database all pass;
- source/restore identities, the exact migration-manifest digest, measured durations, RPO/RTO and unresolved exceptions are recorded;
- an independent operator sign-off is attached to the evidence digest.

CI's ephemeral self-contained GPG + PostgreSQL rehearsal validates the automation with synthetic records. It is additional evidence, not a substitute for the manual workflow against approved recovery infrastructure or for accountable owner sign-off.
