"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildAiStudioBranchPayload, buildAiStudioComparePayload, buildAiStudioDraftPayload,
  buildAiStudioDraftReviewPayload, buildAiStudioEvaluationCasePayload, buildAiStudioEvaluationRunPayload,
  buildAiStudioPolicySimulationPayload, buildAiStudioPublishRequestPayload, buildAiStudioReplayPayload,
  buildAiStudioRollbackPayload, buildAiStudioSandboxPayload, buildAiStudioTemplateDraftPayload,
  createAiAgentStudioClient, normalizeAiStudioRows,
} from "@/lib/ai-agent-studio-workbench.mjs";
import type { AiAgentStudioClient } from "@/lib/ai-agent-studio-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "OVERVIEW" | "DRAFTS" | "SIMULATION" | "POLICY" | "EVALUATION" | "RELEASE";
type Notice = { tone: "success" | "error" | "warning"; message: string };

const TABS: { id: Tab; label: string }[] = [
  { id: "OVERVIEW", label: "Overview" },
  { id: "DRAFTS", label: "Templates & drafts" },
  { id: "SIMULATION", label: "Simulation lab" },
  { id: "POLICY", label: "Policy simulation" },
  { id: "EVALUATION", label: "Evaluation" },
  { id: "RELEASE", label: "Release governance" },
];
const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-32 font-mono text-xs leading-5";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function rows(value: unknown, preferred = "items"): Row[] {
  return normalizeAiStudioRows(value, preferred).map(record);
}
function label(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function firstItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}
function pretty(value: unknown): string {
  if (value === null || value === undefined) return "No result yet.";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The AI Agent Studio request failed.";
}
function tone(value: unknown): string {
  const state = label(value, "UNKNOWN").toUpperCase();
  if (["COMPLETED", "READY_FOR_PUBLISH", "APPROVED", "PROMOTED", "ACTIVE", "PASS", "ALLOWED"].includes(state)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["PENDING", "DRAFT", "BLOCKED", "APPROVAL_REQUIRED", "INCONCLUSIVE"].includes(state)) return "border-amber-200 bg-amber-50 text-amber-900";
  if (["FAILED", "REJECTED", "DENIED", "ROLLED_BACK", "FAIL"].includes(state)) return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}
