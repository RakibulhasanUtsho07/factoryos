export interface MrpRequirementLike {
  required_quantity?: unknown;
  shortage_quantity?: unknown;
  allocation_status?: unknown;
  order_number?: unknown;
  component_sku?: unknown;
  component_name?: unknown;
  product_code?: unknown;
  product_name?: unknown;
  need_by_date?: unknown;
}
export interface MrpCapacityOperationLike { status?: unknown }
export function formatMrpQuantity(value: unknown, unit?: string): string;
export function summarizeMrpRequirements(rows: MrpRequirementLike[]): {
  requirements: number; required: number; shortage: number; covered: number;
  late: number; unsupplied: number; shortageRows: number;
};
export function filterMrpRequirements(
  rows: MrpRequirementLike[], query: string, status?: string
): MrpRequirementLike[];
export function summarizeCapacityOperations(rows: MrpCapacityOperationLike[]): {
  operations: number; scheduled: number; conflicts: number; blocked: number;
};
