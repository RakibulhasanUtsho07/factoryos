export type SaasCommercialRecord = Record<string, unknown>;
export interface SaasCommercialRequest {
  (path: string, options?: { method?: "GET" | "POST"; body?: unknown }): Promise<unknown>;
}
export interface SaasCommercialClient {
  listPlans(): Promise<unknown>;
  createPlan(body: SaasCommercialRecord): Promise<unknown>;
  getCurrentSubscription(): Promise<unknown>;
  startTrial(body: SaasCommercialRecord): Promise<unknown>;
  listSubscriptionEvents(subscriptionId: string): Promise<unknown>;
  transitionSubscription(subscriptionId: string, body: SaasCommercialRecord): Promise<unknown>;
  getEntitlementMode(): Promise<unknown>;
  setEntitlementMode(body: SaasCommercialRecord): Promise<unknown>;
  getBillingAccount(): Promise<unknown>;
  configureBillingAccount(body: SaasCommercialRecord): Promise<unknown>;
  listBillingCloses(input?: { limit?: number; offset?: number }): Promise<unknown>;
  getBillingClose(closeId: string): Promise<unknown>;
  createBillingClose(body: SaasCommercialRecord): Promise<unknown>;
  issueInvoice(closeId: string): Promise<unknown>;
  retryPayment(closeId: string, body: SaasCommercialRecord): Promise<unknown>;
  reconcileInvoice(closeId: string, body: SaasCommercialRecord): Promise<unknown>;
  listBillingReconciliations(closeId: string): Promise<unknown>;
}
export function normalizeSaasCommercialRows(value: unknown, preferredKey?: string): unknown[];
export function buildSaasSubscriptionPlanPayload(input?: SaasCommercialRecord): SaasCommercialRecord;
export function buildSaasTrialPayload(input?: SaasCommercialRecord, now?: number): SaasCommercialRecord;
export function buildSaasSubscriptionTransitionPayload(input?: SaasCommercialRecord): SaasCommercialRecord;
export function buildSaasEntitlementModePayload(input?: SaasCommercialRecord): SaasCommercialRecord;
export function buildSaasBillingAccountPayload(input?: SaasCommercialRecord): SaasCommercialRecord;
export function buildSaasBillingClosePayload(input?: SaasCommercialRecord): SaasCommercialRecord;
export function buildSaasBillingActionPayload(input?: SaasCommercialRecord): SaasCommercialRecord;
export function buildSaasBillingCloseQuery(input?: { limit?: number; offset?: number }): string;
export function createSaasCommercialClient(request: SaasCommercialRequest): SaasCommercialClient;
