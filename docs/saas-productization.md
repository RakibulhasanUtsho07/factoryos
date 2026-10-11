# SaaS Productization — WP10 Backend Slice

**Requirements traceability:** SRS v2.1 FR-SAAS2-02 (P0), FR-SAAS2-06 (P1), FR-PROD-04 (P0), and FR-PROD-05 (P0).  
**Migration range:** 045–050.  
**API bases:** /v2/saas/usage, /v2/saas/subscriptions, and /v2/saas/sandboxes.

## Delivered in this slice

- Tenant-scoped usage events for active users, role assignments, transactions, storage byte-hours, telemetry events, AI input/output tokens, AI tool calls, premium workloads, integration calls, and edge inference.
- Effective-dated immutable rate cards. Event pricing selects the rate in effect at occurred_at and snapshots its version, currency, block size, and rate onto the event so later rate changes do not rewrite historical unit economics.
- Idempotency keys and request fingerprints for usage, rate changes, adjustments, and invoice reconciliation. Reusing a key with a different request is a conflict rather than a second charge.
- Usage reports, reconciliation reports against an external invoice, and explicit, reason-coded adjustments. Billing/invoicing remains an external commercial boundary; this API does not issue invoices or treat provider invoices as FactoryOS source-of-record financial facts.
- Effective-dated tenant/factory budgets with soft/hard limits, anomaly checks, durable alerts, acknowledgement records, and controls restricted to non-critical workload classes.
- Idempotent AI tool-call metering in the governed Tool Gateway. Tool workload classification comes from registered tool metadata, not caller-supplied request fields. Usage is recorded before the budget-control check; only registered non-critical classes can be paused by this mechanism. PRODUCTION and NON_AI workloads are not pause targets.
- PostgreSQL row-level security and tenant/factory-scoped foreign keys on the metering, budget, alert, and provider-cost records.
- api-postgres-ci.yml applies migrations 045–050 and runs the API unit and PostgreSQL integration suite.
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

These are the metering/FinOps, subscription lifecycle, sandbox governance, and release-control backend slices, not a claim that all of WP10 is complete. Remaining SRS scope includes subscription cache semantics and explicit tenant migration from legacy compatibility mode, deployment-profile administration, tenant export/migration compatibility, and the physical sandbox provisioner/data adapter that creates truly isolated storage. Those capabilities must be delivered and tested as separate slices.

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
