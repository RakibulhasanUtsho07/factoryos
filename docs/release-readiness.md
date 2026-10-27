# FactoryOS release-readiness checklist

**Final traceability gate:** Review the [Final SRS/HLD/Blueprint Traceability Audit](final-srs-hld-blueprint-traceability-audit.md), [SRS v2.1 requirement-by-requirement matrix](srs-v2.1-requirement-evidence-matrix.md), [HLD/Blueprint WP01–WP12 evidence matrix](hld-blueprint-work-package-evidence-matrix.md), and [Round 35–43 domain matrix](operational-rounds-35-43-traceability.md). The SRS v2.1 FINAL / FOS-SRS-001, HLD/LLD v1.0 and Blueprint v1.0 were found in the supplied Library (all dated 2026-10-02) but are not committed to the repository. The final SRS §140 declares 950 cumulative design-scope requirements; the matrix contains 899 distinct extracted FR/NFR IDs and 37 priorities that require manual review. These counts are not directly comparable units: do not infer 51 missing requirements from the arithmetic difference. Formal sign-off remains blocked until source owners reconcile the revision/scope accounting and every applicable P0/P1 row has direct acceptance evidence.

This checklist is deliberately separate from deployment. Passing CI does not mean production has been deployed or a production migration has been applied.

## API configuration

- Set `NODE_ENV=production` in the hosting environment.
- Set `CORS_ORIGINS` to a comma-separated list of exact HTTPS frontend origins, with no paths, wildcard, credentials, or trailing empty values.
- Keep `SWAGGER_ENABLED=false` unless there is an approved reason to expose API documentation.
- Use the OIDC configuration for production authentication; do not enable development token issuance.
- Store database credentials, JWT-related secrets, and OIDC configuration in the hosting platform's secret manager, not in Git or `.env.example`.
- Use a dedicated least-privileged application database role.
- For distributed tracing, configure OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to the private OTLP/HTTP collector URL ending in /v1/traces; remote endpoints must use HTTPS. Store OTEL_EXPORTER_OTLP_TRACES_TOKEN (if used) in secret management, set OTEL_SERVICE_NAME, and set/approve TRACE_SAMPLE_RATIO in [0, 1]. Do not send full URLs, payloads or tenant/user IDs to trace attributes.
- To enable Prometheus scraping, configure METRICS_SCRAPE_TOKEN with a high-entropy value of at least 32 characters and restrict GET /api/internal/metrics to the monitoring network/identity. Without the token the endpoint remains unavailable. Scrape each API replica; the metrics are process-local.
- Configure orchestration probes against GET /api/health/live (liveness) and GET /api/health/ready (database readiness). The legacy GET /api/health is preserved as readiness.
- For optional OT integration, configure the OPC UA gateway URL/token and separately configure FACTORYOS_OT_PROTOCOL_GATEWAY_URL to the fixed HTTPS /api/v1/modbus/read endpoint, FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN (at least 32 characters), and optional FACTORYOS_OT_PROTOCOL_GATEWAY_TIMEOUT_MS (100–5000 ms). A spool replay worker requires FACTORYOS_OT_API_URL as a fixed HTTPS origin and FACTORYOS_OT_API_TOKEN or an injected rotating workload-identity provider. Keep all tokens and the 32-byte spool encryption key in deployment secret storage; never commit them. Provision the trusted gateway, broker/topic and controller/register mapping, firewall rules and its own secret-manager access separately; never expose industrial network endpoints to an untrusted network.

## Migration and destructive-change manual release gate

Do not apply a production migration until all of the following are verified:

1. Confirm the target database identity and environment independently; never rely only on a shell prompt or a database name copied from an example.
2. Compare the complete ordered migration list in .github/workflows/api-postgres-ci.yml with applied schema_migrations entries, including same-prefix migrations whose order is dependency-sensitive. Do not use the maximum numeric filename as proof that all migrations ran.
3. Take a fresh, access-restricted backup and prove restore to an isolated database.
4. Apply the exact candidate migration sequence to the isolated restore first; run its SQL contract verification and the PostgreSQL integration tests there.
5. Review RLS, locking, transaction duration, operator permissions, audit retention, and the manual recovery procedure with the database owner.
6. Agree on a rollback/forward-fix plan. Do not assume destructive schema rollback is safe after application writes begin.
7. Schedule production execution with an operator present, capture migration output, and run post-migration smoke tests.

Migrations 149–155 add retention policy/versioning, legal holds, preservation attestations and bounded execution receipts. They do not by themselves make every copy of a tenant erasable. Migration 156 inventories every public base/partition relation: direct `tenant_id` tables receive forced RLS and a restrictive tenant-scope fence, `user_roles`/`role_permissions` are registered as derived-scope IAM relations, and all remaining no-direct-scope relations are explicitly excluded and erasure-blocked pending ownership review. The SQL CI gate fails for missing inventory rows. Only reviewed dataset adapters are exportable, and external object storage, caches/indexes, replicas, providers and backups still need separately configured adapters and verified deletion receipts. Retention periods/legal bases require policy-owner approval; do not advertise whole-tenant erasure until indirect ownership coverage and all required external adapters have passed acceptance. Migration 028's execution-claim reconciliation has additional manual recovery risk: preserve a fresh backup, confirm the isolated restore, inspect claim/execution evidence, and obtain operator review before any production reconciliation action. A CI application of migration 028 is not authorization to run it against production.

