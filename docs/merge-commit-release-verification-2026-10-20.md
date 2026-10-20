# Merge-commit CI verification and release evidence

**Evidence record date:** 2026-10-20  
**Repository:** `RakibulhasanUtsho07/factoryos`  
**Purpose:** Verify the exact main merge SHA for API, PostgreSQL, production dependency security, web, and traceability CI. This is a repository CI record, not deployment approval.

## Pre-change baseline (main before this work)

| Item | Exact SHA / run | Finding |
|---|---|---|
| Main baseline before this task | `ceea82c85d2ebd8fd7e0b55abf01c419eab281ed` | Current `main` SHA at start of work; docs/audit-only merge. |
| Traceability CI | [Run 39433624232](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39433624232) | **SUCCESS** on exact SHA `ceea82c85d2ebd8fd7e0b55abf01c419eab281ed`. It validates audit-register/manifest consistency only. |
| API CI | **NOT PRESENT** on baseline SHA | No exact-SHA API build/lint/test pass was present. |
| API PostgreSQL CI | **NOT PRESENT** on baseline SHA | Ordered migration/integration evidence was not established for this SHA. |
| Production dependency security | **NOT PRESENT** on baseline SHA | No exact-SHA production dependency audit was present. |
| Web CI | **NOT PRESENT** on baseline SHA | No exact-SHA web lint/build pass was present. |

The green API/PostgreSQL/security/web runs on `7b4a28419f6682480d10ee5f64ed5172bf809fad` are historical and are **not** treated as checks on the baseline SHA.

## Migration manifest controls

The PostgreSQL workflow reads its migration apply sequence from [`scripts/audit/migration-manifest.txt`](../scripts/audit/migration-manifest.txt) and executes [`scripts/audit/verify-migration-manifest.mjs`](../scripts/audit/verify-migration-manifest.mjs) before schema application. The verifier fails closed if any entry is missing, duplicated, malformed, or if any top-level `migrations/*.sql` file is omitted. CI prints the manifest-entry count and SHA-256 over the exact ordered entries (one path per line, newline-terminated).

- The former inline workflow array contains **162 unique SQL files**; the highest numeric migration prefix is **158**. These counts differ because several files reuse prefixes (including 003, 004 and 026).
- Apply order is dependency-aware and must not be sorted lexically. In particular, `003_outbox_event_envelope.sql` follows `004_orders_outbox.sql` because it alters objects created by the latter.
- PostgreSQL CI reapplies migrations **151–158** after initial application to exercise their idempotency contracts. This is targeted idempotency evidence, not a claim that every historical migration is universally rerunnable.
- Existing PostgreSQL checks also include the deliberate transaction-failure rollback probe, tenant/RLS and privacy-inventory checks, SQL contracts, and API integration/full test suites.

## Exact post-merge evidence

**Status at record creation: PENDING.** No run is marked successful until GitHub Actions reports a completed successful run on the exact merge commit. PR-head checks are not a substitute for post-merge checks.

This evidence document is a trigger for all five applicable workflows. Changes to this record therefore rerun API CI, API PostgreSQL CI, production dependency security, Web CI and traceability CI; manifest/script changes also trigger PostgreSQL CI.

| Workflow | Required exact-SHA evidence | Status |
|---|---|---|
| API CI | Run URL, run ID, `head_sha`, lint/build/unit-test result | **PENDING POST-MERGE** |
| API PostgreSQL CI | Run URL, run ID, `head_sha`, manifest count/hash, migrations applied, idempotency, DB integration-test result | **PENDING POST-MERGE** |
| Production Dependency Security | Run URL, run ID, `head_sha`, production dependency audit result | **PENDING POST-MERGE** |
| Web CI | Run URL, run ID, `head_sha`, lint/build result | **PENDING POST-MERGE** |
| SRS HLD Blueprint Traceability | Run URL, run ID, `head_sha`, audit validator result | **PENDING POST-MERGE** |

## Release gate

Repository CI validates code, SQL migration order, selected migration reruns, dependency audit, web build, and traceability artifacts only for the commit identified by each run. It does not establish production deployment, real customer-data migration, encrypted backup/restore rehearsal, external deletion propagation, staging load test, live provider/OT hardware integration, or source-owner approval. Keep the formal P0 release gate **BLOCKED** if any required exact-SHA run is missing/failing or required operational/source-owner acceptance evidence remains absent.
