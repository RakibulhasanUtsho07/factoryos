# CBB governance: access control, staleness, terminology, impact tracing, and rollback

**Scope:** Round 26, Phase D — CBB access control, staleness, terminology, impact trace, and audited rollback.  
**Requirements:** FactoryOS AI SRS v2.1 FR-CBB-06 and FR-CBB-07 (P0), FR-CBB-10, FR-CBB-11 and FR-CBB-12 (P1), plus the CBB immutable-version invariant documented in `migrations/014_cbb_business_model.sql`.  
**Implementation:** `services/api/src/cbb/cbb.governance.service.ts`, `services/api/src/cbb/cbb.controller.ts`, `services/api/src/cbb/dto/cbb-governance.dto.ts`, `migrations/132_cbb_governance.sql`.

## Requirement-to-implementation traceability

| Requirement | Delivered contract | Verification |
|---|---|---|
| FR-CBB-06 — inspect and retire stale items; audit changes | Staleness scans store review candidates; a reviewer can mark an item stale by creating a pending `SET_STATE` proposal, reconfirm it, or dismiss it. The underlying immutable graph row is not edited in place. | `CbbGovernanceService` unit tests; PostgreSQL schema contract. |
| FR-CBB-07 — tenant isolation | Every governance read/write is tenant/factory scoped; new governance tables have forced RLS and tenant policies; explicit role grants are scoped to the factory. | `services/api/test/cbb-governance.sql`; API PostgreSQL CI. |
| FR-CBB-10 — terminology dictionary and source variants | Client dictionary reads the current version's `business_terms`; aliases map source-system/language variants to an existing canonical term. Alias review is version-checked, verifies the canonical term still exists in the active dictionary, requires write access to that canonical term, and keeps append-only history. | Alias unit tests and audit/history triggers. |
| FR-CBB-11 — impact tracing | Directed CBB entity relations are traversed to a bounded depth, and both the relation and each downstream entity must pass the caller's object-level ACL before traversal continues; hidden edges cannot be used as a side channel to discover downstream nodes. Explicit, version-bound links expose external PROCESS, RULE, TERM, EXCEPTION, KPI, ORDER, ANALYST_WORKFLOW and SYSTEM references. | Service tests; SQL constraints and access checks. |
| FR-CBB-12 — role-based Business Profiles | `business_acl` grants READ/EDIT/OWNER at target or field level; graph/process reads, change proposals, conflicts, conflict history, terminology, staleness reviews, version lists, rollback history and blueprint summaries are constrained by the active caller's tenant membership and factory/global roles. Alias rows are visible only when their canonical term is visible. Access grant/revoke actions are recorded in ACL history and audit events. | Service/controller tests and ACL-history schema contract. |
| Version safety — rollback | Rollback clones a selected historical snapshot into a newly numbered version, advances the current pointer using an expected-current-version guard, and writes a dedicated rollback receipt plus audit event. | Rollback concurrency test; API and PostgreSQL CI. |

This is a backend governance slice. It does not claim that a full front-end access-profile editor, automatic external source ingestion, or all cross-domain impact edges already exist; cross-domain impact links are explicit, governed references until their producing domain integrates them.

## API

All routes are under `/v1/business-model`. Existing IAM permission checks and authenticated factory scope remain required.

| Method and path | Permission | Behaviour |
|---|---|---|
| `GET /access` | `ai.business.read` | Lists CBB role grants for the factory. |
| `POST /access` | `ai.business.review` | Grants target- or field-level READ/EDIT/OWNER access to a tenant role. Replacing a grant records revoke/grant history in the same transaction. |
| `DELETE /access/:aclId` | `ai.business.review` | Revokes a factory-scoped access grant and writes audit/history. |
| `GET /staleness` | `ai.business.read` | Lists the latest stale-evidence review candidates. |
| `POST /staleness/scan` | `ai.business.review` | Scans the current immutable version for VERIFIED/INFERRED objects whose last linked source evidence (or object creation time when evidence is absent) exceeds the supplied threshold. |
| `POST /staleness/:reviewId/decision` | `ai.business.review` | Applies an optimistic-versioned MARK_STALE, RECONFIRM, or DISMISS decision. MARK_STALE creates a pending CBB `SET_STATE` proposal. |
| `GET /terminology?search=...` | `ai.business.read` | Lists version-bound canonical CBB terms and tenant/factory-scoped aliases. |
| `GET /terminology/resolve?term=...&source_system=...` | `ai.business.read` | Resolves an exact canonical term or a verified/inferred alias, with proposed aliases returned as suggestions. |
| `POST /terminology/aliases` | `ai.business.review` | Creates a PROPOSED alias only when the canonical term exists in the current dictionary. |
| `POST /terminology/aliases/:aliasId/decision` | `ai.business.review` | Verifies an alias or marks it STALE using an expected version and meaningful reason. |
| `POST /impact-links` | `ai.business.review` | Adds a unique, immutable, version-bound impact reference. |
| `GET /impact/:targetType/:targetId?depth=3` | `ai.business.read` | Traverses visible downstream graph entities and returns explicit external impact references. Depth is bounded to 1–5. |
| `POST /versions/rollback` | `ai.business.review` | Restores content from a historical version by creating a new immutable version. Requires both `source_version_id` and `expected_current_version_id`, plus a reason. |
| `GET /rollback-history` | `ai.business.read` | Lists immutable rollback receipts with actor, from/restored/to version IDs, reason and correlation ID. |

## Access-control semantics

