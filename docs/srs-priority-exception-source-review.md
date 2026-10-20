# SRS Priority Exception Source-Review Evidence

**Review ID:** FOS-TRACE-37X-01  
**Status:** `OPEN — Product/Requirements source-owner disposition required`  
**SRS source copy:** FOS-SRS-001 v2.1 Final Product-Ready; SHA-256 `ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959`  
**Raw hash source:** [Audit source baseline manifest](audit-source-baseline-manifest.md)  
**Register:** [37-exception occurrence evidence CSV](srs-priority-exception-source-review.csv)

## Findings from the exact inspected SRS copy

The 37 exceptions were searched as literal IDs in the supplied 103-page SRS PDF text. The exact-match scan returned one or more occurrences on the pages recorded in the CSV. Those occurrences are commonly cross-references from other current requirement rows, KPI definitions, architecture history or acceptance scenarios.

A second, line-oriented extraction check for each ID using the pattern `^\s*ID\s+.*\s+P[012]\s*$` returned **zero one-line normative-row matches for every one of the 37 IDs**. This is a *text-extraction diagnostic*, not a definitive statement that there can be no normative row: wrapped table cells, multi-line table extraction, superseded sections and PDF layout can prevent an exact row from matching a one-line pattern. The pages and literal contexts are documented to make manual review reproducible.

## Required source-owner decision for each exception

For every ID in the CSV, Product/Requirements must perform a page-level review of the raw PDF and set one of the following approved outcomes:

- `CANONICAL_REQUIREMENT_ROW` — point to the actual normative table row, transcribe its exact wording and priority, and link its source page.
- `CROSS_REFERENCE_ONLY` — confirm that v2.1 contains only a cross-reference and identify the canonical requirement ID / approved earlier specification that supplies its normative wording and priority.
- `SUPERSEDED_OR_MERGED` — link the approved change/requirements decision that superseded or merged the ID; identify its canonical replacement.
- `SOURCE_EXTRACTION_DEFECT` — provide the corrected row transcription and a reproducible source location.
- `EXCLUDED_WITH_APPROVAL` — record the explicit Product/Architecture approval reference and rationale.

Do not update the current priority or remove an ID from the release gate based only on the page-search output. Add the reviewer identity, date and immutable source-owner decision reference in the CSV and corresponding requirement register.

## Priority exception result

All 37 IDs remain `OPEN_SOURCE_OWNER_REVIEW`; no source-owner approval or canonical normative priority has been assumed. The machine-readable gate register includes every one as a conservative candidate until classified. That keeps the release gate safe while exposing the actual work needed to reconcile the count.

The relationship between 950 cumulative scope and 899 distinct IDs remains **not numerically reconciled**. Source-owner decisions from this review must be joined to the source-occurrence ledger specified in [scope reconciliation](srs-requirement-scope-reconciliation.md) before this issue can be called closed.
