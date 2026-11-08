# SRS v2.1 priority-exception owner decision register

**Register ID:** FOS-TRACE-37X-02  
**Source artifact SHA-256:** ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959  
**Rows:** 37  
**Current status:** 37/37 OPEN_SOURCE_OWNER_REVIEW  
**Decision authority:** Product/Requirements and Architecture  
**Related issue:** https://github.com/RakibulhasanUtsho07/factoryos/issues/348

## Purpose

The existing srs-priority-exception-source-review.csv remains the literal-search diagnostic. This separate decision register adds fields needed to record a verifiable source-owner disposition without changing the diagnostic output or treating page-search findings as approved decisions.

The machineAssessmentCandidate field is copied from the 2026-11-04 page review and is explicitly provisional. It is not a source-owner disposition, an approved priority, or a reason to remove a row from the release gate.

## Disposition values

| Value | Required evidence |
|---|---|
| OPEN_SOURCE_OWNER_REVIEW | All decision fields remain blank. |
| CANONICAL_REQUIREMENT_ROW | Canonical ID, approved source document/revision, section, PDF page, table/row, exact normative wording, P0/P1/P2 priority, rationale, immutable decision reference, reviewer and date. |
| CROSS_REFERENCE_ONLY | Canonical requirement and approved source-document locator, exact canonical wording and priority, rationale, immutable decision reference, reviewer and date. |
| SUPERSEDED_OR_MERGED | Approved canonical replacement and its source-document locator/wording/priority, with change rationale and immutable owner decision/reviewer/date. |
| SOURCE_EXTRACTION_DEFECT | Corrected normative row with exact source document/revision/section/page/table/row, wording, priority and owner decision/reviewer/date. |
| EXCLUDED_WITH_APPROVAL | Explicit exclusion rationale, immutable Product/Architecture decision reference, reviewer and date. |

The CSV deliberately leaves every decision field empty at creation. No person, priority, source revision, canonical wording, or approval reference has been inferred or fabricated.

## Validation

The new contract test checks:

- the exact 37-ID population and unique rows;
- page locator, literal count, context and one-line diagnostic parity against the existing source CSV;
- page locator and machine-candidate parity against the 2026-11-04 page review;
- the provisional-only nature of machine assessments;
- the required evidence fields for each completed disposition and the prohibition on incomplete approvals.

A dedicated GitHub Actions workflow runs this contract whenever the register, source diagnostics, page review or validator changes. It does not approve any requirement.

## Current disposition

All 37 rows remain OPEN_SOURCE_OWNER_REVIEW. The inherited 900-row population, active 950-row scope reconciliation, controlled DMS/PLM source-of-record, and Product/Architecture decisions remain open. Issue #348 must remain open until the complete occurrence ledger is approved and all direct release evidence is reviewed.
