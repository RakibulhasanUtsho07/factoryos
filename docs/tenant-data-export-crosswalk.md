# Tenant export crosswalk: reviewed PostgreSQL source adapters

**Status:** repository adapter inventory and CI consistency contract. This document is not evidence of a production export, migration or tenant-wide erasure.

## Rules

- The PostgreSQL export source is a reviewed, explicit allowlist. It is not a generic table dumper and does not infer support from table names, foreign keys or inventory classification.
- The TypeScript source map, migration 156's `is_export_allowlisted` list and `services/api/test/tenant-data-governance-inventory.sql` must describe the same direct-table set. The API PostgreSQL CI runs `scripts/audit/tenant-data-export-crosswalk.test.mjs` to compare them in both directions and validate each relation's category.
- Direct tables in the allowlist must have an approved category adapter. Relations without a direct `tenant_id` are handled only through their explicit derived-scope ownership review and a dedicated logical adapter; they are not copied as arbitrary join rows.

## Direct PostgreSQL adapter map

### BUSINESS_DATA

- `legal_entities`
- `factories`
- `inventory_locations` — target factory-seeded default location is rebound under the dedicated transfer-import role; child locations are inserted parent-first.
- `traceability_settings` — factory-seeded composite-key row is reconciled by `(tenant_id, factory_id)` under the dedicated transfer-import role.
- `orders`
- `order_lines`
- `order_event_projections`
- `inventory_items`
- `inventory_stock_balances`
- `inventory_movements`
- `business_blueprints`
- `business_blueprint_versions`
- `business_entities`
- `business_relations`
- `business_processes`
- `business_process_steps`
- `business_rules`
- `business_terms`
- `business_exceptions`
- `business_change_proposals`
- `business_conflicts`
- `business_feedback`
- `growth_opportunities`
- `growth_scenarios`
- `growth_experiments`
- `saas_usage_events`
- `saas_usage_adjustments`
- `saas_usage_reconciliations`
- `saas_budget_evaluations`
- `saas_workload_control_events`
- `saas_budget_alerts`
- `saas_budget_alert_acknowledgements`
- `saas_provider_cost_events`
- `saas_provider_cost_reconciliations`

### AUDIT_LOG

- `audit_events`

### EVIDENCE

- `business_evidence`
- `business_evidence_links`
- `growth_opportunity_evidence`

### APPROVALS

- `approvals`

### EFFECTIVE_DATED_MASTER_DATA

- `risk_classes`
- `policies`
- `saas_usage_rate_cards`
- `saas_usage_budgets`

### AI_CONTEXT

- `ai_decision_envelopes`
- `ai_context_packages`
- `ai_verification_runs`
- `research_sources`
- `research_claims`
- `research_claim_links`
- `research_knowledge_releases`
- `research_relevance_mappings`

### LEARNING_EVALUATION

- `research_release_evaluations`
- `growth_experiment_results`
- `growth_opportunity_outcomes`

## IAM access: logical remapping, not raw table copying

The `IAM_ACCESS` source uses a dedicated tenant-scoped logical adapter rather than the direct-table map. It reads `tenant_memberships` and `roles` as direct tenant relations and reads `user_roles` and `role_permissions` through derived membership/role scope. It emits only the normalized logical records `iam_memberships`, `iam_roles`, `iam_user_roles` and `iam_role_permissions` (stable user/role/factory/permission codes), after rejecting inconsistent cross-tenant assignments.

Migration 156 includes the two direct relations `tenant_memberships` and `roles` in its direct inventory allowlist. Migration 159 permits the derived `user_roles` and `role_permissions` records only for this logical remapping path; the generic ownership ledger keeps new FK-derived relations excluded from generic export and blocked from generic erasure.

## Foreign-key export and restore ordering

The source reader streams the reviewed table arrays inside one read-only `REPEATABLE READ` snapshot. Stream order is not treated as a referential-integrity guarantee: the target importer stages and validates all rows before inserting any destination table.

For each import, the target adapter reads the destination database's actual `pg_constraint` catalog and derives a stable parent-before-child order from non-deferrable foreign keys whose two endpoints are in the current import set. There is no second hand-maintained preferred-order list. Deferrable constraints are deferred with `SET CONSTRAINTS ALL DEFERRED` and checked by PostgreSQL at commit. References outside the import set must already be provisioned in the destination; the destination FK remains authoritative.

Four migration-defined immediate FK patterns have dedicated, narrowly named strategies:

- **Blueprint current pointer:** `business_blueprints.current_version_id` references `business_blueprint_versions`, while each version references its blueprint. The importer inserts the blueprint with a null `current_version_id`, inserts the versions, then restores the pointer. Only `fk_business_blueprints_current_version` on the `current_version_id` column is removed from the table-order graph.
- **Research release evaluation:** `research_knowledge_releases.evaluation_id` references `research_release_evaluations`, while each evaluation references its release. A release with a non-null evaluation pointer is staged as `DRAFT` with a null pointer; the evaluation rows are inserted next; then the original release status and evaluation pointer are restored together so the release guard can verify the attached passing evaluation. If any staged release carries an evaluation pointer but `research_release_evaluations` is absent from the import set, import fails before destination inserts. Therefore an export containing attached research releases must include the `LEARNING_EVALUATION` category as well as `AI_CONTEXT`.
- **Inventory-location parent hierarchy:** `inventory_locations.parent_location_id` is a same-tenant/factory self-reference. The importer rebinds the factory-generated default row first, then inserts non-default rows in a recursive parent-depth order. Only `fk_inventory_location_parent_scope` with ordered child columns `(parent_location_id, tenant_id, factory_id)` and parent columns `(id, tenant_id, factory_id)` is removed from the table-order graph; the `factories → inventory_locations` FK remains and still requires factories first.
- **Evidence predecessor chain:** `business_evidence.supersedes_evidence_id` is a self-reference, and migration 131's `BEFORE INSERT` guard requires the predecessor to exist and be the latest earlier revision. Evidence rows are therefore inserted in factory/source/revision order, not UUID or stream order. The same ordered insert also keeps each self-referencing FK check within its table statement.

