# Research & Growth Intelligence backend

**Implementation state:** API and PostgreSQL governance foundations are implemented; full product-level Research/Growth Intelligence is not yet complete. The remaining integration/evaluation boundaries are listed at the end.

## Research API

The tenant-scoped endpoints are under `/research`:

- `POST /sources` registers source metadata and rights/access claims. It starts `PENDING`; source text is always untrusted.
- `GET /sources` lists the tenant's sources and approved global references.
- `POST /sources/:sourceId/decision` records approve/reject/revoke decisions with a reason. Approval is blocked for restricted/unknown rights or missing documented rights.
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
- `POST /opportunities/:opportunityId/outcomes` records evidence-backed realized results, advances a qualifying in-progress hypothesis to `REALIZED`, and atomically appends an immutable `FACTORY`-scoped `ai_learning_signals` record linked to that exact outcome. The recorded confidence is explicitly submitter-assessed, not a calibrated causal probability. Both the outcome and learning-signal event are emitted through the transactional outbox.

Evidence origin is explicit: external research, client-private CBB, operational data, market signals or client documents. Research evidence must reference an approved rights-cleared research claim. Client-private evidence is stored only in the tenant/factory scope.

## Consistency and safety properties

- Every research/growth table has PostgreSQL RLS enabled and forced.
- Research claims cannot be approved until their source is approved, rights are documented, citation locator exists and evidence grade is assigned.
- Knowledge releases can only promote with a stored PASSED evaluation bound to that exact release, unchanged claim/source fingerprint, approved visible claims, complete citation coverage, permitted rights, reviewer safety attestation and a recorded external regression-evidence reference. Promoted releases are also removed from tenant-visible release listings whenever any linked claim is superseded or its source loses currently approved reuse rights; immutable historical release rows are retained rather than rewritten. Evaluation records and promoted releases cannot be edited or deleted. The deterministic safety screen is a conservative signal, not a replacement for a security review or model-level regression suite.
- Growth opportunity evidence is append-only. Acceptance fails at the database boundary if evidence is missing; an opportunity cannot be marked realized without an outcome row.
- Scenario snapshots, experiment results and outcome evidence are append-only. Scenario input snapshots include data vintage, model version, projected constraint metrics and a SHA-256 fingerprint. A scenario without all four sourced constraint dimensions cannot become decision-ready, and every constraint reference must match evidence attached to that opportunity.
- Uncertainty ranking is deterministic, visible and auditable. Resolved unknowns require a resolution evidence reference, and the database prevents rewriting the question, impact or effort after the result is known.
- Opportunity, experiment and scenario writes are factory-authorized via IAM and emit transactional outbox events; writes are audited separately through the platform audit service.
- The sensitivity engine is deterministic arithmetic, not an AI forecast or causal model. It explicitly discloses the assumptions it uses.

## Explicit remaining gaps before claiming full SRS completion

This implementation does not by itself deliver DOI/publisher crawling, customer-file parsing/OCR, external content-fetching workers, automated claim extraction, prompt-injection classifier, robust evidence-quality calibration, global research curator tooling, automatically executed regression/evaluation suites, supersession-aware retrieval/ranking, a full research knowledge graph/search index, CBB/finance/order data adapters that automatically populate authoritative business constraints, AI-generated growth hypotheses from live business data, multi-model strategy simulations, ROI/capacity/quality/cash integrated forecasts, scheduled opportunity discovery, experiment instrumentation connectors, or production dashboard/SLO/DR evidence. The contract evaluator runs automatically on request and stores an immutable pass/fail/review-required record. The external regression-evidence reference remains separate: this release-evaluation engine does not itself prove model-answer quality or run a full AI benchmark. These capabilities remain separate work and require dedicated integrations and acceptance suites. Realised growth outcomes now feed the existing governed evaluation-signal store, but they do not automatically alter prompts, models, or production recommendations.
