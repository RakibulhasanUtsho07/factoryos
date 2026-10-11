# SaaS Productization — WP10 Backend Slice

**Requirements traceability:** SRS v2.1 FR-SAAS2-02 (P0), FR-SAAS2-06 (P1), FR-SAAS2-07 (P1), FR-SAAS2-08 (P1), FR-PROD-04 (P0), and FR-PROD-05 (P0).  
**Migration range:** 045–052.  
**API bases:** /v2/saas/usage, /v2/saas/subscriptions, /v2/saas/sandboxes, /v2/saas/releases, /v2/saas/deployment-profiles, and /v2/saas/data-transfers.

## Delivered in this slice

- Tenant-scoped usage events for active users, role assignments, transactions, storage byte-hours, telemetry events, AI input/output tokens, AI tool calls, premium workloads, integration calls, and edge inference.
- Effective-dated immutable rate cards. Event pricing selects the rate in effect at occurred_at and snapshots its version, currency, block size, and rate onto the event so later rate changes do not rewrite historical unit economics.
- Idempotency keys and request fingerprints for usage, rate changes, adjustments, and invoice reconciliation. Reusing a key with a different request is a conflict rather than a second charge.
- Usage reports, reconciliation reports against an external invoice, and explicit, reason-coded adjustments. Billing/invoicing remains an external commercial boundary; this API does not issue invoices or treat provider invoices as FactoryOS source-of-record financial facts.
- Effective-dated tenant/factory budgets with soft/hard limits, anomaly checks, durable alerts, acknowledgement records, and controls restricted to non-critical workload classes.
- Idempotent AI tool-call metering in the governed Tool Gateway. Tool workload classification comes from registered tool metadata, not caller-supplied request fields. Usage is recorded before the budget-control check; only registered non-critical classes can be paused by this mechanism. PRODUCTION and NON_AI workloads are not pause targets.
- PostgreSQL row-level security and tenant/factory-scoped foreign keys on the metering, budget, alert, and provider-cost records.
- api-postgres-ci.yml applies migrations 045–052 and runs the API unit and PostgreSQL integration suite.
- Versioned, tenant-scoped subscription plans use an explicitly configured tier_rank so the service can validate upgrade/downgrade direction without inventing plan prices. Deployment profile is recorded as control-plane metadata; billing remains external.
- Subscription state is guarded by a database transition trigger and an immutable event ledger. A deferred constraint trigger prevents state/version updates from committing unless a matching lifecycle event is written in the same transaction. Terminal subscriptions cannot be reactivated; a new subscription can be started after termination/expiry.
- Lifecycle operations use optimistic expected_version checks, tenant-row locking, idempotency request hashes, IAM authorization in both the controller and service, and best-effort audit records after the state/event transaction.

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

Transitions require expected_version and idempotency_key. ACTIVATE, RESUME and RENEW require period bounds; upgrade/downgrade require a target plan whose configured rank is respectively greater/lower than the current rank. Future-dated transitions are rejected because a scheduler is not part of this slice. EXPIRE is accepted only when the trial or active billing period has reached its boundary. Stale versions and reuse of an idempotency key with a different request are rejected.

## Subscription-aware entitlement enforcement

Entitlement resolution and runtime feature-flag evaluation now consult the tenant's latest subscription record. Suspended, terminated, or expired subscriptions, expired trials, and active subscriptions outside their effective billing period cannot resolve an active entitlement or enabled feature flag. Feature-flag evaluation preserves the established safe default (disabled) when there is no effective row or evaluation fails.

The governed AI Tool Gateway re-checks the current subscription immediately before usage metering and execution. If a subscription is not eligible, it rejects the action before tool side effects and before charging a tool-call usage event; non-critical workload budget controls remain an additional independent gate.

**Migration compatibility:** a tenant that has no subscription record is temporarily treated as a legacy installation and keeps its existing entitlement/feature-flag behavior. This avoids unintentionally suspending existing tenants before their plans are onboarded. New subscription onboarding should make a plan/trial explicit; a future enforcement rollout can remove this compatibility mode after existing tenants are migrated. The runtime subscription gate is live-query based; it does not rely on a stale entitlement cache.

## Boundaries and remaining WP10 work

