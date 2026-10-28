# SaaS Productization — WP10 Backend Slice

**Requirements traceability:** SRS v2.1 FR-SAAS2-02 (P0), FR-SAAS2-06 (P1), FR-SAAS2-07 (P1), FR-SAAS2-08 (P1), FR-PROD-04 (P0), FR-PROD-05 (P0), and the tenant-wide portion of FR-PROD-15 (P0).  
**Core control-plane migrations:** 045–053; retention/legal-hold/erasure prerequisites: 149–150; precision hardening: 153; explicit subscription-enforcement mode: 154; bounded retention execution and erasure receipts: 155; schema-wide relation inventory and restrictive RLS fences: 156. Other WP10 infrastructure/governance slices are indexed by the migration manifest and are not limited to the core range.  
**API bases:** /v2/saas/usage, /v2/saas/subscriptions, /v2/saas/sandboxes, /v2/saas/releases, /v2/saas/deployment-profiles, /v2/saas/data-transfers, and /v2/saas/data-retention.

## Delivered in this slice

- Tenant-scoped usage events for active users, role assignments, transactions, storage byte-hours, telemetry events, AI input/output tokens, AI tool calls, premium workloads, integration calls, and edge inference.
- Effective-dated immutable rate cards. Event pricing selects the rate in effect at occurred_at and snapshots its version, currency, block size, and rate onto the event so later rate changes do not rewrite historical unit economics. Quantities and rate block sizes are normalized against the database's six-decimal NUMERIC contract; cost-in-minor-unit rounding uses BigInt fixed-point arithmetic rather than binary floating-point division.
- Idempotency keys and request fingerprints for usage, rate changes, adjustments, and invoice reconciliation. Reusing a key with a different request is a conflict rather than a second charge.
- Usage reports, reconciliation reports against an external invoice, and explicit, reason-coded adjustments. Billing/invoicing remains an external commercial boundary; this API does not issue invoices or treat provider invoices as FactoryOS source-of-record financial facts.
- Effective-dated tenant/factory budgets with soft/hard limits, anomaly checks, durable alerts, acknowledgement records, and controls restricted to non-critical workload classes. After usage ingestion (including an idempotent duplicate or late-arriving historical event), the budget check is evaluated at processing time; the event's original occurred_at and rate snapshot remain unchanged for the historical ledger.
- Idempotent AI tool-call metering in the governed Tool Gateway. Tool workload classification comes from registered tool metadata, not caller-supplied request fields. Usage is recorded before the budget-control check; only registered non-critical classes can be paused by this mechanism. PRODUCTION and NON_AI workloads are not pause targets.
- PostgreSQL row-level security and tenant/factory-scoped foreign keys on the metering, budget, alert, and provider-cost records. Billing totals, budget aggregates, provider invoice sums and variances use exact integer arithmetic; aggregate columns use NUMERIC(30,0) or NUMERIC(34,4) where a valid aggregate can exceed BIGINT or JavaScript's safe-integer range.
- The PostgreSQL ownership-review contract now cross-checks migration 159's ownership ledger against migration 156's privacy inventory: stale review rows, missing direct-scope mappings, drifted export/erasure dispositions, and integration-metadata/file-reference rows that bypass the unconfigured-adapter fail-closed boundary stop CI. This is schema-contract evidence only; it does not configure a real provider adapter or close staging acceptance.
- Each requested PostgreSQL export category now calls a narrowly granted SECURITY DEFINER completeness guard inside the same repeatable-read snapshot. If the current tenant has rows in an excluded direct-tenant relation assigned to that category, export fails closed rather than emitting a count/hash manifest that falsely implies complete coverage; the runtime role receives no direct SELECT access to privacy/ownership governance ledgers.
- AI runtime traces (`agent_tasks`, steps, action attempts and handoffs), agent definitions/grants, rollout drafts, execution claims/reconciliations, operational controls, agent evaluation cases/results, operational evaluations, decision lifecycle events and AI evidence references are explicitly kept outside the curated transfer allowlist. Their inventory and ownership-review records must remain `EXCLUDED` / `BLOCKED_UNREVIEWED` until a category-specific source/target adapter, retention policy and independent receipt are approved. The PostgreSQL contract test fails if any of these relations disappear from the crosswalk or become generically exportable/deletable.
- Migration 156 maintains an inventory entry for every public base/partition relation. Direct `tenant_id` relations receive ENABLE/FORCE RLS and a restrictive current-tenant fence while preserving existing permissive policies; command-specific global registries such as `ai_tool_registry` retain their explicitly tested SELECT-only global-read and tenant-only INSERT contract. `user_roles`/`role_permissions` are derived-scope relations; every other relation without a direct `tenant_id` defaults to excluded/unreviewed and erasure-blocked until its ownership is documented. `services/api/test/tenant-data-governance-inventory.sql` checks completeness, policies, allowlist alignment and finance-ledger erasure exclusions.
- AuditService recursively redacts common secret/credential and non-count token fields by JSON key in both standalone and transaction-bound audit writes; callers must still avoid placing sensitive values in audit payloads and use data-classification appropriately.
- api-postgres-ci.yml applies the complete ordered SQL migration manifest (currently including 153–156), reapplies precision, entitlement, retention/erasure and privacy-inventory migrations for idempotency checks, and runs the SaaS money-precision, entitlement-enforcement, retention-governance and cross-tenant isolation PostgreSQL contract checks alongside the API unit/integration suite.
- Versioned, tenant-scoped subscription plans use an explicitly configured tier_rank so the service can validate upgrade/downgrade direction without inventing plan prices. Deployment profile is recorded as control-plane metadata; billing remains external.
- Subscription state is guarded by a database transition trigger and an immutable event ledger. A deferred constraint trigger prevents state/version updates from committing unless a matching lifecycle event is written in the same transaction. Terminal subscriptions cannot be reactivated; a new subscription can be started after termination/expiry.
- Lifecycle operations use optimistic expected_version checks, tenant-row locking, idempotency request hashes, IAM authorization in both the controller and service, and best-effort audit records after the state/event transaction.
- Versioned retention policies, tenant-scoped legal holds, independent export-preservation attestations, dual-control erasure approvals and immutable retention/erasure execution receipts use forced RLS, expected versions, idempotency keys and transactional audit evidence. Migration 155 expands the erasure state machine to APPROVED → EXECUTING → VERIFIED only when the exact successful receipt and manifest digest are committed with the data changes.
- Retention DRY_RUN / EXECUTE operations validate the exact policy version, tenant RLS policy, relation scope, timestamp anchor, legal holds, dependency graph and per-run row bound before deletion. Unknown categories, missing adapters, protected classes, anonymization without a dedicated adapter, unreviewed DELETE triggers and dependent rows fail closed with BLOCKED evidence rather than an unrestricted table delete.
- The PostgreSQL acceptance workflow applies the ordered migration manifest through 156, reapplies migrations 155 and 156 for receipt/policy idempotency, and executes `saas-data-retention-contract.sql`, `saas-tenant-isolation-matrix.sql`, and `tenant-data-governance-inventory.sql`. The API isolation integration suite discovers direct `tenant_id` relations dynamically. Automated acceptance still requires a green run on the exact commit.

