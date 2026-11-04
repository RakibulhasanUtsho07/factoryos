"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  canExecuteAgentStep,
  createAiAgentControlCenterClient,
  isTerminalAgentTaskState,
} from "@/lib/ai-agent-control-center.mjs";
import type { AiAgentControlCenterClient } from "@/lib/ai-agent-control-center.mjs";

type JsonRecord = Record<string, unknown>;
type Agent = JsonRecord & { id: string };
type Task = JsonRecord & { id: string };
type TaskDetail = { task: Task; steps: JsonRecord[] };
type Client = AiAgentControlCenterClient;
type Tab = "overview" | "agents" | "tasks" | "drafts";

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asItems(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  if (Array.isArray(record.items)) return record.items.map(asRecord);
  if (Array.isArray(record.data)) return record.data.map(asRecord);
  return [];
}

function valueText(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function valueNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "No record returned.";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function displayDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusTone(status: string): string {
  if (["ACTIVE", "ENABLED", "COMPLETED", "SUCCEEDED", "ACCEPTED", "APPROVED"].includes(status)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (["PAUSED", "AWAITING_APPROVAL", "PENDING", "RESTRICTED", "BLOCKED"].includes(status)) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (["FAILED", "CANCELLED", "REJECTED", "RETIRED"].includes(status)) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${statusTone(value)}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}

function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold tracking-wide text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

export default function AiAgentControlCenterPage() {
  const [apiOrigin, setApiOrigin] = useState(process.env.NEXT_PUBLIC_FACTORYOS_API_URL ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [factoryId, setFactoryId] = useState("");
  const [client, setClient] = useState<Client | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<JsonRecord[]>([]);
  const [templates, setTemplates] = useState<JsonRecord[]>([]);
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<JsonRecord | null>(null);
  const [agentControl, setAgentControl] = useState<JsonRecord | null>(null);
  const [evaluationReport, setEvaluationReport] = useState<unknown>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);

  const [desiredControl, setDesiredControl] = useState<"ENABLED" | "PAUSED" | "RESTRICTED">("ENABLED");
  const [controlReason, setControlReason] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [message, setMessage] = useState("");

  const selectedAgentName = useMemo(() => {
    const found = agents.find((agent) => agent.id === selectedAgentId);
    return valueText(found?.name, "Selected agent");
  }, [agents, selectedAgentId]);

  const refreshWorkspace = useCallback(async (apiClient: Client) => {
    setLoadingWorkspace(true);
    const [agentsResult, tasksResult, draftsResult, templatesResult] = await Promise.allSettled([
      apiClient.listAgents(),
      apiClient.listTasks(50),
      apiClient.listWorkflowDrafts(),
      apiClient.listTemplates(),
    ]);

    const errors: Record<string, string> = {};
    let nextAgents: Agent[] = [];
    if (agentsResult.status === "fulfilled") {
      nextAgents = asItems(agentsResult.value)
        .filter((item) => typeof item.id === "string")
        .map((item) => item as Agent);
      setAgents(nextAgents);
    } else {
      setAgents([]);
      errors.agents = agentsResult.reason instanceof Error ? agentsResult.reason.message : "Could not load agent catalogue.";
    }

    if (tasksResult.status === "fulfilled") {
      setTasks(asItems(tasksResult.value).filter((item) => typeof item.id === "string") as Task[]);
    } else {
      setTasks([]);
      errors.tasks = tasksResult.reason instanceof Error ? tasksResult.reason.message : "Could not load governed tasks.";
    }

    if (draftsResult.status === "fulfilled") {
      setDrafts(asItems(draftsResult.value));
    } else {
      setDrafts([]);
      errors.drafts = draftsResult.reason instanceof Error ? draftsResult.reason.message : "Could not load workflow drafts.";
    }

    if (templatesResult.status === "fulfilled") {
      setTemplates(asItems(templatesResult.value));
    } else {
      setTemplates([]);
      errors.templates = templatesResult.reason instanceof Error ? templatesResult.reason.message : "Could not load agent templates.";
    }

    setReadErrors(errors);
    setSelectedAgentId((current) => (
      current && nextAgents.some((agent) => agent.id === current)
        ? current
        : nextAgents[0]?.id ?? ""
    ));
    const nextTasks = tasksResult.status === "fulfilled"
      ? asItems(tasksResult.value).filter((item) => typeof item.id === "string") as Task[]
      : [];
    setSelectedTaskId((current) => (
      current && nextTasks.some((task) => task.id === current)
        ? current
        : nextTasks[0]?.id ?? ""
    ));
    setLoadingWorkspace(false);
  }, []);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPageError("");
    setMessage("");
    try {
      const nextClient = createAiAgentControlCenterClient({
        apiOrigin,
        accessToken,
        tenantId,
        factoryId,
      });
      setClient(nextClient);
      await refreshWorkspace(nextClient);
      setMessage("Connection established. Each panel reports its own permission and data status.");
    } catch (error) {
      setClient(null);
      setPageError(error instanceof Error ? error.message : "Could not connect to FactoryOS.");
    }
  };

  const disconnect = () => {
    setClient(null);
    setAccessToken("");
    setAgents([]);
    setTasks([]);
    setDrafts([]);
    setTemplates([]);
    setSelectedAgentId("");
    setSelectedTaskId("");
    setSelectedAgent(null);
    setAgentControl(null);
    setEvaluationReport(null);
    setTaskDetail(null);
    setReadErrors({});
    setPageError("");
    setMessage("Disconnected. The bearer token was cleared from this page's memory.");
  };

  const refresh = async () => {
    if (!client) return;
    setPageError("");
    await refreshWorkspace(client);
    setMessage("Workspace refreshed from the authenticated API.");
  };

  useEffect(() => {
    if (!client || !selectedAgentId) {
      setSelectedAgent(null);
      setAgentControl(null);
      setEvaluationReport(null);
      return;
    }
    let active = true;
    setDetailsLoading(true);
    Promise.allSettled([
      client.getAgent(selectedAgentId),
      client.getAgentControl(selectedAgentId),
      client.getEvaluationReport(selectedAgentId),
    ]).then(([agentResult, controlResult, evaluationResult]) => {
      if (!active) return;
      setSelectedAgent(agentResult.status === "fulfilled" ? asRecord(agentResult.value) : null);
      setAgentControl(controlResult.status === "fulfilled" ? asRecord(controlResult.value) : null);
      setEvaluationReport(evaluationResult.status === "fulfilled" ? evaluationResult.value : null);

      const agentError = agentResult.status === "rejected" ? valueText(agentResult.reason instanceof Error ? agentResult.reason.message : "", "Agent detail unavailable.") : "";
      const controlError = controlResult.status === "rejected" ? valueText(controlResult.reason instanceof Error ? controlResult.reason.message : "", "Operational control unavailable.") : "";
      const evaluationError = evaluationResult.status === "rejected" ? valueText(evaluationResult.reason instanceof Error ? evaluationResult.reason.message : "", "Evaluation report unavailable.") : "";
      setReadErrors((current) => ({
        ...current,
        agentDetail: agentError,
        agentControl: controlError,
        evaluation: evaluationError,
      }));
      if (controlResult.status === "fulfilled") {
        const control = asRecord(asRecord(controlResult.value).control);
        const state = valueText(control.status, "ENABLED");
        setDesiredControl(state === "PAUSED" || state === "RESTRICTED" ? state : "ENABLED");
      }
      setDetailsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [client, selectedAgentId]);

  const loadTask = useCallback(async (apiClient: Client, taskId: string) => {
    if (!taskId) {
      setTaskDetail(null);
      return;
    }
    setDetailsLoading(true);
    try {
      const result = asRecord(await apiClient.getTask(taskId));
      const steps = Array.isArray(result.steps) ? result.steps.map(asRecord) : [];
      setTaskDetail({ task: asRecord(result.task), steps });
      setReadErrors((current) => ({ ...current, taskDetail: "" }));
    } catch (error) {
      setTaskDetail(null);
      setReadErrors((current) => ({
        ...current,
        taskDetail: error instanceof Error ? error.message : "Could not load task details.",
      }));
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!client || !selectedTaskId) {
      setTaskDetail(null);
      return;
    }
    void loadTask(client, selectedTaskId);
  }, [client, selectedTaskId, loadTask]);

  const runControlChange = async () => {
    if (!client || !selectedAgentId) return;
    if (!controlReason.trim()) {
      setPageError("Add an operator reason before changing agent operational control.");
      return;
    }
    setBusyAction("control");
    setPageError("");
    try {
      const existingControl = asRecord(asRecord(agentControl).control);
      const scopes = Array.isArray(existingControl.executionScopes)
        ? existingControl.executionScopes.filter((scope): scope is string => typeof scope === "string")
        : [];
      await client.setAgentControl(selectedAgentId, {
        status: desiredControl,
        execution_scopes: scopes,
        reason: controlReason.trim(),
      });
      setControlReason("");
      setMessage(`${selectedAgentName} operational control updated to ${desiredControl}.`);
      const refreshed = await client.getAgentControl(selectedAgentId);
      setAgentControl(asRecord(refreshed));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Agent control update failed.");
    } finally {
      setBusyAction("");
    }
  };

  const runTaskAction = async (
    action: "cancel" | "execute" | "resume" | "verify",
    stepId?: string,
  ) => {
    if (!client || !selectedTaskId) return;
    if (action === "cancel" && !window.confirm("Cancel this governed task? Pending steps will be cancelled; a running external side effect is not force-killed.")) {
      return;
    }
    setBusyAction(action + (stepId ?? ""));
    setPageError("");
    try {
      if (action === "cancel") await client.cancelTask(selectedTaskId);
      if (action === "verify") await client.verifyTask(selectedTaskId);
      if (action === "execute" && stepId) await client.executeStep(selectedTaskId, stepId);
      if (action === "resume" && stepId) await client.resumeTaskStep(selectedTaskId, stepId);
      await loadTask(client, selectedTaskId);
      await refreshWorkspace(client);
      setMessage(
        action === "cancel" ? "Task cancellation recorded by the API." :
          action === "verify" ? "Task verification completed by the API." :
            action === "resume" ? "Approval-pending step was submitted for policy re-check." :
              "Step execution was submitted to the governed API boundary.",
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Task operation failed.");
    } finally {
      setBusyAction("");
    }
  };

  const activeTasks = tasks.filter((task) => !isTerminalAgentTaskState(valueText(task.state, ""))).length;
  const approvalTasks = tasks.filter((task) => valueText(task.state) === "AWAITING_APPROVAL").length;
  const completedTasks = tasks.filter((task) => valueText(task.state) === "COMPLETED").length;

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "agents", label: "Agent catalogue" },
    { id: "tasks", label: "Task operations" },
    { id: "drafts", label: "Studio drafts" },
  ];

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
        <header className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 md:flex-row md:items-end">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-blue-700">
              <span className="inline-block h-2 w-2 rounded-full bg-blue-600" />
              FactoryOS AI
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Agent Control Center</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Governed agent catalogue, factory-scoped tasks, policy approvals and evaluation evidence.
              Write actions remain explicit and are re-authorized by the API.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {client ? (
              <>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">API connected</span>
                <button type="button" onClick={() => void refresh()} disabled={loadingWorkspace} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-100 disabled:opacity-50">
                  {loadingWorkspace ? "Refreshing…" : "Refresh"}
                </button>
                <button type="button" onClick={disconnect} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-100">
                  Disconnect
                </button>
              </>
            ) : (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900">Not connected</span>
            )}
          </div>
        </header>

        {!client && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-bold text-slate-900">Connect to an authenticated FactoryOS API</h2>
              <p className="text-xs leading-5 text-slate-600">
                Paste a short-lived bearer token and the intended tenant/factory scope. The token is kept only in this page's memory,
                is not saved to local storage or cookies, and is cleared when you disconnect or close the page.
              </p>
            </div>
            <form onSubmit={connect} className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold text-slate-700">
                API origin
                <input required value={apiOrigin} onChange={(event) => setApiOrigin(event.target.value)} placeholder="https://factory-api.example.com" className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              </label>
              <label className="text-xs font-semibold text-slate-700">
                Tenant UUID
                <input required value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="11111111-1111-4111-8111-111111111111" className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-mono text-xs font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              </label>
              <label className="text-xs font-semibold text-slate-700">
                Factory UUID
                <input required value={factoryId} onChange={(event) => setFactoryId(event.target.value)} placeholder="22222222-2222-4222-8222-222222222222" className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-mono text-xs font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              </label>
              <label className="text-xs font-semibold text-slate-700">
                Bearer access token
                <input required type="password" autoComplete="off" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="Paste short-lived OIDC access token" className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-mono text-xs font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
                <p className="max-w-2xl text-[11px] leading-5 text-slate-500">
                  The API derives user identity from the verified JWT. This page sends only X-Tenant-Id and X-Factory-Id scope headers;
                  it never sends a caller-supplied X-User-Id.
                </p>
                <button type="submit" className="rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800">
                  Connect securely
                </button>
              </div>
            </form>
          </section>
        )}

        {pageError && <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{pageError}</p>}
        {message && <p role="status" className="mt-5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">{message}</p>}

        {client && (
          <>
            <div className="mt-5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
              <span className="font-semibold text-slate-800">Active factory scope</span>
              <span className="ml-2 font-mono">{tenantId}</span>
              <span className="mx-2 text-slate-300">/</span>
              <span className="font-mono">{factoryId}</span>
              <span className="ml-3 text-slate-400">Bearer token held in memory only</span>
            </div>

            <nav aria-label="Agent Control Center sections" className="mt-6 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
              {tabs.map((item) => (
                <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white hover:text-slate-900"}`}>
                  {item.label}
                </button>
              ))}
            </nav>

            {tab === "overview" && (
              <section className="mt-6 space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Metric label="Agents" value={agents.length} hint="Definitions visible in this factory" />
                  <Metric label="Recent tasks" value={tasks.length} hint="Latest 50 task records" />
                  <Metric label="Active tasks" value={activeTasks} hint="Not in a terminal state" />
                  <Metric label="Awaiting approval" value={approvalTasks} hint="Task state from persisted runtime" />
                </div>
                <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                  <Panel title="Recent governed tasks" action={<button type="button" onClick={() => setTab("tasks")} className="text-xs font-semibold text-blue-700 hover:underline">Open task operations</button>}>
                    {readErrors.tasks && <p className="mb-3 text-xs text-rose-700">{readErrors.tasks}</p>}
                    <div className="space-y-2">
                      {tasks.slice(0, 6).map((task) => (
                        <button key={task.id} type="button" onClick={() => { setSelectedTaskId(task.id); setTab("tasks"); }} className="flex w-full flex-col gap-2 rounded-xl border border-slate-200 p-3 text-left hover:border-blue-300 hover:bg-blue-50/40 sm:flex-row sm:items-center sm:justify-between">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-slate-900">{valueText(task.goal, "Untitled governed task")}</span>
                            <span className="mt-1 block truncate font-mono text-[10px] text-slate-500">{task.id}</span>
                          </span>
                          <StatusPill value={valueText(task.state, "UNKNOWN")} />
                        </button>
                      ))}
                      {tasks.length === 0 && !readErrors.tasks && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No task records returned for this factory scope.</p>}
                    </div>
                  </Panel>
                  <Panel title="Agent portfolio">
                    {readErrors.agents && <p className="mb-3 text-xs text-rose-700">{readErrors.agents}</p>}
                    <div className="space-y-2">
                      {agents.slice(0, 6).map((agent) => (
                        <button key={agent.id} type="button" onClick={() => { setSelectedAgentId(agent.id); setTab("agents"); }} className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 text-left hover:border-blue-300 hover:bg-blue-50/40">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-slate-900">{valueText(agent.name, valueText(agent.agentId, "Unnamed agent"))}</span>
                            <span className="mt-1 block text-xs text-slate-500">{valueText(agent.version, "Unversioned")} · {valueText(agent.capability, "Capability not supplied")}</span>
                          </span>
                          <StatusPill value={valueText(agent.status, "UNKNOWN")} />
                        </button>
                      ))}
                      {agents.length === 0 && !readErrors.agents && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No agent definitions returned.</p>}
                    </div>
                  </Panel>
                </div>
                <div className="grid gap-5 md:grid-cols-2">
                  <Panel title="Drafts awaiting review">
                    {readErrors.drafts && <p className="mb-3 text-xs text-rose-700">{readErrors.drafts}</p>}
                    <p className="text-3xl font-semibold text-slate-950">{drafts.length}</p>
                    <p className="mt-1 text-xs text-slate-500">Workflow drafts visible to the current IAM principal.</p>
                  </Panel>
                  <Panel title="Templates available">
                    {readErrors.templates && <p className="mb-3 text-xs text-rose-700">{readErrors.templates}</p>}
                    <p className="text-3xl font-semibold text-slate-950">{templates.length}</p>
                    <p className="mt-1 text-xs text-slate-500">Template catalogue returned by the API for this factory.</p>
                  </Panel>
                </div>
                <p className="text-xs leading-5 text-slate-500">Counts are live API responses, not seeded demo values. A permission error is displayed per section and does not fabricate a zero-data success.</p>
              </section>
            )}

            {tab === "agents" && (
              <section className="mt-6 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                <Panel title="Factory agent definitions">
                  {readErrors.agents && <p className="mb-3 text-xs text-rose-700">{readErrors.agents}</p>}
                  <div className="space-y-2">
                    {agents.map((agent) => (
                      <button key={agent.id} type="button" onClick={() => setSelectedAgentId(agent.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedAgentId === agent.id ? "border-blue-500 bg-blue-50/70" : "border-slate-200 hover:border-blue-300"}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-slate-900">{valueText(agent.name, valueText(agent.agentId, "Unnamed agent"))}</span>
                          <StatusPill value={valueText(agent.status, "UNKNOWN")} />
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{valueText(agent.agentId)} · v{valueText(agent.version)}</p>
                        <p className="mt-2 text-xs leading-5 text-slate-600">{valueText(agent.capability, "No capability description.")}</p>
                      </button>
                    ))}
                    {agents.length === 0 && !readErrors.agents && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No agent definitions returned for this scope.</p>}
                  </div>
                </Panel>

                <div className="space-y-5">
                  <Panel title={selectedAgentName} action={detailsLoading ? <span className="text-xs text-slate-500">Loading details…</span> : undefined}>
                    {readErrors.agentDetail && <p className="mb-3 text-xs text-rose-700">{readErrors.agentDetail}</p>}
                    {selectedAgent ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase text-slate-500">Authority</p><p className="mt-1 text-sm">{valueText(selectedAgent.authority)}</p></div>
                        <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase text-slate-500">Risk ceiling</p><p className="mt-1 text-sm">{valueText(selectedAgent.riskCeiling)}</p></div>
                        <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase text-slate-500">Execution scopes</p><p className="mt-1 break-words text-sm">{Array.isArray(selectedAgent.executionScopes) ? selectedAgent.executionScopes.join(", ") || "None" : "Not returned"}</p></div>
                        <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase text-slate-500">Owner user ID</p><p className="mt-1 break-all font-mono text-xs">{valueText(selectedAgent.ownerUserId)}</p></div>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">Select an agent to inspect its version-pinned definition.</p>
                    )}
                  </Panel>

                  <Panel title="Operational control">
                    {readErrors.agentControl && <p className="mb-3 text-xs text-rose-700">{readErrors.agentControl}</p>}
                    {agentControl && (
                      <div className="mb-4 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-slate-600">Current catalogue state: {valueText(agentControl.catalogueStatus)}</span>
                        <StatusPill value={valueText(asRecord(agentControl.control).status, "NO OVERRIDE")} />
                      </div>
                    )}
                    <div className="grid gap-3 sm:grid-cols-[1fr_1.3fr]">
                      <label className="text-xs font-semibold text-slate-700">
                        Desired control
                        <select value={desiredControl} onChange={(event) => setDesiredControl(event.target.value as "ENABLED" | "PAUSED" | "RESTRICTED")} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm">
                          <option value="ENABLED">Enabled</option>
                          <option value="PAUSED">Paused</option>
                          <option value="RESTRICTED">Restricted</option>
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-slate-700">
                        Operator reason (required)
                        <input value={controlReason} onChange={(event) => setControlReason(event.target.value)} maxLength={1000} placeholder="Incident, safety or operations reason" className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-normal" />
                      </label>
                    </div>
                    <button type="button" disabled={!selectedAgentId || busyAction === "control" || !controlReason.trim()} onClick={() => void runControlChange()} className="mt-3 rounded-lg bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-40">
                      {busyAction === "control" ? "Updating…" : "Record operational control"}
                    </button>
                    <p className="mt-2 text-[11px] leading-5 text-slate-500">The API requires ai.agents.control and records a reasoned operational-control revision. The immutable agent definition is not edited.</p>
                  </Panel>

                  <Panel title="Evaluation report">
                    {readErrors.evaluation && <p className="mb-3 text-xs text-rose-700">{readErrors.evaluation}</p>}
                    <pre className="max-h-80 overflow-auto rounded-xl bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">{pretty(evaluationReport)}</pre>
                  </Panel>
                </div>
              </section>
            )}

            {tab === "tasks" && (
              <section className="mt-6 grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
                <Panel title="Recent factory tasks">
                  {readErrors.tasks && <p className="mb-3 text-xs text-rose-700">{readErrors.tasks}</p>}
                  <div className="space-y-2">
                    {tasks.map((task) => (
                      <button key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)} className={`w-full rounded-xl border p-3 text-left ${selectedTaskId === task.id ? "border-blue-500 bg-blue-50/70" : "border-slate-200 hover:border-blue-300"}`}>
                        <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{valueText(task.goal, "Governed task")}</span><StatusPill value={valueText(task.state, "UNKNOWN")} /></div>
                        <p className="mt-1 break-all font-mono text-[10px] text-slate-500">{task.id}</p>
                        <p className="mt-2 text-xs text-slate-500">Updated {displayDate(task.updatedAt)}</p>
                      </button>
                    ))}
                    {tasks.length === 0 && !readErrors.tasks && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No task records found in the latest 50 for this factory.</p>}
                  </div>
                </Panel>

                <div className="space-y-5">
                  <Panel title="Persisted task and step ledger" action={detailsLoading ? <span className="text-xs text-slate-500">Loading…</span> : undefined}>
                    {readErrors.taskDetail && <p role="alert" className="mb-3 text-xs text-rose-700">{readErrors.taskDetail}</p>}
                    {taskDetail ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-base font-semibold">{valueText(taskDetail.task.goal, "Governed task")}</p>
                            <p className="mt-1 break-all font-mono text-[10px] text-slate-500">{valueText(taskDetail.task.id)}</p>
                          </div>
                          <StatusPill value={valueText(taskDetail.task.state, "UNKNOWN")} />
                        </div>
                        <div className="mt-4 grid gap-2 sm:grid-cols-3">
                          <Metric label="Completed steps" value={valueNumber(taskDetail.task.completedStepCount)} hint={`Maximum ${valueText(taskDetail.task.maxSteps)}`} />
                          <Metric label="Tool calls" value={valueNumber(taskDetail.task.toolCallCount)} hint={`Maximum ${valueText(taskDetail.task.maxToolCalls)}`} />
                          <Metric label="Retries" value={valueNumber(taskDetail.task.retryCount)} hint={`Limit ${valueText(taskDetail.task.maxRetries)}`} />
                        </div>
                        <div className="mt-4 space-y-3">
                          {taskDetail.steps.map((step) => {
                            const stepId = valueText(step.id, "");
                            const stepStatus = valueText(step.status, "UNKNOWN");
                            const canExecute = canExecuteAgentStep(step);
                            return (
                              <article key={stepId} className="rounded-xl border border-slate-200 p-4">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-sm font-semibold">{valueText(step.stepKey, "Step")} · {valueText(step.toolId)}</span>
                                  <StatusPill value={stepStatus} />
                                </div>
                                <p className="mt-1 text-xs text-slate-500">{valueText(step.capability)} · {valueText(step.actionType)} · attempt {valueNumber(step.authorizationAttempt)}</p>
                                {step.nextRetryAt && <p className="mt-1 text-xs text-amber-800">Next retry eligible: {displayDate(step.nextRetryAt)}</p>}
                                {step.approvalId && <p className="mt-1 break-all font-mono text-[10px] text-slate-500">Approval: {valueText(step.approvalId)}</p>}
                                {step.executionEvidence && <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-blue-700">Execution evidence</summary><pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-[10px] text-slate-100">{pretty(step.executionEvidence)}</pre></details>}
                                {step.error && Object.keys(asRecord(step.error)).length > 0 && <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-rose-50 p-3 text-[10px] text-rose-800">{pretty(step.error)}</pre>}
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {canExecute && <button type="button" onClick={() => void runTaskAction("execute", stepId)} disabled={Boolean(busyAction)} className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{busyAction === "execute" + stepId ? "Executing…" : "Execute pending step"}</button>}
                                  {stepStatus === "AWAITING_APPROVAL" && <button type="button" onClick={() => void runTaskAction("resume", stepId)} disabled={Boolean(busyAction)} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-40">{busyAction === "resume" + stepId ? "Re-checking…" : "Resume after approval"}</button>}
                                </div>
                              </article>
                            );
                          })}
                          {taskDetail.steps.length === 0 && <p className="text-sm text-slate-500">This task has no step records.</p>}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
                          {!isTerminalAgentTaskState(valueText(taskDetail.task.state, "")) && <button type="button" onClick={() => void runTaskAction("cancel")} disabled={Boolean(busyAction)} className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 disabled:opacity-40">{busyAction === "cancel" ? "Cancelling…" : "Request cancellation"}</button>}
                          {taskDetail.steps.length > 0 && taskDetail.steps.every((step) => valueText(step.status) === "SUCCEEDED") && <button type="button" onClick={() => void runTaskAction("verify")} disabled={Boolean(busyAction)} className="rounded-lg bg-blue-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{busyAction === "verify" ? "Verifying…" : "Verify completed task"}</button>}
                        </div>
                        <p className="mt-3 text-[11px] leading-5 text-slate-500">A click is only a request. The backend rechecks IAM, policy, planner signature, tool entitlement, dependencies, retry eligibility, idempotency and cancellation/deadline state before execution. Ambiguous side effects stay in the backend reconciliation path.</p>
                      </>
                    ) : (
                      <p className="text-sm text-slate-500">Select a task to inspect its persisted step, approval, retry and execution-evidence ledger.</p>
                    )}
                  </Panel>
                </div>
              </section>
            )}

            {tab === "drafts" && (
              <section className="mt-6 grid gap-5 lg:grid-cols-2">
                <Panel title="Workflow drafts">
                  {readErrors.drafts && <p className="mb-3 text-xs text-rose-700">{readErrors.drafts}</p>}
                  <div className="space-y-2">
                    {drafts.map((draft, index) => (
                      <article key={valueText(draft.id, `draft-${index}`)} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{valueText(draft.title, valueText(draft.prompt, "Untitled draft"))}</span><StatusPill value={valueText(draft.status, "UNSPECIFIED")} /></div>
                        <p className="mt-1 break-all font-mono text-[10px] text-slate-500">{valueText(draft.id)}</p>
                        <p className="mt-2 text-xs text-slate-500">Updated {displayDate(draft.updatedAt)}</p>
                      </article>
                    ))}
                    {drafts.length === 0 && !readErrors.drafts && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No workflow drafts were returned.</p>}
                  </div>
                </Panel>
                <Panel title="Agent Studio templates">
                  {readErrors.templates && <p className="mb-3 text-xs text-rose-700">{readErrors.templates}</p>}
                  <div className="space-y-2">
                    {templates.map((template, index) => (
                      <article key={valueText(template.id, valueText(template.templateKey, `template-${index}`))} className="rounded-xl border border-slate-200 p-3">
                        <p className="text-sm font-semibold">{valueText(template.name, valueText(template.title, valueText(template.templateKey, "Template")))}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-600">{valueText(template.description, "No description returned.")}</p>
                        <p className="mt-2 break-all font-mono text-[10px] text-slate-500">{valueText(template.templateKey, valueText(template.id))}</p>
                      </article>
                    ))}
                    {templates.length === 0 && !readErrors.templates && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No templates were returned.</p>}
                  </div>
                </Panel>
              </section>
            )}

            <footer className="mt-8 rounded-xl border border-slate-200 bg-white px-4 py-3 text-[11px] leading-5 text-slate-500">
              This console displays only data returned by the current authenticated factory scope. It does not invoke a planner, create a task from an unsigned plan, invent execution outcomes, or promote an agent release automatically. Live planner/provider, write-executor and closed-loop learning acceptance remain separate release gates.
            </footer>
          </>
        )}

        {!client && (
          <section className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white p-6">
            <h2 className="text-sm font-bold text-slate-900">Operator workspace ready</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Connect with an access token that has the relevant AI read and operator permissions to load the real agent catalogue, tasks, workflow drafts and evaluation records. Nothing is seeded into the dashboard.</p>
          </section>
        )}
      </div>
    </main>
  );
}
