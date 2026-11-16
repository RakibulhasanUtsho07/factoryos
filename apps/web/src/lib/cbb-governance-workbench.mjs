const EVIDENCE_STATES = Object.freeze([
  "VERIFIED",
  "INFERRED",
  "PROPOSED",
  "CONFLICTING",
  "STALE",
]);
const TARGET_TYPES = Object.freeze([
  "BLUEPRINT",
  "ENTITY",
  "RELATION",
  "PROCESS",
  "PROCESS_STEP",
  "RULE",
  "TERM",
  "EXCEPTION",
]);
const CONFLICT_STATUSES = Object.freeze(["OPEN", "RESOLVED", "DISMISSED"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredRequest(request) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }
  return request;
}

function enumValue(value, allowed, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.includes(normalized)) {
    throw new Error(label + " must be one of: " + allowed.join(", ") + ".");
  }
  return normalized;
}

function uuid(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(label + " must be a valid UUID.");
  }
  return normalized;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(label + " must be an integer between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function queryString(entries) {
  const selected = entries.filter((entry) =>
    entry[1] !== undefined && entry[1] !== null && entry[1] !== "");
  return selected.length
    ? "?" + selected.map((entry) =>
      encodeURIComponent(entry[0]) + "=" + encodeURIComponent(String(entry[1]))).join("&")
    : "";
}

function listBounds(limit, offset) {
  return {
    limit: boundedInteger(limit, "Page limit", 1, 200),
    offset: boundedInteger(offset, "Page offset", 0, 100000),
  };
}

export function createCbbGovernanceClient({ request }) {
  const sessionRequest = requiredRequest(request);
  const root = "/v1/business-model";

  return Object.freeze({
    async getBusinessModel() {
      return sessionRequest(root);
    },

    async getBusinessMap() {
      return sessionRequest(root + "/map");
    },

    async getVersionMap({ versionId: versionIdInput } = {}) {
      const versionId = uuid(versionIdInput, "Blueprint version ID");
      return sessionRequest(root + "/versions/" + versionId + "/map");
    },

    async listProcesses() {
      return sessionRequest(root + "/processes");
    },

    async getProcess({ processId: processIdInput } = {}) {
      const processId = uuid(processIdInput, "Process ID");
      return sessionRequest(root + "/processes/" + processId);
    },

    async listVersions() {
      return sessionRequest(root + "/versions");
    },

    async listEvidence({
      state: stateInput,
      targetType: targetTypeInput,
      targetId: targetIdInput,
      limit: limitInput = 50,
      offset: offsetInput = 0,
    } = {}) {
      const state = enumValue(stateInput, EVIDENCE_STATES, "Evidence state");
      const targetType = enumValue(targetTypeInput, TARGET_TYPES, "Evidence target type");
      const targetId = targetIdInput === undefined || targetIdInput === null || targetIdInput === ""
        ? undefined
        : uuid(targetIdInput, "Evidence target ID");
      if ((targetType === undefined) !== (targetId === undefined)) {
        throw new Error("Evidence target type and target ID must be supplied together.");
      }
      const bounds = listBounds(limitInput, offsetInput);
      return sessionRequest(root + "/evidence" + queryString([
        ["state", state],
        ["target_type", targetType],
        ["target_id", targetId],
        ["limit", bounds.limit],
        ["offset", bounds.offset],
      ]));
    },

    async listConflicts({
      status: statusInput,
      subjectType: subjectTypeInput,
      limit: limitInput = 50,
      offset: offsetInput = 0,
    } = {}) {
      const status = enumValue(statusInput, CONFLICT_STATUSES, "Conflict status");
      const subjectType = enumValue(subjectTypeInput, TARGET_TYPES, "Conflict subject type");
      const bounds = listBounds(limitInput, offsetInput);
      return sessionRequest(root + "/conflicts" + queryString([
        ["status", status],
        ["subject_type", subjectType],
        ["limit", bounds.limit],
        ["offset", bounds.offset],
      ]));
    },

    async listStaleness() {
      return sessionRequest(root + "/staleness");
    },

    async listTerminology({ search: searchInput } = {}) {
      const search = searchInput === undefined || searchInput === null
        ? undefined
        : String(searchInput).trim();
      if (search && search.length > 300) {
        throw new Error("Terminology search cannot exceed 300 characters.");
      }
      return sessionRequest(root + "/terminology" + queryString([
        ["search", search],
      ]));
    },
  });
}

export const cbbEvidenceStates = EVIDENCE_STATES;
export const cbbTargetTypes = TARGET_TYPES;
export const cbbConflictStatuses = CONFLICT_STATUSES;
