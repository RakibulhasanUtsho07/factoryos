# P0/P1 Requirement Evidence Closure Register

**Register ID:** FOS-TRACE-P0P1-01  
**Status:** `OPEN_NOT_ACCEPTED`  
**Baseline commit used to generate the register:** `7b4a28419f6682480d10ee5f64ed5172bf809fad`  
**Source:** [SRS v2.1 requirement evidence matrix](srs-v2.1-requirement-evidence-matrix.md), derived from the source copies pinned in [the source manifest](audit-source-baseline-manifest.md).

## Purpose

`srs-p0-p1-evidence-closure-register.json` is the machine-readable closure tracker for every matrix row whose extracted priority is P0 or P1, plus every row whose priority still says `REVIEW SOURCE`. It currently contains **842 unique provisional tracker rows**: 259 IDs parsed as P0, 546 parsed as P1, and 37 unresolved source-row/priority IDs. These priority classifications come from the full-PDF text index (which includes inherited/historical material and cross-references), so this is not yet proven to be the exact active v2.1 P0/P1 requirement set. Keep the rows open conservatively until a revision-aware occurrence ledger and source-owner approval confirm active scope, canonical IDs and priorities. They must not silently disappear from release review, but must not be reported as 842 confirmed active release requirements either.

The register is intentionally initialized with `disposition: OPEN` and `acceptanceResult: NOT_ACCEPTED`. The matrix may describe a bounded feature as “Implemented”; that is a repository assessment, not a source-owner-approved requirement acceptance.

## Per-row closure contract

| Field | Closure requirement |
|---|---|
| `requirementId` / `sourcePriority` | Must match the exact row in the evidence matrix. `REVIEW SOURCE` is not an approved priority. |
| `matrixAssessment`, `requirementMatrixPath` | Preserve the current repository assessment and point to the source matrix row for full evidence-pointer and acceptance-gap text. The status is not direct acceptance proof. |
| `provisionalOwnerRole` | Suggested accountability group inferred from the requirement family. It is triage only, not an assignment. |
| `namedOwner`, `reviewer` | Must be filled with accountable people/roles under the project's approval process; self-review is not sufficient where maker-checker separation applies. |
| `directCodeReferences` | Exact repository paths and preferably line/range or symbol for behavior supporting this requirement. |
| `migrationReferences` | Exact migrations and/or an explicit owner-reviewed not-applicable rationale where the requirement does not involve persistence. |
| `automatedTestReferences` | Exact test/spec/SQL-contract names and the requirement/acceptance assertion exercised. |
| `ciRunUrls`, `acceptedCandidateSha` | Immutable run URL(s) and the full 40-hex candidate SHA those runs actually tested. Do not reuse a different SHA's result. |
| `stagingOperationalEvidence` | Required for scenarios that involve live IdP, named providers, rollout health, peak load, external stores, production configuration or real restore. |
| `disposition` | `OPEN`, `ACCEPTED`, `APPROVED_EXCEPTION`, or `NOT_APPLICABLE_APPROVED`. Exceptions must identify an approval record and expiry/review condition. |
| `acceptanceResult` | `NOT_ACCEPTED`, `PASS`, `PASS_WITH_APPROVED_EXCEPTION`, or `NOT_APPLICABLE_APPROVED`. Only an evidence-complete row may leave `NOT_ACCEPTED`. |

Empty evidence arrays and null approval fields are deliberate. The register does not fabricate per-ID tests or source-owner sign-off where the repository matrix only carries family-level pointers.

## Row-level source/evidence export

The [P0/P1 evidence closure CSV](srs-p0-p1-evidence-closure.csv) contains one aligned record for every gate row, copied directly from the source matrix: requirement wording excerpt, repository assessment, evidence cell, acceptance gap, literal repository-path scan and current open disposition. The export is validated against the matrix on every traceability workflow run. It intentionally records when direct code/test/migration paths are not supplied in the evidence cell rather than pretending those references exist. The JSON closure register remains the approval/state tracker with named owner, reviewer, exact candidate SHA, CI links and staging evidence fields.

## Safe editing workflow

1. Resolve the source row/priority first. For a `REVIEW SOURCE` row, attach the exact SRS page/table and source-owner decision in the scope reconciliation ledger before changing its priority.
2. Link the implementation's exact code and migration or a reviewed not-applicable rationale. Link tests that assert this requirement's behavior, not merely a broad suite name.
3. Confirm the test run used the exact full candidate SHA. Link CI runs and any mandatory staging/operational evidence.
4. Fill owner and reviewer. Record explicit open-risk decisions separately; do not use a PASS label for accepted risk.
5. Set `acceptanceResult` / `disposition` only after requirements, evidence, owner and reviewer agree.
6. Run `node scripts/audit/validate-srs-audit.mjs` and the `SRS HLD Blueprint Traceability` workflow. The validator checks structure, row population and PASS guardrails; it cannot judge whether an external approval is genuine. Owners remain accountable for truthful entries.

## What this register does not prove

- It is not a signed source-owner or release approval.
- 842 is the **conservative evidence-closure tracker population**, not the number of missing implementations or an assertion that every row is P0/P1.
- The 950 cumulative design-scope count versus 899 distinct extracted IDs remains open until source occurrences and revision semantics are reconciled in [the scope reconciliation ledger](srs-requirement-scope-reconciliation.md).
- CI consistency is not production deployment, penetration-test certification, live adapter evidence, or an actual restore rehearsal.

## Release gate

Until every required row is either fully accepted or explicitly covered by a valid, owner-approved exception/accepted-not-applicable record, the overall SRS/HLD/Blueprint status stays **NOT READY FOR FORMAL SIGN-OFF**.
