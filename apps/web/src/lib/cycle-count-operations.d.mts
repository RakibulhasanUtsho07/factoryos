export interface CycleCountTask {
  id: string;
  item_id: string;
  item_sku?: string;
  item_name?: string;
  location_id?: string | null;
  location_code?: string | null;
  assigned_to_user_id?: string | null;
  due_at: string;
  priority: number;
  status: string;
  blind_count: boolean;
  current_proposal_id?: string | null;
  variance_escalation_status?: "OPEN" | "RESOLVED" | null;
  overdue: boolean;
  notes?: string | null;
  [key: string]: unknown;
}
export interface CycleCountProposal {
  id: string;
  item_id: string;
  task_id?: string | null;
  counted_quantity: string;
  ledger_quantity_at_count: string | null;
  balance_version_at_count?: string | null;
  location_id?: string | null;
  location_quantity_at_count?: string | null;
  variance_reason_code?: string | null;
  status: string;
  blind_count_snapshot?: boolean;
  created_by_user_id: string;
  created_at: string;
  reviewed_by_user_id?: string | null;
  review_decision?: string | null;
  review_note?: string | null;
  reconciliation_id?: string | null;
  notes?: string | null;
}
export interface CycleCountSession {
  id: string;
  item_id: string;
  assigned_to_user_id: string;
  due_at: string;
  priority: number;
  expected_bin_count: number;
  task_count: number;
  scheduled_count: number;
  in_progress_count: number;
  awaiting_review_count: number;
  completed_count: number;
  cancelled_count: number;
  blind_count: boolean;
  status: string;
  [key: string]: unknown;
}
export interface CycleCountPolicy {
  id: string;
  item_id: string;
  location_id: string | null;
  location_ids: string[];
  assigned_to_user_id: string;
  cadence_unit: string;
  cadence_interval: number;
  next_run_at: string;
  last_run_at: string | null;
  status: string;
  blind_count: boolean;
}
export function asCycleCountItems(value: unknown, key?: string): any[];
export function cycleCountSummary(tasks?: CycleCountTask[], sessions?: CycleCountSession[], policies?: CycleCountPolicy[], proposals?: CycleCountProposal[]): {
  scheduled: number; inProgress: number; awaitingReview: number; overdue: number;
  activeSessions: number; activePolicies: number; pendingProposals: number; openEscalations: number;
};
export function filterCycleCountTasks(tasks: CycleCountTask[], search?: string, status?: string): CycleCountTask[];
export function expectedSnapshotVisible(proposal: CycleCountProposal, viewerUserId: string, reviewer?: boolean): boolean;
export function cycleCountVariance(proposal: CycleCountProposal): number | null;
export function canReviewCycleCountProposal(proposal: CycleCountProposal, viewerUserId: string, hasReviewPermission: boolean, escalationStatus?: string | null): boolean;
export function formatCycleCountStatus(value: string): string;
export function formatCycleCountQuantity(value: unknown, unit?: string): string;
export function buildCycleCountTaskPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildCycleCountSessionPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildRecurringCycleCountPayload(input: Record<string, unknown>): Record<string, unknown>;
export function cycleCountTaskActions(task: CycleCountTask, viewerUserId: string): {
  canStart: boolean; canSubmit: boolean; canCancel: boolean; hasProposal: boolean;
};
