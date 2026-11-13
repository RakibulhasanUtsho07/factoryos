"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";

const navigation = [
  { href: "/", label: "Overview" },
  { href: "/wms", label: "Warehouse" },
  { href: "/wms/browser-acceptance", label: "Browser HIL" },
  { href: "/wms/rfid", label: "RFID HIL" },
  { href: "/ai/agents", label: "AI Agents" },
] as const;

export function WorkspaceNavigation() {
  const pathname = usePathname();
  const {
    status,
    snapshot,
    activeFactoryId,
    selectFactory,
    disconnect,
  } = useFactoryOsSession();

  const connected = status === "connected" && snapshot !== null;
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Link
            href="/"
            aria-label="FactoryOS overview"
            className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-sm font-bold text-white">
              F
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold tracking-tight text-slate-950">FactoryOS</span>
              <span className="block truncate text-[11px] text-slate-500">Manufacturing operations</span>
            </span>
          </Link>

          <div className="flex min-w-0 items-center justify-end gap-2">
            {connected && snapshot ? (
              <>
                <div className="hidden min-w-0 text-right sm:block">
                  <p className="max-w-48 truncate text-xs font-semibold text-slate-900">
                    {snapshot.user.displayName}
                  </p>
                  <p className="max-w-48 truncate text-[11px] text-slate-500">
                    {snapshot.tenant.name}
                  </p>
                </div>
                <label className="sr-only" htmlFor="workspace-factory-context">
                  Active factory context
                </label>
                <select
                  id="workspace-factory-context"
                  value={activeFactoryId}
                  onChange={(event) => selectFactory(event.target.value)}
                  className="min-h-9 max-w-44 rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 sm:max-w-56 sm:px-3"
                >
                  <option value="">No factory selected</option>
                  {snapshot.factories.map((factory) => (
                    <option
                      key={factory.id}
                      value={factory.id}
                      disabled={factory.status.toUpperCase() !== "ACTIVE"}
                    >
                      {factory.code} · {factory.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={disconnect}
                  className="min-h-9 shrink-0 rounded-lg border border-slate-300 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 sm:px-3"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <Link
                href="/session"
                className="inline-flex min-h-9 items-center rounded-lg bg-blue-700 px-3 text-xs font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              >
                {status === "connecting" ? "Connecting…" : "Connect session"}
              </Link>
            )}
          </div>
        </div>

        <nav
          aria-label="Primary workspace navigation"
          className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 pb-1"
        >
          {navigation.map((item) => {
            const active = item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "inline-flex min-h-9 shrink-0 items-center rounded-lg px-3 text-xs font-semibold transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700",
                  active
                    ? "bg-slate-950 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/session"
            aria-current={pathname === "/session" ? "page" : undefined}
            className={[
              "inline-flex min-h-9 shrink-0 items-center rounded-lg px-3 text-xs font-semibold transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700",
              pathname === "/session" ? "bg-blue-50 text-blue-800" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
            ].join(" ")}
          >
            Session
          </Link>
        </nav>
      </div>
      {connected && activeFactory ? (
        <div className="border-t border-emerald-100 bg-emerald-50/70 px-4 py-1.5 text-center text-[11px] font-medium text-emerald-900 sm:px-6 lg:px-8">
          Verified tenant context: {snapshot?.tenant.slug} · Active factory: {activeFactory.code}
        </div>
      ) : null}
    </header>
  );
}
