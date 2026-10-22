# Quality inspection, defects, quarantine and disposition

**SRS traceability:** FactoryOS AI SRS v2.1 `FR-UFM-16` (incoming, in-process and final inspection plans) and `FR-UFM-17` (hold, disposition, NCR and CAPA workflows).

All endpoints are mounted under `/api`. They require authenticated actor, verified tenant/factory context, the permission shown below and `Idempotency-Key` on state-creating writes. The API resolves target-to-item relationships in the database rather than accepting an arbitrary item binding from a client.

## API

| Method and path | Permission | Use |
|---|---|---|
| `POST /api/quality/inspections` | `quality.inspections.write` | Create an incoming, in-process, final, inventory or supplier inspection |
| `GET /api/quality/inspections?status=FAILED&inspection_type=FINAL&limit=50` | `quality.inspections.read` | Find the factory inspection queue |
| `GET /api/quality/inspections/:inspectionId` | `quality.inspections.read` | Read defects, hold/disposition history and NCR/CAPA evidence |
| `POST /api/quality/inspections/:inspectionId/defects` | `quality.defects.write` | Record defect code, severity, affected quantity, description and evidence JSON |
| `POST /api/quality/inspections/:inspectionId/decision` | `quality.inspections.write` | `START`, `PASS`, `FAIL`, `HOLD` or `CANCEL` with an expected row version |
| `POST /api/quality/inspections/:inspectionId/dispositions` | `quality.disposition.decide` | Decide release/use-as-is, rework, scrap or supplier return |
| `GET /api/quality/holds?status=ACTIVE&limit=50` | `quality.inspections.read` | Find active and released quality holds |
| `POST /api/quality/ncrs/:ncrId/actions` | `quality.ncr.manage` | Add containment, corrective or preventive action |
| `POST /api/quality/ncrs/:ncrId/close` | `quality.ncr.manage` | Close a non-conformance report after CAPA prerequisites pass |

### Create an inspection

```json
{
  "inspection_type": "INCOMING",
  "target_type": "GOODS_RECEIPT_LINE",
  "target_id": "posted-grn-line-uuid",
  "plan_code": "INCOMING-COMPONENT-A",
  "sample_quantity": 5,
  "notes": "Inspect supplier delivery before using it"
}
```

Supported targets are `INVENTORY_ITEM`, `TRACEABILITY_UNIT`, `GOODS_RECEIPT_LINE`, `PRODUCTION_REPORT` and `WORK_ORDER`. Inspection types are `INCOMING`, `IN_PROCESS`, `FINAL`, `INVENTORY` and `SUPPLIER`. Item, GRN, production report and work-order references must exist inside the authenticated factory. A GRN inspection requires a posted receipt. Incoming, in-process and final inspections require an ACTIVE versioned plan with criteria; the selected plan revision is snapshotted onto the inspection. Inventory and supplier inspections may omit a plan only when the factory process does not require one.

## Versioned inspection plans and measured results

Use `POST /api/quality/plans` with `quality.plans.manage` to create a draft plan. Each plan has a factory-scoped case-insensitive code, an auto-incremented revision and 1–100 acceptance criteria. Every criterion declares its data type, comparator, target/range or allowed values, units, required/critical flags and sequence. Supported rules are `EQ`, `NE`, `GT`, `GTE`, `LT`, `LTE`, `BETWEEN`, `IN` and (text only) `CONTAINS`. Numeric range rules use six-decimal precision for rule values; inventory/sample quantities remain limited to four decimals.

`GET /api/quality/plans?inspection_type=INCOMING&status=ACTIVE` lists plans. `GET /api/quality/plans/:planId` returns a plan and its criteria. `POST /api/quality/plans/:planId/transition` with `{"action":"ACTIVATE","expected_version":1}` activates a draft plan; `{"action":"RETIRE","expected_version":2,"reason":"Superseded by revision 2"}` retires an active revision. An active revision cannot be silently edited, and only one revision per plan code and inspection type may be active. Retire the previous revision before activating a replacement. Amendments are new plan revisions, so historical inspections retain the criteria they actually used.

When an inspection supplies `plan_code`, the database resolves an ACTIVE plan matching that inspection type and snapshots its complete criteria and revision onto the inspection. An absent or mismatched plan code is rejected. `sample_quantity` may override the plan's default sample size; otherwise the plan default is copied.

