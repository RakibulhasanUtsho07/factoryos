# SRS Requirement-Scope Reconciliation Ledger

**Ledger ID:** FOS-TRACE-SCOPE-01  
**Prepared:** 2026-10-20  
**Status:** `PARTIAL — §140 scope arithmetic reconciled; active requirement occurrence ledger and source-owner sign-off pending Product/Architecture`  
**Source:** SRS v2.1 Final / FOS-SRS-001, §140 and the requirement-by-requirement matrix derived from the inspected 2026-10-02 source copy.  
**Related register:** [Source-of-record and approval register](srs-source-of-record-and-approval-register.md).

## 1. Reconciliation result — what is and is not established

The source itself gives a **scope-ledger arithmetic that can be reconciled**. SRS §140 says the inherited v2.0 design scope is 900 requirements; v2.1 adds 50 productization/production-readiness requirements (32 functional and 18 non-functional); the consolidated scope is 950. The same source states the added priority counts are P0=35, P1=15, P2=0. Its inherited cumulative priorities are P0=261, P1=567, P2=72, producing final cumulative priorities of P0=296, P1=582, P2=72.

That arithmetic reconciles exactly:
- Scope: 900 + 50 = 950.
- P0: 261 + 35 = 296.
- P1: 567 + 15 = 582.
- P2: 72 + 0 = 72.

The repository's **899 distinct FR/NFR ID figure is a different, provisional measure**: it was extracted from the *full 103-page PDF text*, which contains the final v2.1 document plus inherited/historical revision content and cross-reference mentions. It is not a confirmed count of unique active requirement rows in the current v2.1 scope. Therefore:
- The arithmetic difference (950 - 899 = 51) is **not evidence of 51 missing implementations**, and neither is it proof of 51 duplicates.
- The priority buckets (P0=259, P1=546, P2=57, review=37) belong to this full-PDF distinct-ID index, not a source-owner-approved current active v2.1 requirement occurrence ledger. They must not be subtracted from §140's cumulative categories.
- The 37 IDs with unresolved source-row/priority extraction are currently a separate exception set. Literal source searches often return references from other requirement rows, metrics, scope/history or scenarios; a one-line table-row search is only an extraction diagnostic. Their canonical IDs, active applicability and priority require Product/Requirements source-owner disposition.
- The 842-row JSON/CSV is a **provisional closure tracker population** (805 source-index rows parsed as P0/P1 plus 37 review candidates). It is not proven to be exactly the active v2.1 P0/P1 set and is not an implementation-gap count. Keep its entries OPEN until the active source occurrence ledger is reconciled.

**Current decision:** the arithmetic within §140 is reconciled; the difference between the §140 active cumulative scope and the 899-key full-PDF text index remains **not numerically reconciled**. The missing deliverable is a revision-aware occurrence ledger separating active inherited v2.0 requirements, v2.1 delta requirements, changed/superseded wording, and cross-reference-only mentions. Product/Requirements + Architecture must approve that ledger before the release gate may be closed.

| Metric | SRS §140 | Repository extraction | Current interpretation | Closure action |
|---|---:|---:|---|---|
| §140 cumulative arithmetic vs full-PDF distinct-ID index | 900 + 50 = 950 cumulative | 899 distinct textual ID keys across all 103 PDF pages | §140 arithmetic reconciled; 899-key index includes historical text/cross-references and is not active v2.1 scope | Product + Requirements + Architecture approve the 950-row active occurrence/canonical-ID ledger and 899-key crosswalk |
| P0 | 296 cumulative | 259 parsed P0 IDs in full-PDF text index | Different population; not comparable by subtraction | Reconcile all active v2.0 P0 rows plus v2.1 delta and cross-reference/supersession cases |
| P1 | 582 cumulative | 546 parsed P1 IDs in full-PDF text index | Different population; not comparable by subtraction | Same, with source page and canonical ID for every active row |
| P2 | 72 cumulative | 57 parsed P2 IDs in full-PDF text index | Different population; not comparable by subtraction | Same, including all current P2 active rows and cross-references |
| Priority/wording review | Not stated as a separate cumulative measure | 37 distinct IDs marked `REVIEW SOURCE` | Known extraction exceptions; source text needs manual review | Resolve every ID below against the exact source PDF table and record reviewer/evidence |
| Arithmetic (950 - 899) | 950 | 899 | 51 difference only; **not a missing-code count** | Do not close until source occurrences/revision semantics explain the relationship |

