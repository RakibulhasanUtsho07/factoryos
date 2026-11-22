const ALLOCATION_POLICIES = ["FIFO", "FEFO", "LOT", "SERIAL"];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(field + " must be a valid number.");
  return parsed;
}

export function asInventoryRows(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
}

export function summarizeReplenishment(shortages = [], recommendations = [], allocationPolicies = []) {
  return {
    shortageItems: shortages.length,
    uncoveredItems: shortages.filter((row) => Number(row.uncovered_shortage_quantity) > 0).length,
    recommendations: recommendations.length,
    supplierRequired: recommendations.filter((row) => row.recommendation_status === "SUPPLIER_REQUIRED").length,
    reviewRequired: recommendations.filter((row) => row.recommendation_status === "REVIEW_REQUIRED").length,
    allocationRules: allocationPolicies.filter((row) => row.policy_scope !== "FACTORY").length,
    traceabilityRequired: allocationPolicies.filter((row) => row.require_traceability === true).length,
  };
}

export function filterReplenishmentRows(rows = [], search = "", status = "ALL") {
  const query = text(search).toLowerCase();
  return rows.filter((row) => {
    if (status !== "ALL" && row.recommendation_status !== status) return false;
    if (!query) return true;
    return [row.sku, row.item_name, row.preferred_supplier_name, row.preferred_supplier_id, row.item_id]
      .some((value) => text(value).toLowerCase().includes(query));
  });
}

export function replenishmentMetrics(row) {
  const onHand = Number(row?.quantity_on_hand ?? 0);
  const reserved = Number(row?.quantity_reserved ?? 0);
  const available = Number(row?.available_quantity ?? onHand - reserved);
  const incoming = Number(row?.incoming_quantity ?? 0);
  const minimum = Number(row?.minimum_quantity ?? 0);
  const maximum = Number(row?.maximum_quantity ?? 0);
  const position = Number(row?.inventory_position ?? available + incoming);
  const physical = Number(row?.physical_shortage_quantity ?? Math.max(minimum - available, 0));
  const uncovered = Number(row?.uncovered_shortage_quantity ?? Math.max(minimum - available - incoming, 0));
  const recommended = Number(row?.recommended_order_quantity ?? Math.max(maximum - position, 0));
  return {
    onHand, reserved, available, incoming, minimum, maximum,
    inventoryPosition: position, physicalShortage: physical,
    uncoveredShortage: uncovered, recommendedOrder: recommended,
  };
}

export function buildReorderPolicyPayload(input) {
  const minimum = finite(input.minimum_quantity, "minimum_quantity");
  const maximum = finite(input.maximum_quantity, "maximum_quantity");
  const leadTime = finite(input.lead_time_days, "lead_time_days");
  if (minimum < 0 || maximum <= minimum) {
    throw new Error("Maximum quantity must be greater than the non-negative minimum quantity.");
  }
  if (minimum > 99999999999999 || maximum > 99999999999999
    || Math.abs(minimum * 10000 - Math.round(minimum * 10000)) > 0.000001
    || Math.abs(maximum * 10000 - Math.round(maximum * 10000)) > 0.000001) {
    throw new Error("Reorder quantities support up to 4 decimal places.");
  }
  if (!Number.isInteger(leadTime) || leadTime < 0 || leadTime > 3650) {
    throw new Error("Lead time must be an integer between 0 and 3650 days.");
  }
  const supplierId = text(input.preferred_supplier_id);
  return {
    minimum_quantity: minimum,
    maximum_quantity: maximum,
    lead_time_days: leadTime,
    preferred_supplier_id: supplierId || null,
    enabled: input.enabled === true,
  };
}

export function buildAllocationPolicyPayload(input) {
  const policy = text(input.allocation_policy).toUpperCase();
  if (!ALLOCATION_POLICIES.includes(policy)) {
    throw new Error("Choose FIFO, FEFO, LOT or SERIAL.");
  }
  const version = Number(input.expected_version);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("Policy version is stale or invalid. Refresh before saving.");
  }
  return {
    allocation_policy: policy,
    require_traceability: input.require_traceability === true,
    expected_version: version,
  };
}

export function findAllocationPolicy(policies = [], scope, value) {
  const expected = text(value).toLowerCase();
  return policies.find((policy) => {
    if (policy.policy_scope !== scope) return false;
    const actual = scope === "MATERIAL"
      ? policy.inventory_item_id
      : policy.sector_code;
    return text(actual).toLowerCase() === expected;
  }) ?? null;
}

/**
 * Mirrors the API's allocation-policy precedence:
 * material > sector > factory > tenant/factory traceability settings > FIFO fallback.
 * The last inherited source is intentionally labelled without guessing its current value.
 */
export function resolveAllocationPolicy(item, policies = []) {
  const material = findAllocationPolicy(policies, "MATERIAL", item?.id);
  if (material) return { ...material, source: "MATERIAL", inherited: false };
  const sector = text(item?.sector_code);
  if (sector) {
    const sectorPolicy = findAllocationPolicy(policies, "SECTOR", sector);
    if (sectorPolicy) return { ...sectorPolicy, source: "SECTOR", inherited: true };
  }
  const factory = policies.find((policy) => policy.policy_scope === "FACTORY");
  if (factory) return { ...factory, source: "FACTORY", inherited: true };
  return {
    policy_scope: "INHERITED",
    allocation_policy: null,
    require_traceability: null,
    version: null,
    source: "SYSTEM_DEFAULT",
    inherited: true,
  };
}

export function allocationPolicyLabel(value) {
  const names = {
    FIFO: "First in, first out",
    FEFO: "First expired, first out",
    LOT: "Lot-controlled",
    SERIAL: "Serial-controlled",
  };
  return names[text(value).toUpperCase()] ?? "System inherited";
}

export function getReorderEditorDefaults(item, signal = null) {
  return {
    minimum_quantity: signal?.minimum_quantity ?? "",
    maximum_quantity: signal?.maximum_quantity ?? "",
    lead_time_days: signal?.lead_time_days === undefined ? "7" : String(signal.lead_time_days),
    preferred_supplier_id: signal?.preferred_supplier_id ?? "",
    enabled: signal?.enabled !== false,
    item_id: item?.id ?? "",
  };
}
