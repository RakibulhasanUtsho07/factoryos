# Backup/Restore, Migration Recovery, Load and Security Acceptance

**Status:** bounded repository-level verification and operator runbook. Passing these checks is not a production disaster-recovery certification. RPO/RTO, retention durations, load targets and production change authority must be approved by their owners.

The production rehearsal entrypoint and immutable receipt/sign-off contract are detailed in [`docs/production-disaster-recovery-rehearsal.md`](production-disaster-recovery-rehearsal.md). Its manual workflow requires an approved isolated runner, protected libpq/GPG configuration, a manifest exactly matching pending migrations for the restored snapshot, reviewed watermark/smoke SQL, and independently recorded operator approval. CI uses disposable synthetic data and is not itself production DR sign-off.

## Scope and requirement evidence

| Area | Automated repository evidence | Operator / environment evidence still required |
|---|---|---|
| Encrypted backup and restore | **scripts/recovery/postgres-backup-restore-rehearsal.sh** validates distinct source/target identity, archive readability, checksum, empty isolated target, candidate migrations, and a reviewed erasure-tombstone replay plus independent read-only residual check before schema smoke/API readiness. CI validates the replay preconditions and evidence/sign-off contract; the replay SQL and external ledger remain operator-provisioned. | Run against an approved source and disposable restore database; verify keys, restricted storage, actual duration, integrity, externally sourced erasure ledger completeness/digest, provider-specific reconciliation, application smoke queries, RPO/RTO and independent operator sign-off. |
| Migration failure / recovery | PostgreSQL CI applies the complete explicit migration manifest and reruns designated migrations for idempotency. A deliberate failure after DDL/DML must fail and must leave no probe table behind. Existing migration/inventory SQL contracts remain release gates. | Test every candidate migration in a fresh restore; review lock behavior, irreversible data changes and forward-fix/rollback decisions. Never infer production safety from the deliberate transaction probe alone. |
| Bounded load / performance | **npm --workspace services/api run test:load-smoke:contract** exercises success metrics, request caps, the 5xx acceptance gate, remote-target opt-in, credential-URL rejection and path validation against a local synthetic HTTP server. | Run representative read/write mixes, DB pool and lock pressure, saturation, soak, recovery and capacity tests only in a scheduled isolated environment with approved synthetic data and traffic budgets. A 15-second smoke test is not capacity certification. |
| Security / isolation | API unit tests, PostgreSQL integration tests, the schema-wide tenant governance inventory, forced-RLS/tenant-isolation matrix, least-privilege DB-role checks already in the CI schema setup, and production dependency auditing. | Review live IAM, secrets, network boundaries, backup access, GPG key custody, alert delivery and deployed configuration. Run a staging cross-tenant abuse test under an approved security plan. |

The signed authoritative SRS/HLD/Blueprint were not present in the inspected repository snapshot. This page maps the requested acceptance themes to the repository's operational reliability and release-readiness documents; it is not signed SRS sign-off.

## 1. Run an encrypted PostgreSQL backup/restore rehearsal

Use the script from a controlled operator workstation or ephemeral recovery runner. Requirements: Bash, PostgreSQL client tools (pg_dump, pg_restore, psql), GnuPG, sha256sum, approved pg_service/pgpass configuration, an approved GPG recipient, and a separately created empty restore database. Use a protected PGSERVICEFILE and PGPASSFILE or the libpq defaults; never put database passwords in this script, Git, a URL, or a ticket.

Create source and restore entries in the protected libpq service file. Confirm independently that the restore service points to a disposable isolated database, not the source or another customer's database. Import the approved recovery key on the rehearsal host. Prepare a reviewed, read-only SQL smoke file appropriate to the restored schema.

Linux/macOS example (supply approved values locally, never commit them):

~~~sh
export FACTORYOS_BACKUP_PGSERVICE=factoryos-source
export FACTORYOS_RESTORE_PGSERVICE=factoryos-restore-empty
export FACTORYOS_BACKUP_OUTPUT=/secure/restricted/factoryos-prechange-2026-10-20.dump.gpg
export FACTORYOS_BACKUP_GPG_RECIPIENT=approved-recovery-key@example.invalid
export FACTORYOS_RESTORE_SMOKE_SQL=/secure/restricted/restore-smoke.sql
export FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE=I_HAVE_VERIFIED_EMPTY
bash scripts/recovery/postgres-backup-restore-rehearsal.sh
~~~

