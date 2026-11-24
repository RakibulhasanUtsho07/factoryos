import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSaasBillingAccountPayload,
  buildSaasBillingActionPayload,
  buildSaasBillingClosePayload,
  buildSaasBillingCloseQuery,
  buildSaasEntitlementModePayload,
  buildSaasSubscriptionPlanPayload,
  buildSaasSubscriptionTransitionPayload,
  buildSaasTrialPayload,
  createSaasCommercialClient,
  normalizeSaasCommercialRows,
} from "./saas-commercial-billing-workbench.mjs";

const key = "test-key-2026";
const future = "2099-01-01T00:00:00.000Z";

test("normalizes collection envelopes without inventing rows", () => {
  assert.deepEqual(normalizeSaasCommercialRows({ items: [{ id: "a" }] }), [{ id: "a" }]);
  assert.deepEqual(normalizeSaasCommercialRows({ data: { plans: [{ id: "b" }] } }, "plans"), [{ id: "b" }]);
  assert.deepEqual(normalizeSaasCommercialRows(null), []);
  assert.deepEqual(normalizeSaasCommercialRows({}), []);
});

test("builds bounded versioned subscription plans", () => {
  const result = buildSaasSubscriptionPlanPayload({
    plan_code: "PRO_PLUS", display_name: "Pro Plus", tier_rank: "3",
    deployment_profile: "DEDICATED_VPC", status: "ACTIVE",
    capabilities: '{"ai.runtime.inference":true}', idempotency_key: key,
  });
  assert.equal(result.plan_code, "PRO_PLUS");
  assert.equal(result.tier_rank, 3);
  assert.deepEqual(result.capabilities, { "ai.runtime.inference": true });
  assert.throws(() => buildSaasSubscriptionPlanPayload({
    plan_code: "not valid", display_name: "bad", tier_rank: 0, idempotency_key: key,
  }), /plan_code/);
  assert.throws(() => buildSaasSubscriptionPlanPayload({
    plan_code: "BASIC", display_name: "Basic", tier_rank: 1, capabilities: "[]", idempotency_key: key,
  }), /JSON object/);
});

test("starts a trial only with an active future expiry", () => {
  const payload = buildSaasTrialPayload({ plan_code: "BASIC", trial_ends_at: future, idempotency_key: key }, 1);
  assert.equal(payload.plan_code, "BASIC");
  assert.equal(payload.trial_ends_at, future);
  assert.throws(() => buildSaasTrialPayload({
    plan_code: "BASIC", trial_ends_at: "2020-01-01T00:00:00.000Z", idempotency_key: key,
  }, Date.parse("2021-01-01T00:00:00.000Z")), /future/);
});

test("requires valid transition-specific plan and billing-period inputs", () => {
  const suspend = buildSaasSubscriptionTransitionPayload({
    action: "SUSPEND", expected_version: "2", reason: "Approved finance hold", idempotency_key: key,
  });
  assert.equal(suspend.expected_version, 2);
  assert.equal(suspend.action, "SUSPEND");
  assert.throws(() => buildSaasSubscriptionTransitionPayload({
    action: "UPGRADE", expected_version: 2, reason: "Upgrade", idempotency_key: key,
  }), /target_plan_code/);
  assert.throws(() => buildSaasSubscriptionTransitionPayload({
    action: "TERMINATE", expected_version: 2, reason: "Terminate", period_start: future, idempotency_key: key,
  }), /period dates/);
  const activate = buildSaasSubscriptionTransitionPayload({
    action: "ACTIVATE", expected_version: 1, period_start: "2026-01-01T00:00:00Z",
    period_end: future, reason: "Trial converted", idempotency_key: key,
  });
  assert.equal(activate.action, "ACTIVATE");
  assert.throws(() => buildSaasSubscriptionTransitionPayload({
    action: "RENEW", expected_version: 1, period_start: future, period_end: future,
    reason: "Renew", idempotency_key: key,
  }), /later/);
});

