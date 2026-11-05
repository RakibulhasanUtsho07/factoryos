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


## 2026-11-04 v2.1 delta extraction verified

The 50 v2.1 additions in SRS §§130-131 are now indexed as 32 functional + 18 non-functional rows on PDF pages 96-99. The ledger confirms 50 unique IDs and the source-declared new-addition priorities P0=35 / P1=15 / P2=0, with source table locators and normalized wording digests. An offline verifier can re-extract against the exact source PDF hash. This is a bounded extraction improvement only; it does not resolve the inherited 900 v2.0 population or any source-owner approval, and does not change the 842 provisional tracker status.


## 2026-11-04 v2.0 inherited-scope table extraction diagnostic

The inherited v2.0 PDF candidate was re-examined using the source-hash-pinned extractor in \`scripts/audit/extract_srs_v20_inherited_occurrence_candidates.py\`.

- Candidate filename: \`FactoryOS_AI_-_SRS_v2_0_Clean_AI_Logic_Consolidated_SRS.pdf\`
- SHA-256: \`8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42\`
- 93 pages; the PDF Title metadata still identifies v1.8 and the document carries a Draft footer, so it is not established as the approved v2.0 source-of-record.
- 809 normative requirement-table row candidates across 799 distinct IDs; extracted priority-token counts P0=225, P1=527, P2=57.
- FR-IOT-01 through FR-IOT-10 each occur twice in the normative candidate tables; occurrences remain distinct.
- 13 auxiliary agent-catalogue rows, 30 scope/crosswalk candidates and 2 metric/decision cross-reference candidates were kept outside the normative row count.
- One unlocated ID/priority line (\`FR-AIG-03\`, PDF page 6) remains an explicit locator-review candidate.

SRS v2.1 §140 declares an inherited v2.0 population of 900 with P0=261 / P1=567 / P2=72. The 809 table-positioned candidate count and the 91-row arithmetic difference are not a proven row-level reconciliation, not a missing-requirement count, and not implementation-gap evidence. The source populations remain non-equivalent until the controlled revision and count semantics are approved.

The extractor can regenerate full occurrence locators and per-row normalized wording SHA-256 when the exact source PDF is supplied. The source PDF is not committed; the repository stores the count summary in \`docs/srs-v20-inherited-occurrence-candidate-ledger.payload-manifest.json\`, not a claim that all generated row data is committed. Every classification remains unresolved; this does not alter the 842-row provisional closure register, approve priorities, close any of the 37 owner exceptions or mark any requirement PASS.
