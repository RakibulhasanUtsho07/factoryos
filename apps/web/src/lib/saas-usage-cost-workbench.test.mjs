import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSaasAlertQuery,
  buildSaasAlertAcknowledgementPayload,
  buildSaasBudgetEvaluationQuery,
  buildSaasBudgetPayload,
  buildSaasProviderCostEventPayload,
  buildSaasProviderReconciliationPayload,
  buildSaasRateCardPayload,
  buildSaasUsageAdjustmentPayload,
  buildSaasUsageEventPayload,
  buildSaasUsageReconciliationPayload,
  buildSaasUsageReportQuery,
  buildSaasWorkloadControlPayload,
  createSaasUsageClient,
  normalizeSaasRows,
} from "./saas-usage-cost-workbench.mjs";

const rateBase = {
  metric_code: "AI_INPUT_TOKEN", rate_version: 1, rate_minor_per_block: 50,
  block_quantity: "1000", currency: "BDT", effective_from: "2026-11-01T00:00:00Z",
  idempotency_key: "rate-v1",
};
const eventBase = {
  metric_code: "AI_INPUT_TOKEN", capability_code: "ai.runtime.inference",
  workload_class: "PRODUCTION", quantity: "1250.125000",
  occurred_at: "2026-11-18T10:00:00Z", source_system: "AI_GATEWAY",
  source_event_ref: "request:123", idempotency_key: "event-123",
};
const budgetBase = {
  budget_code: "ai-monthly", policy_version: 1, period_kind: "MONTHLY", scope_level: "TENANT",
  currency: "BDT", soft_limit_minor: 10000, hard_limit_minor: 20000,
  effective_from: "2026-11-01T00:00:00Z", idempotency_key: "budget-v1",
};
const providerBase = {
  provider_code: "openai", metric_code: "AI_INPUT_TOKEN", workload_class: "PRODUCTION",
  quantity: 100, currency: "USD", provider_cost_minor: 500,
  occurred_at: "2026-11-18T10:00:00Z", source_system: "PROVIDER_EXPORT",
  source_event_ref: "provider-event-1", idempotency_key: "provider-event-v1",
};

test("normalizes direct arrays, nested envelopes and API-specific collection keys", () => {
  const expected = [{ id: "one" }];
  assert.deepEqual(normalizeSaasRows(expected), expected);
  assert.deepEqual(normalizeSaasRows({ rates: expected }), expected);
  assert.deepEqual(normalizeSaasRows({ reconciliations: expected }, "reconciliations"), expected);
  assert.deepEqual(normalizeSaasRows({ data: { alerts: expected } }, "alerts"), expected);
  assert.deepEqual(normalizeSaasRows(null), []);
});

test("creates effective-dated meter rates with supported metric and currency", () => {
  assert.deepEqual(buildSaasRateCardPayload(rateBase), {
    ...rateBase, effective_from: "2026-11-01T00:00:00.000Z",
  });
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, metric_code: "UNKNOWN" }), /metric_code/);
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, currency: "bdt" }), /currency/);
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, rate_version: 0 }), /rate_version/);
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, rate_minor_per_block: 1.5 }), /minor currency/);
});

test("rate card rejects invalid effective timestamps and idempotency keys", () => {
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, effective_from: "yesterday" }), /ISO-8601/);
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, idempotency_key: "bad key" }), /idempotency_key/);
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, block_quantity: 0 }), /block_quantity/);
  assert.throws(() => buildSaasRateCardPayload({ ...rateBase, block_quantity: "0.0000001" }), /decimal places/);
});

test("records metered usage with capability, workload and source identity", () => {
  assert.deepEqual(buildSaasUsageEventPayload(eventBase), {
    ...eventBase, occurred_at: "2026-11-18T10:00:00.000Z", quantity: 1250.125,
  });
  assert.throws(() => buildSaasUsageEventPayload({ ...eventBase, capability_code: "UpperCase" }), /capability_code/);
  assert.throws(() => buildSaasUsageEventPayload({ ...eventBase, workload_class: "UNKNOWN" }), /workload_class/);
  assert.throws(() => buildSaasUsageEventPayload({ ...eventBase, source_system: "UNTRUSTED" }), /source_system/);
});