## API surface

All routes require a verified request identity and the corresponding IAM permission.

| Route | Permission | Purpose |
|---|---|---|
| POST /rates and GET /rates | saas.rates.write / saas.usage.read | Create/list immutable effective-dated rates |
| POST /events | saas.usage.write | Ingest an idempotent metering event |
| GET /report | saas.usage.read | Summarize usage and priced/unpriced amounts |
| POST /adjustments | saas.adjustments.write | Append an auditable usage/cost correction |
| POST /reconciliations and GET /reconciliations | saas.reconciliation.write / saas.usage.read | Compare the internal usage ledger with an external invoice |
| POST /budgets and GET /budgets | saas.budgets.write / saas.budgets.read | Version budget policies |
| POST /budgets/evaluate and GET /budgets/evaluations | saas.budgets.read | Evaluate spend and list immutable results |
| POST /workloads/control and GET /workloads/controls | saas.workloads.control / saas.budgets.read | Pause/resume only supported non-critical AI classes |
| GET /alerts and POST /alerts/:alertId/acknowledgements | saas.alerts.read / saas.alerts.ack | List and acknowledge durable alerts |
| POST /provider-costs/events and POST /provider-costs/reconciliations | saas.provider_costs.write / saas.provider_costs.reconcile | Record and reconcile provider-reported cost |

## Tenant data governance, retention and erasure

All routes use the authenticated request tenant/user, not tenant or actor IDs supplied in the request body.

| Route | Permission | Purpose |
|---|---|---|
| POST /v2/saas/data-retention/policies | saas.data_retention.write | Create an immutable, versioned retention policy for a category |
| GET /v2/saas/data-retention/policies and /policies/history | saas.data_retention.read | Read the current policy version and prior versions |
| POST /v2/saas/data-retention/legal-holds | saas.data_retention.write | Place category-scoped legal hold evidence |
| POST /v2/saas/data-retention/legal-holds/:holdId/release | saas.data_retention.approve | Release a hold with distinct reviewer and reason |
| POST /v2/saas/data-retention/exports/:transferId/preservation-attestation | saas.data_retention.approve | Bind independent preservation evidence to an exact completed export and digest |
| POST /v2/saas/data-retention/erasure-requests | saas.data_retention.write | Request erasure only for categories present in a matching preserved export and not held |
| POST /v2/saas/data-retention/erasure-requests/:requestId/review | saas.data_retention.approve | Approve/reject with optimistic version and requester/reviewer separation |
| POST /v2/saas/data-retention/policies/:categoryCode/run | saas.data_retention.execute | Run DRY_RUN or bounded, guarded retention execution |
| POST /v2/saas/data-retention/erasure-requests/:requestId/execute | saas.data_retention.execute | Execute an approved, eligible erasure request with separate executor |
| GET /v2/saas/data-retention/runs | saas.data_retention.read | List tenant-scoped retention run receipts |
| GET /v2/saas/data-retention/erasure-requests/:requestId/runs | saas.data_retention.read | List immutable erasure execution receipts |

The database run ledger stores category/policy version, mode, cutoff, examined/eligible/deleted counts, a per-table manifest and digest. An erasure request is VERIFIED only when its exact tenant/request/version has a committed COMPLETED receipt with the same manifest digest. Requester, reviewer, and executor are three different actors. The executor rechecks the preservation attestation and active legal holds in its transaction and uses RLS plus explicit tenant predicates, table metadata checks, foreign-key dependency ordering and exact preflight-versus-delete counts.

Broad `BUSINESS_DATA` deletion and retention execution must not implicitly purge SaaS metering, billing reconciliation, provider-cost, budget evaluation/alert, or rate-card/budget control tables. The execution receipt carries exact `retainedTables`, `retainedRows` and a reason for these exclusions; if a general BUSINESS_DATA retention cutoff would touch those ledgers, execution is blocked. A dedicated finance-specific retention class/adapter must be designed and approved before these records can be deleted automatically.

**Erasure is bounded, not synonymous with wiping every copy.** Only reviewed PostgreSQL table mappings in BUSINESS_DATA, EVIDENCE, AI_CONTEXT, and LEARNING_EVALUATION are eligible; tables with an unreviewed DELETE trigger, incomplete RLS/time anchor, unresolved foreign-key dependencies, protected disposition, or too-large scope are blocked. Immutable audit, approval, effective-dated and IAM access records are protected. Object storage, caches/search indexes, replicas, external providers and backups require separate adapters/configuration; successful SQL erasure receipts do not prove those copies are purged. Retention durations and legal basis must be approved by the relevant policy owner.

See `docs/tenant-data-governance-and-isolation.md` for the audit/isolation matrix, scope boundaries and remaining release gates. Migration 156 does not represent whole-tenant erasure: non-direct tenant ownership beyond the known IAM relations and external storage/cache/index/replica/backup copies still require reviewed adapters and explicit acceptance evidence.
## Subscription lifecycle API

All endpoints require verified tenant/user context and the listed IAM permission.

| Route | Permission | Purpose |
|---|---|---|
| POST /v2/saas/subscriptions/plans | saas.subscription_plans.write | Add an immutable version of a tenant plan |
| GET /v2/saas/subscriptions/plans | saas.subscription_plans.read | List each plan's latest version |
| POST /v2/saas/subscriptions | saas.subscriptions.write | Start a trial for an active plan |
| GET /v2/saas/subscriptions/current | saas.subscriptions.read | Get the latest subscription record |
| GET /v2/saas/subscriptions/:id/events | saas.subscriptions.read | Read append-only lifecycle history |
| POST /v2/saas/subscriptions/:id/transitions | saas.subscriptions.write | Activate, suspend, resume, upgrade, downgrade, renew, terminate or expire |
| GET /v2/saas/subscriptions/entitlement-mode | saas.entitlement_modes.read | Read the explicit or implicit tenant enforcement mode/version |
| POST /v2/saas/subscriptions/entitlement-mode | saas.entitlement_modes.write | Record an idempotent, version-checked tenant migration to subscription-required enforcement |

Transitions require expected_version and idempotency_key. ACTIVATE, RESUME and RENEW require period bounds; upgrade/downgrade require a target plan whose configured rank is respectively greater/lower than the current rank. Future-dated transitions are rejected because a scheduler is not part of this slice. EXPIRE is accepted only when the trial or active billing period has reached its boundary. Stale versions and reuse of an idempotency key with a different request are rejected.

## Subscription-aware entitlement enforcement

Entitlement resolution and runtime feature-flag evaluation now consult the tenant's latest subscription record. Suspended, terminated, or expired subscriptions, expired trials, and active subscriptions outside their effective billing period cannot resolve an active entitlement or enabled feature flag. Feature-flag evaluation preserves the established safe default (disabled) when there is no effective row or evaluation fails.

