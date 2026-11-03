# Tenant-wide export and erasure: WP10 closure batch (2026-11-03)

**Implementation status:** repository code and contract slice implemented on branch
feat/wp10-tenant-data-lifecycle-closure-20261103. Awaiting exact-head CI and review.
**Release status:** AS-137 / NFR-PROD-14 remain PARTIAL. This document does not
claim a production tenant export, customer-data deletion, or provider acceptance.

## 1. Scope and safety decision

This batch closes the code-level gaps that can be resolved without selecting
unidentified external providers or making destructive changes to production
data. It does not invent a search/vector vendor, a replica topology, a cloud
account scope, a retention jurisdiction, or an archive-purge authority.

A store/category may become eligible for propagation only when its reviewed
coverage decision, provider target, non-secret configuration reference,
complete inventory and provider-specific adapter all agree. A missing or
unconfigured adapter is a blocker, not an empty dataset and not a successful
receipt. Whole-request VERIFIED still requires each required target's exact
sealed resource manifest, idempotent delete outcome, independent read-back,
zero residuals, current retention-policy versions and a fresh legal-hold check.

No production erasure was invoked by this implementation.

## 2. Finance and usage ledger retention

The previous module registered SAAS_TENANT_FINANCE_RETENTION_ADAPTER with
useValue null. The module now registers
PostgresFinanceRetentionInventoryAdapter through useExisting.

Adapter identity:
- Key: postgresql.finance-usage-ledger.inventory.v1
- Version: 1.0.0
- Opt-in mode: FACTORYOS_FINANCE_RETENTION_MODE=INVENTORY_ONLY
- Global bound: 100,000 candidate rows for one tenant inventory run

The adapter inventories these 17 immutable or versioned PostgreSQL relations:

| Table | Age/cutoff anchor | Disposition |
|---|---|---|
| saas_usage_rate_cards | created_at | Retained immutable |
| saas_usage_events | occurred_at | Retained immutable |
| saas_usage_adjustments | created_at | Retained immutable |
| saas_usage_reconciliations | created_at | Retained immutable |
| saas_usage_budgets | created_at | Retained immutable |
| saas_budget_evaluations | evaluated_at | Retained immutable |
| saas_budget_alerts | created_at | Retained immutable |
| saas_budget_alert_acknowledgements | acknowledged_at | Retained immutable |
| saas_workload_control_events | created_at | Retained immutable |
| saas_provider_cost_events | occurred_at | Retained immutable |
| saas_provider_cost_reconciliations | created_at | Retained immutable |
| saas_billing_provider_accounts | created_at | Retained/versioned configuration |
| saas_billing_provider_account_events | created_at | Retained immutable |
| saas_billing_close_runs | created_at | Retained immutable |
| saas_billing_close_events | created_at | Retained immutable |
| saas_billing_provider_webhook_events | received_at | Retained immutable |
| saas_billing_reconciliation_results | created_at | Retained immutable |

Before scanning each relation, the adapter checks PostgreSQL catalogs for
relation existence, forced RLS, a tenant_id column, the configured cutoff
column, and an enabled trigger that guards DELETE. The candidate query always
uses the authenticated tenant ID and a parameterized cutoff/limit. Table and
column identifiers come only from the constant allowlist. No row payload,
customer identifier, provider token, credential, or connection string enters
the manifest. The manifest records table identity, bounded counts, scan
completeness, retention-policy version, cutoff, a digest of the legal-basis
label and the explicit retained disposition.

DRY_RUN produces the bounded inventory, manifest digest and independent
second-read digest without deleting any row. EXECUTE is intentionally
non-destructive: any aged immutable row produces a BLOCKED result with the
observed retained residual count and
FINANCE_LEDGER_IMMUTABLE_REQUIRES_APPROVED_ARCHIVE_PURGE. If the global bound
is exceeded, the inventory is explicitly incomplete and the run is blocked.
Only a complete inventory with zero candidates can produce a completed no-op
receipt. The adapter source contains no DELETE statement.

