import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoodsReceiptPayload,
  buildProcurementListQuery,
  buildPurchaseOrderPayload,
  buildPurchaseOrderTransitionPayload,
  buildPurchaseOrderUpdatePayload,
  buildSupplierPayload,
  buildSupplierPerformanceQuery,
  buildSupplierStatusPayload,
  buildSupplierUpdatePayload,
  filterProcurementRows,
  normalizeProcurementRows,
  summarizeProcurement,
} from "./procurement-workbench.mjs";

const SUPPLIER = "a3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";
const LINE = "b3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";

test("normalizes procurement API page envelopes and rejects unknown list kinds", () => {
  const rows = [{ id: "one" }];
  assert.deepEqual(normalizeProcurementRows({ items: rows }), rows);
  assert.deepEqual(normalizeProcurementRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeProcurementRows({ purchase_orders: rows }, "purchase_orders"), rows);
  assert.deepEqual(normalizeProcurementRows(null), []);
  assert.throws(() => buildProcurementListQuery({}, "invoices"), /Unsupported/);
});

test("builds bounded supplier list filters and validates statuses", () => {
  const params = new URLSearchParams(buildProcurementListQuery({
    page: 2, limit: 25, search: "fabric", status: "active",
  }, "suppliers").slice(1));
  assert.equal(params.get("page"), "2");
  assert.equal(params.get("limit"), "25");
  assert.equal(params.get("search"), "fabric");
  assert.equal(params.get("status"), "ACTIVE");
  assert.throws(() => buildProcurementListQuery({ status: "PENDING" }, "suppliers"), /status filter/);
  assert.throws(() => buildProcurementListQuery({ limit: 101 }, "purchase-orders"), /limit/);
});

test("builds supplier registration and optimistic profile/status payloads without caller scope", () => {
  const supplier = buildSupplierPayload({
    code: "sup-001", name: "Cotton Mills", country_code: "bd", email: "ap@example.com",
    payment_terms_days: "30", currency: "bdt",
  });
  assert.equal(supplier.code, "SUP-001");
  assert.equal(supplier.country_code, "BD");
  assert.equal(Object.hasOwn(supplier, "tenant_id"), false);
  assert.equal(buildSupplierUpdatePayload({ name: "Cotton Mills", currency: "BDT" }, "3").expected_version, 3);
  assert.deepEqual(buildSupplierStatusPayload("disabled", 4), { target_status: "DISABLED", expected_version: 4 });
  assert.throws(() => buildSupplierPayload({ code: "bad code", name: "X" }), /code may contain/);
  assert.throws(() => buildSupplierPayload({ code: "SUP-1", name: "X", country_code: "BGD" }), /two-letter/);
  assert.throws(() => buildSupplierStatusPayload("DELETED", 1), /ACTIVE or DISABLED/);
});

test("builds purchase orders with unique line numbers, exact UOM and bounded quantities", () => {
  const po = buildPurchaseOrderPayload({
    supplier_id: SUPPLIER, po_number: "po-100", order_date: "2026-11-01",
    expected_delivery_date: "2026-11-15", currency: "bdt", payment_terms_days: 30,
    lines: [{ description: "Cotton yarn", quantity: "120.5", unit: "kg", unit_price: "85.25", inventory_item_id: LINE }],
  });
  assert.equal(po.po_number, "PO-100");
  assert.equal(po.lines[0].quantity, 120.5);
  assert.equal(po.lines[0].unit, "KG");
  assert.equal(po.lines[0].inventory_item_id, LINE);
  assert.equal(Object.hasOwn(po, "factory_id"), false);
  assert.throws(() => buildPurchaseOrderPayload({
    supplier_id: SUPPLIER, po_number: "PO-2", expected_delivery_date: "2026-11-01", order_date: "2026-11-02",
    lines: [{ description: "x", quantity: 1, unit: "kg", unit_price: 1 }],
  }), /cannot be before/);
  assert.throws(() => buildPurchaseOrderPayload({
    supplier_id: SUPPLIER, po_number: "PO-2",
    lines: [{ description: "x", quantity: "0", unit: "kg", unit_price: 1 }],
  }), /greater than zero/);
  assert.throws(() => buildPurchaseOrderPayload({
    supplier_id: SUPPLIER, po_number: "PO-2",
    lines: [
      { line_number: 1, description: "x", quantity: 1, unit: "kg", unit_price: 1 },
      { line_number: 1, description: "y", quantity: 2, unit: "kg", unit_price: 1 },
    ],
  }), /unique/);
});