- A CBB read still requires the baseline `ai.business.read` permission. Governance writes require `ai.business.review`.
- The service resolves active tenant membership and factory-scoped or tenant-wide role assignments. Target-level ACL rules can limit a particular node/process/term; field-level rules can redact named fields.
- To keep existing tenant deployments compatible, a target with **no explicit ACL entries** retains baseline IAM-authorized visibility. Once object-level ACL entries exist for a target, only callers with a matching role grant can see it. A field with explicit grants is omitted for unmatched roles.
- Business Map reads filter protected entities and relations and remove edges whose endpoints are not visible. Process-list/detail reads apply their target grants too. Proposal/conflict list responses are filtered by target ACL; conflict history checks the subject ACL before returning history. Proposal approval/rejection also checks field-level EDIT/OWNER grants for the proposal payload, not only a generic review permission. Evidence search checks an explicitly requested target before querying, and returned source links are redacted when their graph target is not visible. Staleness rows and rollback history require readable blueprint scope and filter stale target records by role ACL. Blueprint summary and version-list endpoints do not return content when the active blueprint is hidden. Internal/restricted evidence retains its separate permission boundary.
- ACL grants and revocations create append-only `business_acl_history` snapshots and transaction-bound audit events. The new history table uses forced RLS.
- Scope is never accepted from caller-supplied tenant/factory headers. The service uses the authenticated request context and checks targets against the active blueprint version before granting access.

## Staleness lifecycle

The scan is deterministic and bounded by a reviewer-supplied age threshold (1–3650 days). For each VERIFIED/INFERRED entity, relation, process, process step, rule, term, or exception in the current version it finds the latest linked source timestamp. If there is no linked source timestamp it falls back to the object's creation timestamp. Old evidence is a review signal, not proof that the object is wrong.

A scan creates/refreshes an OPEN review record. A stale decision does **not** directly update an immutable CBB row; it creates a pending `SET_STATE` proposal with proposed state `STALE`. The existing proposal approval/promotion workflow must materialize that new state in a new CBB version. A concurrent reviewer with an outdated `expected_version` receives a conflict instead of overwriting a newer decision.

## Terminology lifecycle

- Canonical terms come from the active immutable `business_terms` snapshot.
- Alias creation normalizes Unicode (NFKC), normalizes language identifiers, rejects self-aliases and refuses a mapping whose canonical term is absent or not VERIFIED/INFERRED in the current CBB dictionary. A new alias begins as PROPOSED. It may be verified or marked STALE with an optimistic version check; stale aliases are not silently reactivated.
- Alias identity is scoped by tenant, factory, normalized spelling, source system, and language. The unique index in `133_cbb_terminology_context.sql` and the application advisory lock use the same context key; importing `PO → Purchase Order` from ERP/en-US does not block a different qualified mapping for another source/language, while a duplicate in the exact same context is rejected.
- Alias listing and lookup require read access to the mapped canonical term, not just access to the alias row. Searching by alias must still resolve its canonical ACL even when the canonical term itself does not match the search text. Hidden canonical mappings are omitted.
- Resolution considers only VERIFIED/INFERRED direct terms and aliases. When source-system or language context is supplied, exact-context candidates outrank generic fallback candidates. If equally specific candidates map to different canonical terms, resolution returns an explicit ambiguous result rather than choosing arbitrarily. Proposed aliases are suggestions, not authoritative mappings.
- Each alias insertion/update/retirement generates a trigger-managed history snapshot. Alias mappings are client/factory scoped, not globally shared.

## Impact trace

For an ENTITY root, the trace follows directed, VERIFIED/INFERRED `business_relations` on the active version, prevents cycles using a visited UUID path, excludes targets with open conflicts, caps depth at five, and filters returned graph items through role ACLs. Additional links map a CBB object to a governed downstream reference such as an order, KPI or Analyst workflow.

External links are explicit references, not a claim that the referenced order/KPI/Analyst workflow's current state has been automatically fetched or validated. Producer domains should add/remove these references through their own reviewed lifecycle. Impact links are immutable and copied to a new version during rollback.

## Audited rollback

Rollback never moves the pointer back to an old row and never edits/deletes a historical CBB version. It locks the active blueprint, verifies the caller's expected current version and a same-blueprint historical source version, allocates a new version number, clones every CBB graph category with new IDs, remaps relations and process-step parents, restores evidence links, impact links, role ACLs and applicable open conflict reviews, then advances the current version pointer in the same transaction.

A reason is mandatory. `business_cbb_rollback_events` stores the from-version, restored-from-version, new to-version, actor, correlation ID and timestamp. The same transaction writes an audit event, so the graph pointer cannot commit without the rollback receipt and audit insert. Rollback is rejected when the current version has advanced since the caller read it.

## Database and tests

Migration `132_cbb_governance.sql` adds staleness review records, terminology aliases and append-only history, explicit impact links, rollback receipts, ACL change history, indexes, triggers and forced tenant RLS. Migration `133_cbb_terminology_context.sql` adds a source/language-aware unique key and context lookup index; API creation and resolution use the same context key and reject ambiguous equally specific mappings. The PostgreSQL contract lives in `services/api/test/cbb-governance.sql` and is run from `.github/workflows/api-postgres-ci.yml`. Focused application tests are in `services/api/src/cbb/cbb.governance.service.spec.ts` and `services/api/src/cbb/cbb.controller.spec.ts`; they cover role-hidden targets and evidence links, field redaction and proposal write checks, source/language-aware terminology lookup, canonical-term write permission on alias review, hidden-edge impact traversal, stale-review proposal creation, conflicting version guards, and audited rollback receipt creation.

Before production rollout, run the full API CI and PostgreSQL integration workflow at the exact branch head and apply migrations in the repository's supported order. No database was changed outside the CI disposable PostgreSQL environment by this documentation.
