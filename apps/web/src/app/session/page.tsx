"use client";

import { useState, type FormEvent } from "react";

import {
  useFactoryOsSession,
} from "@/components/auth/factoryos-session-provider";

export default function WorkspaceSessionPage() {
  const {
    status,
    error,
    snapshot,
    activeFactoryId,
    connect,
    disconnect,
    selectFactory,
    hasPermission,
  } = useFactoryOsSession();

  const [apiOrigin, setApiOrigin] = useState(
    process.env.NEXT_PUBLIC_FACTORYOS_API_URL ?? "http://localhost:3001",
  );
  const [tenantId, setTenantId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setLocalError("");
    try {
      await connect({ apiOrigin, tenantId, accessToken });
      setAccessToken("");
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Connection failed.");
      setAccessToken("");
    } finally {
      setBusy(false);
    }
  }

  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <header className="mb-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
          Workspace identity
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
          Connect FactoryOS session
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Validate an existing short-lived bearer session with the FactoryOS API.
          This page does not issue development tokens or replace your organization&apos;s
          approved OIDC sign-in.
        </p>
      </header>

      {snapshot ? (
        <section className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm" aria-labelledby="session-status">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
                Authenticated API session
              </span>
              <h2 id="session-status" className="mt-3 text-xl font-semibold text-slate-950">
                {snapshot.user.displayName}
              </h2>
              <p className="text-sm text-slate-600">{snapshot.user.email ?? snapshot.user.id}</p>
            </div>
            <button
              type="button"
              onClick={disconnect}
              className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              Disconnect
            </button>
          </div>

          <dl className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tenant</dt>
              <dd className="mt-1 font-semibold text-slate-900">{snapshot.tenant.name}</dd>
              <dd className="text-xs text-slate-500">{snapshot.tenant.slug}</dd>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Membership</dt>
              <dd className="mt-1 font-semibold text-slate-900">{snapshot.membership.status}</dd>
              <dd className="text-xs text-slate-500">{snapshot.membership.id}</dd>
            </div>
          </dl>

          <div className="mt-6">
            <label htmlFor="active-factory" className="block text-sm font-semibold text-slate-800">
              Active factory context
            </label>
            <select
              id="active-factory"
              value={activeFactoryId}
              onChange={(event) => selectFactory(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              <option value="">No active factory selected</option>
              {snapshot.factories.map((factory) => (
                <option
                  key={factory.id}
                  value={factory.id}
                  disabled={factory.status.toUpperCase() !== "ACTIVE"}
                >
                  {factory.code} — {factory.name} ({factory.status})
                </option>
              ))}
            </select>
            {activeFactory ? (
              <p className="mt-2 text-xs text-slate-500">
                Selected scope: {activeFactory.code} · {activeFactory.timezone ?? snapshot.tenant.timezone}
              </p>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                No active factory is currently selected. Factory-scoped operations must remain unavailable.
              </p>
            )}
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Tenant roles</h3>
              {snapshot.roles.length ? (
                <ul className="mt-3 space-y-2">
                  {snapshot.roles.map((role) => (
                    <li key={role.id} className="flex flex-wrap justify-between gap-2 text-sm">
                      <span className="font-medium text-slate-800">{role.name}</span>
                      <span className="text-xs text-slate-500">{role.code}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No role records were returned.</p>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Permission snapshot</h3>
              <p className="mt-2 text-2xl font-semibold text-slate-950">{snapshot.permissions.length}</p>
              <p className="text-xs text-slate-500">Permissions returned by IAM for display only.</p>
              <p className="mt-3 text-xs text-slate-600">
                {hasPermission("iam.access.read")
                  ? "IAM access-read capability is present."
                  : "IAM access-read capability is not listed."}
              </p>
            </div>
          </div>

          <p className="mt-5 rounded-lg bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
            This in-memory context helps the UI present the current tenant and factory.
            It is not an authorization grant. Every API operation must still pass the backend&apos;s
            JWT, tenant, factory and permission checks.
          </p>
        </section>
      ) : (
        <form onSubmit={handleConnect} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-5">
            <div>
              <label htmlFor="api-origin" className="block text-sm font-semibold text-slate-800">
                FactoryOS API origin
              </label>
              <input
                id="api-origin"
                type="url"
                required
                autoComplete="url"
                value={apiOrigin}
                onChange={(event) => setApiOrigin(event.target.value)}
                placeholder="https://factory-api.example.com"
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              />
            </div>
            <div>
              <label htmlFor="tenant-id" className="block text-sm font-semibold text-slate-800">
                Tenant UUID
              </label>
              <input
                id="tenant-id"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                value={tenantId}
                onChange={(event) => setTenantId(event.target.value)}
                placeholder="00000000-0000-4000-8000-000000000000"
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              />
            </div>
            <div>
              <label htmlFor="access-token" className="block text-sm font-semibold text-slate-800">
                Existing short-lived bearer token
              </label>
              <input
                id="access-token"
                type="password"
                required
                autoComplete="off"
                spellCheck={false}
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                placeholder="Paste a token issued by your approved identity provider"
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              />
              <p className="mt-2 text-xs leading-5 text-slate-500">
                The token is held in memory only, is not written to browser storage or cookies,
                and is cleared from the form after the connection attempt.
              </p>
            </div>

            {localError || error ? (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                {localError || error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={busy || status === "connecting"}
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy || status === "connecting" ? "Checking session…" : "Connect existing session"}
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