During OPEN/IN_PROGRESS, record a measurement using `POST /api/quality/inspections/:inspectionId/results`, for example `{"criterion_code":"SIZE","observed_value":"10.5","notes":"Measured with calibrated gauge"}`. The API evaluates the observed value against the pinned acceptance rule; the client cannot choose PASS/FAIL. Results and evidence are append-only and sequenced by criterion attempt, so a rework follow-up may record a fresh attempt without overwriting the original measurement. Required criteria need a latest PASS result before the inspection can pass; this condition is enforced both in the service and by PostgreSQL. A direct SQL writer cannot submit a result that disagrees with the criterion's rule or bypass the completion gate.

## CAPA execution, independent verification and rework

A CAPA action is now a versioned, auditable work item rather than a text-only entry. Each containment/corrective/preventive action progresses through `PLANNED` → `IN_PROGRESS` → `COMPLETED` → `VERIFIED` or `REJECTED`. Completion requires notes and evidence. Verification requires its own reason/evidence and must be performed by a different actor than the completer. A rejected action must restart and submit new completion evidence. NCR closure requires all three action types to be independently verified; it also requires resolved inspection/defects, no active quality hold and no unfinished rework task.

- `POST /api/quality/ncrs/:ncrId/actions/:actionId/transition` with `{"action":"START","expected_version":1,"reason":"Work started"}` starts a planned/rejected action. `{"action":"COMPLETE","expected_version":2,"reason":"Implemented control","evidence":{"change_ticket":"CAPA-123"}}` completes an in-progress action.
- `POST /api/quality/ncrs/:ncrId/actions/:actionId/verify` with `{"decision":"PASS","expected_version":3,"reason":"Effectiveness checked","evidence":{"sample_size":10}}` verifies it. Choose `FAIL` to reject the effectiveness check and require a fresh action attempt.
- `GET /api/quality/defects/:defectId/traceability` returns the defect, its inspection/NCR context, direct source links and associated rework tasks. `POST /api/quality/defects/:defectId/links` appends an additional scoped link; a manual link must refer to a record related to the same inspection's lot/order/production context. Link evidence is immutable.
- `POST /api/quality/defects/:defectId/rework-orders` creates a rework task with a positive input quantity no greater than the defect-affected quantity. `GET /api/quality/rework-orders` and `GET /api/quality/rework-orders/:reworkOrderId` provide the queue and event history. `POST /api/quality/rework-orders/:reworkOrderId/transition` handles `APPROVE`, `START`, `COMPLETE`, `VERIFY`, `RESTART` and permitted `CANCEL` commands with an expected row version and idempotency key.

Rework completion must reconcile `recovered_quantity + scrap_quantity = input_quantity`. A recovered output requires a new active traceability lot/serial whose quantity exactly matches recovered quantity and a follow-up `IN_PROCESS`, `FINAL` or `INVENTORY` inspection targeting that exact identity. Verification follows the follow-up inspection result; a failed/held follow-up returns the task to `REWORK_REQUIRED`, allowing a fresh attempt without overwriting previous output evidence. Independent verification is required. Recovered output is linked back to the original defect with a `REWORK_OUTPUT` link, while the source lot/order/production links remain append-only history.

A rework task records process quantities and genealogy evidence but **does not post inventory stock**. The inventory ledger remains the only stock authority. Source holds are not automatically released just because recovered output passed: disposition/release must explicitly resolve the original quarantine. Scrap stock is not removed unless the existing quality disposition and matching inventory ISSUE workflow are completed.

## Lifecycle

```text
OPEN -> IN_PROGRESS -> PASSED
                   -> FAILED -> DISPOSITIONED
          |        -> ON_HOLD -> DISPOSITIONED
          +-> CANCELLED

An ON_HOLD inspection can return to IN_PROGRESS only after a REWORK disposition has been recorded.
```

Every decision checks `expected_version`. A stale update returns a conflict instead of overwriting another inspector's work. Repeating the same key with the same request replays the original record; the same key with a different request conflicts. Defects may only be reported against OPEN or IN_PROGRESS inspections, require a valid defect code, a `CRITICAL`, `MAJOR` or `MINOR` severity, positive affected quantity and non-empty description. Evidence JSON can hold measurement links, certificates or operator notes. Defect reporting is append-only evidence; the permitted disposition is recorded separately.

