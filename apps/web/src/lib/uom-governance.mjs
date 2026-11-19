export function formatUomFactor(numerator, denominator) {
  return String(numerator ?? "—") + " / " + String(denominator ?? "—");
}

export function summarizeUomGovernance(units, conversions) {
  const rules = conversions.reduce((summary, rule) => {
    const state = String(rule.status ?? "UNKNOWN").toUpperCase();
    summary.total += 1;
    if (state === "PENDING_APPROVAL") summary.pending += 1;
    else if (state === "APPROVED") summary.approved += 1;
    else if (state === "REJECTED") summary.rejected += 1;
    else if (state === "RETIRED") summary.retired += 1;
    return summary;
  }, { total: 0, pending: 0, approved: 0, rejected: 0, retired: 0 });

  const dimensions = new Set(units.map((unit) => String(unit.dimension_code ?? "").trim()).filter(Boolean));
  return {
    units: units.length,
    dimensions: dimensions.size,
    conversions: rules.total,
    pending: rules.pending,
    approved: rules.approved,
    rejected: rules.rejected,
    retired: rules.retired,
  };
}

export function filterUomUnits(units, query, dimension = "ALL") {
  const needle = String(query ?? "").trim().toLowerCase();
  const selectedDimension = String(dimension ?? "ALL").toUpperCase();
  return units.filter((unit) => {
    if (selectedDimension !== "ALL" && String(unit.dimension_code ?? "").toUpperCase() !== selectedDimension) return false;
    if (!needle) return true;
    return [unit.unit_code, unit.name, unit.dimension_code].some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
}

export function filterUomConversions(conversions, query, status = "ALL") {
  const needle = String(query ?? "").trim().toLowerCase();
  const selectedStatus = String(status ?? "ALL").toUpperCase();
  return conversions.filter((rule) => {
    if (selectedStatus !== "ALL" && String(rule.status ?? "").toUpperCase() !== selectedStatus) return false;
    if (!needle) return true;
    return [
      rule.from_unit_code, rule.from_unit_name, rule.to_unit_code, rule.to_unit_name,
      rule.dimension_code, rule.factor_numerator, rule.factor_denominator, rule.rounding_mode,
      rule.decision_reason, rule.submitted_by_user_id, rule.decided_by_user_id,
    ].some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
}
