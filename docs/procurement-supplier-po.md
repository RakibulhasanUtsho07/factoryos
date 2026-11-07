# Supplier, Purchase Order and Supplier Performance Evidence (WP02)

This backend slice implements the supplier and purchase-order lifecycle described by FactoryOS AI SRS v2.1 and the Core Domain Kernel work package in the Engineering Implementation Blueprint. It also exposes read-only supplier delivery and GRN-linked quality evidence. It does not assign a supplier score or rank.

## Supplier API

- `POST /api/v1/suppliers` — create a tenant-scoped supplier; requires `suppliers.write`.
- `GET /api/v1/suppliers?page=1&limit=20&status=ACTIVE&search=` — search/list suppliers; requires `suppliers.read`.
- `GET /api/v1/suppliers/:supplierId/performance?from=2026-09-01&to=2026-09-30&as_of=2026-10-15` — read supplier performance evidence for the authenticated factory; requires `suppliers.performance.read`.
- `PATCH /api/v1/suppliers/:supplierId` — edit supplier profile/contact/payment terms using required `expected_version`; requires `suppliers.write`.
- `POST /api/v1/suppliers/:supplierId/status` — enable/disable a supplier with required `expected_version`; requires `suppliers.write`.

Supplier codes are normalized to uppercase and unique per tenant. Profile updates use optimistic version checks, emit transactional outbox events and correlated audit entries, while supplier creation emits an outbox event and audit entry atomically. Supplier codes and creator provenance are immutable. Suppliers are disabled rather than deleted. A supplier with draft, submitted, or approved purchase orders cannot be disabled.

## Supplier performance evidence

The report is read-only and requires authenticated tenant context plus server-derived factory scope. The API accepts strict ISO calendar dates in `YYYY-MM-DD` form. `from` and `to` are inclusive; the range may span no more than 366 calendar days. Optional `as_of` defaults to the current UTC date and includes evidence through that UTC day.

The database report reads only approved purchase orders and posted goods-receipt lines. A PO line is complete at the first GRN `posted_at` when cumulative physical `received_quantity` reaches the ordered quantity. Rejected units count as physically delivered for delivery-completion timing, but are reported separately from accepted units. The report classifies completed lines as `ON_TIME` or `LATE` by comparing the UTC completion date with the expected delivery date; uncompleted lines are `OVERDUE_OPEN` or `OPEN_NOT_DUE`. Undated approved POs are counted separately and excluded from due-line metrics.

Ordered, received, accepted, rejected and outstanding quantities are grouped by normalized PO-line unit. Different units are never added together. The report includes up to 50 late/overdue delivery exceptions and up to 50 GRN-linked quality evidence events, with explicit truncation flags.

Quality evidence is sourced only from existing `quality_supplier_quality_events` rows that are linked to the same posted GRN line and PO line. Migration 164 enforces source provenance and append-only behavior for these events. The report's stated coverage is therefore GRN-linked quality defect events only; it is not a census of all supplier inspections or all quality outcomes.

The report deliberately returns `supplier_score = NOT_CALCULATED`, `supplier_ranking = NOT_CALCULATED`, and `automatic_supplier_recommendation = NOT_PROVIDED`. No weighted score, supplier ranking, alternative-supplier recommendation, price comparison, or external AP-provider acceptance is inferred by this endpoint. Those outcomes require separately approved business thresholds and evidence.

The database function is `STABLE SECURITY INVOKER`, derives the tenant from the verified database context, and is not executable by `PUBLIC`. Permission `suppliers.performance.read` is assigned to `ORG_ADMIN`, `FACTORY_MANAGER`, and `QUALITY_MANAGER`. After migration 238 and the built-in application-role seeds have been applied, and the `factoryos_app` PostgreSQL runtime role exists, the database owner/provisioning principal must execute:

```sh
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/security/grant-supplier-performance-report-runtime-access.sql
```

Do not run this grant using the application role. The script fails closed when the runtime role, report function, permission row, or any of the three required application roles is missing. It grants the application permission mapping as well as the PostgreSQL function EXECUTE privilege. API PostgreSQL CI runs this provisioning step after the role and schema are created, then asserts the EXECUTE grant, absence of PUBLIC EXECUTE, report volatility/security mode, role permissions, forced RLS, indexes and migration marker.

## Purchase Order API

- `POST /api/v1/purchase-orders` — create a draft PO with one or more lines; requires `purchase_orders.write`. The caller's factory scope is server-derived. Supports `Idempotency-Key`.
- `GET /api/v1/purchase-orders?page=1&limit=20&status=DRAFT&search=` — list within the authenticated tenant/factory scope; requires `purchase_orders.read`.
- `PATCH /api/v1/purchase-orders/:purchaseOrderId` — edit a draft's commercial terms and/or replace its lines atomically; requires `purchase_orders.write` and a matching `expected_version`.
- `GET /api/v1/purchase-orders/:purchaseOrderId` — header, lines, deterministic total, and append-only status history; requires `purchase_orders.read`.
- `POST /api/v1/purchase-orders/:purchaseOrderId/submit` — submit a draft; requires `purchase_orders.write`.
- `POST /api/v1/purchase-orders/:purchaseOrderId/approve` and `/reject` — decision by a separately authorized approver; requires `purchase_orders.approve`.
- `POST /api/v1/purchase-orders/:purchaseOrderId/cancel` — cancel a draft or submitted PO with a reason; requires `purchase_orders.write`.

The lifecycle is `DRAFT -> SUBMITTED -> APPROVED|REJECTED`; `DRAFT` and `SUBMITTED` may also be cancelled. Rejection and cancellation require a reason. The creator cannot approve their own PO. All purchase-order status transitions and draft updates require `expected_version` and return a conflict when the submitted version is stale. Supplier status transitions also require `expected_version`. Draft edits replace lines and update the header in a single transaction, append a same-status version history entry with changed-field names, and publish an outbox event. A stale version receives a conflict response.

All PO lines use a generated numeric line amount; aggregate totals are calculated by PostgreSQL rather than by a model or floating-point total in application code. Lines and commercial terms cannot be changed after submission. Status history and outbox events are written in the same transaction as the state change, alongside tenant/factory-safe foreign keys and forced row-level security. Goods receipt/GRN, including partial receipts and immutable posted receipt evidence, is implemented in the procurement/WMS slice.

## CI evidence

- `services/api/test/purchase-order-lifecycle.sql` asserts migration objects, RLS, permissions, transition guards, line immutability, self-approval protection, and append-only history.
- `services/api/test/goods-receipt.sql` verifies GRN posting, partial receipts, accepted/rejected quantity accounting, immutable supplier-quality event provenance, and the supplier performance report's late-delivery, quantity reconciliation, GRN-linked quality evidence, no-score boundary, and factory isolation.
- `services/api/test/supplier-performance-evidence.sql` asserts the report function's stable/invoker security mode, runtime EXECUTE grant, PUBLIC denial, permission/role grants, RLS, indexes, migration marker, deterministic empty results and invalid-range rejection.
- `services/api/src/procurement/supplier-performance.service.spec.ts` covers read-only tenant context, UTC default `as_of`, date validation and missing-supplier behavior.

## Acceptance boundary

This implementation is technical, read-only evidence; it does not itself constitute independent Finance/Product owner acceptance, external AP-provider certification, or completion of any SRS requirement whose acceptance evidence remains partial. Supplier pricing, weighted scorecards/rankings, tax/commercial approval thresholds, and external provider integration remain separate follow-up work.
