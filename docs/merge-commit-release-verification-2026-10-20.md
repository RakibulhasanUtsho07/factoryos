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

**Repository CI gate for exact `main` merge SHA `96804e4408f1ef7f4df1912f1cbc0c542d5c4f05`: PASS.** Promotion PR [#150](https://github.com/RakibulhasanUtsho07/factoryos/pull/150) was merged after all five PR-candidate workflows passed. All five post-merge workflows below also completed successfully with `head_sha=96804e4408f1ef7f4df1912f1cbc0c542d5c4f05`.

- Source-to-dev promotion: [PR #124](https://github.com/RakibulhasanUtsho07/factoryos/pull/124), merged as `bb85a5291873a4fb20fe0cc73178a21f7d43f014`.
- Dev-to-main promotion: [PR #150](https://github.com/RakibulhasanUtsho07/factoryos/pull/150), merge commit `96804e4408f1ef7f4df1912f1cbc0c542d5c4f05`.

### Exact post-merge CI on main

| Workflow | Post-merge run | Result |
|---|---|---|
| API CI | [Run 40078188614](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078188614) | **SUCCESS** — API lint/build and unit-test job completed. |
| API PostgreSQL CI | [Run 40078188589](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078188589) | **SUCCESS** — ordered migration manifest, PostgreSQL application/integration suite, and recovery/security/performance contracts completed. |
| Production Dependency Security | [Run 40078188585](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078188585) | **SUCCESS** — locked dependency install and production security audit completed. |
| Web CI | [Run 40078188611](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078188611) | **SUCCESS** — web lint and production build completed. |
| SRS HLD Blueprint Traceability | [Run 40078188631](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078188631) | **SUCCESS** — SRS/HLD/Blueprint audit consistency validator completed. |

Every run above identifies the exact merge SHA in its metadata; these are post-merge `push` runs, not merely PR-head checks.

### Ordered migration manifest verification

The PostgreSQL CI run invoked `scripts/audit/verify-migration-manifest.mjs` before applying schema changes. Its successful output records:

| Verification item | Result on merge SHA |
|---|---|
| Ordered manifest entries | **202** |
| Top-level `migrations/*.sql` inventory | **202** |
| Ordered manifest SHA-256 | `04e2462a218f2725a3ed242484d09d7317a14f33d2f3e8da9b13fd0b4a978043` |
| Manifest/inventory validator | **PASS** |

The workflow then applied the ordered migration set, including the current inventory cycle-count/session migrations and AI artifact provenance/admission migration, and completed the PostgreSQL-backed integration suite successfully.

### Release and SRS boundary

**Repository CI gate: PASS. Production release authorization: NOT IMPLIED.** Passing CI does not prove a production deployment, approved customer-cluster policy installation, actual OT hardware HIL commissioning, live provider acceptance, external deletion propagation, production backup/restore RPO/RTO, or owner/reviewer sign-off for every SRS requirement.

SRS FR-MSO-03 and FR-MSO-05 remain **OPEN / NOT_ACCEPTED** until the approved live-provider environment, synthetic positive/negative probe evidence, operational records, and independent release sign-off are recorded. The provider acceptance procedure is documented in [AI Model Provider Live Release Acceptance](ai-provider-live-release-acceptance.md); the procedure itself is not evidence that a live acceptance run occurred.

## 2026-10-24 post-merge dependency promotion

The grouped dependency update [PR #90](https://github.com/RakibulhasanUtsho07/factoryos/pull/90) was merged as `c0cdefdcbdd3ad17befdb9476bfcd22efa41f66d`. The exact post-merge `main` SHA completed the applicable push workflows successfully:

| Workflow | Post-merge run | Result |
|---|---|---|
| API CI | [Run 40078990071](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078990071) | **SUCCESS** |
| API PostgreSQL CI | [Run 40078990065](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078990065) | **SUCCESS** |
| Production Dependency Security | [Run 40078990147](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078990147) | **SUCCESS** |
| Web CI | [Run 40078990091](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078990091) | **SUCCESS** |

All four run records identify the exact merge SHA `c0cdefdcbdd3ad17befdb9476bfcd22efa41f66d`. The traceability workflow was not triggered by the dependency-only file set; the immediately preceding `main` SHA `9dac10f2d5f9028600eb0f7c38627a62e17dff45` passed [SRS HLD Blueprint Traceability run 40078667385](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40078667385). This evidence-record change itself will run the traceability and applicable CI checks on its candidate SHA.

The PostgreSQL workflow on `c0cdefdcbdd3ad17befdb9476bfcd22efa41f66d` re-ran `scripts/audit/verify-migration-manifest.mjs` and confirmed:

| Verification item | Result |
|---|---|
| Ordered manifest entries | **202** |
| Top-level `migrations/*.sql` inventory | **202** |
| Ordered manifest SHA-256 | `04e2462a218f2725a3ed242484d09d7317a14f33d2f3e8da9b13fd0b4a978043` |
| Manifest/inventory validator | **PASS** |

The dependency promotion passed repository CI. This remains separate from production release authorization and does not change the OPEN / NOT_ACCEPTED status of SRS FR-MSO-03 and FR-MSO-05 pending live-provider acceptance evidence and independent sign-off.

## 2026-10-31 — structured external-store inventory evidence gate

The external copy-coverage catch-all `UNCLASSIFIED_EXTERNAL_STORE` now has a stricter evidence contract. A signed `NOT_APPLICABLE` assertion is accepted only when the exact read-only evidence artifact is a valid `factoryos.external-store-inventory/v1` manifest, checked at submission, independent ACCEPT review, and propagation/recovery checkpoints.

The manifest is tenant/category-bound and carries a canonical scope digest over provider, account, project and region references. It must include one current, complete and pagination-exhausted receipt for each of seven discovery source classes: tenant scope catalog, resource type catalog, IAM writer principals, replication/delivery, scheduled/delayed writers, restore/DR paths, and secondary external stores. Unknown store counts must be zero and every discovered store kind must be in the current catalog. The evidence signer now refuses to sign a sentinel `NOT_APPLICABLE` claim when these checks fail. Regression tests cover missing/duplicate sources, pagination gaps, stale evidence, scope mismatch, unknown kinds and a re-signed incomplete manifest; the propagation test asserts no adapter prepare/delete call occurs.

Implementation and operator format: [external-store inventory evidence manifest](external-store-inventory-evidence.md).

**Evidence boundary:** this validates the structure, freshness, tenant/category binding and digest integrity of an owner-attested evidence artifact. It does not independently query or authenticate cloud-provider APIs, establish that a malicious owner enumerated every account/region, or defeat privileged cloud/storage administrators. Provider-native discovery receipts, cross-account read-only discovery and independent infrastructure review remain separate acceptance requirements. AS-137 / NFR-PROD-14 remain **PARTIAL** until those real-world controls and provider staging are independently evidenced.
