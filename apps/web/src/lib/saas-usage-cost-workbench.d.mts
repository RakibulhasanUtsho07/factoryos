export interface SaasRequestOptions { method?: "GET" | "POST"; body?: unknown; }
export interface SaasUsageClient {
  listRates(metricCode?: string): Promise<unknown>;
  createRate(body: Record<string, unknown>): Promise<unknown>;
  report(from: string, to: string): Promise<unknown>;
  recordEvent(body: Record<string, unknown>): Promise<unknown>;
  createAdjustment(body: Record<string, unknown>): Promise<unknown>;
  reconcileUsage(body: Record<string, unknown>): Promise<unknown>;
  listReconciliations(limit?: number, offset?: number): Promise<unknown>;
  listBudgets(): Promise<unknown>;
  createBudget(body: Record<string, unknown>): Promise<unknown>;
  evaluateBudgets(asOf?: string): Promise<unknown>;
  listBudgetEvaluations(limit?: number, offset?: number): Promise<unknown>;
  listWorkloadControls(): Promise<unknown>;
  setWorkloadControl(body: Record<string, unknown>): Promise<unknown>;
  listAlerts(input?: { limit?: number; offset?: number; unread_only?: boolean }): Promise<unknown>;
  acknowledgeAlert(alertId: string, body: Record<string, unknown>): Promise<unknown>;
  recordProviderCost(body: Record<string, unknown>): Promise<unknown>;
  reconcileProviderInvoice(body: Record<string, unknown>): Promise<unknown>;
  listProviderReconciliations(limit?: number, offset?: number): Promise<unknown>;
}
export function normalizeSaasRows(value: unknown, preferredKey?: string): unknown[];
export function buildSaasRateCardPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasUsageEventPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasUsageAdjustmentPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasUsageReconciliationPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasBudgetPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasWorkloadControlPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasAlertAcknowledgementPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasProviderCostEventPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasProviderReconciliationPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSaasUsageReportQuery(from: string, to: string): string;
export function buildSaasBudgetEvaluationQuery(asOf?: string): string;
export function buildSaasAlertQuery(input?: { limit?: number; offset?: number; unread_only?: boolean }): string;
export function createSaasUsageClient(request: (path: string, options?: SaasRequestOptions) => Promise<unknown>): SaasUsageClient;
