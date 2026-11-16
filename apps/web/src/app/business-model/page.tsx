"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
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
  Select,
  StatusBadge,
} from "@/components/ui";
import { createCbbGovernanceClient } from "@/lib/cbb-governance-workbench.mjs";
import type {
  CbbConflictStatus,
  CbbEvidenceState,
} from "@/lib/cbb-governance-workbench.mjs";

type JsonRecord = Record<string, unknown>;
type CbbTab = "blueprint" | "evidence" | "governance" | "terminology";

type OverviewResult = {
  key: string;
  model: JsonRecord | null;
  processes: JsonRecord[];
  versions: JsonRecord[];
  errors: string[];
};

type MapResult = {
  key: string;
  map: JsonRecord | null;
  error: string;
};

type ProcessResult = {
  key: string;
  process: JsonRecord | null;
  steps: JsonRecord[];
  error: string;
};

type ListResult = {
  key: string;
  items: JsonRecord[];
  total: number;
  error: string;
};

type GovernanceResult = {
  key: string;
  conflicts: JsonRecord[];
  conflictTotal: number;
  staleness: JsonRecord[];
  errors: string[];
};

type TerminologyResult = {
  key: string;
  canonicalTerms: JsonRecord[];
  aliases: JsonRecord[];
  error: string;
};

const EVIDENCE_STATE_OPTIONS = [
  ["", "All evidence states"],
  ["VERIFIED", "Verified"],
  ["INFERRED", "Inferred"],
  ["PROPOSED", "Proposed"],
  ["CONFLICTING", "Conflicting"],
  ["STALE", "Stale"],
] as const;

const CONFLICT_STATUS_OPTIONS = [
  ["", "All conflict statuses"],
  ["OPEN", "Open"],
  ["RESOLVED", "Resolved"],
  ["DISMISSED", "Dismissed"],
] as const;

const PAGE_SIZE = 50;

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

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: unknown, digits = 2): string {
  const number = numberValue(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(number);
}

function formatDateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
}


function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        {children}
      </table>
    </div>
  );
}

function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
      {children}
    </thead>
  );
}

function Pagination({
  page,
  total,
  onPrevious,
  onNext,
}: {
  page: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
      <p className="text-xs text-slate-500">
        Page {page + 1} of {pages} · {formatNumber(total, 0)} matching records
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onPrevious} disabled={page <= 0}>
          Previous
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={page + 1 >= pages}>
          Next
        </Button>
      </div>
    </div>
  );
}

