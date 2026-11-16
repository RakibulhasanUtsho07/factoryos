import test from "node:test";
import assert from "node:assert/strict";

import {
  createFactoryOsSessionClient,
  FactoryOsSessionError,
  readLocalDevelopmentSession,
} from "./factoryos-session.mjs";

const tenantId = "a1000000-0000-4000-8000-000000000001";
const token = "short-lived-test-access-token";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function makeJwt(expiresInSeconds = 3600) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })).toString("base64url");
  return "header." + payload + ".signature";
}

function withLocalSessionStorage(run) {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  process.env.NODE_ENV = "development";
  try {
    return run(values);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("session client rejects insecure or credential-bearing API origins", () => {
  const config = { accessToken: token, tenantId, fetchImpl: async () => response({ data: {} }) };
  assert.throws(() => createFactoryOsSessionClient({ ...config, apiOrigin: "http://api.factoryos.example" }), /HTTPS/);
  assert.throws(() => createFactoryOsSessionClient({ ...config, apiOrigin: "https://user:pass@api.factoryos.example" }), /origin/);
  assert.throws(() => createFactoryOsSessionClient({ ...config, apiOrigin: "https://api.factoryos.example/api" }), /origin/);
});

test("session client accepts localhost HTTP for local development", () => {
  const client = createFactoryOsSessionClient({
    apiOrigin: "http://localhost:3001",
    accessToken: token,
    tenantId,
    fetchImpl: async () => response({ data: { authenticated: true } }),
  });
  assert.equal(typeof client.getCurrentUser, "function");
  client.clear();
});

test("session client requires bearer token and valid tenant UUID", () => {
  assert.throws(() => createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: " ",
    tenantId,
    fetchImpl: async () => response({ data: {} }),
  }), /bearer/);

  assert.throws(() => createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: token,
    tenantId: "not-a-uuid",
    fetchImpl: async () => response({ data: {} }),
  }), /Tenant ID/);
});

test("identity and access bootstrap use verified bearer identity and requested tenant only", async () => {
  const calls = [];
  const client = createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: token,
    tenantId,
    idFactory: (() => {
      let index = 0;
      return () => "request-" + (++index);
    })(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ api_version: "v1", data: { authenticated: true } });
    },
  });

  const currentUser = await client.getCurrentUser();
  const access = await client.getAccess();
  const factories = await client.listFactories();

  assert.deepEqual(currentUser, { authenticated: true });
  assert.deepEqual(access, { authenticated: true });
  assert.deepEqual(factories, { authenticated: true });
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.factoryos.example/api/auth/me",
    "https://api.factoryos.example/api/iam/access",
    "https://api.factoryos.example/api/iam/factories",
  ]);

  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.headers.authorization, "Bearer " + token);
    assert.equal(options.headers["x-tenant-id"], tenantId);
    assert.ok(options.headers["x-request-id"]);
    assert.ok(options.headers["x-trace-id"]);
    assert.equal(options.headers["x-user-id"], undefined);
    assert.equal(options.headers["x-factory-id"], undefined);
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
  }
});

test("session client distinguishes unauthenticated and forbidden API responses", async () => {
  const unauthorized = createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: token,
    tenantId,
    fetchImpl: async () => response({ message: "Authentication required" }, 401),
  });
  await assert.rejects(
    unauthorized.getCurrentUser(),
    (error) => error instanceof FactoryOsSessionError
      && error.status === 401
      && error.code === "UNAUTHENTICATED"
      && !error.message.includes(token),
  );

  const forbidden = createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: token,
    tenantId,
    fetchImpl: async () => response({ message: "Missing permission" }, 403),
  });
  await assert.rejects(
    forbidden.getAccess(),
    (error) => error instanceof FactoryOsSessionError
      && error.status === 403
      && error.code === "ACCESS_DENIED",
  );
});

