# Research ingestion & evidence-review productionization — acceptance evidence (2026-10-22)

## Status

**Implemented on the rakibul-hasan branch; release-gate status remains subject to the latest API and PostgreSQL CI results.** This slice adds concrete provider metadata verification, bounded customer text-file intake, digest-backed provenance, tenant rights enforcement, explicit knowledge-release retraction, and source-revision-driven withdrawal of a stale active release. It does not claim autonomous crawling, OCR/PDF parsing, or semantic citation entailment.

## Lifecycle map

| Lifecycle step | Implementation | Evidence and fail-closed behavior |
| --- | --- | --- |
| Source registration and rights decision | Existing tenant-scoped source registry and append-only rights snapshots | Unknown/restricted rights cannot authorize full-text storage; rights/source revisions invalidate queued jobs and previous snapshots. |
| Provider/source identity | ResearchSourceAdapterService: DOI → Crossref; PubMed ID → Europe PMC | Fixed HTTPS hosts only, redirect rejection, 7-second timeout, 1 MiB response cap, provider response SHA-256, normalized identifier match and title-similarity score. Arbitrary source_url values are never fetched. |
| Authenticity review | POST /sources/:sourceId/authenticity-checks/:checkId/decision | A different reviewer is required. Only a current exact provider identifier plus title-similarity score ≥ 0.85 may be accepted. Database triggers independently bind a VERIFIED result to the registered DOI/PMID and source revision. |
| Customer-file intake | POST /sources/:sourceId/documents | Requires idempotency key, tenant-owned CUSTOMER_PROVIDED source, approved rights and explicit full-text storage permission. Allows plain text, CSV, Markdown, HTML and JSON; ≤ 5 MiB input and ≤ 1 MiB extracted text. Rejects unsupported binary/PDF/archive formats. |
| Content provenance and dedup | Immutable document metadata plus separate content row | Stores byte SHA-256, extracted/normalized text SHA-256, parser version, source/right versions and a bounded 16-slot text-shingle signature. Exact/similar matches are linked as review candidates; records are not silently merged. |
| Durable ingestion/extraction | Existing ResearchIngestionService lease, checkpoint, retry, immutable events, extraction-run/items and review-gate implementation | Idempotent jobs, bounded metadata-only checkpoints, version/lease checks, explicit failure reasons, source/right snapshot validation, atomic extraction persistence and append-only review decision. Worker deployment remains separate. |
| Claim/evidence review | Existing deterministic rubric, locator/registered-identifier validation, safety review and database insert/approval guards | Suggested grade is not automatic approval. Metadata citation checks do not fetch citation passages or prove semantic entailment. Prompt-injection red-team cases remain heuristic screening, not a perfect detector. |
| Release promotion and rollback | Existing immutable version history, evaluation fingerprint, active channel and rollback API | Promotion requires matching passing evaluation, reviewer safety statement and external regression-evidence reference. Rollback revalidates current rights/evidence and moves only the active pointer. |
| Release retraction and stale-source withdrawal | POST /releases/:releaseId/retract; source-revision/rights trigger | Retraction requires research.review, a reason and current active version. Source metadata/rights revision automatically withdraws an affected active channel and appends RETRACTED history plus outbox event. Migration 176 defers an integrity check so channel withdrawal cannot commit without a matching immutable retraction event. |
| Content purge | Existing stored-claim-excerpt purge plus uploaded-document-content purge triggers | Access revocation, restriction or loss of storage rights deletes stored bytes/text in the same transaction; document/excerpt digests, version and reason remain in an immutable tenant-scoped receipt. |

## API paths added

- POST /research/sources/:sourceId/authenticity-checks
- GET /research/sources/:sourceId/authenticity-checks
- POST /research/sources/:sourceId/authenticity-checks/:checkId/decision
- POST /research/sources/:sourceId/documents (multipart field file, required Idempotency-Key header)
- GET /research/sources/:sourceId/documents
- GET /research/sources/:sourceId/documents/:documentId/content (trusted worker permission only)
- POST /research/releases/:releaseId/retract

Existing source/rights history, job/checkpoint/retry, extraction, claim assessment/approval, release evaluation/promotion, history and rollback endpoints remain the downstream lifecycle.

## Reproducible verification

| Evidence | Coverage |
| --- | --- |
| services/api/src/research/research-source-adapters.spec.ts | DOI/PMID provider identity, title mismatch, URL/SSRF boundary, provider response cap and stable failure behavior. |
| services/api/src/research/research-source-document-parser.spec.ts | UTF-8 and size bounds, HTML script stripping, JSON parse, unsupported binary formats, normalized hashes and duplicate signatures. |
| services/api/src/research/research-source-production.service.spec.ts | Rights-gated upload, DB content write, idempotent replay/conflict and duplicate-candidate linking. |
| services/api/src/research/research-ingestion.service.spec.ts | Durable job and extraction state transitions, expected version/lease checks, immutable reviewer decisions and provenance. |
| services/api/test/research-ingestion-provenance.sql | Forced tenant RLS, source/right history, ingestion/checkpoint/extraction guards, review gates, digest receipts and rights integrity. |
| services/api/test/research-source-production.sql | Provider identity match guard, independent authenticity review, customer-document storage, digest matching, no direct content delete, rights-revocation purge. |
| services/api/test/research-release-lifecycle.sql | Release channel/versioning, lifecycle event guards, explicit and source-triggered retraction, and deferred audit completeness. |
| services/api/src/research/research-growth.postgres.integration.spec.ts | Real PostgreSQL invariant test that revoking a linked source right clears the active channel and records a RETRACTED event. |
| .github/workflows/api-postgres-ci.yml | Ordered manifest apply, replay/idempotency checks, PostgreSQL contracts and the full API test/build/lint jobs. |

Migrations 171–176 add provider/document provenance, content-integrity enforcement, source-identity binding, release retraction, source-driven release withdrawal and deferred retraction-audit integrity. They are registered in scripts/audit/migration-manifest.txt in explicit apply order.

## Remaining production gates

1. Deploy and operationally monitor a worker that consumes the durable ingestion queue, uses the document-content endpoint and posts extraction results. The API does not autonomously launch a crawler or LLM.
2. Validate live provider terms/rate limits and configure the permitted-license policy for each customer. Metadata verification is not legal authorization and does not prove publisher-byte authenticity.
3. Add PDF/OCR only through an approved parser with malware/content scanning, and add stronger source-version clustering beyond uploaded-text similarity.
4. Run external semantic citation-to-claim entailment and prompt-injection red-team benchmarks; preserve results as reviewed release regression evidence.
5. Confirm the latest commit's API and PostgreSQL CI are green before marking this work as release-accepted; do not treat a pending, cancelled or stale-SHA run as passing.
