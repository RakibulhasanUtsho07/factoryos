const CURRENCY = /^[A-Z]{3}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function dateValue(value, field) {
  const result = clean(value);
  if (!DATE_ONLY.test(result)) throw new Error(field + " must use YYYY-MM-DD.");
  const parsed = new Date(result + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(field + " must be a valid calendar date.");
  }
  return result;
}

function reasonValue(value, field = "Reason") {
  const result = clean(value);
  if (result.length < 8 || result.length > 1000) {
    throw new Error(field + " must contain 8–1000 characters.");
  }
  return result;
}

export function normalizeFinanceCloseRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.close_periods)) return value.close_periods;
  }
  return [];
}

export function buildFinanceCloseCreatePayload(input) {
  const periodStart = dateValue(input.period_start, "Period start");
  const periodEnd = dateValue(input.period_end, "Period end");
  if (periodEnd < periodStart) throw new Error("Period end must be on or after period start.");
  const days = (Date.parse(periodEnd + "T00:00:00.000Z") - Date.parse(periodStart + "T00:00:00.000Z")) / 86_400_000;
  if (days > 370) throw new Error("A finance-close period cannot exceed 371 calendar days.");
  const currency = clean(input.currency).toUpperCase();
  if (!CURRENCY.test(currency)) throw new Error("Currency must be a three-letter ISO code.");
  return {
    period_start: periodStart,
    period_end: periodEnd,
    currency,
    reason: reasonValue(input.reason, "Creation reason"),
  };
}

export function buildFinanceCloseActionPayload(input) {
  const expectedVersion = Number(input.expected_version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 2_147_483_647) {
    throw new Error("Expected row version must be a positive integer.");
  }
  return {
    expected_version: expectedVersion,
    reason: reasonValue(input.reason, "Transition reason"),
  };
}

export function financeCloseReadiness(snapshot) {
  const readiness = snapshot && typeof snapshot === "object" ? snapshot.readiness : null;
  if (!readiness || typeof readiness !== "object") {
    return { ready: false, blockers: ["The persisted snapshot does not contain a readiness assessment."] };
  }
  const blockers = [];
  const missing = Array.isArray(readiness.missing_reporting_domains) ? readiness.missing_reporting_domains : [];
  const uninitialized = Array.isArray(readiness.uninitialized_reporting_domains) ? readiness.uninitialized_reporting_domains : [];
  const unresolved = Number(readiness.unresolved_reconciliation_count ?? 0);
  if (missing.length) blockers.push("Missing active reporting domains: " + missing.join(", "));
  if (uninitialized.length) blockers.push("Reporting sources without a completed ingestion receipt: " + uninitialized.join(", "));
  if (!Number.isFinite(unresolved) || unresolved > 0) {
    blockers.push("Open reconciliation mismatches: " + (Number.isFinite(unresolved) ? unresolved : "unknown"));
  }
  if (readiness.can_submit !== true && blockers.length === 0) {
    blockers.push("The backend readiness gate has not cleared submission.");
  }
  return { ready: readiness.can_submit === true && blockers.length === 0, blockers };
}

export function summarizeFinanceClosePeriods(rows = []) {
  const summary = { total: rows.length, drafts: 0, submitted: 0, approved: 0, readyDrafts: 0, blockedDrafts: 0 };
  for (const row of rows) {
    const status = String(row.status ?? "").toUpperCase();
    if (status === "DRAFT") {
      summary.drafts += 1;
      if (financeCloseReadiness(row.snapshot).ready) summary.readyDrafts += 1;
      else summary.blockedDrafts += 1;
    } else if (status === "SUBMITTED") summary.submitted += 1;
    else if (status === "APPROVED") summary.approved += 1;
  }
  return summary;
}

export function filterFinanceClosePeriods(rows = [], filters = {}) {
  const status = clean(filters.status || "ALL").toUpperCase();
  const currency = clean(filters.currency || "ALL").toUpperCase();
  const query = clean(filters.search).toLowerCase();
  return rows.filter((row) => {
    if (status !== "ALL" && String(row.status).toUpperCase() !== status) return false;
    if (currency !== "ALL" && String(row.currency).toUpperCase() !== currency) return false;
    if (!query) return true;
    return [
      row.currency, row.period_start, row.period_end, row.status, row.snapshot_hash,
      row.created_by_user_id, row.submitted_by_user_id, row.approved_by_user_id,
    ].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}