These are the metering/FinOps, subscription lifecycle, sandbox governance, release-control, deployment-profile, and tenant export/migration compatibility backend slices, not a claim that all of WP10 is complete. Remaining SRS scope includes subscription cache semantics and explicit tenant migration from legacy compatibility mode, the physical sandbox provisioner/data adapter that creates truly isolated storage, and actual infrastructure orchestration behind deployment-profile transitions. Those capabilities must be delivered and tested as separate slices.

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

- `BUSINESS_DATA`: legal entities, factories, orders/order lines/event projections, inventory items/balances/movements, CBB blueprints/versions/entities/relations/processes/steps/rules/terms/exceptions/change proposals/conflicts/feedback, growth opportunities/scenarios/experiments, and SaaS usage/budget governance history (usage events, adjustments, reconciliations, evaluations, workload controls, alerts/acknowledgements, and provider-cost records). IAM role/ACL grants are excluded and must be provisioned separately.
- `AUDIT_LOG`: `audit_events`.
- `EVIDENCE`: CBB evidence and evidence links plus growth-opportunity evidence.
- `APPROVALS`: `approvals`.
- `EFFECTIVE_DATED_MASTER_DATA`: risk classes, policies, usage rate cards, and usage budgets.
- `AI_CONTEXT`: AI decision envelopes/context packages/verification runs and research sources/claims/claim links/knowledge releases/relevance mappings.
- `LEARNING_EVALUATION`: research-release evaluations and growth experiment/outcome results. AI action execution/outcome-learning records and agent evaluation cases/results are excluded until their full dependency sets have reviewed export/import adapters.

Auth identities, user credential material, message-queue internals, and the export/migration control-plane ledger are intentionally not copied as business rows. `INTEGRATION_METADATA` and `FILE_REFERENCES` remain valid optional category names but have no reviewed source adapter yet; requesting either category returns a service-unavailable error rather than claiming a successful empty export. The explicit allowlist must be reviewed whenever tenant-owned schema tables are added or changed.

The PostgreSQL pipeline integration test seeds a disposable tenant with live factory, audit, evidence and effective-dated rate data, runs the real source through the AES-256-GCM/GZIP encrypted bundle store, recomputes all required category counts and hashes after authenticated decryption, and streams the verified payload through a test target-adapter implementation. This verifies the source/store/worker contract; it does **not** mean a production target database importer is registered. Migration execution still fails closed until a deployment supplies a governed target adapter that imports into the isolated target and returns an independently measured manifest. A local spool directory is not shared storage for multi-replica production deployments.

### PostgreSQL target importer and immutable import receipts

The concrete target adapter is now registered as SAAS_TENANT_MIGRATION_TARGET_ADAPTER. Configure SAAS_TRANSFER_TARGET_DATABASE_URL with a dedicated PostgreSQL target database; the adapter refuses to run when the setting is missing, checks that source and target are not the same database, and requires migration 053_saas_tenant_import_receipts on the target.

The importer streams the canonical bundle one JSON row at a time into a transaction-local staging table, then inserts staged rows in reviewed foreign-key dependency order within a single target transaction. It uses tenant RLS context, explicit tenant predicates, an advisory lock per tenant/transfer, and an immutable receipt keyed by tenant and transfer. A retry with an existing matching receipt returns that receipt; a changed manifest for the same transfer conflicts. For a new receipt, the target's rows are read back independently and every available category count and SHA-256 digest must match the source manifest before receipt and data commit. Any import or verification failure rolls back the target transaction. Existing target rows in the selected relations are rejected rather than overwritten.

This adapter intentionally supports exact-schema copies only: source_schema_version and target_schema_version must match. Cross-version COMPATIBLE rules still need an explicit transformation adapter; this implementation does not guess column transformations. The destination tenant and referenced user identities must be provisioned before import. It does not copy identity credentials, IAM roles/ACL grants, action-token hashes, integration secrets, file blobs, or unreviewed AI execution/evaluation dependencies. Connector/integration metadata and file references still have no backing product tables/adapters and therefore remain fail-closed; file blobs must never be implied to have migrated merely because object-reference metadata is copied. INTEGRATION_METADATA and FILE_REFERENCES still fail closed until adapters are implemented.

The value returned as targetBundleReference is an opaque PostgreSQL import receipt reference, not a physical database backup. targetBundleDigest is the deterministic digest of the independently measured target snapshot manifest. Production disaster recovery must separately configure a database backup/snapshot service, shared encrypted object storage and KMS-managed key lifecycle; the import receipt is verification metadata, not a substitute for those facilities.

