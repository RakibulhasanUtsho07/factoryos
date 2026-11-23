export const SHOULD_COST_CATEGORIES = [
  "MATERIAL", "LABOUR", "ENERGY", "FREIGHT", "DUTY", "OVERHEAD", "SCRAP",
];
const METHODS_BY_CATEGORY = {
  MATERIAL: ["DIRECT_RATE"],
  LABOUR: ["DIRECT_RATE"],
  ENERGY: ["DIRECT_RATE"],
  FREIGHT: ["DIRECT_RATE", "FIXED_PER_BATCH"],
  DUTY: ["DIRECT_RATE", "PERCENT_OF_BASE"],
  OVERHEAD: ["DIRECT_RATE", "FIXED_PER_BATCH", "PERCENT_OF_BASE"],
  SCRAP: ["DIRECT_RATE", "SCRAP_GROSS_UP"],
};
const SOURCE_TYPES = [
  "SUPPLIER_QUOTE", "PURCHASE_ORDER", "COST_RATE_CARD", "UTILITY_BILL",
  "FREIGHT_QUOTE", "DUTY_SCHEDULE", "OVERHEAD_POLICY", "QUALITY_STANDARD",
  "MANUAL_APPROVED",
];
const QUANTITY_SOURCE_TYPES = ["BOM", "ROUTING", "UTILITY_READING", "MANUAL_APPROVED"];
const SCOPE_TYPES = ["PRODUCT_VERSION", "ORDER", "QUOTATION"];
const PROFILE_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function record(value, field) {
  let result = value;
  if (typeof value === "string") {
    try { result = JSON.parse(value); }
    catch { throw new Error(field + " must contain valid JSON."); }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(field + " must be a JSON object.");
  }
  if (Object.keys(result).length === 0) throw new Error(field + " must contain at least one evidence field.");
  return result;
}

function dateOnly(value, field) {
  const result = clean(value);
  if (!DATE_ONLY.test(result)) throw new Error(field + " must use YYYY-MM-DD.");
  const parsed = new Date(result + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(field + " must be a real calendar date.");
  }
  return result;
}

function positiveDecimal(value, field, maxDecimals, allowZero = false) {
  const result = clean(String(value ?? ""));
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(result)) throw new Error(field + " must be a non-negative decimal.");
  const decimals = result.split(".")[1]?.length ?? 0;
  if (decimals > maxDecimals) throw new Error(field + " supports at most " + maxDecimals + " decimal places.");
  const parsed = Number(result);
  if (!Number.isFinite(parsed) || (!allowZero && parsed <= 0)) {
    throw new Error(field + (allowZero ? " must not be negative." : " must be greater than zero."));
  }
  return parsed;
}

function uuid(value, field) {
  const result = clean(value).toLowerCase();
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result;
}

function assertMethod(category, method, bases) {
  if (!METHODS_BY_CATEGORY[category]?.includes(method)) {
    throw new Error(method + " is not supported for " + category + ".");
  }
  const baseList = Array.isArray(bases) ? bases : [];
  if (new Set(baseList).size !== baseList.length) {
    throw new Error(category + " base categories must be unique.");
  }
  const index = SHOULD_COST_CATEGORIES.indexOf(category);
  if (["PERCENT_OF_BASE", "SCRAP_GROSS_UP"].includes(method)) {
    if (!baseList.length || baseList.some((base) =>
      !SHOULD_COST_CATEGORIES.includes(base) || SHOULD_COST_CATEGORIES.indexOf(base) >= index
    )) {
      throw new Error(category + " may depend only on earlier cost categories.");
    }
  } else if (baseList.length) {
    throw new Error(category + " does not accept base categories for this method.");
  }
}

export function normalizeShouldCostRows(value, preferredKey = "items") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.rows)) return value.rows;
  if (value.data !== undefined) return normalizeShouldCostRows(value.data, preferredKey);
  return [];
}

