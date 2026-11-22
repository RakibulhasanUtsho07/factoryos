import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFinanceCloseActionPayload,
  buildFinanceCloseCreatePayload,
  filterFinanceClosePeriods,
  financeCloseReadiness,
  normalizeFinanceCloseRows,
  summarizeFinanceClosePeriods,
} from "./finance-period-close.mjs";

const readySnapshot = {
  readiness: {
    missing_reporting_domains: [],
    uninitialized_reporting_domains: [],
    unresolved_reconciliation_count: 0,
    can_submit: true,
  },
};

const blockedSnapshot = {
  readiness: {
    missing_reporting_domains: ["GL"],
    uninitialized_reporting_domains: ["AP"],
    unresolved_reconciliation_count: 2,
    can_submit: false,
  },
};

test("normalizes close period register responses", () => {
  const periods = [{ id: "close-1" }];
  assert.deepEqual(normalizeFinanceCloseRows(periods), periods);
  assert.deepEqual(normalizeFinanceCloseRows({ items: periods }), periods);
  assert.deepEqual(normalizeFinanceCloseRows({ close_periods: periods }), periods);
  assert.deepEqual(normalizeFinanceCloseRows({}), []);
});

test("builds a finance-close creation request with canonical dates and currency", () => {
  assert.deepEqual(buildFinanceCloseCreatePayload({
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    currency: "bdt",
    reason: "Create October 2026 close",
  }), {
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    currency: "BDT",
    reason: "Create October 2026 close",
  });
});

test("rejects invalid date, reversed dates and periods beyond 371 calendar days", () => {
  assert.throws(() => buildFinanceCloseCreatePayload({
    period_start: "2026-02-30", period_end: "2026-03-31", currency: "BDT", reason: "A valid reason",
  }), /valid calendar date/);
  assert.throws(() => buildFinanceCloseCreatePayload({
    period_start: "2026-11-01", period_end: "2026-10-31", currency: "BDT", reason: "A valid reason",
  }), /on or after/);
  assert.throws(() => buildFinanceCloseCreatePayload({
    period_start: "2025-01-01", period_end: "2026-01-07", currency: "BDT", reason: "A valid reason",
  }), /cannot exceed 371/);
});

test("requires ISO three-letter currency and a reason of at least eight characters", () => {
  assert.throws(() => buildFinanceCloseCreatePayload({
    period_start: "2026-10-01", period_end: "2026-10-31", currency: "BD", reason: "Create October close",
  }), /three-letter/);
  assert.throws(() => buildFinanceCloseCreatePayload({
    period_start: "2026-10-01", period_end: "2026-10-31", currency: "BDT", reason: "short",
  }), /8–1000/);
});

test("builds optimistic-versioned transition payloads", () => {
  assert.deepEqual(buildFinanceCloseActionPayload({
    expected_version: "3", reason: "Reviewed reconciliation evidence",
  }), {
    expected_version: 3,
    reason: "Reviewed reconciliation evidence",
  });
});

test("rejects stale or malformed transition version and short reasons", () => {
  assert.throws(() => buildFinanceCloseActionPayload({ expected_version: "2.5", reason: "A reason is valid" }), /positive integer/);
  assert.throws(() => buildFinanceCloseActionPayload({ expected_version: "0", reason: "A reason is valid" }), /positive integer/);
  assert.throws(() => buildFinanceCloseActionPayload({ expected_version: "1", reason: "short" }), /8–1000/);
});

test("submission readiness preserves backend blockers without converting them to zero", () => {
  assert.deepEqual(financeCloseReadiness(readySnapshot), { ready: true, blockers: [] });
  assert.deepEqual(financeCloseReadiness(blockedSnapshot), {
    ready: false,
    blockers: [
      "Missing active reporting domains: GL",
      "Reporting sources without a completed ingestion receipt: AP",
      "Open reconciliation mismatches: 2",
    ],
  });
  assert.equal(financeCloseReadiness({}).ready, false);
});

test("summarizes draft readiness, submitted and approved statuses", () => {
  assert.deepEqual(summarizeFinanceClosePeriods([
    { status: "DRAFT", snapshot: readySnapshot },
    { status: "DRAFT", snapshot: blockedSnapshot },
    { status: "SUBMITTED" },
    { status: "APPROVED" },
  ]), {
    total: 4, drafts: 2, submitted: 1, approved: 1, readyDrafts: 1, blockedDrafts: 1,
  });
});

test("filters close periods by status, currency and search", () => {
  const rows = [
    { id: "1", currency: "BDT", status: "DRAFT", period_start: "2026-10-01" },
    { id: "2", currency: "USD", status: "SUBMITTED", period_start: "2026-09-01" },
    { id: "3", currency: "BDT", status: "APPROVED", period_start: "2026-08-01" },
  ];
  assert.deepEqual(filterFinanceClosePeriods(rows, { status: "DRAFT" }).map((item) => item.id), ["1"]);
  assert.deepEqual(filterFinanceClosePeriods(rows, { currency: "BDT" }).map((item) => item.id), ["1", "3"]);
  assert.deepEqual(filterFinanceClosePeriods(rows, { search: "2026-09" }).map((item) => item.id), ["2"]);
});
