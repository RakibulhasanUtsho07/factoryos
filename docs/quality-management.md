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

Supported targets are `INVENTORY_ITEM`, `TRACEABILITY_UNIT`, `GOODS_RECEIPT_LINE`, `PRODUCTION_REPORT` and `WORK_ORDER`. Inspection types are `INCOMING`, `IN_PROCESS`, `FINAL`, `INVENTORY` and `SUPPLIER`. Item, GRN, production report and work-order references must exist inside the authenticated factory. A GRN inspection requires a posted receipt. The selected `plan_code` is retained with the inspection; reusable versioned plan authoring and measured results per inspection criterion are a separate follow-up, not inferred from this field.

## Lifecycle

```text
OPEN -> IN_PROGRESS -> PASSED
                   -> FAILED -> DISPOSITIONED
          |        -> ON_HOLD -> DISPOSITIONED
          +-> CANCELLED

An ON_HOLD inspection can return to IN_PROGRESS only after a REWORK disposition has been recorded.
```

Every decision checks `expected_version`. A stale update returns a conflict instead of overwriting another inspector's work. Repeating the same key with the same request replays the original record; the same key with a different request conflicts. Defects may only be reported against OPEN or IN_PROGRESS inspections, require a valid defect code, a `CRITICAL`, `MAJOR` or `MINOR` severity, positive affected quantity and non-empty description. Evidence JSON can hold measurement links, certificates or operator notes. Defect reporting is append-only evidence; the permitted disposition is recorded separately.

`FAIL` requires at least one open defect. `PASS` is blocked while defects remain OPEN. Rework defects are resolved by a successful follow-up inspection; an inspection cannot be cancelled while defects remain OPEN/REWORK. FAIL/HOLD creates an active hold and a corresponding NCR. An NCR cannot close until all three action types—`CONTAINMENT`, `CORRECTIVE` and `PREVENTIVE`—are recorded and no defect for the inspection remains OPEN or in REWORK.

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

**Current boundary:** inspection records, defect evidence, hold/release/disposition and NCR/CAPA are supported. Reusable versioned inspection-plan authoring and per-criterion measured results are not yet implemented by this slice; `plan_code` currently references a plan selected by the factory rather than a managed criteria set.