export function buildShouldCostProfilePayload(input) {
  const factoryId = uuid(input.factory_id, "Factory ID");
  const profileCode = clean(input.profile_code).toUpperCase();
  const currency = clean(input.currency || "BDT").toUpperCase();
  const outputUnit = clean(input.output_unit).toUpperCase();
  const productId = clean(input.product_id) ? uuid(input.product_id, "Product ID") : undefined;
  if (!profileCode || profileCode.length > 100) throw new Error("Profile code must contain 1 to 100 characters.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter ISO code.");
  if (!outputUnit || outputUnit.length > 50) throw new Error("Output unit must contain 1 to 50 characters.");
  if (!Array.isArray(input.components) || input.components.length !== 7) {
    throw new Error("A should-cost profile must configure all seven cost categories.");
  }
  const seen = new Set();
  const components = input.components.map((component) => {
    const category = clean(component.category).toUpperCase();
    const method = clean(component.calculation_method).toUpperCase();
    const guidance = clean(component.guidance);
    const bases = Array.isArray(component.base_categories)
      ? component.base_categories.map((entry) => clean(entry).toUpperCase())
      : [];
    if (!SHOULD_COST_CATEGORIES.includes(category) || seen.has(category)) {
      throw new Error("Each of the seven cost categories must appear exactly once.");
    }
    seen.add(category);
    if (!guidance || guidance.length > 1000) throw new Error(category + " guidance is required and cannot exceed 1000 characters.");
    assertMethod(category, method, bases);
    return {
      category,
      calculation_method: method,
      is_required: component.is_required !== false,
      base_categories: bases,
      guidance,
    };
  });
  if (seen.size !== 7 || SHOULD_COST_CATEGORIES.some((category) => !seen.has(category))) {
    throw new Error("A should-cost profile must contain all seven categories.");
  }
  return {
    factory_id: factoryId,
    ...(productId ? { product_id: productId } : {}),
    profile_code: profileCode,
    currency,
    output_unit: outputUnit,
    components: SHOULD_COST_CATEGORIES.map((category) => components.find((item) => item.category === category)),
  };
}

export function buildShouldCostTransitionPayload(expectedVersion, reason) {
  const version = Number(expectedVersion);
  const rationale = clean(reason);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
    throw new Error("Expected profile row version must be a positive integer.");
  }
  if (!rationale || rationale.length > 1000) {
    throw new Error("Transition reason must contain 1 to 1000 characters.");
  }
  return { expected_version: version, reason: rationale };
}

export function buildShouldCostAssessmentPayload(input, profile) {
  const scopeType = clean(input.scope_type).toUpperCase();
  if (!SCOPE_TYPES.includes(scopeType)) throw new Error("Choose a supported target scope.");
  const targetId = uuid(input.target_id, "Target ID");
  const profileId = uuid(input.profile_id, "Profile ID");
  const targetQuantity = positiveDecimal(input.target_quantity, "Target quantity", 4, false);
  if (targetQuantity > 99999999999999) throw new Error("Target quantity exceeds the API maximum.");
  const targetUnit = clean(input.target_unit).toUpperCase();
  if (!targetUnit || targetUnit.length > 50) throw new Error("Target unit must contain 1 to 50 characters.");
  if (!profile || profile.id !== profileId || profile.status !== "APPROVED" || profile.is_current !== true) {
    throw new Error("Assessment requires the selected current approved profile.");
  }
  if (targetUnit !== String(profile.output_unit).trim().toUpperCase()) {
    throw new Error("Target unit must match the approved profile output unit.");
  }
  if (Array.isArray(profile.components) && profile.components.length !== 7) {
    throw new Error("Selected profile does not contain all seven formulas.");
  }
  if (!Array.isArray(input.evidence) || input.evidence.length !== 7) {
    throw new Error("Provide one evidence line for each of the seven cost categories.");
  }
  const byCategory = new Map(input.evidence.map((line) => [clean(line.category).toUpperCase(), line]));
  if (byCategory.size !== 7 || SHOULD_COST_CATEGORIES.some((category) => !byCategory.has(category))) {
    throw new Error("Evidence must contain each cost category exactly once.");
  }
  const profileComponents = new Map((profile.components ?? []).map((component) => [component.category, component]));
  const evidence = SHOULD_COST_CATEGORIES.map((category, index) => {
    const line = byCategory.get(category);
    const component = profileComponents.get(category);
    if (!line || !component) throw new Error("Missing " + category + " configuration or evidence.");
    const applicable = line.applicable !== false;
    const notes = clean(line.notes);
    if (!notes || notes.length > 2000) throw new Error(category + " evidence notes are required (maximum 2000 characters).");
    if (!applicable) {
      if (component.is_required !== false) throw new Error("Required " + category + " cannot be marked not applicable.");
      return {
        category, line_number: index + 1, applicable: false,
        source_type: "NOT_APPLICABLE", notes,
      };
    }
    const method = component.calculation_method;
    const sourceType = clean(line.source_type).toUpperCase();
    if (!SOURCE_TYPES.includes(sourceType)) throw new Error(category + " source type is invalid.");
    const sourceReference = clean(line.source_reference);
    if (!sourceReference || sourceReference.length > 500) throw new Error(category + " source reference is required (maximum 500 characters).");
    const sourceAsOf = dateOnly(line.source_as_of, category + " source date");
    const sourceSnapshot = record(line.source_snapshot, category + " rate/source snapshot");
    const result = {
      category,
      line_number: index + 1,
      applicable: true,
      source_type: sourceType,
      source_reference: sourceReference,
      source_as_of: sourceAsOf,
      notes,
      source_snapshot: sourceSnapshot,
    };
    if (method === "DIRECT_RATE") {
      result.unit_code = clean(line.unit_code).toUpperCase();
      if (!result.unit_code || result.unit_code.length > 50) throw new Error(category + " unit code is required for direct-rate evidence.");
      result.unit_rate = positiveDecimal(line.unit_rate, category + " unit rate", 8, true);
      result.input_quantity = positiveDecimal(line.input_quantity, category + " input quantity", 6, true);
      result.source_currency = clean(line.source_currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(result.source_currency)) throw new Error(category + " source currency must be a three-letter code.");
      if (["MATERIAL", "LABOUR", "ENERGY"].includes(category)) {
        result.quantity_source_type = "MANUAL_APPROVED";
        result.quantity_source_reference = clean(line.quantity_source_reference);
        if (!result.quantity_source_reference || result.quantity_source_reference.length > 500) {
          throw new Error(category + " quantity source reference is required.");
        }
        result.quantity_source_snapshot = record(line.quantity_source_snapshot, category + " quantity source snapshot");
      }
    } else if (method === "FIXED_PER_BATCH") {
      result.fixed_amount = positiveDecimal(line.fixed_amount, category + " fixed amount", 4, true);
      result.source_currency = clean(line.source_currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(result.source_currency)) throw new Error(category + " source currency must be a three-letter code.");
    } else {
      result.percentage_rate = positiveDecimal(line.percentage_rate, category + " percentage rate", 4, true);
      const maxRate = method === "SCRAP_GROSS_UP" ? 99.9999 : 100;
      if (result.percentage_rate > maxRate) throw new Error(category + " percentage exceeds the allowed formula limit.");
      if (Array.isArray(component.base_categories) && component.base_categories.length === 0) {
        throw new Error(category + " formula requires one or more base categories.");
      }
    }
    return result;
  });
  return {
    scope_type: scopeType,
    target_id: targetId,
    profile_id: profileId,
    target_quantity: targetQuantity,
    target_unit: targetUnit,
    evidence,
  };
}

