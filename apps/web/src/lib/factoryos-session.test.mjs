import test from "node:test";
import assert from "node:assert/strict";

import {
  createFactoryOsSessionClient,
  FactoryOsSessionError,
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
