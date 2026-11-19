export interface EngineeringProductLike {
  status?: unknown; product_code?: unknown; product_name?: unknown;
  style_code?: unknown; size_code?: unknown; product_type?: unknown; base_unit?: unknown;
}
export interface EngineeringVersionLike { state?: unknown }
export interface EngineeringVersionDetailLike {
  bom_lines?: Array<{ quantity_per?: unknown }>;
  alternates?: Array<{ status?: unknown }>;
  routing_steps?: Array<{ is_quality_gate?: unknown }>;
}
export function formatEngineeringQuantity(value: unknown, unit?: string): string;
export function summarizeProductPortfolio(
  products: EngineeringProductLike[], versions?: EngineeringVersionLike[]
): { products: number; active: number; draftVersions: number; approvedVersions: number; retiredVersions: number };
export function summarizeEngineeringRevision(detail: EngineeringVersionDetailLike): {
  bomLines: number; bomQuantity: number; alternates: number; draftAlternates: number;
  approvedAlternates: number; routingSteps: number; qualityGates: number;
};
export function filterEngineeringProducts<T extends EngineeringProductLike>(products: T[], query: string): T[];