export function buildShouldCostQuery(filters = {}, kind = "profiles") {
  const params = new URLSearchParams();
  if (kind === "profiles") {
    const status = clean(filters.status).toUpperCase();
    const code = clean(filters.profile_code);
    const productId = clean(filters.product_id);
    if (status && status !== "ALL") {
      if (!PROFILE_STATUSES.includes(status)) throw new Error("Profile status filter is invalid.");
      params.set("status", status);
    }
    if (code) {
      if (code.length > 100) throw new Error("Profile code filter is too long.");
      params.set("profile_code", code);
    }
    if (productId) params.set("product_id", uuid(productId, "Product ID"));
  } else if (kind === "assessments") {
    const scopeType = clean(filters.scope_type).toUpperCase();
    const targetId = clean(filters.target_id);
    const limit = filters.limit === undefined ? 20 : Number(filters.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Assessment limit must be between 1 and 100.");
    if (scopeType && scopeType !== "ALL") {
      if (!SCOPE_TYPES.includes(scopeType)) throw new Error("Assessment scope filter is invalid.");
      params.set("scope_type", scopeType);
    }
    if (targetId) params.set("target_id", uuid(targetId, "Target ID"));
    params.set("limit", String(limit));
  } else {
    throw new Error("Unsupported should-cost query type.");
  }
  const query = params.toString();
  return query ? "?" + query : "";
}

export function summarizeShouldCost(profiles = [], assessments = []) {
  return {
    profiles: profiles.length,
    currentProfiles: profiles.filter((row) => row.status === "APPROVED" && row.is_current === true).length,
    pendingProfiles: profiles.filter((row) => row.status === "PENDING_APPROVAL").length,
    draftProfiles: profiles.filter((row) => row.status === "DRAFT").length,
    assessments: assessments.length,
    costedTargets: new Set(assessments.map((row) => row.scope_type + ":" + row.scope_id)).size,
    totalCostedValue: assessments.reduce((sum, row) => sum + (Number(row.total_cost) || 0), 0),
  };
}

export function filterShouldCostProfiles(rows = [], search = "", status = "ALL") {
  const term = clean(search).toLocaleLowerCase();
  const wanted = clean(status).toUpperCase();
  return rows.filter((row) => {
    if (wanted !== "ALL" && String(row.status ?? "").toUpperCase() !== wanted) return false;
    if (!term) return true;
    return [row.profile_code, row.currency, row.output_unit, row.status]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(term));
  });
}

export function formatShouldCostMoney(value, currency, digits = 4) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const normalizedCurrency = /^[A-Z]{3}$/.test(String(currency ?? "").toUpperCase())
    ? String(currency).toUpperCase()
    : "";
  return (normalizedCurrency ? normalizedCurrency + " " : "") +
    amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export function shouldCostMarginTone(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "UNKNOWN";
  if (percent < 0) return "NEGATIVE";
  if (percent < 10) return "LOW";
  if (percent < 25) return "MODERATE";
  return "HEALTHY";
}
