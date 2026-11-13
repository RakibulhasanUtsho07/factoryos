const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeApiOrigin(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("FactoryOS API origin is required.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("FactoryOS API origin must be an absolute URL.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const isLocal = localHosts.has(url.hostname);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("FactoryOS API origin must use HTTPS except on localhost.");
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter only the API origin, without credentials, path, query or fragment.");
  }

  return url.origin;
}

function responseMessage(payload, status) {
  if (payload && typeof payload === "object") {
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }

    if (Array.isArray(payload.message)) {
      const messages = payload.message.filter((entry) => typeof entry === "string" && entry.trim());
      if (messages.length) return messages.join("; ");
    }

    if (Array.isArray(payload.errors)) {
      const messages = payload.errors
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry.message === "string") return entry.message;
          return "";
        })
        .filter(Boolean);
      if (messages.length) return messages.join("; ");
    }
  }

  return "FactoryOS request failed with HTTP " + status + ".";
}

function unwrapResponse(payload) {
  if (payload && typeof payload === "object"
    && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload.data;
  }
  return payload;
}

function secureRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  throw new Error("A secure request-ID generator is unavailable.");
}

export class FactoryOsSessionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "FactoryOsSessionError";
    this.status = status;
    this.code = status === 401
      ? "UNAUTHENTICATED"
      : status === 403
        ? "ACCESS_DENIED"
        : "API_REQUEST_FAILED";
  }
}

/**
 * Creates an in-memory, read-only session bootstrap client.
 * The caller supplies a short-lived bearer token; this module never persists it.
 * The backend remains authoritative for identity, tenant membership and permissions.
 */
export function createFactoryOsSessionClient({
  apiOrigin,
  accessToken,
  tenantId,
  fetchImpl = globalThis.fetch,
  idFactory = secureRequestId,
}) {
  const origin = normalizeApiOrigin(apiOrigin);
  let bearerToken = typeof accessToken === "string" ? accessToken.trim() : "";

  if (!bearerToken) {
    throw new Error("A short-lived bearer access token is required.");
  }

  const selectedTenantId = String(tenantId ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(selectedTenantId)) {
    throw new Error("Tenant ID must be a valid UUID.");
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is unavailable in this browser.");
  }

  async function get(path) {
    if (!bearerToken) {
      throw new Error("This FactoryOS session has been cleared. Connect again.");
    }

    const response = await fetchImpl(origin + "/api" + path, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer " + bearerToken,
        "x-tenant-id": selectedTenantId,
        "x-request-id": idFactory(),
        "x-trace-id": idFactory(),
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new FactoryOsSessionError(responseMessage(payload, response.status), response.status);
    }

    return unwrapResponse(payload);
  }

  return Object.freeze({
    getCurrentUser: () => get("/auth/me"),
    getAccess: () => get("/iam/access"),
    listFactories: () => get("/iam/factories"),
    clear: () => {
      bearerToken = "";
    },
  });
}
