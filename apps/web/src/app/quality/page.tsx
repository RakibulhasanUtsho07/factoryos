"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildQualityDecisionPayload,
  buildQualityDefectPayload,
  buildQualityDispositionPayload,
  buildQualityInspectionPayload,
  buildQualityNcrActionPayload,
  buildQualityNcrTransitionPayload,
  buildQualityNcrVerificationPayload,
  buildQualityPlanPayload,
  buildQualityQuery,
  buildQualityResultPayload,
  filterQualityRows,
  normalizeQualityRows,
  summarizeQualityWorkspace,
} from "@/lib/quality-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "INSPECTIONS" | "PLANS" | "CONTAINMENT" | "ANALYTICS";
type Notice = { tone: "success" | "error"; message: string };

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "INSPECTIONS", label: "Inspections", description: "Incoming, in-process, final and inventory inspection execution" },
  { id: "PLANS", label: "Inspection plans", description: "Revisioned acceptance criteria with controlled activation" },
  { id: "CONTAINMENT", label: "Holds & rework", description: "Quarantine, disposition, rework and NCR/CAPA visibility" },
  { id: "ANALYTICS", label: "Quality analytics", description: "Defect Pareto, supplier quality and repeat-defect signals" },
];

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function rows(value: unknown, key = "items"): Row[] {
  return normalizeQualityRows(value, key).map((entry) => object(entry));
}

function display(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The quality request could not be completed.";
}

function dateTime(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function newIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure idempotency-key generation is unavailable.");
  return "quality:" + globalThis.crypto.randomUUID();
}

function toneForStatus(value: unknown) {
  const status = display(value, "UNKNOWN").toUpperCase();
  if (["ACTIVE", "PASSED", "VERIFIED", "COMPLETED", "RELEASED", "DISPOSITIONED"].includes(status)) {
    return "bg-emerald-50 text-emerald-800";
  }
  if (["DRAFT", "OPEN", "IN_PROGRESS", "ON_HOLD", "PLANNED", "APPROVED", "REWORK_REQUIRED"].includes(status)) {
    return "bg-amber-50 text-amber-900";
  }
  if (["RETIRED", "CANCELLED"].includes(status)) return "bg-slate-100 text-slate-700";
  return "bg-rose-50 text-rose-800";
}

function StatusPill({ value }: { value: unknown }) {
  const status = display(value, "UNKNOWN").toUpperCase();
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + toneForStatus(status)}>{status.replaceAll("_", " ")}</span>;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-4 text-slate-500">{hint}</span> : null}
    </label>
  );
}