Plan capability grants are top-level canonical dotted keys in the immutable plan `capabilities` JSON object (for example, `"ai.runtime": true`, `"research.ingestion": true`). `SaasSubscriptionService.assertCapabilityAvailable(tenantId, capabilityCode)` is the shared live resolver. A listed capability is granted only when its value is exactly boolean `true`; explicit false/non-true values deny it even while a subscription is active. Under `SUBSCRIPTION_REQUIRED`, missing capability keys are denied; in `LEGACY_COMPATIBLE` mode, absent keys preserve prior capability behavior until tenants and plan capabilities are migrated. This is a controlled compatibility contract, not a silent default grant for newly enforced tenants.

The governed AI Tool Gateway re-checks the current subscription and the `ai.runtime` capability immediately before usage metering and execution. If a subscription is not eligible or the plan denies the capability, it rejects the action before tool side effects and before charging a tool-call usage event; non-critical workload budget controls remain an additional independent gate.

**Migration compatibility and explicit enforcement rollout:** a tenant with no explicit mode row defaults to `LEGACY_COMPATIBLE` at implicit version 0, preserving existing behavior until it is deliberately onboarded. `GET /v2/saas/subscriptions/entitlement-mode` returns the current mode/version. `POST /v2/saas/subscriptions/entitlement-mode` performs an IAM-authorized, idempotent, expected-version transition with an audit event. Moving to `SUBSCRIPTION_REQUIRED` is permitted only after the tenant has an unexpired trial or active billing period; the database re-checks this precondition. Once enabled, the mode cannot be downgraded to legacy compatibility. Premium AI entitlement is resolved from the latest subscription and enforcement mode on each runtime check; no stale entitlement cache is used. This enables controlled tenant-by-tenant rollout instead of either surprise-blocking existing tenants or leaving compatibility implicit forever.

## Boundaries and remaining WP10 work

These are the metering/FinOps, subscription lifecycle, sandbox governance, release-control, deployment-profile, and tenant export/migration compatibility backend slices, not a claim that all of WP10 is complete. Explicit tenant migration away from legacy entitlement compatibility is implemented with optimistic versioning, an immutable audit-ready mode ledger, subscription eligibility checks and a database downgrade guard. Remaining production acceptance includes a real billing/invoicing provider adapter, jurisdiction-specific accounting/tax and billing-close procedures, the physical sandbox provisioner/data adapter that creates truly isolated storage, and actual infrastructure orchestration behind deployment-profile transitions. A verified internal usage ledger is not an issued invoice, and a deployment-profile record is not proof that infrastructure has been provisioned.

## Tenant export and migration compatibility

Migration `052_saas_tenant_export_migration.sql` implements **FR-SAAS2-08** as a tenant-scoped export/compatibility control plane. It records versioned export requests, immutable worker-attested bundle manifests, explicit source/target schema compatibility rules, migration validation decisions, and append-only migration lifecycle snapshots. Tenant RLS, idempotency fingerprints, schema-version checks, audit records and optimistic expected-version checks apply throughout.

Every export requires the following dataset categories: `BUSINESS_DATA`, `AUDIT_LOG`, `EVIDENCE`, `APPROVALS`, and `EFFECTIVE_DATED_MASTER_DATA`. Tenants may also request `AI_CONTEXT`, `LEARNING_EVALUATION`, `INTEGRATION_METADATA`, and `FILE_REFERENCES`. Each category manifest contains a record count and SHA-256 digest. Artifact references are opaque identifiers only; the API rejects URLs, paths, credential fields and raw data payloads.

| Route | Permission | Purpose |
|---|---|---|
| POST /v2/saas/data-transfers/compatibility-rules | saas.data_transfers.write | Register a versioned source/target schema compatibility decision |
| GET /v2/saas/data-transfers/compatibility-rules | saas.data_transfers.read | List the latest compatibility rule for each schema pair |
| POST /v2/saas/data-transfers/exports | saas.data_transfers.write | Request an export with mandatory preservation categories |
| POST /v2/saas/data-transfers/exports/:transferId/attest | saas.data_transfers.execute | Attach an export bundle reference, digest, and category manifest |
| POST /v2/saas/data-transfers/exports/:transferId/process | saas.data_transfers.execute | Run the configured export source adapters, write an encrypted bundle, calculate digests, and attest it |
| POST /v2/saas/data-transfers/migrations/:transferId/process | saas.data_transfers.execute | Decrypt and verify the source bundle, invoke the target importer, then persist its target manifest |
| POST /v2/saas/data-transfers/migrations/validate | saas.data_transfers.write | Compare the completed export's schema to the target and persist VALIDATED/BLOCKED outcome |
| POST /v2/saas/data-transfers/migrations/:transferId/transitions | saas.data_transfers.execute | Start, complete, fail, or cancel a validated migration |
| GET /v2/saas/data-transfers | saas.data_transfers.read | List the latest export/migration snapshot |
| GET /v2/saas/data-transfers/:transferId/history | saas.data_transfers.read | Read immutable transfer history |

A target schema is accepted only when the schema version is identical or a latest ACTIVE compatibility rule explicitly declares it COMPATIBLE. Missing rules fail closed; INCOMPATIBLE or TRANSFORM_REQUIRED mappings are persisted as BLOCKED until a separately governed transformation path exists. Before migration completion, the target manifest must include all required categories, and record counts for audit logs, evidence, approvals, and effective-dated master data must match the source manifest. The target bundle must have a SHA-256 digest and an explicit preservation attestation.

**Data adapter boundary:** this slice governs metadata and migration validation; it does not itself stream database rows or upload archive files. A controlled export/migration worker must read tenant-scoped authoritative stores, construct and encrypt the actual bundle, calculate the category/bundle digests, verify the target contents, and only then call the attest/transition routes. Bundle storage, key management, backups, actual schema transformations, and cross-infrastructure transfer remain adapter responsibilities. This avoids pretending that a manifest alone is the exported customer data.


### Encrypted bundle worker boundary

The export worker serializes tenant-scoped dataset adapters as canonical JSON, computes per-category record counts and SHA-256 hashes, compresses the payload with GZIP, and encrypts the stream with AES-256-GCM. The encrypted file is written atomically to a private local spool directory with restrictive file/directory permissions. The stored bundle digest is over the full encrypted artifact, including framing and the authentication tag; source bytes are never returned in the HTTP response. A migration worker verifies the encrypted artifact digest and AEAD authentication before passing the decrypted stream to the target adapter. It records target bundle references only after the importer returns a target digest and measured manifest.

To enable local-spool execution, set `SAAS_TRANSFER_BUNDLE_DIR` to a persistent private directory and `SAAS_TRANSFER_ENCRYPTION_KEY_BASE64` to a KMS-managed 32-byte key encoded in Base64. Production multi-replica deployments must provide a shared durable encrypted bundle store or object-storage adapter and manage key rotation/recovery through their KMS process; do not bake keys into the repository or CI variables. The local store deliberately refuses to start a transfer when these values are absent or invalid.

