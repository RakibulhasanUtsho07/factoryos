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

For each import, the target adapter reads the target database's actual `pg_constraint` catalog and derives a stable parent-before-child order from non-deferrable foreign keys whose two endpoints are in the current import set. It does not trust a second hand-maintained preferred-order list. Deferrable constraints are deferred with `SET CONSTRAINTS ALL DEFERRED` and are checked by PostgreSQL at commit. References to relations outside the import set must already be provisioned in the destination (for example, the tenant's shared identity principals); the destination FK remains authoritative.

The one reviewed immediate cycle is `business_blueprints.current_version_id` → `business_blueprint_versions`, while each version references its blueprint. The first blueprint insert explicitly projects `current_version_id = NULL`; after all versions have been inserted, the importer restores the original pointer from the staged payload. The PostgreSQL dependency contract verifies that this exact immediate FK still exists and checks the live adapter-table graph for any other non-deferrable cycle.

An unrecognized non-deferrable cycle or malformed catalog response fails closed before any table insert. The import transaction rolls back; it does not guess an order or silently skip a constraint. The dependency-order algorithm has unit coverage for parent ordering, multiple FKs, deferrable edges, the exact blueprint pointer exception and unexpected cycles.
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