function Section({ title, subtitle, children, action }: { title: string; subtitle: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-sm font-bold text-slate-950">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p>
        </div>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">{children}</div>;
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>{headers.map((header) => <th key={header} className="whitespace-nowrap px-3 py-3 font-bold">{header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p>
    </div>
  );
}

export default function QualityManagementWorkbenchPage() {
  const { status: sessionStatus, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const permissions = {
    inspectionsRead: hasPermission("quality.inspections.read"),
    inspectionsWrite: hasPermission("quality.inspections.write"),
    plansManage: hasPermission("quality.plans.manage"),
    defectsWrite: hasPermission("quality.defects.write"),
    disposition: hasPermission("quality.disposition.decide"),
    ncrManage: hasPermission("quality.ncr.manage"),
    capaVerify: hasPermission("quality.capa.verify"),
    advancedRead: hasPermission("quality.advanced.read"),
    advancedManage: hasPermission("quality.advanced.manage"),
    reworkManage: hasPermission("quality.rework.manage"),
  };
  const canRead = permissions.inspectionsRead;
  const canOpenWorkspace = canRead || permissions.plansManage || permissions.advancedRead || permissions.advancedManage;

  const [tab, setTab] = useState<Tab>("INSPECTIONS");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadedFactoryId, setLoadedFactoryId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  const [inspections, setInspections] = useState<Row[]>([]);
  const [plans, setPlans] = useState<Row[]>([]);
  const [holds, setHolds] = useState<Row[]>([]);
  const [reworkOrders, setReworkOrders] = useState<Row[]>([]);
  const [pareto, setPareto] = useState<Row[]>([]);
  const [supplierQuality, setSupplierQuality] = useState<Row[]>([]);
  const [repeatAlerts, setRepeatAlerts] = useState<Row[]>([]);

  const [inspectionSearch, setInspectionSearch] = useState("");
  const [inspectionStatus, setInspectionStatus] = useState("ALL");
  const [planSearch, setPlanSearch] = useState("");
  const [planStatus, setPlanStatus] = useState("ALL");
  const [selectedInspectionId, setSelectedInspectionId] = useState("");
  const [inspectionDetail, setInspectionDetail] = useState<Row | null>(null);

  const [inspectionDraft, setInspectionDraft] = useState({
    inspection_type: "INCOMING", target_type: "INVENTORY_ITEM", target_id: "", plan_code: "", sample_quantity: "1", notes: "",
  });
  const [planDraft, setPlanDraft] = useState({
    plan_code: "", name: "", inspection_type: "INCOMING", default_sample_quantity: "1", notes: "",
    criteria: JSON.stringify([{
      criterion_code: "DIMENSION", name: "Measured dimension", value_type: "NUMERIC",
      comparison_operator: "BETWEEN", lower_limit: 10, upper_limit: 12, unit: "mm",
      is_required: true, is_critical: true, sequence_number: 1,
    }], null, 2),
  });
  const [defectDraft, setDefectDraft] = useState({
    defect_code: "", severity: "MAJOR", affected_quantity: "1", description: "", evidence_reference: "",
  });
  const [resultDraft, setResultDraft] = useState({ criterion_code: "", observed_value: "", notes: "", evidence_reference: "" });
  const [decisionReason, setDecisionReason] = useState("");
  const [dispositionDraft, setDispositionDraft] = useState({ action: "RELEASE", quantity: "", reason: "" });
  const [ncrActionDraft, setNcrActionDraft] = useState({
    action_type: "CONTAINMENT", action_text: "", due_date: "", responsible_user_id: "",
  });
  const [capaReason, setCapaReason] = useState("");
  const [capaEvidenceReference, setCapaEvidenceReference] = useState("");
  const [ncrClosureReason, setNcrClosureReason] = useState("");
  const [analyticsDimension, setAnalyticsDimension] = useState("DEFECT");
  const [analyticsLookback, setAnalyticsLookback] = useState("30");

  const visibleInspections = useMemo(
    () => filterQualityRows(inspections, inspectionSearch, inspectionStatus),
    [inspections, inspectionSearch, inspectionStatus],
  );
  const visiblePlans = useMemo(() => filterQualityRows(plans, planSearch, planStatus), [plans, planSearch, planStatus]);
  const summary = useMemo(
    () => summarizeQualityWorkspace({ inspections, plans, holds, reworkOrders }),
    [inspections, plans, holds, reworkOrders],
  );

  async function loadAnalytics() {
    if (!permissions.advancedRead) return;
    const safe = async (path: string) => {
      try { return await request(path); } catch { return null; }
    };
    const [paretoResult, supplierResult, repeatResult] = await Promise.all([
      safe("/quality/analytics/defect-pareto?dimension=" + encodeURIComponent(analyticsDimension) + "&limit=10"),
      safe("/quality/analytics/supplier-quality?limit=10"),
      safe("/quality/analytics/rework-repeat-alerts?lookback_days=" + encodeURIComponent(analyticsLookback) + "&minimum_occurrences=2&limit=10"),
    ]);
    setPareto(rows(paretoResult));
    setSupplierQuality(rows(supplierResult));
    setRepeatAlerts(rows(repeatResult));
  }

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      if (sessionStatus !== "connected" || !activeFactoryId || !canOpenWorkspace) return;
      setLoading(true);
      setNotice(null);
      setLoadedFactoryId("");
      const requests: Array<{ key: string; enabled: boolean; path: string }> = [
        { key: "inspections", enabled: permissions.inspectionsRead, path: "/quality/inspections" + buildQualityQuery({ limit: 100 }, "inspections") },
        { key: "plans", enabled: permissions.inspectionsRead, path: "/quality/plans" + buildQualityQuery({ limit: 100 }, "plans") },
        { key: "holds", enabled: permissions.inspectionsRead, path: "/quality/holds" + buildQualityQuery({ limit: 100 }, "holds") },
        { key: "rework", enabled: permissions.inspectionsRead, path: "/quality/rework-orders" + buildQualityQuery({ limit: 100 }, "rework") },
      ];
      try {
        const enabled = requests.filter((entry) => entry.enabled);
        const values = await Promise.all(enabled.map(async (entry) => {
          try { return { key: entry.key, value: await request(entry.path) }; }
          catch (error) { return { key: entry.key, error }; }
        }));
        if (cancelled) return;
        const result = Object.fromEntries(values.map((entry) => [entry.key, "value" in entry ? entry.value : null])) as Record<string, unknown>;
        const failures = values.filter((entry) => "error" in entry);
        setInspections(rows(result.inspections, "inspections"));
        setPlans(rows(result.plans, "plans"));
        setHolds(rows(result.holds, "holds"));
        setReworkOrders(rows(result.rework, "rework_orders"));
        if (failures.length) {
          const failure = failures[0] as { error: unknown };
          setNotice({ tone: "error", message: "Some quality lists could not load: " + errorMessage(failure.error) });
        }
        setLoadedFactoryId(activeFactoryId);
      } catch (error) {
        if (!cancelled) setNotice({ tone: "error", message: errorMessage(error) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    sessionStatus, activeFactoryId, canOpenWorkspace, permissions.inspectionsRead,
    permissions.plansManage, refreshVersion, request,
  ]);

  useEffect(() => {
    if (tab !== "ANALYTICS" || !permissions.advancedRead || sessionStatus !== "connected" || !activeFactoryId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadAnalytics().catch((error) => {
        if (!cancelled) setNotice({ tone: "error", message: errorMessage(error) });
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tab, permissions.advancedRead, sessionStatus, activeFactoryId, analyticsDimension, analyticsLookback, refreshVersion, request]);

  async function refreshSelected() {
    if (!selectedInspectionId || !permissions.inspectionsRead) return;
    try {
      setInspectionDetail(object(await request("/quality/inspections/" + encodeURIComponent(selectedInspectionId))));
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  }

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setRefreshVersion((current) => current + 1);
      if (selectedInspectionId && permissions.inspectionsRead) {
        try {
          setInspectionDetail(object(await request("/quality/inspections/" + encodeURIComponent(selectedInspectionId))));
        } catch {
          setInspectionDetail(null);
        }
      }
      setNotice({ tone: "success", message: success });
      return result;
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openInspection(id: string) {
    if (!permissions.inspectionsRead) return;
    setSelectedInspectionId(id);
    setInspectionDetail(null);
    try {
      setInspectionDetail(object(await request("/quality/inspections/" + encodeURIComponent(id))));
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  }

  async function createInspection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildQualityInspectionPayload(inspectionDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = object(await perform(
      () => request("/quality/inspections", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Quality inspection created in the selected factory.",
    ));
    if (result.id) {
      const id = String(result.id);
      setSelectedInspectionId(id);
      setTab("INSPECTIONS");
      await openInspection(id);
    }
  }

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildQualityPlanPayload(planDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/plans", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "A new inspection-plan revision was created as DRAFT.",
    );
    if (result) setPlanDraft({ ...planDraft, plan_code: "", name: "", notes: "" });
  }

  async function transitionPlan(plan: Row, action: "ACTIVATE" | "RETIRE") {
    const reason = action === "RETIRE" ? window.prompt("Why is this inspection-plan revision being retired?") : "";
    if (action === "RETIRE" && !reason?.trim()) return;
    const body = { expected_version: Number(plan.row_version), action, ...(reason ? { reason: reason.trim() } : {}) };
    await perform(
      () => request("/quality/plans/" + String(plan.id) + "/transition", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Inspection plan " + action.toLowerCase() + " transition completed.",
    );
  }

  async function addDefect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedInspectionId) return;
    let body: Row;
    try { body = buildQualityDefectPayload(defectDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/inspections/" + selectedInspectionId + "/defects", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Non-conformance defect recorded against the inspection.",
    );
    if (result) setDefectDraft({ defect_code: "", severity: "MAJOR", affected_quantity: "1", description: "", evidence_reference: "" });
  }

  async function recordResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedInspectionId) return;
    let body: Row;
    try { body = buildQualityResultPayload(resultDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/inspections/" + selectedInspectionId + "/results", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Inspection criterion result recorded with the plan snapshot.",
    );
    if (result) setResultDraft({ criterion_code: "", observed_value: "", notes: "", evidence_reference: "" });
  }

  async function decideInspection(action: "START" | "PASS" | "FAIL" | "HOLD" | "CANCEL") {
    if (!inspectionDetail) return;
    if (["FAIL", "HOLD", "CANCEL"].includes(action) && decisionReason.trim().length < 3) {
      setNotice({ tone: "error", message: "A reason of at least three characters is required for this decision." });
      return;
    }
    let body: Row;
    try {
      body = buildQualityDecisionPayload({
        expected_version: inspectionDetail.row_version, action, reason: decisionReason,
      }) as Row;
    } catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/inspections/" + selectedInspectionId + "/decision", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Inspection decision " + action + " recorded using the current row version.",
    );
    if (result) setDecisionReason("");
  }

  async function submitDisposition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inspectionDetail) return;
    let body: Row;
    try {
      body = buildQualityDispositionPayload({
        expected_version: inspectionDetail.row_version, ...dispositionDraft,
      }) as Row;
    } catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/inspections/" + selectedInspectionId + "/dispositions", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Quality disposition recorded. Inventory follow-up, when required, remains a separate API action.",
    );
    if (result) setDispositionDraft({ action: "RELEASE", quantity: "", reason: "" });
  }

  async function addNcrAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ncr = object(inspectionDetail?.ncr);
    if (!ncr.id) return;
    let body: Row;
    try { body = buildQualityNcrActionPayload(ncrActionDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/ncrs/" + String(ncr.id) + "/actions", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "NCR CAPA action planned.",
    );
    if (result) setNcrActionDraft({ action_type: "CONTAINMENT", action_text: "", due_date: "", responsible_user_id: "" });
  }

  async function transitionCapa(ncrId: string, action: Row, command: "START" | "COMPLETE") {
    let body: Row;
    try {
      body = buildQualityNcrTransitionPayload({
        expected_version: action.row_version, action: command, reason: capaReason,
        ...(command === "COMPLETE" ? { evidence: { reference: capaEvidenceReference } } : {}),
      }) as Row;
    } catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/ncrs/" + ncrId + "/actions/" + String(action.id) + "/transition", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "CAPA action " + command.toLowerCase() + " transition recorded.",
    );
    if (result) { setCapaReason(""); setCapaEvidenceReference(""); }
  }

  async function verifyCapa(ncrId: string, action: Row, decision: "PASS" | "FAIL") {
    let body: Row;
    try {
      body = buildQualityNcrVerificationPayload({
        expected_version: action.row_version, decision, reason: capaReason,
        evidence: { reference: capaEvidenceReference },
      }) as Row;
    } catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); return; }
    const result = await perform(
      () => request("/quality/ncrs/" + ncrId + "/actions/" + String(action.id) + "/verify", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Independent CAPA verification " + decision + " recorded.",
    );
    if (result) { setCapaReason(""); setCapaEvidenceReference(""); }
  }

  async function closeNcr() {
    const ncr = object(inspectionDetail?.ncr);
    if (!ncr.id || !ncrClosureReason.trim()) {
      setNotice({ tone: "error", message: "A closure reason is required." });
      return;
    }
    await perform(
      () => request("/quality/ncrs/" + String(ncr.id) + "/close", {
        method: "POST",
        body: { expected_version: Number(ncr.row_version), reason: ncrClosureReason.trim() },
      }),
      "NCR closure recorded after server-side CAPA and hold checks.",
    );
    setNcrClosureReason("");
  }

  async function createRework(defect: Row) {
    if (!permissions.reworkManage) return;
    const quantity = window.prompt("Enter the rework input quantity:", String(defect.affected_quantity ?? "1"));
    if (!quantity) return;
    const reason = window.prompt("Why is this defect being sent to rework?");
    if (!reason?.trim()) return;
    await perform(
      () => request("/quality/defects/" + String(defect.id) + "/rework-orders", {
        method: "POST",
        body: { input_quantity: Number(quantity), reason: reason.trim() },
        idempotencyKey: newIdempotencyKey(),
      }),
      "Quality rework order created; stock and traceability constraints are enforced by the API.",
    );
    setTab("CONTAINMENT");
  }

  const detailDefects = rows(inspectionDetail?.defects, "defects");
  const detailResults = rows(inspectionDetail?.results, "results");
  const detailDispositions = rows(inspectionDetail?.dispositions, "dispositions");
  const detailHolds = rows(inspectionDetail?.holds, "holds");
  const ncr = object(inspectionDetail?.ncr);
  const ncrActions = rows(ncr.actions, "actions");
  const criterionSnapshot = Array.isArray(inspectionDetail?.criteria_snapshot)
    ? inspectionDetail.criteria_snapshot.map((entry) => object(entry)) : [];
  const selectedStatus = String(inspectionDetail?.status ?? "");
  const canAddInspectionData = ["OPEN", "IN_PROGRESS"].includes(selectedStatus);

  if (sessionStatus !== "connected") {
    return (
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <Section title="Quality Management" subtitle="Connect an authenticated FactoryOS session to access factory-scoped quality controls.">
          <Empty>Connect from the workspace header, then select an active factory.</Empty>
        </Section>
      </main>
    );
  }

  if (!activeFactoryId) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <Section title="Quality Management" subtitle="Quality data is isolated by active tenant and factory.">
          <Empty>Select an active factory from the workspace header to load quality records.</Empty>
        </Section>
      </main>
    );
  }

  if (!canOpenWorkspace) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <Section title="Quality Management" subtitle="The authenticated account does not have a quality workspace permission.">
          <Empty>Ask an administrator to grant the relevant quality read or management permissions.</Empty>
        </Section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Factory operations · Quality</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Quality Management & CAPA</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Control inspection plans, shop-floor results, non-conformances, inventory holds and independently verified corrective actions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600">
            {display(snapshot?.tenant.name)} · {display(snapshot?.factories.find((factory) => factory.id === activeFactoryId)?.code)}
          </span>
          <button type="button" className={SECONDARY} onClick={() => setRefreshVersion((value) => value + 1)} disabled={loading || busy}>Refresh</button>
        </div>
      </div>

      {notice ? (
        <div role="status" className={"rounded-xl border px-4 py-3 text-xs leading-5 " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900")}>
          {notice.message}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Inspections" value={summary.inspections} detail="Latest factory records" />
        <Kpi label="In progress" value={summary.inProgress} detail="Active inspection work" />
        <Kpi label="Failed" value={summary.failed} detail="Requires disposition" />
        <Kpi label="Active holds" value={summary.activeHolds} detail="Quarantined quality scope" />
        <Kpi label="Recorded defects" value={summary.criticalDefects} detail="Defect count on listed inspections" />
        <Kpi label="Active plans" value={summary.activePlans} detail={summary.openRework + " open rework orders"} />
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
        {TABS.map((item) => (
          <button key={item.id} type="button" onClick={() => setTab(item.id)}
            className={"min-h-10 shrink-0 rounded-lg px-3 text-xs font-semibold " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>
            {item.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">{TABS.find((item) => item.id === tab)?.description}</p>

      {loading ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">Loading factory quality records…</div> : null}
      {loadedFactoryId && loadedFactoryId !== activeFactoryId ? <Empty>Factory context changed. Refreshing scoped records…</Empty> : null}

      {tab === "INSPECTIONS" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)]">
          <div className="space-y-5">
            {permissions.inspectionsWrite ? (
              <Section title="Create inspection" subtitle="The target must belong to the selected factory. INCOMING, IN_PROCESS and FINAL require an ACTIVE plan code.">
                <form onSubmit={createInspection} className="grid gap-3 sm:grid-cols-2">
                  <Field label="Inspection type">
                    <select className={INPUT} value={inspectionDraft.inspection_type} onChange={(event) => setInspectionDraft({ ...inspectionDraft, inspection_type: event.target.value })}>
                      {["INCOMING", "IN_PROCESS", "FINAL", "INVENTORY", "SUPPLIER"].map((item) => <option key={item}>{item}</option>)}
                    </select>
                  </Field>
                  <Field label="Target type">
                    <select className={INPUT} value={inspectionDraft.target_type} onChange={(event) => setInspectionDraft({ ...inspectionDraft, target_type: event.target.value })}>
                      {["INVENTORY_ITEM", "TRACEABILITY_UNIT", "GOODS_RECEIPT_LINE", "PRODUCTION_REPORT", "WORK_ORDER"].map((item) => <option key={item}>{item}</option>)}
                    </select>
                  </Field>
                  <Field label="Target UUID"><input required className={INPUT} value={inspectionDraft.target_id} onChange={(event) => setInspectionDraft({ ...inspectionDraft, target_id: event.target.value })} placeholder="Target record UUID" /></Field>
                  <Field label="Active plan code" hint="Required for INCOMING, IN_PROCESS and FINAL inspections.">
                    <input className={INPUT} value={inspectionDraft.plan_code} onChange={(event) => setInspectionDraft({ ...inspectionDraft, plan_code: event.target.value })} placeholder="e.g. INCOMING-FABRIC" />
                  </Field>
                  <Field label="Sample quantity"><input className={INPUT} value={inspectionDraft.sample_quantity} onChange={(event) => setInspectionDraft({ ...inspectionDraft, sample_quantity: event.target.value })} inputMode="decimal" /></Field>
                  <Field label="Notes"><input className={INPUT} value={inspectionDraft.notes} onChange={(event) => setInspectionDraft({ ...inspectionDraft, notes: event.target.value })} /></Field>
                  <div className="sm:col-span-2 flex justify-end"><button className={PRIMARY} disabled={busy}>Create inspection</button></div>
                </form>
              </Section>
            ) : null}

            <Section title="Inspection register" subtitle="Select an inspection to review its criterion snapshots, results, defects, hold and decision history.">
              <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_180px]">
                <input className={INPUT} value={inspectionSearch} onChange={(event) => setInspectionSearch(event.target.value)} placeholder="Search type, target UUID or inspection ID" />
                <select className={INPUT} value={inspectionStatus} onChange={(event) => setInspectionStatus(event.target.value)}>
                  {["ALL", "OPEN", "IN_PROGRESS", "PASSED", "FAILED", "ON_HOLD", "DISPOSITIONED", "CANCELLED"].map((item) => <option key={item}>{item}</option>)}
                </select>
              </div>
              {visibleInspections.length ? (
                <Table headers={["Inspection", "Type / target", "Status", "Defects", "Hold", ""]}>
                  {visibleInspections.map((inspection) => (
                    <tr key={String(inspection.id)} className={selectedInspectionId === String(inspection.id) ? "bg-blue-50/70" : ""}>
                      <td className="max-w-40 px-3 py-3"><p className="truncate font-semibold text-slate-900">{display(inspection.plan_code, "No plan")}</p><p className="mt-1 truncate font-mono text-[10px] text-slate-500">{display(inspection.id)}</p></td>
                      <td className="whitespace-nowrap px-3 py-3"><p className="font-semibold text-slate-800">{display(inspection.inspection_type)}</p><p className="mt-1 text-[10px] text-slate-500">{display(inspection.target_type)}</p></td>
                      <td className="px-3 py-3"><StatusPill value={inspection.status} /></td>
                      <td className="px-3 py-3 text-center font-semibold">{display(inspection.defect_count, "0")}</td>
                      <td className="px-3 py-3">{inspection.on_quality_hold ? <StatusPill value="ON_HOLD" /> : <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-3"><button type="button" className={SECONDARY} onClick={() => void openInspection(String(inspection.id))}>Open</button></td>
                    </tr>
                  ))}
                </Table>
              ) : <Empty>{canRead ? "No inspections match the current filter." : "The account does not have quality.inspections.read."}</Empty>}
            </Section>
          </div>

          <div className="space-y-5">
            {inspectionDetail ? (
              <>
                <Section title="Inspection detail" subtitle="The server row version is used for every decision and disposition command."
                  action={<button type="button" className={SECONDARY} onClick={() => void refreshSelected()}>Reload detail</button>}>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div><p className="text-[10px] uppercase text-slate-500">Inspection</p><p className="mt-1 break-all font-mono text-slate-800">{display(inspectionDetail.id)}</p></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Current state</p><div className="mt-1"><StatusPill value={inspectionDetail.status} /></div></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Type / target</p><p className="mt-1 font-semibold text-slate-800">{display(inspectionDetail.inspection_type)} · {display(inspectionDetail.target_type)}</p></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Plan revision</p><p className="mt-1 font-semibold text-slate-800">{display(inspectionDetail.plan_code)} · {display(inspectionDetail.plan_revision, "—")}</p></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Row version</p><p className="mt-1 font-semibold text-slate-800">{display(inspectionDetail.row_version)}</p></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Created</p><p className="mt-1 text-slate-700">{dateTime(inspectionDetail.created_at)}</p></div>
                  </div>
                  <div className="mt-4 rounded-lg bg-slate-50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Target record UUID</p>
                    <p className="mt-1 break-all font-mono text-xs text-slate-700">{display(inspectionDetail.target_id)}</p>
                  </div>
                  {criterionSnapshot.length ? (
                    <div className="mt-4">
                      <p className="mb-2 text-xs font-bold text-slate-800">Frozen acceptance criteria snapshot</p>
                      <div className="space-y-2">
                        {criterionSnapshot.map((criterion) => (
                          <div key={String(criterion.criterion_code)} className="rounded-lg border border-slate-200 p-3 text-xs">
                            <div className="flex items-center justify-between gap-2"><span className="font-semibold">{display(criterion.name)}</span><span className="font-mono text-[10px] text-slate-500">{display(criterion.criterion_code)}</span></div>
                            <p className="mt-1 text-slate-500">{display(criterion.value_type)} · {display(criterion.comparison_operator)} · {display(criterion.target_value, display(criterion.lower_limit) + "–" + display(criterion.upper_limit))} {display(criterion.unit, "")}</p>
                            <p className="mt-1 text-[10px] text-slate-500">{criterion.is_required === false ? "Optional" : "Required"}{criterion.is_critical ? " · Critical" : ""}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </Section>

                {canAddInspectionData && permissions.inspectionsWrite ? (
                  <Section title="Record criterion result" subtitle="Observed values are evaluated by the API against the inspection's frozen plan revision.">
                    {criterionSnapshot.length ? (
                      <form onSubmit={recordResult} className="grid gap-3">
                        <Field label="Criterion">
                          <select required className={INPUT} value={resultDraft.criterion_code} onChange={(event) => setResultDraft({ ...resultDraft, criterion_code: event.target.value })}>
                            <option value="">Select criterion</option>
                            {criterionSnapshot.map((criterion) => <option key={String(criterion.criterion_code)} value={String(criterion.criterion_code)}>{String(criterion.criterion_code)} · {String(criterion.name)}</option>)}
                          </select>
                        </Field>
                        <Field label="Observed value"><input required className={INPUT} value={resultDraft.observed_value} onChange={(event) => setResultDraft({ ...resultDraft, observed_value: event.target.value })} /></Field>
                        <Field label="Notes"><input className={INPUT} value={resultDraft.notes} onChange={(event) => setResultDraft({ ...resultDraft, notes: event.target.value })} /></Field>
                        <Field label="Evidence reference" hint="Provide a document, photo or measurement-sheet reference where available."><input className={INPUT} value={resultDraft.evidence_reference} onChange={(event) => setResultDraft({ ...resultDraft, evidence_reference: event.target.value })} /></Field>
                        <div className="flex justify-end"><button className={PRIMARY} disabled={busy}>Record result</button></div>
                      </form>
                    ) : <Empty>This inspection has no plan criteria snapshot. Choose an active plan when creating the inspection.</Empty>}
                    {detailResults.length ? (
                      <div className="mt-4">
                        <Table headers={["Criterion", "Observed", "Outcome", "Attempt", "Recorded"]}>
                          {detailResults.map((result, index) => (
                            <tr key={String(result.id ?? index)}>
                              <td className="px-3 py-2 font-semibold">{display(result.criterion_code)}</td>
                              <td className="px-3 py-2">{display(result.observed_value)}</td>
                              <td className="px-3 py-2"><StatusPill value={result.outcome} /></td>
                              <td className="px-3 py-2">{display(result.attempt)}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{dateTime(result.created_at)}</td>
                            </tr>
                          ))}
                        </Table>
                      </div>
                    ) : <div className="mt-3"><Empty>No criterion results have been recorded.</Empty></div>}
                  </Section>
                ) : detailResults.length ? (
                  <Section title="Recorded criterion results" subtitle="Results are immutable evidence evaluated against the frozen inspection plan.">
                    <Table headers={["Criterion", "Observed", "Outcome", "Attempt"]}>
                      {detailResults.map((result, index) => <tr key={String(result.id ?? index)}><td className="px-3 py-2">{display(result.criterion_code)}</td><td className="px-3 py-2">{display(result.observed_value)}</td><td className="px-3 py-2"><StatusPill value={result.outcome} /></td><td className="px-3 py-2">{display(result.attempt)}</td></tr>)}
                    </Table>
                  </Section>
                ) : null}

                {canAddInspectionData && permissions.defectsWrite ? (
                  <Section title="Record non-conformance" subtitle="Defect severity and affected quantity feed the inspection decision, hold and NCR flow.">
                    <form onSubmit={addDefect} className="grid gap-3 sm:grid-cols-2">
                      <Field label="Defect code"><input required className={INPUT} value={defectDraft.defect_code} onChange={(event) => setDefectDraft({ ...defectDraft, defect_code: event.target.value })} placeholder="e.g. FABRIC-HOLE" /></Field>
                      <Field label="Severity"><select className={INPUT} value={defectDraft.severity} onChange={(event) => setDefectDraft({ ...defectDraft, severity: event.target.value })}>{["CRITICAL", "MAJOR", "MINOR"].map((item) => <option key={item}>{item}</option>)}</select></Field>
                      <Field label="Affected quantity"><input required className={INPUT} inputMode="decimal" value={defectDraft.affected_quantity} onChange={(event) => setDefectDraft({ ...defectDraft, affected_quantity: event.target.value })} /></Field>
                      <Field label="Evidence reference"><input className={INPUT} value={defectDraft.evidence_reference} onChange={(event) => setDefectDraft({ ...defectDraft, evidence_reference: event.target.value })} placeholder="Photo / lab report / sample ref" /></Field>
                      <div className="sm:col-span-2"><Field label="Defect description"><textarea required className={AREA} value={defectDraft.description} onChange={(event) => setDefectDraft({ ...defectDraft, description: event.target.value })} /></Field></div>
                      <div className="sm:col-span-2 flex justify-end"><button className={PRIMARY} disabled={busy}>Record defect</button></div>
                    </form>
                    {detailDefects.length ? (
                      <div className="mt-4"><Table headers={["Defect", "Severity", "Affected", "State", "Action"]}>
                        {detailDefects.map((defect) => (
                          <tr key={String(defect.id)}>
                            <td className="px-3 py-2"><p className="font-semibold">{display(defect.defect_code)}</p><p className="mt-1 max-w-48 text-[10px] text-slate-500">{display(defect.description)}</p></td>
                            <td className="px-3 py-2"><StatusPill value={defect.severity} /></td>
                            <td className="px-3 py-2">{display(defect.affected_quantity)}</td>
                            <td className="px-3 py-2"><StatusPill value={defect.status} /></td>
                            <td className="px-3 py-2">{permissions.reworkManage && ["OPEN", "REWORK"].includes(String(defect.status)) ? <button type="button" className={SECONDARY} onClick={() => void createRework(defect)}>Create rework</button> : "—"}</td>
                          </tr>
                        ))}
                      </Table></div>
                    ) : null}
                  </Section>
                ) : detailDefects.length ? (
                  <Section title="Recorded defects" subtitle="Non-conformance evidence for this inspection.">
                    <Table headers={["Defect", "Severity", "Affected", "State"]}>
                      {detailDefects.map((defect) => <tr key={String(defect.id)}><td className="px-3 py-2">{display(defect.defect_code)}</td><td className="px-3 py-2"><StatusPill value={defect.severity} /></td><td className="px-3 py-2">{display(defect.affected_quantity)}</td><td className="px-3 py-2"><StatusPill value={defect.status} /></td></tr>)}
                    </Table>
                  </Section>
                ) : null}

                {permissions.inspectionsWrite ? (
                  <Section title="Inspection decision" subtitle="PASS is blocked until every required criterion passes and all open defects are resolved. FAIL/HOLD/CANCEL require a reason.">
                    <Field label="Decision reason"><textarea className={AREA} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder="Required for FAIL, HOLD and CANCEL" /></Field>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedStatus === "OPEN" || selectedStatus === "ON_HOLD" ? <button type="button" className={PRIMARY} disabled={busy} onClick={() => void decideInspection("START")}>Start inspection</button> : null}
                      {selectedStatus === "IN_PROGRESS" ? (
                        <>
                          <button type="button" className={PRIMARY} disabled={busy} onClick={() => void decideInspection("PASS")}>Pass inspection</button>
                          <button type="button" className={DANGER} disabled={busy} onClick={() => void decideInspection("FAIL")}>Fail inspection</button>
                          <button type="button" className={SECONDARY} disabled={busy} onClick={() => void decideInspection("HOLD")}>Place on hold</button>
                          <button type="button" className={SECONDARY} disabled={busy} onClick={() => void decideInspection("CANCEL")}>Cancel</button>
                        </>
                      ) : null}
                      {!["OPEN", "ON_HOLD", "IN_PROGRESS"].includes(selectedStatus) ? <span className="text-xs text-slate-500">No direct inspection transition is available from {selectedStatus}.</span> : null}
                    </div>
                  </Section>
                ) : null}

                {permissions.disposition && ["FAILED", "ON_HOLD", "PASSED"].includes(selectedStatus) ? (
                  <Section title="Quality disposition" subtitle="RELEASE, USE_AS_IS and REWORK require an active hold. SCRAP and RETURN_TO_SUPPLIER require the complete on-hand quantity and inventory follow-up.">
                    <form onSubmit={submitDisposition} className="grid gap-3">
                      <Field label="Disposition">
                        <select className={INPUT} value={dispositionDraft.action} onChange={(event) => setDispositionDraft({ ...dispositionDraft, action: event.target.value })}>
                          {["RELEASE", "USE_AS_IS", "REWORK", "SCRAP", "RETURN_TO_SUPPLIER"].map((item) => <option key={item}>{item}</option>)}
                        </select>
                      </Field>
                      {["SCRAP", "RETURN_TO_SUPPLIER"].includes(dispositionDraft.action) ? (
                        <Field label="Full on-hand quantity"><input required className={INPUT} inputMode="decimal" value={dispositionDraft.quantity} onChange={(event) => setDispositionDraft({ ...dispositionDraft, quantity: event.target.value })} /></Field>
                      ) : null}
                      <Field label="Disposition reason"><textarea required className={AREA} value={dispositionDraft.reason} onChange={(event) => setDispositionDraft({ ...dispositionDraft, reason: event.target.value })} /></Field>
                      <div className="flex justify-end"><button className={PRIMARY} disabled={busy}>Record disposition</button></div>
                    </form>
                    {detailDispositions.length ? <div className="mt-4"><Table headers={["Action", "State", "Quantity", "Reason"]}>{detailDispositions.map((item) => <tr key={String(item.id)}><td className="px-3 py-2 font-semibold">{display(item.action)}</td><td className="px-3 py-2"><StatusPill value={item.status} /></td><td className="px-3 py-2">{display(item.quantity)}</td><td className="px-3 py-2">{display(item.reason)}</td></tr>)}</Table></div> : null}
                  </Section>
                ) : null}

                {ncr.id ? (
                  <Section title={"Non-conformance report · " + display(ncr.ncr_number)} subtitle="NCR closure requires independently verified containment, corrective and preventive actions, resolved defects and no active hold.">
                    <div className="flex flex-wrap items-center gap-2"><StatusPill value={ncr.status} /><span className="text-[10px] text-slate-500">Version {display(ncr.row_version)}</span><span className="text-xs text-slate-700">{display(ncr.title)}</span></div>
                    {permissions.ncrManage && ncr.status !== "CLOSED" ? (
                      <form onSubmit={addNcrAction} className="mt-4 grid gap-3 sm:grid-cols-2">
                        <Field label="CAPA action type"><select className={INPUT} value={ncrActionDraft.action_type} onChange={(event) => setNcrActionDraft({ ...ncrActionDraft, action_type: event.target.value })}>{["CONTAINMENT", "CORRECTIVE", "PREVENTIVE"].map((item) => <option key={item}>{item}</option>)}</select></Field>
                        <Field label="Due date"><input type="date" className={INPUT} value={ncrActionDraft.due_date} onChange={(event) => setNcrActionDraft({ ...ncrActionDraft, due_date: event.target.value })} /></Field>
                        <div className="sm:col-span-2"><Field label="Action description"><textarea required className={AREA} value={ncrActionDraft.action_text} onChange={(event) => setNcrActionDraft({ ...ncrActionDraft, action_text: event.target.value })} /></Field></div>
                        <Field label="Responsible user UUID (optional)"><input className={INPUT} value={ncrActionDraft.responsible_user_id} onChange={(event) => setNcrActionDraft({ ...ncrActionDraft, responsible_user_id: event.target.value })} /></Field>
                        <div className="flex items-end justify-end"><button className={PRIMARY} disabled={busy}>Plan CAPA action</button></div>
                      </form>
                    ) : null}
                    {ncrActions.length ? (
                      <div className="mt-4 space-y-3">
                        {ncrActions.map((action) => (
                          <div key={String(action.id)} className="rounded-xl border border-slate-200 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div><p className="text-xs font-bold text-slate-900">{display(action.action_type)} · {display(action.action_text)}</p><p className="mt-1 text-[10px] text-slate-500">Due {display(action.due_date)} · Row version {display(action.row_version)}</p></div>
                              <StatusPill value={action.action_status} />
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {permissions.ncrManage && ["PLANNED", "REJECTED"].includes(String(action.action_status)) ? <button type="button" className={SECONDARY} disabled={busy} onClick={() => void transitionCapa(String(ncr.id), action, "START")}>Start</button> : null}
                              {permissions.ncrManage && action.action_status === "IN_PROGRESS" ? <button type="button" className={SECONDARY} disabled={busy} onClick={() => void transitionCapa(String(ncr.id), action, "COMPLETE")}>Complete</button> : null}
                              {permissions.capaVerify && action.action_status === "COMPLETED" ? <><button type="button" className={PRIMARY} disabled={busy} onClick={() => void verifyCapa(String(ncr.id), action, "PASS")}>Verify pass</button><button type="button" className={DANGER} disabled={busy} onClick={() => void verifyCapa(String(ncr.id), action, "FAIL")}>Verify fail</button></> : null}
                            </div>
                            {["PLANNED", "REJECTED", "IN_PROGRESS", "COMPLETED"].includes(String(action.action_status)) ? (
                              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                <input className={INPUT} value={capaReason} onChange={(event) => setCapaReason(event.target.value)} placeholder="Transition / verification reason" />
                                <input className={INPUT} value={capaEvidenceReference} onChange={(event) => setCapaEvidenceReference(event.target.value)} placeholder="Completion / verification evidence ref" />
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : <div className="mt-4"><Empty>No CAPA actions have been recorded for this NCR.</Empty></div>}
                    {permissions.ncrManage && ncr.status !== "CLOSED" ? (
                      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
                        <input className={INPUT} value={ncrClosureReason} onChange={(event) => setNcrClosureReason(event.target.value)} placeholder="NCR closure reason" />
                        <button type="button" className={DANGER} disabled={busy} onClick={() => void closeNcr()}>Close NCR</button>
                      </div>
                    ) : null}
                  </Section>
                ) : null}

                {detailHolds.length ? (
                  <Section title="Hold history" subtitle="Hold release is controlled by a successful inspection decision or an accepted disposition.">
                    <Table headers={["Hold", "State", "Reason", "Created"]}>
                      {detailHolds.map((hold) => <tr key={String(hold.id)}><td className="px-3 py-2 font-mono text-[10px]">{display(hold.id)}</td><td className="px-3 py-2"><StatusPill value={hold.status} /></td><td className="px-3 py-2">{display(hold.reason)}</td><td className="px-3 py-2 whitespace-nowrap">{dateTime(hold.created_at)}</td></tr>)}
                    </Table>
                  </Section>
                ) : null}
              </>
            ) : (
              <Section title="Inspection workspace" subtitle="Choose an inspection from the register to review its versioned criteria, result evidence and disposition gates.">
                <Empty>No inspection selected.</Empty>
              </Section>
            )}
          </div>
        </div>
      ) : null}

      {tab === "PLANS" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.2fr)]">
          {permissions.plansManage ? (
            <Section title="Create inspection-plan revision" subtitle="Criteria are captured as an immutable snapshot when an inspection is created. The new plan starts in DRAFT.">
              <form onSubmit={createPlan} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Plan code"><input required className={INPUT} value={planDraft.plan_code} onChange={(event) => setPlanDraft({ ...planDraft, plan_code: event.target.value })} /></Field>
                  <Field label="Inspection type"><select className={INPUT} value={planDraft.inspection_type} onChange={(event) => setPlanDraft({ ...planDraft, inspection_type: event.target.value })}>{["INCOMING", "IN_PROCESS", "FINAL", "INVENTORY", "SUPPLIER"].map((item) => <option key={item}>{item}</option>)}</select></Field>
                </div>
                <Field label="Plan name"><input required className={INPUT} value={planDraft.name} onChange={(event) => setPlanDraft({ ...planDraft, name: event.target.value })} /></Field>
                <Field label="Default sample quantity"><input className={INPUT} inputMode="decimal" value={planDraft.default_sample_quantity} onChange={(event) => setPlanDraft({ ...planDraft, default_sample_quantity: event.target.value })} /></Field>
                <Field label="Acceptance criteria (JSON)" hint="Each criterion supports NUMERIC, TEXT, BOOLEAN or ENUM values and the supported comparison operators.">
                  <textarea required spellCheck={false} className={AREA + " min-h-64 font-mono text-[11px]"} value={planDraft.criteria} onChange={(event) => setPlanDraft({ ...planDraft, criteria: event.target.value })} />
                </Field>
                <Field label="Notes"><textarea className={AREA} value={planDraft.notes} onChange={(event) => setPlanDraft({ ...planDraft, notes: event.target.value })} /></Field>
                <button className={PRIMARY} disabled={busy}>Create draft revision</button>
              </form>
            </Section>
          ) : null}
          <Section title="Plan register" subtitle="Only one ACTIVE revision may exist for each plan code and inspection type. Retire the current revision before activating a replacement.">
            <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_170px]">
              <input className={INPUT} value={planSearch} onChange={(event) => setPlanSearch(event.target.value)} placeholder="Search plan code or name" />
              <select className={INPUT} value={planStatus} onChange={(event) => setPlanStatus(event.target.value)}>{["ALL", "DRAFT", "ACTIVE", "RETIRED"].map((item) => <option key={item}>{item}</option>)}</select>
            </div>
            {visiblePlans.length ? (
              <Table headers={["Plan", "Type", "Revision", "Criteria", "State", "Actions"]}>
                {visiblePlans.map((plan) => {
                  const criteria = rows(plan.criteria, "criteria");
                  return (
                    <tr key={String(plan.id)}>
                      <td className="px-3 py-3"><p className="font-semibold text-slate-900">{display(plan.plan_code)}</p><p className="mt-1 text-[10px] text-slate-500">{display(plan.name)}</p></td>
                      <td className="px-3 py-3 whitespace-nowrap">{display(plan.inspection_type)}</td>
                      <td className="px-3 py-3">v{display(plan.revision)}</td>
                      <td className="px-3 py-3">{criteria.length}</td>
                      <td className="px-3 py-3"><StatusPill value={plan.status} /></td>
                      <td className="px-3 py-3"><div className="flex gap-1">
                        {permissions.plansManage && plan.status === "DRAFT" ? <button type="button" className={PRIMARY} disabled={busy} onClick={() => void transitionPlan(plan, "ACTIVATE")}>Activate</button> : null}
                        {permissions.plansManage && plan.status === "ACTIVE" ? <button type="button" className={DANGER} disabled={busy} onClick={() => void transitionPlan(plan, "RETIRE")}>Retire</button> : null}
                      </div></td>
                    </tr>
                  );
                })}
              </Table>
            ) : <Empty>No inspection plans are available for this factory.</Empty>}
          </Section>
        </div>
      ) : null}

      {tab === "CONTAINMENT" ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Section title="Quality holds" subtitle="The hold ledger is factory-scoped and remains authoritative for quarantined stock and work-order containment.">
            {holds.length ? (
              <Table headers={["Inspection", "Target", "State", "Reason", "Created"]}>
                {holds.map((hold) => <tr key={String(hold.id)}>
                  <td className="px-3 py-3"><button type="button" className="font-mono text-[10px] text-blue-700 underline" onClick={() => { setTab("INSPECTIONS"); void openInspection(String(hold.inspection_id)); }}>{display(hold.inspection_id)}</button><p className="mt-1 text-[10px] text-slate-500">{display(hold.inspection_type)}</p></td>
                  <td className="px-3 py-3"><p className="text-[10px] font-semibold">{display(hold.target_type)}</p><p className="mt-1 max-w-36 break-all font-mono text-[10px] text-slate-500">{display(hold.target_id)}</p></td>
                  <td className="px-3 py-3"><StatusPill value={hold.status} /></td>
                  <td className="px-3 py-3 max-w-52">{display(hold.reason)}</td>
                  <td className="px-3 py-3 whitespace-nowrap">{dateTime(hold.created_at)}</td>
                </tr>)}
              </Table>
            ) : <Empty>No quality holds are recorded.</Empty>}
          </Section>
          <Section title="Rework orders" subtitle="Rework transitions validate recovered plus scrap quantities, output traceability and follow-up inspection against the source target.">
            {reworkOrders.length ? (
              <Table headers={["Rework", "Defect", "Input", "Recovered / scrap", "State"]}>
                {reworkOrders.map((order) => <tr key={String(order.id)}>
                  <td className="px-3 py-3"><p className="font-semibold">{display(order.rework_number)}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{display(order.id)}</p></td>
                  <td className="px-3 py-3"><p className="font-semibold">{display(order.defect_code)}</p><p className="mt-1 text-[10px] text-slate-500">{display(order.severity)}</p></td>
                  <td className="px-3 py-3">{display(order.input_quantity)}</td>
                  <td className="px-3 py-3">{display(order.recovered_quantity, "0")} / {display(order.scrap_quantity, "0")}</td>
                  <td className="px-3 py-3"><StatusPill value={order.status} /></td>
                </tr>)}
              </Table>
            ) : <Empty>No rework orders have been created.</Empty>}
          </Section>
        </div>
      ) : null}

      {tab === "ANALYTICS" ? (
        <div className="space-y-5">
          {!permissions.advancedRead ? <Empty>The account does not have quality.advanced.read.</Empty> : (
            <>
              <Section title="Defect Pareto" subtitle="Select the dimension used to group quality defects. Analytics are returned by the factory-scoped quality service.">
                <div className="mb-4 flex flex-wrap items-end gap-3">
                  <Field label="Dimension">
                    <select className={INPUT} value={analyticsDimension} onChange={(event) => setAnalyticsDimension(event.target.value)}>
                      {["DEFECT", "LINE", "OPERATION", "STYLE", "SHIFT"].map((item) => <option key={item}>{item}</option>)}
                    </select>
                  </Field>
                  <Field label="Repeat alert lookback days"><input className={INPUT} type="number" min="1" max="365" value={analyticsLookback} onChange={(event) => setAnalyticsLookback(event.target.value)} /></Field>
                  <button type="button" className={SECONDARY} onClick={() => void loadAnalytics()}>Refresh analytics</button>
                </div>
                {pareto.length ? (
                  <Table headers={["Dimension", "Count", "Affected quantity", "Other evidence"]}>
                    {pareto.map((item, index) => <tr key={String(item.id ?? item.key ?? index)}>
                      <td className="px-3 py-3 font-semibold">{display(item.label, display(item.defect_code, display(item.dimension_value, JSON.stringify(item))))}</td>
                      <td className="px-3 py-3">{display(item.defect_count, display(item.count, display(item.occurrences)))}</td>
                      <td className="px-3 py-3">{display(item.affected_quantity)}</td>
                      <td className="px-3 py-3 text-[10px] text-slate-500">{display(item.line_code, display(item.operation_code, display(item.style_code, display(item.shift_code))))}</td>
                    </tr>)}
                  </Table>
                ) : <Empty>No defect Pareto rows are currently returned.</Empty>}
              </Section>
              <div className="grid gap-5 xl:grid-cols-2">
                <Section title="Supplier quality" subtitle="Supplier quality evidence is reported separately from inspection count; no supplier score is calculated in the browser.">
                  {supplierQuality.length ? <Table headers={["Supplier", "Inspections", "Defects", "Quality evidence"]}>{supplierQuality.map((item, index) => <tr key={String(item.supplier_id ?? item.id ?? index)}>
                    <td className="px-3 py-3"><p className="font-semibold">{display(item.supplier_name, display(item.supplier_code, display(item.supplier_id)))}</p></td>
                    <td className="px-3 py-3">{display(item.inspection_count, display(item.total_inspections))}</td>
                    <td className="px-3 py-3">{display(item.defect_count, display(item.total_defects))}</td>
                    <td className="px-3 py-3 text-[10px] text-slate-500">{display(item.last_inspection_at, display(item.period))}</td>
                  </tr>)}</Table> : <Empty>No supplier-quality evidence is currently returned.</Empty>}
                </Section>
                <Section title="Repeat-defect alerts" subtitle="Signals are based on the selected lookback window and API minimum-occurrence threshold.">
                  {repeatAlerts.length ? <Table headers={["Defect", "Occurrences", "Last observed", "Context"]}>{repeatAlerts.map((item, index) => <tr key={String(item.id ?? item.defect_code ?? index)}>
                    <td className="px-3 py-3 font-semibold">{display(item.defect_code, display(item.key))}</td>
                    <td className="px-3 py-3"><StatusPill value={item.occurrences ?? item.occurrence_count} /></td>
                    <td className="px-3 py-3 whitespace-nowrap">{dateTime(item.last_occurred_at ?? item.last_seen_at)}</td>
                    <td className="px-3 py-3 text-[10px] text-slate-500">{display(item.line_code, display(item.operation_code, display(item.style_code)))}</td>
                  </tr>)}</Table> : <Empty>No repeat-defect alerts meet the selected threshold.</Empty>}
                </Section>
              </div>
            </>
          )}
        </div>
      ) : null}

      <p className="text-[10px] leading-5 text-slate-500">
        Quality decisions are API-authorized and factory-scoped. This workbench does not override hold, inventory movement, traceability or independent CAPA verification controls. Failed stock dispositions may require a separate inventory movement; the page deliberately does not claim that a pending inventory action has completed.
      </p>
    </main>
  );
}