This is a safe PostgreSQL finance-retention inventory adapter, not an archive
purge adapter. Finance/business legal owners must select an archive class,
retention authority, export/preservation and restore procedure before an
archive/purge adapter can be designed. Existing immutable billing history
must not be weakened to force an artificial deletion PASS.

## 3. External store and copy-class disposition

The generic SPI already requires preflight, complete bounded prepare,
exact-manifest erase, independent verify and uncertain-attempt recovery.
Durable manifests and per-resource event records persist PREPARED,
DELETE_REQUESTED, DELETED, VERIFIED, FAILED_RETRYABLE, BLOCKED and RETAINED
evidence. The runner re-checks target inventory, retention versions and legal
holds before mutation.

| Store kind | Repository implementation | Current release boundary |
|---|---|---|
| OBJECT_STORAGE | Narrow WMS POD S3 adapter | Only the approved POD prefix/category and deployment configuration; staging still required |
| CACHE | TenantCacheService Redis adapter | Only the new application-owned standalone primary namespace; no replicas/cluster/failover or backup copies |
| SEARCH_INDEX | No provider selected/adapter registered | Required target cannot be approved; unresolved coverage blocks propagation |
| VECTOR_STORE | No provider selected/adapter registered | Required target cannot be approved; unresolved coverage blocks propagation |
| LEARNING_ARTIFACT | No provider selected/adapter registered | External/derived learning artifacts remain unresolved and block propagation |
| EXTERNAL_PROVIDER | Provider-specific data owner/provider not selected | Requires an explicit provider adapter and its own inventory/read-back |
| REPLICA | No complete replica/failover adapter | Every primary/replica/secondary scope must be inventoried; unsupported topology blocks |
| BACKUP | S3 version-level adapter plus writer-fence/producer inventory | Activation remains fail-closed until independent provider acceptance, exclusive policy ownership, all-writer coverage and restore/tombstone replay evidence pass |

The unclassified-store catch-all and signed external inventory evidence remain
mandatory. The signed inventory source receipt validates freshness, canonical
scope, pagination exhaustion and Ed25519 signer trust. It authenticates the
source's signed claims; it does not independently call the provider control
plane or prove that the collector discovered every cloud account, project,
region, endpoint or writer. A NOT_APPLICABLE coverage decision must have a
complete, independently trusted inventory; unresolved or newly discovered
store kinds block the request.

The current application-level provider verification paths independently
re-read WMS POD prefixes and Redis key/value namespaces. The S3 backup adapter
enumerates exact object versions/delete markers, verifies byte digests and
retention/legal-hold state, and reads back residuals, but its production target
remains disabled until the writer-fence acceptance references are independently
established. A provider-reported delete count alone is not a VERIFIED receipt.

## 4. AI learning and derived data inventory

The export source has bounded optional mappings:
- AI_CONTEXT: ai_decision_envelopes, ai_context_packages,
  ai_verification_runs, research_sources, research_claims, research_claim_links,
  research_knowledge_releases and research_relevance_mappings.
- LEARNING_EVALUATION: research_release_evaluations, growth_experiment_results
  and growth_opportunity_outcomes.

Those mappings are exact named PostgreSQL relations, not a claim that every
AI execution trace, agent evaluation, model feedback, rollout artifact,
derived feature, embedding, vector or learned model artifact is portable.
Earlier ownership review explicitly keeps unreviewed AI execution/outcome/
evaluation relations excluded or blocked. External AI learning artifacts are
the separate LEARNING_ARTIFACT store kind and remain unresolved until their
actual storage providers, keys, producer inventory, retention rules and
independent deletion/read-back are identified.

## 5. Tenant export categories and schema compatibility

The required transfer set is BUSINESS_DATA, AUDIT_LOG, EVIDENCE, APPROVALS,
EFFECTIVE_DATED_MASTER_DATA and IAM_ACCESS. The required PostgreSQL categories
have an explicit allowlist and logical IAM remapping adapter.

AI_CONTEXT and LEARNING_EVALUATION are optional, bounded adapters. They cover
only the table lists stated in the reviewed crosswalk; they do not imply
full AI lifecycle or all learning artifact coverage.

