const TASK_STATUSES = ["SCHEDULED", "IN_PROGRESS", "AWAITING_REVIEW", "COMPLETED", "CANCELLED"];
const SESSION_STATUSES = TASK_STATUSES;
const POLICY_STATUSES = ["ACTIVE", "PAUSED", "RETIRED"];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function asCycleCountItems(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
}

export function cycleCountSummary(tasks = [], sessions = [], policies = [], proposals = []) {
  return {
    scheduled: tasks.filter((task) => task.status === "SCHEDULED").length,
    inProgress: tasks.filter((task) => task.status === "IN_PROGRESS").length,
    awaitingReview: tasks.filter((task) => task.status === "AWAITING_REVIEW").length,
    overdue: tasks.filter((task) => task.overdue === true).length,
    activeSessions: sessions.filter((session) => ["SCHEDULED", "IN_PROGRESS", "AWAITING_REVIEW"].includes(session.status)).length,
    activePolicies: policies.filter((policy) => policy.status === "ACTIVE").length,
    pendingProposals: proposals.filter((proposal) => proposal.status === "PENDING_REVIEW").length,
    openEscalations: tasks.filter((task) => task.variance_escalation_status === "OPEN").length,
  };
}

export function filterCycleCountTasks(tasks = [], search = "", status = "ALL") {
  const query = text(search).toLowerCase();
  return tasks.filter((task) => {
    if (status !== "ALL" && task.status !== status) return false;
    if (!query) return true;
    return [
      task.item_name, task.item_sku, task.location_code, task.assigned_to_user_id,
      task.id, task.notes,
    ].some((value) => text(value).toLowerCase().includes(query));
  });
}

export function expectedSnapshotVisible(proposal, viewerUserId, reviewer = false) {
  if (!proposal || proposal.ledger_quantity_at_count === null || proposal.ledger_quantity_at_count === undefined) {
    return false;
  }
  if (proposal.blind_count_snapshot === true
    && text(proposal.created_by_user_id).toLowerCase() === text(viewerUserId).toLowerCase()) {
    return false;
  }
  return reviewer || proposal.blind_count_snapshot !== true || Boolean(proposal.ledger_quantity_at_count);
}

export function cycleCountVariance(proposal) {
  if (!expectedSnapshotVisible(proposal, "", true)) return null;
  const expected = number(proposal.ledger_quantity_at_count);
  const counted = number(proposal.counted_quantity);
  return Number((counted - expected).toFixed(4));
}

export function canReviewCycleCountProposal(proposal, viewerUserId, hasReviewPermission, escalationStatus = null) {
  if (!hasReviewPermission || proposal?.status !== "PENDING_REVIEW") return false;
  if (text(proposal?.created_by_user_id).toLowerCase() === text(viewerUserId).toLowerCase()) return false;
  if (escalationStatus === "OPEN") return false;
  return true;
}

export function formatCycleCountStatus(value) {
  const normalized = text(value).toUpperCase();
  if (TASK_STATUSES.includes(normalized) || SESSION_STATUSES.includes(normalized) || POLICY_STATUSES.includes(normalized)) {
    return normalized.replaceAll("_", " ");
  }
  return normalized ? normalized.replaceAll("_", " ") : "UNKNOWN";
}

export function formatCycleCountQuantity(value, unit = "") {
  const parsed = Number(value);
  const formatted = Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : "—";
  return unit ? formatted + " " + unit : formatted;
}

export function buildCycleCountTaskPayload(input) {
  const payload = {
    item_id: text(input.item_id),
    due_at: new Date(input.due_at).toISOString(),
    priority: Number(input.priority ?? 100),
    blind_count: input.blind_count !== false,
  };
  if (text(input.location_id)) payload.location_id = text(input.location_id);
  if (text(input.assigned_to_user_id)) payload.assigned_to_user_id = text(input.assigned_to_user_id);
  if (text(input.variance_escalation_threshold)) {
    payload.variance_escalation_threshold = Number(input.variance_escalation_threshold);
  }
  if (text(input.notes)) payload.notes = text(input.notes);
  return payload;
}

export function buildCycleCountSessionPayload(input) {
  const locations = Array.from(new Set((input.location_ids ?? []).map(text).filter(Boolean)));
  if (locations.length < 2 || locations.length > 50) {
    throw new Error("Select between 2 and 50 distinct active bins.");
  }
  if (!text(input.assigned_to_user_id)) throw new Error("Choose an assigned counter.");
  return {
    item_id: text(input.item_id),
    location_ids: locations,
    assigned_to_user_id: text(input.assigned_to_user_id),
    due_at: new Date(input.due_at).toISOString(),
    priority: Number(input.priority ?? 100),
    blind_count: input.blind_count !== false,
    ...(text(input.variance_escalation_threshold)
      ? { variance_escalation_threshold: Number(input.variance_escalation_threshold) }
      : {}),
    ...(text(input.notes) ? { notes: text(input.notes) } : {}),
  };
}

export function buildRecurringCycleCountPayload(input) {
  const locations = Array.from(new Set((input.location_ids ?? []).map(text).filter(Boolean)));
  if (!text(input.assigned_to_user_id)) throw new Error("Choose an assigned counter.");
  if (locations.length === 1) throw new Error("A multi-bin recurring policy needs at least 2 bins.");
  if (locations.length > 50) throw new Error("A recurring session can include at most 50 bins.");
  const cadence = text(input.cadence_unit).toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(cadence)) {
    throw new Error("Choose a valid recurrence cadence.");
  }
  return {
    item_id: text(input.item_id),
    assigned_to_user_id: text(input.assigned_to_user_id),
    cadence_unit: cadence,
    cadence_interval: Number(input.cadence_interval ?? 1),
    first_run_at: new Date(input.first_run_at).toISOString(),
    priority: Number(input.priority ?? 100),
    blind_count: input.blind_count !== false,
    ...(locations.length >= 2 ? { location_ids: locations } : {}),
    ...(locations.length === 0 && text(input.location_id) ? { location_id: text(input.location_id) } : {}),
    ...(text(input.variance_escalation_threshold)
      ? { variance_escalation_threshold: Number(input.variance_escalation_threshold) }
      : {}),
    ...(text(input.notes) ? { notes: text(input.notes) } : {}),
  };
}

export function cycleCountTaskActions(task, viewerUserId) {
  const assigned = text(task?.assigned_to_user_id).toLowerCase();
  const viewer = text(viewerUserId).toLowerCase();
  return {
    canStart: task?.status === "SCHEDULED" && (!assigned || assigned === viewer),
    canSubmit: task?.status === "IN_PROGRESS" && (!assigned || assigned === viewer),
    canCancel: ["SCHEDULED", "IN_PROGRESS"].includes(task?.status),
    hasProposal: Boolean(task?.current_proposal_id),
  };
}
