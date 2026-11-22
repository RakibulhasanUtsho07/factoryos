import test from "node:test";
import assert from "node:assert/strict";
import {
  allocationPolicyLabel,
  asInventoryRows,
  buildAllocationPolicyPayload,
  buildReorderPolicyPayload,
  filterReplenishmentRows,
  findAllocationPolicy,
  getReorderEditorDefaults,
  replenishmentMetrics,
  resolveAllocationPolicy,
  summarizeReplenishment,
} from "./inventory-replenishment.mjs";

test("normalizes array and paginated API payloads", () => {
  assert.deepEqual(asInventoryRows([{ id: "a" }]), [{ id: "a" }]);
  assert.deepEqual(asInventoryRows({ items: [{ id: "b" }] }), [{ id: "b" }]);
  assert.deepEqual(asInventoryRows({ policies: [{ id: "c" }] }, "policies"), [{ id: "c" }]);
  assert.deepEqual(asInventoryRows(null), []);
});

test("summarizes shortage coverage, recommendations and allocation controls", () => {
  const result = summarizeReplenishment(
    [{ uncovered_shortage_quantity: "4" }, { uncovered_shortage_quantity: "0" }],
    [{ recommendation_status: "SUPPLIER_REQUIRED" }, { recommendation_status: "REVIEW_REQUIRED" }],
    [{ policy_scope: "FACTORY", require_traceability: true }, { policy_scope: "MATERIAL", require_traceability: true }],
  );
  assert.deepEqual(result, {
    shortageItems: 2, uncoveredItems: 1, recommendations: 2,
    supplierRequired: 1, reviewRequired: 1, allocationRules: 1, traceabilityRequired: 2,
  });
});

test("filters replenishment signals by SKU, supplier and recommendation status", () => {
  const rows = [
    { sku: "RM-01", item_name: "Cotton", preferred_supplier_name: "Alpha", recommendation_status: "SUPPLIER_REQUIRED" },
    { sku: "RM-02", item_name: "Polyester", preferred_supplier_name: "Beta", recommendation_status: "REVIEW_REQUIRED" },
  ];
  assert.equal(filterReplenishmentRows(rows, "cotton").length, 1);
  assert.equal(filterReplenishmentRows(rows, "beta", "REVIEW_REQUIRED").length, 1);
  assert.equal(filterReplenishmentRows(rows, "", "SUPPLIER_REQUIRED").length, 1);
});

test("calculates physical, incoming and uncovered stock separately", () => {
  const result = replenishmentMetrics({
    quantity_on_hand: "8", quantity_reserved: "2", incoming_quantity: "3",
    minimum_quantity: "12", maximum_quantity: "30",
  });
  assert.equal(result.available, 6);
  assert.equal(result.inventoryPosition, 9);
  assert.equal(result.physicalShortage, 6);
  assert.equal(result.uncoveredShortage, 3);
  assert.equal(result.recommendedOrder, 21);
});

test("reorder policy requires valid min/max thresholds and four-decimal precision", () => {
  const result = buildReorderPolicyPayload({
    minimum_quantity: "10.25", maximum_quantity: "30", lead_time_days: "14",
    preferred_supplier_id: "supplier-1", enabled: true,
  });
  assert.deepEqual(result, {
    minimum_quantity: 10.25, maximum_quantity: 30, lead_time_days: 14,
    preferred_supplier_id: "supplier-1", enabled: true,
  });
  assert.throws(() => buildReorderPolicyPayload({
    minimum_quantity: "30", maximum_quantity: "30", lead_time_days: "14", enabled: true,
  }), /greater than/);
  assert.throws(() => buildReorderPolicyPayload({
    minimum_quantity: "1.00001", maximum_quantity: "2", lead_time_days: "14", enabled: true,
  }), /4 decimal/);
  assert.throws(() => buildReorderPolicyPayload({
    minimum_quantity: "1", maximum_quantity: "2", lead_time_days: "3651", enabled: true,
  }), /3650/);
});

test("allocation policy writes carry optimistic expected-version and traceability intent", () => {
  assert.deepEqual(buildAllocationPolicyPayload({
    allocation_policy: "fefo", require_traceability: true, expected_version: 3,
  }), { allocation_policy: "FEFO", require_traceability: true, expected_version: 3 });
  assert.throws(() => buildAllocationPolicyPayload({
    allocation_policy: "LAST_IN", expected_version: 0,
  }), /FIFO/);
  assert.throws(() => buildAllocationPolicyPayload({
    allocation_policy: "FIFO", expected_version: -1,
  }), /version/);
});

test("material policy overrides sector, which overrides factory policy", () => {
  const policies = [
    { policy_scope: "FACTORY", allocation_policy: "FIFO", require_traceability: false, version: 1 },
    { policy_scope: "SECTOR", sector_code: "RAW", allocation_policy: "FEFO", require_traceability: true, version: 2 },
    { policy_scope: "MATERIAL", inventory_item_id: "item-1", allocation_policy: "SERIAL", require_traceability: true, version: 4 },
  ];
  assert.equal(resolveAllocationPolicy({ id: "item-1", sector_code: "RAW" }, policies).allocation_policy, "SERIAL");
  assert.equal(resolveAllocationPolicy({ id: "item-2", sector_code: "RAW" }, policies).allocation_policy, "FEFO");
  assert.equal(resolveAllocationPolicy({ id: "item-3", sector_code: "FINISHED" }, policies).allocation_policy, "FIFO");
});

test("unconfigured allocation scope stays explicitly inherited", () => {
  const policy = resolveAllocationPolicy({ id: "item-1", sector_code: null }, []);
  assert.equal(policy.source, "SYSTEM_DEFAULT");
  assert.equal(policy.allocation_policy, null);
  assert.equal(policy.inherited, true);
  assert.equal(allocationPolicyLabel(policy.allocation_policy), "System inherited");
});

test("reorder editor defaults preserve existing signal and allow a blank policy", () => {
  assert.equal(getReorderEditorDefaults({ id: "item-1" }).lead_time_days, "7");
  assert.deepEqual(getReorderEditorDefaults({ id: "item-1" }, {
    minimum_quantity: "5", maximum_quantity: "25", lead_time_days: 10,
    preferred_supplier_id: "supplier-1", enabled: false,
  }), {
    minimum_quantity: "5", maximum_quantity: "25", lead_time_days: "10",
    preferred_supplier_id: "supplier-1", enabled: false, item_id: "item-1",
  });
});

test("finds allocation policy rows by material or case-insensitive sector", () => {
  const rows = [{ policy_scope: "SECTOR", sector_code: "RAW", allocation_policy: "FEFO" }];
  assert.equal(findAllocationPolicy(rows, "SECTOR", "raw")?.allocation_policy, "FEFO");
  assert.equal(findAllocationPolicy(rows, "MATERIAL", "item-1"), null);
});
