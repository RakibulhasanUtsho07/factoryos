import test from "node:test";
import assert from "node:assert/strict";
import {
  asCommercialRows,
  buildExchangeRatePayload,
  buildPricingRulePayload,
  buildQuotationConversionPayload,
  buildQuotationPayload,
  buildQuotationRevisionPayload,
  buildQuotationTransitionPayload,
  calculateQuotationPreview,
  filterQuotations,
  quotationStatusLabel,
  resolveCurrentPricingRule,
  resolveExchangeRate,
  summarizeQuotations,
} from "./commercial-quotation-workbench.mjs";

const FACTORY = "11111111-1111-4111-8111-111111111111";
const BASE_LINES = [
  { line_number: 1, product_code: "FG-01", product_name: "Finished good", quantity: "2.5", unit: "PCS", unit_price: "100.0000", discount_percent: "5", notes: "" },
  { line_number: 2, product_code: "FG-02", product_name: "Accessory", quantity: "1", unit: "PCS", unit_price: "50", tax_percent: "10" },
];
const QUOTE = {
  id: "22222222-2222-4222-8222-222222222222",
  quote_number: "Q-001", customer_name: "Acme", customer_reference: "ACME-01",
  status: "DRAFT", current_revision: 1, version: "4",
  currency: "BDT", base_currency: "BDT", lines: BASE_LINES,
};

test("normalizes quotation, rule, FX and history response envelopes", () => {
  const rows = [{ id: "one" }];
  assert.deepEqual(asCommercialRows(rows), rows);
  assert.deepEqual(asCommercialRows({ items: rows }), rows);
  assert.deepEqual(asCommercialRows({ lines: rows }, "lines"), rows);
  assert.deepEqual(asCommercialRows({ history: rows }, "history"), rows);
  assert.deepEqual(asCommercialRows(null), []);
});

test("calculates line subtotal, discount, tax and base amount with integer precision", () => {
  const result = calculateQuotationPreview(BASE_LINES, "7.5", "10", "1.25");
  assert.deepEqual(result.lines.map(line => line.line_total), ["255.3125", "55.0000"]);
  assert.deepEqual(result.totals, {
    subtotal: "300.0000", discount_total: "12.5000", tax_total: "22.8125",
    total: "310.3125", total_base: "387.8906",
  });
  assert.equal(result.max_line_discount_percent, "5.00");
});

test("rejects empty lines, duplicate numbering, over precision and invalid amounts", () => {
  assert.throws(() => calculateQuotationPreview([], 0, 0));
  assert.throws(() => calculateQuotationPreview([
    ...BASE_LINES, { ...BASE_LINES[0], line_number: 1 },
  ], 0, 10));
  assert.throws(() => calculateQuotationPreview([
    { ...BASE_LINES[0], quantity: "1.00001" },
  ], 0, 10));
  assert.throws(() => calculateQuotationPreview([
    { ...BASE_LINES[0], unit_price: "-1" },
  ], 0, 10));
  assert.throws(() => calculateQuotationPreview([
    { ...BASE_LINES[0], discount_percent: "20" },
  ], 0, 10));
});

test("resolves customer-specific pricing rules before factory defaults", () => {
  const rules = [
    { rule_code: "DEFAULT", customer_reference: null, is_current: true },
    { rule_code: "ACME", customer_reference: "ACME-01", is_current: true },
    { rule_code: "OLD", customer_reference: "ACME-01", is_current: false },
  ];
  assert.equal(resolveCurrentPricingRule(rules, "acme-01").rule_code, "ACME");
  assert.equal(resolveCurrentPricingRule(rules, "OTHER").rule_code, "DEFAULT");
  assert.equal(resolveCurrentPricingRule(rules, "ACME-01", "DEFAULT").rule_code, "DEFAULT");
  assert.equal(resolveCurrentPricingRule(rules, "ACME-01", "MISSING"), null);
});