test("enforcement mode requires an explicit reason and compare-and-swap version", () => {
  const payload = buildSaasEntitlementModePayload({
    mode: "SUBSCRIPTION_REQUIRED", expected_version: 0, reason: "Approved tenant billing cutover", idempotency_key: key,
  });
  assert.equal(payload.expected_version, 0);
  assert.throws(() => buildSaasEntitlementModePayload({
    mode: "INVALID", expected_version: 0, reason: "x", idempotency_key: key,
  }), /mode/);
});

test("billing account follows Stripe collection and tax constraints", () => {
  const payload = buildSaasBillingAccountPayload({
    provider_customer_id: "cus_123456", currency: "BDT", collection_method: "send_invoice",
    days_until_due: "30", automatic_tax_enabled: true, tax_behavior: "exclusive",
    expected_version: 0, idempotency_key: key,
  });
  assert.equal(payload.provider_code, "stripe");
  assert.equal(payload.days_until_due, 30);
  assert.equal(payload.tax_behavior, "exclusive");
  assert.throws(() => buildSaasBillingAccountPayload({
    provider_customer_id: "cus_123456", currency: "BDT", collection_method: "send_invoice",
    automatic_tax_enabled: false, expected_version: 0, idempotency_key: key,
  }), /days_until_due/);
  assert.throws(() => buildSaasBillingAccountPayload({
    provider_customer_id: "not-a-customer", currency: "BDT", collection_method: "charge_automatically",
    automatic_tax_enabled: false, expected_version: 0, idempotency_key: key,
  }), /Stripe customer ID/);
  assert.throws(() => buildSaasBillingAccountPayload({
    provider_customer_id: "cus_123456", currency: "BDT", collection_method: "charge_automatically",
    days_until_due: 10, automatic_tax_enabled: false, expected_version: 0, idempotency_key: key,
  }), /must be omitted/);
});

test("billing close uses a positive period capped at 35 days", () => {
  const payload = buildSaasBillingClosePayload({
    period_start: "2026-01-01T00:00:00Z", period_end: "2026-02-05T00:00:00Z",
    currency: "BDT", idempotency_key: key,
  });
  assert.equal(payload.currency, "BDT");
  assert.throws(() => buildSaasBillingClosePayload({
    period_start: "2026-01-01T00:00:00Z", period_end: "2026-02-06T00:00:00Z",
    currency: "BDT", idempotency_key: key,
  }), /35-day/);
  assert.deepEqual(buildSaasBillingActionPayload({ idempotency_key: key }), { idempotency_key: key });
  assert.equal(buildSaasBillingCloseQuery({ limit: 50, offset: 25 }), "?limit=50&offset=25");
  assert.throws(() => buildSaasBillingCloseQuery({ limit: 101 }), /limit/);
});

test("client binds to the existing subscription and billing API contracts", async () => {
  const calls = [];
  const client = createSaasCommercialClient(async (path, options) => {
    calls.push({ path, options });
    return { ok: true };
  });
  await client.listPlans();
  await client.startTrial({ plan_code: "BASIC" });
  await client.listSubscriptionEvents("id/with spaces");
  await client.getBillingAccount();
  await client.listBillingCloses({ limit: 10, offset: 20 });
  await client.issueInvoice("close/id");
  await client.reconcileInvoice("close/id", { idempotency_key: key });
  assert.deepEqual(calls.map((call) => call.path), [
    "/v2/saas/subscriptions/plans",
    "/v2/saas/subscriptions",
    "/v2/saas/subscriptions/id%2Fwith%20spaces/events",
    "/v2/saas/billing/provider-account",
    "/v2/saas/billing/closes?limit=10&offset=20",
    "/v2/saas/billing/closes/close%2Fid/issue",
    "/v2/saas/billing/closes/close%2Fid/reconcile",
  ]);
  assert.equal(calls[5].options.method, "POST");
});