`FAIL` requires at least one open defect. `PASS` is blocked while defects remain OPEN. Rework defects are resolved by a successful follow-up inspection; an inspection cannot be cancelled while defects remain OPEN/REWORK. FAIL/HOLD creates an active hold and a corresponding NCR. An NCR cannot close until all three action types—`CONTAINMENT`, `CORRECTIVE` and `PREVENTIVE`—are recorded, no defect for the inspection remains OPEN or in REWORK, the inspection is `PASSED` or `DISPOSITIONED`, and no active quality hold remains. The service and database guard both enforce this gate.

## Quarantine and disposition

Quality holds are evidence-backed and reason-required. The database controls the cross-module effect:

- An item-level hold prevents new inventory reservations and blocks ordinary stock ISSUE movements until an authorized quality disposition permits a matching action.
- A traceability-unit/lot/serial hold synchronizes its status to `QUARANTINED` in the genealogy ledger and writes the status-history, audit and outbox evidence. A quality release returns the unit to `ACTIVE` only when no other active quality hold remains; recall/disposal states are not silently reopened.
- A work-order hold blocks the work order from moving into `IN_PROGRESS` or `COMPLETED` and prevents new output reports while the hold remains active.
- Release and use-as-is record an explicit disposition and close the associated active hold. Rework preserves a hold and inspection re-entry requires the explicit rework disposition.

`SCRAP` and `RETURN_TO_SUPPLIER` return a `next_inventory_action` pointing to an inventory `ISSUE` with `reference_type=QUALITY_DISPOSITION` and the disposition ID. This stock removal is a separate idempotent inventory write: it must use the full current on-hand balance with no active reservation. Until that matched ISSUE posts, the disposition remains `PENDING_INVENTORY` and the hold stays active. The database records the exact movement and then completes the disposition atomically. This deliberately fails closed because the current aggregate inventory ledger does not yet decrement quality holds by an individual lot/serial quantity. Release any existing reservations before scrapping or returning the full item balance.

## Audit and integrity

Migration `093_quality_inspection_ncr_holds_disposition.sql` adds tenant/factory-scoped quality tables with forced PostgreSQL RLS, optimistic row versions, idempotency uniqueness, append-only event/audit evidence and transactional outbox records. DB triggers enforce target ownership, valid transitions, reason/evidence requirements, hold protections for inventory and production, traceability quarantine/release history and CAPA closure. The external audit sink is not the source of truth; durable audit and outbox evidence commit with the quality mutation.

Regression coverage:
- `services/api/src/quality/quality.service.spec.ts` — pre-transaction request validation.
- `services/api/test/quality-management-contract.sql` — migration, tenant RLS and cross-module enforcement contract.

**Current boundary:** the workflow supports reusable versioned inspection plans, per-criterion acceptance rules/measurement records, defect evidence, hold/release/disposition and NCR/CAPA. Physical QR/barcode rendering, RFID capture, offline mobile sync and lot-aware partial stock consumption remain separate integration capabilities.


## Advanced quality acceptance: AQL, fabric rolls, supplier linkage and Pareto

