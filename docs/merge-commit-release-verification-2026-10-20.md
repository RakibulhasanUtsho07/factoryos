# Merge-commit CI verification and release evidence

**Evidence record date:** 2026-10-20  
**Repository:** `RakibulhasanUtsho07/factoryos`  
**Release-merge SHA verified:** `afeb9cdbe25d1d154ad42a4e6137a18977d33c23`  
**PR:** [#68 — test(release): verify CI on exact merge commits](https://github.com/RakibulhasanUtsho07/factoryos/pull/68)  
**Purpose:** Record successful CI evidence against the actual `main` merge commit, not only the pre-merge PR head.

## Exact post-merge CI on main

All five applicable workflows completed with conclusion **SUCCESS** and `head_sha=afeb9cdbe25d1d154ad42a4e6137a18977d33c23`. These are `push` runs on `main`, after PR #68 merged.

| Workflow | Post-merge run | Result and evidence |
|---|---|---|
| API CI | [Run 39437359258](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359258) | **SUCCESS**. API lint/build; 115 suites / 1,039 unit tests passed, plus PostgreSQL RLS integration 1 suite / 7 tests passed. Bounded load and backup/restore contract checks also passed. |
| API PostgreSQL CI | [Run 39437359368](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359368) | **SUCCESS**. Ordered migration apply, manifest inventory/hash verification, selected migration idempotency reruns, rollback/security SQL contracts, API lint/build and full PostgreSQL-backed suite: 151 suites / 1,206 tests passed. |
| Production Dependency Security | [Run 39437359369](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359369) | **SUCCESS**. Locked install, recovery/load contract checks, `npm audit --omit=dev`. |
| Web CI | [Run 39437359291](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359291) | **SUCCESS**. Web dependency install, lint and production build. |
| SRS HLD Blueprint Traceability | [Run 39437359027](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39437359027) | **SUCCESS**. Audit script syntax and SRS/HLD/Blueprint consistency validator. |

Each link above opens the post-merge run. Their run metadata identifies the same exact merge SHA shown at the top of this record. PR-head checks also passed, but are additional evidence only; they are not being substituted for these post-merge runs.

## Ordered migration manifest verification

The PostgreSQL workflow consumes [`scripts/audit/migration-manifest.txt`](../scripts/audit/migration-manifest.txt) and runs [`scripts/audit/verify-migration-manifest.mjs`](../scripts/audit/verify-migration-manifest.mjs) before executing schema changes.

| Verification item | Result on merge SHA |
|---|---|
| Manifest entries | **162** |
| Actual top-level `migrations/*.sql` inventory | **162** |
| Missing entries | **0** |
| Extra/nonexistent entries | **0** |
| Duplicate entries | **0** |
| Ordered manifest SHA-256 | `55b89db4b58e095c1448465fc880f1ddcf83b8d45a09af6f37ddccfdf1fc086e` |
| Inventory validator | **PASS** |
| Explicit, dependency-aware apply order | **PASS** |
| Applied migrations in log | **162/162** |
| Final migration | `migrations/158_ot_mqtt_modbus_gateway.sql` |

The 162-file count is not the same as the highest numeric migration prefix (158), because some migrations share a numeric prefix. The ordering is intentionally not lexical: `003_outbox_event_envelope.sql` follows `004_orders_outbox.sql` because it alters objects created by that migration. Do not sort this manifest without reviewing and testing migration dependencies.

### Selected idempotency evidence

The PostgreSQL run reapplied each of the following after the initial ordered application; the step completed successfully within the passing job:

- `151_growth_forecast_evaluation_calibration.sql`
- `152_ai_agent_retry_backoff.sql`
- `153_saas_money_aggregation_precision.sql`
- `154_saas_entitlement_enforcement_modes.sql`
- `155_saas_retention_execution_and_erasure_receipts.sql`
- `156_tenant_privacy_inventory_and_rls_guardrails.sql`
- `157_ot_opcua_read_gateway.sql`
- `158_ot_mqtt_modbus_gateway.sql`

This is tested idempotency for those eight migrations and their covered contracts; it is **not** a claim that every historic migration is universally rerunnable. The passing PostgreSQL run also performed the repository's migration inventory guard, transaction-failure rollback probe, tenant/RLS/privacy-inventory controls, SQL contracts and complete API test suite.

## Baseline versus release merge

The prior `main` baseline was `ceea82c85d2ebd8fd7e0b55abf01c419eab281ed`. It had only [traceability run 39433624232](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39433624232) as an exact-SHA CI run; API, PostgreSQL, production security and web were not present on that SHA. Earlier green runs on other SHAs were treated as historical evidence only.

After PR #68 merged, the actual merge SHA `afeb9cdbe25d1d154ad42a4e6137a18977d33c23` independently passed every applicable workflow linked above. The run set, test totals and migration digest were read from the completed GitHub Actions run metadata/logs.

## Release-gate interpretation

**Repository CI gate for this merge SHA: PASS.** All five required post-merge workflow runs succeeded, and the explicit migration manifest verified and applied successfully in disposable PostgreSQL CI.

**Production release authorization: NOT IMPLIED.** These checks do not establish production deployment, an approved production database migration, actual encrypted backup/restore rehearsal, production RPO/RTO, live external deletion propagation, staged large-tenant load/rollback, live provider or OT hardware integration, or source-owner sign-off for all SRS requirements. Those operational/source-governance gates remain separate and must not be marked PASS from CI alone.

## 2026-10-24 dev-to-main promotion verification

**Status: OPEN / NOT_ACCEPTED pending exact post-merge SHA checks.** This section records staged promotion evidence; it is not production acceptance and does not replace post-merge verification.

- Source branch: `rakibul-hasan`, conflict-resolved candidate `3ceb59a040dc070def9ea70bceb4096a0f226ca5`.
- Source-to-dev promotion: [PR #124](https://github.com/RakibulhasanUtsho07/factoryos/pull/124), merged as `bb85a5291873a4fb20fe0cc73178a21f7d43f014`.
- PR-head API CI: [run 40077592817](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40077592817) — SUCCESS on `3ceb59a040dc070def9ea70bceb4096a0f226ca5`.
- PR-head API PostgreSQL CI: [run 40077592838](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40077592838) — SUCCESS on `3ceb59a040dc070def9ea70bceb4096a0f226ca5`.
- PR-head Production Dependency Security: [run 40077592818](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40077592818) — SUCCESS on `3ceb59a040dc070def9ea70bceb4096a0f226ca5`.

These are **pre-merge PR-head checks**, not evidence that the `dev` or `main` merge commit passed. Keep this promotion open until exact post-merge `dev` and `main` SHAs have completed applicable API, PostgreSQL, dependency-security, SRS/HLD/Blueprint traceability, and Web CI where web paths change. Record each run URL and outcome against its own SHA. Verify the ordered migration manifest and its inventory/hash on the release candidate; do not copy historical manifest counts or checksums from the 2026-10-20 record.

FR-MSO-03 and FR-MSO-05 remain OPEN / NOT_ACCEPTED until live-provider acceptance prerequisites, positive/negative probe evidence, and independent release sign-off are recorded.