Domain-specific dataset source adapters and a target migration importer are injected through `SAAS_TENANT_TRANSFER_DATASET_SOURCE` and `SAAS_TENANT_MIGRATION_TARGET_ADAPTER`. No default adapter is registered in this slice because FactoryOS domains must explicitly define their exportable records and tenant-scoped read semantics; without them, the worker returns a service-unavailable response and does not mark an export/migration successful. The worker rejects records with an explicit tenant_id/tenantId outside the authenticated tenant and fails closed when common credential/secret field names appear. Adapters must filter tenant-scoped tables correctly, exclude secrets not represented by conventional field names, and independently verify target counts/digests. The PostgreSQL source adapter provides a single consistent source snapshot across all selected categories. The encrypted bundle store is injectable through `SAAS_ENCRYPTED_TENANT_BUNDLE_STORE`, so a durable object-storage implementation can replace the local spool. The worker is an explicit API-triggered operation rather than an unbounded background job; large production migrations should be delegated to a durable queue/worker runner using the same idempotent transfer ledger.


## Deployment profile administration

Migration `051_saas_deployment_profiles.sql` implements **FR-SAAS2-07** as a separate, append-only deployment topology registry. It distinguishes `SHARED_SAAS`, `SINGLE_TENANT`, `DEDICATED_VPC`, and `HYBRID_EDGE_CLOUD`, with tenant-wide and factory-scoped assignments. Profile lifecycle snapshots are versioned with idempotency fingerprints, optimistic `expected_version` checks, tenant RLS, scoped factory foreign keys, database-enforced lifecycle transitions, and an immutable-row guard. Deployment references are opaque identifiers only; URLs, credentials, arbitrary paths and secret payloads are rejected.

| Route | Permission | Purpose |
|---|---|---|
| POST /v2/saas/deployment-profiles | saas.deployment_profiles.write | Register a tenant or factory deployment profile in PLANNED state |
| GET /v2/saas/deployment-profiles | saas.deployment_profiles.read | List the latest profile snapshot for each scope |
| GET /v2/saas/deployment-profiles/effective | saas.deployment_profiles.read | Resolve an ACTIVE factory profile first, then the active tenant profile |
| GET /v2/saas/deployment-profiles/tenant/history | saas.deployment_profiles.read | Read tenant-wide profile history |
| GET /v2/saas/deployment-profiles/factories/:factoryId/history | saas.deployment_profiles.read | Read factory-scoped profile history |
| POST /v2/saas/deployment-profiles/tenant/transitions | saas.deployment_profiles.control | Provision, activate, pause, resume, fail, migrate or retire tenant profile |
| POST /v2/saas/deployment-profiles/factories/:factoryId/transitions | saas.deployment_profiles.control | Apply the same lifecycle to a factory profile |

Non-shared profiles require a non-secret `deployment_reference` before activation; hybrid edge-cloud profiles also require an `edge_site_code`. Migration is represented as a controlled state transition: a destination profile/reference is registered first, the assignment enters `MIGRATING`, and completion writes a new immutable active snapshot. Resolution returns only the latest ACTIVE assignment, prefers factory over tenant scope, and explicitly reports `tenantSemanticsChanged: false`. The profile registry is not an infrastructure provisioner or data-migration engine: an external orchestration adapter must perform and verify infrastructure changes before sending ACTIVATE or COMPLETE_MIGRATION. Tenant identity, auth context and RLS boundaries remain unchanged.


AI token counts must be emitted by the actual approved model/provider adapter once such calls execute; the Tool Gateway integration in this slice meters registered tool calls and does not fabricate token usage for deterministic code paths.


## Sandbox environment governance

Migration `049_saas_sandbox_environments.sql` adds a tenant-scoped sandbox control-plane registry for **FR-SAAS2-04**, **FR-PPX-01**, **FR-PPX-04** and **FR-PPX-05**. Definitions and provenance manifests are immutable; lifecycle versions are guarded by PostgreSQL and every change must commit with a matching append-only event. Both tables use forced tenant RLS and tenant-aware foreign keys.

The `/v2/saas/sandboxes` API requires verified request identity and IAM authorization:

| Route | Permission | Purpose |
|---|---|---|
| POST /v2/saas/sandboxes | saas.sandboxes.write | Register a synthetic or masked-data sandbox definition |
| GET /v2/saas/sandboxes | saas.sandboxes.read | List tenant-owned sandbox metadata |
| GET /v2/saas/sandboxes/:id/events | saas.sandboxes.read | Read append-only lifecycle history |
| POST /v2/saas/sandboxes/:id/approve-masked-data | saas.sandboxes.approve_masked_data | Approve or renew masked-data use with an expiry |
| POST /v2/saas/sandboxes/:id/transitions | saas.sandboxes.control | Suspend, resume or retire an environment |

Synthetic environments require a generator/version, schema version, deterministic seed and record count; the registry rejects unrecognized manifest fields so customer rows cannot be posted into this API. Masked data requires an opaque dataset reference, schema version, masking-policy version, mask timestamp, SHA-256 checksum, a privacy assessment, reviewed field identifiers, and residual risk no higher than MEDIUM. Such environments start in `PENDING_APPROVAL`; a different user must approve them with a reason and an expiry no more than 90 days away. Approval expiry is evaluated by a live guard; an expired approval blocks access even if the stored lifecycle status still says ACTIVE. Idempotency keys, expected-version checks, IAM checks, audit events and an immutable lifecycle ledger protect state changes.

**Provisioning boundary:** this commit implements the governed control-plane contract and its database integrity. It intentionally does not clone customer databases, copy source data, create separate schemas/instances, or run a synthetic-data generator. The sandbox provisioning/data adapter must call `SaasSandboxService.assertSandboxUsable(tenantId, environmentId)` before opening an environment and must provide the actual storage/network isolation. The registry stores manifests and opaque references only, never dataset rows or customer payloads.


## Staged release channels and rollback

Migration `050_saas_release_rollouts.sql` adds the **FR-SAAS2-05** control plane. Each release rollout is an immutable, versioned snapshot scoped to an organization (tenant), factory, module or agent and assigned to a `STABLE`, `PREVIEW` or `EXPERIMENTAL` channel. Artifacts are pinned by version and SHA-256 digest; a new artifact uses a new rollout key. Tenant RLS, scoped factory foreign keys, IAM authorization, idempotency request hashes, optimistic `expected_version` checks and an immutable row guard protect the release history.

| Route | Permission | Purpose |
|---|---|---|
| POST /v2/saas/releases | saas.releases.write | Register a pinned artifact as DRAFT |
| GET /v2/saas/releases | saas.releases.read | List the latest snapshot for each rollout |
| GET /v2/saas/releases/:rolloutKey/history | saas.releases.read | Inspect immutable lifecycle versions |
| GET /v2/saas/releases/resolve | saas.releases.read | Resolve the applicable release for a target and subject |
| POST /v2/saas/releases/:rolloutKey/promotions | saas.releases.promote | Promote DRAFT → CANARY (1–99%) → PRODUCTION (100%) |
| POST /v2/saas/releases/:rolloutKey/rollback | saas.releases.rollback | Re-pin a release to a previous live, tested artifact in the same scope/channel |
| POST /v2/saas/releases/:rolloutKey/transitions | saas.releases.control | Pause, resume or retire a rollout |

