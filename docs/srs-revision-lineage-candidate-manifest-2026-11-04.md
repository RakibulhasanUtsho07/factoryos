# SRS revision lineage candidate manifest — 2026-11-04

**Manifest ID:** FOS-SRS-REVISION-LINEAGE-2026-11-04  
**Status:** CANDIDATE LINEAGE AND SCOPE ARITHMETIC ONLY  
**Decision authority:** Product Owner, Requirements Lead, Architecture Owner and Document Control  
**Related issue:** https://github.com/RakibulhasanUtsho07/factoryos/issues/348

## Purpose and boundary

This manifest records SHA-256 hashes and metadata for the historical SRS candidate files found in the available Library search. It also reconciles the source-declared cumulative scope arithmetic from v1.4 through v2.1.

It does **not** establish that these Library copies are the controlled DMS/PLM source-of-record. The source approval register still has no stable DMS/PLM reference or signed Product/Architecture approval. Most historical copies explicitly say Draft. Even the v2.1 title's “FINAL” label is not source-owner approval.

The original v1.1 and v1.2 source bytes were not located in the available Library search. Later versions refer to them as inherited normative documents. Their absence from this search is not proof that the enterprise source does not exist.

## Candidate source chain

| Revision | Candidate artifact(s) | Declared scope transition | Candidate state / issue |
|---|---|---:|---|
| v1.1 | Not located | Parent baseline not yet byte-pinned | Must obtain the controlled source bytes |
| v1.2 | Not located | Client Business Blueprint inherited by v1.3 | Must obtain the controlled source bytes |
| v1.3 | DOCX, SHA-256 pinned | Retains v1.1/v1.2 requirements; amendment set | Draft for Product/Engineering review |
| v1.4 | DOCX, SHA-256 pinned | Cumulative scope later stated as 318 | Draft; v1.1-v1.3 remain inherited |
| v1.5 corrected | DOCX + 46-page PDF, both SHA-256 pinned | 318 + 80 FR + 12 NFR = 410 | Corrected draft; older v1.5 DOCX conflicts on priorities |
| v1.6 | DOCX + 55-page PDF, both pinned | 410 + 74 FR + 18 NFR = 502 | Draft |
| v1.7 | DOCX + 66-page PDF, both pinned | 502 + 132 FR + 24 NFR = 658 | Draft |
| v1.8 frontier | DOCX + 77-page PDF, both pinned | 658 + 100 FR + 20 NFR = 778 | Draft; filenames containing “FINAL” do not override the document-control status |
| v1.9 growth/research | DOCX + 86-page PDF, both pinned | 778 + 74 FR + 18 NFR = 870 | 92 source-located rows on PDF pages 75–85; version metadata conflict remains |
| v2.0 | DOCX + 93-page PDF, both pinned | 870 + 20 FR + 10 NFR = 900 | Draft; PDF Title metadata still says v1.8 |
| v2.1 | DOCX + 103-page PDF, both pinned | 900 + 32 FR + 18 NFR = 950 | Title says FINAL; controlled source approval remains pending |

The machine-readable manifest stores exact filenames, sizes, hashes, PDF page counts, candidate approval states and the source-version lineage. Hashes identify the exact bytes; they do not make a draft authoritative.

## Scope arithmetic

The declared cumulative count reconciles arithmetically:

```text
v1.4 cumulative scope (as cited by corrected v1.5)      318
v1.5 corrected additions: 80 FR + 12 NFR                 92  -> 410
v1.6 additions:          74 FR + 18 NFR                  92  -> 502
v1.7 additions:         132 FR + 24 NFR                 156  -> 658
v1.8 frontier additions:100 FR + 20 NFR                 120  -> 778
v1.9 growth/research additions: 74 FR + 18 NFR            92  -> 870
v2.0 additions:          20 FR + 10 NFR                  30  -> 900
v2.1 additions:          32 FR + 18 NFR                  50  -> 950
```

The v1.4 starting parent count is not inferred here. The corrected v1.5 source states 318 as its inherited v1.4 cumulative scope, but the original v1.1/v1.2 source bytes are not currently located.

### Priority distribution

| Revision candidate | P0 | P1 | P2 | Total | Note |
|---|---:|---:|---:|---:|---|
| v1.5 corrected | 109 | 252 | 49 | 410 | Corrected copy |
| v1.6 | 126 | 320 | 56 | 502 | Cumulative |
| v1.7 | 177 | 419 | 62 | 658 | Cumulative |
| v2.0 | 261 | 567 | 72 | 900 | Cumulative |
| v2.1 | 296 | 582 | 72 | 950 | §140 cumulative |

The v1.9 growth/research addition has now been independently re-extracted from the byte-pinned 86-page PDF with page/line locators: 74 FR + 18 NFR, priorities P0=37/P1=55/P2=0. The machine-readable occurrence ledger is docs/srs-v19-growth-delta-occurrence-ledger.json. This remains candidate extraction from a draft/version-conflicted PDF, not Product/Requirements acceptance. The cumulative v1.9 priority buckets remain unknown because the reviewed v1.8 cumulative priority baseline is not available.

## Source conflicts that are preserved

1. **v1.5 priority conflict.** The older v1.5 DOCX still has document-control version 1.4 and reports P0=109/P1=243/P2=58. The corrected v1.5 DOCX/PDF report P0=109/P1=252/P2=49. Both totals equal 410. The older copy is retained as a conflicting candidate, not silently overwritten; Product/Requirements must approve which source revision governs.
2. **v1.9 version conflict.** The file cover/title and appended growth/research material identify v1.9, while DOCX document control and PDF Title metadata still identify v1.8. Obtain a corrected controlled artifact or signed revision decision.
3. **v2.0 PDF metadata conflict.** The visible source identifies v2.0, but the PDF Title metadata remains v1.8. Regenerate or record an approved metadata exception.
4. **v1.1/v1.2 source gap.** v1.3 and later revisions explicitly inherit those versions, but their original bytes were not located in the available Library search. Do not substitute the v1.3 consolidation as proof of the missing normative occurrence populations.
5. **v1.9 growth delta extraction.** The 92 rows and their FR/NFR and priority split are source-located as candidates. The remaining gap is source-owner approval of the version-conflicted v1.9 artifact and occurrence classifications; the cumulative v1.9 priority buckets remain unknown.

## Why this does not close the occurrence ledger

The 950 figure remains the SRS §140 declared cumulative scope. It is not a count independently reconstructed from all normative source occurrences. This manifest deliberately keeps separate:

- declared cumulative scope arithmetic;
- candidate document lineage and byte hashes;
- full-PDF distinct textual ID index (899);
- table-positioned v2.1 extraction candidates (857 occurrences / 849 distinct IDs);
- provisional 842-row P0/P1 closure tracker;
- the 37 priority/source exceptions still awaiting owner disposition.

None of these populations is silently substituted for another. The v1.1/v1.2 normative source files, the 37 source-owner decisions, the full 950-row active occurrence ledger and the 899-ID crosswalk remain open.

## Validation

The dedicated contract test validates source-hash formatting and candidate status, missing predecessor treatment, declared cumulative count arithmetic, priority totals where stated, preserved v1.5 conflict and v1.9/v2.0 version metadata exceptions. Passing this contract means the manifest is internally consistent; it does not approve any source or requirement.
