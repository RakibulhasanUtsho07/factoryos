# CBB evidence provenance, source links and conflict handling

**Phase:** D — CBB, Research & Growth Intelligence  
**Round:** 25 — CBB evidence provenance, source links, version history and conflict handling  
**Requirement intent:** FactoryOS AI SRS v2.1 CBB provenance/confidence/conflict requirements (FR-CBB-04 through FR-CBB-07).

## Evidence is a source record, not a claim of truth

CBB evidence stores provenance metadata, not a copied body of an external document. Each new API-created source record must carry an explicit-timezone source timestamp and a SHA-256 content fingerprint. Optional source identity includes a stable source key, source system, upstream record ID, upstream version and HTTP(S) source URL. The recorded state (`VERIFIED`, `INFERRED`, `PROPOSED`, `CONFLICTING`, `STALE`) remains confidence/evidence status; it does not replace permission checks or prove the source itself is true.

Raw source content is not persisted by this CBB evidence API. A hash records the submitted fingerprint; it does not independently verify bytes at a remote URL. Source fetchers, OCR and publisher/ERP/MES ingestion workers are separate integrations.

## API

These routes are under `/api/v1/business-model` and require authenticated tenant and factory scope.

| Route | Permission | Purpose |
| --- | --- | --- |
| `POST /evidence` | `ai.business.review` | Record source metadata and digest; identical content is an idempotent replay |
| `GET /evidence` | `ai.business.read` | Search internal evidence by source, state, source key or linked graph target |
| `GET /evidence/restricted` | `ai.business.review` | Search restricted evidence; it is not exposed on the general read endpoint |
| `GET /evidence/:evidenceId/history` | `ai.business.read` | Inspect a source key's immutable evidence revisions |
| `POST /evidence/:evidenceId/links` | `ai.business.review` | Link evidence to a specific current-version blueprint target |
| `GET /versions` | `ai.business.read` | List immutable blueprint version snapshots and identify the current version |
| `GET /versions/:versionId/map` | `ai.business.read` | Retrieve a tenant/factory-scoped historical graph version |
| `GET /conflicts` | `ai.business.read` | List open or terminal evidence conflicts |
| `GET /conflicts/:conflictId/history` | `ai.business.read` | Inspect the append-only conflict decision/evidence timeline |
| `POST /conflicts/:conflictId/decision` | `ai.business.review` | Resolve or dismiss an open conflict with a version-checked decision |

Evidence list filtering accepts `source_type`, `state`, `source_key`, `target_type`, `target_id`, `limit` and `offset`. A graph-target filter uses both `target_type` and `target_id`; the API constrains list/page sizes.

### Source revisions and replay rules

- The first revision of a stable `source_key` is revision 1.
- Re-submitting the same digest with unchanged/omitted source-version metadata returns the existing evidence record and does not create a duplicate revision or audit event. A conflicting upstream version is rejected instead of silently discarding the changed version metadata.
- A changed digest for an existing source conflicts unless the request supplies `supersedes_evidence_id` pointing to the exact latest revision in the same tenant/factory/source key.
- Revision sequence, predecessor scope, source timestamp and 64-character SHA-256 digest are guarded by PostgreSQL, not only by DTO validation.
- Evidence records and evidence links are immutable. Corrections create a new revision rather than editing historical provenance.

The server serializes concurrent source-key revisions and the database rejects replay races, source-key/factory crossover, invalid revision numbering and attempts to supersede an older predecessor.

### Version-bound source links

Evidence links use one of `SUPPORTS`, `CONTRADICTS`, `SUPERSEDES` or `RELATED_TO`, and name a supported CBB target type: `BLUEPRINT`, `ENTITY`, `RELATION`, `PROCESS`, `PROCESS_STEP`, `RULE`, `TERM` or `EXCEPTION`.

A link is checked against a real target in the same tenant/factory and is bound to that target's exact blueprint and version. The business map now exposes internal source provenance for visible entity and relation nodes. For all graph target types, callers can query `GET /evidence?target_type=PROCESS&target_id=<uuid>` (or another supported type); restricted source metadata is retrieved only from the review-only route. Existing links are backfilled with target blueprint/version scope where the target can be resolved safely.

### Conflicts are explicit, versioned review work

Creating a `CONTRADICTS` link opens a `business_conflicts` record or appends a newly observed evidence ID to the existing open conflict. It never overwrites the existing source or silently alters the verified graph. Database guards check evidence IDs and the conflicted graph subject within the same tenant/factory/blueprint.

The decision request uses `action: RESOLVE|DISMISS`, `expected_version`, a reason and a durable resolution reference. Resolving additionally requires `resolution_evidence_id` that is already attached to the conflict. The selected resolution record must be scoped to the same factory. Only an open conflict may be decided; a stale version returns a conflict response so the reviewer must refresh history instead of losing another review's changes.

Conflict history is written by a database trigger, tenant RLS is forced, direct history inserts/updates/deletes are blocked, and decision actions are audited. A still-open conflict suppresses its affected entity (and edges attached to a conflicted entity/relationship) from the normal business map. Resolving/dismissing the conflict does not mutate the versioned graph or mark evidence VERIFIED automatically; a business-model change must still follow the existing review/promotion path.

## Data safety

- The existing CBB tables keep forced tenant row-level security. The new conflict-history table also uses forced RLS with a tenant predicate.
- Composite foreign keys prevent evidence, links, target blueprint versions and resolution evidence from crossing tenant/factory boundaries.
- Source evidence and provenance links reject update/delete; conflict identity is immutable and conflict decisions require optimistic version checks.
- List/query limits are bounded; review actions require `ai.business.review`, while general reads expose only `INTERNAL` evidence.
- Audit records store source identifiers, hashes, revision numbers and decision metadata—not raw source content.

## Acceptance boundaries and remaining integrations

This slice provides the database and authenticated API contract for provenance and manual conflict review. It does **not** run external crawlers, download or OCR source documents, verify the live bytes behind a URI, infer the truth of a claim from its hash, or automatically convert conflict resolution into model changes. Providers must submit their stable source key/version/time and digest from an authorized integration path; human reviewers or upstream source connectors remain responsible for source trust and rights decisions.