Canary assignment is deterministic from a SHA-256 hash of the rollout key and a caller-supplied stable subject key; raw subject keys are not persisted. Resolution prefers agent, module, factory, then organization scope. A subject outside a canary cohort falls back to production at the same scope when available, then to broader scopes. Pausing removes a rollout from resolution; resuming restores its last live stage; rollback adds a new immutable version rather than rewriting any prior release.

The resolver is a **control-plane API**, not proof that every application path has switched versions: each runtime/module/agent adapter must call `resolveEffectiveRelease` at its execution boundary and implement the resulting artifact routing. This slice does not deploy binaries/models by itself. AI-agent publication already has its own simulation-gated CANARY/PRODUCTION workflow; this SaaS release registry covers the broader organization/factory/module/agent target hierarchy.

### PostgreSQL dataset adapters and transfer pipeline verification

The export worker registers a concrete `SaasTenantPostgresDatasetSource`. It uses a reviewed table allowlist and selects live FactoryOS tenant-owned rows directly from PostgreSQL. All requested categories for one export are read through the same connection and one read-only `REPEATABLE READ` transaction, with transaction-local `app.tenant_id` / `app.user_id` context, explicit `tenant_id` predicates, and UUID keyset pagination (500 rows per page). This prevents concurrent writes between categories from producing a mixed-time manifest. The transaction stays open until encrypted bundle streaming completes; if a category reader is abandoned or bundle generation fails, the export rolls back and releases the connection. Returned records carry a `__factoryos_table` discriminator so a target adapter can map data to reviewed relations without trusting caller-supplied table names. PostgreSQL `NUMERIC` fields remain strings rather than being rounded through JSON-number parsing. Production deployments should bound export duration and monitor long-lived snapshots because repeatable-read transactions retain an old MVCC horizon while streaming.

The current reviewed relation coverage is (SaaS usage and budget lifecycle rows are now included in the business-data export/import path):

- `BUSINESS_DATA`: legal entities, factories, orders/order lines/event projections, inventory items/balances/movements, CBB blueprints/versions/entities/relations/processes/steps/rules/terms/exceptions/change proposals/conflicts/feedback, growth opportunities/scenarios/experiments, and SaaS usage/budget governance history (usage events, adjustments, reconciliations, evaluations, workload controls, alerts/acknowledgements, and provider-cost records).
- `AUDIT_LOG`: `audit_events`.
- `EVIDENCE`: CBB evidence and evidence links plus growth-opportunity evidence.
- `APPROVALS`: `approvals`.
- `EFFECTIVE_DATED_MASTER_DATA`: risk classes, policies, usage rate cards, and usage budgets.
- `AI_CONTEXT`: AI decision envelopes/context packages/verification runs and research sources/claims/claim links/knowledge releases/relevance mappings.
- `LEARNING_EVALUATION`: research-release evaluations and growth experiment/outcome results. AI action execution/outcome-learning records and agent evaluation cases/results remain excluded until their full dependency sets have reviewed export/import adapters.
- `IAM_ACCESS`: logical tenant memberships, role definitions, user-role assignments and role-permission grants. Generated membership/role/permission IDs are remapped using stable user IDs, role/permission codes and factory codes.

Auth identities, user credential material, message-queue internals, and the export/migration control-plane ledger are intentionally not copied as business rows. The current generic exact-schema transfer allowlist also does not copy subscription plans, current subscription state/events, or entitlement-enforcement mode history; these rows are not safe to import as ordinary inserts because current subscription states are guarded by a state/event ledger and enforcement mode requires an eligible target subscription. A migrated tenant must be provisioned through the subscription onboarding/control plane and its entitlement mode explicitly re-established and verified before the target accepts premium traffic. Do not infer that the source subscription contract was preserved merely because SaaS usage history was exported. `INTEGRATION_METADATA` and `FILE_REFERENCES` remain valid optional category names but have no reviewed source adapter yet; requesting either category returns a service-unavailable error rather than claiming a successful empty export. The explicit allowlist must be reviewed whenever tenant-owned schema tables are added or changed.

The PostgreSQL pipeline integration test seeds a disposable tenant with live factory, audit, evidence and effective-dated rate data, runs the real source through the AES-256-GCM/GZIP encrypted bundle store, recomputes all required category counts and hashes after authenticated decryption, and streams the verified payload through a test target-adapter implementation. This verifies the source/store/worker contract; it does **not** mean a production target database importer is registered. Migration execution still fails closed until a deployment supplies a governed target adapter that imports into the isolated target and returns an independently measured manifest. A local spool directory is not shared storage for multi-replica production deployments.

### PostgreSQL target importer and immutable import receipts

The concrete target adapter is now registered as SAAS_TENANT_MIGRATION_TARGET_ADAPTER. Configure SAAS_TRANSFER_TARGET_DATABASE_URL with a dedicated PostgreSQL target database; the adapter refuses to run when the setting is missing, checks that source and target are not the same database, and requires migration 053_saas_tenant_import_receipts on the target.

The importer streams the canonical bundle one JSON row at a time into a transaction-local staging table, then inserts staged rows in reviewed foreign-key dependency order within a single target transaction. It uses tenant RLS context, explicit tenant predicates, an advisory lock per tenant/transfer, and an immutable receipt keyed by tenant and transfer. A retry with an existing matching receipt returns that receipt; a changed manifest for the same transfer conflicts. For a new receipt, the target's rows are read back independently and every available category count and SHA-256 digest must match the source manifest before receipt and data commit. Any import or verification failure rolls back the target transaction. Existing target rows in the selected relations are rejected rather than overwritten.

This adapter intentionally supports exact-schema copies only: source_schema_version and target_schema_version must match. Cross-version COMPATIBLE rules still need an explicit transformation adapter; this implementation does not guess column transformations. The destination tenant and referenced user identities must be provisioned before import. It does not copy identity credentials, action-token hashes, integration secrets, file blobs, or unreviewed AI execution/evaluation dependencies. IAM is an explicit migration boundary: `tenant_memberships` and `roles` are tenant-scoped, but `user_roles` has no `tenant_id` column and relies on its membership/role foreign keys, while `role_permissions` joins tenant roles to a global `permissions` catalogue by generated IDs. Those assignments must not be added to the generic table allowlist. The pure `saas-tenant-iam-remapping.plan.ts` planner now defines deterministic mapping by active user IDs, tenant membership, stable role codes, permission codes, and stable factory codes; it rejects missing/inactive target directory records, source relationship gaps, duplicate logical grants, incompatible existing role semantics, and any missing/extra target effective-access tuple. The logical planner is wired into the PostgreSQL target import transaction. Export uses canonical bundle formatVersion 2 and includes IAM_ACCESS in the same repeatable-read snapshot as business data. The target importer maps memberships by user ID, roles by tenant role code, permissions by global permission code and factory-scoped assignments by tenant factory code; it inserts only missing logical records, rejects extra target assignments/grants, and compares target effective-access tuples before recording the receipt. Missing/inactive users or permissions, missing factories, duplicate/dangling relationships and effective-access mismatches fail closed and roll back the same transaction. IAM_ACCESS is mandatory, so older exports must be re-exported before migration. The destination tenant, referenced users and global permission catalogue must be provisioned first; credentials and auth identities are never copied. Connector/integration metadata and file references still have no backing product tables/adapters and therefore remain fail-closed; file blobs must never be implied to have migrated merely because object-reference metadata is copied. INTEGRATION_METADATA and FILE_REFERENCES still fail closed until adapters are implemented.

