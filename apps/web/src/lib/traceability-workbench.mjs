const STATUSES = ["ACTIVE", "QUARANTINED", "RECALLED", "DISPOSED", "SHIPPED"];
const UNIT_TYPES = ["LOT", "SERIAL", "PALLET", "CARTON", "BUNDLE", "FINISHED_GOOD", "SHIPMENT"];
const PRODUCT_ROLES = ["MATERIAL", "FINISHED_GOOD", "PACKAGING", "SHIPMENT", "OTHER"];
const ACK_OUTCOMES = ["RECEIVED", "NO_ACTION_REQUIRED", "ACTION_IN_PROGRESS", "ACTION_COMPLETED", "UNABLE_TO_CONFIRM"];
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value, field, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(field + " must be an integer between " + min + " and " + max + ".");
  }
  return parsed;
}

export function asTraceabilityRows(value, key = "units") {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.units)) return value.units;
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.events)) return value.events;
    if (Array.isArray(value.relationships)) return value.relationships;
  }
  return [];
}

export function summarizeTraceabilityUnits(units = []) {
  const summary = {
    total: units.length,
    active: 0,
    quarantined: 0,
    recalled: 0,
    shipped: 0,
    disposed: 0,
    lots: 0,
    serials: 0,
    expiringSoon: 0,
  };
  const now = Date.now();
  const horizon = now + 30 * 24 * 60 * 60 * 1000;
  for (const unit of units) {
    const status = clean(unit.status).toUpperCase();
    const type = clean(unit.unit_type).toUpperCase();
    if (status === "ACTIVE") summary.active += 1;
    if (status === "QUARANTINED") summary.quarantined += 1;
    if (status === "RECALLED") summary.recalled += 1;
    if (status === "SHIPPED") summary.shipped += 1;
    if (status === "DISPOSED") summary.disposed += 1;
    if (type === "LOT") summary.lots += 1;
    if (type === "SERIAL") summary.serials += 1;
    if (unit.expires_at) {
      const expiry = new Date(unit.expires_at).getTime();
      if (Number.isFinite(expiry) && expiry >= now && expiry <= horizon) summary.expiringSoon += 1;
    }
  }
  return summary;
}

export function buildRecallDeclarationPayload(input) {
  const reason = clean(input.reason);
  if (!reason || reason.length > 1800) throw new Error("Recall reason is required and must be 1800 characters or fewer.");
  return {
    reason,
    depth: integer(input.depth, "Depth", 1, 12),
    limit: integer(input.limit, "Node limit", 1, 500),
  };
}

export function buildRecallNotificationIntentPayload(input) {
  const recipientType = clean(input.recipient_type).toUpperCase();
  if (!["CUSTOMER", "SITE"].includes(recipientType)) throw new Error("Choose CUSTOMER or SITE as the recipient type.");
  const recipientReference = clean(input.recipient_reference);
  if (!SAFE_REFERENCE.test(recipientReference) || /^https?:/i.test(recipientReference)) {
    throw new Error("Recipient reference must be a non-URL customer or site reference.");
  }
  const channel = clean(input.channel).toUpperCase();
  if (!["EMAIL", "PORTAL", "EDI", "MANUAL"].includes(channel)) throw new Error("Choose a supported notification channel.");
  const reason = clean(input.reason);
  if (reason.length > 1800) throw new Error("Notification reason must be 1800 characters or fewer.");
  return {
    recipient_type: recipientType,
    recipient_reference: recipientReference,
    channel,
    ...(reason ? { reason } : {}),
  };
}

export function buildRecallAcknowledgementPayload(input) {
  const outcome = clean(input.outcome).toUpperCase();
  if (!ACK_OUTCOMES.includes(outcome)) throw new Error("Choose a supported acknowledgement outcome.");
  const notes = clean(input.notes);
  if (notes.length > 1800) throw new Error("Acknowledgement notes must be 1800 characters or fewer.");
  const evidenceReference = clean(input.evidence_reference);
  if (evidenceReference && (!SAFE_REFERENCE.test(evidenceReference) || /^https?:/i.test(evidenceReference))) {
    throw new Error("Evidence reference must be a reference token, not a URL.");
  }
  return {
    outcome,
    ...(notes ? { notes } : {}),
    ...(evidenceReference ? { evidence_reference: evidenceReference } : {}),
  };
}

export function buildTraceabilityStatusPayload(input) {
  const targetStatus = clean(input.target_status).toUpperCase();
  if (!STATUSES.includes(targetStatus)) throw new Error("Choose a supported traceability status.");
  const reason = clean(input.reason);
  if (!reason || reason.length > 2000) throw new Error("Status-change reason is required and must be 2000 characters or fewer.");
  return { target_status: targetStatus, reason };
}

export function traceabilityStatusLabel(value) {
  const status = clean(value).toUpperCase();
  return status ? status.replaceAll("_", " ") : "UNKNOWN";
}

export function traceabilityUnitTypeLabel(value) {
  const type = clean(value).toUpperCase();
  return type ? type.replaceAll("_", " ") : "UNKNOWN";
}
