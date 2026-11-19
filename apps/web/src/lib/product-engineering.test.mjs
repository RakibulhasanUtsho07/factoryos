import test from "node:test";
import assert from "node:assert/strict";
import {
  filterEngineeringProducts,
  formatEngineeringQuantity,
  summarizeEngineeringRevision,
  summarizeProductPortfolio,
} from "./product-engineering.mjs";

test("formats product engineering quantities with bounded precision", () => {
  assert.equal(formatEngineeringQuantity("2.34567", "KG"), "2.3457 KG");
  assert.equal(formatEngineeringQuantity("not-a-number"), "0");
});

test("summarizes active portfolio and version state counts", () => {
  assert.deepEqual(summarizeProductPortfolio(
    [{ status: "ACTIVE" }, { status: "DISABLED" }],
    [{ state: "DRAFT" }, { state: "APPROVED" }, { state: "DRAFT" }],
  ), { products: 2, active: 1, draftVersions: 2, approvedVersions: 1, retiredVersions: 0 });
});

test("summarizes BOM, alternate authorization and routing quality gates", () => {
  assert.deepEqual(summarizeEngineeringRevision({
    bom_lines: [{ quantity_per: "2.5" }, { quantity_per: "1.25" }],
    alternates: [{ status: "DRAFT" }, { status: "APPROVED" }],
    routing_steps: [{ is_quality_gate: true }, { is_quality_gate: false }],
  }), {
    bomLines: 2, bomQuantity: 3.75, alternates: 2, draftAlternates: 1,
    approvedAlternates: 1, routingSteps: 2, qualityGates: 1,
  });
});

test("filters product master records by code, name, style, size and type", () => {
  const products = [
    { product_code: "TEE-001", product_name: "Basic Tee", style_code: "TEE", product_type: "STANDARD" },
    { product_code: "JKT-002", product_name: "Light Jacket", style_code: "OUTER", product_type: "KIT" },
  ];
  assert.equal(filterEngineeringProducts(products, "jacket")[0].product_code, "JKT-002");
  assert.equal(filterEngineeringProducts(products, "tee").length, 1);
  assert.equal(filterEngineeringProducts(products, "none").length, 0);
});
