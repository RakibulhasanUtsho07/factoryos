# Tenant Data Governance, Retention, Erasure and Isolation

**Status:** implementation/acceptance matrix; policy owners must approve durations before production enforcement.
**Scope:** tenant export and migration, deletion/erasure requests, retention controls, audit coverage, and cross-tenant isolation.
**Related implementation:** `saas-tenant-data-transfer.service.ts`, `saas-tenant-data-transfer.worker.ts`, `saas-tenant-postgres-dataset-source.ts`, `saas-tenant-postgres-migration-target.adapter.ts`, `audit/audit.service.ts`, migrations 045–156, especially 149–156.

## Security invariants

1. Every tenant-owned query must use a verified tenant context and tenant predicate; RLS is defense in depth, not a replacement for authorization.
2. An export is complete only when its required category manifest, row counts, hashes, encrypted artifact receipt and final attestation agree. Failed/incomplete bundles must be removed best-effort and never presented as completed.
3. Cross-tenant export and deletion requests are denied before reading or mutating data. Object-store references are opaque; no raw credentials, secrets, access tokens or encryption keys belong in export payloads.
4. Audit events are tenant-scoped, actor-attributed where available, and data-classified. AuditService recursively redacts common credential/secret and token fields by key before JSON payload persistence; this is a safety net, not a substitute for callers minimizing payloads or reviewing unusual secret-field names. Audit evidence must not be silently deleted by routine business-data erasure.
5. Deletion is a governed lifecycle, not an unscoped SQL DELETE. A request must be authorized, reasoned, idempotent, versioned, reviewable and independently verifiable.
6. Legal holds, unresolved financial obligations, statutory records and append-only audit/security evidence can delay or narrow erasure. The policy owner must define applicable law and exceptions; software must not invent a universal retention duration.
7. A failed audit write, failed tenant-context setup, ambiguous tenant scope, or unrecognized table/category must fail closed.

## Retention policy registry

Retention periods are not hard-coded: legal/compliance owners must approve the duration and jurisdiction before production policy is configured. Each version records the category, duration, disposition, legal basis, reason, actor and idempotency fingerprint. A run uses an expected policy version and produces an immutable, tenant-scoped manifest/count/digest receipt; dry-run and execute modes are explicit. A policy change never rewrites completed runs. Destructive execution requires a dedicated permission and a different actor from the policy maker.

Minimum classes to govern:
- Operational/business records and evidence.
- Usage, adjustments, provider reconciliation and billing-support records.
- Authentication, authorization and security events.
- Immutable audit trail and approval evidence.
- Export bundles, manifests and temporary staging artifacts.
- Backups, snapshots, replicas and disaster-recovery copies.
- User-linked personal data and derived/cache/search data.

Until a policy is approved, no retention run can execute. The run engine fails closed for categories without a reviewed table mapping, without a timestamp anchor, without forced RLS/tenant policy, with a legal hold, with recent dependent rows, or above its 100,000-row synchronous bound. `ANONYMIZE` is blocked until a field-level anonymization adapter is reviewed. The current executor is for reviewed PostgreSQL tables only; object-store, cache, replica and backup expiry still require deployment-specific adapters and retention settings.

## Schema-wide tenant relation inventory and isolation fence

Migration `156_tenant_privacy_inventory_and_rls_guardrails.sql` inventories **every public base/partition relation**. Direct `tenant_id` relations are classified and receive forced RLS; `user_roles` and `role_permissions` receive explicit derived-scope treatment; every other relation is recorded as `NO_DIRECT_TENANT_ID`, `UNREVIEWED`, excluded from tenant export, and blocked from generic erasure until an owner documents whether it is global control-plane data or has indirect tenant ownership. CI fails if any public relation is missing from the inventory or an unreviewed no-direct-scope relation becomes exportable/deletable.

