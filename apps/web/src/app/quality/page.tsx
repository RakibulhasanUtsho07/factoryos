"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import { createQualityWorkspaceClient } from "@/lib/quality-workspace.mjs";
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
type QualityView = "inspections" | "holds" | "rework" | "plans";
type ListResult = {
  key: string;
  items: JsonRecord[];
  error: string;
};
type DetailResult = {
  key: string;
  payload?: JsonRecord;
  error: string;
};

const INSPECTION_STATUS_OPTIONS = [
  { value: "", label: "All inspection statuses" },
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "PASSED", label: "Passed" },
  { value: "FAILED", label: "Failed" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "DISPOSITIONED", label: "Dispositioned" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

const INSPECTION_TYPE_OPTIONS = [
  { value: "", label: "All inspection types" },
  { value: "INCOMING", label: "Incoming" },
  { value: "IN_PROCESS", label: "In process" },
  { value: "FINAL", label: "Final" },
  { value: "INVENTORY", label: "Inventory" },
  { value: "SUPPLIER", label: "Supplier" },
] as const;

const PLAN_STATUS_OPTIONS = [
  { value: "", label: "All plan statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "ACTIVE", label: "Active" },
  { value: "RETIRED", label: "Retired" },
] as const;

const HOLD_STATUS_OPTIONS = [
  { value: "", label: "All hold statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "RELEASED", label: "Released" },
  { value: "DISPOSED", label: "Disposed" },
] as const;

const REWORK_STATUS_OPTIONS = [
  { value: "", label: "All rework statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "APPROVED", label: "Approved" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "REWORK_REQUIRED", label: "Rework required" },
  { value: "VERIFIED", label: "Verified" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

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

function formatNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(number)
    : valueText(value);
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
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

function displayLabel(value: unknown): string {
  return valueText(value, "Unknown").replaceAll("_", " ").toLowerCase();
}

function getItems(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return asRecords(payload);
  return asRecords(asRecord(payload).items);
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      </CardContent>
    </Card>
  );
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-800">{valueText(value)}</dd>
    </div>
  );
}

function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-slate-950">{title}</h3>
      <Badge tone="neutral">{count} returned</Badge>
    </div>
  );
}

export default function QualityWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [view, setView] = useState<QualityView>("inspections");
  const [inspectionStatus, setInspectionStatus] = useState("");
  const [inspectionType, setInspectionType] = useState("");
  const [planStatus, setPlanStatus] = useState("");
  const [holdStatus, setHoldStatus] = useState("ACTIVE");
  const [reworkStatus, setReworkStatus] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selection, setSelection] = useState<{ scopeKey: string; inspectionId: string } | null>(null);
  const [listResult, setListResult] = useState<ListResult | null>(null);
  const [detailResult, setDetailResult] = useState<DetailResult | null>(null);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canReadQuality = connected && hasPermission("quality.inspections.read");
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const scopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const selectedInspectionId = selection?.scopeKey === scopeKey ? selection.inspectionId : "";

  const listKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadQuality,
    view,
    inspectionStatus,
    inspectionType,
    planStatus,
    holdStatus,
    reworkStatus,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadQuality,
    view,
    inspectionStatus,
    inspectionType,
    planStatus,
    holdStatus,
    reworkStatus,
    refreshVersion,
  ]);

  const detailKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadQuality,
    view,
    inspectionStatus,
    inspectionType,
    selectedInspectionId,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadQuality,
    view,
    inspectionStatus,
    inspectionType,
    selectedInspectionId,
    refreshVersion,
  ]);

  const currentList = listResult?.key === listKey ? listResult : null;
  const currentDetail = detailResult?.key === detailKey ? detailResult : null;
  const loadingList = connected && Boolean(activeFactoryId) && canReadQuality && currentList === null;
  const loadingDetail = view === "inspections" && Boolean(selectedInspectionId)
    && canReadQuality && currentDetail === null;

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadQuality) return;

    let active = true;
    const client = createQualityWorkspaceClient({ request });
    const load = async () => {
      try {
        let payload: unknown;
        if (view === "inspections") {
          payload = await client.listInspections({
            status: inspectionStatus || undefined,
            inspectionType: inspectionType || undefined,
            limit: 100,
          });
        } else if (view === "holds") {
          payload = await client.listHolds({
            status: holdStatus || undefined,
            limit: 100,
          });
        } else if (view === "rework") {
          payload = await client.listReworkOrders({
            status: reworkStatus || undefined,
            limit: 100,
          });
        } else {
          payload = await client.listInspectionPlans({
            status: planStatus || undefined,
            limit: 100,
          });
        }
        if (!active) return;
        setListResult({ key: listKey, items: getItems(payload), error: "" });
      } catch (cause) {
        if (!active) return;
        setListResult({
          key: listKey,
          items: [],
          error: cause instanceof Error ? cause.message : "Quality records could not be loaded.",
        });
      }
    };
    void load();

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadQuality,
    request,
    view,
    inspectionStatus,
    inspectionType,
    planStatus,
    holdStatus,
    reworkStatus,
    refreshVersion,
    listKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadQuality
      || view !== "inspections" || !selectedInspectionId) return;

    let active = true;
    const client = createQualityWorkspaceClient({ request });
    void client.getInspection(selectedInspectionId).then((payload) => {
      if (!active) return;
      setDetailResult({ key: detailKey, payload: asRecord(payload), error: "" });
    }).catch((cause: unknown) => {
      if (!active) return;
      setDetailResult({
        key: detailKey,
        error: cause instanceof Error ? cause.message : "Inspection details could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadQuality,
    request,
    view,
    selectedInspectionId,
    detailKey,
  ]);

  const items = currentList?.items ?? [];
  const detail = asRecord(currentDetail?.payload);
  const defects = asRecords(detail.defects);
  const holds = asRecords(detail.holds);
  const dispositions = asRecords(detail.dispositions);
  const results = asRecords(detail.results);
  const ncr = detail.ncr ? asRecord(detail.ncr) : null;
  const ncrActions = asRecords(ncr?.actions);
  const listCount = items.length;

  function refresh() {
    setRefreshVersion((value) => value + 1);
  }

  function changeView(next: QualityView) {
    setSelection(null);
    setView(next);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Quality assurance · containment & corrective action"
        title="Quality Workbench"
        description="Review inspection queues, non-conformance records, quality holds and rework orders for the selected factory."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={!connected || !activeFactoryId || !canReadQuality || loadingList || loadingDetail}
            >
              Refresh quality
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Alert tone={connected && activeFactoryId ? "success" : "warning"} title="Workspace scope">
          {connected && snapshot
            ? snapshot.tenant.name + (activeFactory
              ? " · " + activeFactory.code + " — " + activeFactory.name
              : " · Select an active factory")
            : "Connect an existing FactoryOS session to inspect quality records."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">
                Open session setup
              </Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canReadQuality ? "success" : "info"} title="Quality read permission">
          {canReadQuality
            ? "The quality workspace requires quality.inspections.read. The API independently enforces permission and factory scope on every request."
            : "Inspection, hold, plan, rework and NCR detail views require quality.inspections.read."}
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose an active factory returned by the authenticated IAM session. Quality records are never loaded across all factories."
        />
      ) : null}

      {connected && activeFactoryId && !canReadQuality ? (
        <EmptyState
          title="Quality access is not available"
          description="The current IAM permission snapshot does not include quality.inspections.read. Ask an authorized administrator to review your access."
        />
      ) : null}

      {connected && activeFactoryId && canReadQuality ? (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <MetricCard
              label="Inspections returned"
              value={view === "inspections" ? String(listCount) : "—"}
              hint="Current queue · maximum 100 rows"
            />
            <MetricCard
              label="Quality holds returned"
              value={view === "holds" ? String(listCount) : "—"}
              hint="Current hold filter · maximum 100 rows"
            />
            <MetricCard
              label="Rework orders returned"
              value={view === "rework" ? String(listCount) : "—"}
              hint="Current rework filter · maximum 100 rows"
            />
          </div>

          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Quality work queues">
            {([
              ["inspections", "Inspections"],
              ["holds", "Quality holds"],
              ["rework", "Rework orders"],
              ["plans", "Inspection plans"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => changeView(key)}
                className={[
                  "min-h-10 rounded-lg border px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                  view === key
                    ? "border-brand-300 bg-brand-50 text-brand-800"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>

          <Card className="mb-6">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>
                    {view === "inspections" ? "Inspection queue"
                      : view === "holds" ? "Quality hold register"
                        : view === "rework" ? "Rework order queue"
                          : "Inspection plan register"}
                  </CardTitle>
                  <CardDescription>
                    {view === "inspections" ? "Inspect quality status, defect counts and containment indicators."
                      : view === "holds" ? "Review active, released and disposed quality holds."
                        : view === "rework" ? "Review rework lifecycle, input quantity and recovered/scrap quantities."
                          : "Review inspection plan revisions, active state and criterion definitions."}
                  </CardDescription>
                </div>
                <Badge tone="neutral">Maximum 100 rows</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                {view === "inspections" ? (
                  <>
                    <div>
                      <label htmlFor="quality-inspection-status" className="block text-xs font-semibold text-slate-700">Inspection status</label>
                      <select
                        id="quality-inspection-status"
                        value={inspectionStatus}
                        onChange={(event) => {
                          setSelection(null);
                          setInspectionStatus(event.target.value);
                        }}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {INSPECTION_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="quality-inspection-type" className="block text-xs font-semibold text-slate-700">Inspection type</label>
                      <select
                        id="quality-inspection-type"
                        value={inspectionType}
                        onChange={(event) => {
                          setSelection(null);
                          setInspectionType(event.target.value);
                        }}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {INSPECTION_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </div>
                  </>
                ) : null}
                {view === "holds" ? (
                  <div>
                    <label htmlFor="quality-hold-status" className="block text-xs font-semibold text-slate-700">Hold status</label>
                    <select
                      id="quality-hold-status"
                      value={holdStatus}
                      onChange={(event) => setHoldStatus(event.target.value)}
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                    >
                      {HOLD_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                ) : null}
                {view === "rework" ? (
                  <div>
                    <label htmlFor="quality-rework-status" className="block text-xs font-semibold text-slate-700">Rework status</label>
                    <select
                      id="quality-rework-status"
                      value={reworkStatus}
                      onChange={(event) => setReworkStatus(event.target.value)}
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                    >
                      {REWORK_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                ) : null}
                {view === "plans" ? (
                  <div>
                    <label htmlFor="quality-plan-status" className="block text-xs font-semibold text-slate-700">Plan status</label>
                    <select
                      id="quality-plan-status"
                      value={planStatus}
                      onChange={(event) => setPlanStatus(event.target.value)}
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                    >
                      {PLAN_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                ) : null}
              </div>

              {currentList?.error ? (
                <Alert tone="danger" title="Could not load quality records">{currentList.error}</Alert>
              ) : loadingList ? (
                <div className="space-y-3" aria-label="Loading quality records">
                  {[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}
                </div>
              ) : items.length === 0 ? (
                <EmptyState
                  title={view === "inspections" ? "No inspections returned"
                    : view === "holds" ? "No quality holds returned"
                      : view === "rework" ? "No rework orders returned"
                        : "No inspection plans returned"}
                  description="No records were returned for this factory and the current filters."
                />
              ) : view === "inspections" ? (
                <div className="grid gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                  <div className="space-y-2">
                    {items.map((item) => {
                      const id = valueText(item.id, "");
                      const selected = id !== "" && id === selectedInspectionId;
                      return (
                        <button
                          type="button"
                          key={id}
                          disabled={!id}
                          onClick={() => setSelection({ scopeKey, inspectionId: id })}
                          aria-pressed={selected}
                          className={[
                            "w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                            selected ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
                          ].join(" ")}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-950">{displayLabel(item.inspection_type)}</p>
                              <p className="mt-1 text-xs text-slate-500">{displayLabel(item.target_type)} · {valueText(item.target_id)}</p>
                            </div>
                            <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                            <span>Plan: {valueText(item.plan_code, "No plan")}{item.plan_revision ? " · rev " + valueText(item.plan_revision) : ""}</span>
                            <span>Defects: {formatNumber(item.defect_count)}</span>
                            <span>{item.on_quality_hold === true ? "Quality hold active" : "No active hold flag"}</span>
                          </div>
                          <p className="mt-2 text-[11px] text-slate-500">Created {formatDateTime(item.created_at)}</p>
                        </button>
                      );
                    })}
                    <p className="pt-1 text-[11px] text-slate-500">Showing {items.length} of up to 100 inspections returned.</p>
                  </div>

                  <div className="min-w-0">
                    {!selectedInspectionId ? (
                      <EmptyState
                        title="Select an inspection"
                        description="Choose an inspection to review its defects, results, holds, dispositions and associated NCR/CAPA record."
                      />
                    ) : loadingDetail ? (
                      <div className="h-72 animate-pulse rounded-xl bg-slate-100" aria-label="Loading inspection detail" />
                    ) : currentDetail?.error ? (
                      <Alert tone="danger" title="Could not load inspection detail">{currentDetail.error}</Alert>
                    ) : currentDetail?.payload ? (
                      <div className="space-y-4">
                        <section className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Inspection record</p>
                              <h3 className="mt-1 text-lg font-semibold text-slate-950">{displayLabel(detail.inspection_type)} inspection</h3>
                              <p className="mt-1 text-xs text-slate-500">{displayLabel(detail.target_type)} · {valueText(detail.target_id)}</p>
                            </div>
                            <StatusBadge status={valueText(detail.status, "UNKNOWN")} />
                          </div>
                          <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                            <DetailField label="Plan" value={valueText(detail.plan_code, "No plan assigned")} />
                            <DetailField label="Plan revision" value={detail.plan_revision} />
                            <DetailField label="Sample quantity" value={detail.sample_quantity} />
                            <DetailField label="Record version" value={detail.row_version} />
                            <DetailField label="Created" value={formatDateTime(detail.created_at)} />
                            <DetailField label="Last updated" value={formatDateTime(detail.updated_at)} />
                          </dl>
                          {typeof detail.notes === "string" && detail.notes.trim()
                            ? <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{detail.notes}</p>
                            : null}
                        </section>

                        <section className="rounded-xl border border-slate-200 p-4">
                          <SectionHeading title="Defects" count={defects.length} />
                          {defects.length ? (
                            <div className="mt-3 space-y-2">
                              {defects.map((defect) => (
                                <article key={valueText(defect.id)} className="rounded-lg bg-slate-50 p-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="font-semibold text-slate-900">{valueText(defect.defect_code)}</p>
                                    <div className="flex items-center gap-2">
                                      <Badge tone={valueText(defect.severity) === "CRITICAL" ? "danger" : valueText(defect.severity) === "MAJOR" ? "warning" : "neutral"}>
                                        {displayLabel(defect.severity)}
                                      </Badge>
                                      <StatusBadge status={valueText(defect.status, "UNKNOWN")} />
                                    </div>
                                  </div>
                                  <p className="mt-2 text-sm leading-6 text-slate-700">{valueText(defect.description)}</p>
                                  <p className="mt-2 text-xs text-slate-500">
                                    Affected quantity: {formatNumber(defect.affected_quantity)} · Reported {formatDateTime(defect.created_at)}
                                  </p>
                                </article>
                              ))}
                            </div>
                          ) : <p className="mt-3 text-sm text-slate-500">No defects were returned for this inspection.</p>}
                        </section>

                        <section className="rounded-xl border border-slate-200 p-4">
                          <SectionHeading title="Inspection results" count={results.length} />
                          {results.length ? (
                            <div className="mt-3 space-y-2">
                              {results.map((result, index) => {
                                const criterion = asRecord(result.criterion_snapshot);
                                return (
                                  <article key={valueText(result.id, valueText(result.criterion_code, String(index)))} className="rounded-lg border border-slate-100 p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="font-semibold text-slate-900">{valueText(result.criterion_code)} · {valueText(criterion.name, "Inspection criterion")}</p>
                                      <StatusBadge status={valueText(result.outcome, "UNKNOWN")} />
                                    </div>
                                    <p className="mt-2 text-sm text-slate-700">
                                      Observed: <span className="font-semibold">{valueText(result.observed_value)}</span>
                                      {criterion.unit ? " " + valueText(criterion.unit) : ""}
                                    </p>
                                    {typeof result.notes === "string" && result.notes.trim()
                                      ? <p className="mt-1 text-xs text-slate-500">{result.notes}</p>
                                      : null}
                                    <p className="mt-1 text-[11px] text-slate-400">Attempt {valueText(result.attempt, "—")} · {formatDateTime(result.created_at)}</p>
                                  </article>
                                );
                              })}
                            </div>
                          ) : <p className="mt-3 text-sm text-slate-500">No inspection result records were returned.</p>}
                        </section>

                        <section className="rounded-xl border border-slate-200 p-4">
                          <SectionHeading title="Quality holds" count={holds.length} />
                          {holds.length ? (
                            <div className="mt-3 space-y-2">
                              {holds.map((hold) => (
                                <article key={valueText(hold.id)} className="rounded-lg bg-slate-50 p-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-sm font-semibold text-slate-900">{valueText(hold.reason)}</p>
                                    <StatusBadge status={valueText(hold.status, "UNKNOWN")} />
                                  </div>
                                  <p className="mt-2 text-xs text-slate-500">Created {formatDateTime(hold.created_at)}</p>
                                  {typeof hold.release_reason === "string" && hold.release_reason.trim()
                                    ? <p className="mt-1 text-xs text-slate-600">Release reason: {hold.release_reason}</p>
                                    : null}
                                  {hold.released_at ? <p className="mt-1 text-xs text-slate-500">Released {formatDateTime(hold.released_at)}</p> : null}
                                </article>
                              ))}
                            </div>
                          ) : <p className="mt-3 text-sm text-slate-500">No quality holds were returned for this inspection.</p>}
                        </section>

                        <section className="rounded-xl border border-slate-200 p-4">
                          <SectionHeading title="Dispositions" count={dispositions.length} />
                          {dispositions.length ? (
                            <div className="mt-3 space-y-2">
                              {dispositions.map((disposition) => (
                                <article key={valueText(disposition.id)} className="rounded-lg bg-slate-50 p-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="font-semibold text-slate-900">{displayLabel(disposition.action)}</p>
                                    <StatusBadge status={valueText(disposition.status, "UNKNOWN")} />
                                  </div>
                                  <p className="mt-2 text-sm text-slate-700">{valueText(disposition.reason)}</p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    Quantity: {formatNumber(disposition.quantity)} · Created {formatDateTime(disposition.created_at)}
                                  </p>
                                </article>
                              ))}
                            </div>
                          ) : <p className="mt-3 text-sm text-slate-500">No disposition records were returned.</p>}
                        </section>

                        <section className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="font-semibold text-slate-950">Non-conformance report (NCR) / CAPA</h4>
                            {ncr ? <StatusBadge status={valueText(ncr.status, "UNKNOWN")} /> : <Badge tone="neutral">No NCR linked</Badge>}
                          </div>
                          {ncr ? (
                            <>
                              <div className="mt-3">
                                <p className="font-semibold text-slate-900">{valueText(ncr.ncr_number)}</p>
                                <p className="mt-1 text-sm text-slate-700">{valueText(ncr.title)}</p>
                                <p className="mt-2 text-sm leading-6 text-slate-600">{valueText(ncr.summary)}</p>
                                <p className="mt-2 text-xs text-slate-500">
                                  Severity: {displayLabel(ncr.severity)} · Opened {formatDateTime(ncr.created_at)}
                                </p>
                                {ncr.closed_at ? <p className="mt-1 text-xs text-slate-500">Closed {formatDateTime(ncr.closed_at)} · {valueText(ncr.closure_reason)}</p> : null}
                              </div>
                              <div className="mt-4 border-t border-slate-100 pt-3">
                                <SectionHeading title="CAPA actions" count={ncrActions.length} />
                                {ncrActions.length ? (
                                  <div className="mt-3 space-y-2">
                                    {ncrActions.map((action) => {
                                      const actionEvents = asRecords(action.events);
                                      return (
                                        <article key={valueText(action.id)} className="rounded-lg bg-slate-50 p-3">
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                            <p className="font-semibold text-slate-900">{displayLabel(action.action_type)}</p>
                                            <StatusBadge status={valueText(action.action_status, "UNKNOWN")} />
                                          </div>
                                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{valueText(action.action_text)}</p>
                                          <p className="mt-2 text-xs text-slate-500">Due: {formatDate(action.due_date)} · Created {formatDateTime(action.created_at)}</p>
                                          {typeof action.completion_notes === "string" && action.completion_notes.trim()
                                            ? <p className="mt-2 text-xs text-slate-600">Completion: {action.completion_notes}</p>
                                            : null}
                                          {typeof action.verification_notes === "string" && action.verification_notes.trim()
                                            ? <p className="mt-1 text-xs text-slate-600">Verification: {action.verification_notes}</p>
                                            : null}
                                          {actionEvents.length ? (
                                            <ol className="mt-3 space-y-2 border-l-2 border-slate-200 pl-3">
                                              {actionEvents.map((event, index) => (
                                                <li key={valueText(event.id, String(index))}>
                                                  <p className="text-xs font-semibold text-slate-700">
                                                    {displayLabel(event.command)} · {displayLabel(event.from_status)} → {displayLabel(event.to_status)}
                                                  </p>
                                                  <p className="mt-0.5 text-xs text-slate-500">{valueText(event.reason)} · {formatDateTime(event.created_at)}</p>
                                                </li>
                                              ))}
                                            </ol>
                                          ) : null}
                                        </article>
                                      );
                                    })}
                                  </div>
                                ) : <p className="mt-3 text-sm text-slate-500">No CAPA actions were returned for this NCR.</p>}
                              </div>
                            </>
                          ) : (
                            <p className="mt-3 text-sm text-slate-500">No NCR record is currently linked to this inspection.</p>
                          )}
                        </section>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : view === "holds" ? (
                <div className="space-y-2">
                  {items.map((item) => (
                    <article key={valueText(item.id)} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-slate-950">{displayLabel(item.inspection_type)} · {displayLabel(item.target_type)}</p>
                          <p className="mt-1 text-sm text-slate-700">{valueText(item.reason)}</p>
                        </div>
                        <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                        <span>Inspection: {displayLabel(item.inspection_status)}</span>
                        <span>Target: {valueText(item.target_id)}</span>
                        <span>Created: {formatDateTime(item.created_at)}</span>
                      </div>
                      {typeof item.release_reason === "string" && item.release_reason.trim()
                        ? <p className="mt-2 text-xs text-slate-600">Release reason: {item.release_reason}</p>
                        : null}
                    </article>
                  ))}
                </div>
              ) : view === "rework" ? (
                <div className="space-y-2">
                  {items.map((item) => (
                    <article key={valueText(item.id)} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-slate-950">{valueText(item.rework_number)}</p>
                          <p className="mt-1 text-sm text-slate-700">Defect {valueText(item.defect_code)} · {valueText(item.ncr_number, "No NCR")}</p>
                        </div>
                        <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
                        <DetailField label="Severity" value={item.severity} />
                        <DetailField label="Input quantity" value={item.input_quantity} />
                        <DetailField label="Recovered / scrap" value={formatNumber(item.recovered_quantity) + " / " + formatNumber(item.scrap_quantity)} />
                      </div>
                      <p className="mt-2 text-[11px] text-slate-500">Created {formatDateTime(item.created_at)}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {items.map((item) => {
                    const criteria = asRecords(item.criteria);
                    return (
                      <article key={valueText(item.id)} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-950">{valueText(item.plan_code)} · {valueText(item.name)}</p>
                            <p className="mt-1 text-xs text-slate-500">{displayLabel(item.inspection_type)} · Revision {valueText(item.revision)}</p>
                          </div>
                          <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
                          <DetailField label="Default sample quantity" value={item.default_sample_quantity} />
                          <DetailField label="Criteria" value={criteria.length} />
                          <DetailField label="Version" value={item.row_version} />
                        </div>
                        {criteria.length ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {criteria.slice(0, 12).map((criterion) => (
                              <span key={valueText(criterion.criterion_code)} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
                                {valueText(criterion.criterion_code)} · {valueText(criterion.name)}
                                {criterion.is_critical === true ? " · Critical" : ""}
                              </span>
                            ))}
                            {criteria.length > 12 ? <span className="self-center text-xs text-slate-500">+{criteria.length - 12} more criteria</span> : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
              {!loadingList && !currentList?.error && items.length ? (
                <p className="mt-4 text-[11px] text-slate-500">
                  Showing {items.length} rows returned by the selected factory API scope. The list endpoint is bounded to 100 records.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <p className="mt-4 text-xs leading-5 text-slate-500">
            This workbench is read-only. It does not create inspections or defects, record results, change inspection decisions, release/dispose holds, create or transition rework orders, plan/verify CAPA actions, or close NCRs. Evidence blobs, actor identifiers and internal idempotency data are not rendered.
          </p>
        </>
      ) : null}
    </main>
  );
}
