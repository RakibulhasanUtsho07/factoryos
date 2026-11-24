export type ReleaseScope = "ORGANIZATION" | "FACTORY" | "MODULE" | "AGENT";
export type ReleaseChannel = "STABLE" | "PREVIEW" | "EXPERIMENTAL";
export type ReleaseStage = "DRAFT" | "CANARY" | "PRODUCTION" | "PAUSED" | "RETIRED";
export type DeploymentProfileType = "SHARED_SAAS" | "SINGLE_TENANT" | "DEDICATED_VPC" | "HYBRID_EDGE_CLOUD";
export interface SaasRequest {
  (path: string, options?: { method?: "GET" | "POST"; body?: unknown }): Promise<unknown>;
}
export interface SaasReleaseControlClient {
  listReleases(): Promise<unknown>;
  createRelease(body: Record<string, unknown>): Promise<unknown>;
  releaseHistory(key: string): Promise<unknown>;
  promoteRelease(key: string, body: Record<string, unknown>): Promise<unknown>;
  transitionRelease(key: string, body: Record<string, unknown>): Promise<unknown>;
  rollbackRelease(key: string, body: Record<string, unknown>): Promise<unknown>;
  resolveRelease(input: Record<string, unknown>): Promise<unknown>;
  listProfiles(factoryId?: string): Promise<unknown>;
  effectiveProfile(factoryId?: string): Promise<unknown>;
  createProfile(body: Record<string, unknown>): Promise<unknown>;
  tenantProfileHistory(): Promise<unknown>;
  factoryProfileHistory(factoryId: string): Promise<unknown>;
  transitionTenantProfile(body: Record<string, unknown>): Promise<unknown>;
  transitionFactoryProfile(factoryId: string, body: Record<string, unknown>): Promise<unknown>;
  listPhysicalRuns(limit?: number, offset?: number): Promise<unknown>;
  getPhysicalRun(runId: string): Promise<unknown>;
  provisionProfile(profileId: string, body: Record<string, unknown>): Promise<unknown>;
  deployRelease(key: string, body: Record<string, unknown>): Promise<unknown>;
}
export function normalizeSaasRows(value: unknown, keys?: string[]): Record<string, unknown>[];
export function normalizePhysicalRunRows(value: unknown): Record<string, unknown>[];
export function normalizePhysicalRunDetail(value: unknown): { run: Record<string, unknown>; events: Record<string, unknown>[]; idempotent: boolean };
export function summarizeReleaseRollouts(input: unknown): {
  total: number; draft: number; canary: number; production: number; paused: number; retired: number; physicallyDeployable: number;
};
export function summarizeDeploymentProfiles(input: unknown): {
  total: number; planned: number; provisioning: number; active: number; migrating: number; failed: number; retired: number;
};
export function buildCreateReleasePayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildReleasePromotionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildReleaseTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildReleaseRollbackPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildDeploymentProfilePayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildDeploymentProfileTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildPhysicalOperationPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildEffectiveReleaseQuery(input?: Record<string, unknown>): string;
export function createSaasReleaseControlClient(request: SaasRequest): SaasReleaseControlClient;