The value returned as targetBundleReference is an opaque PostgreSQL import receipt reference, not a physical database backup. targetBundleDigest is the deterministic digest of the independently measured target snapshot manifest. Production disaster recovery must separately configure a database backup/snapshot service, shared encrypted object storage and KMS-managed key lifecycle; the import receipt is verification metadata, not a substitute for those facilities.



## ERP file import/export relationship (FR-PROD-15)

The tenant-wide export/migration pipeline in this document remains the asynchronous choice for full tenant datasets, schema compatibility, encrypted bundles, manifest attestation and target-side migration receipts. For bounded ERP/finance facts, the more specific CSV/JSON/SFTP contract lives in `docs/finance-integration-contract.md`: it adds dry-run validation reports, row-level errors, report-bound commit, finance import receipts, checksum-based file export receipts and idempotent retries. These two paths have different payloads and receipts and must not be conflated. SFTP is only enabled when a verified deployment transport adapter is registered; the application fails closed when it is absent.


## Tenant export, retention and erasure propagation (migration 160)

Migration 155/156 SQL receipts cover the reviewed PostgreSQL table allowlist only. They do **not** prove deletion from object storage, cache entries, search indexes, vector/embedding stores, learning artifacts, external providers, replicas or backups. The erasure service now records `receiptScope: POSTGRESQL_ONLY`, sets the request to `PROPAGATION_PENDING` after its SQL phase, and never marks the request `VERIFIED` based on a PostgreSQL receipt. The guarded lifecycle only accepts `PROPAGATION_PENDING -> VERIFIED` when a request-bound external run has a valid manifest digest, every required target has an immutable verified receipt, the digests match exactly, deleted copy counts equal the prepared counts, and residual count is zero.

### External target registry and evidence

`saas_tenant_external_data_targets` is a tenant-scoped registry of independently reviewed adapter targets. A target is created in `PENDING`; a different actor must approve or reject it. Active targets declare one of `OBJECT_STORAGE`, `CACHE`, `SEARCH_INDEX`, `VECTOR_STORE`, `LEARNING_ARTIFACT`, `EXTERNAL_PROVIDER`, `REPLICA`, or `BACKUP`, plus the data categories it stores, an opaque config-manager reference, and whether it is a required copy. Secret values, credentials and provider URLs are not stored in governance rows. Target scope/config is immutable after registration; pause/resume/review changes are audited.

`SaasTenantExternalDataPropagationAdapter` defines the provider contract: enumerate and hash the exact copy manifest (`prepare`), idempotently delete those identities (`erase`), independently read back the resulting state (`verify`), and reconcile uncertain previous attempts before retry (`recover`). Provider receipts carry planned/deleted/residual counts, the exact manifest digest, an opaque verification reference, an optional opaque provider receipt reference, and residual copy identifiers. Provider exceptions or unknown outcomes are treated as residual data, not success. A saved plan is persisted before a destructive call so a timeout/restart can resume against the same set of identities.

The propagation API is exposed under `/v2/saas/data-retention`: `POST/GET external-targets`, `POST external-targets/:targetId/review`, `POST erasure-requests/:requestId/propagate`, and `GET erasure-requests/:requestId/propagation-runs`. The workflow re-checks the approved request version, exact preserved export digest, an independent preservation attestation, active legal holds and three-person separation (requester, reviewer, PostgreSQL executor and propagation executor) before attempting provider work. All target kinds must have reviewed active coverage for every erasure category; a missing registry row, unconfigured adapter or missing provider implementation blocks completion.

### Separate finance/usage ledger retention

The usage/metering, adjustment, budget, reconciliation, rate-card and provider-cost ledgers remain excluded from generic business-data deletion. Migration 160 adds `saas_tenant_finance_retention_policies` and append-only `saas_tenant_finance_retention_runs` with a separate finance adapter key, legal basis, retention schedule, independent reviewer, independent executor, cutoff, planned/deleted/residual counts, exact receipt digest and adapter verification reference. APIs are `POST/GET finance-policies`, `POST finance-policies/:version/review`, `POST finance-policies/:version/run`, and `GET finance-runs`. Finance execution requires the policy maker, reviewer and executor to be different actors and blocks when an active business-data/finance hold applies. The finance adapter is intentionally a separate contract, never the generic business-data SQL delete path.

### Release/operations boundary

Migration 160 defines the contracts and state machine; `services/api/src/saas/saas-tenant-propagation.adapters.ts` is the provider adapter SPI. This repository does not select a specific cloud object store, cache, search engine, vector database, external SaaS provider or backup platform, and the module registers no production external adapters by default. This is fail-closed: a real tenant erasure cannot become `VERIFIED` until deployment supplies and reviews an implementation for every required target. The finance adapter likewise fails closed until its configured provider-specific implementation is registered. CI exercises schema, RLS, state-machine and fake-adapter contract evidence; it is not a claim that a live provider, replica or backup has already been purged.

Acceptance evidence: `services/api/test/saas-tenant-propagation-contract.sql`, `services/api/test/saas-data-retention-contract.sql`, the tenant ownership review gate, and the SaaS retention/propagation service tests. For an incident or partial provider failure, inspect per-target immutable receipts and residual manifests, keep the request in `PROPAGATION_PENDING`, restore provider credentials/configuration, and retry with the same run/idempotency key. Never represent a PostgreSQL-only run receipt as whole-tenant deletion proof.


## Task 23 — Physical sandbox provisioning, deployment orchestration and guarded rollout

Migration 186 adds an immutable execution ledger and tenant-isolated event state machine for physical infrastructure operations. This extends the pre-existing sandbox, deployment-profile and staged-release control-plane records; those older records alone never prove that infrastructure has been provisioned.

### Execution API and lifecycle evidence

| Route | Permission | Purpose |
|---|---|---|
| POST /api/v2/saas/physical-provisioning/sandboxes/:id/provision | saas.sandboxes.control | Provision isolated storage and materialize the exact synthetic/approved masked dataset manifest |
| POST /api/v2/saas/physical-provisioning/deployment-profiles/:id/provision | saas.deployment_profiles.control | Ask a topology-specific provider to provision the selected deployment-profile version |
| POST /api/v2/saas/physical-provisioning/releases/:rolloutKey/deploy | saas.releases.promote | Deploy a version-pinned artifact and run the provider health check |
| GET /api/v2/saas/physical-provisioning/runs and GET /runs/:id | saas.physical_provisioning.read | Inspect provider operation state, health evidence, provisioning receipts, halt and rollback history |