For every direct `tenant_id` relation the migration enables and forces row-level security and installs an additional **restrictive** policy that ANDs the current transaction tenant into all operations. It preserves existing permissive policies, rather than unconditionally adding another permissive rule that could OR with and weaken a narrower in-tenant access policy. Only when a relation has no permissive policy at all does it install a tenant-bound fallback so the relation is not left inaccessible. `user_roles` and `role_permissions`, which do not have a direct `tenant_id` column, receive derived-scope restrictive policies through membership/role/factory ownership and are inventoried separately.

The inventory deliberately does not automatically make new tables exportable. Export authorization remains tied to the reviewed source/target allowlists in `SAAS_TENANT_DATASET_TABLES` and the special logical IAM transfer adapter. The PostgreSQL CI suite now applies and reapplies migration 156, then executes `services/api/test/tenant-data-governance-inventory.sql`; the tenant-isolation integration test also discovers all public tables with `tenant_id` from PostgreSQL catalogs instead of relying on a fixed hand-maintained table list.

**Coverage boundary:** migration 156's `tenant_relation_inventory` remains the fail-closed direct-column/export inventory; `NO_DIRECT_TENANT_ID` in that table does not, by itself, claim that the relation is global or tenant-safe. Migration 159 adds the separate `factoryos_governance.tenant_relation_ownership_reviews` ledger for every public base/partition relation. It records `DIRECT_TENANT`, `DERIVED_TENANT`, `GLOBAL_SHARED`, or `UNRESOLVED`, the evidence basis, exact generated FK-derived scope predicate, export/erasure disposition, and review status.

For no-direct-column tables, migration 159 recursively traverses declared foreign keys to find tenant-owned parents. A derived-scope policy ANDs every ownership-bearing FK path and enforces the predicate in restrictive `USING` and `WITH CHECK` policies with FORCE RLS. Nullable FK groups may be absent, but populated relationships must resolve inside the active tenant. This covers ordinary linked relations plus `user_roles` and `role_permissions`; the latter retain their derived membership/role/factory semantics. Linkage discovery does **not** make a relation exportable or erasable: generic export remains excluded and generic erasure blocked until a category-specific adapter is explicitly reviewed. The pre-existing `user_roles` and `role_permissions` relationships are the documented exception: their ownership ledger remains `ALLOWLISTED`/`PROTECTED` only because the dedicated logical IAM remapping adapter emits tenant-scoped membership/role/permission codes instead of copying raw relationship rows; they are not eligible for generic deletion.

The initial `GLOBAL_SHARED` entries are explicit repository-policy decisions for the tenant registry, shared user identity principals, the OIDC issuer/subject mapping (`auth_identities`) resolved before tenant selection, the global permission catalogue and the schema migration ledger. They remain excluded from generic tenant export and protected from generic erasure. A table with neither direct `tenant_id`, a declared FK path to tenant-owned data, nor an explicit global-scope entry is recorded as `UNRESOLVED`, receives a deny-all restrictive policy, and fails the PostgreSQL ownership-review gate. Missing FK constraints are not silently treated as proof of global ownership.

The automated FK review is a database-evidence classification, not a substitute for a data owner approving legal retention durations or a new transfer adapter. The inventory still does not prove external copies are purged or that every tenant-owned relation has a usable export/erasure adapter.

## Ownership review and derived-scope closure (migration 159)

The ownership review gate is `services/api/test/tenant-ownership-review.sql`, run after migration 159 and the migration-156 inventory contract in PostgreSQL CI. It checks that every public base/partition relation has an ownership record, no unresolved relation remains, global-scope records stay excluded/protected, and each FK-derived relation has FORCE RLS plus a restrictive tenant policy. Its adversarial fixture exercises cross-tenant reads and attempted writes through `user_roles` and `role_permissions`, including an intentionally inconsistent legacy assignment that must remain hidden from both tenants.

API-level negative coverage is in `saas-tenant-data-transfer.postgres.integration.spec.ts`: tenant B cannot read tenant A's transfer history, attest tenant A's export, or start tenant A's migration by supplying a known transfer UUID. The earlier direct SQL query also asserts that the foreign tenant sees zero transfer rows. These tests complement (rather than replace) the schema-wide RLS/catalog checks.

