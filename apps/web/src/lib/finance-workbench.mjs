const CLOSE_PERIOD_STATUSES = Object.freeze(["DRAFT", "SUBMITTED", "APPROVED"]);

function requiredRequest(request) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }
  return request;
}

function calendarDate(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(label + " must use YYYY-MM-DD format.");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(label + " must be a real calendar date.");
  }
  return value;
}

function currencyCode(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (!normalized) return undefined;
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("Currency must be a three-letter ISO currency code.");
  }
  return normalized;
}

function queryString(entries) {
  const values = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  return values.length
    ? "?" + values.map(([key, value]) =>
      encodeURIComponent(key) + "=" + encodeURIComponent(String(value))).join("&")
    : "";
}

function validateDateRange(from, to) {
  if (from && to && from > to) {
    throw new Error("from must be earlier than or equal to to.");
  }
}

export function createFinanceWorkbenchClient({ request }) {
  const sessionRequest = requiredRequest(request);

  return Object.freeze({
    async readWorkbench({
      from: fromInput,
      to: toInput,
      currency: currencyInput,
      horizonDays = 30,
      unreconciledLimit = 50,
    } = {}) {
      const from = calendarDate(fromInput, "from");
      const to = calendarDate(toInput, "to");
      validateDateRange(from, to);
      const currency = currencyCode(currencyInput);
      if (!Number.isSafeInteger(horizonDays) || horizonDays < 1 || horizonDays > 365) {
        throw new Error("Cash horizon must be an integer between 1 and 365 days.");
      }
      if (!Number.isSafeInteger(unreconciledLimit) || unreconciledLimit < 1 || unreconciledLimit > 100) {
        throw new Error("Unreconciled fact limit must be an integer between 1 and 100.");
      }

      const query = queryString([
        ["from", from],
        ["to", to],
        ["currency", currency],
        ["horizon_days", horizonDays],
        ["unreconciled_limit", unreconciledLimit],
      ]);
      return sessionRequest("/finance/workbench" + query);
    },

    async listClosePeriods({
      status: statusInput,
      currency: currencyInput,
      from: fromInput,
      to: toInput,
    } = {}) {
      const status = statusInput === undefined || statusInput === null || statusInput === ""
        ? undefined
        : String(statusInput).trim().toUpperCase();
      if (status && !CLOSE_PERIOD_STATUSES.includes(status)) {
        throw new Error("Close-period status must be DRAFT, SUBMITTED or APPROVED.");
      }
      const currency = currencyCode(currencyInput);
      const from = calendarDate(fromInput, "from");
      const to = calendarDate(toInput, "to");
      validateDateRange(from, to);

      const query = queryString([
        ["status", status],
        ["currency", currency],
        ["from", from],
        ["to", to],
      ]);
      return sessionRequest("/finance/close-periods" + query);
    },
  });
}

export const financeClosePeriodStatuses = CLOSE_PERIOD_STATUSES;