Every request pins the resource version, topology, artifact digest or dataset-manifest digest, idempotency key, failure policy and bounded health-check timeout. The run record is immutable; the event stream permits only REQUESTED → IN_PROGRESS → SUCCEEDED/FAILED/HALTED or IN_PROGRESS → ROLLBACK_IN_PROGRESS → ROLLED_BACK/ROLLBACK_FAILED. Forced RLS, a restrictive tenant policy, an idempotency constraint, a versioned event sequence, privacy-inventory classification and mutation-rejection triggers protect the records.

The provider SPI in `services/api/src/saas/saas-physical-infrastructure.adapters.ts` requires topology-aware support, provider idempotency, storage and dataset-materialization evidence, a SHA-256 manifest digest, an isolation attestation, health-check receipts and a verifiable rollback receipt. Dataset payloads, cloud credentials and bearer tokens must never be placed in request bodies, the run ledger or audit metadata. The application rejects receipts that fail to match the requested topology, artifact or dataset digest. For `ROLLBACK`, the target must be a prior production artifact with the same release scope; the rollback itself must be confirmed healthy. For `HALT`, the provider must confirm that the failed deployment was halted. Unknown provider outcomes remain failed/recovery-required, not successful.

### Kubernetes provider adapter, topology mapping and release gate

`KubernetesSaasPhysicalInfrastructureAdapter` is registered as the physical adapter. It uses the Kubernetes REST API for actual namespace, ResourceQuota, LimitRange, ingress NetworkPolicy, PersistentVolumeClaim, dataset materializer Job, Deployment and Service operations; it waits for storage binding, dataset job completion and release readiness rather than synthesizing success. Existing tenant resources are accepted only when their FactoryOS tenant/topology ownership labels and pinned spec/manifest digest match. Release traffic resolution excludes a release whose latest physical operation ended `HALTED`, `FAILED` or `ROLLBACK_FAILED`. On a health failure, HALT scales the failed Deployment to zero and appends an audited `PAUSED` control-plane release version. ROLLBACK requires a prior production artifact with the exact same release scope and a successful physical deployment receipt; it restores the pinned image, re-runs readiness checks and appends the corresponding versioned rollout rollback record. A provider rollback that succeeds physically but cannot be synchronized to the control plane is recorded as `ROLLBACK_FAILED` and is not silently represented as a fully recovered rollout.

The deployment must inject bearer tokens from a secret manager as environment variables. Shared and single-tenant topologies select `SAAS_KUBERNETES_API_SERVER` and `SAAS_KUBERNETES_BEARER_TOKEN`; dedicated VPC and hybrid cloud/edge topologies resolve opaque, reviewed `deployment_reference` / `edge_site_code` values to the `SAAS_KUBERNETES_TARGET_<REF_KEY>_API_SERVER`, `SAAS_KUBERNETES_TARGET_<REF_KEY>_BEARER_TOKEN`, `SAAS_KUBERNETES_EDGE_<REF_KEY>_API_SERVER` and matching `_BEARER_TOKEN` settings. `<REF_KEY>` is the upper-case sanitized reference (maximum 32 characters) followed by an underscore and the first eight uppercase SHA-256 hex characters of the original reference. The configured Kubernetes endpoint must be a trusted HTTPS origin; only non-production loopback endpoints can use HTTP. The adapter never accepts API URLs or secrets from a request body.

Sandbox materialization is implemented in `services/api/physical-provisioning/dataset-materializer.mjs` and packaged by `services/api/physical-provisioning/Dockerfile.dataset-materializer`. Build and scan it using a reviewed registry/build pipeline, then pin its pushed digest in `SAAS_SANDBOX_DATASET_PROVISIONER_IMAGE`:

```sh
docker build -f services/api/physical-provisioning/Dockerfile.dataset-materializer \
  -t <registry>/factoryos/dataset-materializer:<version> services/api/physical-provisioning
docker push <registry>/factoryos/dataset-materializer:<version>
# Set SAAS_SANDBOX_DATASET_PROVISIONER_IMAGE to the resulting registry path@sha256:<64-hex-digest>.
```

The container runs non-root, validates the canonical manifest SHA-256 against the requested run, produces deterministic synthetic JSONL from the approved seed, or streams approved masked source bytes into the tenant PVC. Masked manifests must identify an opaque `dataset_reference`, SHA-256 checksum, schema version, masking-policy version, record count and masking timestamp; the independent privacy assessment must be ASSESSED with LOW/MEDIUM residual risk and reviewed field identifiers. Source bytes must be a newline-delimited export whose non-empty record count matches the manifest. The materializer verifies byte checksum and count before publishing its output and emits a minimal completion receipt to stdout. The provider reads the completed Job's pod log and validates run ID, sandbox ID, mode, manifest digest, source checksum/output checksum, output filename and record count before accepting `datasetMaterialized=true`; a successful Job without that receipt is a failure.

For MASKED mode, the Kubernetes Secret named by `SAAS_KUBERNETES_MASKED_SOURCE_SECRET_NAME` (default `factoryos-masked-source`) must be pre-installed in the same tenant namespace with FactoryOS tenant ownership labels and a `source.json` key. Its JSON shape is `{"dataset_reference":"warehouse-snapshot:batch-42","download_url":"https://approved-object-store.example/opaque-signed-object","authorization_bearer":"optional-secret-token"}`; `authorization_bearer` is optional. The reference must exactly match the approved manifest. Redirects are refused, the HTTPS hostname must match `SAAS_KUBERNETES_MASKED_DATASET_ALLOWED_HOSTS`, and the resolved egress address must be included in `SAAS_KUBERNETES_MASKED_DATASET_ALLOWED_CIDRS`. The provider installs a materializer-only HTTPS egress NetworkPolicy for those CIDRs; default namespace policy continues to deny other cross-tenant ingress/egress. The allowlist must be maintained by infrastructure operators when the approved object-store address ranges change; a policy drift causes provisioning to fail closed. Do not put source URLs, bearer tokens, source payloads or secret values in manifests, tickets, API request bodies or audit records.

Other settings include `SAAS_KUBERNETES_STORAGE_CLASS`, `SAAS_KUBERNETES_SANDBOX_STORAGE_REQUEST` (default `10Gi`), `SAAS_KUBERNETES_PROVISION_TIMEOUT_SECONDS` (default `180`), `SAAS_DATASET_MATERIALIZER_MAX_RECORDS` (default `100000`), `SAAS_DATASET_MATERIALIZER_MAX_BYTES` (default `1073741824`), `SAAS_MASKED_DATASET_DOWNLOAD_TIMEOUT_SECONDS` (default `120`), `SAAS_RELEASE_IMAGE_REPOSITORY`, `SAAS_RELEASE_REPLICAS` (default `1`), `SAAS_RELEASE_CONTAINER_PORT` (default `3001`), `SAAS_RELEASE_READINESS_PATH` (default `/api/health/ready`) and `SAAS_RELEASE_LIVENESS_PATH` (default `/api/health/live`).

