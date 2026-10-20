# Merge-commit CI verification and release evidence

**Evidence record date:** 2026-10-20  
**Repository:** `RakibulhasanUtsho07/factoryos`  
**Purpose:** Verify the exact main merge SHA for API, PostgreSQL, production dependency security, web, and traceability CI. This is a repository CI record, not deployment approval.

## Baseline before this task

| Item | Exact SHA / run | Finding |
|---|---|---|
| Main baseline before this task | `ceea82c85d2ebd8fd7e0b55abf01c419eab281ed` | Documentation/audit-only merge SHA, before the release verification changes. |
| Traceability CI | [Run 39433624232](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39433624232) | **SUCCESS** on exact baseline SHA `ceea82c85d2ebd8fd7e0b55abf01c419eab281ed`. This validated audit-register consistency only. |
| API / PostgreSQL / security / web on baseline | **NOT PRESENT** | No runs were present for these gates on the baseline SHA. Older green runs on `7b4a28419f6682480d10ee5f64ed5172bf809fad` are historical evidence and are not substituted. |

## Candidate main merge commit and exact-SHA results

**Candidate SHA:** `afeb9cdbe25d1d154ad42a4e6137a18977d33c23`  
**PR:** [#68 — test(release): verify CI on exact merge commits](https://github.com/RakibulhasanUtsho07/factoryos/pull/68)  
All five run records below are GitHub Actions `push` runs whose `head_sha` was independently checked to equal the candidate SHA above. These are post-merge results, not PR-head checks.

| Required workflow | Exact run evidence | Result |
|---|---|---|
| API CI | [Run 39437359258](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359258) — SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23` | **SUCCESS** — API lint/build, load/recovery contract tests, 115 suites / 1,039 unit tests passed; AI Tool Registry PostgreSQL RLS integration: 1 suite / 7 tests passed. |
| API PostgreSQL CI | [Run 39437359368](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359368) — SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23` | **SUCCESS** — 162/162 ordered migration files validated and applied; designated idempotency reruns passed; rollback-recovery, privacy/RLS and SQL contract checks ran; full suite: 151 suites / 1,206 tests passed. |
| Production Dependency Security | [Run 39437359369](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359369) — SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23` | **SUCCESS** — locked install, recovery/load security contracts, and `npm audit --omit=dev` passed. |
| Web CI | [Run 39437359291](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359291) — SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23` | **SUCCESS** — workspace install, web lint and web build passed. |
| SRS/HLD/Blueprint Traceability | [Run 39437359027](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359027) — SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23` | **SUCCESS** — audit validator syntax and audit consistency validator passed. This does not amount to Product/Architecture source-owner sign-off. |

## Ordered migration manifest and idempotency evidence

The source-of-truth apply sequence is [`scripts/audit/migration-manifest.txt`](../scripts/audit/migration-manifest.txt), verified by [`scripts/audit/verify-migration-manifest.mjs`](../scripts/audit/verify-migration-manifest.mjs) before any SQL is applied by PostgreSQL CI.

| Check | Exact evidence on candidate SHA `afeb9cd...` |
|---|---|
| Manifest path count | `migration_manifest_entry_count=162` |
| SQL-file inventory count | `migration_files_inventory_count=162` |
| Ordered entries SHA-256 | `55b89db4b58e095c1448465fc880f1ddcf83b8d45a09af6f37ddccfdf1fc086e` |
| Inventory consistency | `migration_manifest_inventory=PASS` |
| Apply order | `explicit; dependency-aware, not lexical` |
| Coverage | 162 manifest entries / 162 SQL files; no duplicates, missing entries, or extras in the manifest comparison. |
| Idempotency | PostgreSQL CI reapplied migrations 151–158 after the ordered initial apply; the job passed. This is targeted rerun evidence, not a claim that every historical migration is universally rerunnable. |

The workflow intentionally places `003_outbox_event_envelope.sql` after `004_orders_outbox.sql`, because the former alters objects created by the latter. The largest numeric prefix is 158, while the number of files is 162 because some migration prefixes are reused. Do not sort this manifest lexically or equate highest prefix with file count.

## Release gate conclusion for this verification item

**Merge-commit CI acceptance: PASS on candidate SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23`.** All five required post-merge runs are completed and successful on that exact SHA. The run URLs, terminal outcomes, test summaries, manifest inventory, order and digest above were read from GitHub Actions.

**This is not overall FactoryOS production release approval.** CI does not establish production deployment, application of migrations to a live/customer database, an encrypted production backup/restore rehearsal, external deletion propagation, staged load/capacity acceptance, live provider/OT hardware integration, or authoritative SRS/HLD/Blueprint approval. The separate formal SRS traceability P0 gate remains blocked until its documented source-owner, active-scope reconciliation, per-row acceptance and operational evidence gaps are closed.
