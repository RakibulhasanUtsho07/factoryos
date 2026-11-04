# SRS v2.0 inherited-scope occurrence extraction — candidate ledger

**Ledger:** \`FOS-SRS-V20-INHERITED-CANDIDATE-01\`  
**Prepared:** 2026-11-04  
**Source candidate:** \`FactoryOS_AI_-_SRS_v2_0_Clean_AI_Logic_Consolidated_SRS.pdf\`  
**Source SHA-256:** \`8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42\`  
**PDF pages:** 93  
**Status:** \`CANDIDATE EXTRACTION ONLY — 900-row inherited active baseline remains unreconciled\`

## Extraction result

The source-hash-pinned, layout-preserving extractor produced **809 normative requirement-table row candidates across 799 distinct IDs**. The priority tokens found within those table-positioned candidates are P0=225, P1=527 and P2=57. Ten FR-IOT IDs (FR-IOT-01 through FR-IOT-10) have two separate occurrences each; both positions are retained rather than deduplicated.

The parser kept other table-like contexts separate: 13 auxiliary agent-catalogue rows (P0=2, P1=11), 30 scope/crosswalk candidates and 2 metric/decision cross-reference candidates. One standalone ID/priority line (\`FR-AIG-03\`, PDF page 6) did not receive a stable table-row locator and is retained as an unresolved locator-review candidate. It is not silently inserted into the normative total.

The checked-in snapshot is stored as a gzip+base64 payload split into three text parts, with a small payload manifest containing part order, uncompressed byte count and SHA-256. Its uncompressed JSON contains row-level page/table/row locators, ID candidates, priority candidates and extraction status. It intentionally contains no raw requirement wording or per-row wording hashes. The Python extractor computes the normalized wording SHA-256 when rerun against the source PDF; the companion Node contract joins the parts, verifies the decompressed digest and population invariants.

## Comparison with the §140 scope claim

The later v2.1 §140 text declares 900 inherited v2.0 requirements with cumulative priorities P0=261, P1=567 and P2=72. The table-positioned diagnostic above yields 809 candidate rows / P0=225, P1=527 and P2=57. The 91-row arithmetic difference and priority-bucket differences are **unreconciled source-population diagnostics**, not evidence of 91 missing requirements, 91 duplicates or missing implementation. The two numbers are not certified as equivalent populations.

Source identity also remains conflicted: the inspected file name and visible cover identify v2.0, while PDF Title metadata says \`FactoryOS AI - SRS v1.8 AI Frontier Upgrade Manufacturing SaaS\`; the source carries a Draft footer. No controlled DMS/PLM URI, approved revision record or immutable owner approval was available. The source must therefore remain a revision candidate, not an approved v2.0 normative baseline.

## Reproduction

\`\`\`bash
python -m pip install pdfplumber
python scripts/audit/extract_srs_v20_inherited_occurrence_candidates.py \\
  --source-pdf /path/to/approved-or-reviewed-srs-v2.0-candidate.pdf \\
  --output /tmp/srs-v20-inherited-occurrence-candidates.json
\`\`\`

The extractor rejects a different SHA-256 or page count. The source PDF is intentionally not committed. Join the three payload parts in the order recorded by \`docs/srs-v20-inherited-occurrence-candidate-ledger.payload-manifest.json\`, base64-decode the result, then gzip-decompress it. The manifest records the uncompressed SHA-256 and byte count.

## Acceptance boundary

Every occurrence remains \`UNRESOLVED\`. This output does not classify inherited rows as active, canonical, revised, superseded, duplicate, cross-reference-only or excluded; it does not approve any priority, settle the v1.8/v2.0 metadata conflict, or establish the full 900-row source population. It does not change the 842-row provisional P0/P1 closure register and does not mark any requirement PASS. Product/Document Control, Product/Requirements and Architecture must identify the controlled source revision, approve count semantics and disposition each ambiguity before the active 950-row ledger can close.
