export interface AiOperationalSeries {
  domain: string; metricKey: string; modelVersion: string; sampleCount: number;
  meanAbsoluteError: number; meanAbsolutePercentageError: number | null;
  meanSignedError: number; withinToleranceRate: number;
  [key: string]: unknown;
}
export function normalizeAiOperationalRows(value: unknown, preferredKey?: string): unknown[];
export function buildAiOperationalQuery(filters?: Record<string, unknown>, kind?: string): string;
export function buildAiObservedEvaluationPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildAiForecastReconciliationPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildAiEvaluationPolicyPayload(input: Record<string, unknown>): Record<string, unknown>;
export function summarizeAiOperationalSeries(accuracy: unknown, calibration: unknown, policies: unknown): {
  seriesCount: number; totalSamples: number; meanWithinTolerance: number | null;
  calibrationGroups: number; policyCount: number;
};
export function filterAiOperationalSeries(rows?: AiOperationalSeries[], filters?: Record<string, unknown>): AiOperationalSeries[];
