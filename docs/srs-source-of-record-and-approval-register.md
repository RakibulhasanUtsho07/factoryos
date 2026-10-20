# SRS / HLD / Blueprint Source-of-Record and Approval Register

**Register ID:** FOS-TRACE-SOURCE-01  
**Prepared:** 2026-10-20  
**Record status:** `BLOCKED — source-owner confirmation and controlled approval evidence pending`  
**Applies to:** FactoryOS AI SRS v2.1 Final, HLD/LLD v1.0, and Engineering Implementation Blueprint v1.0.

## Decision

The audit has identified and hash-pinned three exact source copies in `docs/audit-source-baseline-manifest.md`. This makes the inspected bytes reproducible; it does **not** prove these copies are the organization's approved source of record. No source-owner signature, formal document-control-system URI, or signed approval record was present in the available source metadata. Do not mark the source baseline approved until Product and Architecture complete this register with evidence from the approved document-control location.

The original PDFs are not included in the repository because the current audit only established access to the supplied Library copies, not permission to redistribute them. Store authoritative originals in the organization's approved document-control system and put its stable document ID/URI in the records below. Do not treat a chat-library filename as an enterprise document-control reference.

## Exact copies inspected

| Source ID | Required source/version | Inspected filename | Source date | Pages | SHA-256 in manifest | Approval result |
|---|---|---|---|---:|---|---|
| FOS-SRS-001 | SRS v2.1 Final Product-Ready Manufacturing SaaS | `FactoryOS_AI_-_SRS_v2_1_FINAL_Product_Ready_Manufacturing_SaaS(8).pdf` | 2026-10-02 | 103 | `ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959` | PENDING |
| HLD-LLD-001 | System Architecture & Technical Design HLD/LLD v1.0 | `FactoryOS_AI_v2_1_System_Architecture_Technical_Design_HLD_LLD(3).pdf` | 2026-10-02 | 25 | `fd75c8a794d78537713d3bbf7eb129b57ceb96cf5f4a7c07cf789b979528509e` | PENDING |
| FOS-BLUEPRINT-001 | Engineering Implementation Blueprint v1.0, based on SRS v2.1 Final + HLD/LLD v1.0 | `FactoryOS_AI_v2_1_Engineering_Implementation_Blueprint_v1_0(8).pdf` | 2026-10-02 | 31 | `e8a42cf663177afb8275f269b94213d5943b78b1e33a30e845abcf2a243ba08d` | PENDING |

The hashes above are copied from the raw-byte SHA-256 computation recorded in the source manifest. Before approval, a source owner must independently compare the archived source bytes and their digests to that manifest. A re-saved/re-exported PDF is a different byte-level artifact even if its visible text is unchanged.

## Approval fields — must be completed by the accountable owners

No entries below are signed approvals. The role-based owners must enter their identity and an auditable approval reference; the implementation team must not fill these fields on their behalf.

| Gate | Required owner | Required evidence | Current state | Closure field |
|---|---|---|---|---|
| Controlled source-of-record | Product / Document Control | Stable DMS/PLM document ID and URI, revision, approval state, effective date, and retention/access owner | BLOCKED | `TBD — owner to complete` |
| SRS scope and priority baseline | Product Owner + Requirements Lead | Confirmation of §140 cumulative counts, final normative tables, reused/superseded IDs and the 37 source-row priority exceptions | BLOCKED | `TBD — signed decision/reference` |
| Architecture baseline | Architecture Owner | HLD/LLD v1.0 source-of-record reference, architecture decision/version and approval | BLOCKED | `TBD — signed decision/reference` |
| Blueprint baseline | Engineering / Architecture Owner | Blueprint v1.0 controlled reference and confirmation it is based on the approved SRS/HLD versions | BLOCKED | `TBD — signed decision/reference` |
| Requirement evidence acceptance | Product + Engineering + Security + Operations, per scope | Direct requirement-to-code/migration/test/CI/staging evidence, exact candidate SHA and accepted/open disposition | BLOCKED | `TBD — release decision record` |

### Source approval record (fill only with verified information)

- **Approved DMS/PLM location:** `PENDING`
- **SRS approver / role / approval date / immutable record ID:** `PENDING`
- **HLD/LLD approver / role / approval date / immutable record ID:** `PENDING`
- **Blueprint approver / role / approval date / immutable record ID:** `PENDING`
- **Approved baseline revision set:** `PENDING`
- **Approved requirement-scope reconciliation record:** `PENDING`
- **Decision status:** `BLOCKED — not yet source-owner approved`

## Release SHA and evidence binding

A passing CI run is valid only for the exact commit SHA shown by that run. A prior branch/PR SHA is not automatically evidence for the merge commit or any later candidate.

For each release candidate, record:

| Field | Value |
|---|---|
| Candidate branch/tag and full commit SHA | `PENDING — set for each release candidate` |
| API CI URL + conclusion + tested SHA | `PENDING` |
| PostgreSQL CI URL + conclusion + tested SHA | `PENDING` |
| Security workflow URL + conclusion + tested SHA | `PENDING` |
| Traceability workflow URL + conclusion + tested SHA | `PENDING` |
| Staging/operational evidence bundle URI | `PENDING — when applicable` |
| Product / Architecture / Security / Operations go-no-go reference | `PENDING` |

The merged baseline commit `7b4a28419f6682480d10ee5f64ed5172bf809fad` is a repository anchor, not a statement that all release gates have passed. Do not populate a release-acceptance field unless its linked evidence actually refers to that candidate SHA.

## Change control

1. Any SRS, HLD, Blueprint, acceptance-scenario or priority change requires a new source revision record and new SHA-256 values for the exact archived bytes.
2. Preserve prior rows and hashes; record supersession instead of silently overwriting history.
3. Re-run the requirement extractor/reconciliation against the approved source revision. Review the full normative row, not an indirect cross-reference or parsed table fragment.
4. Invalidate only the requirement evidence affected by a source/code/migration/test change, but produce the new release evidence set against the exact candidate SHA.
5. Source approval, implementation status, test status, and production acceptance are distinct fields; none can substitute for another.

## Links to linked audit artifacts

- [Raw source hash manifest](audit-source-baseline-manifest.md)
- [Requirement-by-requirement matrix](srs-v2.1-requirement-evidence-matrix.md)
- [Scope reconciliation and priority exceptions](srs-requirement-scope-reconciliation.md)
- [P0/P1 evidence closure register](srs-p0-p1-evidence-closure-register.json)
- [Final provisional traceability audit](final-srs-hld-blueprint-traceability-audit.md)

**Current decision:** The exact inspected source copies are identified; controlled source-of-record, source-owner approval, scope reconciliation sign-off, and direct per-requirement acceptance evidence remain open. This register intentionally does not convert those missing approvals into an assumed PASS.