function State({ value }: { value: unknown }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " + tone(value)}>{label(value, "UNKNOWN").replaceAll("_", " ")}</span>;
}
function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="border-b border-slate-100 px-4 py-4 sm:px-5">
      <h2 className="text-sm font-bold text-slate-950">{title}</h2>
      {subtitle ? <p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p> : null}
    </div>
    <div className="p-4 sm:p-5">{children}</div>
  </section>;
}
function Field({ label: fieldLabel, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0">
    <span className="mb-1.5 block text-xs font-semibold text-slate-700">{fieldLabel}</span>
    {children}
    {hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}
  </label>;
}
function Json({ title, value }: { title: string; value: unknown }) {
  return <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-950 p-3">
    <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</p>
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-100">{pretty(value)}</pre>
  </div>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-center text-xs leading-5 text-slate-500">{children}</div>;
}
function Metric({ label: metricLabel, value, hint }: { label: string; value: string | number; hint: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4">
    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{metricLabel}</p>
    <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p>
    <p className="mt-1 text-[10px] text-slate-500">{hint}</p>
  </div>;
}

export default function AiAgentStudioGovernancePage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && !!activeFactoryId;
  const canAgentsRead = hasPermission("ai.agents.read");
  const canDraftRead = hasPermission("ai.agents.draft.read");
  const canDraftWrite = hasPermission("ai.agents.draft.write");
  const canAgentsWrite = hasPermission("ai.agents.write");
  const canPublish = hasPermission("ai.agents.publish");
  const canPromote = hasPermission("ai.agents.promote");
  const canRollback = hasPermission("ai.agents.rollback");
  const canRead = canAgentsRead || canDraftRead;

  const [tab, setTab] = useState<Tab>("OVERVIEW");
  const [refreshTick, setRefreshTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Row[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [draftDetail, setDraftDetail] = useState<Row | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [evaluationCases, setEvaluationCases] = useState<Row[]>([]);
  const [evaluationReport, setEvaluationReport] = useState<Row | null>(null);
  const [evaluationScopeId, setEvaluationScopeId] = useState("");
  const [loadedFactoryId, setLoadedFactoryId] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [sandboxId, setSandboxId] = useState("");
  const [runId, setRunId] = useState("");
  const [runDetail, setRunDetail] = useState<Row | null>(null);
  const [stepIndex, setStepIndex] = useState("0");
  const [stepDetail, setStepDetail] = useState<Row | null>(null);
  const [comparisonResult, setComparisonResult] = useState<Row | null>(null);
  const [policyResult, setPolicyResult] = useState<Row | null>(null);
  const [evaluationResult, setEvaluationResult] = useState<Row | null>(null);
  const [publishRequest, setPublishRequest] = useState<Row | null>(null);
  const [deployment, setDeployment] = useState<Row | null>(null);
  const [latestOperation, setLatestOperation] = useState<unknown>(null);

  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [templateTitle, setTemplateTitle] = useState("");
  const [templateCustomization, setTemplateCustomization] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [sandboxName, setSandboxName] = useState("Agent Studio simulation");
  const [agentSpecJson, setAgentSpecJson] = useState("{\n  \"agent_id\": \"your-agent-id\",\n  \"version\": \"1.0.0\",\n  \"goal\": \"Describe the bounded agent objective\",\n  \"risk_ceiling\": \"L1\",\n  \"execution_scopes\": [],\n  \"tools\": [\n    { \"tool_id\": \"REGISTERED.TOOL.ID\", \"version\": \"1.0.0\", \"action_type\": \"REGISTERED.ACTION\" }\n  ]\n}");
  const [planStepJson, setPlanStepJson] = useState("[\n  {\n    \"step_key\": \"step-1\",\n    \"tool_id\": \"REGISTERED.TOOL.ID\",\n    \"tool_version\": \"1.0.0\",\n    \"action_type\": \"REGISTERED.ACTION\",\n    \"input\": {}\n  }\n]");
  const [simulatedResponsesJson, setSimulatedResponsesJson] = useState("{\n  \"REGISTERED.TOOL.ID@1.0.0\": { \"fixture\": true }\n}");
  const [inputSnapshotJson, setInputSnapshotJson] = useState("{}");
  const [policySnapshotJson, setPolicySnapshotJson] = useState("{}");
  const [replaySource, setReplaySource] = useState("");
  const [replayFrom, setReplayFrom] = useState("0");
  const [replayTo, setReplayTo] = useState("");
  const [branchSource, setBranchSource] = useState("");
  const [branchIndex, setBranchIndex] = useState("0");
  const [branchPlanJson, setBranchPlanJson] = useState("[\n  {\n    \"step_key\": \"alternative-step\",\n    \"tool_id\": \"REGISTERED.TOOL.ID\",\n    \"tool_version\": \"1.0.0\",\n    \"action_type\": \"REGISTERED.ACTION\",\n    \"input\": {}\n  }\n]");
  const [branchResponsesJson, setBranchResponsesJson] = useState("{}");
  const [leftRunId, setLeftRunId] = useState("");
  const [rightRunId, setRightRunId] = useState("");
  const [historicalEventsJson, setHistoricalEventsJson] = useState("[\n  {\n    \"event_key\": \"case-1\",\n    \"action\": \"INVENTORY.READ\",\n    \"resource_type\": \"INVENTORY_ITEM\",\n    \"attributes\": {},\n    \"effective_at\": \"2026-11-24T00:00:00.000Z\",\n    \"expected_outcome\": \"ALLOWED\"\n  }\n]");
  const [evaluationCaseJson, setEvaluationCaseJson] = useState("{\n  \"case_key\": \"stock-read-expected\",\n  \"version\": 1,\n  \"name\": \"Expected stock summary read\",\n  \"kind\": \"EXPECTED_TOOL_CALL\",\n  \"expected_tool_id\": \"REGISTERED.TOOL.ID\",\n  \"expected_tool_version\": \"1.0.0\",\n  \"expected_action_type\": \"REGISTERED.ACTION\",\n  \"expected_input_subset\": {},\n  \"status\": \"ACTIVE\"\n}");
  const [evaluationRunId, setEvaluationRunId] = useState("");
  const [publishAgentId, setPublishAgentId] = useState("");
  const [publishSandboxId, setPublishSandboxId] = useState("");
  const [publishRunId, setPublishRunId] = useState("");
  const [publishPolicyRunId, setPublishPolicyRunId] = useState("");
  const [publishStage, setPublishStage] = useState<"CANARY" | "PRODUCTION">("CANARY");
  const [publishReason, setPublishReason] = useState("");
  const [rollbackDeploymentId, setRollbackDeploymentId] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");

  function api(): AiAgentStudioClient {
    return createAiAgentStudioClient((path, options = {}) => request(path, options));
  }

  const visibleDraftDetail = draftDetail && String(draftDetail.draftId ?? draftDetail.draft_id ?? "") === selectedDraftId ? draftDetail : null;
  const visibleAgents = loadedFactoryId === activeFactoryId ? agents : [];
  const visibleTemplates = loadedFactoryId === activeFactoryId ? templates : [];
  const visibleDrafts = loadedFactoryId === activeFactoryId ? drafts : [];
  const visibleEvaluationCases = evaluationScopeId === selectedAgentId ? evaluationCases : [];
  const visibleEvaluationReport = evaluationScopeId === selectedAgentId ? evaluationReport : null;
  const selectedCase = evaluationScopeId === selectedAgentId ? evaluationCases.find((item) => String(item.id ?? item.caseId ?? item.case_id ?? "") === selectedCaseId) : undefined;
  const factoryName = snapshot?.factories.find((factory) => factory.id === activeFactoryId)?.name ?? activeFactoryId;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!connected || !canRead) {
        setLoading(false);
        setLoadedFactoryId("");
        return;
      }
      setLoading(true);
      const apiClient = createAiAgentStudioClient((path, options = {}) => request(path, options));
      const definitions = [
        { key: "agents", enabled: canAgentsRead, task: () => apiClient.listAgents() },
        { key: "templates", enabled: canDraftRead, task: () => apiClient.listTemplates() },
        { key: "drafts", enabled: canDraftRead, task: () => apiClient.listDrafts() },
      ].filter((entry) => entry.enabled);
      const results = await Promise.all(definitions.map(async (entry) => {
        try { return { key: entry.key, value: await entry.task(), error: "" }; }
        catch (cause) { return { key: entry.key, value: null, error: messageOf(cause) }; }
      }));
      if (cancelled) return;
      const errors: Record<string, string> = {};
      for (const result of results) {
        if (result.error) errors[result.key] = result.error;
        if (result.key === "agents") setAgents(rows(result.value));
        if (result.key === "templates") setTemplates(rows(result.value));
        if (result.key === "drafts") setDrafts(rows(result.value));
      }
      setReadErrors(errors);
      const nextTemplates = rows(results.find((result) => result.key === "templates")?.value);
      const nextDrafts = rows(results.find((result) => result.key === "drafts")?.value);
      const nextAgents = rows(results.find((result) => result.key === "agents")?.value);
      setSelectedTemplateKey((current) => current && nextTemplates.some((item) => String(item.key) === current) ? current : String(nextTemplates[0]?.key ?? ""));
      setSelectedDraftId((current) => current && nextDrafts.some((item) => String(item.draftId ?? item.draft_id) === current) ? current : String(nextDrafts[0]?.draftId ?? nextDrafts[0]?.draft_id ?? ""));
      setSelectedAgentId((current) => current && nextAgents.some((item) => String(item.id) === current) ? current : String(nextAgents[0]?.id ?? ""));
      setLoadedFactoryId(activeFactoryId);
      setLoading(false);
    }
    const timer = window.setTimeout(() => {
      void load().catch((cause) => {
        if (!cancelled) { setReadErrors({ workspace: messageOf(cause) }); setLoading(false); }
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connected, activeFactoryId, canRead, canAgentsRead, canDraftRead, request, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    if (!connected || !canDraftRead || !selectedDraftId) return () => { cancelled = true; };
    const timer = window.setTimeout(() => {
      void createAiAgentStudioClient((path, options = {}) => request(path, options)).getDraft(selectedDraftId).then((result) => {
        if (!cancelled) setDraftDetail(record(result));
      }).catch((cause) => {
        if (!cancelled) setNotice({ tone: "error", message: messageOf(cause) });
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connected, activeFactoryId, canDraftRead, selectedDraftId, request]);

  useEffect(() => {
    let cancelled = false;
    if (!connected || !canAgentsRead || !selectedAgentId) return () => { cancelled = true; };
    const timer = window.setTimeout(() => {
      const apiClient = createAiAgentStudioClient((path, options = {}) => request(path, options));
      void Promise.allSettled([apiClient.listEvaluationCases(selectedAgentId), apiClient.getEvaluationReport(selectedAgentId)]).then((results) => {
        if (cancelled) return;
        if (results[0].status === "fulfilled") {
          const nextCases = rows(results[0].value);
          setEvaluationCases(nextCases);
          setSelectedCaseId((current) => current && nextCases.some((item) => String(item.id ?? item.caseId ?? item.case_id) === current)
            ? current : String(nextCases[0]?.id ?? nextCases[0]?.caseId ?? nextCases[0]?.case_id ?? ""));
        } else setEvaluationCases([]);
        if (results[1].status === "fulfilled") setEvaluationReport(record(results[1].value));
        else setEvaluationReport(null);
        setEvaluationScopeId(selectedAgentId);
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connected, activeFactoryId, canAgentsRead, selectedAgentId, request, refreshTick]);

  async function perform(title: string, action: () => Promise<unknown>, onSuccess?: (value: unknown) => void): Promise<unknown> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      onSuccess?.(result);
      setLatestOperation(result);
      setNotice({ tone: "success", message: title + " completed. Inspect the returned API status and evidence before the next lifecycle action." });
      setRefreshTick((current) => current + 1);
      return result;
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
      return null;
    } finally {
      setBusy(false);
    }
  }
  function onSubmit(event: FormEvent<HTMLFormElement>, title: string, action: () => Promise<unknown>, done?: (value: unknown) => void) {
    event.preventDefault();
    void perform(title, action, done);
  }

  async function loadRun() {
    if (!sandboxId || !runId) {
      setNotice({ tone: "warning", message: "A sandbox UUID and simulation run UUID are required." });
      return;
    }
    await perform("Simulation run detail", () => api().getRun(sandboxId, runId), (value) => {
      setRunDetail(record(value));
      setReplaySource(runId);
      setBranchSource(runId);
      setLeftRunId(runId);
    });
  }
  async function inspectStep() {
    if (!sandboxId || !runId) return;
    await perform("Simulation step inspection", () => api().inspectStep(sandboxId, runId, Number(stepIndex)), (value) => setStepDetail(record(value)));
  }
  async function refreshCaseEvidence() {
    if (!selectedAgentId || !canAgentsRead) return;
    const result = await Promise.allSettled([api().listEvaluationCases(selectedAgentId), api().getEvaluationReport(selectedAgentId)]);
    if (result[0].status === "fulfilled") setEvaluationCases(rows(result[0].value));
    if (result[1].status === "fulfilled") setEvaluationReport(record(result[1].value));
  }

  const tabs = TABS.filter((item) => {
    if (item.id === "OVERVIEW") return canRead;
    if (item.id === "DRAFTS") return canDraftRead || canDraftWrite;
    if (item.id === "SIMULATION" || item.id === "POLICY") return canAgentsRead || canAgentsWrite;
    if (item.id === "EVALUATION") return canAgentsRead || canAgentsWrite;
    return canPublish || canPromote || canRollback;
  });
  const activeTab = tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id ?? "OVERVIEW";

  if (!connected) return <main className="space-y-5 p-4 sm:p-6">
    <header className="rounded-2xl bg-slate-950 px-5 py-6 text-white">
      <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-blue-200">AI governance</p>
      <h1 className="mt-2 text-2xl font-bold">AI Agent Studio</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Connect the shared FactoryOS session and select an active factory. This page does not collect or persist a separate bearer token.</p>
    </header>
    <Panel title="Factory session required"><Empty>Connect from the workspace session panel and choose an active factory before using the Agent Studio.</Empty></Panel>
  </main>;

  if (!canRead && !canDraftWrite && !canAgentsWrite && !canPublish && !canPromote && !canRollback) {
    return <main className="p-4 sm:p-6"><Panel title="AI Agent Studio access unavailable"><Empty>This factory session has no AI Agent Studio permissions. Ask an administrator for the specific agent, draft, publish or rollback permission required.</Empty></Panel></main>;
  }

  return <main className="space-y-5 p-4 sm:p-6">
    <header className="rounded-2xl bg-slate-950 text-white">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-6 sm:px-7">
        <div className="max-w-3xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-blue-200">AI lifecycle control plane</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">AI Agent Studio & Release Governance</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">Design an agent, validate registered tools, run isolated simulations, evaluate policy and acceptance evidence, then follow the governed publication path.</p>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-300">
            <span className="rounded-full border border-white/20 px-3 py-1">{factoryName}</span>
            <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-emerald-200">Authenticated factory scope</span>
            <span className="rounded-full border border-white/20 px-3 py-1">Live execution not offered</span>
          </div>
        </div>
        <button type="button" className="min-h-9 rounded-lg border border-white/20 px-3 text-xs font-semibold hover:bg-white/10 disabled:opacity-50" disabled={busy || loading} onClick={() => setRefreshTick((value) => value + 1)}>{loading ? "Refreshing…" : "Refresh workspace"}</button>
      </div>
    </header>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Agent definitions" value={canAgentsRead ? visibleAgents.length : "—"} hint={canAgentsRead ? "Catalogue rows returned" : "ai.agents.read required"} />
      <Metric label="Workflow drafts" value={canDraftRead ? drafts.length : "—"} hint={canDraftRead ? "Latest draft versions" : "Draft read permission required"} />
      <Metric label="Simulation run" value={runId ? "Selected" : "Not selected"} hint={runId ? "A simulation run UUID is available" : "Create or load a run"} />
      <Metric label="Publication status" value={label(publishRequest?.status, "Not started")} hint="Current-page request record only" />
    </div>

    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-950">
      <span className="mr-2 rounded-full bg-blue-100 px-2 py-1 text-[10px] font-bold uppercase text-blue-800">Simulation boundary</span>
      Sandbox, replay, branch and historical policy checks are simulation-only. The backend records no network access, no credential access and no live writes. Real task execution and live evaluation are deliberately not exposed here.
    </div>

    {notice ? <div className={"rounded-xl border px-4 py-3 text-xs leading-5 " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : notice.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-rose-200 bg-rose-50 text-rose-900")}>
      <div className="flex items-start justify-between gap-3"><p>{notice.message}</p><button type="button" className="text-[10px] font-bold uppercase" onClick={() => setNotice(null)}>Dismiss</button></div>
    </div> : null}
    {Object.keys(readErrors).length ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="text-xs font-bold text-amber-900">Some read endpoints could not be loaded</p>
      {Object.entries(readErrors).map(([key, value]) => <p key={key} className="mt-1 text-xs text-amber-800">{key}: {value}</p>)}
    </div> : null}

    <nav className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1" aria-label="AI Agent Studio sections">
      {tabs.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-current={activeTab === item.id ? "page" : undefined} className={"min-w-max rounded-lg px-3 py-2 text-xs font-semibold " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
    </nav>

    {activeTab === "OVERVIEW" ? <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Governed agent lifecycle" subtitle="Each stage has separate permissions and API-side eligibility checks. Draft approval does not create an agent definition or grant tools.">
        <ol className="space-y-3">
          {[
            ["01", "Specify", "Start from a template or generate a natural-language workflow draft."],
            ["02", "Review", "APPROVE appends READY_FOR_PUBLISH only; it does not publish."],
            ["03", "Catalogue", "Use an existing immutable agent definition and registered tool grants."],
            ["04", "Simulate", "Create an isolated sandbox; inspect, replay, branch and compare simulation runs."],
            ["05", "Evaluate", "Run versioned evaluation cases against simulation evidence."],
            ["06", "Publish", "Request CANARY or PRODUCTION, then separately approve and promote."],
          ].map(([number, title, description]) => <li key={number} className="flex gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-700">{number}</span>
            <div><p className="text-xs font-bold text-slate-900">{title}</p><p className="mt-0.5 text-xs leading-5 text-slate-500">{description}</p></div>
          </li>)}
        </ol>
      </Panel>
      <Panel title="Permission coverage" subtitle="The UI gates actions for guidance; the API rechecks every permission and factory scope.">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ["ai.agents.read", canAgentsRead], ["ai.agents.draft.read", canDraftRead],
            ["ai.agents.draft.write", canDraftWrite], ["ai.agents.write", canAgentsWrite],
            ["ai.agents.publish", canPublish], ["ai.agents.promote", canPromote],
            ["ai.agents.rollback", canRollback],
          ].map(([name, granted]) => <div key={String(name)} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
            <code className="text-[10px] text-slate-700">{name}</code><State value={granted ? "GRANTED" : "NOT_GRANTED"} />
          </div>)}
        </div>
      </Panel>
      <Panel title="Current evidence references" subtitle="Exact IDs used by the subsequent policy, evaluation and release operations.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sandbox ID"><input className={INPUT} readOnly value={sandboxId} placeholder="Not selected" /></Field>
          <Field label="Simulation run ID"><input className={INPUT} readOnly value={runId} placeholder="Not selected" /></Field>
          <Field label="Agent definition ID"><input className={INPUT} readOnly value={selectedAgentId} placeholder="Select in Evaluation" /></Field>
          <Field label="Publish request ID"><input className={INPUT} readOnly value={label(publishRequest?.requestId ?? publishRequest?.id, "")} placeholder="No request" /></Field>
        </div>
      </Panel>
      <Panel title="Release eligibility constraints" subtitle="The service checks these again when a publication request is promoted.">
        <ul className="space-y-2 text-xs leading-5 text-slate-600">
          <li>• Publication requires a catalogue definition plus a completed simulation-only sandbox and completed simulation run.</li>
          <li>• PRODUCTION requests also require a completed policy simulation.</li>
          <li>• Production promotion requires an active CANARY deployment for the same immutable agent definition and fresh live acceptance after CANARY started.</li>
          <li>• Policy drift, denied events or missing expected outcomes must be addressed; an incomplete simulation is not an acceptance pass.</li>
          <li>• No publish-request listing endpoint is exposed here. The page displays action responses held in this page session only.</li>
        </ul>
      </Panel>
    </div> : null}

    {activeTab === "DRAFTS" ? <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Template catalogue" subtitle="Templates generate reviewable drafts only. They do not grant tool entitlements or issue action tokens.">
          {canDraftRead && templates.length ? <div className="space-y-2">
            {visibleTemplates.map((entry) => <button key={String(entry.key)} type="button" onClick={() => setSelectedTemplateKey(String(entry.key))} className={"w-full rounded-xl border p-3 text-left " + (selectedTemplateKey === entry.key ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50")}>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-900">{label(entry.title, label(entry.key))}</span><State value={entry.category ?? "TEMPLATE"} /></div>
              <p className="mt-1 text-[11px] text-slate-500">{label(entry.description, label(entry.summary, "Factory workflow template"))}</p>
              <p className="mt-2 font-mono text-[10px] text-slate-400">{label(entry.key)} · v{label(entry.version)}</p>
            </button>)}
          </div> : <Empty>{canDraftRead ? "No templates were returned for this factory." : "ai.agents.draft.read permission is required."}</Empty>}
          {canDraftWrite ? <form className="mt-4 space-y-3 border-t border-slate-100 pt-4" onSubmit={(event) => onSubmit(event, "Template draft", () => api().createTemplateDraft(selectedTemplateKey, buildAiStudioTemplateDraftPayload({ title: templateTitle, customization: templateCustomization })), (value) => {
            const draft = record(record(value).draft);
            const id = String(draft.draftId ?? draft.draft_id ?? "");
            if (id) setSelectedDraftId(id);
          })}>
            <Field label="Draft title"><input className={INPUT} value={templateTitle} onChange={(event) => setTemplateTitle(event.target.value)} placeholder="Optional title override" /></Field>
            <Field label="Factory-specific customization" hint="Human review only; the backend treats this text as untrusted.">
              <textarea className={AREA} value={templateCustomization} onChange={(event) => setTemplateCustomization(event.target.value)} placeholder="Describe additional boundaries and approval checkpoints…" />
            </Field>
            <button className={PRIMARY} type="submit" disabled={busy || !selectedTemplateKey}>Create draft from selected template</button>
          </form> : null}
        </Panel>
        <Panel title="Natural-language workflow draft" subtitle="The compiler creates a specification for review. It does not call tools or grant authority.">
          {canDraftWrite ? <form className="space-y-3" onSubmit={(event) => onSubmit(event, "Workflow draft", () => api().createDraft(buildAiStudioDraftPayload({ prompt: draftPrompt, title: draftTitle })), (value) => {
            const result = record(value);
            const id = String(result.draftId ?? result.draft_id ?? "");
            if (id) setSelectedDraftId(id);
            setDraftPrompt("");
          })}>
            <Field label="Draft title"><input className={INPUT} value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} placeholder="e.g. Production exception triage" /></Field>
            <Field label="Describe the workflow" hint="Maximum 4,000 characters. Include objective, scope, checks and human approval points. Never include secrets.">
              <textarea className={AREA + " min-h-48"} value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} maxLength={4000} required placeholder="Design a read-only production exception assistant that checks WIP signals, summarizes blockers, recommends the next action and asks for manager review before any write…" />
            </Field>
            <button className={PRIMARY} type="submit" disabled={busy || !draftPrompt.trim()}>Generate reviewable draft</button>
          </form> : <Empty>ai.agents.draft.write permission is required to create a workflow draft.</Empty>}
        </Panel>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Panel title="Latest workflow drafts" subtitle="The API returns the latest version of each draft, up to 100 records.">
          {canDraftRead && visibleDrafts.length ? <div className="space-y-2">
            {visibleDrafts.map((draft) => {
              const id = String(draft.draftId ?? draft.draft_id ?? "");
              return <button key={id} type="button" onClick={() => setSelectedDraftId(id)} className={"w-full rounded-xl border p-3 text-left " + (selectedDraftId === id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50")}>
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-900">{label(draft.title, "Untitled workflow")}</span><State value={draft.status} /></div>
                <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{label(draft.goal, label(draft.sourcePrompt, "No goal summary returned."))}</p>
                <p className="mt-2 font-mono text-[10px] text-slate-400">v{label(draft.version)} · {id}</p>
              </button>;
            })}
          </div> : <Empty>Select a factory with readable workflow drafts, or create a new draft above.</Empty>}
        </Panel>
        <Panel title="Draft version detail" subtitle="APPROVE creates READY_FOR_PUBLISH only; a separate catalogue definition and simulation are still required.">
          {visibleDraftDetail ? <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-bold text-slate-900">{label(visibleDraftDetail.title)}</p><p className="mt-1 break-all font-mono text-[10px] text-slate-400">{label(visibleDraftDetail.draftId ?? visibleDraftDetail.draft_id)} · v{label(visibleDraftDetail.version)}</p></div><State value={visibleDraftDetail.status} /></div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Metric label="Permissions granted" value={label(record(visibleDraftDetail.validation).permissionsGranted, "0")} hint="Draft generation must not grant authority" />
              <Metric label="Tool grants created" value={label(record(visibleDraftDetail.validation).toolGrantsCreated, "0")} hint="Registry and IAM review is separate" />
            </div>
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{label(firstItem(record(visibleDraftDetail.validation).reasons), "Publication remains blocked until the separately governed catalogue and simulation requirements are met.")}</p>
            <Json title="Generated specification and validation" value={{ generatedSpec: visibleDraftDetail.generatedSpec, validation: visibleDraftDetail.validation, reviewNotes: visibleDraftDetail.reviewNotes, reviewedAt: visibleDraftDetail.reviewedAt }} />
            {canDraftWrite && visibleDraftDetail.status === "DRAFT" ? <div className="space-y-2 border-t border-slate-100 pt-3">
              <Field label="Review notes"><textarea className={AREA} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Explain the decision for the next governed step…" /></Field>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={PRIMARY} disabled={busy} onClick={() => void perform("Draft review approval", () => api().reviewDraft(selectedDraftId, buildAiStudioDraftReviewPayload({ decision: "APPROVE", notes: reviewNotes })), (value) => setDraftDetail(record(value)))}>Mark ready for next step</button>
                <button type="button" className={DANGER} disabled={busy} onClick={() => void perform("Draft review rejection", () => api().reviewDraft(selectedDraftId, buildAiStudioDraftReviewPayload({ decision: "REJECT", notes: reviewNotes })), (value) => setDraftDetail(record(value)))}>Reject draft</button>
              </div>
            </div> : null}
          </div> : <Empty>Select a draft to inspect generated specification and review metadata.</Empty>}
        </Panel>
      </div>
    </div> : null}

    {activeTab === "SIMULATION" ? <div className="space-y-4">
      <Panel title="Create isolated sandbox simulation" subtitle="Use a catalogue-backed agent specification. Every tool id, version and action type must match the registered tool definition. Responses are simulation fixtures, not tool invocations.">
        {canAgentsWrite ? <form className="space-y-3" onSubmit={(event) => onSubmit(event, "Sandbox creation", () => api().createSandbox(buildAiStudioSandboxPayload({
          name: sandboxName, agent_spec: agentSpecJson, plan: planStepJson,
          simulated_tool_responses: simulatedResponsesJson, input_snapshot: inputSnapshotJson, policy_snapshot: policySnapshotJson,
        })), (value) => {
          const result = record(value);
          const sandbox = record(result.sandbox);
          const simulation = record(result.simulation);
          setSandboxId(String(sandbox.id ?? ""));
          setRunId(String(simulation.id ?? ""));
          setRunDetail(result);
          setStepDetail(null);
          setPublishSandboxId(String(sandbox.id ?? ""));
          setPublishRunId(String(simulation.id ?? ""));
          setReplaySource(String(simulation.id ?? ""));
          setBranchSource(String(simulation.id ?? ""));
          setLeftRunId(String(simulation.id ?? ""));
        })}>
          <Field label="Sandbox name"><input className={INPUT} value={sandboxName} onChange={(event) => setSandboxName(event.target.value)} required maxLength={200} /></Field>
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Agent specification JSON" hint="Required fields: agent_id, version, goal, risk_ceiling L0–L4, execution_scopes and tools [{tool_id,version,action_type}].">
              <textarea className={AREA + " min-h-64"} value={agentSpecJson} onChange={(event) => setAgentSpecJson(event.target.value)} />
            </Field>
            <Field label="Simulation plan JSON array" hint="Enter 1–100 ordered step objects. Every tool/version/action must match agent_spec.tools.">
              <textarea className={AREA + " min-h-64"} value={planStepJson} onChange={(event) => setPlanStepJson(event.target.value)} />
            </Field>
          </div>
          <Field label="Simulated tool responses JSON" hint="Object keys must be exact tool_id@version references. Missing fixtures create a BLOCKED simulation.">
            <textarea className={AREA} value={simulatedResponsesJson} onChange={(event) => setSimulatedResponsesJson(event.target.value)} />
          </Field>
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Input snapshot JSON (optional)"><textarea className={AREA} value={inputSnapshotJson} onChange={(event) => setInputSnapshotJson(event.target.value)} /></Field>
            <Field label="Policy snapshot JSON (optional)"><textarea className={AREA} value={policySnapshotJson} onChange={(event) => setPolicySnapshotJson(event.target.value)} /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-3"><button className={PRIMARY} type="submit" disabled={busy}>Create simulation-only sandbox</button><span className="text-[10px] text-slate-500">API sets networkAccess=NONE, credentialsAccess=NONE and liveWriteAllowed=false.</span></div>
        </form> : <Empty>ai.agents.write permission is required to create sandbox simulations.</Empty>}
      </Panel>

      <Panel title="Sandbox and simulation run" subtitle="Run detail includes the backend plan review built from registered tool metadata.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sandbox UUID"><input className={INPUT} value={sandboxId} onChange={(event) => setSandboxId(event.target.value)} placeholder="Sandbox UUID" /></Field>
          <Field label="Simulation run UUID"><input className={INPUT} value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="Run UUID" /></Field>
        </div>
        <button type="button" className={SECONDARY + " mt-3"} disabled={busy || !sandboxId || !runId} onClick={() => void loadRun()}>Load run detail</button>
        {runDetail ? <div className="mt-4 grid gap-3 lg:grid-cols-2"><Json title="Sandbox and run" value={{ sandbox: record(runDetail.sandbox), simulation: record(runDetail.simulation), runKind: runDetail.runKind }} /><Json title="Plan review" value={runDetail.planReview} /></div> : <div className="mt-4"><Empty>Create a sandbox or enter existing sandbox and simulation UUIDs.</Empty></div>}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Inspect an individual step" subtitle="Inspect expected tool call, observation and simulated fixture response.">
          <div className="flex flex-wrap items-end gap-2"><Field label="Step index"><input type="number" min="0" max="99" className={INPUT} value={stepIndex} onChange={(event) => setStepIndex(event.target.value)} /></Field><button type="button" className={SECONDARY} disabled={busy || !sandboxId || !runId} onClick={() => void inspectStep()}>Inspect step</button></div>
          {stepDetail ? <div className="mt-3"><Json title="Step inspection" value={stepDetail} /></div> : <div className="mt-3"><Empty>Choose an index and inspect the selected run.</Empty></div>}
        </Panel>
        <Panel title="Replay and branch" subtitle="Both actions reuse simulated fixtures or user-supplied fixtures. Neither executes a live tool.">
          <div className="space-y-3">
            <Field label="Replay source run UUID"><input className={INPUT} value={replaySource} onChange={(event) => setReplaySource(event.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="From step"><input type="number" min="0" max="99" className={INPUT} value={replayFrom} onChange={(event) => setReplayFrom(event.target.value)} /></Field>
              <Field label="To step (optional)"><input type="number" min="0" max="99" className={INPUT} value={replayTo} onChange={(event) => setReplayTo(event.target.value)} /></Field>
            </div>
            <button type="button" className={SECONDARY} disabled={busy || !canAgentsWrite || !sandboxId} onClick={() => void perform("Simulation replay", async () => {
              const result = await api().replayRun(sandboxId, buildAiStudioReplayPayload({ source_run_id: replaySource, from_step_index: replayFrom, to_step_index: replayTo }));
              const simulation = record(record(result).simulation);
              if (simulation.id) { setRunId(String(simulation.id)); setRunDetail(record(result)); }
              return result;
            })}>Replay selected range</button>
            <div className="border-t border-slate-100 pt-3">
              <Field label="Branch source run UUID"><input className={INPUT} value={branchSource} onChange={(event) => setBranchSource(event.target.value)} /></Field>
              <Field label="Branch from step"><input type="number" min="0" max="99" className={INPUT} value={branchIndex} onChange={(event) => setBranchIndex(event.target.value)} /></Field>
              <Field label="Alternative plan JSON array"><textarea className={AREA} value={branchPlanJson} onChange={(event) => setBranchPlanJson(event.target.value)} /></Field>
              <Field label="Alternative simulated response JSON"><textarea className={AREA} value={branchResponsesJson} onChange={(event) => setBranchResponsesJson(event.target.value)} /></Field>
              <button type="button" className={SECONDARY} disabled={busy || !canAgentsWrite || !sandboxId} onClick={() => void perform("Simulation branch", async () => {
                const result = await api().branchRun(sandboxId, buildAiStudioBranchPayload({ source_run_id: branchSource, branch_from_step_index: branchIndex, plan: branchPlanJson, simulated_tool_responses: branchResponsesJson }));
                const simulation = record(record(result).simulation);
                if (simulation.id) { setRunId(String(simulation.id)); setRunDetail(record(result)); }
                return result;
              })}>Create alternate simulation branch</button>
            </div>
          </div>
        </Panel>
      </div>
      <Panel title="Compare simulation runs" subtitle="The API returns step-level plan differences and outcome summaries. Both runs must belong to this sandbox.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Left simulation run UUID"><input className={INPUT} value={leftRunId} onChange={(event) => setLeftRunId(event.target.value)} /></Field>
          <Field label="Right simulation run UUID"><input className={INPUT} value={rightRunId} onChange={(event) => setRightRunId(event.target.value)} /></Field>
        </div>
        <button type="button" className={SECONDARY + " mt-3"} disabled={busy || !canAgentsRead || !sandboxId} onClick={() => void perform("Simulation comparison", () => api().compareRuns(sandboxId, buildAiStudioComparePayload({ left_run_id: leftRunId, right_run_id: rightRunId })), (value) => setComparisonResult(record(value)))}>Compare runs</button>
        {comparisonResult ? <div className="mt-3"><Json title="Run comparison result" value={comparisonResult} /></div> : null}
      </Panel>
    </div> : null}

    {activeTab === "POLICY" ? <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Historical policy simulation" subtitle="The backend runs each historical event through the PolicyService and persists a simulation record. Every event needs an expected outcome for complete expectations.">
        <p className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-900">This evaluates policy evidence only. It does not authorize or execute the historical action.</p>
        <Field label="Sandbox UUID"><input className={INPUT} value={sandboxId} onChange={(event) => setSandboxId(event.target.value)} /></Field>
        <Field label="Historical events JSON" hint="Array of 1–100 events with event_key, action, effective_at and optional resource_type, attributes and expected_outcome.">
          <textarea className={AREA + " min-h-80"} value={historicalEventsJson} onChange={(event) => setHistoricalEventsJson(event.target.value)} />
        </Field>
        <button type="button" className={PRIMARY + " mt-3"} disabled={busy || !canAgentsWrite || !sandboxId} onClick={() => void perform("Historical policy simulation", () => api().simulatePolicies(sandboxId, buildAiStudioPolicySimulationPayload({ historical_events: historicalEventsJson })), (value) => {
          const result = record(value);
          setPolicyResult(result);
          setPublishPolicyRunId(String(result.simulationRunId ?? result.simulation_run_id ?? ""));
        })}>Evaluate historical policies</button>
      </Panel>
      <Panel title="Policy drift and event evidence" subtitle="Recommendations come from expected-versus-actual outcomes and do not replace a human approval.">
        {policyResult ? <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><State value={policyResult.status} /><State value={policyResult.recommendation} /></div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            <Metric label="Allowed" value={label(policyResult.allowedCount, "0")} hint="Actual ALLOWED" />
            <Metric label="Approval required" value={label(policyResult.approvalRequiredCount, "0")} hint="Actual approval gate" />
            <Metric label="Denied" value={label(policyResult.deniedCount, "0")} hint="Actual DENIED" />
            <Metric label="Expected matches" value={label(policyResult.expectedOutcomeMatches, "0")} hint="Matched expectations" />
            <Metric label="Outcome drift" value={label(policyResult.expectedOutcomeDriftCount, "0")} hint="Expectation mismatch" />
            <Metric label="Missing expectations" value={label(policyResult.missingExpectedOutcomeCount, "0")} hint="Must be completed" />
          </div>
          <div className="rounded-lg border border-slate-200 p-3 text-xs text-slate-700">
            <p>All expectations complete: <strong>{String(policyResult.expectationsComplete)}</strong></p>
            <p className="mt-1">Expected outcomes all matched: <strong>{String(policyResult.allExpectedOutcomesMatched)}</strong></p>
            <p className="mt-1">All cases non-denied: <strong>{String(policyResult.allCasesNonDenied)}</strong></p>
            <p className="mt-1 break-all font-mono text-[10px] text-slate-500">Policy simulation run: {label(policyResult.simulationRunId)}</p>
          </div>
          {rows(policyResult.cases).map((entry) => <article key={String(entry.eventKey)} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold">{label(entry.eventKey)}</span><State value={entry.actualOutcome} /></div>
            <p className="mt-1 text-[11px] text-slate-600">{label(entry.action)} · expected {label(entry.expectedOutcome, "not supplied")} · match {String(entry.matchedExpectedOutcome ?? "not evaluated")}</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-500">{label(entry.reason)}</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-500">Policy {label(entry.policyKey, "—")} v{label(entry.policyVersion)} · risk {label(entry.riskClass)} · approval required {String(entry.approvalRequired)} · safe default {String(entry.safeDefault)}</p>
          </article>)}
        </div> : <Empty>Run a policy simulation to inspect drift, policy version, risk class, safe-default and event-level reasoning.</Empty>}
      </Panel>
    </div> : null}

    {activeTab === "EVALUATION" ? <div className="space-y-4">
      <Panel title="Select catalogue definition" subtitle="Evaluation cases are bound to an immutable Agent Catalogue definition.">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="Agent definition"><select className={INPUT} value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
            <option value="">Select an agent definition</option>
            {visibleAgents.map((entry) => <option key={String(entry.id)} value={String(entry.id)}>{label(entry.name, label(entry.agentId ?? entry.agent_id))} · {label(entry.version)}</option>)}
          </select></Field>
          <div className="flex items-end"><button type="button" className={SECONDARY} disabled={busy || !selectedAgentId} onClick={() => void refreshCaseEvidence()}>Refresh evidence</button></div>
        </div>
        {selectedAgentId ? <p className="mt-2 break-all font-mono text-[10px] text-slate-500">Definition ID: {selectedAgentId}</p> : null}
      </Panel>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Create a versioned evaluation case" subtitle="Never include passwords, tokens, API keys or secret-like fields in expected_input_subset.">
          {canAgentsWrite && selectedAgentId ? <form className="space-y-3" onSubmit={(event) => onSubmit(event, "Evaluation case creation", () => api().createEvaluationCase(selectedAgentId, buildAiStudioEvaluationCasePayload(JSON.parse(evaluationCaseJson))))}>
            <Field label="Evaluation case JSON" hint="Kinds: EXPECTED_TOOL_CALL, EXPECTED_REFUSAL, RED_TEAM_POLICY_BYPASS, EXPECTED_COMPENSATION, PRIVACY_NO_SECRET_LEAKAGE. Backend validates kind-specific fields.">
              <textarea className={AREA + " min-h-80"} value={evaluationCaseJson} onChange={(event) => setEvaluationCaseJson(event.target.value)} />
            </Field>
            <button type="submit" className={PRIMARY} disabled={busy}>Create evaluation case</button>
          </form> : <Empty>Select an agent and grant ai.agents.write to add an evaluation case.</Empty>}
        </Panel>
        <Panel title="Evaluation cases" subtitle="Evaluate against a simulation_run_id only. Live task evaluation is not available on this page.">
          {visibleEvaluationCases.length ? <div className="space-y-2">
            {visibleEvaluationCases.map((entry) => {
              const id = String(entry.id ?? entry.caseId ?? entry.case_id ?? "");
              return <button key={id} type="button" onClick={() => setSelectedCaseId(id)} className={"w-full rounded-lg border p-3 text-left " + (id === selectedCaseId ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50")}>
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold">{label(entry.name, label(entry.caseKey ?? entry.case_key))}</span><State value={entry.latestStatus ?? entry.status} /></div>
                <p className="mt-1 text-[10px] text-slate-500">{label(entry.kind)} · v{label(entry.version ?? entry.caseVersion)}</p>
                <p className="mt-1 break-all font-mono text-[10px] text-slate-400">{id}</p>
              </button>;
            })}
          </div> : <Empty>No evaluation cases are recorded for the selected agent.</Empty>}
          {selectedCase ? <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
            <p className="text-xs font-bold">{label(selectedCase.name)}</p>
            <Field label="Simulation run UUID"><input className={INPUT} value={evaluationRunId} onChange={(event) => setEvaluationRunId(event.target.value)} placeholder={runId || "Completed simulation run UUID"} /></Field>
            <button type="button" className={SECONDARY} disabled={busy || !canAgentsWrite} onClick={() => void perform("Evaluation case run", () => api().evaluateCase(selectedAgentId, selectedCaseId, buildAiStudioEvaluationRunPayload({ simulation_run_id: evaluationRunId || runId })), (value) => setEvaluationResult(record(value)))}>Evaluate against simulation</button>
          </div> : null}
        </Panel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Acceptance report" subtitle="PASS, FAIL and INCONCLUSIVE totals are returned directly by the evaluation service.">
          {visibleEvaluationReport ? <Json title="Catalogue evaluation report" value={visibleEvaluationReport} /> : <Empty>Select an agent with ai.agents.read permission to view the report.</Empty>}
          {evaluationResult ? <div className="mt-3"><Json title="Latest evaluation result" value={evaluationResult} /></div> : null}
        </Panel>
        <Panel title="Evidence interpretation" subtitle="The service restricts what synthetic evidence is allowed to prove.">
          <ul className="space-y-2 text-xs leading-5 text-slate-600">
            <li>• EXPECTED_TOOL_CALL and EXPECTED_REFUSAL may be checked against matching sandbox simulation evidence.</li>
            <li>• Privacy no-secret-leakage, red-team bypass and compensation cases can remain INCONCLUSIVE without version-pinned live executor evidence.</li>
            <li>• Do not convert INCONCLUSIVE to PASS manually. Follow the authorized external acceptance process and use the report as returned.</li>
            <li>• This page does not call evaluate-live and never runs a live agent task.</li>
          </ul>
        </Panel>
      </div>
    </div> : null}

    {activeTab === "RELEASE" ? <div className="space-y-4">
      <Panel title="Request publication" subtitle="This creates a controlled request only; it does not promote or activate an agent. The API validates all source IDs and evidence in this factory.">
        {canPublish ? <form className="space-y-3" onSubmit={(event) => onSubmit(event, "Publication request", () => api().requestPublication(buildAiStudioPublishRequestPayload({
          agent_definition_id: publishAgentId, sandbox_id: publishSandboxId, simulation_run_id: publishRunId,
          policy_simulation_run_id: publishPolicyRunId, target_stage: publishStage, reason: publishReason,
        })), (value) => {
          setPublishRequest(record(value));
          setRollbackDeploymentId("");
        })}>
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Agent definition UUID"><input className={INPUT} value={publishAgentId} onChange={(event) => setPublishAgentId(event.target.value)} placeholder={selectedAgentId || "Catalogue definition UUID"} /></Field>
            <Field label="Sandbox UUID"><input className={INPUT} value={publishSandboxId} onChange={(event) => setPublishSandboxId(event.target.value)} placeholder={sandboxId || "Completed sandbox UUID"} /></Field>
            <Field label="Completed simulation run UUID"><input className={INPUT} value={publishRunId} onChange={(event) => setPublishRunId(event.target.value)} placeholder={runId || "Completed run UUID"} /></Field>
            <Field label="Policy simulation run UUID" hint="Required for PRODUCTION."><input className={INPUT} value={publishPolicyRunId} onChange={(event) => setPublishPolicyRunId(event.target.value)} /></Field>
            <Field label="Target stage"><select className={INPUT} value={publishStage} onChange={(event) => setPublishStage(event.target.value as "CANARY" | "PRODUCTION")}><option value="CANARY">CANARY</option><option value="PRODUCTION">PRODUCTION</option></select></Field>
            <Field label="Reason (optional)"><input className={INPUT} value={publishReason} onChange={(event) => setPublishReason(event.target.value)} maxLength={2000} /></Field>
          </div>
          {publishStage === "PRODUCTION" ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">PRODUCTION publication requires a completed policy simulation. Promotion later requires this same agent version to be active in CANARY and fresh live acceptance evidence recorded after the canary deployment began.</p> : null}
          <button className={PRIMARY} type="submit" disabled={busy}>Create publication request</button>
        </form> : <Empty>ai.agents.publish permission is required to create or approve a publication request.</Empty>}
      </Panel>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Publication request status" subtitle="The API exposes no publish-request list endpoint. This action response is held in this open page only.">
          {publishRequest ? <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><State value={publishRequest.status} /><span className="text-[10px] text-slate-500">{label(publishRequest.targetStage)} stage · v{label(publishRequest.version)}</span></div>
            <p className="break-all font-mono text-[10px] text-slate-500">Request: {label(publishRequest.requestId ?? publishRequest.id)}</p>
            <Json title="Publication request record" value={publishRequest} />
            <div className="flex flex-wrap gap-2">
              {canPublish ? <button type="button" className={SECONDARY} disabled={busy || publishRequest.status !== "PENDING"} onClick={() => void perform("Publication approval", () => api().approvePublication(label(publishRequest.requestId ?? publishRequest.id)), (value) => setPublishRequest(record(value)))}>Approve request</button> : null}
              {canPromote ? <button type="button" className={PRIMARY} disabled={busy || publishRequest.status !== "APPROVED"} onClick={() => void perform("Agent promotion", () => api().promotePublication(label(publishRequest.requestId ?? publishRequest.id)), (value) => {
                const result = record(value);
                setPublishRequest(record(result.request));
                setDeployment(record(result.deployment));
                setRollbackDeploymentId(String(record(result.deployment).id ?? ""));
              })}>Promote approved request</button> : null}
            </div>
          </div> : <Empty>Create a publication request to see its ID and current status. The API is authoritative for any later transition.</Empty>}
        </Panel>
        <Panel title="Deployment and rollback" subtitle="Rollback needs ai.agents.rollback, a deployment UUID and a reason.">
          {deployment ? <div className="mb-3"><Json title="Latest deployment record" value={deployment} /></div> : null}
          {canRollback ? <form className="space-y-3" onSubmit={(event) => onSubmit(event, "Deployment rollback", () => api().rollbackDeployment(rollbackDeploymentId, buildAiStudioRollbackPayload({ reason: rollbackReason })), (value) => setDeployment(record(value)))}>
            <Field label="Deployment UUID"><input className={INPUT} value={rollbackDeploymentId} onChange={(event) => setRollbackDeploymentId(event.target.value)} placeholder="Deployment returned by promotion" required /></Field>
            <Field label="Rollback reason"><textarea className={AREA} value={rollbackReason} onChange={(event) => setRollbackReason(event.target.value)} placeholder="Record the verified issue and why rollback is required…" maxLength={2000} required /></Field>
            <button type="submit" className={DANGER} disabled={busy || !rollbackDeploymentId || !rollbackReason.trim()}>Rollback deployment</button>
          </form> : <Empty>ai.agents.rollback permission is required for deployment rollback.</Empty>}
        </Panel>
      </div>
      {latestOperation ? <Panel title="Latest API operation response" subtitle="Copy this exact response into your release evidence and audit review."><Json title="API response" value={latestOperation} /></Panel> : null}
    </div> : null}

    <footer className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[10px] leading-5 text-slate-500">
      Shared FactoryOS session · active factory {activeFactoryId} · API permissions and state transitions remain authoritative · no access token is stored by this page.
    </footer>
  </main>;
}
