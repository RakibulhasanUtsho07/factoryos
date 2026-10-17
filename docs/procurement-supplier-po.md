# Supplier and Purchase Order Lifecycle (WP02)

This backend slice implements the initial procurement lifecycle described by FactoryOS AI SRS v2.1 and the Core Domain Kernel work package in the Engineering Implementation Blueprint.

## Supplier API

- `POST /api/v1/suppliers` — create a tenant-scoped supplier; requires `suppliers.write`.
- `GET /api/v1/suppliers?page=1&limit=20&status=ACTIVE&search=` — search/list suppliers; requires `suppliers.read`.
- `PATCH /api/v1/suppliers/:supplierId` — edit supplier profile/contact/payment terms using required `expected_version`; requires `suppliers.write`.
- `POST /api/v1/suppliers/:supplierId/status` — enable/disable a supplier with required `expected_version`; requires `suppliers.write`.

Supplier codes are normalized to uppercase and unique per tenant. Profile updates use optimistic version checks, emit transactional outbox events and correlated audit entries, while supplier creation emits an outbox event and audit entry atomically. Supplier codes and creator provenance are immutable. Suppliers are disabled rather than deleted. A supplier with draft, submitted, or approved purchase orders cannot be disabled.

## Purchase Order API

- `POST /api/v1/purchase-orders` — create a draft PO with one or more lines; requires `purchase_orders.write`. The caller's factory scope is server-derived. Supports `Idempotency-Key`.
- `GET /api/v1/purchase-orders?page=1&limit=20&status=DRAFT&search=` — list within the authenticated tenant/factory scope; requires `purchase_orders.read`.
- `PATCH /api/v1/purchase-orders/:purchaseOrderId` — edit a draft's commercial terms and/or replace its lines atomically; requires `purchase_orders.write` and a matching `expected_version`.
- `GET /api/v1/purchase-orders/:purchaseOrderId` — header, lines, deterministic total, and append-only status history; requires `purchase_orders.read`.
- `POST /api/v1/purchase-orders/:purchaseOrderId/submit` — submit a draft; requires `purchase_orders.write`.
- `POST /api/v1/purchase-orders/:purchaseOrderId/approve` and `/reject` — decision by a separately authorized approver; requires `purchase_orders.approve`.
- `POST /api/v1/purchase-orders/:purchaseOrderId/cancel` — cancel a draft or submitted PO with a reason; requires `purchase_orders.write`.

The lifecycle is `DRAFT -> SUBMITTED -> APPROVED|REJECTED`; `DRAFT` and `SUBMITTED` may also be cancelled. Approved, rejected, and cancelled POs are terminal in this slice; receipt/partial receipt is deferred to the next procurement/WMS slice. Rejection and cancellation require a reason. The creator cannot approve their own PO. All purchase-order status transitions and draft updates require `expected_version` and return a conflict when the submitted version is stale. Supplier status transitions also require `expected_version`. Draft edits replace lines and update the header in a single transaction, append a same-status version history entry with changed-field names, and publish an outbox event. A stale version receives a conflict response.

All PO lines use a generated numeric line amount; aggregate totals are calculated by PostgreSQL rather than by a model or floating-point total in application code. Lines and commercial terms cannot be changed after submission. Status history and outbox events are written in the same transaction as the state change, alongside tenant/factory-safe foreign keys and forced row-level security.

## CI evidence

`services/api/test/purchase-order-lifecycle.sql` asserts migration objects, RLS, permissions, transition guards, line immutability, self-approval protection, and append-only history. `purchase-order-lifecycle.spec.ts` covers the transition map.

## Boundary

This is the initial procurement slice, not the full purchasing feature set. Goods receipt/GRN, partial receipts, supplier pricing/scorecards, tax and commercial approval thresholds, and lot/serial genealogy are tracked as separate follow-up work.