The example recipient, service names, paths and SQL file are placeholders. Change them to real, pre-approved values on the recovery runner. The output directory must already exist on restricted storage. The script refuses to overwrite an existing artifact, requires an explicit empty-target confirmation, compares source/target database identity, rejects non-empty user schemas, streams pg_dump into GPG encryption, writes a SHA-256 checksum, verifies/decrypts the archive in a mode-700 temporary directory, checks pg_restore --list, restores with --exit-on-error and --single-transaction, and executes the reviewed smoke SQL. The encrypted artifact is the configured output path (ending in .dump.gpg), with a sibling .sha256 checksum file.

Keep the archive, checksum, key reference, output of the smoke check, candidate Git SHA, database server/tool versions, backup timestamp, restore start/end UTC time, artifact access log, observed recovery-point/recovery-time, and operator sign-off in the approved change record. Do not attach the database dump, credentials, private key, PGPASSFILE or raw customer rows to issues/PRs.

This script is a rehearsal helper, not a scheduler, off-site replication service or immutable backup manager. It does not configure storage retention, multi-region copies, point-in-time recovery/WAL archiving, database encryption at rest, key rotation, service-level RPO/RTO or alerting. Do not run it against production without change authorization. If restore fails, preserve logs and the encrypted backup, quarantine the target and recover according to the approved incident plan; the script deliberately does not drop or clean up the target automatically.

## 2. Migration preflight and failure recovery

Before a schema release:

1. Pin the candidate commit SHA and confirm API CI, PostgreSQL CI, frontend CI and dependency security checks that apply to it.
2. Confirm target database/environment identity and inspect the exact ordered migration manifest in **.github/workflows/api-postgres-ci.yml**. Numbered migration filenames are not sufficient to reconstruct dependency order; same-prefix migrations can depend on later-numbered files.
3. Create an encrypted backup and prove restore into an isolated empty database. Verify backup checksum and application/schema smoke SQL before candidate changes.
4. Apply the exact candidate migration order to the restore first. Confirm every numbered SQL file appears in the manifest; CI fails on omitted or missing entries. Run the SQL contract and RLS/privacy inventory checks.
5. Reapply only migrations explicitly designed and tested for idempotency. The repository's PostgreSQL CI reruns selected late migrations; this does not assert every migration is safe to run twice.
6. Observe locks, long transactions, constraint validation, trigger/policy changes and row-volume assumptions. For destructive or partially irreversible changes, document the approved forward-fix plan before applying production.
7. Capture migration output, start/end UTC time, candidate SHA, resulting schema state and operator approval. After migration, execute API readiness, authentication, tenant isolation and domain smoke tests.

The PostgreSQL CI transaction probe creates a table and inserts a row inside a transaction, deliberately triggers a division-by-zero error, and verifies that the table did not survive. This validates fail-closed transactional recovery mechanics in the CI database. It does not prove that an arbitrary migration is transactional, that non-transactional DDL or external side effects can be rolled back, or that business data can be reconstructed from schema rollback alone. Review each migration's actual transaction and recovery properties.

If a candidate migration fails in staging/production, stop the rollout and follow the approved incident/restore decision tree. Do not repeatedly retry an unknown partial migration or execute ad-hoc reverse SQL against live writes. Preserve the first error output and current migration/schema state, identify committed DDL/data and any external effects, and obtain a database-owner decision between a reviewed forward fix and restoring/replaying from backup. Restore only to a separately validated target unless the incident commander explicitly approves a production recovery.

## 3. Bounded load smoke testing

Run the harness against localhost by default. It accepts only an absolute path on the selected origin and does not follow redirects. Defaults are 15 seconds, concurrency 5, 100,000 attempted requests maximum and a five-second timeout per request; lower the request cap for a first rehearsal. Remote targets are blocked unless an operator deliberately sets FACTORYOS_LOAD_ALLOW_REMOTE=true.

~~~sh
FACTORYOS_LOAD_BASE_URL=http://localhost:3001 \
FACTORYOS_LOAD_PATH=/health \
FACTORYOS_LOAD_DURATION_SECONDS=15 \
FACTORYOS_LOAD_CONCURRENCY=5 \
FACTORYOS_LOAD_MAX_REQUESTS=1000 \
npm --workspace services/api run test:load-smoke
~~~