Research release rows are also inserted in `release_key`/`version` order because migration 142 enforces a monotonically increasing version sequence on every insert. These are row-level guard requirements in addition to the table-level FK graph.

The PostgreSQL dependency contract verifies that the four exact FK exceptions still exist in the live catalog, including the ordered child-to-parent column mapping on both sides of each composite constraint. Runtime cycle exceptions use the same exact ordered mappings; a matching constraint name with an added, reordered or redirected column is not exempt. The contract also checks the remaining adapter-table graph for any other non-deferrable cycle. The unit tests cover parent ordering, multiple/deferrable edges, all four reviewed exceptions, and unknown self or multi-table cycles.

Any unrecognized cycle or malformed catalog response fails closed before table inserts. The import transaction rolls back; the importer does not guess an order or silently skip a constraint. This is a repository/CI acceptance contract, not evidence that a real provider migration or production tenant restore has been accepted.

## Column-level export contract and schema-drift gate

The generic PostgreSQL adapter still uses its reviewed table allowlist, but a table allowlist alone is not a column allowlist: a later migration could add a sensitive or otherwise unreviewed field to an already-approved table while `SELECT *` silently begins exporting it.

Migration `233_tenant_export_column_contract.sql` closes that schema-drift path for the generic direct-table adapters:

- It records a versioned JSONB snapshot for each generic export relation in `factoryos_governance.tenant_export_column_contracts`. The snapshot binds the data category and each live column's ordinal, name, PostgreSQL formatted type, nullability, identity/generated flags, default expression and collation.
- Contract rows are append-only. A database trigger rejects UPDATE and DELETE; the API runtime role receives SELECT only. A new reviewed contract is a new version, not an in-place edit.
- Before yielding any row for a generic category, the API reads the complete catalog shape for every table in that category and compares it with the latest reviewed version. Missing contracts, changed categories, added/dropped/renamed/reordered columns, type/nullability/default/identity/generated/collation drift, missing tables or unexpected catalog results block the category with a service-unavailable response. It does not export part of a category before discovering drift in a later table.
- IAM remains on its dedicated stable-code logical remapping path and is not changed by this generic table snapshot.

The PostgreSQL contract test verifies the baseline against the live catalog, confirms mutation protection, then adds a synthetic unreviewed column to `public.orders` inside a rollback-only subtransaction and proves the manifest comparison becomes false. The DDL probe is rolled back and cannot leave the test schema altered.

The runtime database role needs only `USAGE` on `factoryos_governance` and `SELECT` on `tenant_export_column_contracts`; it does not receive access to the broader ownership or privacy inventory. Migration 233 grants these when `factoryos_app` already exists. Where infrastructure provisions the application login after migration replay, run `scripts/security/grant-tenant-export-column-contract-runtime-access.sql` after role creation. The script fails when the expected role or manifest table is absent, so provisioning cannot silently skip the grant.

### Safe schema-change procedure

Do not refresh an existing manifest during application startup or ordinary migration replay. When a reviewed change to an exportable table is needed, use a later numbered migration to append a new contract version for only the affected table(s), after reviewing the field's data classification, tenant scope, serialization, portability, retention/erasure disposition and target-import behavior. Preserve the earlier version for audit. A routine column addition without that explicit review must fail closed.

This contract protects against structural drift after its baseline. It is not a semantic data-classification system: it does not inspect JSONB keys or discover secrets inside existing fields, and a baseline is not a substitute for Security/Data-Owner review of the field meanings. Optional AI categories remain bounded as already described above; this gate does not turn them into required full AI lifecycle coverage.

## Explicitly unsupported categories

- `INTEGRATION_METADATA` — no PostgreSQL source adapter is registered.
- `FILE_REFERENCES` — no PostgreSQL source adapter is registered.

For both categories the source raises `ServiceUnavailableException` before emitting any rows. An empty result, an inventory label, or an external reference is not a substitute for a reviewed category adapter. These categories must remain outside the required transfer set until adapter mapping, tenant scope, dependency order, serialization and recovery behavior are reviewed and tested.

## Optional, bounded adapters

`AI_CONTEXT` and `LEARNING_EVALUATION` have explicit source mappings above, but are not in `REQUIRED_TRANSFER_CATEGORIES`. Their presence covers only the named relations; it does not prove complete export of every AI execution, outcome, evaluation or derived artifact. Keep those requirement rows PARTIAL until the source owners reconcile the full AI data inventory and acceptance evidence.

## Change protocol

When adding, removing or moving a table:

1. Update `SAAS_TENANT_DATASET_TABLES` and the PostgreSQL source/serialization tests.
2. Update migration 156's direct allowlist and the `category := CASE` classification; do not add an unknown relation by naming convention.
3. Update the exact allowlist in `services/api/test/tenant-data-governance-inventory.sql`.
4. For relations without `tenant_id`, update migration 159 only after documenting FK-derived scope or an explicit global/shared decision; keep unsupported relations denied.
5. Update this document and preserve the independent logical IAM mapping where applicable.
6. Run the crosswalk contract plus the full API PostgreSQL suite on the exact candidate SHA.

A passing crosswalk proves repository-list consistency only. It does not turn a table into an approved legal-retention class, prove provider copies were enumerated, or establish whole-tenant export/erasure. AS-137 / NFR-PROD-14 remain **PARTIAL** until all required local and external categories have their own approved adapters and independently verified release evidence.