## CI scope

The repository has automated API, PostgreSQL integration, frontend and dependency-security verification workflows. Confirm the exact workflow set that applies to the candidate SHA:

- **API CI** runs API lint, build, and the unit tests that do not require PostgreSQL integration fixtures.
- **API PostgreSQL CI** provisions a disposable PostgreSQL 16 service, validates and applies the exact ordered list in `scripts/audit/migration-manifest.txt` (currently ending at `migrations/213_traceability_gs1_datamatrix_symbology.sql`), checks that no numbered migration is omitted, replays selected migrations and domain SQL contracts—including privacy/RLS, OT gateways, WMS cycle-count policies/sessions, Edge gateway credentials/health, and AI artifact provenance/admission, the governed AI inventory stock-summary tool contract, the production output lot/scrap genealogy contract, the work-order WMS-consumption genealogy guard contract, and the WP02 blind-count variance resolver UUID/reviewer-separation contract—and then runs the full API Jest suite serially. API regressions cover case-normalized escalation idempotent replay, rejection of counter self-resolution, and rejection of replay by a different actor. Migration filenames have duplicate numeric prefixes, so the ordered manifest is authoritative; do not infer execution order by sorting filenames numerically. Migration 028 is applied only to this disposable CI database.
- **Web CI** installs the npm workspace dependencies, runs the frontend lint command, and builds the Next.js application.

A green GitHub Actions run verifies only the commit and environment shown in that run. It does not mean the application was deployed, that production configuration was entered in a hosting platform, or that any production migration was applied.

## Exact-SHA post-merge verification — 2026-10-27