The harness reports status counts, network and HTTP 5xx errors, requests per second and p50/p95/p99/max latency. FACTORYOS_LOAD_MAX_ERROR_RATE defaults to 1%. Set FACTORYOS_LOAD_MAX_P95_MS only where a route-specific threshold has been approved. A bearer token is supported only for an approved read-only target, is never placed in the URL, and is not printed in the report.

Run deterministic guardrail tests with:

~~~sh
npm --workspace services/api run test:load-smoke:contract
npm --workspace services/api run test:recovery:contract
~~~

The load tests use a local synthetic HTTP server only; the recovery tests exercise configuration rejection before database clients are called. Neither test suite makes requests to production or requires database credentials. For real performance characterization, separately define an approved environment, traffic mix, workload ramp, rate limit, observation window, database/connection-pool monitoring, success/error budget, stop conditions, and a cleanup plan. Do not turn this script into an unbounded or production-directed stress test.

## 4. Security and tenant isolation checks

The applicable release evidence includes:

- **services/api/test/tenant-data-governance-inventory.sql**: new public base/partition relations must be inventoried.
- **services/api/test/saas-tenant-isolation-matrix.sql**: forced RLS and tenant-bound USING/WITH CHECK policies for critical SaaS/governance surfaces.
- API database/tenant-isolation integration coverage: foreign-tenant resource IDs, missing tenant context, writes and transfer paths must fail closed.
- PostgreSQL CI migration manifest verification and idempotency reruns.
- Least-privilege application role setup, API authorization/secret-redaction tests, and production dependency auditing.

Do not interpret inventory visibility as proof every indirect ownership relation is exportable/deletable. New tables with direct tenant_id require forced RLS and tenant-context policy review. Tables without direct tenant scope must be explicitly classified and join/foreign-key isolation-tested before export or erasure support. Export adapter allowlists, caches, external providers, replicas and backups remain separate scope; tenant erasure is not complete until each required external adapter supplies verifiable receipts.

Do not store bearer tokens in URLs or metrics labels; do not log request bodies, SQL text or bind values. Keep telemetry/database/backup credentials in secret management, restrict scrape and DB access to trusted identities/networks, and use a non-superuser application database role. Production dependency audit is distinct from the API's functional security tests; neither substitutes for secret scanning, penetration testing or a review of live deployment permissions.

The detailed production identity, secrets, database-role, egress, credential-rotation and independent-review gate is recorded in [Production Security Configuration and Independent Review](production-security-configuration-and-independent-review.md). Its attestation remains NOT_ATTESTED and PENDING_EXTERNAL_REVIEW until the hosting owner provides the active config evidence and an independent reviewer completes the authorized scope. It includes the current preliminary implementation findings (production auth-mode fallback, MFA claim policy and local PostgreSQL bind) and tracks unverified deployed privileges, secrets manager bindings, active network rules, SCIM applicability and independent retest as release blockers. Do not check the release-approval box below solely because the new code/config tests pass.

## Release acceptance record

Complete this record on the exact candidate SHA:

- [ ] API CI, API PostgreSQL CI, Web CI and dependency-security workflow applicable to the SHA passed.
- [ ] Backup helper precondition contract passes; backup artifact is created in approved encrypted storage; checksum passes; isolated restore and reviewed SQL smoke check pass.
- [ ] Ordered candidate migration sequence applied successfully to the restore; inventory/RLS and domain SQL contracts pass.
- [ ] Failed-transaction recovery probe verifies no partial DDL remains.
- [ ] Load-smoke contract tests pass; any real load test has owner approval and a sanitized result linked to the SHA.
- [ ] Tenant isolation and authorization-denial checks pass; application role and production secret/network configuration reviewed.
- [ ] Production DR rehearsal evidence receipt binds the exact candidate SHA, encrypted backup checksum, distinct source/target identities, pending migration manifest digest, migration/failure recovery result, smoke/isolation/audit results and measured recovery durations.
- [ ] Independent operator sign-off is recorded against the evidence SHA-256 and linked to the approved change/environment approval event; CI-only rehearsal is not substituted for production evidence.
- [ ] RPO/RTO, retention, load target, rollback/forward-fix decision, operator, approver and unresolved risks are recorded.

A box may be checked only with evidence from the relevant environment. Green CI alone does not prove production backup freshness, successful restore, service deployment, actual alert delivery or approved business SLOs.
