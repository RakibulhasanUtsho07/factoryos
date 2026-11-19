export interface UomUnitLike {
  unit_code?: unknown; name?: unknown; dimension_code?: unknown;
}
export interface UomConversionLike {
  status?: unknown; from_unit_code?: unknown; from_unit_name?: unknown;
  to_unit_code?: unknown; to_unit_name?: unknown; dimension_code?: unknown;
  factor_numerator?: unknown; factor_denominator?: unknown; rounding_mode?: unknown;
  decision_reason?: unknown; submitted_by_user_id?: unknown; decided_by_user_id?: unknown;
}
export function formatUomFactor(numerator: unknown, denominator: unknown): string;
export function summarizeUomGovernance(units: UomUnitLike[], conversions: UomConversionLike[]): {
  units: number; dimensions: number; conversions: number; pending: number;
  approved: number; rejected: number; retired: number;
};
export function filterUomUnits<T extends UomUnitLike>(units: T[], query: string, dimension?: string): T[];
export function filterUomConversions<T extends UomConversionLike>(conversions: T[], query: string, status?: string): T[];