export default function CbbGovernanceWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const connected = sessionStatus === "connected" && snapshot !== null && Boolean(activeFactoryId);
  const canReadBusinessModel = connected && hasPermission("ai.business.read");
  const permissionSnapshotKey = snapshot?.permissions
    .map((permission) => permission.code)
    .sort()
    .join(",") ?? "";

  const [requestedTab, setRequestedTab] = useState<CbbTab>("blueprint");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [selectedProcessId, setSelectedProcessId] = useState("");
  const [evidenceState, setEvidenceState] = useState<CbbEvidenceState | "">("");
  const [evidencePage, setEvidencePage] = useState(0);
  const [conflictStatus, setConflictStatus] = useState<CbbConflictStatus | "">("");
  const [conflictPage, setConflictPage] = useState(0);
  const [terminologyDraft, setTerminologyDraft] = useState("");
  const [terminologySearch, setTerminologySearch] = useState("");

  const [overviewResult, setOverviewResult] = useState<OverviewResult | null>(null);
  const [mapResult, setMapResult] = useState<MapResult | null>(null);
  const [processResult, setProcessResult] = useState<ProcessResult | null>(null);
  const [evidenceResult, setEvidenceResult] = useState<ListResult | null>(null);
  const [governanceResult, setGovernanceResult] = useState<GovernanceResult | null>(null);
  const [terminologyResult, setTerminologyResult] = useState<TerminologyResult | null>(null);

  const client = useMemo(
    () => createCbbGovernanceClient({ request }),
    [request],
  );

  const tabs: { id: CbbTab; label: string }[] = [
    { id: "blueprint", label: "Blueprint & processes" },
    { id: "evidence", label: "Evidence register" },
    { id: "governance", label: "Conflicts & staleness" },
    { id: "terminology", label: "Terminology" },
  ];

  const overviewKey = [
    activeFactoryId,
    permissionSnapshotKey,
    refreshVersion,
  ].join("|");
  const visibleOverview = overviewResult?.key === overviewKey ? overviewResult : null;
  const model = visibleOverview?.model ?? null;
  const processes = visibleOverview?.processes ?? [];
  const versions = visibleOverview?.versions ?? [];

  const mapQueryKey = [
    activeFactoryId,
    permissionSnapshotKey,
    selectedVersionId,
    refreshVersion,
  ].join("|");
  const visibleMapResult = mapResult?.key === mapQueryKey ? mapResult : null;
  const businessMap = visibleMapResult?.map ?? null;

  const selectedProcess = processes.find((process) =>
    valueText(process.id, "").toLowerCase() === selectedProcessId.toLowerCase())
    ?? processes[0]
    ?? null;
  const effectiveProcessId = selectedProcess ? valueText(selectedProcess.id, "") : "";
  const processQueryKey = [
    activeFactoryId,
    permissionSnapshotKey,
    effectiveProcessId,
    refreshVersion,
  ].join("|");
  const visibleProcessResult = processResult?.key === processQueryKey ? processResult : null;

  const evidenceQueryKey = [
    activeFactoryId,
    permissionSnapshotKey,
    evidenceState,
    evidencePage,
    refreshVersion,
  ].join("|");
  const visibleEvidenceResult = evidenceResult?.key === evidenceQueryKey ? evidenceResult : null;

  const governanceQueryKey = [
    activeFactoryId,
    permissionSnapshotKey,
    conflictStatus,
    conflictPage,
    refreshVersion,
  ].join("|");
  const visibleGovernanceResult = governanceResult?.key === governanceQueryKey
    ? governanceResult
    : null;

  const terminologyQueryKey = [
    activeFactoryId,
    permissionSnapshotKey,
    terminologySearch,
    refreshVersion,
  ].join("|");
  const visibleTerminologyResult = terminologyResult?.key === terminologyQueryKey
    ? terminologyResult
    : null;

  useEffect(() => {
    if (!canReadBusinessModel || requestedTab !== "blueprint") return;
    let cancelled = false;
    void Promise.allSettled([
      client.getBusinessModel(),
      client.listProcesses(),
      client.listVersions(),
    ]).then((results) => {
      if (cancelled) return;
      const errors: string[] = [];
      const modelValue = results[0].status === "fulfilled"
        ? (results[0].value ? asRecord(results[0].value) : null)
        : null;
      if (results[0].status === "rejected") {
        errors.push(results[0].reason instanceof Error
          ? results[0].reason.message
          : "Business model summary could not be loaded.");
      }
      const processPayload = results[1].status === "fulfilled"
        ? asRecord(results[1].value)
        : {};
      if (results[1].status === "rejected") {
        errors.push(results[1].reason instanceof Error
          ? results[1].reason.message
          : "Business process list could not be loaded.");
      }
      const versionPayload = results[2].status === "fulfilled"
        ? results[2].value
        : [];
      if (results[2].status === "rejected") {
        errors.push(results[2].reason instanceof Error
          ? results[2].reason.message
          : "Blueprint versions could not be loaded.");
      }
      setOverviewResult({
        key: overviewKey,
        model: modelValue,
        processes: asRecords(processPayload.items),
        versions: asRecords(versionPayload),
        errors,
      });
    });
    return () => { cancelled = true; };
  }, [canReadBusinessModel, client, overviewKey, requestedTab]);

  useEffect(() => {
    if (!canReadBusinessModel || requestedTab !== "blueprint") return;
    let cancelled = false;
    const load = selectedVersionId
      ? client.getVersionMap({ versionId: selectedVersionId })
      : client.getBusinessMap();
    void load.then((payload) => {
      if (!cancelled) setMapResult({
        key: mapQueryKey,
        map: payload ? asRecord(payload) : null,
        error: "",
      });
    }).catch((error: unknown) => {
      if (!cancelled) setMapResult({
        key: mapQueryKey,
        map: null,
        error: error instanceof Error ? error.message : "Business map could not be loaded.",
      });
    });
    return () => { cancelled = true; };
  }, [canReadBusinessModel, client, mapQueryKey, requestedTab, selectedVersionId]);

  useEffect(() => {
    if (!canReadBusinessModel || requestedTab !== "blueprint" || !effectiveProcessId) return;
    let cancelled = false;
    void client.getProcess({ processId: effectiveProcessId })
      .then((payload) => {
        if (cancelled) return;
        const value = asRecord(payload);
        setProcessResult({
          key: processQueryKey,
          process: value.process ? asRecord(value.process) : null,
          steps: asRecords(value.steps),
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setProcessResult({
          key: processQueryKey,
          process: null,
          steps: [],
          error: error instanceof Error ? error.message : "Process detail could not be loaded.",
        });
      });
    return () => { cancelled = true; };
  }, [canReadBusinessModel, client, effectiveProcessId, processQueryKey, requestedTab]);

  useEffect(() => {
    if (!canReadBusinessModel || requestedTab !== "evidence") return;
    let cancelled = false;
    void client.listEvidence({
      limit: PAGE_SIZE,
      offset: evidencePage * PAGE_SIZE,
      ...(evidenceState ? { state: evidenceState } : {}),
    }).then((payload) => {
      if (cancelled) return;
      const value = asRecord(payload);
      setEvidenceResult({
        key: evidenceQueryKey,
        items: asRecords(value.items),
        total: numberValue(value.total) ?? 0,
        error: "",
      });
    }).catch((error: unknown) => {
      if (!cancelled) setEvidenceResult({
        key: evidenceQueryKey,
        items: [],
        total: 0,
        error: error instanceof Error ? error.message : "Evidence register could not be loaded.",
      });
    });
    return () => { cancelled = true; };
  }, [canReadBusinessModel, client, evidencePage, evidenceQueryKey, evidenceState, requestedTab]);

  useEffect(() => {
    if (!canReadBusinessModel || requestedTab !== "governance") return;
    let cancelled = false;
    void Promise.allSettled([
      client.listConflicts({
        limit: PAGE_SIZE,
        offset: conflictPage * PAGE_SIZE,
        ...(conflictStatus ? { status: conflictStatus } : {}),
      }),
      client.listStaleness(),
    ]).then((results) => {
      if (cancelled) return;
      const errors: string[] = [];
      let conflicts: JsonRecord[] = [];
      let conflictTotal = 0;
      let staleness: JsonRecord[] = [];
      if (results[0].status === "fulfilled") {
        const value = asRecord(results[0].value);
        conflicts = asRecords(value.items);
        conflictTotal = numberValue(value.total) ?? 0;
      } else {
        errors.push(results[0].reason instanceof Error
          ? results[0].reason.message
          : "Conflict register could not be loaded.");
      }
      if (results[1].status === "fulfilled") {
        staleness = asRecords(results[1].value);
      } else {
        errors.push(results[1].reason instanceof Error
          ? results[1].reason.message
          : "Staleness reviews could not be loaded.");
      }
      setGovernanceResult({
        key: governanceQueryKey,
        conflicts,
        conflictTotal,
        staleness,
        errors,
      });
    });
    return () => { cancelled = true; };
  }, [canReadBusinessModel, client, conflictPage, conflictStatus, governanceQueryKey, requestedTab]);

  useEffect(() => {
    if (!canReadBusinessModel || requestedTab !== "terminology") return;
    let cancelled = false;
    void client.listTerminology({
      ...(terminologySearch ? { search: terminologySearch } : {}),
    }).then((payload) => {
      if (cancelled) return;
      const value = asRecord(payload);
      setTerminologyResult({
        key: terminologyQueryKey,
        canonicalTerms: asRecords(value.canonicalTerms),
        aliases: asRecords(value.aliases),
        error: "",
      });
    }).catch((error: unknown) => {
      if (!cancelled) setTerminologyResult({
        key: terminologyQueryKey,
        canonicalTerms: [],
        aliases: [],
        error: error instanceof Error ? error.message : "Terminology dictionary could not be loaded.",
      });
    });
    return () => { cancelled = true; };
  }, [canReadBusinessModel, client, requestedTab, terminologyQueryKey, terminologySearch]);

  const counts = asRecord(model?.counts);
  const currentVersion = asRecord(model?.currentVersion);
  const nodes = asRecords(businessMap?.nodes);
  const edges = asRecords(businessMap?.edges);
  const nodeNames = new Map(nodes.map((node) => [
    valueText(node.id, ""),
    valueText(node.name, "Unnamed entity"),
  ]));
  const openConflictCount = visibleGovernanceResult?.conflicts.filter((item) =>
    valueText(item.status, "").toUpperCase() === "OPEN").length ?? 0;
  const openStalenessCount = visibleGovernanceResult?.staleness.filter((item) =>
    valueText(item.review_status, "").toUpperCase() === "OPEN").length ?? 0;

  const refresh = () => setRefreshVersion((current) => current + 1);

  function applyTerminologySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTerminologySearch(terminologyDraft.trim());
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">FactoryOS · AI / Business Model</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Business Model & Governance Workbench</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Review the governed factory blueprint, verified and inferred process context, evidence, conflicts, staleness and canonical terminology.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={connected ? "success" : "neutral"}>
            {connected ? "Authenticated workspace" : "Session not connected"}
          </Badge>
          <Button variant="outline" onClick={refresh} disabled={!connected}>
            Refresh
          </Button>
        </div>
      </header>

      {!connected ? (
        <Alert tone="warning" title="Connect a FactoryOS workspace">
          Connect through the shared session page and select an active factory before opening business model governance data.
        </Alert>
      ) : null}

      {connected && !canReadBusinessModel ? (
        <EmptyState
          title="Business model read access is not assigned"
          description="The current IAM permission snapshot does not grant ai.business.read. Ask a workspace administrator to assign the appropriate factory-scoped permission."
        />
      ) : null}

      {canReadBusinessModel ? (
        <>
          <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-200 pb-3" role="tablist" aria-label="Business model governance views">
            {tabs.map((tab) => (
              <Button
                key={tab.id}
                role="tab"
                aria-selected={requestedTab === tab.id}
                variant={requestedTab === tab.id ? "primary" : "ghost"}
                size="sm"
                onClick={() => setRequestedTab(tab.id)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          {requestedTab === "blueprint" ? (
            <div className="space-y-5">
              {visibleOverview?.errors.length ? (
                <Alert tone="warning" title="Some blueprint information is unavailable">
                  {visibleOverview.errors.join(" ")}
                </Alert>
              ) : null}

              {!visibleOverview ? <p className="py-8 text-center text-sm text-slate-500">Loading current business blueprint…</p> : null}

              {visibleOverview && !model ? (
                <EmptyState
                  title="No readable active blueprint"
                  description="This factory has no active blueprint visible to the current role, or the active blueprint has not been published yet."
                />
              ) : null}

              {model ? (
                <>
                  <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Card>
                      <CardContent className="py-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Blueprint version</p>
                        <p className="mt-2 text-2xl font-bold">v{valueText(currentVersion.version)}</p>
                        <p className="mt-1 text-xs text-slate-500">{valueText(model.blueprint && asRecord(model.blueprint).status, "UNKNOWN")} · {valueText(currentVersion.status, "UNKNOWN")}</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="py-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Readiness score</p>
                        <p className="mt-2 text-2xl font-bold tabular-nums">{formatNumber(currentVersion.readinessScore)}</p>
                        <p className="mt-1 text-xs text-slate-500">Backend-published score; no browser recomputation</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="py-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Entities / relations</p>
                        <p className="mt-2 text-2xl font-bold tabular-nums">{formatNumber(counts.entities, 0)} / {formatNumber(counts.relations, 0)}</p>
                        <p className="mt-1 text-xs text-slate-500">Current blueprint version</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="py-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open conflicts</p>
                        <p className="mt-2 text-2xl font-bold tabular-nums">{formatNumber(counts.openConflicts, 0)}</p>
                        <p className="mt-1 text-xs text-slate-500">Server summary for the active factory blueprint</p>
                      </CardContent>
                    </Card>
                  </section>

                  <div className="grid gap-5 xl:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <CardTitle>Blueprint graph</CardTitle>
                            <CardDescription>Role-filtered entities and relationships for the selected version.</CardDescription>
                          </div>
                          <Badge tone="info">ACL filtered by API</Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        {visibleMapResult?.error ? <Alert tone="danger" title="Business map unavailable">{visibleMapResult.error}</Alert> : null}
                        {!visibleMapResult ? <p className="py-6 text-sm text-slate-500">Loading business map…</p> : null}
                        {visibleMapResult && !businessMap ? (
                          <EmptyState title="No business map found" description="The selected blueprint version does not have a readable graph." />
                        ) : null}
                        {businessMap ? (
                          <>
                            <div className="mb-4 flex flex-wrap gap-2">
                              <Badge tone="outline">{nodes.length} visible entities</Badge>
                              <Badge tone="outline">{edges.length} visible relations</Badge>
                              <Badge tone="outline">v{valueText(asRecord(businessMap.version).number)}</Badge>
                            </div>
                            {nodes.length === 0 ? (
                              <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">No entities are visible under the current target-level permissions.</p>
                            ) : (
                              <div className="space-y-2">
                                {nodes.slice(0, 12).map((node, index) => (
                                  <div key={valueText(node.id, String(index))} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 p-3">
                                    <div className="min-w-0">
                                      <p className="font-semibold">{valueText(node.name, "Unnamed entity")}</p>
                                      <p className="text-xs text-slate-500">{valueText(node.type, "ENTITY").replaceAll("_", " ")}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <StatusBadge status={valueText(node.state, "UNKNOWN")} />
                                      <Badge tone="outline">{formatNumber(node.confidence)}</Badge>
                                    </div>
                                  </div>
                                ))}
                                {nodes.length > 12 ? <p className="text-xs text-slate-500">Showing 12 of {nodes.length} visible entities.</p> : null}
                              </div>
                            )}
                            {edges.length > 0 ? (
                              <div className="mt-4 border-t border-slate-100 pt-4">
                                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Visible relationships</p>
                                <div className="space-y-2">
                                  {edges.slice(0, 8).map((edge, index) => (
                                    <p key={valueText(edge.id, String(index))} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                                      <span className="font-medium">{nodeNames.get(valueText(edge.fromEntityId, "")) ?? "Visible entity"}</span>
                                      {" → "}
                                      <span className="font-semibold">{valueText(edge.relationType).replaceAll("_", " ")}</span>
                                      {" → "}
                                      <span className="font-medium">{nodeNames.get(valueText(edge.toEntityId, "")) ?? "Visible entity"}</span>
                                    </p>
                                  ))}
                                  {edges.length > 8 ? <p className="text-xs text-slate-500">Showing 8 of {edges.length} visible relationships.</p> : null}
                                </div>
                              </div>
                            ) : null}
                          </>
                        ) : null}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <CardTitle>Blueprint version history</CardTitle>
                            <CardDescription>Published version readiness and evidence history.</CardDescription>
                          </div>
                          <Badge tone="info">Read only</Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        {versions.length === 0 ? (
                          <EmptyState title="No blueprint versions" description="No version history is available for this factory." />
                        ) : (
                          <div className="space-y-3">
                            {versions.slice(0, 12).map((version, index) => {
                              const versionId = valueText(version.versionId, "");
                              const isCurrent = version.isCurrent === true;
                              const selected = selectedVersionId
                                ? selectedVersionId === versionId
                                : isCurrent;
                              return (
                                <article key={versionId || index} className={"rounded-xl border p-3 " + (selected ? "border-blue-200 bg-blue-50/60" : "border-slate-200")}>
                                  <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div>
                                      <p className="font-semibold">Version {valueText(version.version)}</p>
                                      <p className="mt-1 text-xs text-slate-500">{formatDateTime(version.createdAt)}</p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {isCurrent ? <Badge tone="success">Current</Badge> : <StatusBadge status={valueText(version.status, "UNKNOWN")} />}
                                      <Badge tone="outline">Score {formatNumber(version.readinessScore)}</Badge>
                                    </div>
                                  </div>
                                  <p className="mt-2 text-xs text-slate-600">{formatNumber(version.evidenceCount, 0)} evidence item(s) · {valueText(version.changeReason, "No change reason recorded")}</p>
                                  {!isCurrent ? (
                                    <Button
                                      className="mt-3"
                                      size="sm"
                                      variant={selected ? "secondary" : "outline"}
                                      onClick={() => setSelectedVersionId(versionId)}
                                      disabled={!versionId}
                                    >
                                      {selected ? "Version selected" : "Inspect graph"}
                                    </Button>
                                  ) : null}
                                  {isCurrent && selectedVersionId ? (
                                    <Button className="mt-3" size="sm" variant="outline" onClick={() => setSelectedVersionId("")}>
                                      Return to current graph
                                    </Button>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        )}
                        <p className="mt-3 text-xs text-slate-500">Creator IDs and graph hashes are intentionally omitted from this workspace.</p>
                      </CardContent>
                    </Card>
                  </div>

                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle>Business process register</CardTitle>
                          <CardDescription>Processes visible in the active blueprint. Open-conflict items are excluded by the backend.</CardDescription>
                        </div>
                        <Badge tone="info">{processes.length} returned</Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {processes.length === 0 ? (
                        <EmptyState title="No visible business processes" description="No verified or inferred processes are available in the current blueprint and role scope." />
                      ) : (
                        <div className="grid gap-3 md:grid-cols-2">
                          {processes.slice(0, 12).map((process, index) => {
                            const processId = valueText(process.id, "");
                            const selected = effectiveProcessId.toLowerCase() === processId.toLowerCase();
                            return (
                              <article key={processId || index} className={"rounded-xl border p-4 " + (selected ? "border-blue-200 bg-blue-50/60" : "border-slate-200")}>
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <p className="font-semibold">{valueText(process.name, "Unnamed process")}</p>
                                  <StatusBadge status={valueText(process.state, "UNKNOWN")} />
                                </div>
                                <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-600">{valueText(process.description, "No process description recorded.")}</p>
                                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-xs text-slate-500">{formatNumber(process.stepCount, 0)} visible step(s) · confidence {formatNumber(process.confidence)}</span>
                                  <Button size="sm" variant={selected ? "secondary" : "outline"} onClick={() => setSelectedProcessId(processId)} disabled={!processId}>
                                    {selected ? "Selected" : "Inspect process"}
                                  </Button>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}
                      {processes.length > 12 ? <p className="mt-3 text-xs text-slate-500">Showing 12 of {processes.length} returned processes.</p> : null}
                    </CardContent>
                  </Card>

                  {selectedProcess ? (
                    <Card>
                      <CardHeader>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <CardTitle>Process detail · {valueText(visibleProcessResult?.process?.name, valueText(selectedProcess.name))}</CardTitle>
                            <CardDescription>Ordered, role-filtered process steps.</CardDescription>
                          </div>
                          <Badge tone="info">GET only</Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        {visibleProcessResult?.error ? <Alert tone="danger" title="Process detail unavailable">{visibleProcessResult.error}</Alert> : null}
                        {!visibleProcessResult ? <p className="py-4 text-sm text-slate-500">Loading process detail…</p> : null}
                        {visibleProcessResult && visibleProcessResult.steps.length === 0 ? (
                          <EmptyState title="No visible process steps" description="The selected process has no verified or inferred steps visible to this role." />
                        ) : null}
                        {visibleProcessResult && visibleProcessResult.steps.length > 0 ? (
                          <ol className="space-y-3">
                            {visibleProcessResult.steps.map((step, index) => (
                              <li key={valueText(step.id, String(index))} className="flex gap-3 rounded-xl border border-slate-100 p-3">
                                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold tabular-nums">{valueText(step.sequence, String(index + 1))}</span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="font-semibold">{valueText(step.name, "Unnamed step")}</p>
                                    <StatusBadge status={valueText(step.state, "UNKNOWN")} />
                                  </div>
                                  <p className="mt-1 text-sm leading-6 text-slate-600">{valueText(step.description, "No step description recorded.")}</p>
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : null}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Alert tone="info" title="Retrieval interpretation">
                    The business model API includes VERIFIED and INFERRED context and excludes PROPOSED, CONFLICTING and STALE graph items. Inferred data is contextual evidence, not a verified business fact.
                  </Alert>
                </>
              ) : null}
            </div>
          ) : null}

          {requestedTab === "evidence" ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>Internal evidence register</CardTitle>
                    <CardDescription>Evidence records and ACL-filtered visible links supporting the current business blueprint.</CardDescription>
                  </div>
                  <Badge tone="info">INTERNAL visibility only</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4 max-w-sm">
                  <label className="grid gap-1.5 text-sm font-medium">
                    Evidence state
                    <Select
                      value={evidenceState}
                      onChange={(event) => {
                        setEvidenceState(event.target.value as CbbEvidenceState | "");
                        setEvidencePage(0);
                      }}
                    >
                      {EVIDENCE_STATE_OPTIONS.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
                    </Select>
                  </label>
                </div>
                {visibleEvidenceResult?.error ? <Alert tone="danger" title="Evidence register unavailable">{visibleEvidenceResult.error}</Alert> : null}
                {!visibleEvidenceResult ? <p className="py-8 text-center text-sm text-slate-500">Loading internal evidence…</p> : null}
                {visibleEvidenceResult && visibleEvidenceResult.items.length === 0 ? (
                  <EmptyState title="No evidence records found" description="No internal evidence matches the selected state and the current role's target-level permissions." />
                ) : null}
                {visibleEvidenceResult && visibleEvidenceResult.items.length > 0 ? (
                  <div className="space-y-3">
                    {visibleEvidenceResult.items.map((evidence, index) => {
                      const links = asRecords(evidence.links);
                      return (
                        <article key={valueText(evidence.id, String(index))} className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-semibold">{valueText(evidence.source_type).replaceAll("_", " ")}</p>
                                <StatusBadge status={valueText(evidence.state, "UNKNOWN")} />
                                <Badge tone="outline">{valueText(evidence.evidence_grade, "Unrated")}</Badge>
                              </div>
                              <p className="mt-1 text-xs text-slate-500">
                                {valueText(evidence.source_system, "Source system not set")}
                                {evidence.source_version ? " · " + valueText(evidence.source_version) : ""}
                              </p>
                            </div>
                            <div className="text-right text-xs text-slate-500">
                              <p>Confidence {formatNumber(evidence.confidence)}</p>
                              <p>{formatDateTime(evidence.source_timestamp)}</p>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {links.map((link, linkIndex) => (
                              <Badge key={valueText(link.id, String(linkIndex))} tone="info">
                                {valueText(link.link_type).replaceAll("_", " ")} · {valueText(link.target_type).replaceAll("_", " ")}
                              </Badge>
                            ))}
                            {links.length === 0 ? <span className="text-xs text-slate-500">No visible target links</span> : null}
                          </div>
                          <p className="mt-3 text-xs text-slate-500">
                            Recorded {formatDateTime(evidence.created_at)} · revision {formatNumber(evidence.revision_no, 0)}
                          </p>
                        </article>
                      );
                    })}
                  </div>
                ) : null}
                {visibleEvidenceResult ? (
                  <Pagination
                    page={evidencePage}
                    total={visibleEvidenceResult.total}
                    onPrevious={() => setEvidencePage((value) => Math.max(0, value - 1))}
                    onNext={() => setEvidencePage((value) =>
                      value + 1 < Math.ceil(visibleEvidenceResult.total / PAGE_SIZE) ? value + 1 : value)}
                  />
                ) : null}
                <p className="mt-4 text-xs leading-5 text-slate-500">
                  Restricted evidence is intentionally excluded. Source URIs, raw references, content hashes, metadata, creator identities and internal record IDs are not rendered.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {requestedTab === "governance" ? (
            <div className="space-y-5">
              {visibleGovernanceResult?.errors.length ? (
                <Alert tone="warning" title="Some governance registers are unavailable">
                  {visibleGovernanceResult.errors.join(" ")}
                </Alert>
              ) : null}
              <section className="grid gap-3 sm:grid-cols-2">
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open conflicts in current result</p>
                    <p className="mt-2 text-2xl font-bold tabular-nums">{visibleGovernanceResult ? openConflictCount : "—"}</p>
                    <p className="mt-1 text-xs text-slate-500">Current filter page, not a factory-wide total</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open staleness reviews in result</p>
                    <p className="mt-2 text-2xl font-bold tabular-nums">{visibleGovernanceResult ? openStalenessCount : "—"}</p>
                    <p className="mt-1 text-xs text-slate-500">API returns at most 500 reviews</p>
                  </CardContent>
                </Card>
              </section>

              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>Business conflict register</CardTitle>
                      <CardDescription>Contradictory or unresolved evidence affecting readable blueprint targets.</CardDescription>
                    </div>
                    <Badge tone="info">ACL filtered by API</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 max-w-sm">
                    <label className="grid gap-1.5 text-sm font-medium">
                      Conflict status
                      <Select
                        value={conflictStatus}
                        onChange={(event) => {
                          setConflictStatus(event.target.value as CbbConflictStatus | "");
                          setConflictPage(0);
                        }}
                      >
                        {CONFLICT_STATUS_OPTIONS.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
                      </Select>
                    </label>
                  </div>
                  {visibleGovernanceResult?.conflicts.length === 0 ? (
                    <EmptyState title="No visible conflicts found" description="No conflicts match the selected status and the current role's target-level access." />
                  ) : null}
                  {visibleGovernanceResult?.conflicts.length ? (
                    <div className="space-y-3">
                      {visibleGovernanceResult.conflicts.map((conflict, index) => (
                        <article key={valueText(conflict.id, String(index))} className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="font-semibold">{valueText(conflict.subjectType).replaceAll("_", " ")}</p>
                              <p className="mt-1 text-xs text-slate-500">Created {formatDateTime(conflict.createdAt)} · version {valueText(conflict.version)}</p>
                            </div>
                            <StatusBadge status={valueText(conflict.status, "UNKNOWN")} />
                          </div>
                          <p className="mt-3 text-sm leading-6 text-slate-700">{valueText(conflict.description, "No conflict description recorded.")}</p>
                          {conflict.resolutionReason ? (
                            <p className="mt-2 text-sm leading-6 text-slate-600">Resolution note: {valueText(conflict.resolutionReason)}</p>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {visibleGovernanceResult ? (
                    <Pagination
                      page={conflictPage}
                      total={visibleGovernanceResult.conflictTotal}
                      onPrevious={() => setConflictPage((value) => Math.max(0, value - 1))}
                      onNext={() => setConflictPage((value) =>
                        value + 1 < Math.ceil(visibleGovernanceResult.conflictTotal / PAGE_SIZE) ? value + 1 : value)}
                    />
                  ) : null}
                  <p className="mt-3 text-xs text-slate-500">No conflict decision, resolution, dismissal or evidence mutation is available in this view.</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>Blueprint evidence staleness</CardTitle>
                      <CardDescription>Review freshness observations and current review status for readable targets.</CardDescription>
                    </div>
                    <Badge tone="info">Read only · max 500</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {!visibleGovernanceResult ? <p className="py-6 text-sm text-slate-500">Loading staleness reviews…</p> : null}
                  {visibleGovernanceResult && visibleGovernanceResult.staleness.length === 0 ? (
                    <EmptyState title="No visible staleness reviews" description="No staleness review rows are available for the active readable blueprint." />
                  ) : null}
                  {visibleGovernanceResult && visibleGovernanceResult.staleness.length > 0 ? (
                    <TableShell>
                      <TableHead>
                        <tr>
                          <th className="px-3 py-3">Target type</th>
                          <th className="px-3 py-3">Last evidence</th>
                          <th className="px-3 py-3">Threshold</th>
                          <th className="px-3 py-3">Review status</th>
                          <th className="px-3 py-3">Last scanned</th>
                        </tr>
                      </TableHead>
                      <tbody className="divide-y divide-slate-100">
                        {visibleGovernanceResult.staleness.map((review, index) => (
                          <tr key={valueText(review.id, String(index))}>
                            <td className="px-3 py-3 font-medium">{valueText(review.target_type).replaceAll("_", " ")}</td>
                            <td className="whitespace-nowrap px-3 py-3">{formatDateTime(review.last_evidence_at)}</td>
                            <td className="px-3 py-3">{formatNumber(review.stale_threshold_days, 0)} day(s)</td>
                            <td className="px-3 py-3"><StatusBadge status={valueText(review.review_status, "UNKNOWN")} /></td>
                            <td className="whitespace-nowrap px-3 py-3">{formatDateTime(review.last_scanned_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </TableShell>
                  ) : null}
                  <p className="mt-3 text-xs text-slate-500">Review reasons, reviewer identities and internal target IDs are not rendered. Scanning, marking stale, reconfirming and dismissing reviews remain outside this read-only page.</p>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {requestedTab === "terminology" ? (
            <div className="space-y-5">
              <Card>
                <CardHeader>
                  <CardTitle>Canonical terminology dictionary</CardTitle>
                  <CardDescription>Search canonical terms and approved aliases from the active blueprint's governed dictionary.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={applyTerminologySearch} className="flex flex-col gap-3 sm:flex-row">
                    <input
                      value={terminologyDraft}
                      onChange={(event) => setTerminologyDraft(event.target.value)}
                      maxLength={300}
                      aria-label="Search terminology"
                      placeholder="Search a business term or canonical phrase"
                      className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-700"
                    />
                    <Button type="submit">Search dictionary</Button>
                    {terminologySearch ? (
                      <Button type="button" variant="outline" onClick={() => {
                        setTerminologyDraft("");
                        setTerminologySearch("");
                      }}>
                        Clear
                      </Button>
                    ) : null}
                  </form>
                  {visibleTerminologyResult?.error ? <Alert className="mt-4" tone="danger" title="Terminology search unavailable">{visibleTerminologyResult.error}</Alert> : null}
                  {!visibleTerminologyResult ? <p className="py-8 text-center text-sm text-slate-500">Loading terminology dictionary…</p> : null}
                </CardContent>
              </Card>

              <div className="grid gap-5 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <CardTitle>Canonical terms</CardTitle>
                        <CardDescription>Blueprint version terms filtered by target-level access.</CardDescription>
                      </div>
                      <Badge tone="outline">{visibleTerminologyResult?.canonicalTerms.length ?? "—"} returned</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {visibleTerminologyResult && visibleTerminologyResult.canonicalTerms.length === 0 ? (
                      <EmptyState title="No canonical terms found" description="No terms match this search in the current readable blueprint." />
                    ) : null}
                    {visibleTerminologyResult && visibleTerminologyResult.canonicalTerms.length > 0 ? (
                      <div className="space-y-3">
                        {visibleTerminologyResult.canonicalTerms.slice(0, 60).map((term, index) => (
                          <article key={valueText(term.id, String(index))} className="rounded-xl border border-slate-200 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="font-semibold">{valueText(term.canonical_term, valueText(term.term))}</p>
                                {valueText(term.term, "") !== valueText(term.canonical_term, "") ? (
                                  <p className="mt-1 text-xs text-slate-500">Observed term: {valueText(term.term)}</p>
                                ) : null}
                              </div>
                              <StatusBadge status={valueText(term.state, "UNKNOWN")} />
                            </div>
                            <p className="mt-2 text-xs text-slate-500">
                              {valueText(term.language_code, "Language not set")} · {valueText(term.source_system, "Source not set")} · confidence {formatNumber(term.confidence)}
                            </p>
                          </article>
                        ))}
                        {visibleTerminologyResult.canonicalTerms.length > 60 ? <p className="text-xs text-slate-500">Showing 60 of {visibleTerminologyResult.canonicalTerms.length} returned canonical terms.</p> : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Terminology aliases</CardTitle>
                    <CardDescription>Alias-to-canonical mappings visible to this role.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {visibleTerminologyResult && visibleTerminologyResult.aliases.length === 0 ? (
                      <EmptyState title="No aliases found" description="No aliases match this search or current role scope." />
                    ) : null}
                    {visibleTerminologyResult && visibleTerminologyResult.aliases.length > 0 ? (
                      <TableShell>
                        <TableHead>
                          <tr>
                            <th className="px-3 py-3">Alias</th>
                            <th className="px-3 py-3">Canonical term</th>
                            <th className="px-3 py-3">Context</th>
                          </tr>
                        </TableHead>
                        <tbody className="divide-y divide-slate-100">
                          {visibleTerminologyResult.aliases.slice(0, 60).map((alias, index) => (
                            <tr key={valueText(alias.id, String(index))}>
                              <td className="px-3 py-3 font-medium">{valueText(alias.alias)}</td>
                              <td className="px-3 py-3">{valueText(alias.canonical_term)}</td>
                              <td className="px-3 py-3 text-xs text-slate-500">
                                {valueText(alias.language_code, "Any language")} · {valueText(alias.source_system, "Any source")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </TableShell>
                    ) : null}
                  </CardContent>
                </Card>
              </div>
              <Alert tone="info" title="Terminology governance">
                The dictionary is read-only here. Creating aliases, verifying or marking them stale, and changing canonical terms require the separate governed review workflow.
              </Alert>
            </div>
          ) : null}
        </>
      ) : null}

      <footer className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        Read-only CBB governance visibility. All requests use the shared authenticated session and selected active factory. Backend role/target ACL filters remain authoritative. Restricted evidence, raw source references, content hashes, metadata, user IDs and internal record identifiers are not displayed. No proposals, evidence links, conflict decisions, staleness transitions, terminology changes or blueprint rollbacks are submitted here.
      </footer>
    </main>
  );
}
