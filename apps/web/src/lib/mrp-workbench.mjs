const asFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function formatMrpQuantity(value, unit = "") {
  const formatted = asFiniteNumber(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
  return unit ? formatted + " " + unit : formatted;
}

export function summarizeMrpRequirements(rows) {
  return rows.reduce((summary, row) => {
    const required = asFiniteNumber(row.required_quantity);
    const shortage = asFiniteNumber(row.shortage_quantity);
    summary.requirements += 1;
    summary.required += required;
    summary.shortage += shortage;
    const status = String(row.allocation_status ?? "UNKNOWN").toUpperCase();
    if (status === "COVERED") summary.covered += 1;
    else if (status === "LATE_SUPPLY") summary.late += 1;
    else summary.unsupplied += 1;
    if (shortage > 0) summary.shortageRows += 1;
    return summary;
  }, { requirements: 0, required: 0, shortage: 0, covered: 0, late: 0, unsupplied: 0, shortageRows: 0 });
}

export function filterMrpRequirements(rows, query, status = "ALL") {
  const needle = String(query ?? "").trim().toLowerCase();
  const selectedStatus = String(status ?? "ALL").toUpperCase();
  return rows.filter((row) => {
    const rowStatus = String(row.allocation_status ?? "UNKNOWN").toUpperCase();
    if (selectedStatus !== "ALL" && rowStatus !== selectedStatus) return false;
    if (!needle) return true;
    return [
      row.order_number, row.component_sku, row.component_name, row.product_code,
      row.product_name, row.need_by_date, row.allocation_status,
    ].some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
}

export function summarizeCapacityOperations(rows) {
  return rows.reduce((summary, row) => {
    summary.operations += 1;
    const status = String(row.status ?? "UNKNOWN").toUpperCase();
    if (status === "SCHEDULED") summary.scheduled += 1;
    else if (status === "CAPACITY_CONFLICT" || status === "FROZEN_HORIZON_CONFLICT") summary.conflicts += 1;
    else if (status.startsWith("BLOCKED_")) summary.blocked += 1;
    return summary;
  }, { operations: 0, scheduled: 0, conflicts: 0, blocked: 0 });
}
