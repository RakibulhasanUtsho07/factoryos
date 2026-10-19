# CBB evidence provenance, source links, revision history, and conflicts

**Scope:** Phase D, Round 25 — CBB evidence provenance, source links, version history, and conflict handling.  
**Implementation:** API and PostgreSQL contract in `services/api/src/cbb/cbb.evidence.service.ts`, `services/api/src/cbb/cbb.controller.ts`, and `migrations/131_cbb_evidence_provenance.sql`.  
**Status:** Backend slice implemented; verify the linked CI runs and environment-specific migration/integration checks before treating deployment acceptance as complete.

## Behaviour and traceability

| Requirement | Implementation / acceptance evidence |
|---|---|
| Preserve evidence origin | Evidence records retain `source_type`, `source_ref`, source timestamp, optional source system/record/version and URI, source key, SHA-256 content hash, evidence grade, confidence, visibility, metadata, actor, and creation time. |
| Make repeated ingestion safe | A source key identifies a source within a tenant/factory. Identical content is returned as an idempotent replay. Changed content requires the exact latest predecessor and creates the next immutable revision. A stale predecessor or mismatched source version is rejected. |
| Keep revision history | `GET /v1/business-model/evidence/:evidenceId/history` returns ordered revisions for the same source key. A history lookup is tenant/factory scoped and must use a visibility-specific route. |
| Connect evidence to CBB graph | `POST /v1/business-model/evidence/:evidenceId/links` records `SUPPORTS`, `CONTRADICTS`, `SUPERSEDES`, or `RELATED_TO` against the active blueprint/version and a typed graph target. Link rows are immutable and remember the exact blueprint version. |
| Surface source disagreements | A new contradiction link creates or updates an open review conflict for the graph subject. Replaying an existing link does not reopen a resolved/dismissed conflict. Further evidence can be appended to an open conflict. |
| Govern conflict resolution | Conflicts can be listed, their immutable history retrieved, and open conflicts resolved/dismissed using optimistic version checks, a reason, a resolution reference, and (for resolution) evidence attached to that conflict. |
| Enforce database-level integrity | Migration 131 adds revision/source constraints, scoped foreign keys, target/link validation, append-only triggers, conflict transition guards, conflict history, and forced row-level security for conflict history. |
| Record accountable actions | Evidence creation, link creation, and conflict decisions emit audit events with the authenticated tenant/factory and actor context. The audit and history contract must be checked in integration tests alongside the mutation. |

This document records the implemented contract and is not, by itself, a claim that every FactoryOS SRS requirement or the full product UI is complete.

## API surface

All routes below are under `/v1/business-model` and require the relevant IAM permission plus authenticated factory scope.

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /evidence` | `ai.business.review` | Record evidence or append a new source revision. |
| `GET /evidence` | `ai.business.read` | List internal evidence with source/state/target filters and pagination. |
| `GET /evidence/restricted` | `ai.business.review` | List restricted evidence with the same filters. |
| `GET /evidence/:evidenceId/history` | `ai.business.read` | Read internal source revision history. |
| `GET /evidence/restricted/:evidenceId/history` | `ai.business.review` | Read restricted source revision history. |
| `POST /evidence/:evidenceId/links` | `ai.business.review` | Attach source evidence to a current CBB target. |
| `GET /versions` and `GET /versions/:versionId/map` | `ai.business.read` | Inspect blueprint version history and a selected version's graph. |
| `GET /conflicts` | `ai.business.read` | Filter and page through conflict reviews. |
| `GET /conflicts/:conflictId/history` | `ai.business.read` | Read append-only conflict decision history. |
| `POST /conflicts/:conflictId/decision` | `ai.business.review` | Resolve or dismiss an open conflict using its expected version. |

Evidence list results must apply the same tenant, factory, visibility, and target predicates to both the count and item queries. Returned evidence links must be limited to the requested graph target when a target filter is supplied.

## Data and safety contract

- A valid content fingerprint is a 64-character hexadecimal SHA-256 digest. Source timestamps must include an explicit timezone.
- Source URIs, when present, are normalized HTTP(S) URLs. A source reference may be non-URL identifiers such as ERP record keys; in that case the URI remains absent unless explicitly supplied.
- New source revisions are append-only. They link to the exact latest predecessor, advance revision numbers sequentially, and may not reuse the predecessor's content hash as a new revision.
- Evidence rows and evidence links are immutable; corrections require a new source revision or a new link rather than rewriting provenance.
- Evidence, graph targets, blueprints, conflict rows, and resolution evidence must belong to the authenticated tenant/factory scope. Evidence links bind to the graph version at creation and cannot silently follow a later promoted version.
- Conflict decisions use `expected_version` to prevent a stale reviewer from overwriting a newer decision. Resolution evidence must be attached to the conflict and scoped to the same factory.
- Conflict history is append-only and forced-RLS protected. Open-conflict uniqueness and transition rules are enforced in PostgreSQL as well as the application.
- Evidence content and metadata must be treated as untrusted input. Provenance records establish origin and integrity metadata; they do not by themselves prove that a source's claims are truthful.

## Validation

The implementation has focused service unit tests in `services/api/src/cbb/cbb.evidence.service.spec.ts` and a PostgreSQL schema contract in `services/api/test/cbb-evidence-provenance.sql`. The contract checks required columns, RLS, indexes, guard triggers, scoped foreign keys, and migration registration.

Before production rollout:
1. Apply migrations in the repository's supported migration order through `131_cbb_evidence_provenance`.
2. Run the CBB evidence service tests and PostgreSQL integration/contract suite against a real PostgreSQL instance.
3. Confirm restricted-evidence read paths and all mutation + audit/history guarantees under tenant/factory-scoped credentials.
4. Confirm CI is green for the exact branch head; a local or mock-only test pass is not a substitute for the PostgreSQL contract.

## Related CBB governance

Round 26 adds role-aware visibility, staleness review, canonical terminology aliases, impact tracing, and audited version rollback. See [CBB governance](cbb-governance.md) for SRS traceability, API permissions, data lifecycle and acceptance checks.

## Boundaries

This slice provides backend provenance, versioning, and conflict governance. It does not imply that an external crawler, source authenticity verification service, legal rights review, human review UI, or SRS-wide end-to-end acceptance is delivered unless those are separately implemented and tested.