PR [#251](https://github.com/RakibulhasanUtsho07/factoryos/pull/251) promoted the verified `dev` release to `main` at merge commit `7325a69a48d3bca1eeb0bcf2ec9858f450e0d5b9`. The following GitHub Actions push workflows completed successfully on that exact SHA:

- **API CI:** [run 40455702949](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40455702949) — `success`.
- **API PostgreSQL CI:** [run 40455702974](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40455702974) — `success`.
- **Production Dependency Security:** [run 40455702972](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40455702972) — `success`.

For this candidate, `scripts/audit/migration-manifest.txt` contains 219 unique migration paths and ends at `migrations/212_quality_rework_genealogy_link_guard.sql`. The explicit manifest order is authoritative because numeric prefixes are intentionally duplicated and dependency-sensitive; do not sort the entries lexically or infer migration execution from the maximum prefix.

This record proves only the listed GitHub Actions checks for the recorded merge SHA. It does not prove that the application was deployed, that these migrations were applied to a production database, or that an external provider, backup restore, live carrier, OT hardware, or factory site has passed operational acceptance. Keep those gates open until their own exact-environment evidence and authorized sign-offs are recorded.

## Backup and restore evidence

Before any production database change, follow [the encrypted backup/restore, migration recovery, load and security acceptance guide](backup-restore-migration-load-security-acceptance.md) and the [operational reliability runbook](operational-reliability-runbook.md). Use **scripts/recovery/postgres-backup-restore-rehearsal.sh** with protected PostgreSQL service/credential files, an approved GPG recipient and a separately created empty restore database. The helper checks that the source and target differ, rejects user relations in the target, encrypts the archive, records/verifies a SHA-256 checksum, restores in a single transaction and executes a reviewed restore smoke SQL file.

Record the encrypted artifact reference and checksum, source/restore database identity, candidate SHA, backup and restore UTC timestamps, client/server versions, observed restore duration, smoke-check results, migration contract output, RPO/RTO observations and operator sign-off. Never add plaintext dumps, customer rows, private keys or credentials to GitHub issues/PRs. A CI transaction-failure probe validates rollback mechanics only; it is not proof that all production migrations are reversible.

## Bounded performance and security verification

The API CI workflow runs deterministic tests of the local load-smoke harness and backup helper preconditions: request caps and latency/status reports, rejection of remote targets by default, URL credential rejection, the configured 5xx threshold, required backup configuration, encrypted-artifact naming, distinct source/restore identities and explicit empty-target confirmation. Run **npm --workspace services/api run test:load-smoke:contract** and **npm --workspace services/api run test:recovery:contract** locally before release. A real load or capacity test requires a separately approved isolated environment, representative workloads, rate/stop limits and recorded database/pool observations; do not treat a short smoke test as a capacity guarantee.

The PostgreSQL CI workflow must pass the complete ordered migration manifest, selected idempotency reruns, the intentional migration-failure rollback probe, and tenant governance inventory/RLS contracts. The dependency-security workflow audits production dependencies and executes the load/recovery guard tests on the maintained branch. These checks are repository evidence; they do not substitute for production IAM/network review, secret/key-custody review, external backup/restore rehearsals or owner-approved SLO and RPO/RTO sign-off.

## Final SRS/HLD/Blueprint audit consistency gate

For audit artefacts changed in a release, run `node scripts/audit/validate-srs-audit.mjs` from the repository root. The dedicated [SRS HLD Blueprint Traceability workflow](../.github/workflows/traceability-audit-ci.yml) runs this validator whenever the requirement matrix, AS-132–AS-141 matrix, HLD/Blueprint WP matrix, source manifest, master audit, release-readiness or audit validator changes. It checks the 899 extracted unique ID rows and documented priority buckets, all ten final production acceptance scenarios, WP01–WP12, P0/P1 gap IDs, P2 backlog IDs and three distinct SHA-256 source references. This checks the internal consistency of the evidence set only; it does not mean each requirement/scenario has passed or that formal Product/Architecture/Security/Operations sign-off has been granted.

## Final SRS v2.1 production-readiness acceptance gates

Treat the final SRS §131 P0 requirements and §135 scenarios AS-132–AS-141 as release gates. The [final audit](final-srs-hld-blueprint-traceability-audit.md) records the scenario-by-scenario closure evidence; the relevant NFRs include:

- **NFR-PROD-11 / NFR-PROD-12 (P0):** prove an integrity-checked backup can be restored; record approved service-class RTO/RPO and an actual DR exercise. HLD/LLD §23's critical OLTP RPO ≤5 min/RTO ≤60 min and important-domain RPO ≤1 hour/RTO ≤4 hours are proposed baselines, not approved deployment targets until Operations signs them.
- **NFR-PROD-14 (P0):** prove governed export/deletion through relevant vectors, caches, indexes, derived stores and model-adaptation artifacts; attach completion receipts or explicit residual exceptions.
- **NFR-PROD-17 / NFR-PROD-18 (P0):** retain security, compatibility, performance, rollback and audit evidence for the exact candidate SHA.
- **AS-132–AS-141:** use the [scenario-by-scenario acceptance matrix](srs-v2.1-as-132-141-acceptance-matrix.md) for the exact contract tests and required closure evidence. Do not mark a scenario PASS from a unit test or endpoint alone where the source scenario requires staging, tenant isolation, provider outage, failed rollout, peak-load throttling or a real restore. Record environment, report, outcome, owner and candidate SHA.

## Release completion criteria

- Review the final SRS/HLD/Blueprint traceability audit and exhaustive requirement matrix on the exact candidate SHA; do not approve formal sign-off until the 950-vs-899 scope delta, all 37 priority review items and all P0 gaps are reconciled or formally dispositioned by an authorized owner.
- Confirm the API CI, API PostgreSQL CI, Web CI, and dependency-security run applicable to the exact commit being released.
- Confirm the production API environment has exact HTTPS values for `CORS_ORIGINS`, `NODE_ENV=production`, `SWAGGER_ENABLED=false`, and validated OIDC settings.
- Confirm the actual production database target, compare its applied migration history with the complete ordered `scripts/audit/migration-manifest.txt` (currently ending at `migrations/213_traceability_gs1_datamatrix_symbology.sql`), and record the applicable privacy/RLS, WMS, OT, Edge and AI artifact SQL contract outputs, fresh backup, and proven isolated restore before scheduling any production migration.
- Apply production migrations with an operator present and run post-migration API and frontend smoke tests.
- Record the deployed commit, migration results, verification evidence, and rollback/forward-fix decision.

## OT / OPC UA / MQTT / Modbus commissioning gate

Migrations 157–158 and 191–193 plus the OT API adapters establish bounded protocol/API and device-gateway control-plane contracts, not a production-commissioned industrial connector. Before production use, deploy and review the trusted OT gateway; map every config:// reference to approved endpoints and secrets in the gateway trust zone; restrict routes to explicitly approved controllers/brokers; confirm OPC UA certificate policy, MQTT TLS/ACL/topic and QoS 1 settings, and Modbus unit/register/address/data-type conventions. Provision the durable spool encryption key through secret management, protect its dedicated directory and capacity, ensure a broker delivery is not acknowledged until durably spooled, and ensure a spool item is not removed until all source IDs receive a validated telemetry API acknowledgement. Exercise network loss, reconnect storms, timeout, invalid acknowledgements, response loss after database commit, duplicate delivery, source sequence gaps, retry-ceiling quarantine, manual requeue, wrong key, corrupted spool, full disk, tenant/factory isolation and controller/broker HIL behavior. This repository change does not contain a live OPC UA/MQTT/Modbus session driver or certify hardware-in-the-loop behavior; retain commissioning evidence, rollback/recovery procedure and operator approval before connecting production equipment.
