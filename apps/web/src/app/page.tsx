import Link from "next/link";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@/components/ui";

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
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8 lg:px-10">
        <PageHeader
          eyebrow="Manufacturing operations platform"
          title="FactoryOS AI"
          description="One governed workspace for factory operations, warehouse execution and permission-controlled AI workflows."
        />

        <section aria-labelledby="workspace-heading" className="mt-9">
          <div className="mb-5">
            <h2
              id="workspace-heading"
              className="text-sm font-bold uppercase tracking-wider text-slate-700"
            >
              Workspaces
            </h2>
            <p className="mt-1 text-sm text-muted">
              Choose an operational surface.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {workspaces.map((workspace) => (
              <Link
                key={workspace.href}
                href={workspace.href}
                className="group block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-700"
              >
                <Card className="h-full transition duration-150 group-hover:-translate-y-0.5 group-hover:border-brand-200 group-hover:shadow-md motion-reduce:transition-none">
                  <CardHeader className="border-0 pb-2">
                    <Badge tone="info" className="w-fit tracking-[0.12em]">
                      {workspace.eyebrow}
                    </Badge>
                    <CardTitle className="mt-3 text-xl sm:text-2xl">
                      {workspace.title}
                    </CardTitle>
                    <CardDescription className="mt-1 min-h-20">
                      {workspace.description}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="pt-3">
                    <ul className="flex flex-wrap gap-2" aria-label={workspace.title + " capabilities"}>
                      {workspace.points.map((point) => (
                        <li key={point}>
                          <Badge tone="neutral">{point}</Badge>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-7 text-sm font-semibold text-slate-900 group-hover:text-brand-700">
                      Open workspace <span aria-hidden="true">→</span>
                    </p>
                  </CardContent>
                </Card>
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

        <aside className="mt-8 rounded-xl border border-border bg-white px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">Product environment</p>
          <p className="mt-1 text-sm leading-6 text-muted">
            Connect each workspace to the approved FactoryOS API. Operational
            data and actions remain subject to authenticated tenant/factory
            scope and server-side permissions.
          </p>
        </aside>
      </div>
    </main>
  );
}