test("workspace requests retain server-verified bearer identity and attach only selected factory context", async () => {
  const calls = [];
  const client = createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: token,
    tenantId,
    idFactory: (() => {
      let index = 0;
      return () => "trace-" + (++index);
    })(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ data: { accepted: true } });
    },
  });

  const result = await client.request("/v1/ai/tasks?limit=25", {
    method: "POST",
    factoryId: "a2000000-0000-4000-8000-000000000002",
    body: { goal: "read-only test" },
  });
  assert.deepEqual(result, { accepted: true });
  assert.equal(calls[0].url, "https://api.factoryos.example/api/v1/ai/tasks?limit=25");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer " + token);
  assert.equal(calls[0].options.headers["x-tenant-id"], tenantId);
  assert.equal(calls[0].options.headers["x-factory-id"], "a2000000-0000-4000-8000-000000000002");
  assert.equal(calls[0].options.headers["x-user-id"], undefined);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.cache, "no-store");
  assert.deepEqual(JSON.parse(calls[0].options.body), { goal: "read-only test" });
});

test("workspace requests reject invalid paths, methods and factory context before network access", async () => {
  let called = false;
  const client = createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: token,
    tenantId,
    fetchImpl: async () => {
      called = true;
      return response({ data: {} });
    },
  });
  await assert.rejects(client.request("//evil.example/path"), /API-relative paths/);
  await assert.rejects(client.request("/v1/ai/tasks", { method: "TRACE" }), /Unsupported/);
  await assert.rejects(client.request("/v1/ai/tasks", { factoryId: "not-a-uuid" }), /factory context/i);
  assert.equal(called, false);
});

test("local development sessions survive a page reload in the same tab and are removed on disconnect", () => {
  withLocalSessionStorage((values) => {
    const accessToken = makeJwt(12 * 60 * 60);
    const client = createFactoryOsSessionClient({
      apiOrigin: "http://localhost:3001",
      accessToken,
      tenantId,
      fetchImpl: async () => response({ data: {} }),
    });

    const saved = JSON.parse(values.get("factoryos.local-dev-session.v1"));
    assert.equal(saved.apiOrigin, "http://localhost:3001");
    assert.equal(saved.tenantId, tenantId);
    assert.equal(saved.accessToken, accessToken);
    assert.deepEqual(readLocalDevelopmentSession(), {
      apiOrigin: "http://localhost:3001",
      tenantId,
      accessToken,
    });

    client.clear();
    assert.equal(values.has("factoryos.local-dev-session.v1"), false);
    assert.equal(readLocalDevelopmentSession(), null);
  });
});

test("expired local development sessions are discarded instead of restored", () => {
  withLocalSessionStorage((values) => {
    const expiredToken = makeJwt(-60);
    values.set("factoryos.local-dev-session.v1", JSON.stringify({
      apiOrigin: "http://localhost:3001",
      tenantId,
      accessToken: expiredToken,
      expiresAt: Date.now() - 60_000,
    }));
    assert.equal(readLocalDevelopmentSession(), null);
    assert.equal(values.has("factoryos.local-dev-session.v1"), false);
  });
});

test("remote HTTPS sessions are never persisted, even in local development", () => {
  withLocalSessionStorage((values) => {
    const client = createFactoryOsSessionClient({
      apiOrigin: "https://api.factoryos.example",
      accessToken: makeJwt(),
      tenantId,
      fetchImpl: async () => response({ data: {} }),
    });
    assert.equal(values.size, 0);
    client.clear();
    assert.equal(values.size, 0);
  });
});

test("clearing a session removes its in-memory bearer token", async () => {
  const calls = [];
  const client = createFactoryOsSessionClient({
    apiOrigin: "https://api.factoryos.example",
    accessToken: token,
    tenantId,
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return response({ data: { authenticated: true } });
    },
  });

  await client.getCurrentUser();
  client.clear();
  await assert.rejects(client.getCurrentUser(), /session has been cleared/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer " + token);
});
