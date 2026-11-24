const DEVICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const DEVICE_GROUP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY = /(secret|password|credential|private.?key|api.?key|access.?token|refresh.?token|authorization|bearer)/i;
const PROTOCOLS = new Set(["OPC_UA", "MQTT", "MODBUS", "GENERIC"]);
const STATUSES = new Set(["ACTIVE", "PAUSED", "REVOKED"]);
const TARGETS = new Set(["FACTORY", "DEVICE", "DEVICE_GROUP", "USE_CASE"]);
const CONTROL_ACTIONS = new Set(["PAUSE", "RESUME", "REVOKE"]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedReason(value, minimum = 8, maximum = 300) {
  const reason = clean(value);
  if (reason.length < minimum || reason.length > maximum) {
    throw new Error("Reason must contain " + minimum + " to " + maximum + " characters.");
  }
  return reason;
}

function safeCapabilityProfile(value) {
  let profile = value;
  if (typeof value === "string") {
    try { profile = JSON.parse(value); }
    catch { throw new Error("Capability profile must be valid JSON."); }
  }
  if (!isRecord(profile)) throw new Error("Capability profile must be a JSON object.");
  let serialized;
  try { serialized = JSON.stringify(profile); }
  catch { throw new Error("Capability profile must be serializable JSON."); }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 4096) {
    throw new Error("Capability profile cannot exceed 4 KiB.");
  }
  for (const key of Object.keys(profile)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || SENSITIVE_KEY.test(key)) {
      throw new Error("Capability profile contains an unsafe or credential-like field.");
    }
  }
  return profile;
}

export function normalizeEdgeRows(value, preferredKey = "") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.rows)) return value.rows;
  if (value.data !== undefined) return normalizeEdgeRows(value.data, preferredKey);
  return [];
}

export function buildEdgeDevicePayload(input) {
  const deviceKey = clean(input.device_key);
  const displayName = clean(input.display_name);
  const protocol = clean(input.protocol).toUpperCase();
  const deviceGroup = clean(input.device_group);
  if (!DEVICE_KEY.test(deviceKey)) throw new Error("Device key must be a canonical identifier of at most 100 characters.");
  if (displayName.length < 2 || displayName.length > 180) throw new Error("Display name must contain 2 to 180 characters.");
  if (!PROTOCOLS.has(protocol)) throw new Error("Choose OPC_UA, MQTT, MODBUS or GENERIC.");
  if (deviceGroup && !DEVICE_GROUP.test(deviceGroup)) throw new Error("Device group contains unsupported characters.");
  const capabilityProfile = safeCapabilityProfile(input.capability_profile ?? {});
  return {
    device_key: deviceKey,
    display_name: displayName,
    protocol,
    ...(deviceGroup ? { device_group: deviceGroup } : {}),
    capability_profile: capabilityProfile,
  };
}

export function buildEdgeCredentialPayload(validForDays) {
  const days = Number(validForDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
    throw new Error("Credential validity must be an integer between 1 and 366 days.");
  }
  return { valid_for_days: days };
}

export function buildEdgeSigningKeyPayload(input) {
  const keyId = clean(input.key_id);
  const publicKey = clean(input.public_key_pem);
  const replacesKeyId = clean(input.replaces_key_id);
  if (!KEY_ID.test(keyId)) throw new Error("Key ID must be a canonical identifier of at most 128 characters.");
  if (publicKey.length < 80 || publicKey.length > 4096 ||
    !/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(publicKey) ||
    /PRIVATE KEY/i.test(publicKey)) {
    throw new Error("Provide a PEM-encoded public key only. Private-key material is not accepted.");
  }
  if (replacesKeyId && !KEY_ID.test(replacesKeyId)) {
    throw new Error("Replacement key ID contains unsupported characters.");
  }
  if (replacesKeyId === keyId) throw new Error("A signing key cannot replace itself.");
  return {
    key_id: keyId,
    public_key_pem: publicKey,
    ...(replacesKeyId ? { replaces_key_id: replacesKeyId } : {}),
  };
}