This closure intentionally does not expand the reviewed dataset export allowlist: only the existing direct-table allowlist and the dedicated logical IAM remapping adapter may be transferred. New FK-derived tables remain excluded until a specific data category/source adapter and its manifest/erasure behavior are reviewed.

## Export acceptance contract

The existing PostgreSQL source uses a single read-only `REPEATABLE READ` snapshot, tenant RLS context, explicit tenant predicates, UUID keyset pagination and a reviewed table allowlist. Export completion must verify:
- all required categories exist, including empty categories with count 0 and a deterministic digest;
- row count and category digest match the encrypted bundle manifest;
- source tenant/schema and export request IDs are bound into the attestation;
- no credentials, authentication secrets or transfer control-plane records are exported;
- partial bundles are removed if snapshot, stream, encryption or attestation fails;
- artifact access and deletion are audited; expired bundle cleanup is observable;
- an export is not described as a full backup or complete migration when categories are deliberately excluded.

The current allowlist is a reviewed subset, not proof of every tenant-owned table. Schema changes must add/update isolation and export-matrix tests before a new table becomes exportable.

## Deletion/erasure lifecycle

Implemented database lifecycle:
`REQUESTED → APPROVED|REJECTED`; an approved request can enter `EXECUTING → VERIFIED` only inside the same database transaction that deletes the reviewed table scope and inserts a matching immutable execution receipt. Review requires a different actor than the requester; execution requires a third actor distinct from requester and reviewer. The executor requires the independent preservation attestation, rechecks active legal holds, checks the expected row version, uses tenant-scoped SQL plus forced RLS/tenant policies, builds a foreign-key dependency order, refuses external or recent dependent rows, compares preflight counts with deleted counts, hashes a manifest and writes audit evidence in the same transaction. Failed destructive transactions roll back and are represented by an immutable failed-run receipt where the database is available; retry requires a new idempotency key. A repeated request key never repeats a successful deletion.

SaaS usage events/adjustments, invoice reconciliation, provider-cost events/reconciliation, budget evaluations/alerts and rate-card/budget control tables are explicitly excluded from broad business-data erasure and surfaced as `retainedTables`/`retainedRows` with a reason in the immutable manifest. A `BUSINESS_DATA` retention execution is blocked with `FINANCIAL_RETENTION_REVIEW_REQUIRED` when its cutoff would remove those records; they require a separately approved finance-specific retention workflow and table adapter, which is not yet implemented; the generic executor blocks instead of inheriting the general business-data schedule. These retained rows are not silently counted as deleted or hidden behind a successful receipt.

The execution adapter is deliberately bounded and **not a claim of whole-tenant erasure**. It accepts only the reviewed categories `BUSINESS_DATA`, `EVIDENCE`, `AI_CONTEXT`, and `LEARNING_EVALUATION` where all mapped tables pass the isolation/dependency checks and the synchronous run is at most 100,000 rows. Audit logs, approvals, effective-dated master data and IAM access evidence are retained as protected classes. The export allowlist does not yet prove coverage of every tenant-owned relation.

Object-store exports, derived indexes, caches, replicas, external providers and immutable backups are not purged by this PostgreSQL adapter. The export bundle must be treated as a sensitive recovery artifact and its expiry/secure deletion must be implemented and configured in the bundle-store adapter. A verified receipt covers only the named table/category manifest and must not be represented as proof that every external copy or every tenant-owned table has been erased.

## Audit coverage matrix

