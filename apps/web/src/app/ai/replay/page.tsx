"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  createAiDecisionReplayClient,
  isAiTraceId,
} from "@/lib/ai-decision-replay.mjs";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  StatusBadge,
} from "@/components/ui";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord =>
      item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
}

function valueText(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

function SectionCard({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          {typeof count === "number" ? <Badge tone="neutral">{count} records</Badge> : null}
        </div>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ReadOnlyRecords({
  title,
  description,
  records,
  fields,
}: {
  title: string;
  description: string;
  records: JsonRecord[];
  fields: Array<{ key: string; label: string }>;
}) {
  return (
    <SectionCard title={title} description={description} count={records.length}>
      {records.length ? (
        <div className="space-y-3">
          {records.map((record, index) => (
            <article
              key={valueText(record.id, title + "-" + index)}
              className="rounded-xl border border-slate-200 p-4"
            >
              <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
                {fields.map((field) => {
                  const value = record[field.key];
                  if (value === null || value === undefined || typeof value === "object") return null;
                  return (
                    <div key={field.key} className="min-w-0">
                      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {field.label}
                      </dt>
                      <dd className="mt-1 break-words text-sm font-medium text-slate-800">
                        {valueText(value)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No {title.toLowerCase()} were recorded for this decision.</p>
      )}
    </SectionCard>
  );
}

const componentLabels: Array<{ key: string; label: string }> = [
  { key: "canonicalEnvelope", label: "Canonical envelope" },
  { key: "lifecycle", label: "Lifecycle ledger" },
  { key: "contexts", label: "Context packages" },
  { key: "evidenceReferences", label: "Evidence references" },
  { key: "verifications", label: "Verification runs" },
  { key: "actions", label: "Action intents" },
  { key: "executions", label: "Executions" },
  { key: "outcomes", label: "Outcome links" },
  { key: "learningSignals", label: "Learning signals" },
  { key: "releases", label: "Releases" },
];

export default function AiDecisionReplayPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [traceId, setTraceId] = useState("");
  const [loadedTraceId, setLoadedTraceId] = useState("");
  const [replay, setReplay] = useState<JsonRecord | null>(null);
  const [replayHash, setReplayHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canRead = connected && hasPermission("ai.replay.read");
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);

  useEffect(() => {
    requestSequence.current += 1;
    setLoading(false);
    setReplay(null);
    setReplayHash("");
    setLoadedTraceId("");
    setError("");
  }, [activeFactoryId, canRead, snapshot?.tenant.id]);

  async function handleReplay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTraceId = traceId.trim().toLowerCase();

    if (!isAiTraceId(normalizedTraceId)) {
      setError("Enter a valid UUID trace ID.");
      return;
    }
    if (!connected || !activeFactoryId) {
      setError("Connect an authenticated session and select an active factory first.");
      return;
    }
    if (!hasPermission("ai.replay.read")) {
      setError("Your IAM permission snapshot does not include ai.replay.read.");
      return;
    }

    const currentRequest = requestSequence.current + 1;
    requestSequence.current = currentRequest;
    setLoading(true);
    setError("");
    setReplay(null);
    setReplayHash("");
    setLoadedTraceId("");

    try {
      const client = createAiDecisionReplayClient({ request });
      const response = asRecord(await client.replay(normalizedTraceId));
      if (requestSequence.current !== currentRequest) return;
      const nextReplay = asRecord(response.replay);
      if (!Object.keys(nextReplay).length) {
        throw new Error("The API response did not contain an AI decision replay.");
      }
      setReplay(nextReplay);
      setReplayHash(valueText(response.replayHash, ""));
      setLoadedTraceId(normalizedTraceId);
    } catch (cause) {
      if (requestSequence.current === currentRequest) {
        setError(cause instanceof Error ? cause.message : "Could not load the AI decision replay.");
      }
    } finally {
      if (requestSequence.current === currentRequest) setLoading(false);
    }
  }

  const decision = asRecord(replay?.decision);
  const lifecycle = asRecord(replay?.lifecycle);
  const completeness = asRecord(replay?.completeness);
  const components = asRecord(completeness.components);
  const contexts = asRecords(replay?.contexts);
  const lifecycleEvents = asRecords(lifecycle.events);
  const verifications = asRecords(replay?.verifications);
  const actions = asRecords(replay?.actions);
  const executions = asRecords(replay?.executions);
  const outcomes = asRecords(replay?.outcomes);
  const learningSignals = asRecords(replay?.learningSignals);
  const releases = asRecords(replay?.releases);
  const blockers = Array.isArray(completeness.blockers)
    ? completeness.blockers.filter((item): item is string => typeof item === "string")
    : [];
  const decisionFields: Array<[string, unknown]> = [
    ["Reasoning mode", decision.reasoningMode],
    ["Risk class", decision.riskClass],
    ["Output state", decision.outputState],
    ["Envelope version", decision.envelopeVersion],
    ["Context version", decision.contextVersion],
    ["Created", formatDate(decision.createdAt)],
    ["Updated", formatDate(decision.updatedAt)],
  ];

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="AI governance · read-only inspection"
        title="Decision Trace Replay"
        description="Inspect the persisted decision envelope, lifecycle, evidence integrity, verification results and downstream records for one factory-scoped AI trace."
        actions={
          <Badge tone="info">No action execution</Badge>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Alert tone={connected ? "success" : "warning"} title={connected ? "Authenticated workspace session" : "Session not connected"}>
          {connected && snapshot
            ? snapshot.tenant.name + (activeFactory ? " · " + activeFactory.code : " · Select an active factory")
            : "Connect an existing FactoryOS session before requesting trace data."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">Open session setup</Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canRead ? "success" : "info"} title="Replay permission">
          {canRead
            ? "IAM permission ai.replay.read is present. The API still performs its own authorization check."
            : "This workspace requires ai.replay.read from the current IAM permission snapshot."}
        </Alert>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Find a decision by trace ID</CardTitle>
          <CardDescription>
            Use the UUID trace ID recorded by the originating FactoryOS workflow. The request is a GET to the authenticated, selected-factory scope.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleReplay} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor="ai-trace-id" className="block text-sm font-semibold text-slate-800">
                Trace ID
              </label>
              <input
                id="ai-trace-id"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                value={traceId}
                disabled={loading}
                onChange={(event) => setTraceId(event.target.value)}
                placeholder="xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
                aria-describedby="ai-trace-hint"
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 outline-none transition focus-visible:ring-2 focus-visible:ring-brand-600"
              />
              <p id="ai-trace-hint" className="mt-1 text-xs text-slate-500">
                Trace IDs must be valid UUIDs. They are sent only to the configured FactoryOS API.
              </p>
            </div>
            <Button type="submit" disabled={!canRead || !activeFactoryId || loading || !isAiTraceId(traceId)}>
              {loading ? "Loading trace…" : "Load replay"}
            </Button>
          </form>
          {error ? <Alert tone="danger" title="Replay request failed" className="mt-4">{error}</Alert> : null}
        </CardContent>
      </Card>

      {replay ? (
        <div className="mt-7 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Loaded trace</p>
              <p className="mt-1 break-all font-mono text-sm text-slate-800">{loadedTraceId}</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={valueText(completeness.status, "UNKNOWN")} />
              <Badge tone="neutral">Read only</Badge>
            </div>
          </div>

          {blockers.length ? (
            <Alert tone="warning" title="Replay completeness has blockers">
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {blockers.map((blocker) => <li key={blocker}>{blocker.replaceAll("_", " ")}</li>)}
              </ul>
            </Alert>
          ) : (
            <Alert tone="success" title="Replay integrity checks are complete">
              The API reports no replay completeness blockers for this trace.
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Decision state</p>
                <p className="mt-2 text-xl font-semibold text-slate-950">{valueText(decision.outputState)}</p>
                <p className="mt-1 text-xs text-slate-500">{valueText(decision.reasoningMode, "Reasoning mode not recorded")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lifecycle state</p>
                <p className="mt-2 text-xl font-semibold text-slate-950">{valueText(lifecycle.currentState)}</p>
                <p className="mt-1 text-xs text-slate-500">Version {valueText(lifecycle.version, "—")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Context packages</p>
                <p className="mt-2 text-xl font-semibold text-slate-950">{contexts.length}</p>
                <p className="mt-1 text-xs text-slate-500">Persisted for this decision</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Replay hash</p>
                <p className="mt-2 break-all font-mono text-xs font-semibold text-slate-800">{replayHash || "Not returned"}</p>
                <p className="mt-1 text-xs text-slate-500">Read audit fingerprint</p>
              </CardContent>
            </Card>
          </div>

          <SectionCard title="Decision envelope" description="Persisted decision metadata; identity and scope are inherited from the authenticated session.">
            <h3 className="text-base font-semibold leading-6 text-slate-950">{valueText(decision.objective, "Objective not recorded")}</h3>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {decisionFields.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-1 break-words text-sm font-medium text-slate-800">{valueText(value)}</dd>
                </div>
              ))}
            </dl>
            <details className="mt-5 rounded-xl border border-slate-200 px-4 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-slate-700">Canonical envelope fingerprint</summary>
              <p className="mt-3 break-all font-mono text-xs leading-5 text-slate-600">{valueText(decision.decisionHash, "No canonical request hash recorded")}</p>
            </details>
          </SectionCard>

          <SectionCard title="Completeness components" description="The server-computed checks used to determine whether the trace can be fully reconstructed.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {componentLabels.map(({ key, label }) => {
                const component = asRecord(components[key]);
                const count = component.count;
                return (
                  <div key={key} className="rounded-xl border border-slate-200 p-3">
                    <p className="text-xs font-semibold text-slate-700">{label}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <StatusBadge status={valueText(component.status, "UNKNOWN")} />
                      {typeof count === "number" ? <span className="text-xs tabular-nums text-slate-500">{count}</span> : null}
                    </div>
                    {key === "evidenceReferences" ? (
                      <p className="mt-2 text-xs text-slate-500">
                        Expected {valueText(component.expected, "—")} · persisted {valueText(component.persisted, "—")}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Decision lifecycle" description="Ordered state transitions persisted by the AI lifecycle ledger." count={lifecycleEvents.length}>
            {lifecycleEvents.length ? (
              <ol className="space-y-0">
                {lifecycleEvents.map((event, index) => (
                  <li key={valueText(event.id, String(index))} className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3 pb-6 last:pb-0">
                    {index < lifecycleEvents.length - 1 ? (
                      <span aria-hidden="true" className="absolute left-[0.9rem] top-8 h-[calc(100%-1rem)] w-px bg-slate-200" />
                    ) : null}
                    <span className="relative z-10 flex size-8 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-xs font-bold text-slate-700">
                      {valueText(event.sequence, String(index + 1))}
                    </span>
                    <div className="min-w-0 rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        {event.fromState ? <Badge tone="neutral">{valueText(event.fromState)}</Badge> : <Badge tone="info">START</Badge>}
                        <span aria-hidden="true" className="text-slate-400">→</span>
                        <StatusBadge status={valueText(event.toState, "UNKNOWN")} />
                      </div>
                      <p className="mt-2 text-sm text-slate-800">{valueText(event.reason, "No transition reason recorded")}</p>
                      <p className="mt-2 text-xs text-slate-500">{formatDate(event.occurredAt)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState title="No lifecycle events" description="The replay returned no persisted lifecycle events. This contributes to a partial replay when lifecycle state is expected." />
            )}
          </SectionCard>

          <SectionCard title="Context packages & evidence references" description="Context hash and evidence-reference integrity, without rendering source snapshots or restricted business content." count={contexts.length}>
            {contexts.length ? (
              <div className="space-y-4">
                {contexts.map((context, index) => {
                  const integrity = asRecord(context.integrity);
                  const references = asRecords(context.evidenceReferences);
                  return (
                    <article key={valueText(context.id, "context-" + index)} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="font-semibold text-slate-900">{valueText(context.contextVersion, "Context version not recorded")}</h3>
                          <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{valueText(context.packageHash)}</p>
                        </div>
                        <StatusBadge status={integrity.packageHashMatches === true && integrity.evidenceReferencesComplete === true ? "VERIFIED" : "INCOMPLETE"} />
                      </div>
                      <p className="mt-3 text-xs text-slate-600">
                        {valueText(integrity.persistedEvidenceReferenceCount, "0")} persisted / {valueText(integrity.sourceReferenceCount, "0")} expected references
                      </p>
                      {references.length ? (
                        <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100">
                          {references.map((reference, refIndex) => (
                            <li key={valueText(reference.evidenceId, "evidence-" + refIndex)} className="grid gap-1 px-3 py-3 sm:grid-cols-2">
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-slate-700">{valueText(reference.sourceType)}</p>
                                <p className="mt-1 break-all font-mono text-xs text-slate-600">{valueText(reference.sourceRef)}</p>
                              </div>
                              <div className="min-w-0 sm:text-right">
                                <p className="break-all font-mono text-[11px] text-slate-500">{valueText(reference.contentHash, "No content hash")}</p>
                                <p className="mt-1 text-xs text-slate-500">{formatDate(reference.sourceTimestamp)}</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-3 text-xs text-slate-500">No persisted evidence references in this context package.</p>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState title="No context package" description="No persisted context package was returned for this decision." />
            )}
          </SectionCard>

          <ReadOnlyRecords
            title="Verification runs"
            description="Verification status and the time each run was recorded."
            records={verifications}
            fields={[
              { key: "status", label: "Status" },
              { key: "createdAt", label: "Recorded" },
              { key: "contextPackageId", label: "Context package" },
            ]}
          />

          <div className="grid gap-6 xl:grid-cols-2">
            <ReadOnlyRecords
              title="Action intents"
              description="Action classification and authorization summary. Tokens and action payloads are not displayed."
              records={actions}
              fields={[
                { key: "actionType", label: "Action type" },
                { key: "toolId", label: "Tool" },
                { key: "toolVersion", label: "Tool version" },
                { key: "riskClass", label: "Risk class" },
                { key: "authorizationStatus", label: "Authorization" },
                { key: "approvalId", label: "Approval reference" },
                { key: "createdAt", label: "Created" },
              ]}
            />
            <ReadOnlyRecords
              title="Execution records"
              description="Execution metadata only; inputs, results and error payloads are not rendered."
              records={executions}
              fields={[
                { key: "executorType", label: "Executor" },
                { key: "toolVersion", label: "Tool version" },
                { key: "status", label: "Status" },
                { key: "startedAt", label: "Started" },
                { key: "finishedAt", label: "Finished" },
              ]}
            />
            <ReadOnlyRecords
              title="Outcome links"
              description="Observed outcome record status."
              records={outcomes}
              fields={[
                { key: "status", label: "Outcome status" },
                { key: "createdAt", label: "Recorded" },
                { key: "executionRecordId", label: "Execution reference" },
              ]}
            />
            <ReadOnlyRecords
              title="Learning signals"
              description="Staged learning signals; this page cannot promote or activate a candidate."
              records={learningSignals}
              fields={[
                { key: "signalType", label: "Signal type" },
                { key: "label", label: "Label" },
                { key: "confidence", label: "Confidence" },
                { key: "tenantScope", label: "Scope" },
                { key: "createdAt", label: "Recorded" },
              ]}
            />
          </div>

          <ReadOnlyRecords
            title="Approved releases"
            description="Release records associated with this decision or trace."
            records={releases}
            fields={[
              { key: "artifactType", label: "Artifact type" },
              { key: "artifactKey", label: "Artifact key" },
              { key: "version", label: "Version" },
              { key: "status", label: "Release status" },
              { key: "approvalId", label: "Approval reference" },
              { key: "effectiveAt", label: "Effective at" },
            ]}
          />

          <Alert tone="info" title="Replay is inspection only">
            This workspace reads the persisted decision record. It does not re-run the model, repeat a tool call, execute an action, change an approval, create a learning signal or promote an artifact. Material actions remain subject to the existing API authorization and approval controls.
          </Alert>
        </div>
      ) : (
        <div className="mt-7">
          <EmptyState
            title={loading ? "Loading persisted replay" : "No trace loaded"}
            description={loading
              ? "The FactoryOS API is reconstructing the decision from the selected tenant and factory scope."
              : "Enter a valid trace ID and load it using a session with ai.replay.read permission. No sample or synthetic decision data is shown."}
          />
        </div>
      )}
    </main>
  );
}
