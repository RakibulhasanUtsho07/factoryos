# SRS revision occurrence crosswalk — v1.9 to v2.1

**Crosswalk:** `FOS-SRS-REVISION-OCCURRENCE-CROSSWALK-01`  
**Prepared:** 2026-11-04  
**Status:** `CANDIDATE LINEAGE RECONCILED; ACTIVE 950-ROW APPROVAL STILL OPEN`

## Reconciliation findings

The source-hash-pinned candidate extracts establish a reproducible identity crosswalk across the available v2.0 inherited table, v1.9 growth/research delta, v2.1 full-PDF table candidate population, official v2.1 delta table and the 37-row owner-decision register. The builder also validates all 92 v1.9 priority values against both inherited candidate sources and verifies that the official 50-row v2.1 delta ledger agrees with the full-PDF CSV on ID, priority, page and wording hash.

| Population | Occurrences | Distinct IDs | Priority candidates |
|---|---:|---:|---|
| v2.0 normative requirement-table candidates | 809 | 799 | P0=225 / P1=527 / P2=57 |
| v1.9 growth/research delta | 92 | 92 | P0=37 / P1=55 / P2=0 |
| v2.1 full-PDF requirement-table candidates | 857 | 849 | P0=260 / P1=540 / P2=57 |
| v2.1 inherited candidates after separating its 50-row delta | 807 | 799 | inherited candidate rows only |
| v2.1 §130–§131 delta | 50 | 50 | P0=35 / P1=15 / P2=0 |

### Exact ID-set reconciliation

- All **92/92 v1.9 growth/research delta IDs** occur in both the v2.0 normative table candidates and the v2.1 inherited table candidates. Their candidate priorities match across these sources; no priority conflict was found in this subset.
- The **799 distinct v2.0 normative candidate IDs** match the **799 distinct v2.1 inherited candidate IDs** exactly. There are zero v2.0-only IDs and zero v2.1-inherited-only IDs in these table-candidate sets.
- The v2.1 addition contains **50 new IDs** (32 FR-PROD + 18 NFR-PROD). None appears in the v2.0 inherited normative table-candidate set.
- Across the 799 inherited ID matches, candidate priority values have **zero conflicts**. However, normalized wording hashes match for 754 IDs and differ for **45 IDs**. Those 45 are a source-wording/layout review queue, not an automatic wording-change, supersession or approval decision.
- Occurrence counts differ for two reused IDs: FR-IOT-09 and FR-IOT-10 each have two table positions in the v2.0 candidate PDF but one in the v2.1 inherited candidate PDF. The other eight FR-IOT repeated IDs retain two occurrences in both extracts. These are preserved as occurrence-count differences; no duplicate or supersession decision is inferred.

### The 37 priority/source exceptions

All **37** exception IDs remain absent from the v1.9/v2.0/v2.1 normative table-candidate populations and remain `OPEN_SOURCE_OWNER_REVIEW`. Page-level review candidates describe them as 31 cross-reference candidates, 3 history-reference candidates and 3 KPI-reference candidates. Their exact ID set equals the 37 rows labelled `REVIEW SOURCE` in the provisional 842-row closure tracker. This equality checks the tracker’s exception population; it does not establish whether those IDs are inherited normative requirements, cross-references, or approved exclusions.

## What this does — and does not — reconcile

The candidate extraction now demonstrates the same 799-ID inherited table-candidate set across v2.0 and v2.1, and confirms the source-located 92-row v1.9 delta plus the 50-row v2.1 delta. It materially narrows the ID lineage uncertainty.

It does **not** reconcile the SRS §140 declared inherited v2.0 count of 900 to the 809 table-positioned v2.0 occurrence candidates. The 91-row difference is not a missing-code count and is not explained by subtracting distinct IDs. The declared cumulative arithmetic `900 + 50 = 950` remains a source claim, not an approved occurrence-by-occurrence ledger. The full-PDF 899 textual-ID index and provisional 842-row closure register remain distinct populations.

The v2.0 PDF remains a conflicted Draft candidate (filename/cover say v2.0, PDF Title metadata says v1.8). The v1.9 draft also has a version-metadata conflict. The inspected v2.1 bytes are hash-matched, but controlled DMS/PLM source-of-record and formal approvals remain pending. No source owner, reviewer, canonical ID, active-scope class, duplicate/superseded/excluded decision or requirement PASS is inferred.

## Reproduction and integrity

The machine-readable payload contains 886 candidate ID crosswalk rows (799 inherited IDs + 50 v2.1 delta IDs + 37 exception IDs), source row locators, candidate priorities and normalized wording hashes. Requirement wording is not copied into this payload. The repository stores the gzip+base64 payload in four ordered text parts. The Node contract joins them, verifies compressed and decompressed SHA-256/byte counts, and checks the population invariants.

The row schema keeps v2.1 full-PDF candidate locators separate from official v2.1 delta-ledger locators because the two extraction methods use different table-row numbering conventions. The official v2.1 delta cross-check requires matching ID, priority, page and wording hash; its official table/row locator is retained independently.

Inputs and source identities are listed in `docs/srs-revision-occurrence-crosswalk.manifest.json`. The v2.1 full-PDF candidate CSV is a derived input produced by `scripts/audit/extract_srs_requirement_occurrence_candidates.py`; it is not committed because it contains source wording. The builder consumes that CSV, the exact v2.0 occurrence JSON, the v1.9 delta ledger, the official v2.1 delta ledger, the 37-row decision register and 842-row closure tracker.

### Reproduction

```bash
# Generate source-located v2.0 inherited candidates (hash-pinned).
python scripts/audit/extract_srs_v20_inherited_occurrence_candidates.py \
  --source-pdf /path/to/srs-v2.0-candidate.pdf \
  --output /tmp/srs-v20-occurrences.json

# Generate the full-PDF v2.1 table CSV (hash-pinned).
python scripts/audit/extract_srs_requirement_occurrence_candidates.py \
  --source-pdf /path/to/srs-v2.1-final.pdf \
  --output /tmp/srs-v21-occurrences.json \
  --csv-output /tmp/srs-v21-occurrences.csv

# Join the pinned repository ledgers and current branch closure tracker.
python scripts/audit/build_srs_revision_occurrence_crosswalk.py \
  --v20-ledger /tmp/srs-v20-occurrences.json \
  --v19-ledger docs/srs-v19-growth-delta-occurrence-ledger.json \
  --v21-candidates-csv /tmp/srs-v21-occurrences.csv \
  --v21-delta-ledger docs/srs-v21-delta-occurrence-ledger.json \
  --exception-decision-register docs/srs-priority-exception-owner-decision-register.csv \
  --closure-register docs/srs-p0-p1-evidence-closure-register.json \
  --output-json /tmp/srs-revision-occurrence-crosswalk.json \
  --output-payload /tmp/srs-revision-occurrence-crosswalk.payload.gz.b64 \
  --output-manifest /tmp/srs-revision-occurrence-crosswalk.manifest.json
```

The PDFs are intentionally not committed. All input extractors reject different source bytes. The builder fails closed if the pinned population counts, 92 priority comparisons, 50-row v2.1 official-delta comparison, 37 exception dispositions, or crosswalk/hash comparison totals change. CI verifies the committed payload; it does not pretend the uncommitted source PDFs were available in a GitHub runner.

**Acceptance boundary:** Product/Document Control must identify the DMS/PLM source-of-record; Product/Requirements and Architecture must approve §140’s count semantics, reconcile the 900 inherited occurrence count and disposition all 37 exceptions. All release evidence/acceptance gates remain OPEN until those decisions are recorded with immutable references.