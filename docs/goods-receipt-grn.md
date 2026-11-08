# Goods Receipt / GRN (WP02 procurement follow-up)

## API

All endpoints require verified user/tenant context, factory scope, and the stated IAM permission.

- `POST /api/v1/purchase-orders/:purchaseOrderId/goods-receipts` posts a GRN against an `APPROVED` PO. Requires `goods_receipts.write` and an `Idempotency-Key` header.
- `GET /api/v1/purchase-orders/:purchaseOrderId/goods-receipts?limit=50` lists posted GRNs for one PO. Requires `goods_receipts.read`.
- `GET /api/v1/goods-receipts/:receiptId` returns a posted GRN and its PO-linked lines. Requires `goods_receipts.read`.

Example request:

```json
{
  "supplier_delivery_reference": "DELIVERY-4821",
  "location_id": "optional-active-warehouse-staging-or-bin-uuid",
  "notes": "First partial delivery",
  "lines": [
    {
      "purchase_order_line_id": "purchase-order-line-uuid",
      "received_quantity": 10,
      "rejected_quantity": 2,
      "rejection_reason": "Two units damaged"
    }
  ]
}
```

## Posting rules

- A receipt can only be created against an approved PO and its own PO lines, in the authenticated tenant/factory scope. The resolved receiving location (explicit warehouse/staging/bin or the factory default bucket) is persisted on the immutable GRN header and returned by read/list APIs.
- Multiple GRNs can be posted against the same PO line. The sum of physically received quantities (accepted + rejected) cannot exceed the ordered quantity. Rejected quantities count toward the ordered amount.
- `accepted_quantity` is a database-generated value: `received_quantity - rejected_quantity`. Any nonzero rejected quantity requires a reason.
- A line with accepted quantity must map to an active inventory item in the same factory, with the same unit as the PO line. Rejected goods never increase on-hand stock.
- Each accepted line increments the aggregate stock balance, synchronizes its chosen/default inventory location, and inserts an immutable `RECEIPT` movement referencing the GRN. GRN, lines, stock, movements, audit entry and outbox event commit or roll back together.
- `Idempotency-Key` is scoped to tenant/factory. Replaying the same request returns the existing posted receipt; reusing the key with a different request returns a conflict.
- GRN headers and lines are immutable after posting. Database triggers reject over-receipt, cross-PO line references, invalid receipt state, missing or mismatched stock movements, movements added after a GRN is posted, and missing transactional audit/outbox evidence. Each GRN stock movement must match the receipt's accepted PO-line quantity, actor, receiving location, and resulting aggregate stock balance. RLS is enabled and forced on both GRN tables.

Migrations: `072_goods_receipt_grn.sql` and `073_grn_stock_posting_guard.sql`. Regression: `services/api/test/goods-receipt.sql`, `goods-receipt.service.spec.ts`, and the GRN-backed FEFO PostgreSQL scenario in `services/api/src/inventory/inventory.reservation.integration.spec.ts`. The latter creates and separately approves a real PO, posts two partial GRNs against the same PO line through `GoodsReceiptService`, links each MATERIAL LOT to its accepted GRN line, and deliberately makes the first-posted receipt have a later `received_at` and later-created LOT identity than the second-posted receipt. With equal expiry dates, competing reservations must still allocate the first-posted GRN LOT first, proving `posted_at` precedence. Persisted POSTED receipt provenance and per-lot, BIN and aggregate balances reconcile; external provider/site acceptance remains separate.

This slice posts received material into inventory. External AP supplier-invoice lines now have a separate read-only three-way match against the exact POSTED GRN line, accepted quantity, approved PO unit price and tenant-scoped PO supplier master; it does not create or pay invoices. Valuation/tax accrual, returns to supplier and landed-cost capitalization remain separate follow-up work.