test("builds draft update and protects versioned transition rules", () => {
  const input = {
    supplier_id: SUPPLIER, po_number: "PO-1", order_date: "2026-11-01",
    expected_delivery_date: "2026-11-02", currency: "BDT",
    lines: [{ description: "Fabric", quantity: 5, unit: "M", unit_price: 10 }],
  };
  const update = buildPurchaseOrderUpdatePayload(input, 7);
  assert.equal(update.expected_version, 7);
  assert.equal(Object.hasOwn(update, "supplier_id"), false);
  assert.equal(Object.hasOwn(update, "po_number"), false);
  assert.deepEqual(buildPurchaseOrderTransitionPayload("SUBMITTED", 7), { expected_version: 7 });
  assert.deepEqual(buildPurchaseOrderTransitionPayload("CANCELLED", 7, "Duplicate"), {
    expected_version: 7, reason: "Duplicate",
  });
  assert.throws(() => buildPurchaseOrderTransitionPayload("REJECTED", 1), /reason is required/);
  assert.throws(() => buildPurchaseOrderTransitionPayload("APPROVED", 0), /expected_version/);
});

test("builds a GRN only from explicit PO line evidence and requires rejection rationale", () => {
  const payload = buildGoodsReceiptPayload({
    supplier_delivery_reference: "DN-55",
    lines: [
      { purchase_order_line_id: LINE, received_quantity: "10.5", rejected_quantity: "1.5", rejection_reason: "Damaged packaging" },
      { purchase_order_line_id: "c3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9", received_quantity: "0", rejected_quantity: "0" },
    ],
  });
  assert.equal(payload.lines.length, 1);
  assert.equal(payload.lines[0].received_quantity, 10.5);
  assert.equal(payload.lines[0].rejected_quantity, 1.5);
  assert.equal(Object.hasOwn(payload, "factory_id"), false);
  assert.throws(() => buildGoodsReceiptPayload({
    lines: [{ purchase_order_line_id: LINE, received_quantity: 2, rejected_quantity: 1 }],
  }), /rejection reason/);
  assert.throws(() => buildGoodsReceiptPayload({
    lines: [{ purchase_order_line_id: LINE, received_quantity: 1, rejected_quantity: 2 }],
  }), /cannot exceed/);
  assert.throws(() => buildGoodsReceiptPayload({ lines: [] }), /at least one/);
});

test("validates supplier evidence windows against the 366-day server limit", () => {
  const query = new URLSearchParams(buildSupplierPerformanceQuery({
    from: "2026-01-01", to: "2026-12-31", as_of: "2026-12-31",
  }).slice(1));
  assert.equal(query.get("from"), "2026-01-01");
  assert.equal(query.get("as_of"), "2026-12-31");
  assert.throws(() => buildSupplierPerformanceQuery({ from: "2026-02-30", to: "2026-03-01" }), /real calendar date/);
  assert.throws(() => buildSupplierPerformanceQuery({ from: "2026-03-02", to: "2026-03-01" }), /on or after/);
  assert.throws(() => buildSupplierPerformanceQuery({ from: "2025-01-01", to: "2026-01-02" }), /366/);
});

test("filters operational lists and summarizes only loaded supplier and PO values", () => {
  const suppliers = [
    { code: "SUP-1", name: "Cotton", status: "ACTIVE" },
    { code: "SUP-2", name: "Dye House", status: "DISABLED" },
  ];
  const orders = [
    { po_number: "PO-1", supplier_name: "Cotton", status: "APPROVED", currency: "BDT", total_amount: "100" },
    { po_number: "PO-2", supplier_name: "Dye House", status: "DRAFT", currency: "BDT", total_amount: "50" },
    { po_number: "PO-3", supplier_name: "Cotton", status: "CANCELLED", currency: "USD", total_amount: "500" },
  ];
  assert.deepEqual(filterProcurementRows(suppliers, { search: "dye" }, "suppliers").map((row) => row.code), ["SUP-2"]);
  assert.deepEqual(filterProcurementRows(orders, { status: "DRAFT" }, "purchase-orders").map((row) => row.po_number), ["PO-2"]);
  assert.deepEqual(summarizeProcurement(suppliers, orders), {
    activeSuppliers: 1, supplierCount: 2, purchaseOrderCount: 3,
    draftCount: 1, submittedCount: 0, approvedCount: 1,
    openCurrencyCount: 1, openValueCurrency: "BDT", totalOpenValue: 150,
    openValueByCurrency: { BDT: 150 },
  });
});
