# Active SRS v2.1 requirement occurrence ledger — status

**Audit date:** 2026-11-04  
**SRS:** FOS-SRS-001 v2.1 Final, 103 pages.  
**Source PDF SHA-256:** `ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959`.  
**Owner decision tracker:** issue #348.  
**Current status:** `BLOCKED — source-owner-approved occurrence ledger not yet produced`.

## Counts that must remain distinct

| Measure | Count | Meaning |
|---|---:|---|
| SRS §140 inherited v2.0 baseline | 900 | Source-declared inherited cumulative scope |
| SRS §140 v2.1 additions | 50 | 32 functional + 18 non-functional additions |
| SRS §140 cumulative total | 950 | Declared cumulative scope, P0=296 / P1=582 / P2=72 |
| Full-PDF distinct textual ID index | 899 | IDs found across the multi-version PDF, including historical rows and cross-references |
| Provisional P0/P1 closure tracker | 842 | 805 rows parsed as P0/P1 plus 37 priority/source review candidates; not an active-scope denominator |
| Priority/source-row exceptions | 37 | Require manual page-level and source-owner disposition |

Neither `950 - 899 = 51` nor the 842 provisional tracker is a measure of missing code, duplicate requirements or accepted scope.

## Reproducible extraction diagnostic

A layout-preserving text extraction of the hash-verified 103-page PDF produced 8,778 extracted text lines. A diagnostic row matcher found 872 one-line ID/wording/priority records and 862 distinct IDs. It is intentionally not promoted to an authoritative count: the parser can split wrapped table cells, merged cells, multi-line requirement wording and PDF page-layout structures. Each of the 37 exception IDs has zero matches under the one-line `ID ... P0/P1/P2` pattern; their literal occurrences are documented in `docs/srs-priority-exception-source-review-2026-11-04.md`.

This diagnostic provides a useful extraction baseline and a review queue, not a complete 950-row active occurrence ledger. It must not be used to update expected counts or convert any row to PASS.

## Required occurrence-ledger schema

The approved deliverable must contain one record for **each normative occurrence**, not merely one record per distinct ID. At minimum:

- `source_artifact_sha256`, approved document revision, source section/page/table/row;
- stable `source_occurrence_key` independent of requirement ID;
- literal `requirement_id`, exact normative wording and normalized wording SHA-256;
- source priority for that occurrence;
- occurrence class: `CANONICAL_FINAL`, `REVISED_SAME_ID`, `SUPERSEDED`, `CROSS_REFERENCE_ONLY`, `DUPLICATE_OCCURRENCE`, `SCOPE_LEDGER_ONLY`, `EXCLUDED_WITH_APPROVAL` or `UNRESOLVED`;
- canonical replacement ID and rationale where appropriate;
- immutable Product/Requirements decision reference, named reviewer and review date.

## Closure sequence

1. Product/Document Control records the controlled DMS/PLM source-of-record and approved revision for SRS, HLD/LLD and Blueprint.
2. Product/Requirements and Architecture approve the §140 count semantics and the source revision set.
3. Requirements Engineering extracts and classifies every normative occurrence, including inherited v2.0 sources, changed/superseded wording and cross-reference-only mentions.
4. The 37 exceptions receive explicit source-owner decisions with canonical row/priority or approved exclusion/supersession references.
5. Reconcile the occurrence population to the §140 total of 950 and its P0/P1/P2 buckets; publish the 899-key crosswalk without assuming arithmetic differences are missing/duplicate items.
6. Rebuild the provisional closure register against the approved source population and current candidate SHA. Populate owner, reviewer, direct code/migration/test/CI references and required staging evidence only when actually verified.

**Decision:** The repository can validate extraction and evidence structure, but it cannot manufacture requirements approval. Keep the current 842-row register `OPEN_NOT_ACCEPTED` until the accountable source owners sign the occurrence ledger and release evidence.
