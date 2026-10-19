# Research & Growth Intelligence backend

**Implementation state:** API and PostgreSQL governance foundations are implemented; full product-level Research/Growth Intelligence is not yet complete. The remaining integration/evaluation boundaries are listed at the end.

## Research API

- `POST /watchlists`, `GET /watchlists` and `POST /watchlists/:watchlistId/decision` manage tenant-scoped topic watchlists for sectors, technologies, processes, markets, sustainability and strategic questions. Query terms, inclusion/exclusion terms, and allowed source types are stored under forced RLS; activation/pause/retire events are auditable. Watchlists are configuration only and do not imply that an external crawler worker is running.

The tenant-scoped endpoints are under `/research`:

- `POST /sources` registers source metadata and rights/access claims. It starts `PENDING`; source text is always untrusted.
- `GET /sources` lists the tenant's sources and approved global references.
- `POST /sources/:sourceId/decision` records approve/reject/revoke decisions with a reason. Approval is blocked for restricted/unknown rights or missing documented rights.
- `GET /sources/:sourceId/rights-history` exposes append-only source/license/access snapshots to `research.review` reviewers. Metadata revisions and rights/access changes increment separate source/right version counters; previously queued/running work is blocked when its source revision or rights snapshot changes.
- `POST /sources/:sourceId/ingestion-jobs` queues an idempotent `METADATA_ONLY` or rights-permitted `FULL_TEXT` job. Creation captures source/rights snapshots and fingerprints. A repeated idempotency key returns the original job only for the same request hash.
- `GET /ingestion-jobs`, `POST /ingestion-jobs/claim-next`, `POST /ingestion-jobs/:jobId/checkpoint`, `POST /ingestion-jobs/:jobId/pause` and `POST /ingestion-jobs/:jobId/failure` provide tenant-scoped status, expiring worker leases, resumable metadata checkpoints, heartbeat, retry scheduling and explicit failure reasons. Each stage change creates an immutable timeline event; stale leases and out-of-date expected versions cannot overwrite a newer worker.
- `POST /ingestion-jobs/:jobId/extraction` persists a worker-reported extraction run and source-located claim candidates atomically. It records extractor/schema version, worker-attested input digest, server-computed canonical output digest, source/right revisions, prompt/config hashes when supplied, model metadata and safety findings. Extracted claims remain `PROPOSED`; prompt-control/data-exfiltration indicators require review and never auto-approve a claim.
- `GET /ingestion-jobs/:jobId/events` returns the immutable progress/failure timeline. Job outputs exclude raw source/rights snapshots; checkpoints are capped metadata-only objects and reject obvious raw-text/excerpt fields.
- `POST /sources/:sourceId/claims` creates a proposed claim only from an approved tenant source. Every claim has citation locator metadata; stored excerpts up to 4,000 characters are permitted only when the source's rights explicitly permit full-text storage.
- `GET /claims` returns tenant claims and approved claims from the global namespace. `POST /claims/:claimId/decision` assigns an evidence grade and approves/rejects/supersedes tenant claims after source checks.
- `POST /claims/:claimId/links` records `SUPPORTS`, `CONTRADICTS` and `RELATED_TO` relationships without silently merging conflicting claims.
- `POST /releases` creates a versioned draft bundle from visible approved claims. `POST /releases/:releaseId/evaluate` persists an immutable, versioned contract-evaluation record with a content fingerprint, citation/rights/consistency checks and a conservative prompt-injection indicator. `POST /releases/:releaseId/promote` requires that a passing evaluation is attached to the unchanged draft, then reruns the checks and requires reviewer safety and external regression-evidence attestations. Once promoted, the release is immutable.
- `POST /claims/:claimId/relevance` maps an approved research claim to a verified/inferred CBB node for the authenticated factory, with tenant evidence, counter-evidence, assumptions and validation plan. `POST /relevance/:mappingId/decision` approves/rejects the mapping.

Global rows are read-only to regular tenant sessions: RLS permits reading `tenant_id IS NULL` global research rows but only permits writes where `tenant_id` equals the current tenant. This prevents a tenant upload from being stored into the shared research namespace.

## Growth API

The factory-scoped endpoints are under `/growth`:

- `POST /opportunities` records a proposed growth hypothesis with assumptions, expected-value range, uncertainty, constraints snapshot, affected CBB nodes and at least one typed evidence item.
- `GET /opportunities` and `GET /opportunities/:opportunityId` return scoped opportunities and their evidence, scenarios, experiments and outcome history.
- `POST /opportunities/:opportunityId/decision` accepts/rejects proposed opportunities. Acceptance requires evidence and a success hypothesis.
- `POST /opportunities/:opportunityId/scenarios` stores an immutable, data-vintaged scenario run with deterministic `factoryos.growth.financial-sensitivity.v1` formula outputs and an input SHA-256 fingerprint. It only runs for accepted/in-progress opportunities. Its `constraintGate` is `REVIEW_REQUIRED` if any source-backed capacity/quality/cash/delivery limit or projected value is missing, `BLOCKED` if a limit is breached, and `PASS` only when all four checks pass. The database independently rejects a claimed `PASS` unless the saved opportunity snapshot, projected inputs, checks and attached evidence references agree; only then is generated `decision_ready` true.
- `POST /opportunities/:opportunityId/experiments` creates a controlled plan with owner, objective, hypothesis, leading indicators, duration, baseline and stop conditions. `POST /experiments/:experimentId/start` starts it; `POST /experiments/:experimentId/results` records pre/post measurements and evidence.
- `GET /opportunities/:opportunityId/scenario-comparison` compares up to 100 immutable scenario snapshots, exposes missing `BASE`/`UPSIDE`/`DOWNSIDE`/`STRESS` coverage and refuses to rank mismatched model versions, baselines or data vintages. Ranking is enabled only if all scenarios pass the database-enforced constraint gate; the response labels the result deterministic sensitivity, not a forecast or causal estimate.
- Each `growth_experiment_result` can be attached to at most one realised opportunity outcome, and the database enforces that the outcome belongs to the same opportunity as its source experiment. This prevents replayed requests or direct SQL writes from multiplying one experiment result into multiple learning signals.
- `POST /opportunities/:opportunityId/outcomes` records evidence-backed realized results, advances a qualifying in-progress hypothesis to `REALIZED`, and atomically appends an immutable `FACTORY`-scoped `ai_learning_signals` record linked to that exact outcome. The recorded confidence is explicitly submitter-assessed, not a calibrated causal probability. Both the outcome and learning-signal event are emitted through the transactional outbox.

