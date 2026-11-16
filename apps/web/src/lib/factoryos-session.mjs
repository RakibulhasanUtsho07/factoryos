const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DEV_SESSION_KEY = "factoryos.local-dev-session.v1";

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

function isLocalDevelopmentOrigin(apiOrigin) {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return false;
  try {
    const url = new URL(apiOrigin);
    return url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function localDevelopmentStorage(apiOrigin) {
  if (!isLocalDevelopmentOrigin(apiOrigin)) return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function tokenExpiry(token) {
  const payloadPart = typeof token === "string" ? token.split(".")[1] : "";
  if (!payloadPart) return 0;
  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const payload = JSON.parse(decoded);
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function persistLocalDevelopmentSession(apiOrigin, tenantId, accessToken) {
  const storage = localDevelopmentStorage(apiOrigin);
  if (!storage) return;
  const expiresAt = tokenExpiry(accessToken);
  if (!expiresAt || expiresAt <= Date.now() + 30_000) {
    storage.removeItem(LOCAL_DEV_SESSION_KEY);
    return;
  }
  try {
    storage.setItem(LOCAL_DEV_SESSION_KEY, JSON.stringify({
      apiOrigin,
      tenantId,
      accessToken,
      expiresAt,
    }));
  } catch {
    // Storage may be unavailable or disabled; the current in-memory session still works.
  }
}

function clearLocalDevelopmentSession(apiOrigin) {
  const storage = localDevelopmentStorage(apiOrigin);
  if (!storage) return;
  try {
    storage.removeItem(LOCAL_DEV_SESSION_KEY);
  } catch {
    // Ignore storage failures during explicit disconnect.
  }
}

/**
 * Returns a saved session only for local Next.js development and a localhost API.
 * Production and remote HTTPS sessions are never read from browser storage.
 */
export function readLocalDevelopmentSession() {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(LOCAL_DEV_SESSION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const apiOrigin = normalizeApiOrigin(saved.apiOrigin);
    const tenantId = String(saved.tenantId ?? "").trim().toLowerCase();
    const accessToken = typeof saved.accessToken === "string" ? saved.accessToken : "";
    const expiresAt = tokenExpiry(accessToken);
    if (
      !isLocalDevelopmentOrigin(apiOrigin)
      || !UUID_PATTERN.test(tenantId)
      || !expiresAt
      || expiresAt <= Date.now() + 30_000
    ) {
      window.sessionStorage.removeItem(LOCAL_DEV_SESSION_KEY);
      return null;
    }
    return { apiOrigin, tenantId, accessToken };
  } catch {
    try {
      window.sessionStorage.removeItem(LOCAL_DEV_SESSION_KEY);
    } catch {
      // Ignore unavailable storage.
    }
    return null;
  }
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
 * Creates a read-only session client. In local Next.js development only,
 * localhost bearer sessions are retained in sessionStorage for this tab so
 * page refreshes do not force another manual token entry. Production and
 * remote API sessions remain memory-only.
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

  persistLocalDevelopmentSession(origin, selectedTenantId, bearerToken);

  async function request(path, options = {}) {
    if (!bearerToken) {
      throw new Error("This FactoryOS session has been cleared. Connect again.");
    }
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error("FactoryOS API paths must be absolute API-relative paths.");
    }

    const method = options.method ?? "GET";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new Error("Unsupported FactoryOS API method.");
    }
    const factoryId = options.factoryId === undefined || options.factoryId === null
      ? ""
      : String(options.factoryId).trim().toLowerCase();
    if (factoryId && !UUID_PATTERN.test(factoryId)) {
      throw new Error("Factory context must be a valid UUID.");
    }
    const hasBody = options.body !== undefined;
    const headers = {
      accept: "application/json",
      authorization: "Bearer " + bearerToken,
      "x-tenant-id": selectedTenantId,
      "x-request-id": idFactory(),
      "x-trace-id": idFactory(),
      ...(factoryId ? { "x-factory-id": factoryId } : {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    };
    const response = await fetchImpl(origin + "/api" + path, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
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

  async function get(path) {
    return request(path);
  }

  return Object.freeze({
    getCurrentUser: () => get("/auth/me"),
    getAccess: () => get("/iam/access"),
    listFactories: () => get("/iam/factories"),
    request,
    clear: () => {
      bearerToken = "";
      clearLocalDevelopmentSession(origin);
    },
  });
}
