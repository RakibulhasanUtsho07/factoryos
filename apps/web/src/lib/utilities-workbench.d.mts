export type UtilityRecord = Record<string, unknown>;
export function normalizeUtilityRows(value: unknown, nestedKey?: string): UtilityRecord[];
export function buildUtilityListQuery(input?: Record<string, unknown>, kind?: "meters" | "events" | "alerts" | "readings" | "bindings" | "policies"): string;
export function buildUtilityMeterPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilityReadingPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilityEventPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilityEventTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilitySourceBindingPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilitySourceBindingTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilitySourceEventPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilityThresholdPolicyPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilityThresholdPolicyTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilityWorkOrderAllocationPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildUtilityAllocationReversePayload(input?: Record<string, unknown>): Record<string, unknown>;
export function summarizeUtilities(input?: Record<string, unknown>): {
 metersLoaded: number; metersActive: number; eventsOpen: number; eventsCritical: number;
 policiesActive: number; alertsOpen: number; readingsLoaded: number;
};