Evidence origin is explicit: external research, client-private CBB, operational data, market signals or client documents. Research evidence must reference an approved rights-cleared research claim. Client-private evidence is stored only in the tenant/factory scope.

## Consistency and safety properties

- Every research/growth table has PostgreSQL RLS enabled and forced.
- Research claims cannot be approved until their source is approved, rights are documented, citation locator exists and evidence grade is assigned.
- Ingestion jobs require a current approved source, a documented permitted rights basis and an unchanged source/rights version. Full-text mode and excerpt persistence require the explicit full-text-storage flag. Rights/source updates atomically block queued, paused or running jobs; historical rights snapshots and job event timelines are append-only under forced tenant RLS.
- Extracted claims carry a locator and explicit extraction-item/run lineage. The output digest is computed by the API over a canonicalized extraction manifest; the fetched input digest is reported by the worker and is retained as worker-attested provenance, not described as independently re-hashed by this API because raw source bodies are not stored or submitted to the API.
- Extractor output is untrusted. The built-in prompt-control/data-exfiltration scan is a heuristic reviewer flag only; it does not guarantee detection of all malicious instructions or replace an external security/regression evaluation.
- Knowledge releases can only promote with a stored PASSED evaluation bound to that exact release, unchanged claim/source fingerprint, approved visible claims, complete citation coverage, permitted rights, reviewer safety attestation and a recorded external regression-evidence reference. Promoted releases are also removed from tenant-visible release listings whenever any linked claim is superseded or its source loses currently approved reuse rights; immutable historical release rows are retained rather than rewritten. Evaluation records and promoted releases cannot be edited or deleted. The deterministic safety screen is a conservative signal, not a replacement for a security review or model-level regression suite.
- Growth opportunity evidence is append-only. Acceptance fails at the database boundary if evidence is missing; an opportunity cannot be marked realized without an outcome row.
- Scenario snapshots, experiment results and outcome evidence are append-only. Scenario input snapshots include data vintage, model version, projected constraint metrics and a SHA-256 fingerprint. A scenario without all four sourced constraint dimensions cannot become decision-ready, and every constraint reference must match evidence attached to that opportunity.
- Uncertainty ranking is deterministic, visible and auditable. Resolved unknowns require a resolution evidence reference, and the database prevents rewriting the question, impact or effort after the result is known.
- Opportunity, experiment and scenario writes are factory-authorized via IAM and emit transactional outbox events; writes are audited separately through the platform audit service.
- The sensitivity engine is deterministic arithmetic, not an AI forecast or causal model. It explicitly discloses the assumptions it uses.

## IAM permissions

The API permission catalog defines `research.read/write/review` and `growth.read/write/review`. The migration registers the codes without automatically granting access to production roles. Tenant administrators must grant these permissions to the appropriate roles; the local `ORG_ADMIN` seed grants them for development/testing.

## Explicit remaining gaps before claiming full SRS completion

The backend now supplies the rights-gated ingestion queue, source/rights revision history, leases/checkpoints/retries, immutable worker events and extraction-run/item provenance contracts. It does **not** itself run a hosted DOI/publisher crawler, fetch arbitrary URLs, parse/OCR uploaded files or invoke an LLM/extraction provider; a deployed worker or provider adapter must consume the queue and call the worker endpoints. The input digest is worker-attested unless a future connector supplies verifiable artifact bytes to a trusted hashing boundary.

Still separate work includes provider-specific crawling and retry policy, customer-file upload/storage/parser integration, a production prompt-injection classifier and exfiltration test corpus, source deduplication using similarity signals across DOI/preprint/journal versions, research search/embedding index, citation-correctness benchmarks and calibrated evidence grading, global corpus curation tools, scheduled freshness monitoring, and end-to-end release/recommendation regression/evaluation suites. Growth-side gaps also remain: automated claim extraction is now persisted when a worker submits output, but no autonomous extractor is launched by this API; CBB/finance/order adapters do not yet auto-populate all authoritative business constraints, and multi-model scenario reasoning, instrumented experiments and production dashboards/SLO/DR evidence remain separate integrations. The existing release evaluator stores a contract-evaluation result but does not prove model-answer quality or execute a full benchmark by itself.



## CBB evidence provenance — Phase D Round 25

CBB source metadata, immutable digest/revision lineage, exact-version graph links, conflict history and optimistic conflict review are documented in [CBB evidence provenance, source links and conflict handling](cbb-evidence-provenance.md). Source evidence is metadata plus a SHA-256 fingerprint, not a cached source body; external source fetching and live connector ingestion remain separate integrations.
