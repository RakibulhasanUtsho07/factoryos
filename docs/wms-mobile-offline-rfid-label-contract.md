# WMS mobile offline sync, barcode/QR labels and RFID contract

**Scope:** P0/P1 WMS/mobile contract aligned with the inventory stock ledger, lot/serial genealogy and immutable audit/outbox rules.

## Delivery boundary

This slice implements the backend contract, persisted sync receipts, immutable label-issue evidence, RFID read deduplication and PostgreSQL integration tests. It does not add a native mobile application, local SQLite/IndexedDB queue UI, camera scanner, printer driver, or physical RFID-reader adapter. A mobile client must durably retain unsynced operations on-device, retry them after connectivity returns, and only retire a queue item after it receives the server's terminal result. The API returns a print payload and versioned layout snapshot; the client renders the barcode/QR image and communicates with the printer.

## Endpoints

All routes require an authenticated user, tenant and factory context and use IAM permission checks plus factory scoping.

| Route | Permission | Contract |
|---|---|---|
| `POST /traceability/labels/issue` | `traceability.write` | Idempotently records a label issue for exactly one traceability unit or one material master item. Requires `Idempotency-Key`. |
| `GET /traceability/labels/resolve?code=...` | `traceability.read` | Resolves a canonical barcode, unit code, material SKU or RFID EPC. Ambiguous matches are rejected rather than guessed. |
| `GET /traceability/units/:unitId/label-history` | `traceability.read` | Returns immutable label-issue history for a lot, serial, pallet, carton, bundle, finished good or shipment identity. |
| `GET /traceability/items/:itemId/label-history` | `traceability.read` | Returns immutable label-issue history for a material master item. |
| `POST /wms/mobile/offline-sync/batches` | `inventory.write` | Reconnects a device's queued stock movements. A batch contains 1–100 operations. |
| `POST /wms/mobile/rfid/read-batches` | `traceability.write` | Ingests one reader session, suppresses repeated EPC reads, and persists quantity reconciliation evidence. Requires `Idempotency-Key`. |

## Barcode/QR identity

A label template defines symbology (`QR`, `CODE128`, `DATAMATRIX`, or `GS1_128`), a layout and supported target types. Templates are immutable. A changed layout or set of target types must be represented by a new template code.

A traceability label identifies a row from `traceability_units`; its payload includes the durable unit ID/code, barcode value, unit type, product role, lot expiry, and RFID EPC when assigned. Its genealogy edges remain the same `product_genealogy_events` IDs used by forward/reverse trace.

A material master label identifies `inventory_items.id` and uses the SKU as the canonical barcode value. It deliberately does **not** create a synthetic lot or quantity-bearing traceability unit: material master identity is not physical lot stock and must not inflate stock reconciliation. The print/issue row holds a snapshot of the template and encoded payload and exactly one target (traceability unit **or** inventory item), joined to the normal audit and outbox evidence.

Example unit label request:

```json
{
  "unit_id": "69ef2a43-8157-4d91-aa59-7b4260ef1778",
  "template_id": "a2c5c233-64b9-4fb4-857f-43aab0db78f7",
  "copy_count": 2
}
```

Example material master label request:

```json
{
  "item_id": "9d7e11aa-2e5b-4680-9519-04ecf5af7d1a",
  "template_id": "a2c5c233-64b9-4fb4-857f-43aab0db78f7",
  "copy_count": 1
}
```

Exactly one of `unit_id` or `item_id` is required. Repeating a request with the same idempotency key and matching payload replays the same issue record; reusing that key for a different target or copy count returns a conflict. The `print_contract` response carries symbology, encoded value, copy count, layout snapshot and identity payload; image generation and physical printing are client responsibilities.

## Offline enqueue and reconnect

The client queue should persist, at minimum: `device_id`, UUID `client_transaction_id`, operation type, item ID, movement type, quantity, selected location (when used), the stock `expected_balance_version` observed by the device, optional source/reference, and enqueue time. The client should not treat local balance projections as authoritative.

The current backend accepts only `STOCK_MOVEMENT` in the mobile sync route. Each transaction ID becomes a deterministic server idempotency key scoped to the device. The request hash covers the operation and all stock-affecting fields. The stock service checks the expected balance version while holding item/balance locks, before posting the movement. A stale balance becomes a conflict and does not silently apply against a newer stock snapshot.