test("usage events reject non-positive quantities and excess decimal precision", () => {
  assert.throws(() => buildSaasUsageEventPayload({ ...eventBase, quantity: 0 }), /quantity/);
  assert.throws(() => buildSaasUsageEventPayload({ ...eventBase, quantity: "0.0000001" }), /decimal places/);
  assert.throws(() => buildSaasUsageEventPayload({ ...eventBase, source_event_ref: "" }), /source_event_ref/);
});

test("usage reports enforce inclusive date period and exclusive next-day end", () => {
  const query = new URLSearchParams(buildSaasUsageReportQuery("2026-11-01", "2026-11-30"));
  assert.equal(query.get("from"), "2026-11-01T00:00:00.000Z");
  assert.equal(query.get("to"), "2026-12-01T00:00:00.000Z");
  assert.throws(() => buildSaasUsageReportQuery("2026-12-01", "2026-11-30"), /after/);
  assert.throws(() => buildSaasUsageReportQuery("2025-01-01", "2026-11-30"), /366-day/);
});

test("usage adjustments require an actual quantity or money change and a reason", () => {
  const payload = buildSaasUsageAdjustmentPayload({
    period_start: "2026-11-01", period_end: "2026-11-30",
    quantity_delta: "-3.25", cost_delta_minor: -500, currency: "BDT",
    reason_code: "CUSTOMER_CREDIT", reason: "Approved service credit",
    idempotency_key: "adjust-v1",
  });
  assert.equal(payload.quantity_delta, -3.25);
  assert.equal(payload.cost_delta_minor, -500);
  assert.equal(payload.period_end, "2026-12-01T00:00:00.000Z");
  assert.throws(() => buildSaasUsageAdjustmentPayload({
    period_start: "2026-11-01", period_end: "2026-11-01", quantity_delta: 0,
    cost_delta_minor: 0, currency: "BDT", reason_code: "OTHER", reason: "No-op",
    idempotency_key: "adjust-noop",
  }), /must change/);
});

test("usage adjustment restricts reason codes, currency and bounded period", () => {
  const base = { period_start: "2026-11-01", period_end: "2026-11-30", quantity_delta: 1, cost_delta_minor: 0, currency: "BDT", reason_code: "OTHER", reason: "Correction", idempotency_key: "adjust-v2" };
  assert.throws(() => buildSaasUsageAdjustmentPayload({ ...base, reason_code: "FAKE" }), /reason_code/);
  assert.throws(() => buildSaasUsageAdjustmentPayload({ ...base, currency: "US" }), /currency/);
  assert.throws(() => buildSaasUsageAdjustmentPayload({ ...base, period_start: "2024-01-01", period_end: "2026-11-30" }), /366-day/);
});

test("usage invoice reconciliation enforces 35-day limit and non-negative minor units", () => {
  const payload = buildSaasUsageReconciliationPayload({
    invoice_reference: "INV-2026-11", reconciliation_version: 1,
    period_start: "2026-11-01", period_end: "2026-11-30",
    currency: "BDT", invoiced_amount_minor: 12000, idempotency_key: "recon-v1",
  });
  assert.equal(payload.period_end, "2026-12-01T00:00:00.000Z");
  assert.throws(() => buildSaasUsageReconciliationPayload({
    invoice_reference: "INV", reconciliation_version: 1, period_start: "2026-01-01", period_end: "2026-02-10",
    currency: "BDT", invoiced_amount_minor: 1, idempotency_key: "recon-too-long",
  }), /35-day/);
  assert.throws(() => buildSaasUsageReconciliationPayload({
    invoice_reference: "INV", reconciliation_version: 1, period_start: "2026-11-01", period_end: "2026-11-02",
    currency: "BDT", invoiced_amount_minor: -1, idempotency_key: "recon-negative",
  }), /minor currency/);
});

test("budget creation supports tenant scope and optional filters", () => {
  const payload = buildSaasBudgetPayload(budgetBase);
  assert.equal(payload.scope_level, "TENANT");
  assert.equal(payload.pause_noncritical_on_hard_limit, undefined);
  assert.equal(payload.anomaly_multiplier, 3);
  assert.equal(payload.anomaly_min_events, 10);
  const filtered = buildSaasBudgetPayload({ ...budgetBase, scope_level: "FACTORY", metric_code: "AI_TOOL_CALL", workload_class: "EVALUATION", capability_code: "ai.tool.read", pause_noncritical_on_hard_limit: true });
  assert.equal(filtered.metric_code, "AI_TOOL_CALL");
  assert.equal(filtered.pause_noncritical_on_hard_limit, true);
});