| Action/data domain | Required audit evidence | Current repository evidence | Acceptance |
|---|---|---|---|
| Export request, attest, validate, cancel | tenant, actor, transfer ID/version, category manifest digest, reason, outcome | SaaS data-transfer service and audit service | Exercise success, denial, replay and partial failure |
| Tenant migration/import | source/target tenant IDs, transfer ID, target receipt/digest, excluded categories | exact-schema target adapter and transfer receipt | Prove no existing rows overwritten; target isolation tested |
| Retention policy changes/runs | policy category/version, actor, mode, cutoff, examined/eligible/affected counts, legal holds, table manifest digest and outcome | `saas-tenant-retention.service.ts`; `saas-tenant-governance-execution.service.ts`; migration 155; retention run ledger | Unit/contract tests committed; policy durations and external-store expiry still need owner approval |
| Erasure request/approval/execution | request/version, requester/reviewer/executor, legal hold, preserved export digest, deleted-row counts, manifest digest and immutable outcome receipt | `saas-tenant-retention.service.ts`; `saas-tenant-governance-execution.service.ts`; migration 155; erasure execution ledger | Bounded database scope is implemented; whole-tenant inventory plus object-store/backup purge is still partial |
| IAM/permission and tenant-scope denial | actor, requested tenant/resource, decision, correlation ID | PermissionGuard/IAM, tenant-scope checks, and AuditService; recursive key-based payload redaction plus unit coverage | Exercise denial paths on PostgreSQL and review field names that may encode secrets under nonstandard keys |
| Usage, budget, subscription | actor/source event, idempotency, policy decision, state transition | SaaS usage/subscription ledgers and audit | Confirm all mutation paths and transaction-failure behavior |
| AI tool/execution/compensation | tool/action IDs, authorization, claim, outcome, compensation receipt | AI execution traceability docs and event ledgers | Verify all paths emit correlated audit events |
| File/evidence access and external adapters | opaque resource ID, tenant, actor, action, result | category/adapter-specific evidence must be checked | Adapter-specific acceptance pending |

## Cross-tenant isolation matrix

| Surface | Tenant A context | Tenant B resource | Required result |
|---|---|---|---|
| Read/list/get | A | B row/ID | deny or indistinguishable not-found; zero row data |
| Create/update/delete | A | B foreign key/resource | reject; no partial mutation |
| SaaS transfer history / export attestation / migration transition | A | B transfer UUID | service returns not-found; no version/state mutation |
| Export request/worker | A | B transfer ID/bundle | reject before snapshot/storage access |
| Export source SQL | A RLS context | B tenant rows | zero rows; explicit tenant predicate and RLS both active |
| Migration target | A transfer | B pre-existing target rows | reject; never overwrite or import into another tenant |
| Object-store artifact | A authorized grant | B artifact reference | deny; references are not bearer authorization |
| Audit list/export | A | B audit event | deny; audit RLS/tenant filter verified |
| Background job/retry | A queued payload | B tenant ID substitution | reject using persisted tenant-bound request, not caller-supplied context |
| Missing/invalid tenant context | none/invalid | any tenant resource | fail closed |
| Cross-tenant foreign key | A row | B parent row | FK/RLS/trigger prevents link; transaction rolls back |
| Tenant deletion | A approved erasure | B data | never touched; exact-tenant inventory and mutation counts checked |

## Release gates

- Keep migration 156 and `services/api/test/tenant-data-governance-inventory.sql` as the automated inventory gate for every public base/partition relation. Direct `tenant_id` relations must have forced RLS and a restrictive current-tenant fence, except explicitly contracted global registries such as `ai_tool_registry` whose command-specific policies are independently asserted.
- Require migration 159's ownership-review ledger to cover every public base/partition relation with no `UNRESOLVED` entries; FK-derived rows must have FORCE RLS and restrictive tenant `USING`/`WITH CHECK` predicates. A new global/shared table needs an explicit rationale/registry entry, and remains excluded from generic export/erasure.
- Retain two-tenant PostgreSQL tests for tenant read/write denial, RLS boundaries, retention/legal-hold/erasure ledgers, export/migration manifests and audit access; catalog checks do not replace endpoint-level failure, replay, or rollback tests.
- Approve retention durations/legal basis before execution; verify dry-run, held data, recent foreign-key dependents, partial failure, idempotent retry and immutable receipts.
- Extend the reviewed table/category inventory to all tenant-owned relations and implement/configure object-store, index/cache, replica and backup expiry adapters before advertising whole-tenant deletion as supported.
- Run API build/lint/unit tests and PostgreSQL CI on the exact commit; this document alone is not runtime proof.

