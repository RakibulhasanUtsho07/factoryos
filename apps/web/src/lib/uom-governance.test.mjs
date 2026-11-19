import test from "node:test";
import assert from "node:assert/strict";
import {
  filterUomConversions,
  filterUomUnits,
  formatUomFactor,
  summarizeUomGovernance,
} from "./uom-governance.mjs";

test("formats rational conversion factors without floating point coercion", () => {
  assert.equal(formatUomFactor("1000", "1"), "1000 / 1");
  assert.equal(formatUomFactor(undefined, "4"), "— / 4");
});

test("summarizes unit dimensions and conversion lifecycle states", () => {
  assert.deepEqual(summarizeUomGovernance(
    [
      { unit_code: "KG", dimension_code: "MASS" },
      { unit_code: "G", dimension_code: "MASS" },
      { unit_code: "M", dimension_code: "LENGTH" },
    ],
    [
      { status: "PENDING_APPROVAL" },
      { status: "APPROVED" },
      { status: "REJECTED" },
      { status: "RETIRED" },
      { status: "APPROVED" },
    ],
  ), { units: 3, dimensions: 2, conversions: 5, pending: 1, approved: 2, rejected: 1, retired: 1 });
});

test("filters units by searchable code, name and dimension", () => {
  const units = [
    { unit_code: "KG", name: "Kilogram", dimension_code: "MASS" },
    { unit_code: "M", name: "Metre", dimension_code: "LENGTH" },
  ];
  assert.equal(filterUomUnits(units, "kilo")[0].unit_code, "KG");
  assert.equal(filterUomUnits(units, "", "LENGTH").length, 1);
  assert.equal(filterUomUnits(units, "missing").length, 0);
});

test("filters conversion rules by endpoint, factor, and governance status", () => {
  const rules = [
    { from_unit_code: "KG", to_unit_code: "G", factor_numerator: "1000", factor_denominator: "1", status: "APPROVED" },
    { from_unit_code: "M", from_unit_name: "Metre", to_unit_code: "CM", to_unit_name: "Centimetre", factor_numerator: "100", factor_denominator: "1", status: "PENDING_APPROVAL" },
  ];
  assert.equal(filterUomConversions(rules, "centi")[0].from_unit_code, "M");
  assert.equal(filterUomConversions(rules, "", "APPROVED").length, 1);
  assert.equal(filterUomConversions(rules, "1000").length, 1);
});
