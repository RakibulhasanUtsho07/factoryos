# SRS v2.1 delta occurrence ledger

**Ledger:** `FOS-SRS-V21-DELTA-01`  
**Source:** FOS-SRS-001, v2.1 Final Product-Ready, dated 2026-10-02  
**Source PDF SHA-256:** `ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959`  
**Source pages:** 96-99 (PDF page numbering)  
**Status:** `50/50 machine-extracted rows indexed; formal source-owner approval remains pending`

## Extracted delta population

The final v2.1 tables contain exactly:

| Family | Rows | P0 | P1 | P2 |
|---|---:|---:|---:|---:|
| FR-PROD-01…FR-PROD-32 | 32 | 22 | 10 | 0 |
| NFR-PROD-01…NFR-PROD-18 | 18 | 13 | 5 | 0 |
| **Total** | **50** | **35** | **15** | **0** |

Every record in `srs-v21-delta-occurrence-ledger.json` contains the exact requirement ID, priority, PDF page, extracted table index, source table row, and SHA-256 of the normalized requirement wording. The wording itself is not redistributed in this repository; the source PDF remains an externally controlled source artifact.

The table pages were rendered and visually reviewed. The extraction also handles the two cross-page continuation rows: FR-PROD-12 (pages 96-97) and FR-PROD-25 (pages 97-98). The verifier reopens the exact source PDF, checks its raw-byte SHA-256, re-extracts the rows, and compares every locator, priority and wording digest.

## Reproduce the extraction

Install Python 3.11+ and `pdfplumber`:

```bash
python -m pip install pdfplumber
python scripts/audit/verify-srs-v21-delta-occurrence-ledger.py --source-pdf /path/to/FactoryOS_AI_-_SRS_v2_1_FINAL_Product_Ready_Manufacturing_SaaS.pdf
```

The command exits non-zero on a source hash mismatch, missing/duplicate IDs, changed priority, shifted source locator, changed wording digest, or incorrect §140 delta totals.

## Important acceptance boundary

This artifact closes a **source extraction/indexing slice only**. It does not approve the DMS/PLM source-of-record, approve the SRS revision, establish the full inherited v2.0 900-row occurrence population, adjudicate the 37 source/priority exceptions, or accept implementation evidence.

Keep the formal scope issue #348 open until Product/Requirements and Architecture provide the controlled source reference, approve §140 count semantics, resolve every inherited/source exception and sign the full revision-aware occurrence ledger. The 50 v2.1 delta rows must not be used as a substitute denominator for the cumulative 950 scope.