test("selects the latest effective FX rate and returns identity conversion", () => {
  const rates = [
    { currency: "USD", base_currency: "BDT", rate_to_base: "119", effective_on: "2026-10-01", source: "BANK-A" },
    { currency: "USD", base_currency: "BDT", rate_to_base: "120", effective_on: "2026-11-01", source: "BANK-B" },
    { currency: "USD", base_currency: "BDT", rate_to_base: "121", effective_on: "2026-12-01", source: "BANK-C" },
  ];
  assert.equal(resolveExchangeRate(rates, "USD", "BDT", "2026-11-22").rate_to_base, "120");
  assert.equal(resolveExchangeRate(rates, "USD", "BDT", "2026-10-15").rate_to_base, "119");
  assert.equal(resolveExchangeRate(rates, "USD", "BDT", "2026-09-01"), null);
  assert.equal(resolveExchangeRate(rates, "BDT", "BDT", "2026-11-22").source, "IDENTITY");
});

test("builds a factory-scoped quotation payload with normalized lines and optional terms", () => {
  const payload = buildQuotationPayload({
    quote_number: " Q-100 ", customer_name: " Acme Ltd ", customer_reference: " ACME-01 ",
    currency: "usd", pricing_rule_code: "USD-ACME",
    requested_delivery_date: "2026-12-01", valid_until: "2026-11-30",
    incoterms: "FCA", payment_terms: "Net 30", notes: "Commercial scope",
    lines: BASE_LINES,
  }, FACTORY);
  assert.equal(payload.factory_id, FACTORY);
  assert.equal(payload.quote_number, "Q-100");
  assert.equal(payload.currency, "USD");
  assert.equal(payload.lines[0].unit_price, 100);
  assert.equal(payload.lines[1].tax_percent, 10);
  assert.equal(payload.lines[0].discount_percent, undefined);
  assert.equal(payload.lines[0].tax_percent, undefined);
});

test("requires an active factory and valid quote identity/customer/lines", () => {
  assert.throws(() => buildQuotationPayload({ quote_number: "Q", customer_name: "Acme", lines: BASE_LINES }, "bad"));
  assert.throws(() => buildQuotationPayload({ quote_number: " ", customer_name: "Acme", lines: BASE_LINES }, FACTORY));
  assert.throws(() => buildQuotationPayload({ quote_number: "Q", customer_name: " ", lines: BASE_LINES }, FACTORY));
  assert.throws(() => buildQuotationPayload({ quote_number: "Q", customer_name: "Acme", lines: [] }, FACTORY));
});

test("builds optimistic quotation revision payloads with mandatory reason", () => {
  const payload = buildQuotationRevisionPayload({
    expected_version: 4, reason: "Corrected quantities", currency: "BDT",
    requested_delivery_date: "2026-12-05", valid_until: "2026-12-01",
    incoterms: "FOB", payment_terms: "Net 15", notes: "Revision two", lines: BASE_LINES,
  }, QUOTE);
  assert.equal(payload.expected_version, 4);
  assert.equal(payload.reason, "Corrected quantities");
  assert.equal(payload.requested_delivery_date, "2026-12-05");
  assert.equal(payload.lines.length, 2);
  assert.throws(() => buildQuotationRevisionPayload({ reason: " ", lines: BASE_LINES }, QUOTE));
});

test("builds lifecycle and accepted-order conversion payloads from current version", () => {
  assert.deepEqual(buildQuotationTransitionPayload({ reason: "Submitted for review" }, QUOTE), {
    expected_version: 4, reason: "Submitted for review",
  });
  assert.deepEqual(buildQuotationConversionPayload({ reason: "Customer accepted", order_number: "SO-100" }, QUOTE), {
    expected_version: 4, reason: "Customer accepted", order_number: "SO-100",
  });
  assert.throws(() => buildQuotationTransitionPayload({ reason: "" }, QUOTE));
  assert.throws(() => buildQuotationConversionPayload({ reason: "Accepted", order_number: " " }, QUOTE));
});