**Topology boundary:** the Kubernetes adapter connects to pre-provisioned clusters. Shared/single-tenant isolation is implemented with tenant namespaces and Kubernetes policy/quota/storage boundaries. Dedicated VPC and hybrid mode require the dedicated cloud/edge cluster, network and credentials to have been provisioned and approved by the infrastructure platform first; this API does not itself create cloud accounts, VPCs, Kubernetes clusters or edge sites. A production acceptance run must exercise each configured topology against real test infrastructure, verify cross-tenant namespace/storage/network isolation, execute synthetic and masked materialization, deploy a real digest-pinned workload, force a health-check failure, and verify both halt and successful/failed rollback evidence. The CI contracts verify schema/state guards, topology-config fail-closed behavior and receipt validation; they do **not** claim live cloud/VPC provisioning without configured cluster credentials and an external infrastructure provisioner.

## Task 24 — Commercial billing and provider-issued invoices

Migration 185 adds a separate commercial billing boundary around the usage/rate ledger above. The saas_usage_events, rate-card, adjustment and usage reconciliation tables remain metering/estimate evidence; they are **not issued invoices**. A commercial invoice exists only after a provider invoice has been created/finalized and its external ID/lifecycle evidence has been recorded in a billing-close event.

### Billing lifecycle

1. Configure one versioned Stripe customer account per tenant. The caller supplies a verified Stripe Customer ID, currency, collection method and tax setting. The API retrieves the customer from the configured Stripe account before accepting it; secrets never enter the request or database.
2. Prepare a bounded billing close (at most 35 days). It snapshots the tenant usage and reason-coded adjustments for the selected currency, rejects unpriced usage, mixed currencies and adjustments that cross the selected time boundaries, and stores exact minor-unit aggregates, line markers, a canonical digest and the provider-account version.
3. Issue a provider invoice from the immutable close snapshot. Each invoice and line-item operation has a stable Stripe idempotency key. Retries retrieve and inspect the existing invoice and line markers first; they do not deliberately create a second invoice or duplicate a line.
4. Finalize/send the invoice or attempt automatic payment according to the saved collection method. Payment failures get append-only receipts and can be recovered with a distinct caller idempotency key. Send-invoice collections do not trigger an automatic charge retry.
5. Reconcile the provider invoice back to the saved close: exact customer/currency, provider subtotal, tax, discount, total, amount due/paid, automatic-tax result, and all expected line markers. Each provider snapshot and result hash is persisted immutably. Variance and tax review are explicit statuses, not silent write-offs.
6. Stripe webhook delivery is the only unauthenticated route in this billing controller. It verifies the signature over the original request bytes using STRIPE_WEBHOOK_SECRET, enforces a five-minute timestamp window, verifies tenant/close/snapshot/customer binding, and de-duplicates the provider event ID and payload digest transactionally. The public route must not be bypassed with JSON re-serialization or a caller-supplied tenant ID. Non-terminal `invoice.updated`/open observations are retained as evidence but do not advance or regress the billing state; a recorded payment failure remains visible until a paid or other terminal provider outcome is confirmed, regardless of webhook delivery order.

### Endpoints and permissions

| Route | Permission | Purpose |
|---|---|---|
| POST /api/v2/saas/billing/provider-account | saas.billing.account.write | Configure/update provider customer and collection/tax settings using expected-version concurrency |
| GET /api/v2/saas/billing/provider-account | saas.billing.read | Read the current provider-account configuration |
| POST /api/v2/saas/billing/closes | saas.billing.close | Create an immutable period/currency billing-close snapshot |
| GET /api/v2/saas/billing/closes and GET /closes/:id | saas.billing.read | Read close status and append-only event history |
| POST /api/v2/saas/billing/closes/:id/issue | saas.billing.issue | Create/recover provider invoice issue operations |
| POST /api/v2/saas/billing/closes/:id/retry-payment | saas.billing.issue | Retry a previously failed automatic payment with an explicit idempotency key |
| POST /api/v2/saas/billing/closes/:id/reconcile | saas.billing.reconcile | Pull the provider invoice and save a versioned reconciliation result |
| GET /api/v2/saas/billing/closes/:id/reconciliations | saas.billing.read | Read reconciliation history |
| POST /api/v2/saas/billing/webhooks/stripe | Stripe signature | Verify and persist provider invoice lifecycle events |

### Configuration and accounting boundary

Configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET through the deployment's secret manager, never in source, request bodies, audit payloads or database tables. The adapter rejects Stripe test-mode keys when `NODE_ENV=production` and rejects provider invoices whose `livemode` does not match the configured key mode. Optionally pin STRIPE_API_VERSION to the version approved for the connected account. Configure a matching webhook endpoint in Stripe and subscribe to invoice lifecycle/payment events. Use Stripe test-mode customers and endpoint secrets in a non-production environment before the production secret is installed.

Amounts are stored and reconciled in integer currency minor units using exact PostgreSQL NUMERIC aggregates and JavaScript BigInt; the provider adapter rejects amounts outside its safe integer contract. Stripe is the commercial provider invoice/payment source of record; FactoryOS is the source of record for usage, rates, adjustments, billing-close snapshot and reconciliation evidence. This integration does not create general-ledger journal entries, declare tax treatment for a jurisdiction, or replace an accounting system. Internal subscription/plan ID, version, status and period are pinned into the immutable close and copied to Stripe invoice metadata when a subscription exists. Legacy metering-only tenants remain supported; an absent subscription is recorded as an empty snapshot. Existing plan capability/entitlement data is not interpreted as a price. No recurring plan base fee is invoiced until FactoryOS has an approved immutable subscription-price contract. Finance must approve currency, inclusive/exclusive tax behaviour, customer tax registrations, invoice numbering/legal language, revenue recognition and close cut-off policy.

A tenant-wide advisory lock serializes snapshotting against usage/adjustment/legacy reconciliation writes, and database triggers reject late ledger entries that overlap an already closed period. Existing manual provider-invoice reconciliation periods are checked before a new close and are fenced against concurrent double invoicing. Late data cannot silently drift an issued snapshot. A negative net close is blocked and requires a separately approved provider credit-note/tax-correction workflow. For automatic-tax invoices, negative adjustment lines are blocked because that provider/tax combination is not safe to infer. The invoice will not be sent or charged until the provider reports a complete automatic-tax calculation. This task therefore provides audited adjustments in billing closes but does not claim automatic credit-note issuance. Unpriced usage, currency mismatches, stale account/version data, unbound provider lines, tax calculation failures and reconciliation variances must be resolved rather than silently invoiced or written off.

**Production release gates:** successful migration-185 replay and PostgreSQL contract test; reviewed Stripe API version; verified test-mode invoice/paid/failure/webhook rehearsal; production webhook delivery/signature verification; configured real account/customer and secret rotation; sample provider-vs-close reconciliation and a failed-payment recovery receipt; finance/tax owner approval and independent close evidence. A green CI run validates code/contracts, not that the user's Stripe account has been activated.
