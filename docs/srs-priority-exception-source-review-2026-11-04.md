# SRS v2.1 — 37 priority-exception page review (2026-11-04)

**Review type:** machine-assisted page/text inspection; not Product/Requirements approval.  
**Artifact:** `FactoryOS_AI_-_SRS_v2_1_FINAL_Product_Ready_Manufacturing_SaaS(10).pdf` (103 pages).  
**SHA-256:** `ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959` — matches `docs/audit-source-baseline-manifest.md`.  
**Prior register:** `docs/srs-priority-exception-source-review.csv` and `docs/srs-priority-exception-source-review.md`.  
**Owner-disposition issue:** #348.

## Result

The exact PDF bytes were re-hashed on 2026-11-04 and match the audited source manifest. A layout-preserving text extraction was searched for each of the 37 exception IDs. Each ID appears only in the page contexts below; none has a matching one-line `ID ... P0/P1/P2` row under the diagnostic extraction pattern.

The occurrences are history/version maps, cross-references from a current requirement, acceptance-scenario references, scope assumptions, or KPI/metric definitions. This gives a reproducible **cross-reference/history candidate** assessment for source-owner review. It is not sufficient to say the IDs are excluded from the 900 inherited v2.0 scope, nor is it authority to clear them from the gate. The PDF extraction may split table rows across lines, so the absence of a one-line match is not definitive proof that a normative occurrence does not exist in a different layout representation.

