const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Enter the FactoryOS API origin first.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('API origin must be a valid absolute URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('API origin must use HTTPS (or HTTP on localhost for local development).');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('Non-local FactoryOS API connections must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter only the API origin, without credentials, path, query or fragment.');
  }
  return url.origin;
}

function unwrapApiResponse(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

function errorMessage(payload, status) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
    if (Array.isArray(payload.message)) return payload.message.filter(Boolean).join('; ');
    if (Array.isArray(payload.errors) && payload.errors.length) {
      return payload.errors.map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry.message === 'string') return entry.message;
        return '';
      }).filter(Boolean).join('; ');
    }
  }
  return `FactoryOS API request failed (HTTP ${status}).`;
}

function createRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  throw new Error('This browser does not provide a secure request-ID generator.');
}

/**
 * Creates an ephemeral, factory-scoped API client.
 * The access token is captured only by this in-memory client and is never
 * written to browser storage, cookies, logs, or URLs.
 */
export function createAiAgentControlCenterClient({
  apiOrigin,
  accessToken,
  tenantId,
  factoryId,
  fetchImpl = globalThis.fetch,
  idFactory = createRequestId,
}) {
  const origin = normalizeOrigin(apiOrigin);
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) throw new Error('Paste a valid bearer access token.');
  if (!UUID_PATTERN.test(String(tenantId ?? '').trim())) {
    throw new Error('Tenant ID must be a UUID.');
  }
  if (!UUID_PATTERN.test(String(factoryId ?? '').trim())) {
    throw new Error('Factory ID must be a UUID.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is unavailable in this browser.');
  }

  const base = `${origin}/api/v1`;
  const headersFor = (hasBody) => ({
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-tenant-id': tenantId.trim(),
    'x-factory-id': factoryId.trim(),
    'x-request-id': idFactory(),
    'x-trace-id': idFactory(),
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  });

  async function request(path, options = {}) {
    const method = options.method ?? 'GET';
    const hasBody = options.body !== undefined;
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: headersFor(hasBody),
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      cache: 'no-store',
      credentials: 'omit',
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(errorMessage(payload, response.status));
    }
    return unwrapApiResponse(payload);
  }

  const encoded = (value) => encodeURIComponent(String(value));

  return Object.freeze({
    listAgents: () => request('/ai/agents/catalogue'),
    listTasks: (limit = 50) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Task list limit must be an integer between 1 and 100.');
      }
      return request(`/ai/tasks?limit=${limit}`);
    },
    listWorkflowDrafts: () => request('/ai/agent-studio/workflow-drafts'),
    listTemplates: () => request('/ai/agent-studio/templates'),
    getAgent: (id) => request(`/ai/agents/catalogue/${encoded(id)}`),
    getAgentControl: (id) => request(`/ai/agents/catalogue/${encoded(id)}/control`),
    getEvaluationReport: (id) => request(`/ai/agents/catalogue/${encoded(id)}/evaluation-report`),
    getTask: (id) => request(`/ai/tasks/${encoded(id)}`),
    setAgentControl: (id, body) => request(`/ai/agents/catalogue/${encoded(id)}/control`, {
      method: 'POST',
      body,
    }),
    cancelTask: (id) => request(`/ai/tasks/${encoded(id)}/cancel`, { method: 'POST' }),
    executeStep: (taskId, stepId) => request(
      `/ai/tasks/${encoded(taskId)}/steps/${encoded(stepId)}/execute`,
      { method: 'POST' },
    ),
    resumeTaskStep: (taskId, stepId) => request(
      `/ai/tasks/${encoded(taskId)}/steps/${encoded(stepId)}/resume`,
      { method: 'POST' },
    ),
    verifyTask: (id) => request(`/ai/tasks/${encoded(id)}/verify`, { method: 'POST' }),
  });
}

export function isTerminalAgentTaskState(state) {
  return ['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(state);
}

export function canExecuteAgentStep(step, now = Date.now()) {
  if (!step || step.status !== 'PENDING') return false;
  if (!step.nextRetryAt) return true;
  const retryAt = Date.parse(step.nextRetryAt);
  return Number.isFinite(retryAt) && retryAt <= now;
}