INTEGRATION_METADATA and FILE_REFERENCES have no PostgreSQL source adapters.
A request for either category returns ServiceUnavailableException before any
rows are emitted. It cannot return a synthetic empty category.

Migrations 214 and 215 enforce category completeness against both the
tenant-relation ownership inventory and a migration-owned exact adapter
registry. A category export is blocked if a tenant-owned row exists in an
excluded/unreviewed relation, if an adapter omits a reviewed relation, or if
the TypeScript relation list differs from the database registry. Migration 233
pins column-level schema manifests; a new or changed column fails export until
a reviewed contract version is appended and the runtime grant is present.

Schema validation accepts an EXACT version pair or a latest ACTIVE COMPATIBLE rule. This validation result does not transform rows: the current PostgreSQL target importer remains exact-schema only and rejects cross-version import even when a COMPATIBLE rule exists. A TRANSFORM_REQUIRED decision remains BLOCKED. Its opaque mapping reference alone is not a transformation engine. No cross-version target import is claimed until a real adapter transforms the row/column/category semantics and proves target counts, digests, recovery and rollback.

SaaS commercial billing provider accounts/events, billing-close records,
provider webhooks and reconciliation results are classified as protected
SAAS_CONTROL_PLANE relations rather than ordinary BUSINESS_DATA. They are
inventoried by the finance-retention adapter but are not silently copied or
deleted through the generic business-data adapter. A separate migration/
portability decision is required before those control-plane records become
transferable.

## 6. Tests and evidence added by this batch

- PostgreSQL finance adapter unit tests: configuration gate, 17-table
  inventory map, forced RLS/cutoff/DELETE-guard checks, bounded tenant-only
  count queries, independent digest read-back, no-DELETE assertion,
  immutable residual BLOCKED outcome and global bound handling.
- Finance service tests: mode binding, maker/reviewer/executor separation,
  legal-hold block, explicit adapter failure code and residual receipt.
- PostgreSQL contract extends the SaaS data-retention SQL gate to all 17
  finance/billing relations and requires forced tenant RLS plus enabled
  DELETE guards.
- Propagation service tests ensure SEARCH_INDEX, VECTOR_STORE,
  LEARNING_ARTIFACT, EXTERNAL_PROVIDER and REPLICA targets cannot be approved
  without matching selected adapters.
- External-erasure contract statically verifies finance adapter registration,
  no destructive SQL path, mode binding, residual handling and CI linkage.
- The export crosswalk retains explicit blocking tests/dispositions for
  INTEGRATION_METADATA and FILE_REFERENCES and exact column-contract checks.

The exact-head API, PostgreSQL, external-erasure, dependency-security and
traceability workflows must pass before this branch can be treated as an
accepted code candidate.

## 7. Outstanding operational acceptance (not closable by repository code)

The following require selected providers, authorized owners, deployed
credentials and controlled staging. They remain release blockers:

1. Select search and vector/index providers and enumerate each primary,
   replica, snapshot, index generation, tombstone queue and backup location.
2. Select the AI learning artifact store and enumerate its full writer,
   model/version, export and derived-copy lifecycle.
3. Select every external provider and establish exact account/project/region
   and tenant-to-resource identity mapping.
4. Prove all replica/failover/secondary destinations and all out-of-process
   writers, including provider IAM/replication principals.
5. Deploy the required adapters in controlled staging and perform synthetic
   export → digest verification → legal-hold recheck → deletion → independent
   read-back → residual reconciliation → recovery replay.
6. Obtain Finance/Data/Infrastructure/Security owner approvals for all
   legal-basis, retention, archive and preservation decisions. No finance
   archive purge is implemented by this batch.
7. Implement and test reviewed INTEGRATION_METADATA/FILE_REFERENCES source
   adapters and any actual TRANSFORM_REQUIRED schema mappings before those
   categories are supported.

Therefore Issue #284 remains OPEN and AS-137 / NFR-PROD-14 remain PARTIAL.
This is intentional: missing or unselected providers never count as deleted,
empty, not applicable or successfully verified.