## 1A. Scope arithmetic evidence from SRS §140

The exact inspected source text on **PDF page 103 / printed §140** says: “The inherited v2.0 design-scope is 900 requirements”; “v2.1 adds 50 productization and production-readiness requirements: 32 functional and 18 non-functional”; “New v2.1 priority additions are P0=35, P1=15 and P2=0”; and “The consolidated design-scope becomes 950 requirements: cumulative P0=296, P1=582 and P2=72.” The inherited v2.0 priority baseline is P0=261, P1=567 and P2=72 (sum 900). This confirms the arithmetic above but does **not** enumerate all 950 current active requirement occurrences or explain which of the 899 full-document distinct IDs are still active.

## 2. Source-occurrence reconciliation method

A numeric reconciliation must be built from the **authoritative source PDF**, not by changing expected counts until CI passes. Use one row for every requirement occurrence in every normative section/revision represented by the final SRS. Do not collapse a reused ID before classifying each occurrence.

Required occurrence ledger columns:

| Field | Required meaning |
|---|---|
| `source_artifact_sha256` | Exact approved SRS bytes, matching the source-of-record register |
| `source_section` / `source_page` | Normative table or §140 scope entry and page reference |
| `source_occurrence_key` | Stable occurrence key (for example `section:table:row`); not derived from ID alone |
| `requirement_id` | Literal FR/NFR ID printed in the source |
| `normalized_wording_hash` | SHA-256 of normalized normative wording, with normalization rules documented |
| `source_priority` | Priority printed in that specific occurrence; never inherit silently from another revision |
| `occurrence_class` | Exactly one of `CANONICAL_FINAL`, `REVISED_SAME_ID`, `SUPERSEDED`, `CROSS_REFERENCE_ONLY`, `DUPLICATE_OCCURRENCE`, `SCOPE_LEDGER_ONLY`, `EXCLUDED_WITH_APPROVAL`, `UNRESOLVED` |
| `canonical_requirement_id` | Final normative ID for a revised/reused row, if approved |
| `rationale` | Why the occurrence contributes (or does not contribute) to the stated cumulative count |
| `source_owner_decision_ref` | Link/ID of Product/Architecture-approved decision |
| `reviewer_and_date` | Accountable reviewer and UTC/date stamp |

### Reconciliation rules

1. Freeze the approved raw source bytes and verify the SHA-256 before extracting rows.
2. Extract normative requirement occurrences and §140 tally definitions separately. Cross-reference-only mentions must not silently become new requirements.
3. Group occurrences by ID **and wording hash**. The same ID with changed wording or priority is a revision relationship, not automatically a duplicate.
4. Compare the final normative occurrence set to the cumulative scope ledger definition. Explicitly classify legacy/superseded occurrences, merged items, scope-ledger-only items and unresolved occurrences.
5. Have Product/Requirements and Architecture approve the classifications. Preserve prior values and the approval record; do not overwrite the history.
6. Rebuild the 899-ID matrix and all priority counts from the accepted occurrence ledger. Keep the 950 figure only if its counting basis is shown and owner-approved.
7. Update the validator's expected counts only in the same change that commits the reviewed occurrence ledger and the signed reconciliation decision.

**Current limitation:** The inspected repository has an extracted per-distinct-ID matrix but does not yet contain a source-owner-approved occurrence ledger explaining how §140 computes the cumulative count. That is the blocking evidence for a final numeric reconciliation. No one should invent duplicate/supersession classifications to force the totals to match.

## 3. The 37 priority/wording exceptions

Literal source-occurrence counts/page locations and the row-search diagnostic for this 37-ID set are preserved in [the source-review evidence note](srs-priority-exception-source-review.md) and [the machine-readable exception CSV](srs-priority-exception-source-review.csv). The search is a text-extraction aid, not a signed source disposition; each exception remains open until its canonical normative row, source priority and Product/Requirements decision reference are supplied.


All of the following currently appear as `REVIEW SOURCE` in the matrix. Each remains unresolved until a reviewer records the exact authoritative source page/table, literal wording and priority. Domain hints below are triage aids only, not replacement wording.