test("budget policies reject hard limits below soft limits and invalid scopes", () => {
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, hard_limit_minor: 9999 }), /hard_limit_minor/);
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, scope_level: "ORGANIZATION" }), /scope_level/);
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, period_kind: "WEEKLY" }), /period_kind/);
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, effective_to: "2026-10-01T00:00:00Z" }), /later/);
});

test("budget policies validate anomaly signal bounds and filter formats", () => {
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, anomaly_multiplier: 1 }), /anomaly_multiplier/);
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, anomaly_min_events: 2 }), /anomaly_min_events/);
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, capability_code: "Bad Capability" }), /capability_code/);
  assert.throws(() => buildSaasBudgetPayload({ ...budgetBase, currency: "BDT!" }), /currency/);
});

test("workload control permits only explicit non-critical AI workload classes", () => {
  const payload = buildSaasWorkloadControlPayload({
    workload_class: "EVALUATION", control_state: "PAUSED", scope_level: "TENANT",
    reason: "Monthly hard budget reached", idempotency_key: "pause-evaluation",
  });
  assert.equal(payload.control_state, "PAUSED");
  assert.throws(() => buildSaasWorkloadControlPayload({ workload_class: "PRODUCTION", control_state: "PAUSED", scope_level: "TENANT", reason: "bad", idempotency_key: "pause-prod" }), /workload_class/);
  assert.throws(() => buildSaasWorkloadControlPayload({ workload_class: "NON_AI", control_state: "PAUSED", scope_level: "TENANT", reason: "bad", idempotency_key: "pause-nonai" }), /workload_class/);
});

test("workload control requires a reason, supported state and scope", () => {
  const base = { workload_class: "DEVELOPMENT", control_state: "RESUMED", scope_level: "FACTORY", reason: "Development budget restored", idempotency_key: "resume-dev" };
  assert.equal(buildSaasWorkloadControlPayload(base).scope_level, "FACTORY");
  assert.throws(() => buildSaasWorkloadControlPayload({ ...base, control_state: "ENABLE" }), /control_state/);
  assert.throws(() => buildSaasWorkloadControlPayload({ ...base, scope_level: "USER" }), /scope_level/);
  assert.throws(() => buildSaasWorkloadControlPayload({ ...base, reason: "" }), /reason/);
});

test("budget evaluation as-of query is encoded and ISO validated", () => {
  assert.equal(buildSaasBudgetEvaluationQuery("2026-11-24T12:00:00Z"), "?as_of=2026-11-24T12%3A00%3A00.000Z");
  assert.equal(buildSaasBudgetEvaluationQuery(), "");
  assert.throws(() => buildSaasBudgetEvaluationQuery("not a date"), /ISO-8601/);
});

test("budget alert query bounds pagination and filters unread-only", () => {
  const params = new URLSearchParams(buildSaasAlertQuery({ limit: 10, offset: 20, unread_only: true }).slice(1));
  assert.equal(params.get("limit"), "10");
  assert.equal(params.get("offset"), "20");
  assert.equal(params.get("unread_only"), "true");
  assert.throws(() => buildSaasAlertQuery({ limit: 101 }), /bounds/);
  assert.throws(() => buildSaasAlertQuery({ offset: 10001 }), /bounds/);
});

test("alert acknowledgement uses a validated idempotency key", () => {
  assert.deepEqual(buildSaasAlertAcknowledgementPayload({ idempotency_key: "ack-alert-1" }), { idempotency_key: "ack-alert-1" });
  assert.throws(() => buildSaasAlertAcknowledgementPayload({ idempotency_key: "" }), /idempotency_key/);
});

test("provider cost event permits only provider-priced metrics", () => {
  const payload = buildSaasProviderCostEventPayload(providerBase);
  assert.equal(payload.provider_code, "openai");
  assert.equal(payload.provider_cost_minor, 500);
  assert.throws(() => buildSaasProviderCostEventPayload({ ...providerBase, metric_code: "TRANSACTION" }), /metric_code/);
  assert.throws(() => buildSaasProviderCostEventPayload({ ...providerBase, source_system: "MANUAL_UNKNOWN" }), /source_system/);
});

