# Merge-commit CI verification and release evidence

**Evidence updated:** 2026-10-20  
**Repository:** `RakibulhasanUtsho07/factoryos`  
**Verified post-merge target SHA:** `afeb9cdbe25d1d154ad42a4e6137a18977d33c23`  
**Source of CI truth:** GitHub Actions run metadata and logs, each checked for exact `head_sha`. This record is repository CI evidence, not production deployment approval.

## Result summary

All five applicable workflows completed successfully **after PR #68 merged**, with `event=push` and exact `head_sha=afeb9cdbe25d1d154ad42a4e6137a18977d33c23`. None of the results below are borrowed from PR-head runs or a previous commit.

| Gate | Post-merge run | Exact-SHA result / evidence |
|---|---|---|
| API CI | [Run 39437359258](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359258) | **SUCCESS** — `npm ci`, AI Tool Registry PostgreSQL RLS fixture setup and rerunnable-migration check, load/recovery harness syntax and contract tests, API lint, API build, **115 suites / 1,039 tests passed**, and separate RLS integration suite **1 suite / 7 tests passed**. |
| API PostgreSQL CI | [Run 39437359368](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359368) | **SUCCESS** — PostgreSQL 16 service healthy; ordered 162-file manifest applied; migration-inventory verifier passed; migrations 151–158 rerun; SQL contracts, deliberate transaction-failure/rollback probe, tenant/RLS and privacy-inventory checks, API lint/build, and full unit + PostgreSQL integration suite **151 suites / 1,206 tests passed**. |
| Production Dependency Security | [Run 39437359369](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359369) | **SUCCESS** — locked install, recovery/load contract checks, `npm audit --omit=dev`: **0 production dependency vulnerabilities reported**. |
| Web CI | [Run 39437359291](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359291) | **SUCCESS** — locked workspace install, web lint and Next.js production build completed successfully. |
| SRS/HLD/Blueprint Traceability | [Run 39437359027](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359027) | **SUCCESS** — audit script syntax check and `node scripts/audit/validate-srs-audit.mjs`; log reports `SRS/HLD/Blueprint audit consistency passed`. |

## Merge and previous-check distinction

| Evidence | SHA / result | Interpretation |
|---|---|---|
| PR #68 | [Merged PR](https://github.com/RakibulhasanUtsho07/factoryos/pull/68) | Added the canonical ordered migration manifest, fail-closed inventory/hash verifier, relevant workflow path triggers and this evidence ledger. |
| PR #68 tested head | `d9c746bd70046d57d8e58f663a7ca7c77299bd89` | Its PR checks were also green, but **are not** used as a substitute for the post-merge evidence below. |
| Actual main merge commit | [Commit afeb9cd](https://github.com/RakibulhasanUtsho07/factoryos/commit/afeb9cdbe25d1d154ad42a4e6137a18977d33c23) | All five run links in the result summary have this exact SHA, were triggered by `push`, and completed successfully. |

## Ordered migration manifest verification

The PostgreSQL CI apply order is stored in [`scripts/audit/migration-manifest.txt`](../scripts/audit/migration-manifest.txt), with checks performed by [`scripts/audit/verify-migration-manifest.mjs`](../scripts/audit/verify-migration-manifest.mjs).

Evidence from the PostgreSQL job log for exact SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23`:

| Check | Observed value |
|---|---|
| Manifest entries | **162** |
| Top-level `migrations/*.sql` inventory | **162** |
| Duplicate entries | **0** |
| Omitted SQL files | **0** |
| Manifest verifier inventory result | **PASS** |
| Order policy | Explicit, dependency-aware order; not lexical sorting |
| Ordered-entry SHA-256 | `55b89db4b58e095c1448465fc880f1ddcf83b8d45a09af6f37ddccfdf1fc086e` |
| Manifest file blob SHA | `bdbd735eaa9600f118d29886fa7494525c15853f` |
| Verifier file blob SHA | `925957c21483b7bc154b6c9f64fbf12ad494be8c` |

The SHA-256 is computed over the canonical ordered sequence after blank lines/comments are removed, joining each migration path with LF and including one final LF. The order is intentionally not lexical: for example, `003_outbox_event_envelope.sql` is applied after `004_orders_outbox.sql` because the former alters objects created by the latter. The filename prefix range ends at 158, while 162 SQL files exist because some numeric prefixes are reused.

The PostgreSQL workflow reruns migrations **151, 152, 153, 154, 155, 156, 157 and 158** after initial application. These successful post-merge reruns are targeted idempotency evidence for those migrations; they do not claim that every migration in the repository is generally rerunnable.

## Remaining release limitations

**CI gate for the code/workflow merge SHA: PASS. Overall formal product-release gate: remains subject to the independent SRS/source-owner and operational acceptance gates.**

These CI runs prove repository build/lint/test/security/traceability and the stated disposable PostgreSQL migration checks on the SHA shown in each run. They do not prove a production deployment, execution of migrations against a customer database, real encrypted backup/restore rehearsal, approved RPO/RTO, staging load/soak results, external erasure propagation, live provider/OT hardware operation, or Product/Document Control source approval. Do not convert those unobserved production/operational items to PASS based only on GitHub Actions.