| Requirement ID | Triage domain | Required source review | Current disposition |
|---|---|---|---|
| FR-AIG-01 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-AIG-03 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-AIG-04 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-AIG-05 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-AIG-06 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-AIG-07 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-AIG-08 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-AIG-09 | AI governance/runtime | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-ANL-04 | Analytics/metrics | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-ANL-10 | Analytics/metrics | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-ANL-12 | Analytics/metrics | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-BD-02 | Manufacturing delivery board | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-BD-10 | Manufacturing delivery board | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-CHN-01 | Customer/channel collaboration | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-CHN-03 | Customer/channel collaboration | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-CHN-05 | Customer/channel collaboration | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-CMP-01 | Compliance | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-CMP-03 | Compliance | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-CMP-04 | Compliance | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-CST-06 | Costing | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-ESG-01 | ESG/sustainability | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-FBR-01 | Factory Business Representation | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-FBR-02 | Factory Business Representation | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-FBR-08 | Factory Business Representation | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-FBR-09 | Factory Business Representation | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-FBR-10 | Factory Business Representation | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-FBR-11 | Factory Business Representation | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-INT-01 | Integrations | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-INT-03 | Integrations | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-RMG-01 | Raw material / manufacturing pack | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-RMG-02 | Raw material / manufacturing pack | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| FR-RMG-06 | Raw material / manufacturing pack | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| NFR-COST-01 | Cost / FinOps | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| NFR-DPR-01 | Data privacy / retention | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| NFR-LOC-01 | Localization/accessibility | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| NFR-OFF-01 | Offline/edge operations | Locate final normative row; verify wording and P0/P1/P2 | OPEN |
| NFR-SEC-02 | Security | Locate final normative row; verify wording and P0/P1/P2 | OPEN |

**No priority exception may be marked resolved merely because a nearby cross-reference mentions the ID.** The reviewer must identify the actual normative row or formally classify the ID as an approved reference-only/superseded item with a source-owner decision.

## 4. Closure log

| Closure item | Responsible role | Evidence required | Current state |
|---|---|---|---|
| Approve authoritative sources and raw-byte hashes | Product / Document Control | Approved DMS records, revision, date, owner, independent hash verification | BLOCKED |
| Define the §140 cumulative-count semantics | Product Owner + Requirements Lead | Written count definition and occurrence ledger | BLOCKED |
| Reconcile source occurrences to distinct IDs | Requirements Lead + Engineering | Complete occurrence ledger, canonical mappings, exception dispositions | BLOCKED |
| Resolve 37 priority/wording exceptions | Product + domain owners | Exact SRS page/table, literal wording, priority, reviewer, decision reference for each row | BLOCKED |
| Attach direct P0/P1 evidence | Engineering + Security + Operations | Exact code/migration/test references, CI URLs, candidate SHA, staging evidence where required | OPEN |
| Approve final release traceability | Product + Architecture + Engineering + Security + Operations | Signed go/no-go record with accepted exceptions and release SHA | BLOCKED |

## 5. Exit criteria

This ledger may be marked **RECONCILED** only when all items below have evidence:

- [ ] Product/Document Control identifies the approved, accessible source-of-record for SRS, HLD/LLD and Blueprint.
- [ ] The exact approved source PDFs' raw-byte hashes have been independently re-verified.
- [ ] Every normative requirement occurrence has a source location, priority, occurrence class and canonical ID/disposition.
- [ ] The §140 cumulative count is reproducible from a documented method; the relationship between 950 and distinct IDs is explained by source-backed row classifications rather than arithmetic assumptions.
- [ ] All 37 exceptions are resolved or explicitly dispositioned by the source owner.
- [ ] Every P0/P1 requirement (plus all unresolved-priority candidates until classified) has direct evidence pointers, named owner, accepted result or approved open-risk disposition, and exact candidate SHA.
- [ ] Applicable AS-132–AS-141 scenarios and P0 production NFR gates have required staging/operational evidence.
- [ ] Product, Architecture, Engineering, Security and Operations approve the final release evidence set.

Until then the correct decision is `NOT READY FOR FORMAL TRACEABILITY SIGN-OFF`. A passing extraction validator proves consistency of the audit artifacts, not that the product has passed every requirement.
