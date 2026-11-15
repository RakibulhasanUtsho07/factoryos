"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";

const navigationGroups = [
  {
    label: "WORKSPACE",
    items: [
      { href: "/", label: "Overview", short: "OV" },
      { href: "/wms", label: "Warehouse", short: "WH" },
      { href: "/ai/agents", label: "AI Control Center", short: "AI" },
    ],
  },
  {
    label: "DEVICE ACCEPTANCE",
    items: [
      { href: "/wms/browser-acceptance", label: "Browser HIL", short: "BH" },
      { href: "/wms/rfid", label: "RFID Workbench", short: "RF" },
    ],
  },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

export function WorkspaceNavigation() {
  const pathname = usePathname();
  const { status, snapshot, activeFactoryId, selectFactory, disconnect } = useFactoryOsSession();
  const connected = status === "connected" && snapshot !== null;
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);

  const navigationLinks = (
    <nav aria-label="Primary workspace navigation" className="space-y-6">
      {navigationGroups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.2em] text-slate-500">
            {group.label}
          </p>
          <div className="space-y-1">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "group flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300",
                    active
                      ? "bg-white/10 text-white shadow-sm ring-1 ring-inset ring-white/10"
                      : "text-slate-400 hover:bg-white/[0.06] hover:text-white",
                  ].join(" ")}
                >
                  <span
                    aria-hidden="true"
                    className={[
                      "flex size-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold tracking-wide",
                      active ? "bg-cyan-300 text-slate-950" : "bg-white/[0.07] text-slate-400 group-hover:text-white",
                    ].join(" ")}
                  >
                    {item.short}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {active ? <span aria-hidden="true" className="size-1.5 rounded-full bg-cyan-300" /> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      <aside className="hidden w-[272px] shrink-0 flex-col border-r border-slate-800 bg-[#101b2b] text-white md:sticky md:top-0 md:flex md:h-screen">
        <div className="flex items-center gap-3 border-b border-white/10 px-6 py-6">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-cyan-300 text-lg font-black tracking-tight text-slate-950 shadow-lg shadow-cyan-950/20">
            F
          </span>
          <span className="min-w-0">
            <span className="block text-base font-bold tracking-tight">FactoryOS</span>
            <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Operations platform
            </span>
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-7">
          {navigationLinks}
        </div>

        <div className="border-t border-white/10 p-4">
          {connected && snapshot ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-4">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-emerald-400" />
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300">
                  Session connected
                </p>
              </div>
              <p className="mt-3 truncate text-sm font-semibold text-white">{snapshot.user.displayName}</p>
              <p className="mt-1 truncate text-xs text-slate-400">{snapshot.tenant.name}</p>
              <label className="mt-4 block text-[10px] font-semibold uppercase tracking-wider text-slate-400" htmlFor="workspace-factory-context">
                Factory context
              </label>
              <select
                id="workspace-factory-context"
                value={activeFactoryId}
                onChange={(event) => selectFactory(event.target.value)}
                className="mt-2 min-h-10 w-full rounded-lg border border-white/10 bg-[#17263a] px-2.5 text-xs font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                <option value="">No factory selected</option>
                {snapshot.factories.map((factory) => (
                  <option key={factory.id} value={factory.id} disabled={factory.status.toUpperCase() !== "ACTIVE"}>
                    {factory.code} · {factory.name}
                  </option>
                ))}
              </select>
              {activeFactory ? (
                <p className="mt-2 text-[10px] leading-4 text-slate-400">
                  Display context only · {activeFactory.code}
                </p>
              ) : null}
              <button
                type="button"
                onClick={disconnect}
                className="mt-3 min-h-9 w-full rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                Disconnect session
              </button>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-4">
              <p className="text-sm font-semibold text-white">Connect your workspace</p>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                Use an existing authorized FactoryOS session to load your tenant context.
              </p>
              <Link
                href="/session"
                className="mt-4 flex min-h-10 items-center justify-center rounded-lg bg-cyan-300 px-3 text-xs font-bold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200"
              >
                {status === "connecting" ? "Connecting…" : "Connect session"}
              </Link>
            </div>
          )}
          <p className="mt-4 px-1 text-[10px] leading-4 text-slate-500">
            FactoryOS · Governed manufacturing operations
          </p>
        </div>
      </aside>

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur md:hidden">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
            <span className="flex size-9 items-center justify-center rounded-xl bg-[#101b2b] text-sm font-black text-cyan-300">F</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-950">FactoryOS</span>
              <span className="block text-[10px] text-slate-500">Operations platform</span>
            </span>
          </Link>
          {connected ? (
            <button type="button" onClick={disconnect} className="min-h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700">
              Disconnect
            </button>
          ) : (
            <Link href="/session" className="inline-flex min-h-9 items-center rounded-lg bg-slate-950 px-3 text-xs font-semibold text-white">
              {status === "connecting" ? "Connecting…" : "Connect"}
            </Link>
          )}
        </div>
        {connected && snapshot ? (
          <div className="mt-3 flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-600">
              {snapshot.tenant.name}{activeFactory ? " · " + activeFactory.code : ""}
            </span>
            <label className="sr-only" htmlFor="mobile-factory-context">Factory context</label>
            <select id="mobile-factory-context" value={activeFactoryId} onChange={(event) => selectFactory(event.target.value)} className="min-h-8 max-w-36 rounded-lg border border-slate-200 bg-white px-2 text-[11px] text-slate-700">
              <option value="">No factory</option>
              {snapshot.factories.map((factory) => (
                <option key={factory.id} value={factory.id} disabled={factory.status.toUpperCase() !== "ACTIVE"}>
                  {factory.code} · {factory.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="mt-3 -mx-1 overflow-x-auto px-1 pb-0.5">
          <div className="flex min-w-max gap-1">
            {navigationGroups.flatMap((group) => group.items).map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold",
                    active ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100",
                  ].join(" ")}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </header>
    </>
  );
}
