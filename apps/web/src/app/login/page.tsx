"use client";

import { useEffect, useState, type FormEvent } from "react";

const MESSAGES: Record<string, string> = {
  tenant: "Tenant UUID ta thik moto dao.",
  callback: "Login sesh kora jay nai, abar try koro.",
  state: "Login-er somoy kichu gondogol hoise, abar try koro.",
  exchange: "Auth0-r sathe jogajog kora jay nai, abar try koro.",
  verify: "Login verify kora jay nai — MFA sesh korso kina check koro.",
};

export default function LoginPage() {
  const [tenantId, setTenantId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setError(new URLSearchParams(window.location.search).get("error") ?? "");
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    window.location.href = "/auth/login?tenant=" + encodeURIComponent(tenantId.trim());
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 py-16 text-slate-900">
      <header className="mb-8 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
          FactoryOS
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
          Sign in
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Tomar tenant UUID dao, tarpor Auth0 diye sign in koro. Password ekhane
          dite hobe na — password ar MFA Auth0-tei hobe.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
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

        {error && MESSAGES[error] ? (
          <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {MESSAGES[error]}
          </div>
        ) : null}

        <button
          type="submit"
          className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        >
          Sign in with Auth0
        </button>
      </form>
    </main>
  );
}