## Requirement traceability

Maps to the tenant-wide portion of `FR-PROD-15`, SaaS export/migration requirements in `docs/saas-productization.md`, and the tenant isolation/privacy principles in the engineering blueprint. The signed SRS/HLD must be present and approved to complete formal requirement-by-requirement sign-off.


## External copy propagation and scoped erasure receipts (migration 160)

A successful row deletion from the reviewed PostgreSQL allowlist is recorded with `receipt_scope = POSTGRESQL_ONLY`; its API manifest explicitly says `wholeTenantErasureVerified: false`. The erasure request then moves to `PROPAGATION_PENDING`. Only a second request-bound propagation receipt can move it to `VERIFIED`, and only if every required, independently reviewed target was verified against the exact prepared SHA-256 manifest, deleted copies match planned copies, no residual copy remains, and the stored request version has not changed.

Targets are registered/reviewed separately for object storage/files, caches, search indexes, vector/embedding stores, derived learning artifacts, external providers, replicas and backups. The provider adapter must enumerate the full tenant/category scope, persist a deterministic identity manifest before deletion, use an idempotent provider operation, verify by independent read-back, keep opaque provider receipt and residual references, and recover uncertain operations before retries. Failed or timed-out operations are recorded as failed/residual and remain pending; they are never silently treated as success. Active legal holds are rechecked before propagation starts.

Finance/usage ledger records remain excluded from generic business-data deletion. Their retention is represented by a separate reviewed policy and adapter execution receipt, requires distinct policy creator, reviewer and executor, has its own legal basis/cutoff/count/digest, and remains blocked by applicable legal holds. This separate class does not imply that a live finance provider integration is configured.

Production note: migration 160 and service contracts implement the fail-closed orchestration and immutable evidence schema. Provider-specific integrations are deployment-owned; no live external service has been claimed deleted by CI. In this repository the provider adapter registry starts empty and finance adapter unset, so any erasure with missing target coverage or missing adapter fails closed and cannot be externally verified. Register and smoke-test provider adapters, secret/config references, inventory completeness, replica/version deletion, backup expiry SLAs and recovery behaviour before treating whole-tenant erasure as production-supported.

## Durable external resource inventory and per-object recovery ledger (migration 219)

Migration \`219_saas_external_erasure_resource_manifest_receipts.sql\` adds three tenant-isolated evidence relations for the next provider-adapter slice:

- \`saas_tenant_external_propagation_manifests\` binds an exact inventory digest to the approved erasure request/version, propagation run, independently reviewed target, source-export digest, retention-policy version map, adapter version and bounded page/batch declarations. A manifest may be sealed only when every declared ordinal has a persisted item; sealed or aborted manifests are immutable.
- \`saas_tenant_external_propagation_manifest_items\` stores each provider resource identity, its digest and a stable per-resource operation key. It rejects duplicate identities and unsafe URL/credential-like references and can only be appended while the parent manifest is in \`STAGING\`.
- \`saas_tenant_external_propagation_resource_events\` is an append-only per-identity event log. It records \`PREPARED\` before \`DELETE_REQUESTED\`, then provider deletion and independent verification, with terminal \`BLOCKED\`, \`RETAINED\` or \`FAILED_RETRYABLE\` outcomes. Retryable failure requires a numbered new attempt; verified/blocked/retained outcomes cannot be extended.

All three tables use forced RLS and restrictive tenant policies. The governance inventory marks these relations as protected control-plane evidence, excluded from generic export/erasure. Provider resource references must remain opaque identifiers, never URLs or credentials.

This migration establishes the durable schema and transition guards only. The existing external propagation saga is **not yet wired** to populate and seal these manifests or append the per-object event stream, and the WMS POD delete primitive is not registered as an external erasure adapter. Do not interpret target-level receipts as proof that a complete resource inventory has been recorded. Keep AS-137 / NFR-PROD-14 Partial until the adapter-to-ledger integration, actual resource enumeration, uncertainty recovery, all required storage adapters and controlled staging evidence pass.

