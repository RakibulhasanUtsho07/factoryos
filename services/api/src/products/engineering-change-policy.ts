export interface EngineeringSnapshot {
  version: { id: string; number: number; expected_yield_percent: string; change_summary: string };
  bom: Array<Record<string, unknown>>;
  alternates: Array<Record<string, unknown>>;
  routing: Array<Record<string, unknown>>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function compareEngineeringSnapshots(source: EngineeringSnapshot, target: EngineeringSnapshot) {
  const bomChanged = canonical(source.bom) !== canonical(target.bom);
  const alternateChanged = canonical(source.alternates) !== canonical(target.alternates);
  const routingChanged = canonical(source.routing) !== canonical(target.routing);
  const specificationChanged = source.version.expected_yield_percent !== target.version.expected_yield_percent;
  return {
    source_version_id: source.version.id,
    target_version_id: target.version.id,
    source_version_number: source.version.number,
    target_version_number: target.version.number,
    bom_changed: bomChanged,
    alternate_materials_changed: alternateChanged,
    routing_changed: routingChanged,
    specification_changed: specificationChanged,
    any_change: bomChanged || alternateChanged || routingChanged || specificationChanged,
    change_summary: target.version.change_summary,
  };
}
