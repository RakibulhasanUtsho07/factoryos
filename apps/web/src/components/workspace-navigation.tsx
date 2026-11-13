"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/", label: "Overview", group: "Workspace" },
  { href: "/wms", label: "Warehouse", group: "Operations" },
  { href: "/wms/browser-acceptance", label: "Browser HIL", group: "Operations" },
  { href: "/wms/rfid", label: "RFID HIL", group: "Operations" },
  { href: "/ai/agents", label: "AI Agents", group: "Intelligence" },
] as const;

export default function WorkspaceNavigation() {
  const pathname = usePathname();

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <Link
          href="/"
          aria-label="FactoryOS overview"
          className="flex w-fit items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-xl bg-slate-950 text-sm font-bold text-white shadow-sm"
          >
            F
          </span>
          <span className="min-w-0">
            <span className="block text-base font-bold tracking-tight text-slate-950">
              FactoryOS
            </span>
            <span className="block text-xs text-slate-500">
              Manufacturing operations
            </span>
          </span>
        </Link>

        <nav
          aria-label="Primary navigation"
          className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:pb-0"
        >
          {navigation.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "inline-flex min-h-10 shrink-0 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2",
                  active
                    ? "bg-slate-950 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="h-px bg-gradient-to-r from-blue-600 via-cyan-500 to-transparent" />
    </header>
  );
}
