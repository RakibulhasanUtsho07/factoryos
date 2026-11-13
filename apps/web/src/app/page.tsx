import Link from "next/link";

const workspaces = [
  {
    href: "/ai/agents",
    eyebrow: "AI GOVERNANCE",
    title: "Agent Control Center",
    description:
      "Inspect factory-scoped agent definitions, review persisted task evidence, manage operational controls and act on approval-gated steps.",
    points: ["Agent catalogue", "Task and approval ledger", "Evaluation and Studio evidence"],
  },
  {
    href: "/wms",
    eyebrow: "WAREHOUSE OPERATIONS",
    title: "WMS Mobile Workbench",
    description:
      "Continue mobile warehouse flows for offline stock movements, traceability labels, barcode resolution and device acceptance.",
    points: ["Durable offline queue", "Labels and traceability", "Scan and resolve"],
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-6 border-b border-slate-200 pb-8 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-blue-700">
              Manufacturing operations platform
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              FactoryOS AI
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
              One governed workspace for factory operations, warehouse execution and
              permission-controlled AI workflows.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <span className="font-semibold text-slate-900">Product environment</span>
            <p className="mt-1">Connect each workspace to the approved FactoryOS API.</p>
          </div>
        </header>

        <section className="mt-9">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">
                Workspaces
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Choose an operational surface.
              </p>
            </div>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {workspaces.map((workspace) => (
              <Link
                key={workspace.href}
                href={workspace.href}
                className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[11px] font-bold tracking-[0.18em] text-blue-700">
                    {workspace.eyebrow}
                  </span>
                  <span className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition group-hover:border-blue-300 group-hover:text-blue-700">
                    <span aria-hidden="true">↗</span>
                  </span>
                </div>
                <h3 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950">
                  {workspace.title}
                </h3>
                <p className="mt-3 min-h-20 text-sm leading-6 text-slate-600">
                  {workspace.description}
                </p>
                <ul className="mt-5 flex flex-wrap gap-2">
                  {workspace.points.map((point) => (
                    <li
                      key={point}
                      className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600"
                    >
                      {point}
                    </li>
                  ))}
                </ul>
                <p className="mt-7 text-sm font-semibold text-slate-900 group-hover:text-blue-700">
                  Open workspace <span aria-hidden="true">→</span>
                </p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-9 rounded-2xl border border-blue-200 bg-blue-50 p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Authenticated workspace session</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-700">
              Connect an existing identity-provider session to load your verified tenant,
              factory list and IAM permission snapshot.
            </p>
          </div>
          <Link
            href="/session"
            className="mt-4 inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 sm:mt-0"
          >
            Connect session
          </Link>
        </section>

        <footer className="mt-10 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-500">
          Access to operational data and actions is enforced by the authenticated API,
          tenant/factory scope and server-side permissions. This landing page does not
          contain seeded customer data or grant authority by itself.
        </footer>
      </div>
    </main>
  );
}
