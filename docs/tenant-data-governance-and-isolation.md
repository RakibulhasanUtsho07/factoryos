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

Migration `156_tenant_privacy_inventory_and_rls_guardrails.sql` adds a database inventory for every public base/partition relation that directly exposes `tenant_id`. Each entry records the data category, export disposition, erasure disposition, audit requirement and reason. An unknown relation is classified as `UNREVIEWED`, excluded from generic export, and blocked from generic erasure until an adapter is reviewed.

For every direct `tenant_id` relation the migration enables and forces row-level security and installs an additional **restrictive** policy that ANDs the current transaction tenant into all operations. It preserves existing permissive policies, rather than unconditionally adding another permissive rule that could OR with and weaken a narrower in-tenant access policy. Only when a relation has no permissive policy at all does it install a tenant-bound fallback so the relation is not left inaccessible. `user_roles` and `role_permissions`, which do not have a direct `tenant_id` column, receive derived-scope restrictive policies through membership/role/factory ownership and are inventoried separately.

The inventory deliberately does not automatically make new tables exportable. Export authorization remains tied to the reviewed source/target allowlists in `SAAS_TENANT_DATASET_TABLES` and the special logical IAM transfer adapter. The PostgreSQL CI suite now applies and reapplies migration 156, then executes `services/api/test/tenant-data-governance-inventory.sql`; the tenant-isolation integration test also discovers all public tables with `tenant_id` from PostgreSQL catalogs instead of relying on a fixed hand-maintained table list.

**Coverage boundary:** catalog enumeration covers direct `tenant_id` relations plus the two known IAM-derived relations. Any additional table whose tenant ownership is expressed only through foreign keys or another indirect relationship must be added to the reviewed derived-scope inventory and tests before it is considered covered. This is not proof that every external copy or every tenant-owned business relation has a usable export/erasure adapter.

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

- Keep migration 156 and `services/api/test/tenant-data-governance-inventory.sql` as the automated inventory/RLS gate for every public base or partition table with a direct `tenant_id`; every such relation must have forced RLS and both current-tenant policy fences.
- Extend the derived-scope inventory for any tenant-owned relation without a direct `tenant_id` beyond the currently registered `user_roles` and `role_permissions`; use explicit ownership joins and two-tenant tests before considering those relations covered.
- Retain two-tenant PostgreSQL tests for tenant read/write denial, RLS boundaries, retention/legal-hold/erasure ledgers, export/migration manifests and audit access; catalog checks do not replace endpoint-level failure, replay, or rollback tests.
- Approve retention durations/legal basis before execution; verify dry-run, held data, recent foreign-key dependents, partial failure, idempotent retry and immutable receipts.
- Extend the reviewed table/category inventory to all tenant-owned relations and implement/configure object-store, index/cache, replica and backup expiry adapters before advertising whole-tenant deletion as supported.
- Run API build/lint/unit tests and PostgreSQL CI on the exact commit; this document alone is not runtime proof.

## Requirement traceability

Maps to the tenant-wide portion of `FR-PROD-15`, SaaS export/migration requirements in `docs/saas-productization.md`, and the tenant isolation/privacy principles in the engineering blueprint. The signed SRS/HLD must be present and approved to complete formal requirement-by-requirement sign-off.
