const numeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function formatEngineeringQuantity(value, unit = "") {
  const formatted = numeric(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
  return unit ? formatted + " " + unit : formatted;
}

export function summarizeProductPortfolio(products, versions = []) {
  const versionStates = versions.reduce((counts, version) => {
    const state = String(version.state ?? "UNKNOWN").toUpperCase();
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});
  return {
    products: products.length,
    active: products.filter((product) => String(product.status ?? "").toUpperCase() === "ACTIVE").length,
    draftVersions: versionStates.DRAFT ?? 0,
    approvedVersions: versionStates.APPROVED ?? 0,
    retiredVersions: versionStates.RETIRED ?? 0,
  };
}

export function summarizeEngineeringRevision(versionDetail) {
  const detail = versionDetail && typeof versionDetail === "object" ? versionDetail : {};
  const bom = Array.isArray(detail.bom_lines) ? detail.bom_lines : [];
  const alternates = Array.isArray(detail.alternates) ? detail.alternates : [];
  const routing = Array.isArray(detail.routing_steps) ? detail.routing_steps : [];
  return {
    bomLines: bom.length,
    bomQuantity: bom.reduce((sum, line) => sum + numeric(line.quantity_per), 0),
    alternates: alternates.length,
    draftAlternates: alternates.filter((item) => String(item.status ?? "").toUpperCase() === "DRAFT").length,
    approvedAlternates: alternates.filter((item) => String(item.status ?? "").toUpperCase() === "APPROVED").length,
    routingSteps: routing.length,
    qualityGates: routing.filter((step) => step.is_quality_gate === true).length,
  };
}

export function filterEngineeringProducts(products, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return products;
  return products.filter((product) => [
    product.product_code, product.product_name, product.style_code,
    product.size_code, product.product_type, product.base_unit,
  ].some((value) => String(value ?? "").toLowerCase().includes(needle)));
}
