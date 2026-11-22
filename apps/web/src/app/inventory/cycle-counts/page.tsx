"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  asCycleCountItems,
  buildCycleCountSessionPayload,
  buildCycleCountTaskPayload,
  buildRecurringCycleCountPayload,
  canReviewCycleCountProposal,
  cycleCountSummary,
  cycleCountTaskActions,
  cycleCountVariance,
  filterCycleCountTasks,
  formatCycleCountQuantity,
  formatCycleCountStatus,
} from "@/lib/cycle-count-operations.mjs";
import type {
  CycleCountPolicy,
  CycleCountProposal,
  CycleCountSession,
  CycleCountTask,
} from "@/lib/cycle-count-operations.mjs";

type InventoryItem = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  status: string;
  quantity_on_hand: string;
  quantity_available: string;
};
type InventoryLocation = {
  id: string;
  location_code: string;
  name?: string;
  location_name?: string;
  location_type: string;
  status: string;
};
type TenantUser = {
  id: string;
  display_name: string;
  email: string;
  status: string;
};
type Tab = "tasks" | "review" | "cadence";
type VarianceEscalation = {
  id: string;
  task_id: string;
  proposal_id: string;
  expected_quantity: string;
  counted_quantity: string;
  variance_quantity: string;
  threshold_quantity: string;
  status: "OPEN" | "RESOLVED";
  resolved_by_user_id: string | null;
  resolution_note: string | null;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function localDateTime(offsetDays = 1) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string; value: number | string; detail: string; tone?: "slate" | "blue" | "amber" | "emerald";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
  };
  return (
    <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </article>
  );
}