| Result | Meaning | Client action |
|---|---|---|
| `APPLIED` | Movement committed and a receipt is durable | Remove this queue item after storing the receipt/result. |
| `CONFLICT` | Stale stock version, conflicting reuse of a transaction ID, or another business-state conflict | Keep evidence; require refresh/user resolution before creating a new transaction ID. Do not blindly mutate and resend the original payload. |
| `REJECTED` | Invalid/unsupported request or an item/resource that cannot be used | Preserve the result for audit/support; a corrected operation must use a new transaction ID. |

A repeated matching transaction ID returns the original terminal result, never repeats the stock effect, and records a `REPLAYED` attempt. Reuse of the same transaction ID for a different request is a deterministic `CONFLICT` and gets an immutable `IDEMPOTENCY_CONFLICT` attempt. First terminal receipts, attempt history, audit events and outbox events are persisted server-side. Expected balance version should be treated as a decimal string to avoid JSON number precision loss.

The API processes a batch one transaction at a time. Each transaction has its own terminal receipt; the batch summary can therefore contain successes, conflicts and rejections together. Clients must reconcile every returned transaction ID individually.

## RFID read and quantity reconciliation

A reader session is scoped to the tenant, factory, reader and session UUID. Duplicate EPCs within a batch are canonicalized to uppercase and sorted before request hashing. One observation is stored per distinct EPC, while `duplicate_read_count` and `duplicate_reads_suppressed` retain diagnostics without counting repeated reads as additional stock.

An eligible EPC resolves to the same `traceability_units.rfid_epc` identity used by the barcode/QR workflow and is joined to its physical item/location trace balance. Unknown tags, tags for another item, absent quantity and quarantined/recalled/disposed/shipped/expired/damaged/held material are excluded from observed quantity and receive an explicit disposition. The service compares the deduplicated observed quantity with the authoritative bin's ledger quantity and returns `MATCHED` or `VARIANCE`, with expected, observed and signed variance quantities. It **does not auto-adjust stock**: variance must follow the existing stock reconciliation/cycle-count approval workflow.

A matching idempotency-key plus matching read set replays the stored session result. A reused key with a different read set, or a different key for an already-used reader/session pair, is rejected as conflict. Read batches, observations, their actor, and reconciliation result are append-only evidence linked to audit and outbox records.

## Safety/integrity rules

- All identities and records are scoped by tenant and factory; foreign keys bind cross-record scope and RLS is enabled and forced on the new ledger tables.
- Label issue, offline receipt and RFID reconciliation records are append-only and have deferred audit/outbox evidence checks.
- The queue's expected balance version is part of the movement fingerprint; a changed payload cannot masquerade as a replay.
- RFID deduplication occurs before summing quantities. A reader repeat is not a receipt, issue, or stock adjustment.
- Label issuance is a reference/print event, not a stock movement. Issuing a label cannot change on-hand quantity or genealogy.
- Physical mobile storage, reconnect scheduling, camera/barcode scanning, print rendering and RFID hardware transport remain device/client integration scope; no hardware connection is implied by this backend contract.

## Verification contract

The PostgreSQL integration suite covers:

1. Offline enqueue applies one issue and saves its receipt.
2. Repeating the same queued transaction replays its durable result without another issue movement.
3. An old expected version returns `CONFLICT`; an unknown item returns `REJECTED`.
4. Final stock ledger remains exactly reconciled with one effective issue and records APPLIED/REPLAYED/CONFLICT/REJECTED attempts.
5. A label issue replays by key, the scanned canonical barcode resolves to the same unit ID, and a `PACKED_INTO` genealogy event is traversable from that identity.
6. A material master SKU label resolves back to the same inventory item and has its own label history without creating fake traceability stock.
7. Three repeated reads of one EPC count as one tag with two suppressed reads; a repeated session request replays, and an unknown EPC produces an explicit variance without changing stock.

Migration `161_wms_mobile_offline_rfid_label_contract.sql` is added to the ordered PostgreSQL migration manifest. Run API lint/build and the full API PostgreSQL CI gate before merge.
