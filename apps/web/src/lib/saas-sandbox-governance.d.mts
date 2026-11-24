export type SandboxPurpose = "DEMO" | "TEST" | "EVALUATION" | "TRAINING";
export type SandboxDataMode = "SYNTHETIC" | "MASKED";
export type SandboxStatus = "PENDING_APPROVAL" | "ACTIVE" | "SUSPENDED" | "RETIRED" | "APPROVAL_EXPIRED";
export type SandboxTransitionAction = "SUSPEND" | "RESUME" | "RETIRE";
export interface SandboxRequest {
  (path: string, options?: { method?: "GET" | "POST"; body?: unknown }): Promise<unknown>;
}
export interface SaasSandboxClient {
  listEnvironments(): Promise<unknown>;
  createEnvironment(body: Record<string, unknown>): Promise<unknown>;
  events(environmentId: string): Promise<unknown>;
  approveMaskedData(environmentId: string, body: Record<string, unknown>): Promise<unknown>;
  transition(environmentId: string, body: Record<string, unknown>): Promise<unknown>;
  listPhysicalRuns(limit?: number, offset?: number): Promise<unknown>;
  physicalRun(runId: string): Promise<unknown>;
  provision(environmentId: string, body: Record<string, unknown>): Promise<unknown>;
}
export function normalizeSandboxRows(value: unknown): Record<string, unknown>[];
export function normalizeSandboxEvents(value: unknown): Record<string, unknown>[];
export function normalizeSandboxMutation(value: unknown): { environment: Record<string, unknown>; event: Record<string, unknown> | null; replayed: boolean };
export function normalizePhysicalRunRows(value: unknown): Record<string, unknown>[];
export function normalizePhysicalRunDetail(value: unknown): { run: Record<string, unknown>; events: Record<string, unknown>[]; idempotent: boolean };
export function summarizeSandboxes(input: unknown): {
  total: number; synthetic: number; masked: number; pendingApproval: number;
  active: number; suspended: number; approvalExpired: number; retired: number;
};
export function filterSandboxes(input: unknown, filters?: { query?: string; status?: string; dataMode?: string; purpose?: string }): Record<string, unknown>[];
export function buildCreateSandboxPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildMaskedApprovalPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSandboxTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSandboxPhysicalPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function createSaasSandboxClient(request: SandboxRequest): SaasSandboxClient;