function StatusTag({ value, urgent = false }: { value: string; urgent?: boolean }) {
  const normalized = value.toUpperCase();
  const tone = urgent || normalized === "OPEN" || normalized === "PENDING_REVIEW"
    ? "bg-amber-50 text-amber-800"
    : normalized === "COMPLETED" || normalized === "APPLIED" || normalized === "ACTIVE" || normalized === "RESOLVED"
      ? "bg-emerald-50 text-emerald-800"
      : normalized === "REJECTED" || normalized === "CANCELLED" || normalized === "RETIRED"
        ? "bg-slate-100 text-slate-600"
        : "bg-blue-50 text-blue-800";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold " + tone}>{formatCycleCountStatus(value)}</span>;
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

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const dangerButton = buttonClass + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

export default function InventoryCycleCountOperationsPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [tasks, setTasks] = useState<CycleCountTask[]>([]);
  const [sessions, setSessions] = useState<CycleCountSession[]>([]);
  const [policies, setPolicies] = useState<CycleCountPolicy[]>([]);
  const [proposals, setProposals] = useState<CycleCountProposal[]>([]);
  const [proposalRefresh, setProposalRefresh] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionDetails, setSessionDetails] = useState<Record<string, unknown> | null>(null);
  const [escalation, setEscalation] = useState<VarianceEscalation | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [taskStatus, setTaskStatus] = useState("ALL");
  const [taskSearch, setTaskSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [sessionFormOpen, setSessionFormOpen] = useState(false);
  const [policyFormOpen, setPolicyFormOpen] = useState(false);
  const [countFormOpen, setCountFormOpen] = useState(false);
  const [cancelTaskOpen, setCancelTaskOpen] = useState(false);
  const [cancelSessionOpen, setCancelSessionOpen] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [countQuantity, setCountQuantity] = useState("0");
  const [countNotes, setCountNotes] = useState("");
  const [countReason, setCountReason] = useState("OTHER");
  const [cancellationReason, setCancellationReason] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");

  const [taskForm, setTaskForm] = useState({
    item_id: "", location_id: "", assigned_to_user_id: "", due_at: localDateTime(),
    priority: "100", blind_count: true, variance_escalation_threshold: "", notes: "",
  });
  const [sessionForm, setSessionForm] = useState({
    item_id: "", location_ids: [] as string[], assigned_to_user_id: "",
    due_at: localDateTime(), priority: "100", blind_count: true,
    variance_escalation_threshold: "", notes: "",
  });
  const [policyForm, setPolicyForm] = useState({
    item_id: "", location_id: "", location_ids: [] as string[], assigned_to_user_id: "",
    cadence_unit: "WEEKLY", cadence_interval: "1", first_run_at: localDateTime(),
    priority: "100", blind_count: true, variance_escalation_threshold: "", notes: "",
  });

  const canRead = hasPermission("inventory.read");
  const canWrite = hasPermission("inventory.write");
  const canReconcile = hasPermission("inventory.reconcile");
  const canReview = hasPermission("inventory.cycle-count.review");
  const canReadUsers = hasPermission("iam.users.read");
  const viewerId = snapshot?.user.id ?? "";
  const activeItem = items.find((item) => item.id === selectedItemId) ?? null;
  const activeItems = items.filter((item) => item.status.toUpperCase() === "ACTIVE");
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? null;
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const activeBins = locations.filter((location) =>
    location.location_type.toUpperCase() === "BIN" && location.status.toUpperCase() === "ACTIVE");
  const assignableUsers = users.length
    ? users.filter((user) => user.status.toUpperCase() === "ACTIVE")
    : viewerId
      ? [{ id: viewerId, display_name: snapshot?.user.displayName ?? "Current user", email: snapshot?.user.email ?? "", status: "ACTIVE" }]
      : [];
  const summary = useMemo(
    () => cycleCountSummary(tasks, sessions, policies, proposals),
    [tasks, sessions, policies, proposals],
  );
  const visibleTasks = useMemo(
    () => filterCycleCountTasks(tasks, taskSearch, taskStatus),
    [tasks, taskSearch, taskStatus],
  );

  const load = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setItems([]);
      setLocations([]);
      setUsers([]);
      setTasks([]);
      setSessions([]);
      setPolicies([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const requests = await Promise.allSettled([
        request("/inventory/items?limit=100"),
        request("/inventory/locations?limit=100"),
        request("/inventory/cycle-count-tasks?limit=100"),
        request("/inventory/cycle-count-sessions?limit=100"),
        request("/inventory/cycle-count-recurring-policies?limit=100"),
        canReadUsers ? request("/iam/users?limit=100") : Promise.resolve({ items: [] }),
      ]);
      const take = (index: number) => requests[index].status === "fulfilled" ? requests[index].value : null;
      const nextItems = asCycleCountItems(take(0), "items") as InventoryItem[];
      setItems(nextItems);
      setLocations(asCycleCountItems(take(1), "locations") as InventoryLocation[]);
      setTasks(asCycleCountItems(take(2), "tasks") as CycleCountTask[]);
      setSessions(asCycleCountItems(take(3), "sessions") as CycleCountSession[]);
      setPolicies(asCycleCountItems(take(4), "policies") as CycleCountPolicy[]);
      const nextUsers = canReadUsers ? asCycleCountItems(take(5), "items") as TenantUser[] : [];
      setUsers(nextUsers);
      setSelectedItemId((current) => nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? "");
      const nextActiveItems = nextItems.filter((item) => item.status.toUpperCase() === "ACTIVE");
      const firstActiveItemId = nextActiveItems[0]?.id ?? "";
      const isActiveItemId = (id: string) => nextActiveItems.some((item) => item.id === id);
      setTaskForm((current) => ({ ...current, item_id: isActiveItemId(current.item_id) ? current.item_id : firstActiveItemId }));
      setSessionForm((current) => ({ ...current, item_id: isActiveItemId(current.item_id) ? current.item_id : firstActiveItemId, assigned_to_user_id: current.assigned_to_user_id || viewerId }));
      setPolicyForm((current) => ({ ...current, item_id: isActiveItemId(current.item_id) ? current.item_id : firstActiveItemId, assigned_to_user_id: current.assigned_to_user_id || viewerId }));
      if (requests.slice(0, 5).some((result) => result.status === "rejected")) {
        setError("Some cycle-count registers could not be loaded. Check your inventory.read access and refresh.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canRead, canReadUsers, request, viewerId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    async function loadProposals() {
      if (!selectedItemId || status !== "connected" || !canRead) {
        setProposals([]);
        return;
      }
      setProposalLoading(true);
      try {
        const path = canReview
          ? "/inventory/items/" + selectedItemId + "/cycle-counts/review?status=PENDING_REVIEW&limit=100"
          : "/inventory/items/" + selectedItemId + "/cycle-counts?limit=100";
        const result = await request(path);
        if (active) {
          setProposals(asCycleCountItems(result, "proposals") as CycleCountProposal[]);
          setSelectedProposalId((current) => {
            const next = asCycleCountItems(result, "proposals") as CycleCountProposal[];
            return next.some((proposal) => proposal.id === current) ? current : next[0]?.id ?? "";
          });
        }
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        if (active) setProposalLoading(false);
      }
    }
    void loadProposals();
    return () => { active = false; };
  }, [selectedItemId, status, canRead, canReview, request, proposalRefresh]);

  useEffect(() => {
    setEscalation(null);
    setSessionDetails(null);
  }, [selectedTaskId, selectedSessionId]);

  async function runAction(action: () => Promise<unknown>, success: string, refresh = true) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      if (refresh) await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const body = buildCycleCountTaskPayload(taskForm);
      await request("/inventory/cycle-count-tasks", {
        method: "POST",
        idempotencyKey: "cycle-count-task-" + crypto.randomUUID(),
        body,
      });
      setTaskFormOpen(false);
      setTaskForm((current) => ({ ...current, location_id: "", notes: "" }));
    }, "Cycle-count task scheduled. The assigned counter must start it before submitting a count.");
  }

  async function startTask(task: CycleCountTask) {
    await runAction(
      () => request("/inventory/cycle-count-tasks/" + task.id + "/start", { method: "POST" }),
      "Task started. Record the physical quantity when counting is complete.",
    );
  }

  async function submitCount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTask) return;
    const quantity = Number(countQuantity);
    if (!Number.isFinite(quantity) || quantity < 0 || Math.abs(quantity * 10000 - Math.round(quantity * 10000)) > 0.000001) {
      setError("Counted quantity must be zero or greater and use at most 4 decimal places.");
      return;
    }
    await runAction(async () => {
      await request("/inventory/items/" + selectedTask.item_id + "/cycle-counts", {
        method: "POST",
        idempotencyKey: "cycle-count-submit-" + crypto.randomUUID(),
        body: {
          counted_quantity: quantity,
          task_id: selectedTask.id,
          ...(selectedTask.location_id ? { location_id: selectedTask.location_id, variance_reason_code: countReason } : {}),
          ...(countNotes.trim() ? { notes: countNotes.trim() } : {}),
        },
      });
      setCountFormOpen(false);
      setCountQuantity("0");
      setCountNotes("");
      setNotice("Count submitted for independent review. Blind-count expected stock remains hidden from the counter.");
    }, "Count submitted for independent review.");
  }

  async function reviewProposal(action: "approve" | "reject") {
    if (!selectedProposal) return;
    const note = reviewNote.trim();
    if (action === "reject" && !note) {
      setError("A review note is required when rejecting a count.");
      return;
    }
    await runAction(async () => {
      await request(
        "/inventory/items/" + selectedProposal.item_id + "/cycle-counts/" + selectedProposal.id + "/" + action,
        {
          method: "POST",
          idempotencyKey: "cycle-count-review-" + action + "-" + crypto.randomUUID(),
          body: note ? { review_note: note } : {},
        },
      );
      setReviewNote("");
      setSelectedProposalId("");
      setProposalRefresh((version) => version + 1);
    }, action === "approve"
      ? "Cycle count approved and its stock reconciliation was applied."
      : "Cycle count rejected. The scheduled task is available for recount.");
  }

  async function loadEscalation(task: CycleCountTask) {
    await runAction(async () => {
      const result = await request("/inventory/cycle-count-tasks/" + task.id + "/variance-escalation");
      setEscalation(result as VarianceEscalation);
    }, "Variance escalation evidence loaded.", false);
  }

  async function resolveEscalation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTask || !resolutionNote.trim()) return;
    await runAction(async () => {
      const result = await request(
        "/inventory/cycle-count-tasks/" + selectedTask.id + "/variance-escalation/resolve",
        {
          method: "POST",
          idempotencyKey: "cycle-count-escalation-" + crypto.randomUUID(),
          body: { resolution_note: resolutionNote.trim() },
        },
      );
      setEscalation(result as VarianceEscalation);
      setResolutionNote("");
    }, "Variance escalation resolved. A different reviewer may now approve the count.");
  }

  async function cancelTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTask || !cancellationReason.trim()) return;
    await runAction(async () => {
      await request("/inventory/cycle-count-tasks/" + selectedTask.id + "/cancel", {
        method: "POST",
        body: { cancellation_reason: cancellationReason.trim() },
      });
      setCancelTaskOpen(false);
      setCancellationReason("");
      setSelectedTaskId("");
    }, "Cycle-count task cancelled.");
  }

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const body = buildCycleCountSessionPayload(sessionForm);
      const result = await request("/inventory/cycle-count-sessions", {
        method: "POST",
        idempotencyKey: "cycle-count-session-" + crypto.randomUUID(),
        body,
      }) as Record<string, unknown>;
      setSessionFormOpen(false);
      setSelectedSessionId(typeof result.id === "string" ? result.id : "");
    }, "Multi-bin count session created with one task per selected bin.");
  }

  async function openSession(session: CycleCountSession) {
    setSelectedSessionId(session.id);
    await runAction(async () => {
      const result = await request("/inventory/cycle-count-sessions/" + session.id);
      setSessionDetails(result as Record<string, unknown>);
    }, "Session details loaded.", false);
  }

  async function startSession(session: CycleCountSession) {
    await runAction(async () => {
      const result = await request("/inventory/cycle-count-sessions/" + session.id + "/start", { method: "POST" });
      setSessionDetails(result as Record<string, unknown>);
    }, "All eligible bin tasks in the session have been started.");
  }

  async function cancelSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSession || !cancellationReason.trim()) return;
    await runAction(async () => {
      const result = await request("/inventory/cycle-count-sessions/" + selectedSession.id + "/cancel", {
        method: "POST",
        body: { cancellation_reason: cancellationReason.trim() },
      });
      setSessionDetails(result as Record<string, unknown>);
      setCancelSessionOpen(false);
      setCancellationReason("");
    }, "Cycle-count session cancelled.");
  }

  async function createPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const body = buildRecurringCycleCountPayload(policyForm);
      await request("/inventory/cycle-count-recurring-policies", {
        method: "POST",
        idempotencyKey: "cycle-count-policy-" + crypto.randomUUID(),
        body,
      });
      setPolicyFormOpen(false);
      setPolicyForm((current) => ({ ...current, location_id: "", location_ids: [], notes: "" }));
    }, "Recurring cycle-count policy created. The deployment scheduler materializes due occurrences.");
  }

  async function transitionPolicy(policy: CycleCountPolicy, transition: "pause" | "resume" | "retire") {
    await runAction(
      () => request("/inventory/cycle-count-recurring-policies/" + policy.id + "/" + transition, { method: "POST" }),
      "Recurring policy " + transition + "d.",
    );
  }

  async function materializeDue() {
    await runAction(
      () => request("/inventory/cycle-count-recurring-policies/materialize-due?limit=50", { method: "POST" }),
      "Due recurring occurrences checked and materialized. Review the returned task and session registers.",
    );
  }

  if (status !== "connected" || !snapshot) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Inventory · cycle counts</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Cycle-count operations use your authenticated tenant membership and selected active factory.</p>
          <Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800">Connect session</Link>
        </section>
      </main>
    );
  }
  if (!activeFactoryId) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">Select an active factory from the workspace header before opening cycle counts.</div></main>;
  }
  if (!canRead) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold text-amber-950">Inventory access required</h1><p className="mt-2 text-sm text-amber-900">Your permission snapshot does not include <code>inventory.read</code>.</p></div></main>;
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Materials control · stock integrity</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Cycle Count Operations</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Schedule and execute blind counts, reconcile multi-bin sessions, review variance evidence and govern recurring count policies.</p>
          <p className="mt-2 text-xs font-medium text-slate-500">{snapshot.tenant.name} · {snapshot.factories.find((factory) => factory.id === activeFactoryId)?.name ?? "Active factory"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/inventory" className={secondaryButton}>Inventory control tower</Link>
          <button type="button" onClick={() => void load()} disabled={loading} className={secondaryButton}>{loading ? "Refreshing…" : "Refresh registers"}</button>
          {canWrite ? <button type="button" onClick={() => setTaskFormOpen(true)} className={primaryButton}>+ Schedule count</button> : null}
        </div>
      </header>

      {error ? <div role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Scheduled" value={summary.scheduled} detail="Tasks waiting for a counter" tone="blue" />
        <Metric label="In progress" value={summary.inProgress} detail="Physical counts being performed" />
        <Metric label="Awaiting review" value={summary.awaitingReview} detail="Count proposals pending decision" tone="amber" />
        <Metric label="Overdue / escalated" value={summary.overdue + summary.openEscalations} detail={summary.overdue + " overdue · " + summary.openEscalations + " open variance escalations"} tone="amber" />
      </section>

      <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
          <div>
            <h2 className="font-bold text-slate-950">Count governance workspace</h2>
            <p className="mt-1 text-xs text-slate-500">{items.length} item(s) · {activeBins.length} active bins · {assignableUsers.length} visible counters</p>
          </div>
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Cycle count workspaces">
            {([
              ["tasks", "Task board"],
              ["review", "Review queue"],
              ["cadence", "Sessions & cadence"],
            ] as [Tab, string][]).map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={"min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold " + (tab === value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")}>{label}</button>
            ))}
          </div>
        </div>

        {tab === "tasks" ? (
          <div className="grid min-w-0 xl:grid-cols-[minmax(0,1.35fr)_minmax(310px,0.65fr)]">
            <div className="min-w-0 border-b border-slate-200 xl:border-b-0 xl:border-r">
              <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <input value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="Search item, SKU, bin or task ID…" aria-label="Search cycle count tasks" className={inputClass} />
                <select value={taskStatus} onChange={(event) => setTaskStatus(event.target.value)} aria-label="Filter tasks by status" className={inputClass}>
                  <option value="ALL">All task states</option>
                  {["SCHEDULED", "IN_PROGRESS", "AWAITING_REVIEW", "COMPLETED", "CANCELLED"].map((value) => <option key={value} value={value}>{formatCycleCountStatus(value)}</option>)}
                </select>
              </div>
              {loading ? <p className="p-8 text-center text-sm text-slate-500">Loading task register…</p> : visibleTasks.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No cycle-count tasks match this filter.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Item / bin</th><th className="px-4 py-3">Assigned counter</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Controls</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleTasks.map((task) => {
                        const actions = cycleCountTaskActions(task, viewerId);
                        return (
                          <tr key={task.id} className={selectedTaskId === task.id ? "bg-blue-50/70" : "hover:bg-slate-50"}>
                            <td className="px-4 py-3">
                              <button type="button" onClick={() => setSelectedTaskId(task.id)} className="text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-700">
                                <span className="block font-semibold text-slate-900">{task.item_name || task.item_sku || task.item_id}</span>
                                <span className="mt-0.5 block text-xs text-slate-500">{task.item_sku || task.id.slice(0, 8)} · {task.location_code || "Aggregate count"}</span>
                              </button>
                              <div className="mt-2 flex flex-wrap gap-1.5"><StatusTag value={task.status} />{task.overdue ? <StatusTag value="OVERDUE" urgent /> : null}{task.blind_count ? <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-800">Blind count</span> : null}{task.variance_escalation_status ? <StatusTag value={task.variance_escalation_status} urgent={task.variance_escalation_status === "OPEN"} /> : null}</div>
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-600">{assignableUsers.find((user) => user.id === task.assigned_to_user_id)?.display_name || (task.assigned_to_user_id ? task.assigned_to_user_id.slice(0, 8) + "…" : "Unassigned")}</td>
                            <td className="px-4 py-3 text-xs tabular-nums text-slate-600">{new Date(task.due_at).toLocaleString()}</td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1.5">
                                {actions.canStart && canReconcile ? <button type="button" onClick={() => void startTask(task)} disabled={busy} className={primaryButton}>Start</button> : null}
                                {actions.canSubmit && canReconcile ? <button type="button" onClick={() => { setSelectedTaskId(task.id); setCountFormOpen(true); }} disabled={busy} className={secondaryButton}>Enter count</button> : null}
                                {task.current_proposal_id && canReview ? <button type="button" onClick={() => { setSelectedItemId(task.item_id); setTab("review"); }} className={secondaryButton}>Review</button> : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <aside className="min-w-0 p-4 sm:p-5">
              {selectedTask ? (
                <>
                  <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected count task</p><h3 className="mt-1 break-all text-base font-bold text-slate-950">{selectedTask.item_name || selectedTask.item_sku || selectedTask.id}</h3><p className="mt-1 font-mono text-[11px] text-slate-500">{selectedTask.id}</p></div><StatusTag value={selectedTask.status} /></div>
                  <dl className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3 text-xs">
                    <div className="flex justify-between gap-3"><dt className="text-slate-500">Counter</dt><dd className="text-right font-semibold text-slate-800">{assignableUsers.find((user) => user.id === selectedTask.assigned_to_user_id)?.display_name || selectedTask.assigned_to_user_id || "Unassigned"}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-500">Scheduled for</dt><dd className="text-right font-semibold text-slate-800">{new Date(selectedTask.due_at).toLocaleString()}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-500">Priority</dt><dd className="font-semibold text-slate-800">{selectedTask.priority}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-500">Expected balance</dt><dd className="font-semibold text-slate-800">{selectedTask.blind_count ? "Hidden from counter" : "Visible by policy"}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-500">Notes</dt><dd className="max-w-44 text-right text-slate-700">{selectedTask.notes || "—"}</dd></div>
                  </dl>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selectedTask.variance_escalation_status && canReview ? <button type="button" onClick={() => void loadEscalation(selectedTask)} disabled={busy} className={secondaryButton}>Variance evidence</button> : null}
                    {cycleCountTaskActions(selectedTask, viewerId).canCancel && canWrite ? <button type="button" onClick={() => { setCancellationReason(""); setCancelTaskOpen(true); }} disabled={busy} className={dangerButton}>Cancel task</button> : null}
                  </div>
                  {escalation ? (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
                      <div className="flex items-center justify-between gap-2"><p className="text-xs font-bold text-amber-950">Variance escalation</p><StatusTag value={escalation.status} urgent={escalation.status === "OPEN"} /></div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-amber-800">Expected</dt><dd className="mt-1 font-semibold text-amber-950">{formatCycleCountQuantity(escalation.expected_quantity)}</dd></div><div><dt className="text-amber-800">Counted</dt><dd className="mt-1 font-semibold text-amber-950">{formatCycleCountQuantity(escalation.counted_quantity)}</dd></div><div><dt className="text-amber-800">Variance</dt><dd className="mt-1 font-semibold text-amber-950">{formatCycleCountQuantity(escalation.variance_quantity)}</dd></div><div><dt className="text-amber-800">Threshold</dt><dd className="mt-1 font-semibold text-amber-950">{formatCycleCountQuantity(escalation.threshold_quantity)}</dd></div></dl>
                      {escalation.status === "OPEN" && canReview ? <form onSubmit={(event) => void resolveEscalation(event)} className="mt-3 space-y-2"><Field label="Resolution note"><textarea required minLength={1} maxLength={1000} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} className={inputClass} rows={2} placeholder="Explain the variance investigation…" /></Field><button type="submit" disabled={busy || !resolutionNote.trim()} className={primaryButton}>Resolve escalation</button></form> : null}
                      {escalation.status === "RESOLVED" && escalation.resolved_by_user_id === viewerId ? <p className="mt-3 text-xs text-amber-900">A different reviewer must approve this escalated count.</p> : null}
                    </div>
                  ) : null}
                </>
              ) : <p className="py-10 text-center text-sm text-slate-500">Select a task to inspect its policy and lifecycle.</p>}
            </aside>
          </div>
        ) : null}

        {tab === "review" ? (
          <div className="grid min-w-0 xl:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="border-b border-slate-200 p-4 xl:border-b-0 xl:border-r">
              <Field label="Item whose counts are being reviewed">
                <select value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)} className={inputClass}>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}
                </select>
              </Field>
              <p className="mt-3 text-xs leading-5 text-slate-500">The API only reveals blind-count expected balances in the reviewer projection. The submitter&apos;s own blind-count snapshot remains hidden.</p>
              {!canReview ? <div className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Read-only proposal history. Independent decisions require <code>inventory.cycle-count.review</code>.</div> : null}
            </aside>
            <div className="min-w-0 p-4 sm:p-5">
              {proposalLoading ? <p className="p-8 text-center text-sm text-slate-500">Loading count proposals…</p> : proposals.length === 0 ? <p className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-500">{canReview ? "No pending proposals for this item." : "No count proposals have been returned for this item."}</p> : (
                <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                  <div className="space-y-2">
                    {proposals.map((proposal) => <button type="button" key={proposal.id} onClick={() => { setSelectedProposalId(proposal.id); setReviewNote(""); }} className={"w-full rounded-xl border p-3 text-left " + (selectedProposalId === proposal.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50")}>
                      <div className="flex items-center justify-between gap-2"><span className="font-mono text-[11px] text-slate-500">{proposal.id.slice(0, 8)}…</span><StatusTag value={proposal.status} /></div>
                      <p className="mt-2 text-sm font-semibold text-slate-900">Counted {formatCycleCountQuantity(proposal.counted_quantity, activeItem?.unit)}</p>
                      <p className="mt-1 text-xs text-slate-500">{new Date(proposal.created_at).toLocaleString()}</p>
                    </button>)}
                  </div>
                  {selectedProposal ? (
                    <section className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold text-slate-950">Count proposal review</h3><StatusTag value={selectedProposal.status} /></div>
                      <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{selectedProposal.id}</p>
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Counted quantity</p><p className="mt-1 text-lg font-bold tabular-nums">{formatCycleCountQuantity(selectedProposal.counted_quantity, activeItem?.unit)}</p></div>
                        <div className="rounded-lg bg-blue-50 p-3"><p className="text-[11px] text-blue-700">Ledger snapshot</p><p className="mt-1 text-lg font-bold tabular-nums text-blue-950">{selectedProposal.ledger_quantity_at_count === null ? "Hidden" : formatCycleCountQuantity(selectedProposal.ledger_quantity_at_count, activeItem?.unit)}</p></div>
                        <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Variance</p><p className="mt-1 text-lg font-bold tabular-nums">{cycleCountVariance(selectedProposal) === null ? "Unavailable" : formatCycleCountQuantity(cycleCountVariance(selectedProposal), activeItem?.unit)}</p></div>
                        <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Reason</p><p className="mt-1 text-sm font-semibold">{selectedProposal.variance_reason_code || "No location variance reason"}</p></div>
                      </div>
                      <dl className="mt-4 space-y-2 text-xs"><div className="flex justify-between gap-3"><dt className="text-slate-500">Counter</dt><dd className="max-w-48 break-all text-right font-medium">{selectedProposal.created_by_user_id}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Task</dt><dd className="max-w-48 break-all text-right font-medium">{selectedProposal.task_id || "Ad-hoc proposal"}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Balance version</dt><dd className="font-mono">{selectedProposal.balance_version_at_count || "Hidden"}</dd></div></dl>
                      {selectedProposal.notes ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">{selectedProposal.notes}</p> : null}
                      {selectedProposal.status === "PENDING_REVIEW" && canReview ? (
                        <>
                          <Field label="Reviewer note" hint="Required for rejection; recommended for approval when explaining an exception."><textarea maxLength={1000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} className={inputClass} placeholder="Document review evidence…" /></Field>
                          {(() => {
                            const task = tasks.find((entry) => entry.id === selectedProposal.task_id);
                            const escalationStatus = task?.variance_escalation_status ?? null;
                            const enabled = canReviewCycleCountProposal(selectedProposal, viewerId, canReview, escalationStatus)
                              && !(escalation?.status === "RESOLVED" && escalation.resolved_by_user_id === viewerId);
                            return <div className="mt-3 space-y-2">
                              {escalationStatus === "OPEN" ? <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Resolve the threshold escalation from the task board before approving this count.</p> : null}
                              <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void reviewProposal("approve")} disabled={busy || !enabled} className={primaryButton}>Approve & apply</button><button type="button" onClick={() => void reviewProposal("reject")} disabled={busy || !enabled || !reviewNote.trim()} className={dangerButton}>Reject & request recount</button></div>
                              {!enabled && escalationStatus !== "OPEN" ? <p className="text-[11px] text-slate-500">The submitter cannot review their own proposal. A different authorized reviewer is required.</p> : null}
                            </div>;
                          })()}
                        </>
                      ) : <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">This proposal is read-only in its current lifecycle state.</p>}
                    </section>
                  ) : <p className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-500">Select a proposal to inspect the snapshot and review evidence.</p>}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {tab === "cadence" ? (
          <div className="grid min-w-0 xl:grid-cols-2">
            <section className="min-w-0 border-b border-slate-200 p-4 sm:p-5 xl:border-b-0 xl:border-r">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-slate-950">Multi-bin count sessions</h3><p className="mt-1 text-xs leading-5 text-slate-500">One assigned counter, one item and 2–50 distinct active bins per physical session.</p></div>{canWrite ? <button type="button" onClick={() => setSessionFormOpen((value) => !value)} className={secondaryButton}>{sessionFormOpen ? "Close form" : "+ New session"}</button> : null}</div>
              {sessionFormOpen ? (
                <form onSubmit={(event) => void createSession(event)} className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Inventory item"><select required value={sessionForm.item_id} onChange={(event) => setSessionForm((current) => ({ ...current, item_id: event.target.value }))} className={inputClass}>{activeItems.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></Field>
                    <Field label="Assigned counter"><select required value={sessionForm.assigned_to_user_id} onChange={(event) => setSessionForm((current) => ({ ...current, assigned_to_user_id: event.target.value }))} className={inputClass}><option value="">Choose user</option>{assignableUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email || user.id.slice(0, 8)}</option>)}</select></Field>
                    <Field label="Due at"><input required type="datetime-local" value={sessionForm.due_at} onChange={(event) => setSessionForm((current) => ({ ...current, due_at: event.target.value }))} className={inputClass} /></Field>
                    <Field label="Priority (lower first)"><input type="number" min="0" max="10000" value={sessionForm.priority} onChange={(event) => setSessionForm((current) => ({ ...current, priority: event.target.value }))} className={inputClass} /></Field>
                  </div>
                  <Field label="Active bins · choose 2–50">
                    <div className="grid max-h-44 gap-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-2">
                      {activeBins.map((bin) => <label key={bin.id} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={sessionForm.location_ids.includes(bin.id)} onChange={(event) => setSessionForm((current) => ({ ...current, location_ids: event.target.checked ? [...current.location_ids, bin.id] : current.location_ids.filter((id) => id !== bin.id) }))} />{bin.location_code}{bin.name || bin.location_name ? " · " + (bin.name || bin.location_name) : ""}</label>)}
                      {activeBins.length === 0 ? <p className="text-xs text-slate-500">No active bin locations are available.</p> : null}
                    </div>
                  </Field>
                  <label className="flex items-start gap-2 text-xs text-slate-700"><input type="checkbox" checked={sessionForm.blind_count} onChange={(event) => setSessionForm((current) => ({ ...current, blind_count: event.target.checked }))} className="mt-0.5" /><span><strong>Blind count</strong> — hide expected stock from the assigned counter.</span></label>
                  <div className="grid gap-3 sm:grid-cols-2"><Field label="Variance escalation threshold (optional)"><input type="number" step="0.0001" min="0.0001" value={sessionForm.variance_escalation_threshold} onChange={(event) => setSessionForm((current) => ({ ...current, variance_escalation_threshold: event.target.value }))} className={inputClass} /></Field><Field label="Notes"><input value={sessionForm.notes} onChange={(event) => setSessionForm((current) => ({ ...current, notes: event.target.value }))} maxLength={1000} className={inputClass} /></Field></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500">{sessionForm.location_ids.length} bin(s) selected</span><button type="submit" disabled={busy || !canWrite || sessionForm.location_ids.length < 2 || !sessionForm.assigned_to_user_id} className={primaryButton}>Create session</button></div>
                </form>
              ) : null}
              <div className="mt-4 space-y-2">
                {sessions.map((session) => <article key={session.id} className={"rounded-xl border p-3 " + (selectedSessionId === session.id ? "border-blue-300 bg-blue-50/60" : "border-slate-200")}>
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold text-slate-900">{items.find((item) => item.id === session.item_id)?.name || session.item_id}</p><p className="mt-1 font-mono text-[11px] text-slate-500">{session.id.slice(0, 8)}… · {session.expected_bin_count} bins</p></div><StatusTag value={session.status} /></div>
                  <div className="mt-3 grid grid-cols-4 gap-1 text-center text-[11px]"><div className="rounded-lg bg-slate-50 p-2"><strong>{session.scheduled_count}</strong><span className="mt-0.5 block text-slate-500">Queued</span></div><div className="rounded-lg bg-slate-50 p-2"><strong>{session.in_progress_count}</strong><span className="mt-0.5 block text-slate-500">Running</span></div><div className="rounded-lg bg-slate-50 p-2"><strong>{session.awaiting_review_count}</strong><span className="mt-0.5 block text-slate-500">Review</span></div><div className="rounded-lg bg-slate-50 p-2"><strong>{session.completed_count}</strong><span className="mt-0.5 block text-slate-500">Done</span></div></div>
                  <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void openSession(session)} disabled={busy} className={secondaryButton}>Inspect</button>{session.status === "SCHEDULED" && canReconcile ? <button type="button" onClick={() => void startSession(session)} disabled={busy || session.assigned_to_user_id !== viewerId} className={primaryButton}>Start session</button> : null}{["SCHEDULED", "IN_PROGRESS"].includes(session.status) && canWrite ? <button type="button" onClick={() => { setSelectedSessionId(session.id); setCancellationReason(""); setCancelSessionOpen(true); }} className={dangerButton}>Cancel</button> : null}</div>
                </article>)}
                {sessions.length === 0 ? <p className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">No count sessions have been scheduled.</p> : null}
              </div>
              {sessionDetails ? (
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                  <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-bold text-slate-950">Selected session details</h4><span className="font-mono text-[11px] text-slate-500">{String(sessionDetails.id || "").slice(0, 8)}…</span></div>
                  <div className="mt-3 space-y-2">{(Array.isArray(sessionDetails.tasks) ? sessionDetails.tasks as Record<string, unknown>[] : []).map((task) => <div key={String(task.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-2 text-xs"><span className="font-semibold">{String(task.location_code || task.location_id || "Bin")} · {String(task.item_sku || "")}</span><StatusTag value={String(task.status || "UNKNOWN")} /></div>)}</div>
                </div>
              ) : null}
            </section>

            <section className="min-w-0 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-slate-950">Recurring count policies</h3><p className="mt-1 text-xs leading-5 text-slate-500">Calendar-anchored schedules materialize due tasks through an explicit scheduler action.</p></div><div className="flex flex-wrap gap-2">{canWrite ? <><button type="button" onClick={() => setPolicyFormOpen((value) => !value)} className={secondaryButton}>{policyFormOpen ? "Close form" : "+ New policy"}</button><button type="button" onClick={() => void materializeDue()} disabled={busy} className={primaryButton}>Materialize due</button></> : null}</div></div>
              {policyFormOpen ? (
                <form onSubmit={(event) => void createPolicy(event)} className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Inventory item"><select required value={policyForm.item_id} onChange={(event) => setPolicyForm((current) => ({ ...current, item_id: event.target.value }))} className={inputClass}>{activeItems.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></Field>
                    <Field label="Assigned counter"><select required value={policyForm.assigned_to_user_id} onChange={(event) => setPolicyForm((current) => ({ ...current, assigned_to_user_id: event.target.value }))} className={inputClass}><option value="">Choose user</option>{assignableUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email || user.id.slice(0, 8)}</option>)}</select></Field>
                    <Field label="Cadence"><select value={policyForm.cadence_unit} onChange={(event) => setPolicyForm((current) => ({ ...current, cadence_unit: event.target.value }))} className={inputClass}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></Field>
                    <Field label="Interval"><input type="number" min="1" max={policyForm.cadence_unit === "DAILY" ? 365 : policyForm.cadence_unit === "WEEKLY" ? 52 : 24} value={policyForm.cadence_interval} onChange={(event) => setPolicyForm((current) => ({ ...current, cadence_interval: event.target.value }))} className={inputClass} /></Field>
                    <Field label="First run"><input required type="datetime-local" value={policyForm.first_run_at} onChange={(event) => setPolicyForm((current) => ({ ...current, first_run_at: event.target.value }))} className={inputClass} /></Field>
                    <Field label="Priority (lower first)"><input type="number" min="0" max="10000" value={policyForm.priority} onChange={(event) => setPolicyForm((current) => ({ ...current, priority: event.target.value }))} className={inputClass} /></Field>
                  </div>
                  <Field label="Single bin (optional)"><select value={policyForm.location_id} disabled={policyForm.location_ids.length >= 2} onChange={(event) => setPolicyForm((current) => ({ ...current, location_id: event.target.value }))} className={inputClass}><option value="">Aggregate item count</option>{activeBins.map((bin) => <option key={bin.id} value={bin.id}>{bin.location_code}</option>)}</select></Field>
                  <Field label="Or choose 2–50 bins for a recurring multi-bin session">
                    <div className="grid max-h-36 gap-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-2">
                      {activeBins.map((bin) => <label key={bin.id} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={policyForm.location_ids.includes(bin.id)} onChange={(event) => setPolicyForm((current) => ({ ...current, location_id: "", location_ids: event.target.checked ? [...current.location_ids, bin.id] : current.location_ids.filter((id) => id !== bin.id) }))} />{bin.location_code}{bin.name ? " · " + bin.name : ""}</label>)}
                    </div>
                  </Field>
                  <label className="flex items-start gap-2 text-xs text-slate-700"><input type="checkbox" checked={policyForm.blind_count} onChange={(event) => setPolicyForm((current) => ({ ...current, blind_count: event.target.checked }))} className="mt-0.5" /><span><strong>Blind count</strong> — expected stock is withheld from the counter.</span></label>
                  <div className="grid gap-3 sm:grid-cols-2"><Field label="Variance escalation threshold (optional)"><input type="number" step="0.0001" min="0.0001" value={policyForm.variance_escalation_threshold} onChange={(event) => setPolicyForm((current) => ({ ...current, variance_escalation_threshold: event.target.value }))} className={inputClass} /></Field><Field label="Notes"><input value={policyForm.notes} onChange={(event) => setPolicyForm((current) => ({ ...current, notes: event.target.value }))} maxLength={1000} className={inputClass} /></Field></div>
                  <div className="flex justify-end"><button type="submit" disabled={busy || !policyForm.item_id || !policyForm.assigned_to_user_id || (policyForm.location_ids.length === 1)} className={primaryButton}>Create recurring policy</button></div>
                </form>
              ) : null}
              <div className="mt-4 space-y-2">
                {policies.map((policy) => <article key={policy.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold text-slate-900">{items.find((item) => item.id === policy.item_id)?.name || policy.item_id}</p><p className="mt-1 text-xs text-slate-500">{policy.cadence_interval} × {policy.cadence_unit.toLowerCase()} · {policy.location_ids?.length ? policy.location_ids.length + " bins" : policy.location_id ? "Single bin" : "Aggregate item"}</p></div><StatusTag value={policy.status} /></div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs"><div><span className="text-slate-500">Next run</span><p className="mt-1 font-semibold">{new Date(policy.next_run_at).toLocaleString()}</p></div><div><span className="text-slate-500">Last run</span><p className="mt-1 font-semibold">{policy.last_run_at ? new Date(policy.last_run_at).toLocaleString() : "Never"}</p></div></div>
                  {canWrite ? <div className="mt-3 flex flex-wrap gap-2">{policy.status === "ACTIVE" ? <button type="button" onClick={() => void transitionPolicy(policy, "pause")} disabled={busy} className={secondaryButton}>Pause</button> : null}{policy.status === "PAUSED" ? <button type="button" onClick={() => void transitionPolicy(policy, "resume")} disabled={busy} className={primaryButton}>Resume</button> : null}{policy.status !== "RETIRED" ? <button type="button" onClick={() => void transitionPolicy(policy, "retire")} disabled={busy} className={dangerButton}>Retire</button> : null}</div> : null}
                </article>)}
                {policies.length === 0 ? <p className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">No recurring policies configured.</p> : null}
              </div>
              <p className="mt-4 rounded-xl bg-blue-50 p-3 text-xs leading-5 text-blue-900">Materialize due checks the policies now; it does not claim that a background scheduler is running. Blocked policies stay visible for follow-up, and generated tasks/sessions appear in their own registers.</p>
            </section>
          </div>
        ) : null}
      </section>

      {taskFormOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-2 sm:items-center sm:p-6" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="schedule-count-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">New inventory task</p><h2 id="schedule-count-title" className="mt-1 text-xl font-bold text-slate-950">Schedule a cycle count</h2></div><button type="button" onClick={() => setTaskFormOpen(false)} className={secondaryButton}>Close</button></div>
            <form onSubmit={(event) => void createTask(event)} className="mt-5 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Inventory item"><select required value={taskForm.item_id} onChange={(event) => setTaskForm((current) => ({ ...current, item_id: event.target.value }))} className={inputClass}>{activeItems.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></Field>
                <Field label="Location (optional)"><select value={taskForm.location_id} onChange={(event) => setTaskForm((current) => ({ ...current, location_id: event.target.value }))} className={inputClass}><option value="">Aggregate item balance</option>{activeBins.map((bin) => <option key={bin.id} value={bin.id}>{bin.location_code}</option>)}</select></Field>
                <Field label="Assign counter (optional)"><select value={taskForm.assigned_to_user_id} onChange={(event) => setTaskForm((current) => ({ ...current, assigned_to_user_id: event.target.value }))} className={inputClass}><option value="">Unassigned</option>{assignableUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email || user.id.slice(0, 8)}</option>)}</select></Field>
                <Field label="Due at"><input required type="datetime-local" value={taskForm.due_at} onChange={(event) => setTaskForm((current) => ({ ...current, due_at: event.target.value }))} className={inputClass} /></Field>
                <Field label="Priority (lower runs first)"><input type="number" min="0" max="10000" value={taskForm.priority} onChange={(event) => setTaskForm((current) => ({ ...current, priority: event.target.value }))} className={inputClass} /></Field>
                <Field label="Variance escalation threshold (optional)"><input type="number" min="0.0001" step="0.0001" value={taskForm.variance_escalation_threshold} onChange={(event) => setTaskForm((current) => ({ ...current, variance_escalation_threshold: event.target.value }))} className={inputClass} /></Field>
              </div>
              <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" checked={taskForm.blind_count} onChange={(event) => setTaskForm((current) => ({ ...current, blind_count: event.target.checked }))} className="mt-1" /><span><strong>Blind count</strong><span className="mt-0.5 block text-xs text-slate-500">Hide the expected balance from the counter until independent review.</span></span></label>
              <Field label="Task notes"><textarea rows={3} maxLength={1000} value={taskForm.notes} onChange={(event) => setTaskForm((current) => ({ ...current, notes: event.target.value }))} className={inputClass} /></Field>
              <div className="flex justify-end gap-2"><button type="button" onClick={() => setTaskFormOpen(false)} className={secondaryButton}>Cancel</button><button type="submit" disabled={busy || !taskForm.item_id || !taskForm.due_at} className={primaryButton}>Schedule task</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {countFormOpen && selectedTask ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-2 sm:items-center sm:p-6" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="enter-count-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Physical count</p><h2 id="enter-count-title" className="mt-1 text-xl font-bold text-slate-950">Enter counted quantity</h2></div><button type="button" onClick={() => setCountFormOpen(false)} className={secondaryButton}>Close</button></div>
            <p className="mt-2 text-xs text-slate-500">{selectedTask.item_name || selectedTask.item_sku} · {selectedTask.location_code || "Aggregate balance"} · {selectedTask.blind_count ? "Blind count policy" : "Visible count policy"}</p>
            <form onSubmit={(event) => void submitCount(event)} className="mt-5 space-y-3">
              <Field label={"Counted quantity" + (activeItem?.unit ? " (" + activeItem.unit + ")" : "")}><input required type="number" min="0" max="99999999999999" step="0.0001" value={countQuantity} onChange={(event) => setCountQuantity(event.target.value)} className={inputClass} /></Field>
              {selectedTask.location_id ? <Field label="Location variance reason"><select value={countReason} onChange={(event) => setCountReason(event.target.value)} className={inputClass}><option value="DAMAGE">Damage</option><option value="LOSS">Loss</option><option value="FOUND_STOCK">Found stock</option><option value="OTHER">Other</option></select></Field> : null}
              <Field label="Counter notes"><textarea rows={3} maxLength={1000} value={countNotes} onChange={(event) => setCountNotes(event.target.value)} className={inputClass} /></Field>
              <div className="rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-900">The expected quantity is not shown for a blind count. Submission is version-bound; a stock change before review prevents approval from silently overwriting the newer balance.</div>
              <div className="flex justify-end gap-2"><button type="button" onClick={() => setCountFormOpen(false)} className={secondaryButton}>Cancel</button><button type="submit" disabled={busy} className={primaryButton}>Submit for review</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {cancelTaskOpen && selectedTask ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="cancel-task-title" className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h2 id="cancel-task-title" className="text-lg font-bold">Cancel count task</h2>
            <p className="mt-2 text-xs text-slate-500">Cancellation is recorded in the task audit history.</p>
            <form onSubmit={(event) => void cancelTask(event)} className="mt-4 space-y-3"><Field label="Cancellation reason"><textarea required maxLength={1000} value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} rows={3} className={inputClass} /></Field><div className="flex justify-end gap-2"><button type="button" onClick={() => setCancelTaskOpen(false)} className={secondaryButton}>Keep task</button><button type="submit" disabled={busy || !cancellationReason.trim()} className={dangerButton}>Cancel task</button></div></form>
          </section>
        </div>
      ) : null}

      {cancelSessionOpen && selectedSession ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="cancel-session-title" className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h2 id="cancel-session-title" className="text-lg font-bold">Cancel multi-bin session</h2>
            <form onSubmit={(event) => void cancelSession(event)} className="mt-4 space-y-3"><Field label="Cancellation reason"><textarea required maxLength={1000} value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} rows={3} className={inputClass} /></Field><div className="flex justify-end gap-2"><button type="button" onClick={() => setCancelSessionOpen(false)} className={secondaryButton}>Keep session</button><button type="submit" disabled={busy || !cancellationReason.trim()} className={dangerButton}>Cancel session</button></div></form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