test("builds new immutable pricing rule versions with policy limits and unique currencies", () => {
  const payload = buildPricingRulePayload({
    rule_code: "acme-usd", customer_reference: "ACME-01",
    base_currency: "bdt", allowed_currencies: "bdt, usd, USD",
    default_tax_percent: "7.5", max_discount_percent: "12.5",
    approval_required: true, approval_total_threshold: "100000",
    approval_discount_threshold_percent: "10",
    incoterms_required: true, payment_terms_required: true,
  }, FACTORY);
  assert.equal(payload.rule_code, "ACME-USD");
  assert.deepEqual(payload.allowed_currencies, ["BDT", "USD"]);
  assert.equal(payload.max_discount_percent, 12.5);
  assert.equal(payload.approval_total_threshold, 100000);
  assert.equal(payload.approval_required, true);
});

test("rejects rule currencies that omit the base currency and invalid limits", () => {
  assert.throws(() => buildPricingRulePayload({
    rule_code: "X", base_currency: "BDT", allowed_currencies: "USD",
  }, FACTORY));
  assert.throws(() => buildPricingRulePayload({
    rule_code: "X", base_currency: "BDT", allowed_currencies: "BDT", max_discount_percent: "100.01",
  }, FACTORY));
});

test("preserves explicit zero tax so it does not inherit the pricing-rule default", () => {
  const payload = buildQuotationPayload({
    quote_number: "Q-ZERO", customer_name: "Acme",
    lines: [{ line_number: 1, product_code: "FG-0", product_name: "Zero rated", quantity: "1", unit: "PCS", unit_price: "100", tax_percent: "0" }],
  }, FACTORY);
  assert.equal(payload.lines[0].tax_percent, 0);
});

test("builds sourced effective-dated FX records and validates positive rates", () => {
  assert.deepEqual(buildExchangeRatePayload({
    currency: "usd", base_currency: "bdt", rate_to_base: "120.125", effective_on: "2026-11-22", source: "Bank circular",
  }, FACTORY), {
    factory_id: FACTORY, currency: "USD", base_currency: "BDT",
    rate_to_base: 120.125, effective_on: "2026-11-22", source: "Bank circular",
  });
  assert.throws(() => buildExchangeRatePayload({
    currency: "BDT", base_currency: "bdt", rate_to_base: "1", effective_on: "2026-11-22", source: "x",
  }, FACTORY));
  assert.throws(() => buildExchangeRatePayload({
    currency: "USD", base_currency: "BDT", rate_to_base: "0", effective_on: "2026-11-22", source: "x",
  }, FACTORY));
  assert.throws(() => buildExchangeRatePayload({
    currency: "USD", base_currency: "BDT", rate_to_base: "120", effective_on: "2026-02-31", source: "x",
  }, FACTORY));
});

test("filters quotations and summarizes lifecycle states", () => {
  const quotes = [
    { quote_number: "Q-1", customer_name: "Acme", status: "DRAFT" },
    { quote_number: "Q-2", customer_name: "North", status: "PENDING_APPROVAL" },
    { quote_number: "Q-3", customer_name: "Acme", status: "CONVERTED" },
  ];
  assert.deepEqual(filterQuotations(quotes, "acme").map(q => q.quote_number), ["Q-1", "Q-3"]);
  assert.deepEqual(filterQuotations(quotes, "", "PENDING_APPROVAL").map(q => q.quote_number), ["Q-2"]);
  assert.deepEqual(summarizeQuotations(quotes), {
    total: 3, draft: 1, pendingApproval: 1, approved: 0, sent: 0,
    accepted: 0, converted: 1, rejected: 0, cancelled: 0, expired: 0,
  });
  assert.equal(quotationStatusLabel("PENDING_APPROVAL"), "PENDING APPROVAL");
});