| ID | Pages with literal occurrence | Observed source context | Machine assessment |
|---|---:|---|---|
| FR-AIG-01 | 3 | v1.1/v1.2 section history map: Governance and security, FR-AIG-01 to 09 | HISTORY_REFERENCE_CANDIDATE |
| FR-AIG-03 | 7, 18 | FR-CBB-19 privacy wording; AS-31 role-only display cross-reference | CROSS_REFERENCE_CANDIDATE |
| FR-AIG-04 | 14, 18 | FR-WFC-05 access-rights dependency; AS-35 biometric import scenario | CROSS_REFERENCE_CANDIDATE |
| FR-AIG-05 | 16, 21 | NFR-CBB-08 rebuild-job cost-class constraint; older risk reference | CROSS_REFERENCE_CANDIDATE |
| FR-AIG-06 | 13 | FR-AGT-06 factory agent test-set requirement | CROSS_REFERENCE_CANDIDATE |
| FR-AIG-07 | 9, 18 | Untrusted upload/email/web-content rule; AS-29 onboarding import | CROSS_REFERENCE_CANDIDATE |
| FR-AIG-08 | 13, 19, 21 | FR-AGT-01 agent pause control; scope/assumption and risk references | CROSS_REFERENCE_CANDIDATE |
| FR-AIG-09 | 19 | “Findings rated useful” KPI reference | KPI_REFERENCE_CANDIDATE |
| FR-ANL-04 | 14 | FR-QIN-05 hypothesis marked as a hypothesis and subject to FR-ANL-04 | CROSS_REFERENCE_CANDIDATE |
| FR-ANL-10 | 13, 19, 20 | FR-AGT-05 findings feedback; useful-findings KPI; pilot assumption | CROSS_REFERENCE_CANDIDATE |
| FR-ANL-12 | 15 | FR-RPT-01 report-builder governed metric-catalogue rule | CROSS_REFERENCE_CANDIDATE |
| FR-BD-02 | 14, 18 | FR-PLN-01 energy derating dependency; AS-27 order-risk factor | CROSS_REFERENCE_CANDIDATE |
| FR-BD-10 | 18, 20 | AS-32 subcontractor-link scenario; release history/decision reference | CROSS_REFERENCE_CANDIDATE |
| FR-CHN-01 | 15, 18 | FR-WFL-05 alert acknowledgement; FR-PRT-03 expiring partner link; AS-32 | CROSS_REFERENCE_CANDIDATE |
| FR-CHN-03 | 14 | FR-QIN-06 offline defect-photo/event queue dependency | CROSS_REFERENCE_CANDIDATE |
| FR-CHN-05 | 15 | FR-PRT-04 buyer read-only shipment/TNA view | CROSS_REFERENCE_CANDIDATE |
| FR-CMP-01 | 20 | “Breaches prevented” overtime-alert KPI | KPI_REFERENCE_CANDIDATE |
| FR-CMP-03 | 15 | FR-RPT-03 report/audit evidence completeness extension | CROSS_REFERENCE_CANDIDATE |
| FR-CMP-04 | 15 | FR-RPT-03 report/audit evidence completeness extension | CROSS_REFERENCE_CANDIDATE |
| FR-CST-06 | 13 | FR-RSK-05 recovery options compared by cost, delay and margin | CROSS_REFERENCE_CANDIDATE |
| FR-ESG-01 | 18 | AS-36 finished-lot origin/certificate traceability scenario | CROSS_REFERENCE_CANDIDATE |
| FR-FBR-01 | 19 | FR-CBB-01 provisioning treatment/absorbed-by reference | HISTORY_REFERENCE_CANDIDATE |
| FR-FBR-02 | 19 | FR-CBB-08 Business Brain retrieval-planner reference | HISTORY_REFERENCE_CANDIDATE |
| FR-FBR-08 | 13 | FR-AGT-02 agent data-readiness threshold reference | CROSS_REFERENCE_CANDIDATE |
| FR-FBR-09 | 13 | FR-AGT-04 decision journal and measured-outcome extension | CROSS_REFERENCE_CANDIDATE |
| FR-FBR-10 | 10, 19 | AS-24 Brain export/delete; FR-CBB-15 scope-ledger absorption | CROSS_REFERENCE_CANDIDATE |
| FR-FBR-11 | 12 | Role-view permission-filter statement | CROSS_REFERENCE_CANDIDATE |
| FR-INT-01 | 18 | AS-35 biometric-reader import/consent scenario | CROSS_REFERENCE_CANDIDATE |
| FR-INT-03 | 15 | FR-MNT-05 predictive-maintenance telemetry dependency | CROSS_REFERENCE_CANDIDATE |
| FR-RMG-01 | 14 | FR-MAT-01 BOM/per-size material requirement extension | CROSS_REFERENCE_CANDIDATE |
| FR-RMG-02 | 14 | FR-MAT-01 configurable wastage allowance extension | CROSS_REFERENCE_CANDIDATE |
| FR-RMG-06 | 14 | FR-QIN-02 fabric inspection linked to lot | CROSS_REFERENCE_CANDIDATE |
| NFR-COST-01 | 20 | AI cost per active factory success metric | KPI_REFERENCE_CANDIDATE |
| NFR-DPR-01 | 16 | NFR-PRV-02 data-protection impact review reference | CROSS_REFERENCE_CANDIDATE |
| NFR-LOC-01 | 15 | FR-RPT-02 Bangla/English report localization reference | CROSS_REFERENCE_CANDIDATE |
| NFR-OFF-01 | 16 | NFR-REL-01 offline queuing dependency | CROSS_REFERENCE_CANDIDATE |
| NFR-SEC-02 | 10, 16, 19 | AS-23 tenant-isolation test; NFR-CBB-06 isolation tests; v1.3 scope/history map | CROSS_REFERENCE_CANDIDATE |

## What is now established

- The PDF bytes used for this page review match the existing source-manifest hash.
- All 37 IDs were located and their page contexts recorded.
- The page contexts do not show standalone one-line normative rows under the diagnostic parser.
- The older register's generic “unresolved source row” state can now be supplemented with concrete page-level context, reducing ambiguity for Product/Requirements reviewers.

## What is not established

- The canonical v2.0 source row for any inherited ID.
- Whether a given ID remains normatively active through inheritance, was superseded, was absorbed into a different v2.1 ID, or is only a historical/cross-reference mention.
- The source-owner-approved priority and applicability for each ID.
- The 950 active requirement occurrence ledger or the full 899-ID-to-950-scope reconciliation.

## Required source-owner disposition

For each of the 37 rows, Product/Requirements and Architecture must choose one of the allowed dispositions in `docs/srs-priority-exception-source-review.md`, cite the canonical source row or approved change decision, and record a named reviewer/date/immutable decision reference in the CSV. Until then the status remains `OPEN_SOURCE_OWNER_REVIEW`; no row is accepted, excluded or silently removed from the P0/P1 gate.