export function buildEdgePackageControlPayload(input) {
  const packageId = clean(input.package_id);
  const packageVersion = clean(input.package_version) || "*";
  const targetKind = clean(input.target_kind).toUpperCase();
  const action = clean(input.action).toUpperCase();
  const targetKeyInput = clean(input.target_key);
  const targetKey = targetKind === "FACTORY" ? "*" : targetKeyInput;
  if (!PACKAGE_ID.test(packageId)) throw new Error("Package ID must be a canonical identifier.");
  if (packageVersion !== "*" && !SAFE_VERSION.test(packageVersion)) {
    throw new Error("Package version must be '*' or a supported version identifier.");
  }
  if (!TARGETS.has(targetKind)) throw new Error("Choose a supported package-control target.");
  if (!CONTROL_ACTIONS.has(action)) throw new Error("Choose PAUSE, RESUME or REVOKE.");
  if (targetKind === "FACTORY" && targetKeyInput && targetKeyInput !== "*") {
    throw new Error("Factory-wide controls must use target key '*'.");
  }
  if (targetKind === "DEVICE" && !UUID.test(targetKey)) throw new Error("Device targets require a valid device UUID.");
  if (targetKind === "DEVICE_GROUP" && !DEVICE_GROUP.test(targetKey)) throw new Error("Device-group targets require a registered group identifier.");
  if (targetKind === "USE_CASE" && !DEVICE_GROUP.test(targetKey)) throw new Error("Use-case targets require a stable identifier.");
  return {
    package_id: packageId,
    package_version: packageVersion,
    target_kind: targetKind,
    target_key: targetKey,
    action,
    reason: boundedReason(input.reason),
  };
}

export function buildEdgeSigningKeyRevocationPayload(reason) {
  return { reason: boundedReason(reason) };
}

export function filterEdgeDevices(rows = [], search = "", status = "ALL", protocol = "ALL") {
  const needle = clean(search).toLowerCase();
  return rows.filter((device) => {
    const statusMatch = status === "ALL" || String(device.status ?? "").toUpperCase() === status;
    const protocolMatch = protocol === "ALL" || String(device.protocol ?? "").toUpperCase() === protocol;
    const searchable = [device.displayName, device.deviceKey, device.deviceGroup, device.protocol]
      .filter((value) => typeof value === "string").join(" ").toLowerCase();
    return statusMatch && protocolMatch && (!needle || searchable.includes(needle));
  });
}

export function summarizeEdgeDevices(rows = []) {
  const summary = { total: rows.length, active: 0, paused: 0, revoked: 0, healthy: 0, attention: 0, neverSeen: 0 };
  for (const device of rows) {
    const status = String(device.status ?? "").toUpperCase();
    if (status === "ACTIVE") summary.active += 1;
    else if (status === "PAUSED") summary.paused += 1;
    else if (status === "REVOKED") summary.revoked += 1;
    const health = String(device.latestHealth?.runtimeStatus ?? "").toUpperCase();
    if (health === "HEALTHY") summary.healthy += 1;
    else if (health === "DEGRADED" || health === "NEEDS_ATTENTION") summary.attention += 1;
    if (!device.lastSeenAt) summary.neverSeen += 1;
  }
  return summary;
}

export function isEdgeUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

export function safeEdgePayloadPreview(value, maxLength = 180) {
  if (!isRecord(value)) return "Payload is not available as a safe object preview.";
  const keys = Object.keys(value);
  const safe = {};
  for (const key of keys.slice(0, 12)) {
    if (SENSITIVE_KEY.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) continue;
    const item = value[key];
    if (["string", "number", "boolean"].includes(typeof item) || item === null) safe[key] = item;
    else safe[key] = Array.isArray(item) ? "[array]" : "[object]";
  }
  let serialized = JSON.stringify(safe);
  if (serialized.length > maxLength) serialized = serialized.slice(0, maxLength - 1) + "…";
  return serialized;
}
