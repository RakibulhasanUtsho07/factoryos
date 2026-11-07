# SRS v2.1 source-located candidate occurrence extraction

**Prepared:** 2026-11-04  
**Source:** FactoryOS AI — SRS v2.1 Final Product-Ready Manufacturing SaaS  
**Source artifact SHA-256:** `ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959`  
**Source pages:** 103  
**Owner decision tracker:** [Issue #348](https://github.com/RakibulhasanUtsho07/factoryos/issues/348)

## Candidate extraction result

A local extraction against the byte-pinned source produced 857 table-positioned FR/NFR occurrence candidates across 849 distinct IDs. Priority candidates: P0=260, P1=540, P2=57. Eight IDs appeared twice: FR-IOT-01 through FR-IOT-08. Fifteen leading page-boundary fragments were held separately for manual review.

These are diagnostic candidate counts. Repeated IDs are not automatically duplicates or superseded. Boundary fragments are not automatically attached to nearby rows.

## Reproduction

The original PDF is intentionally not stored in this repository. Obtain the exact source through the approved Document Control channel, verify its SHA-256, then run the source-located extractor after installing pdfplumber:

```bash
python -m pip install pdfplumber
python scripts/audit/extract_srs_requirement_occurrence_candidates.py \
  --source-pdf /path/to/approved-srs-v2.1.pdf \
  --output /tmp/srs-occurrences.json \
  --csv-output /tmp/srs-occurrences.csv
```

The extractor pins the known source SHA by default. Synthetic regression tests run in the traceability workflow without needing the private PDF.

## Acceptance boundary

The 857 candidates are **not** the 950-row active requirement baseline or a new authoritative denominator. The extractor does not infer applicability, inheritance, canonical IDs, duplicate/supersession status, exclusion or owner approval. The 899 distinct textual-ID index and 842-row provisional P0/P1 closure tracker remain separate populations.

The 37 priority/source exceptions remain OPEN_SOURCE_OWNER_REVIEW. Their absence from the table-positioned ID column does not establish whether they are inherited normative requirements or cross-references. Product/Requirements and Architecture must record source decisions, reviewer and date.

Source-of-record approval, inherited 900-row occurrence reconciliation, all 37 exception dispositions, 950-scope reconciliation and release acceptance remain OPEN/BLOCKED. CI must not convert any of these gates to PASS.
