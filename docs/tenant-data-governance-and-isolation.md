# Tenant Data Governance, Retention, Erasure and Isolation

**Status:** implementation/acceptance matrix; policy owners must approve durations before production enforcement.
**Scope:** tenant export and migration, deletion/erasure requests, retention controls, audit coverage, and cross-tenant isolation.
**Related implementation:** `saas-tenant-data-transfer.service.ts`, `saas-tenant-data-transfer.worker.ts`, `saas-tenant-postgres-dataset-source.ts`, `saas-tenant-postgres-migration-target.adapter.ts`, `audit/audit.service.ts`, migrations 045–154.

## Security invariants

1. Every tenant-owned query must use a verified tenant context and tenant predicate; RLS is defense in depth, not a replacement for authorization.
2. An export is complete only when its required category manifest, row counts, hashes, encrypted artifact receipt and final attestation agree. Failed/incomplete bundles must be removed best-effort and never presented as completed.
3. Cross-tenant export and deletion requests are denied before reading or mutating data. Object-store references are opaque; no raw credentials, secrets, access tokens or encryption keys belong in export payloads.
4. Audit events are tenant-scoped, actor-attributed where available, data-classified and free of secret payloads. Audit evidence must not be silently deleted by routine business-data erasure.
5. Deletion is a governed lifecycle, not an unscoped SQL DELETE. A request must be authorized, reasoned, idempotent, versioned, reviewable and independently verifiable.
6. Legal holds, unresolved financial obligations, statutory records and append-only audit/security evidence can delay or narrow erasure. The policy owner must define applicable law and exceptions; software must not invent a universal retention duration.
7. A failed audit write, failed tenant-context setup, ambiguous tenant scope, or unrecognized table/category must fail closed.

## Retention policy registry

Retention periods are intentionally not hard-coded until legal/compliance owners approve the duration and jurisdiction. Every production policy needs a stable policy key/version, data class, scope, retention duration, trigger (creation/event/termination), legal basis, legal-hold behavior, action (delete/anonymize/archive), approval owner, and testable evidence of execution. Policy changes are versioned; a new version does not retroactively rewrite completed retention runs.

Minimum classes to govern:
- Operational/business records and evidence.
- Usage, adjustments, provider reconciliation and billing-support records.
- Authentication, authorization and security events.
- Immutable audit trail and approval evidence.
- Export bundles, manifests and temporary staging artifacts.
- Backups, snapshots, replicas and disaster-recovery copies.
- User-linked personal data and derived/cache/search data.

Until a policy is approved, the service must report the class as **retention policy unresolved** and must not claim automated deletion compliance. Temporary export artifacts should have a short, explicitly configured expiry, encrypted storage, least-privilege access, and verifiable cleanup; the expiry duration must be approved in deployment configuration.

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

Required state machine for a production erasure workflow:
`REQUESTED → UNDER_REVIEW → APPROVED → EXECUTING → VERIFIED`, with terminal `REJECTED` or `BLOCKED_LEGAL_HOLD` states. Every transition needs expected version, actor, reason, idempotency key and audit record. Execution must:
1. resolve and lock the exact tenant; verify permission and separation of duties;
2. evaluate legal holds, retention obligations, billing/subscription and data-transfer dependencies;
3. enumerate the tenant's reviewed data inventory and classify each item as erase, anonymize, retain, or external-adapter pending;
4. delete/anonymize in bounded, retry-safe batches with progress/checkpoints and no cross-tenant predicates;
5. purge derived indexes, object-store exports, caches and eligible replicas through registered adapters;
6. report backup expiry separately; deletion from a live database does not prove immediate removal from immutable backups;
7. verify residual counts and emit a signed/audited completion manifest with explicit exclusions.

**Important current boundary:** the tenant export/migration backend does not by itself prove that a complete tenant-erasure workflow, object-store purge, external provider purge, or backup expiry is implemented. Do not use migration or export endpoints as deletion endpoints. A production deletion API must be separately reviewed and tested before claiming FR-PROD-15 erasure acceptance.

## Audit coverage matrix

| Action/data domain | Required audit evidence | Current repository evidence | Acceptance |
|---|---|---|---|
| Export request, attest, validate, cancel | tenant, actor, transfer ID/version, category manifest digest, reason, outcome | SaaS data-transfer service and audit service | Exercise success, denial, replay and partial failure |
| Tenant migration/import | source/target tenant IDs, transfer ID, target receipt/digest, excluded categories | exact-schema target adapter and transfer receipt | Prove no existing rows overwritten; target isolation tested |
| Retention policy changes/runs | policy key/version, scope, due counts, deleted/anonymized counts, errors, legal holds | policy registry/run evidence must be confirmed before acceptance | Pending if no executor and durable run ledger |
| Erasure request/approval/execution | request/version, requester/approver, legal hold, scope manifest, residual report | no claim made by export implementation | Separate approved erasure lifecycle required |
| IAM/permission and tenant-scope denial | actor, requested tenant/resource, decision, correlation ID | PermissionGuard/IAM and AuditService | Verify denial events are emitted without leaking resource data |
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

- Add schema-wide inventory query/check so every tenant-owned table is either assigned a documented category or explicitly excluded with rationale.
- Add RLS + forced-RLS verification for every tenant-owned table and policies that bind the active tenant context.
- Add two-tenant PostgreSQL tests for read/write/delete, joins, foreign keys, RLS bypass assumptions, export, migration and audit.
- Add retention policy and execution ledger only after approved durations/legal holds are supplied; test dry-run, partial failure, retries, and immutable audit.
- Add separately authorized erasure state machine and external-store adapters before advertising tenant deletion as supported.
- Run API build/lint/unit tests and PostgreSQL CI on the exact commit; this document alone is not runtime proof.

## Requirement traceability

Maps to the tenant-wide portion of `FR-PROD-15`, SaaS export/migration requirements in `docs/saas-productization.md`, and the tenant isolation/privacy principles in the engineering blueprint. The signed SRS/HLD must be present and approved to complete formal requirement-by-requirement sign-off.