test("provider cost validates provider code, model code and source reference", () => {
  assert.throws(() => buildSaasProviderCostEventPayload({ ...providerBase, provider_code: "OpenAI" }), /provider_code/);
  assert.throws(() => buildSaasProviderCostEventPayload({ ...providerBase, model_code: "bad model code" }), /model_code/);
  assert.throws(() => buildSaasProviderCostEventPayload({ ...providerBase, source_event_ref: "" }), /source_event_ref/);
  assert.throws(() => buildSaasProviderCostEventPayload({ ...providerBase, provider_cost_minor: 1.5 }), /minor currency/);
});

test("provider reconciliation calculates for exact invoice scope within the supported period", () => {
  const payload = buildSaasProviderReconciliationPayload({
    provider_code: "openai", invoice_reference: "INV-OPENAI-11", reconciliation_version: 2,
    period_start: "2026-11-01", period_end: "2026-11-30", currency: "USD",
    invoiced_provider_cost_minor: 25000, idempotency_key: "provider-recon-2",
  });
  assert.equal(payload.reconciliation_version, 2);
  assert.equal(payload.invoiced_provider_cost_minor, 25000);
  assert.throws(() => buildSaasProviderReconciliationPayload({
    provider_code: "openai", invoice_reference: "INV", reconciliation_version: 1,
    period_start: "2026-11-01", period_end: "2026-11-30", currency: "USD",
    invoiced_provider_cost_minor: 100, idempotency_key: "provider-recon-bad",
  }), /invoice_reference/);
});

test("provider invoice reconciliation rejects an inverted period", () => {
  assert.throws(() => buildSaasProviderReconciliationPayload({
    provider_code: "openai", invoice_reference: "INV", reconciliation_version: 1,
    period_start: "2026-11-30", period_end: "2026-11-01", currency: "USD",
    invoiced_provider_cost_minor: 1, idempotency_key: "provider-recon-inverted",
  }), /after/);
});

test("client maps all usage, budget, workload, alert and provider routes", async () => {
  const calls = [];
  const api = createSaasUsageClient(async (path, options = {}) => { calls.push({ path, options }); return { ok: true }; });
  await api.listRates("AI_INPUT_TOKEN");
  await api.createRate({ metric_code: "AI_INPUT_TOKEN" });
  await api.report("2026-11-01", "2026-11-30");
  await api.recordEvent({ quantity: 1 });
  await api.createAdjustment({ reason: "x" });
  await api.reconcileUsage({ invoice_reference: "INV" });
  await api.listReconciliations();
  await api.listBudgets();
  await api.createBudget({ budget_code: "b" });
  await api.evaluateBudgets();
  await api.listBudgetEvaluations();
  await api.listWorkloadControls();
  await api.setWorkloadControl({ control_state: "PAUSED" });
  await api.listAlerts({ unread_only: true });
  await api.acknowledgeAlert("alert/one", { idempotency_key: "ack" });
  await api.recordProviderCost({ provider_code: "openai" });
  await api.reconcileProviderInvoice({ provider_code: "openai" });
  await api.listProviderReconciliations();
  assert.equal(calls.length, 18);
  assert.equal(calls[0].path, "/v2/saas/usage/rates?metric_code=AI_INPUT_TOKEN");
  assert.equal(calls[1].path, "/v2/saas/usage/rates");
  assert.ok(calls[2].path.startsWith("/v2/saas/usage/report?from="));
  assert.equal(calls[3].path, "/v2/saas/usage/events");
  assert.equal(calls[5].path, "/v2/saas/usage/reconciliations");
  assert.equal(calls[8].path, "/v2/saas/usage/budgets");
  assert.equal(calls[9].path, "/v2/saas/usage/budgets/evaluate");
  assert.equal(calls[12].path, "/v2/saas/usage/workloads/control");
  assert.ok(calls[13].path.includes("unread_only=true"));
  assert.equal(calls[14].path, "/v2/saas/usage/alerts/alert%2Fone/acknowledgements");
  assert.equal(calls[16].path, "/v2/saas/usage/provider-cost-reconciliations");
});

test("client refuses to initialize without the shared authenticated session adapter", () => {
  assert.throws(() => createSaasUsageClient(null), /authenticated FactoryOS session/);
});