Migration `164_quality_advanced_sampling_supplier_pareto.sql` adds factory-scoped, versioned AQL and fabric scoring profiles. These are explicit factory-approved sampling rules; the runtime does not pretend that the AQL percentage alone selects an industry-standard sample size or acceptance number. The approved profile records the lot-size range, sample size, accept number and reject number used by the inspection, and every sample run snapshots the profile revision and decision evidence.

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /api/quality/aql-profiles`, `GET /api/quality/aql-profiles` | `quality.advanced.manage` / `quality.advanced.read` | Create/list AQL profile revisions |
| `POST /api/quality/aql-profiles/:profileId/transition` | `quality.advanced.manage` | Activate or retire a profile with `expected_version` |
| `POST /api/quality/fabric-scoring-profiles`, `GET /api/quality/fabric-scoring-profiles` | `quality.advanced.manage` / `quality.advanced.read` | Create/list roll-scoring revisions |
| `POST /api/quality/fabric-scoring-profiles/:profileId/transition` | `quality.advanced.manage` | Activate or retire a scoring revision |
| `POST /api/quality/inspections/:inspectionId/sampling-profile` | `quality.advanced.manage` | Bind an ACTIVE profile of the same inspection type |
| `POST /api/quality/inspections/:inspectionId/aql-samples` | `quality.advanced.manage` | Record lot/sample size, nonconforming count and evidence |
| `POST /api/quality/inspections/:inspectionId/fabric-roll-scores` | `quality.advanced.manage` | Record roll dimensions, point breakdown and evidence |
| `GET /api/quality/inspections/:inspectionId/advanced-evidence` | `quality.advanced.read` | Read pinned profiles, sampling/roll records, defects, holds, dispositions, supplier events and rework links |
| `POST /api/quality/defects/:defectId/context` | `quality.advanced.manage` | Capture immutable line/operation/style/shift dimensions for a defect |
| `GET /api/quality/analytics/defect-pareto?dimension=DEFECT` | `quality.advanced.read` | Ranked defect counts, affected quantity, critical/unresolved counts and cumulative percent |
| `GET /api/quality/analytics/supplier-quality` | `quality.advanced.read` | Aggregate receipt lines, supplier defect severities and linked rework tasks |
| `GET /api/quality/analytics/rework-repeat-alerts` | `quality.advanced.read` | Repeated defect-code/style/supplier clusters in a bounded lookback window |

### AQL sampling and release rules

Create a DRAFT profile with `POST /api/quality/aql-profiles`, then activate it through the versioned transition route. Supply `{"action":"ACTIVATE","expected_version":1,"reason":"Quality-approved sampling plan" }` with an `Idempotency-Key`. Use `inspection_type`, `aql_percent`, `inspection_level`, `lot_size_min`, `lot_size_max`, `sample_size`, `accept_number` and `reject_number` in the profile. The sample size must fit the configured lot-size range, and the rejection number must be greater than the acceptance number and no greater than sample size.

Bind the ACTIVE profile to an OPEN inspection with `{"expected_version":1,"aql_profile_code":"INCOMING-FABRIC-AQL"}`. Record the sample using `{"lot_size":120,"observed_nonconforming":2,"evidence":{"sample_sheet":"QC-LOT-2026-001","inspector_note":"Random samples across the lot"}}`. The database determines the result: count at or below accept number is `ACCEPT`, at or above reject number is `REJECT`, and a count between them is `HOLD`. Profile binding and sample evidence are immutable, factory scoped and idempotent. An AQL `REJECT` or `HOLD` records the sample first and then routes the inspection through the existing hold lifecycle; retrying the same sample key retries reconciliation of its hold if needed. A `PASSED` transition is blocked unless the bound AQL run is `ACCEPT`. Do not bypass the regular quality disposition to release a rejected lot.

### Fabric roll point scoring

Activate a factory-approved fabric scoring profile with `max_points_per_100_square_yards` and `minimum_roll_count`, then bind it to an OPEN `INCOMING` or `SUPPLIER` inspection as appropriate. Each roll request includes a stable `roll_code`, `roll_length_yards`, `roll_width_inches`, `total_defect_points`, a `defects` array where each entry contains a non-negative numeric `points` value, and evidence (for example, inspection-sheet reference and roll photos). The sum of the point breakdown must equal `total_defect_points`; repeat requests with the same key and same payload replay, while reusing the key for a different payload conflicts.

The database derives the four-point score as:

`points_per_100_square_yards = total_defect_points * 3600 / (roll_length_yards * roll_width_inches)`

The denominator conversion uses yards for roll length and inches for width. A roll passes only when its score is at or below the bound profile's threshold. A held roll moves the inspection into the normal ON_HOLD flow. Passing the inspection requires at least the profile's minimum number of PASS roll records and no non-PASS roll. The accepted revision, computed score, threshold snapshot and defect breakdown remain append-only evidence.

### Defect Pareto, supplier quality and repeated alerts

Defect reports derived from a GRN-line inspection already carry a scoped `GOODS_RECEIPT_LINE` source link. The database derives its supplier through that line's purchase order; callers cannot nominate an arbitrary supplier. A supplier-quality event is emitted once per source-link/event type, with receipt, defect, severity and affected-quantity evidence, plus transactional quality audit and outbox records. The supplier analytics keeps quality quantity aggregation separate from rework-task aggregation so one defect with multiple rework tasks cannot multiply its reported affected quantity.

For operational Pareto, submit `dimension=DEFECT`, `LINE`, `OPERATION`, `STYLE` or `SHIFT`, optional ISO date filters `from`/`to`, and a bounded `limit`. Non-defect dimensions require an immutable dimension snapshot from the context route; missing labels are omitted rather than inferred. The response includes total defects, ranking and cumulative defect percentage as well as critical, unresolved and affected-quantity counts.

Repeat alerts accept `lookback_days` (1–365), `minimum_occurrences` and a bounded `limit`. Alerts group repeated defect codes by captured style and linked supplier and expose critical/unresolved volume, rework task counts, latest occurrence and a deterministic `HIGH`/`MEDIUM`/`WATCH` level. These are triage alerts, not autonomous defect disposition or supplier suspension.

### Inventory and disposition boundary

Advanced sampling never writes inventory balances itself. A rejected/held quality inspection uses the established quality hold so issue/reservation guards remain active. Release, use-as-is, rework, scrap and supplier-return still require their authorized disposition lifecycle. Rework quantities must reconcile as `recovered_quantity + scrap_quantity = input_quantity`; recovered output needs a traceability identity and successful follow-up inspection before verification. A rework task is not a receipt and never increments stock. Scrap or return decreases stock only through the matching approved disposition and inventory `ISSUE` movement, with the disposition and movement IDs linked. The quality disposition stays pending and the hold stays active until that stock movement posts.

### Advanced quality acceptance evidence

`services/api/test/quality-advanced-acceptance.sql` is wired into PostgreSQL CI and checks migration registration, forced RLS, immutable revision/evidence triggers, uniqueness/idempotency constraints, decision guards, supplier provenance and deterministic AQL/roll arithmetic. The populated `services/api/test/quality-advanced-workflow.sql` fixture exercises the real PostgreSQL profile-binding trigger, AQL reject/pass barrier, authorized hold release, fabric roll pass/hold calculations, PASS blocking for a held roll, and an approved full SCRAP movement. It asserts that aggregate and location balances reach zero and that the linked disposition/hold close with the inventory movement ID. The same fixture adds three evidenced defects with line/operation/style/shift snapshots and asserts the top-two ranking and cumulative Pareto percentage across all five dimensions, plus repeated-defect alert count and affected quantity.

The existing `services/api/test/goods-receipt.sql` fixture links an incoming defect to its posted GRN line and verifies the PO-derived supplier identity, supplier-quality event provenance, transactional quality audit/outbox, rejected quantity handling and one-event idempotency.

Migration `165_quality_disposition_inventory_balance_guard.sql` aligns the SCRAP/RETURN guard with the inventory transaction order: the aggregate balance is decremented before the immutable ISSUE movement is inserted, so validation matches the movement's post-balance. Migration `166_quality_rework_inventory_ledger.sql` adds guarded source issues, recovered-output receipts and cancellation restoration. `services/api/src/quality/quality.service.ts` posts split source issues to the inventory ledger when rework starts, restores the original location quantities when a started rework task is cancelled, and posts recovered output only after independent verification plus a PASSED follow-up inspection. The recovered output receipt also creates its lot/location balance, movement audit and transactional outbox evidence. Migration `167_quality_sampling_binding_state_guard.sql` allows the one-time versioned AQL/fabric profile bind on an OPEN inspection without weakening the normal inspection lifecycle transitions.

The populated `services/api/test/quality-rework-inventory.sql` fixture sets up a tracked source lot and checks source consumption, an output lot's follow-up inspection, independent rework verification, recovered quantity receipt, the scrap remainder, source/output traceability-location balances, aggregate/location stock balance, inventory movement history and audit/outbox links. The inventory ledger guard also covers cancellation restoration; the populated fixture focuses on a recovered-plus-scrap completion rather than a cancelled-task replay.

**Release status: PARTIAL until the exact candidate SHA passes API and PostgreSQL CI.** The populated tests now cover AQL decisions, fabric scoring, all five Pareto dimensions, repeat-alert results, GRN-derived supplier-quality evidence, approved hold/disposition rules, full SCRAP balance reconciliation, and verified rework recovery/scrap conservation. Do not mark this task PASS based only on a prior commit's workflow result. Record the actual passing API and PostgreSQL CI run links for the final SHA before treating release acceptance as complete.

## External inspection and quality event reconciliation

External QMS/MES event streams use the signed integration contract described in [operational event reconciliation](./operational-event-reconciliation.md). Stable reconciliation keys allow the system to surface duplicate or conflicting inspection evidence across connectors, while source event IDs and sequence/watermark fields expose delivery gaps. Reconciliation cases are review evidence only: resolving a mismatch does not change inspection results, NCR/CAPA status, disposition or active quality holds. Those decisions must still pass the quality endpoints, permissions and lifecycle guards documented above.
