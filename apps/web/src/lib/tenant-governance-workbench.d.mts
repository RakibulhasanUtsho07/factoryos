export interface GovernanceRow {
  id?: string;
  status?: string;
  version?: number | string;
  [key: string]: unknown;
}
export function normalizeGovernanceRows(value: unknown, preferredKey?: string): unknown[];
export function buildGovernanceListQuery(filters?: Record<string, unknown>, kind?: "users" | "feature-flags" | "entitlements"): string;
export function buildAuthIdentityPayload(input?: Record<string, unknown>): { user_id: string; issuer: string; subject: string };
export function buildFeatureFlagPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildEntitlementPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildFlagEvaluationPath(key: string, at?: string): string;
export function summarizeGovernanceWorkspace(input?: Record<string, Array<Record<string, unknown>>>): Record<string, number>;
export function filterGovernanceRows<T extends Record<string, unknown>>(rows?: T[], search?: string): T[];
