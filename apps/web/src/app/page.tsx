import Link from "next/link";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";

const workspaces = [
  {
    href: "/wms",
    code: "WH",
    eyebrow: "OPERATIONS · WP02",
    title: "Warehouse management",
    description:
      "Run warehouse workflows with offline-first stock movements, traceability labels, barcode resolution and scoped scan operations.",
    capabilities: ["Stock movement queue", "Traceability & labels", "Barcode / QR resolution"],
    accent: "bg-cyan-100 text-cyan-900",
  },
  {
    href: "/ai/agents",
    code: "AI",
    eyebrow: "INTELLIGENCE · GOVERNED",
    title: "AI Agent Control Center",
    description:
      "Review factory-scoped agents, inspect task evidence, manage permitted controls and handle approval-gated execution steps.",
    capabilities: ["Agent catalogue", "Task & approval evidence", "Evaluation workspace"],
    accent: "bg-violet-100 text-violet-900",
  },
];

const acceptanceWorkspaces = [
  {
    href: "/wms/browser-acceptance",
    code: "01",
    title: "Browser acceptance",
    description: "Validate offline queue recovery, concurrency and browser-side operational behavior.",
  },
  {
    href: "/wms/rfid",
    code: "02",
    title: "RFID workbench",
    description: "Run USB-serial RFID capture and hardware-in-the-loop acceptance workflows.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 py-7 sm:px-7 sm:py-9 lg:px-10 lg:py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-brand-700">
            Factory operations
          </p>
          <p className="mt-1 text-xs text-muted">Workspace overview / Home</p>
        </div>
        <Badge tone="outline" className="bg-white px-3 py-1.5 text-[11px] tracking-wide">
          FACTORYOS AI · V2.1
        </Badge>
      </div>

      <section className="relative isolate overflow-hidden rounded-[1.75rem] bg-[#101b2b] text-white shadow-xl shadow-slate-900/10">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-36 size-[28rem] rounded-full bg-cyan-400/15 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-44 left-1/3 size-[24rem] rounded-full bg-blue-500/15 blur-3xl" />
        <div className="relative grid gap-8 p-6 sm:p-9 lg:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)] lg:items-center lg:p-11">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200/20 bg-cyan-200/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-200">
              <span className="size-1.5 rounded-full bg-cyan-300" />
              Manufacturing workspace
            </div>
            <h1 className="mt-5 max-w-2xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl lg:text-[2.75rem]">
              Your factory.
              <span className="block text-cyan-200">One connected workspace.</span>
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
              Bring warehouse execution, operational evidence and governed AI workflows into one clear view.
              Choose a workspace to continue where your team works.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/wms" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-cyan-300 px-5 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-950/20 transition hover:-translate-y-0.5 hover:bg-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:transform-none">
                Open warehouse
                <span aria-hidden="true" className="ml-2">→</span>
              </Link>
              <Link href="/ai/agents" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/20 bg-white/[0.06] px-5 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                Explore AI workspace
              </Link>
            </div>
          </div>

          <aside className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-sm sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
              Built around trust
            </p>
            <div className="mt-5 space-y-4">
              <div className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-cyan-300/15 text-xs font-bold text-cyan-200">01</span>
                <div>
                  <p className="text-sm font-semibold text-white">Evidence-led operations</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">See operational context without presenting assumptions as facts.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-cyan-300/15 text-xs font-bold text-cyan-200">02</span>
                <div>
                  <p className="text-sm font-semibold text-white">Permission-aware actions</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">The API remains the authority for every protected operation.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-cyan-300/15 text-xs font-bold text-cyan-200">03</span>
                <div>
                  <p className="text-sm font-semibold text-white">Connected workspaces</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">A consistent shell for warehouse, AI and device workflows.</p>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="workspace-heading">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-700">01 / Workspaces</p>
            <h2 id="workspace-heading" className="mt-1 text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl">
              Operational workspaces
            </h2>
            <p className="mt-1 text-sm text-muted">Focused tools for the work happening across your factory.</p>
          </div>
          <span className="text-xs font-medium text-slate-500">Select a workspace to continue</span>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          {workspaces.map((workspace) => (
            <Link key={workspace.href} href={workspace.href} className="group block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600">
              <Card className="h-full overflow-hidden transition duration-200 group-hover:-translate-y-1 group-hover:border-brand-200 group-hover:shadow-xl group-hover:shadow-slate-900/[0.06] motion-reduce:transform-none motion-reduce:transition-none">
                <CardHeader className="border-0 px-6 pb-2 pt-6 sm:px-7 sm:pt-7">
                  <div className="flex items-start justify-between gap-4">
                    <span className={`flex size-12 items-center justify-center rounded-2xl text-sm font-black tracking-wide ${workspace.accent}`}>
                      {workspace.code}
                    </span>
                    <Badge tone="outline" className="text-[10px] tracking-wide">{workspace.eyebrow}</Badge>
                  </div>
                  <CardTitle className="mt-5 text-xl sm:text-2xl">{workspace.title}</CardTitle>
                  <CardDescription className="mt-1 max-w-2xl min-h-14">{workspace.description}</CardDescription>
                </CardHeader>
                <CardContent className="px-6 pb-6 pt-4 sm:px-7 sm:pb-7">
                  <ul className="flex flex-wrap gap-2" aria-label={workspace.title + " capabilities"}>
                    {workspace.capabilities.map((capability) => (
                      <li key={capability}>
                        <Badge tone="neutral" className="bg-slate-50 text-[11px] font-medium">{capability}</Badge>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-7 flex items-center justify-between border-t border-slate-100 pt-4">
                    <span className="text-sm font-semibold text-slate-800 transition group-hover:text-brand-700">Open workspace</span>
                    <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition group-hover:bg-brand-700 group-hover:text-white">→</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="acceptance-heading">
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-700">02 / Validation</p>
          <h2 id="acceptance-heading" className="mt-1 text-lg font-semibold tracking-tight text-slate-950">Device & browser acceptance</h2>
          <p className="mt-1 text-sm text-muted">Dedicated validation surfaces for browser behavior and connected warehouse hardware.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {acceptanceWorkspaces.map((item) => (
            <Link key={item.href} href={item.href} className="group rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600">
              <div className="flex h-full items-start gap-4 rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-200 hover:shadow-lg hover:shadow-slate-900/[0.04]">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xs font-bold text-slate-600">{item.code}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-slate-900 group-hover:text-brand-700">{item.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{item.description}</p>
                </div>
                <span aria-hidden="true" className="text-slate-400 transition group-hover:translate-x-1 group-hover:text-brand-700">→</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-5 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-6">
        <div className="max-w-2xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-700">Workspace identity</p>
          <h2 className="mt-1 text-base font-semibold text-slate-950">Connect an existing FactoryOS session</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Load the verified tenant, factory and permission context from an already-issued session. The UI context never replaces backend authorization.
          </p>
        </div>
        <Link href="/session" className="mt-4 inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 sm:mt-0">
          Manage session
          <span aria-hidden="true" className="ml-2">→</span>
        </Link>
      </section>
    </main>
  );
}
