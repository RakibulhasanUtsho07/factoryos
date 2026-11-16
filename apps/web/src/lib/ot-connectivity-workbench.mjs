const OT_DEVICE_STATUSES = Object.freeze([
  "PENDING_REVIEW",
  "ACTIVE",
  "PAUSED",
  "REVOKED",
]);
const OT_PROTOCOLS = Object.freeze(["OPC_UA", "MQTT", "MODBUS_TCP"]);
const OT_DELIVERY_STATUSES = Object.freeze(["ON_TIME", "LATE", "SEQUENCE_GAP"]);
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

function deviceUuid(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error("OT device ID must be a valid UUID.");
  }
  return normalized;
}

function boundedLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error(label + " must be an integer between 1 and 200.");
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

export function createOtConnectivityClient({ request }) {
  const sessionRequest = requiredRequest(request);

  return Object.freeze({
    async listDevices({ status: statusInput, protocol: protocolInput } = {}) {
      const status = enumValue(statusInput, OT_DEVICE_STATUSES, "OT device status");
      const protocol = enumValue(protocolInput, OT_PROTOCOLS, "OT protocol");
      return sessionRequest("/ot/devices" + queryString([
        ["status", status],
        ["protocol", protocol],
      ]));
    },

    async getDevice({ deviceId: deviceIdInput } = {}) {
      const deviceId = deviceUuid(deviceIdInput);
      return sessionRequest("/ot/devices/" + deviceId);
    },

    async listHistory({ deviceId: deviceIdInput } = {}) {
      const deviceId = deviceUuid(deviceIdInput);
      return sessionRequest("/ot/devices/" + deviceId + "/history");
    },

    async listTelemetry({ deviceId: deviceIdInput, limit = 100 } = {}) {
      const deviceId = deviceUuid(deviceIdInput);
      const bounded = boundedLimit(limit, "Telemetry limit");
      return sessionRequest("/ot/devices/" + deviceId + "/telemetry" + queryString([
        ["limit", bounded],
      ]));
    },
  });
}

export const otDeviceStatuses = OT_DEVICE_STATUSES;
export const otProtocols = OT_PROTOCOLS;
export const otDeliveryStatuses = OT_DELIVERY_STATUSES;
