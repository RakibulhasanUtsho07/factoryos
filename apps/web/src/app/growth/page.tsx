"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildGrowthAssumptionDecisionPayload,
  buildGrowthAssumptionPayload,
  buildGrowthConstraintPayload,
  buildGrowthEvidenceGapDecisionPayload,
  buildGrowthEvidenceGapPayload,
  buildGrowthExperimentPayload,
  buildGrowthOpportunityDecisionPayload,
  buildGrowthOpportunityPayload,
  buildGrowthOwnerPayload,
  buildGrowthScenarioSetPayload,
  filterGrowthOpportunities,
  growthReadinessSummary,
  normalizeGrowthRows,
  summarizeGrowthOpportunities,
} from "@/lib/growth-intelligence-workbench.mjs";
import type {
  GrowthAssumption,
  GrowthConstraint,
  GrowthDecisionOwner,
  GrowthEvidence,
  GrowthEvidenceGap,
  GrowthExperiment,
  GrowthGovernance,
  GrowthOpportunity,
  GrowthScenario,
  GrowthScenarioComparison,
  GrowthScenarioSet,
} from "@/lib/growth-intelligence-workbench.mjs";

type Tab = "PIPELINE" | "GOVERNANCE" | "SCENARIOS" | "EXPERIMENTS";
type OpportunityDraft = {
  title: string; category: string; opportunity_statement: string; success_hypothesis: string;
  assumptions: string; expected_value_low: string; expected_value_high: string; currency: string;
  uncertainty_pct: string; effort: string; time_to_impact_days: string; implementation_risk: string;
  evidence_type: string; evidence_description: string; reference_ref: string; citation_url: string;
  confidence: string; research_claim_id: string; business_entity_id: string;
};
type OwnerDraft = { role_code: string; owner_user_id: string; rationale: string };
type AssumptionDraft = {
  statement: string; rationale: string; risk_if_false: string; confidence_pct: string;
  validation_method: string; evidence_refs: string; blocks_decision: boolean;
};
type ConstraintDraft = {
  dimension: string; applicability: string; constraint_name: string; limit_operator: string;
  threshold_value: string; observed_value: string; unit: string; source_evidence_ref: string;
  source_as_of: string; rationale: string;
};
type GapDraft = {
  question: string; required_evidence: string; impact: string; due_at: string; blocks_decision: boolean;
};
type ScenarioProfileDraft = {
  price_change_pct: string; volume_change_pct: string; variable_cost_change_pct: string;
  fixed_cost_change_pct: string; investment: string; uncertainty_pct: string;
  include_projected_constraints: boolean; capacity_utilization_pct: string; quality_yield_pct: string;
  cash_after_investment: string; delivery_backlog_days: string;
};
type ScenarioDraft = {
  set_name: string; data_vintage: string; baseline_source_ref: string; currency: string;
  baseline_revenue: string; baseline_variable_cost: string; baseline_fixed_cost: string;
  sensitivity_parameter: string; sensitivity_low: string; sensitivity_high: string; sensitivity_points: string;
  base: ScenarioProfileDraft; upside: ScenarioProfileDraft; downside: ScenarioProfileDraft; stress: ScenarioProfileDraft;
};
type ExperimentDraft = {
  name: string; objective: string; hypothesis: string; leading_indicators: string;
  duration_days: string; baseline_metric_key: string; baseline_value: string; unit: string; stop_conditions: string;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function rows<T>(value: unknown, key: string): T[] {
  return normalizeGrowthRows(value, key) as T[];
}

function money(value: unknown, currency = "") {
  const parsed = Number(value);
  const formatted = Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";
  return currency ? currency + " " + formatted : formatted;
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function localDateTime() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function initialOpportunityDraft(): OpportunityDraft {
  return {
    title: "", category: "REVENUE_GROWTH", opportunity_statement: "", success_hypothesis: "",
    assumptions: "", expected_value_low: "0", expected_value_high: "0", currency: "BDT",
    uncertainty_pct: "20", effort: "MEDIUM", time_to_impact_days: "90", implementation_risk: "MEDIUM",
    evidence_type: "MARKET_SIGNAL", evidence_description: "", reference_ref: "", citation_url: "",
    confidence: "0.5", research_claim_id: "", business_entity_id: "",
  };
}

function initialOwnerDraft(): OwnerDraft {
  return { role_code: "DECISION_OWNER", owner_user_id: "", rationale: "" };
}

function initialAssumptionDraft(): AssumptionDraft {
  return { statement: "", rationale: "", risk_if_false: "MEDIUM", confidence_pct: "50", validation_method: "MEASURE", evidence_refs: "", blocks_decision: true };
}

function initialConstraintDraft(): ConstraintDraft {
  return { dimension: "CAPACITY", applicability: "APPLICABLE", constraint_name: "", limit_operator: "MAX", threshold_value: "", observed_value: "", unit: "%", source_evidence_ref: "", source_as_of: localDateTime() + ":00Z", rationale: "" };
}

function initialGapDraft(): GapDraft {
  return { question: "", required_evidence: "", impact: "MEDIUM", due_at: "", blocks_decision: true };
}

function initialProfile(overrides: Partial<ScenarioProfileDraft> = {}): ScenarioProfileDraft {
  return {
    price_change_pct: "0", volume_change_pct: "0", variable_cost_change_pct: "0",
    fixed_cost_change_pct: "0", investment: "0", uncertainty_pct: "10",
    include_projected_constraints: false, capacity_utilization_pct: "", quality_yield_pct: "",
    cash_after_investment: "", delivery_backlog_days: "",
    ...overrides,
  };
}

function initialScenarioDraft(currency = "BDT"): ScenarioDraft {
  return {
    set_name: "", data_vintage: localDateTime(), baseline_source_ref: "", currency,
    baseline_revenue: "", baseline_variable_cost: "", baseline_fixed_cost: "",
    sensitivity_parameter: "volume_change_pct", sensitivity_low: "-10", sensitivity_high: "10", sensitivity_points: "5",
    base: initialProfile(),
    upside: initialProfile({ price_change_pct: "2", volume_change_pct: "10", investment: "50000", uncertainty_pct: "15" }),
    downside: initialProfile({ price_change_pct: "-2", volume_change_pct: "-5", variable_cost_change_pct: "5", uncertainty_pct: "20" }),
    stress: initialProfile({ price_change_pct: "-5", volume_change_pct: "-15", variable_cost_change_pct: "10", fixed_cost_change_pct: "5", investment: "100000", uncertainty_pct: "30" }),
  };
}

function initialExperimentDraft(): ExperimentDraft {
  return {
    name: "", objective: "", hypothesis: "", leading_indicators: "",
    duration_days: "30", baseline_metric_key: "qualified_leads", baseline_value: "0", unit: "count", stop_conditions: "",
  };
}

function StatusPill({ value }: { value: string }) {
  const status = value.toUpperCase();
  const tone = ["ACCEPTED", "IN_PROGRESS", "REALIZED", "READY", "COMPLETED"].includes(status)
    ? "bg-emerald-50 text-emerald-800"
    : ["PROPOSED", "PLANNED", "BLOCKED"].includes(status)
      ? "bg-amber-50 text-amber-900"
      : ["REJECTED", "CLOSED", "FAILED"].includes(status)
        ? "bg-rose-50 text-rose-800"
        : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide " + tone}>{status.replaceAll("_", " ")}</span>;
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string; value: string | number; detail: string;
  tone?: "slate" | "blue" | "amber" | "emerald" | "rose";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
    rose: "border-rose-100 bg-rose-50/60",
  };
  return (
    <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] text-slate-500">{detail}</p>
    </article>
  );
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

function profileLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function GrowthIntelligenceWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("growth.read");
  const canWrite = hasPermission("growth.write");
  const canReview = hasPermission("growth.review");

  const [tab, setTab] = useState<Tab>("PIPELINE");
  const [opportunities, setOpportunities] = useState<GrowthOpportunity[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<GrowthOpportunity | null>(null);
  const [governance, setGovernance] = useState<GrowthGovernance | null>(null);
  const [comparison, setComparison] = useState<GrowthScenarioComparison | null>(null);
  const [scenarioSets, setScenarioSets] = useState<GrowthScenarioSet[]>([]);
  const [selectedScenarioSet, setSelectedScenarioSet] = useState<Record<string, unknown> | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [categoryFilter, setCategoryFilter] = useState("ALL");

  const [opportunityDraft, setOpportunityDraft] = useState<OpportunityDraft>(initialOpportunityDraft);
  const [ownerDraft, setOwnerDraft] = useState<OwnerDraft>(initialOwnerDraft);
  const [assumptionDraft, setAssumptionDraft] = useState<AssumptionDraft>(initialAssumptionDraft);
  const [constraintDraft, setConstraintDraft] = useState<ConstraintDraft>(initialConstraintDraft);
  const [gapDraft, setGapDraft] = useState<GapDraft>(initialGapDraft);
  const [scenarioDraft, setScenarioDraft] = useState<ScenarioDraft>(initialScenarioDraft);
  const [experimentDraft, setExperimentDraft] = useState<ExperimentDraft>(initialExperimentDraft);

  const [opportunityFormOpen, setOpportunityFormOpen] = useState(false);
  const [governanceForm, setGovernanceForm] = useState<"OWNER" | "ASSUMPTION" | "CONSTRAINT" | "GAP" | null>(null);
  const [decisionDraft, setDecisionDraft] = useState<{ kind: "OPPORTUNITY" | "ASSUMPTION" | "GAP"; id?: string; decision: string; reason: string; evidence_refs: string } | null>(null);
  const [showScenarioForm, setShowScenarioForm] = useState(false);
  const [showExperimentForm, setShowExperimentForm] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visibleOpportunities = useMemo(
    () => filterGrowthOpportunities(opportunities, search, statusFilter, categoryFilter),
    [opportunities, search, statusFilter, categoryFilter],
  );
  const summary = useMemo(() => summarizeGrowthOpportunities(opportunities), [opportunities]);
  const readiness = useMemo(() => growthReadinessSummary(governance), [governance]);
  const evidenceReferences = useMemo(() => {
    const refs = (selected?.evidence ?? []).flatMap((evidence) => [evidence.reference_ref, evidence.citation_url])
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    return [...new Set(refs)];
  }, [selected?.evidence]);

  const loadPortfolio = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setOpportunities([]);
      setSelected(null);
      setSelectedId("");
      return;
    }
    setLoading(true);
    const next = await request("/growth/opportunities?limit=100")
      .then((result) => rows<GrowthOpportunity>(result, "items"))
      .catch((cause) => {
        setError(messageOf(cause));
        return null;
      });
    if (next) {
      setOpportunities(next);
      setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
    }
    setLoading(false);
  }, [status, activeFactoryId, canRead, request]);

  const loadOpportunity = useCallback(async (id: string) => {
    if (!id || !canRead) {
      setSelected(null);
      setGovernance(null);
      setComparison(null);
      setScenarioSets([]);
      setSelectedScenarioSet(null);
      return;
    }
    setLoadingDetail(true);
    setError("");
    const [detailResult, governanceResult, comparisonResult, setsResult] = await Promise.allSettled([
      request("/growth/opportunities/" + id),
      request("/growth/opportunities/" + id + "/governance"),
      request("/growth/opportunities/" + id + "/scenario-comparison"),
      request("/growth/opportunities/" + id + "/scenario-sets"),
    ]);
    if (detailResult.status === "fulfilled") setSelected(detailResult.value as GrowthOpportunity);
    else {
      setSelected(null);
      setError(messageOf(detailResult.reason));
    }
    if (governanceResult.status === "fulfilled") setGovernance(governanceResult.value as GrowthGovernance);
    else setGovernance(null);
    if (comparisonResult.status === "fulfilled") setComparison(comparisonResult.value as GrowthScenarioComparison);
    else setComparison(null);
    if (setsResult.status === "fulfilled") setScenarioSets(rows<GrowthScenarioSet>(setsResult.value, "items"));
    else setScenarioSets([]);
    setLoadingDetail(false);
  }, [canRead, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadPortfolio(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPortfolio]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedId) void loadOpportunity(selectedId);
      else {
        setSelected(null);
        setGovernance(null);
        setComparison(null);
        setScenarioSets([]);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedId, loadOpportunity]);

  useEffect(() => {
    if (selected?.currency) {
      const timer = window.setTimeout(() => {
        setScenarioDraft((current) => ({ ...current, currency: selected.currency }));
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [selected?.currency]);

  function openNewOpportunity() {
    setOpportunityDraft(initialOpportunityDraft());
    setOpportunityFormOpen(true);
    setGovernanceForm(null);
    setDecisionDraft(null);
    setError("");
    setNotice("");
  }

  async function createOpportunity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthOpportunityPayload(opportunityDraft as unknown as Record<string, unknown>);
      const result = await request("/growth/opportunities", { method: "POST", body: payload }) as GrowthOpportunity;
      setOpportunityFormOpen(false);
      setSelectedId(result.id);
      await loadPortfolio();
      setNotice("Growth opportunity proposed with linked evidence. Its governance readiness is intentionally BLOCKED until an independent decision owner, reviewed assumptions, four constraint dimensions and blocking evidence gaps are addressed.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canReview) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthOwnerPayload(ownerDraft as unknown as Record<string, unknown>);
      const result = await request("/growth/opportunities/" + selected.id + "/decision-owners", { method: "POST", body: payload }) as GrowthDecisionOwner;
      setGovernanceForm(null);
      setOwnerDraft(initialOwnerDraft());
      setNotice(result.role_code + " assigned to " + shortId(result.owner_user_id) + ". The API verifies active tenant membership and prevents the opportunity creator from being the decision owner.");
      await loadOpportunity(selected.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createAssumption(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthAssumptionPayload(assumptionDraft as unknown as Record<string, unknown>);
      await request("/growth/opportunities/" + selected.id + "/assumptions", { method: "POST", body: payload });
      setGovernanceForm(null);
      setAssumptionDraft(initialAssumptionDraft());
      setNotice("Assumption added to the immutable governance evidence trail. Blocking assumptions need a reviewer decision and linked evidence.");
      await loadOpportunity(selected.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createConstraint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthConstraintPayload(constraintDraft as unknown as Record<string, unknown>);
      await request("/growth/opportunities/" + selected.id + "/constraints", { method: "POST", body: payload });
      setGovernanceForm(null);
      setConstraintDraft(initialConstraintDraft());
      setNotice("Constraint assessment appended. The latest record for each required dimension is used by the readiness gate.");
      await loadOpportunity(selected.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createEvidenceGap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthEvidenceGapPayload(gapDraft as unknown as Record<string, unknown>);
      await request("/growth/opportunities/" + selected.id + "/evidence-gaps", { method: "POST", body: payload });
      setGovernanceForm(null);
      setGapDraft(initialGapDraft());
      setNotice("Evidence gap recorded. A blocking gap must be resolved with linked evidence or explicitly waived by a reviewer.");
      await loadOpportunity(selected.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function beginOpportunityDecision(decision: "ACCEPT" | "REJECT") {
    setDecisionDraft({ kind: "OPPORTUNITY", decision, reason: "", evidence_refs: "" });
    setError("");
    setNotice("");
  }

  function beginAssumptionDecision(assumption: GrowthAssumption) {
    setDecisionDraft({
      kind: "ASSUMPTION", id: assumption.id,
      decision: "VALIDATED", reason: "", evidence_refs: (assumption.initial_evidence_refs ?? []).join("\n"),
    });
    setError("");
    setNotice("");
  }

  function beginGapDecision(gap: GrowthEvidenceGap) {
    setDecisionDraft({
      kind: "GAP", id: gap.id, decision: "RESOLVED", reason: "", evidence_refs: "",
    });
    setError("");
    setNotice("");
  }

  async function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !decisionDraft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (decisionDraft.kind === "OPPORTUNITY") {
        const payload = buildGrowthOpportunityDecisionPayload(decisionDraft);
        await request("/growth/opportunities/" + selected.id + "/decision", { method: "POST", body: payload });
        setNotice(decisionDraft.decision === "ACCEPT"
          ? "Opportunity accepted by the assigned decision owner. The API checks governance completeness again before committing the decision."
          : "Opportunity rejected by the assigned decision owner with an immutable reasoned event.");
      } else if (decisionDraft.kind === "ASSUMPTION") {
        const payload = buildGrowthAssumptionDecisionPayload(decisionDraft as unknown as Record<string, unknown>);
        await request("/growth/opportunities/" + selected.id + "/assumptions/" + decisionDraft.id + "/decision", { method: "POST", body: payload });
        setNotice("Assumption decision recorded with reviewer, reason and evidence references.");
      } else {
        const payload = buildGrowthEvidenceGapDecisionPayload(decisionDraft as unknown as Record<string, unknown>);
        await request("/growth/opportunities/" + selected.id + "/evidence-gaps/" + decisionDraft.id + "/decision", { method: "POST", body: payload });
        setNotice("Evidence-gap decision recorded in the append-only governance event history.");
      }
      setDecisionDraft(null);
      await loadOpportunity(selected.id);
      await loadPortfolio();
    } catch (cause) {
      setError(messageOf(cause));
      await loadOpportunity(selected.id);
    } finally {
      setBusy(false);
    }
  }

  function updateProfile(profile: "base" | "upside" | "downside" | "stress", field: keyof ScenarioProfileDraft, value: string | boolean) {
    setScenarioDraft((current) => ({
      ...current,
      [profile]: { ...current[profile], [field]: value },
    }));
  }

  async function createScenarioSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthScenarioSetPayload(
        scenarioDraft as unknown as Record<string, unknown>,
        evidenceReferences,
      );
      const result = await request("/growth/opportunities/" + selected.id + "/scenario-sets", { method: "POST", body: payload }) as GrowthScenarioSet;
      setShowScenarioForm(false);
      setScenarioDraft(initialScenarioDraft(selected.currency));
      setNotice(
        "Scenario set v" + result.set_version + " saved with " + result.scenario_count +
        " deterministic scenarios. Standard case readiness: " + (result.decision_ready ? "READY" : "BLOCKED") +
        ". Sensitivity readiness: " + (result.sensitivity_decision_ready ? "READY" : "BLOCKED") +
        ". These outputs are fixed-input sensitivity analysis, not probabilistic forecasts or causal estimates.",
      );
      await loadOpportunity(selected.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openScenarioSet(setId: string) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await request("/growth/opportunities/" + selected.id + "/scenario-sets/" + setId);
      setSelectedScenarioSet(result as Record<string, unknown>);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createExperiment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthExperimentPayload(experimentDraft as unknown as Record<string, unknown>);
      const result = await request("/growth/opportunities/" + selected.id + "/experiments", { method: "POST", body: payload }) as GrowthExperiment;
      setShowExperimentForm(false);
      setExperimentDraft(initialExperimentDraft());
      setNotice("Experiment " + result.name + " planned. It remains PLANNED until a user with growth.review starts it.");
      await loadOpportunity(selected.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startExperiment(experiment: GrowthExperiment) {
    if (!canReview || !selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request("/growth/experiments/" + experiment.id + "/start", { method: "POST", body: {} }) as { status: string };
      setNotice("Experiment started. Its status is now " + result.status + "; record KPI results only after observing the pilot.");
      await loadOpportunity(selected.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const opportunityOwner = governance?.decision_owners.find((owner) =>
    owner.role_code === "DECISION_OWNER" && !owner.active_to,
  ) ?? null;
  const isAssignedDecisionOwner = Boolean(opportunityOwner?.owner_user_id === snapshot?.user.id);
  const opportunityReferences = selected?.evidence ?? [];
  const canDecideOpportunity = Boolean(
    selected?.status === "PROPOSED" && canReview && isAssignedDecisionOwner,
  );
  const currentConstraints = governance?.constraints ?? [];
  const requiredDimensions = ["CAPACITY", "QUALITY", "CASH", "DELIVERY"];
  const missingDimensions = requiredDimensions.filter((dimension) => !currentConstraints.some((item) => item.dimension === dimension));
  const allExperiments = selected?.experiments ?? [];
  const allScenarios = selected?.scenarios ?? [];
  const allOutcomes = selected?.outcomes ?? [];

  if (status !== "connected" || !activeFactoryId) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Growth intelligence</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-950">Opportunity & scenario workbench</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">Connect an authenticated FactoryOS session and select an active factory to manage evidence-backed opportunities, decision governance, scenario plans and experiments.</p>
          <Link href="/session" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white">Open session setup</Link>
        </div>
      </main>
    );
  }

  if (!canRead) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="rounded-3xl border border-amber-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Permission required</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-950">Growth intelligence access is restricted</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">growth.read is required to inspect opportunities and governance. Creating evidence requires growth.write; independent decisions and experiment start require growth.review.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Growth intelligence · governance before forecast</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Opportunity & scenario workbench</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Capture evidence-backed opportunities, assign an independent decision owner, validate assumptions and constraints, then run reproducible financial sensitivity scenarios and controlled experiments.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">Factory {shortId(activeFactoryId)}</span>
          <button type="button" onClick={() => { void loadPortfolio(); if (selectedId) void loadOpportunity(selectedId); }} disabled={loading || busy} className={secondaryButton}>{loading ? "Refreshing…" : "Refresh workbench"}</button>
        </div>
      </header>

      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Opportunities" value={summary.total} detail="Current factory portfolio" />
        <Metric label="Proposed" value={summary.proposed} detail="Awaiting governance decision" tone="amber" />
        <Metric label="Accepted / active" value={summary.accepted + summary.inProgress} detail={summary.accepted + " accepted · " + summary.inProgress + " in progress"} tone="blue" />
        <Metric label="Realized" value={summary.realized} detail="Outcome evidence recorded" tone="emerald" />
        <Metric label="Rejected / closed" value={summary.rejected + summary.closed} detail="Retained decision history" />
      </section>

      <nav aria-label="Growth intelligence sections" className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {([
          ["PIPELINE", "Opportunity pipeline"],
          ["GOVERNANCE", "Governance & evidence"],
          ["SCENARIOS", "Scenario planning"],
          ["EXPERIMENTS", "Experiments & outcomes"],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => setTab(value)} aria-pressed={tab === value}
            className={"min-h-10 rounded-xl px-4 text-xs font-semibold transition " + (tab === value ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>
            {label}
          </button>
        ))}
      </nav>

      <div className="grid gap-5 xl:grid-cols-[minmax(310px,0.78fr)_minmax(0,1.45fr)]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h2 className="text-base font-bold text-slate-950">Opportunity portfolio</h2><p className="mt-1 text-[11px] text-slate-500">Select an item to manage its governance and execution.</p></div>
            {canWrite ? <button type="button" onClick={openNewOpportunity} className={primaryButton}>New opportunity</button> : null}
          </div>
          <div className="mt-4 space-y-2">
            <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search opportunities…" />
            <div className="grid grid-cols-2 gap-2">
              <select className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="ALL">All statuses</option>
                {["PROPOSED", "ACCEPTED", "IN_PROGRESS", "REALIZED", "REJECTED", "CLOSED"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
              </select>
              <select className={inputClass} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option value="ALL">All categories</option>
                {["REVENUE_GROWTH", "MARGIN_EXPANSION", "PRODUCT_MIX", "CUSTOMER_EXPANSION", "MARKET_CHANNEL_EXPANSION", "CAPACITY_UNLOCK", "COST_REDUCTION", "WORKING_CAPITAL", "RISK_REDUCTION", "RESILIENCE", "EXPORT_READINESS"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-4 max-h-[740px] space-y-2 overflow-y-auto">
            {visibleOpportunities.map((item) => (
              <button key={item.id} type="button" onClick={() => { setSelectedId(item.id); setOpportunityFormOpen(false); setDecisionDraft(null); setGovernanceForm(null); setSelectedScenarioSet(null); }}
                className={"w-full rounded-xl border p-3 text-left transition " + (selectedId === item.id ? "border-blue-300 bg-blue-50/70 ring-1 ring-blue-100" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50")}>
                <div className="flex flex-wrap items-start justify-between gap-2"><span className="text-sm font-bold text-slate-950">{item.title}</span><StatusPill value={item.status} /></div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{item.opportunity_statement}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
                  <span>{item.category.replaceAll("_", " ")}</span>
                  <strong className="tabular-nums">{money(item.expected_value_low, item.currency)} – {money(item.expected_value_high, item.currency)}</strong>
                </div>
              </button>
            ))}
            {!visibleOpportunities.length ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">{loading ? "Loading opportunities…" : "No opportunities match these filters."}</div> : null}
          </div>
        </section>

        <section className="min-w-0 space-y-4">
          {opportunityFormOpen ? (
            <section className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">Evidence-backed proposal</p><h2 className="mt-1 text-lg font-bold text-slate-950">Propose a growth opportunity</h2><p className="mt-1 text-xs text-slate-500">One scoped evidence item is mandatory. Initial opportunity assumptions are recorded separately from reviewer-governed assumptions.</p></div>
                <button type="button" onClick={() => setOpportunityFormOpen(false)} className={secondaryButton}>Close</button>
              </div>
              <form onSubmit={createOpportunity} className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Opportunity title"><input required maxLength={300} className={inputClass} value={opportunityDraft.title} onChange={(event) => setOpportunityDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Export channel growth" /></Field>
                  <Field label="Category"><select className={inputClass} value={opportunityDraft.category} onChange={(event) => setOpportunityDraft((current) => ({ ...current, category: event.target.value }))}>{["REVENUE_GROWTH", "MARGIN_EXPANSION", "PRODUCT_MIX", "CUSTOMER_EXPANSION", "MARKET_CHANNEL_EXPANSION", "CAPACITY_UNLOCK", "COST_REDUCTION", "WORKING_CAPITAL", "RISK_REDUCTION", "RESILIENCE", "EXPORT_READINESS"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></Field>
                  <div className="sm:col-span-2"><Field label="Opportunity statement"><textarea required maxLength={8000} rows={3} className={inputClass + " py-2"} value={opportunityDraft.opportunity_statement} onChange={(event) => setOpportunityDraft((current) => ({ ...current, opportunity_statement: event.target.value }))} placeholder="Describe the unmet need, growth lever, customer or factory context…" /></Field></div>
                  <div className="sm:col-span-2"><Field label="Success hypothesis"><textarea required maxLength={4000} rows={2} className={inputClass + " py-2"} value={opportunityDraft.success_hypothesis} onChange={(event) => setOpportunityDraft((current) => ({ ...current, success_hypothesis: event.target.value }))} placeholder="A falsifiable statement about what should change and why…" /></Field></div>
                  <div className="sm:col-span-2"><Field label="Initial assumptions" hint="One assumption per line; at least one is required. Reviewer-governed assumptions are added later in Governance."><textarea required rows={3} className={inputClass + " py-2"} value={opportunityDraft.assumptions} onChange={(event) => setOpportunityDraft((current) => ({ ...current, assumptions: event.target.value }))} placeholder="Buyer demand is sufficient…&#10;Supplier capacity is available…" /></Field></div>
                  <Field label="Expected value — low"><input required inputMode="decimal" className={inputClass} value={opportunityDraft.expected_value_low} onChange={(event) => setOpportunityDraft((current) => ({ ...current, expected_value_low: event.target.value }))} /></Field>
                  <Field label="Expected value — high"><input required inputMode="decimal" className={inputClass} value={opportunityDraft.expected_value_high} onChange={(event) => setOpportunityDraft((current) => ({ ...current, expected_value_high: event.target.value }))} /></Field>
                  <Field label="Currency"><input required maxLength={3} className={inputClass} value={opportunityDraft.currency} onChange={(event) => setOpportunityDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} /></Field>
                  <Field label="Uncertainty %"><input required inputMode="decimal" className={inputClass} value={opportunityDraft.uncertainty_pct} onChange={(event) => setOpportunityDraft((current) => ({ ...current, uncertainty_pct: event.target.value }))} /></Field>
                  <Field label="Effort"><select className={inputClass} value={opportunityDraft.effort} onChange={(event) => setOpportunityDraft((current) => ({ ...current, effort: event.target.value }))}>{["SMALL", "MEDIUM", "LARGE", "UNKNOWN"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                  <Field label="Time to impact (days)"><input required type="number" min={0} max={3650} step={1} className={inputClass} value={opportunityDraft.time_to_impact_days} onChange={(event) => setOpportunityDraft((current) => ({ ...current, time_to_impact_days: event.target.value }))} /></Field>
                  <Field label="Implementation risk"><select className={inputClass} value={opportunityDraft.implementation_risk} onChange={(event) => setOpportunityDraft((current) => ({ ...current, implementation_risk: event.target.value }))}>{["LOW", "MEDIUM", "HIGH", "UNKNOWN"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                </div>
                <div className="rounded-xl border border-slate-200 p-4">
                  <h3 className="text-xs font-bold text-slate-900">Initial evidence provenance</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Evidence type"><select className={inputClass} value={opportunityDraft.evidence_type} onChange={(event) => setOpportunityDraft((current) => ({ ...current, evidence_type: event.target.value }))}>{["MARKET_SIGNAL", "OPERATIONAL_METRIC", "CLIENT_DOCUMENT", "RESEARCH_CLAIM", "CBB_ENTITY"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                    <Field label="Evidence confidence (0–1)"><input required inputMode="decimal" className={inputClass} value={opportunityDraft.confidence} onChange={(event) => setOpportunityDraft((current) => ({ ...current, confidence: event.target.value }))} /></Field>
                    <div className="sm:col-span-2"><Field label="Evidence description"><textarea required maxLength={4000} rows={2} className={inputClass + " py-2"} value={opportunityDraft.evidence_description} onChange={(event) => setOpportunityDraft((current) => ({ ...current, evidence_description: event.target.value }))} placeholder="What is this evidence and what does it support?" /></Field></div>
                    {["MARKET_SIGNAL", "OPERATIONAL_METRIC", "CLIENT_DOCUMENT"].includes(opportunityDraft.evidence_type) ? <Field label="Reference / record ID"><input className={inputClass} value={opportunityDraft.reference_ref} onChange={(event) => setOpportunityDraft((current) => ({ ...current, reference_ref: event.target.value }))} placeholder="evidence:// or report identifier" /></Field> : null}
                    {opportunityDraft.evidence_type === "MARKET_SIGNAL" ? <Field label="Citation URL"><input type="url" className={inputClass} value={opportunityDraft.citation_url} onChange={(event) => setOpportunityDraft((current) => ({ ...current, citation_url: event.target.value }))} placeholder="https://…" /></Field> : null}
                    {opportunityDraft.evidence_type === "RESEARCH_CLAIM" ? <Field label="Approved research claim UUID"><input className={inputClass} value={opportunityDraft.research_claim_id} onChange={(event) => setOpportunityDraft((current) => ({ ...current, research_claim_id: event.target.value }))} /></Field> : null}
                    {opportunityDraft.evidence_type === "CBB_ENTITY" ? <Field label="Verified business-model entity UUID"><input className={inputClass} value={opportunityDraft.business_entity_id} onChange={(event) => setOpportunityDraft((current) => ({ ...current, business_entity_id: event.target.value }))} /></Field> : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-[11px] leading-5 text-slate-500">The API verifies approved research rights or same-factory business node identity where applicable. An unlinked source reference cannot be used as scenario baseline evidence.</p><button type="submit" disabled={busy || !canWrite} className={primaryButton}>{busy ? "Saving…" : "Propose opportunity"}</button></div>
              </form>
            </section>
          ) : null}

          {!opportunityFormOpen && selected ? (
            <>
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">{selected.category.replaceAll("_", " ")}</p><h2 className="mt-1 text-lg font-bold text-slate-950">{selected.title}</h2><p className="mt-1 text-xs leading-5 text-slate-600">{selected.opportunity_statement}</p></div>
                  <StatusPill value={selected.status} />
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-4">
                  <Metric label="Expected value range" value={money(selected.expected_value_low, selected.currency) + " – " + money(selected.expected_value_high, selected.currency)} detail="Proposal estimate · not a realized outcome" />
                  <Metric label="Uncertainty" value={selected.uncertainty_pct + "%"} detail="Declared input, not a confidence interval" />
                  <Metric label="Impact horizon" value={selected.time_to_impact_days + " days"} detail={"Effort " + selected.effort} />
                  <Metric label="Evidence items" value={selected.evidence.length} detail={"Risk " + selected.implementation_risk} tone="blue" />
                </div>
                <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-5">
                  <p className="font-bold text-slate-800">Success hypothesis</p>
                  <p className="mt-1 text-slate-600">{selected.success_hypothesis}</p>
                </div>
                {canDecideOpportunity ? <div className="mt-4 flex flex-wrap items-center gap-2"><span className="text-[11px] text-emerald-800">You are the assigned decision owner.</span><button type="button" onClick={() => beginOpportunityDecision("ACCEPT")} disabled={!readiness.ready} className={primaryButton} title={!readiness.ready ? "Resolve all governance blockers first" : undefined}>Accept opportunity</button><button type="button" onClick={() => beginOpportunityDecision("REJECT")} className={dangerButton}>Reject opportunity</button></div> : selected.status === "PROPOSED" ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-[11px] leading-5 text-amber-900">Only the currently assigned DECISION_OWNER can accept or reject this proposal. The creator cannot be assigned as decision owner. Readiness must be READY before acceptance.</p> : null}
              </section>

              {tab === "PIPELINE" ? (
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-base font-bold text-slate-950">Evidence register & decision context</h2>
                  <p className="mt-1 text-xs text-slate-500">Only references attached to this opportunity may be used for governance decisions and scenario baselines.</p>
                  <div className="mt-4 space-y-2">
                    {opportunityReferences.map((evidence: GrowthEvidence) => <article key={evidence.id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{evidence.evidence_type.replaceAll("_", " ")}</strong><span className="text-[10px] text-slate-500">Confidence {evidence.confidence} · captured {dateTime(evidence.captured_at)}</span></div>
                      <p className="mt-1 text-xs text-slate-700">{evidence.description}</p>
                      {evidence.reference_ref ? <p className="mt-1 break-all text-[10px] text-blue-700">{evidence.reference_ref}</p> : null}
                      {evidence.citation_url ? <a href={evidence.citation_url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-[10px] text-blue-700 underline">{evidence.citation_url}</a> : null}
                    </article>)}
                    {!opportunityReferences.length ? <p className="text-xs text-slate-500">No evidence is attached.</p> : null}
                  </div>
                </section>
              ) : null}

              {tab === "GOVERNANCE" ? (
                <div className="space-y-4">
                  <section className={"rounded-2xl border p-5 shadow-sm " + (readiness.ready ? "border-emerald-200 bg-emerald-50/40" : "border-amber-200 bg-amber-50/30")}>
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Governance readiness</h2><p className="mt-1 text-xs text-slate-600">{governance?.interpretation ?? "Deterministic completeness checklist; not an approval, forecast or causal conclusion."}</p></div><StatusPill value={readiness.ready ? "READY" : "BLOCKED"} /></div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <Metric label="Open blockers" value={readiness.blockerCount} detail="Database readiness checklist" tone={readiness.blockerCount ? "amber" : "emerald"} />
                      <Metric label="Constraint dimensions" value={4 - missingDimensions.length + " / 4"} detail={missingDimensions.length ? "Missing " + missingDimensions.join(", ") : "All required dimensions recorded"} />
                      <Metric label="Independent owner" value={opportunityOwner?.owner_active ? "Assigned" : "Missing"} detail={opportunityOwner ? shortId(opportunityOwner.owner_user_id) : "Assign DECISION_OWNER"} tone={opportunityOwner?.owner_active ? "emerald" : "amber"} />
                    </div>
                    {readiness.missingEvidence.length ? <div className="mt-4 space-y-2"><h3 className="text-xs font-bold text-slate-800">Readiness blockers</h3>{readiness.missingEvidence.map((item, index) => <div key={index} className="rounded-lg border border-amber-200 bg-white/80 p-3"><p className="text-[10px] font-bold uppercase text-amber-800">{item.code.replaceAll("_", " ")}</p><p className="mt-1 text-xs text-slate-700">{item.detail}</p></div>)}</div> : <p className="mt-4 rounded-lg bg-emerald-100 p-3 text-xs text-emerald-900">All deterministic readiness checks are complete. The assigned decision owner must still make the explicit proposal decision.</p>}
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-slate-950">Decision ownership</h2><p className="mt-1 text-[11px] text-slate-500">A named active tenant user who is not the proposal creator must own the decision.</p></div>{canReview ? <button type="button" onClick={() => { setGovernanceForm(governanceForm === "OWNER" ? null : "OWNER"); setOwnerDraft(initialOwnerDraft()); }} className={secondaryButton}>Assign owner</button> : null}</div>
                    <div className="mt-3 space-y-2">{(governance?.decision_owners ?? []).map((owner: GrowthDecisionOwner) => <div key={owner.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-50 p-3 text-xs"><div><strong>{owner.role_code.replaceAll("_", " ")}</strong><p className="mt-1 text-[10px] text-slate-500">User {shortId(owner.owner_user_id)} · {owner.rationale}</p></div><span className="text-[10px] text-slate-500">{owner.active_to ? "Superseded" : owner.owner_active ? "Active" : "Inactive membership"}</span></div>)}</div>
                    {governanceForm === "OWNER" ? <form onSubmit={createOwner} className="mt-4 grid gap-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4 sm:grid-cols-2">
                      <Field label="Governance role"><select className={inputClass} value={ownerDraft.role_code} onChange={(event) => setOwnerDraft((current) => ({ ...current, role_code: event.target.value }))}>{["DECISION_OWNER", "BUSINESS_OWNER", "FINANCE_REVIEWER", "OPERATIONS_REVIEWER", "QUALITY_REVIEWER", "RISK_REVIEWER", "EVIDENCE_OWNER"].map((role) => <option key={role}>{role}</option>)}</select></Field>
                      <Field label="Active tenant user UUID"><input required className={inputClass} value={ownerDraft.owner_user_id} onChange={(event) => setOwnerDraft((current) => ({ ...current, owner_user_id: event.target.value }))} placeholder="Paste user UUID" /></Field>
                      <div className="sm:col-span-2"><Field label="Assignment rationale"><textarea required minLength={10} maxLength={2000} rows={2} className={inputClass + " py-2"} value={ownerDraft.rationale} onChange={(event) => setOwnerDraft((current) => ({ ...current, rationale: event.target.value }))} placeholder="Why this user is accountable for the role…" /></Field></div>
                      <div className="sm:col-span-2 flex flex-wrap gap-2"><button className={primaryButton} disabled={busy || !canReview}>Assign owner</button><button type="button" onClick={() => setGovernanceForm(null)} className={secondaryButton}>Cancel</button></div>
                    </form> : null}
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-slate-950">Assumption register</h2><p className="mt-1 text-[11px] text-slate-500">Blocking assumptions require VALIDATED or WAIVED decisions plus linked evidence.</p></div>{canWrite ? <button type="button" onClick={() => { setGovernanceForm(governanceForm === "ASSUMPTION" ? null : "ASSUMPTION"); setAssumptionDraft(initialAssumptionDraft()); }} className={secondaryButton}>Add assumption</button> : null}</div>
                    <div className="mt-3 space-y-2">{(governance?.assumptions ?? []).map((assumption: GrowthAssumption) => <article key={assumption.id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap justify-between gap-2"><strong className="text-xs text-slate-900">{assumption.statement}</strong><StatusPill value={assumption.latest_decision ?? "UNREVIEWED"} /></div>
                      <p className="mt-1 text-[10px] text-slate-500">Risk if false: {assumption.risk_if_false} · confidence {assumption.confidence_pct}% · {assumption.blocks_decision ? "Blocks decision" : "Non-blocking"}</p>
                      <p className="mt-1 text-xs text-slate-600">{assumption.rationale || assumption.validation_method}</p>
                      {canReview ? <button type="button" onClick={() => beginAssumptionDecision(assumption)} className={secondaryButton + " mt-2"}>Record review decision</button> : null}
                    </article>)}</div>
                    {governanceForm === "ASSUMPTION" ? <form onSubmit={createAssumption} className="mt-4 grid gap-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4 sm:grid-cols-2">
                      <div className="sm:col-span-2"><Field label="Assumption statement"><textarea required minLength={5} maxLength={4000} rows={2} className={inputClass + " py-2"} value={assumptionDraft.statement} onChange={(event) => setAssumptionDraft((current) => ({ ...current, statement: event.target.value }))} /></Field></div>
                      <Field label="Risk if false"><select className={inputClass} value={assumptionDraft.risk_if_false} onChange={(event) => setAssumptionDraft((current) => ({ ...current, risk_if_false: event.target.value }))}>{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                      <Field label="Confidence %"><input inputMode="decimal" className={inputClass} value={assumptionDraft.confidence_pct} onChange={(event) => setAssumptionDraft((current) => ({ ...current, confidence_pct: event.target.value }))} /></Field>
                      <Field label="Validation method"><input required minLength={5} maxLength={2000} className={inputClass} value={assumptionDraft.validation_method} onChange={(event) => setAssumptionDraft((current) => ({ ...current, validation_method: event.target.value }))} /></Field>
                      <Field label="Initial evidence references" hint="One reference per line; each must already be attached to this opportunity."><textarea rows={2} className={inputClass + " py-2"} value={assumptionDraft.evidence_refs} onChange={(event) => setAssumptionDraft((current) => ({ ...current, evidence_refs: event.target.value }))} /></Field>
                      <div className="sm:col-span-2"><Field label="Rationale"><textarea rows={2} maxLength={2000} className={inputClass + " py-2"} value={assumptionDraft.rationale} onChange={(event) => setAssumptionDraft((current) => ({ ...current, rationale: event.target.value }))} /></Field><label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={assumptionDraft.blocks_decision} onChange={(event) => setAssumptionDraft((current) => ({ ...current, blocks_decision: event.target.checked }))} /> Blocks opportunity acceptance</label></div>
                      <div className="sm:col-span-2 flex flex-wrap gap-2"><button className={primaryButton} disabled={busy}>Save assumption</button><button type="button" onClick={() => setGovernanceForm(null)} className={secondaryButton}>Cancel</button></div>
                    </form> : null}
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-slate-950">Constraint assessments</h2><p className="mt-1 text-[11px] text-slate-500">CAPACITY, QUALITY, CASH and DELIVERY are all required. Record sourced limits or a reasoned NOT_APPLICABLE decision.</p></div>{canWrite ? <button type="button" onClick={() => { setGovernanceForm(governanceForm === "CONSTRAINT" ? null : "CONSTRAINT"); setConstraintDraft(initialConstraintDraft()); }} className={secondaryButton}>Assess constraint</button> : null}</div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">{requiredDimensions.map((dimension) => {
                      const item = currentConstraints.find((constraint) => constraint.dimension === dimension);
                      return <div key={dimension} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><strong className="text-xs">{dimension}</strong><StatusPill value={item?.applicability ?? "UNASSESSED"} /></div>{item ? <><p className="mt-1 text-xs text-slate-600">{item.constraint_name}</p><p className="mt-1 text-[10px] text-slate-500">{item.applicability === "APPLICABLE" ? item.observed_value + " " + item.unit + " / " + item.limit_operator + " " + item.threshold_value + " · " + item.source_evidence_ref : item.rationale}</p></> : <p className="mt-1 text-[10px] text-amber-700">Assessment missing</p>}</div>;
                    })}</div>
                    {governanceForm === "CONSTRAINT" ? <form onSubmit={createConstraint} className="mt-4 grid gap-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4 sm:grid-cols-2">
                      <Field label="Dimension"><select className={inputClass} value={constraintDraft.dimension} onChange={(event) => setConstraintDraft((current) => ({ ...current, dimension: event.target.value }))}>{requiredDimensions.map((dimension) => <option key={dimension}>{dimension}</option>)}</select></Field>
                      <Field label="Applicability"><select className={inputClass} value={constraintDraft.applicability} onChange={(event) => setConstraintDraft((current) => ({ ...current, applicability: event.target.value }))}>{["APPLICABLE", "NOT_APPLICABLE", "UNKNOWN"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                      <Field label="Constraint name"><input required maxLength={300} className={inputClass} value={constraintDraft.constraint_name} onChange={(event) => setConstraintDraft((current) => ({ ...current, constraint_name: event.target.value }))} placeholder={constraintDraft.dimension + " limit"} /></Field>
                      {constraintDraft.applicability === "APPLICABLE" ? <>
                        <Field label="Limit operator"><select className={inputClass} value={constraintDraft.limit_operator} onChange={(event) => setConstraintDraft((current) => ({ ...current, limit_operator: event.target.value }))}>{["MAX", "MIN", "EQUALS"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                        <Field label="Threshold"><input required inputMode="decimal" className={inputClass} value={constraintDraft.threshold_value} onChange={(event) => setConstraintDraft((current) => ({ ...current, threshold_value: event.target.value }))} /></Field>
                        <Field label="Observed value"><input required inputMode="decimal" className={inputClass} value={constraintDraft.observed_value} onChange={(event) => setConstraintDraft((current) => ({ ...current, observed_value: event.target.value }))} /></Field>
                        <Field label="Unit"><input required maxLength={60} className={inputClass} value={constraintDraft.unit} onChange={(event) => setConstraintDraft((current) => ({ ...current, unit: event.target.value }))} /></Field>
                        <Field label="Source evidence reference"><select className={inputClass} value={constraintDraft.source_evidence_ref} onChange={(event) => setConstraintDraft((current) => ({ ...current, source_evidence_ref: event.target.value }))}><option value="">Choose linked evidence</option>{evidenceReferences.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
                        <Field label="Source vintage"><input required type="datetime-local" className={inputClass} value={constraintDraft.source_as_of.slice(0, 16)} onChange={(event) => setConstraintDraft((current) => ({ ...current, source_as_of: new Date(event.target.value).toISOString() }))} /></Field>
                      </> : null}
                      <div className="sm:col-span-2"><Field label="Rationale"><textarea required minLength={constraintDraft.applicability === "NOT_APPLICABLE" ? 10 : 5} maxLength={2000} rows={2} className={inputClass + " py-2"} value={constraintDraft.rationale} onChange={(event) => setConstraintDraft((current) => ({ ...current, rationale: event.target.value }))} placeholder="Explain the assessment and its operating evidence…" /></Field></div>
                      <div className="sm:col-span-2 flex flex-wrap gap-2"><button className={primaryButton} disabled={busy}>Record constraint assessment</button><button type="button" onClick={() => setGovernanceForm(null)} className={secondaryButton}>Cancel</button></div>
                    </form> : null}
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-slate-950">Evidence-gap register</h2><p className="mt-1 text-[11px] text-slate-500">Blocking gaps require linked evidence to resolve or an explicit reviewer waiver.</p></div>{canWrite ? <button type="button" onClick={() => { setGovernanceForm(governanceForm === "GAP" ? null : "GAP"); setGapDraft(initialGapDraft()); }} className={secondaryButton}>Add evidence gap</button> : null}</div>
                    <div className="mt-3 space-y-2">{(governance?.evidence_gaps ?? []).map((gap: GrowthEvidenceGap) => <article key={gap.id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap justify-between gap-2"><strong className="text-xs">{gap.question}</strong><StatusPill value={gap.latest_decision} /></div>
                      <p className="mt-1 text-[10px] text-slate-500">Impact {gap.impact} · {gap.blocks_decision ? "Blocks decision" : "Non-blocking"}{gap.due_at ? " · Due " + dateTime(gap.due_at) : ""}</p>
                      <p className="mt-1 text-xs text-slate-600">{gap.required_evidence}</p>
                      {canReview ? <button type="button" onClick={() => beginGapDecision(gap)} className={secondaryButton + " mt-2"}>Record gap decision</button> : null}
                    </article>)}</div>
                    {governanceForm === "GAP" ? <form onSubmit={createEvidenceGap} className="mt-4 grid gap-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4 sm:grid-cols-2">
                      <div className="sm:col-span-2"><Field label="Unanswered question"><textarea required minLength={5} maxLength={4000} rows={2} className={inputClass + " py-2"} value={gapDraft.question} onChange={(event) => setGapDraft((current) => ({ ...current, question: event.target.value }))} /></Field></div>
                      <div className="sm:col-span-2"><Field label="Required evidence"><textarea required minLength={5} maxLength={2000} rows={2} className={inputClass + " py-2"} value={gapDraft.required_evidence} onChange={(event) => setGapDraft((current) => ({ ...current, required_evidence: event.target.value }))} /></Field></div>
                      <Field label="Impact"><select className={inputClass} value={gapDraft.impact} onChange={(event) => setGapDraft((current) => ({ ...current, impact: event.target.value }))}>{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                      <Field label="Due at (optional)"><input type="datetime-local" className={inputClass} value={gapDraft.due_at} onChange={(event) => setGapDraft((current) => ({ ...current, due_at: event.target.value ? new Date(event.target.value).toISOString() : "" }))} /></Field>
                      <div className="sm:col-span-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={gapDraft.blocks_decision} onChange={(event) => setGapDraft((current) => ({ ...current, blocks_decision: event.target.checked }))} /> Blocks proposal acceptance</label></div>
                      <div className="sm:col-span-2 flex flex-wrap gap-2"><button className={primaryButton} disabled={busy}>Add evidence gap</button><button type="button" onClick={() => setGovernanceForm(null)} className={secondaryButton}>Cancel</button></div>
                    </form> : null}
                  </section>
                </div>
              ) : null}

              {tab === "SCENARIOS" ? (
                <div className="space-y-4">
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Deterministic scenario comparison</h2><p className="mt-1 text-xs text-slate-500">Ranking is enabled only when model version, baseline source, data vintage, financial baseline and constraint gates are comparable.</p></div>{selected.status === "ACCEPTED" || selected.status === "IN_PROGRESS" ? canWrite ? <button type="button" onClick={() => { setScenarioDraft(initialScenarioDraft(selected.currency)); setShowScenarioForm(!showScenarioForm); setSelectedScenarioSet(null); }} className={primaryButton}>{showScenarioForm ? "Close planner" : "Run scenario set"}</button> : null : <span className="rounded-lg bg-amber-50 px-3 py-2 text-[10px] text-amber-900">Accept the opportunity before running scenarios</span>}</div>
                    {comparison ? <div className="mt-4 space-y-3">
                      <div className="flex flex-wrap gap-2"><StatusPill value={comparison.comparable ? "COMPARABLE" : "NOT COMPARABLE"} /><StatusPill value={comparison.ranking_enabled ? "RANKING ENABLED" : "RANKING BLOCKED"} /><span className="text-[10px] text-slate-500">Method: {comparison.comparison_method}</span></div>
                      {comparison.comparability_reasons.length || comparison.ranking_blockers.length ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900"><p className="font-bold">Comparison blockers</p><p className="mt-1">{[...comparison.comparability_reasons, ...comparison.ranking_blockers].join(" · ")}</p></div> : <p className="rounded-lg bg-emerald-50 p-3 text-[11px] text-emerald-800">Scenarios share a common model, baseline and data vintage. Rank reflects deterministic net impact only.</p>}
                      <div className="grid gap-2 sm:grid-cols-3 text-[10px] text-slate-500"><div>Model: {comparison.model_versions.join(", ") || "—"}</div><div>Baseline: {comparison.baseline_sources.map((value) => value.slice(0, 30)).join(", ") || "—"}</div><div>Vintages: {comparison.data_vintages.join(", ") || "—"}</div></div>
                      <div className="space-y-2">{comparison.scenarios.map((scenario) => {
                        const impact = scenario.impact as { netImpactPoint?: number | null; lowerBound?: number | null; upperBound?: number | null; investment?: number | null };
                        const gate = scenario.constraintGate as { decisionReady?: boolean; status?: string; violations?: unknown[]; missingConstraints?: unknown[]; missingProjectedMetrics?: unknown[] };
                        return <article key={String(scenario.id)} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold">{String(scenario.scenario_name)} <span className="font-normal text-slate-500">· {String(scenario.scenario_type)}</span></p><p className="mt-1 text-[10px] text-slate-500">{String(scenario.model_version)} · {String(scenario.data_vintage)} · {String(scenario.method)}</p></div><div className="flex items-center gap-2"><StatusPill value={gate?.decisionReady ? "DECISION READY" : gate?.status ?? "REVIEW REQUIRED"} />{scenario.impact_rank ? <strong className="text-xs">#{String(scenario.impact_rank)}</strong> : null}</div></div>
                          <div className="mt-3 grid gap-2 sm:grid-cols-4">
                            <div><p className="text-[10px] text-slate-500">Net impact</p><p className="text-sm font-bold tabular-nums">{money(impact?.netImpactPoint, selected.currency)}</p></div>
                            <div><p className="text-[10px] text-slate-500">Lower bound</p><p className="text-xs font-semibold tabular-nums">{money(impact?.lowerBound, selected.currency)}</p></div>
                            <div><p className="text-[10px] text-slate-500">Upper bound</p><p className="text-xs font-semibold tabular-nums">{money(impact?.upperBound, selected.currency)}</p></div>
                            <div><p className="text-[10px] text-slate-500">Investment</p><p className="text-xs font-semibold tabular-nums">{money(impact?.investment, selected.currency)}</p></div>
                          </div>
                          {!gate?.decisionReady ? <p className="mt-2 text-[10px] text-amber-800">Missing constraints: {gate?.missingConstraints?.length ?? 0} · Missing projected metrics: {gate?.missingProjectedMetrics?.length ?? 0} · Violations: {gate?.violations?.length ?? 0}</p> : null}
                        </article>;
                      })}</div>
                    </div> : <p className="mt-4 rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">No scenarios yet. Run a scenario set to generate the four standard cases and a sensitivity grid.</p>}
                  </section>

                  {showScenarioForm ? <section className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
                    <div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">Scenario model factoryos.growth.financial-sensitivity.v1</p><h2 className="mt-1 text-lg font-bold">Run immutable scenario set</h2><p className="mt-1 text-xs leading-5 text-slate-500">Four standard cases and one-factor sensitivity are persisted atomically with one baseline source, data vintage and SHA-256 input fingerprint.</p></div>
                    <form onSubmit={createScenarioSet} className="mt-4 space-y-4">
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        <Field label="Scenario set name"><input required maxLength={140} className={inputClass} value={scenarioDraft.set_name} onChange={(event) => setScenarioDraft((current) => ({ ...current, set_name: event.target.value }))} placeholder="November planning baseline" /></Field>
                        <Field label="Data vintage (UTC/local timestamp)"><input required type="datetime-local" className={inputClass} value={scenarioDraft.data_vintage} onChange={(event) => setScenarioDraft((current) => ({ ...current, data_vintage: event.target.value }))} /></Field>
                        <Field label="Baseline evidence reference"><select className={inputClass} value={scenarioDraft.baseline_source_ref} onChange={(event) => setScenarioDraft((current) => ({ ...current, baseline_source_ref: event.target.value }))}><option value="">Choose evidence attached above</option>{evidenceReferences.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
                        <Field label="Currency"><input readOnly className={inputClass} value={scenarioDraft.currency} /></Field>
                        <Field label="Baseline revenue"><input required inputMode="decimal" className={inputClass} value={scenarioDraft.baseline_revenue} onChange={(event) => setScenarioDraft((current) => ({ ...current, baseline_revenue: event.target.value }))} /></Field>
                        <Field label="Baseline variable cost"><input required inputMode="decimal" className={inputClass} value={scenarioDraft.baseline_variable_cost} onChange={(event) => setScenarioDraft((current) => ({ ...current, baseline_variable_cost: event.target.value }))} /></Field>
                        <Field label="Baseline fixed cost"><input required inputMode="decimal" className={inputClass} value={scenarioDraft.baseline_fixed_cost} onChange={(event) => setScenarioDraft((current) => ({ ...current, baseline_fixed_cost: event.target.value }))} /></Field>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {(["base", "upside", "downside", "stress"] as const).map((profile) => {
                          const value = scenarioDraft[profile];
                          return <article key={profile} className="rounded-xl border border-slate-200 p-3">
                            <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-bold text-slate-900">{profileLabel(profile)} case</h3><span className="text-[10px] text-slate-500">Financial assumptions</span></div>
                            <div className="mt-3 grid grid-cols-2 gap-2">
                              {([
                                ["price_change_pct", "Price change %"], ["volume_change_pct", "Volume change %"],
                                ["variable_cost_change_pct", "Variable cost %"], ["fixed_cost_change_pct", "Fixed cost %"],
                                ["investment", "Investment"], ["uncertainty_pct", "Uncertainty %"],
                              ] as const).map(([field, label]) => <Field key={field} label={label}><input inputMode="decimal" className={inputClass} value={value[field]} onChange={(event) => updateProfile(profile, field, event.target.value)} /></Field>)}
                            </div>
                            <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-700"><input type="checkbox" checked={value.include_projected_constraints} onChange={(event) => updateProfile(profile, "include_projected_constraints", event.target.checked)} /> Include projected constraint metrics for decision gate</label>
                            {value.include_projected_constraints ? <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3">
                              <Field label="Capacity utilization %"><input required inputMode="decimal" className={inputClass} value={value.capacity_utilization_pct} onChange={(event) => updateProfile(profile, "capacity_utilization_pct", event.target.value)} /></Field>
                              <Field label="Quality yield %"><input required inputMode="decimal" className={inputClass} value={value.quality_yield_pct} onChange={(event) => updateProfile(profile, "quality_yield_pct", event.target.value)} /></Field>
                              <Field label={"Cash after investment (" + scenarioDraft.currency + ")"}><input required inputMode="decimal" className={inputClass} value={value.cash_after_investment} onChange={(event) => updateProfile(profile, "cash_after_investment", event.target.value)} /></Field>
                              <Field label="Delivery backlog days"><input required inputMode="decimal" className={inputClass} value={value.delivery_backlog_days} onChange={(event) => updateProfile(profile, "delivery_backlog_days", event.target.value)} /></Field>
                            </div> : <p className="mt-2 text-[10px] text-amber-700">Without projected constraint metrics this scenario is preserved but will not be decision-ready.</p>}
                          </article>;
                        })}
                      </div>
                      <div className="rounded-xl border border-slate-200 p-4">
                        <h3 className="text-xs font-bold text-slate-900">One-factor sensitivity</h3>
                        <p className="mt-1 text-[11px] text-slate-500">The API creates 2–11 points for one numeric parameter while keeping the other BASE inputs unchanged.</p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-4">
                          <Field label="Parameter"><select className={inputClass} value={scenarioDraft.sensitivity_parameter} onChange={(event) => setScenarioDraft((current) => ({ ...current, sensitivity_parameter: event.target.value }))}>{["price_change_pct", "volume_change_pct", "variable_cost_change_pct", "fixed_cost_change_pct", "investment", "uncertainty_pct"].map((value) => <option key={value}>{value}</option>)}</select></Field>
                          <Field label="Low value"><input required inputMode="decimal" className={inputClass} value={scenarioDraft.sensitivity_low} onChange={(event) => setScenarioDraft((current) => ({ ...current, sensitivity_low: event.target.value }))} /></Field>
                          <Field label="High value"><input required inputMode="decimal" className={inputClass} value={scenarioDraft.sensitivity_high} onChange={(event) => setScenarioDraft((current) => ({ ...current, sensitivity_high: event.target.value }))} /></Field>
                          <Field label="Points (2–11)"><input required type="number" min={2} max={11} step={1} className={inputClass} value={scenarioDraft.sensitivity_points} onChange={(event) => setScenarioDraft((current) => ({ ...current, sensitivity_points: event.target.value }))} /></Field>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-[11px] leading-5 text-slate-500">This is deterministic arithmetic and one-factor sensitivity, not fitted forecasting, Monte Carlo, causal inference or a statistical confidence interval. Every run is a new immutable version.</p><button type="submit" disabled={busy || !canWrite} className={primaryButton}>{busy ? "Calculating…" : "Run and save scenario set"}</button></div>
                    </form>
                  </section> : null}

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-bold text-slate-950">Scenario-set history</h2><p className="mt-1 text-[11px] text-slate-500">Every set version and input hash is retained.</p></div><span className="text-[10px] text-slate-500">{scenarioSets.length} sets</span></div>
                    <div className="mt-3 space-y-2">{scenarioSets.map((set) => <div key={set.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"><div><p className="text-xs font-bold">{set.set_name} · v{set.set_version}</p><p className="mt-1 text-[10px] text-slate-500">{set.scenario_count} / {set.expected_scenario_count} scenarios · {set.model_version} · {set.data_vintage}</p><p className="mt-1 break-all font-mono text-[9px] text-slate-400">SHA-256 {set.input_hash}</p></div><div className="flex items-center gap-2"><StatusPill value={set.decision_ready ? "READY" : "BLOCKED"} /><button type="button" onClick={() => openScenarioSet(set.id)} disabled={busy} className={secondaryButton}>Inspect</button></div></div>)}</div>
                    {selectedScenarioSet ? <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/40 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{String(selectedScenarioSet.set_name)} · version {String(selectedScenarioSet.set_version)}</strong><button type="button" onClick={() => setSelectedScenarioSet(null)} className={secondaryButton}>Close</button></div><p className="mt-1 text-[10px] text-slate-500">Coverage: {JSON.stringify(selectedScenarioSet.scenario_type_coverage)} · decision ready {String(selectedScenarioSet.decision_ready)}</p><div className="mt-3 space-y-2">{(Array.isArray(selectedScenarioSet.scenarios) ? selectedScenarioSet.scenarios : []).map((scenario) => {
                      const item = scenario as GrowthScenario;
                      const impact = item.output_snapshot?.impact as Record<string, unknown> | undefined;
                      return <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3 text-xs"><div className="flex flex-wrap justify-between gap-2"><strong>{item.scenario_name}</strong><StatusPill value={item.decision_ready ? "READY" : "BLOCKED"} /></div><p className="mt-1 text-[10px] text-slate-500">Impact {money(impact?.netImpactPoint, selected.currency)} · lower {money(impact?.lowerBound, selected.currency)} · upper {money(impact?.upperBound, selected.currency)}</p><p className="mt-1 break-all font-mono text-[9px] text-slate-400">{item.input_hash}</p></div>;
                    })}</div></div> : null}
                  </section>
                </div>
              ) : null}

              {tab === "EXPERIMENTS" ? (
                <div className="space-y-4">
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Controlled experiment register</h2><p className="mt-1 text-xs text-slate-500">Plans record objective, hypothesis, leading indicators, baseline and stop conditions before a reviewer starts them.</p></div>{["ACCEPTED", "IN_PROGRESS"].includes(selected.status) && canWrite ? <button type="button" onClick={() => setShowExperimentForm(!showExperimentForm)} className={primaryButton}>{showExperimentForm ? "Close form" : "Plan experiment"}</button> : null}</div>
                    {showExperimentForm ? <form onSubmit={createExperiment} className="mt-4 grid gap-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4 sm:grid-cols-2">
                      <Field label="Experiment name"><input required maxLength={300} className={inputClass} value={experimentDraft.name} onChange={(event) => setExperimentDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
                      <Field label="Duration (days)"><input required type="number" min={1} max={3650} className={inputClass} value={experimentDraft.duration_days} onChange={(event) => setExperimentDraft((current) => ({ ...current, duration_days: event.target.value }))} /></Field>
                      <div className="sm:col-span-2"><Field label="Objective"><textarea required maxLength={4000} rows={2} className={inputClass + " py-2"} value={experimentDraft.objective} onChange={(event) => setExperimentDraft((current) => ({ ...current, objective: event.target.value }))} /></Field></div>
                      <div className="sm:col-span-2"><Field label="Hypothesis"><textarea required maxLength={4000} rows={2} className={inputClass + " py-2"} value={experimentDraft.hypothesis} onChange={(event) => setExperimentDraft((current) => ({ ...current, hypothesis: event.target.value }))} /></Field></div>
                      <Field label="Leading indicators" hint="One per line."><textarea required rows={3} className={inputClass + " py-2"} value={experimentDraft.leading_indicators} onChange={(event) => setExperimentDraft((current) => ({ ...current, leading_indicators: event.target.value }))} /></Field>
                      <Field label="Stop conditions" hint="One per line."><textarea required rows={3} className={inputClass + " py-2"} value={experimentDraft.stop_conditions} onChange={(event) => setExperimentDraft((current) => ({ ...current, stop_conditions: event.target.value }))} /></Field>
                      <Field label="Baseline metric key"><input required className={inputClass} value={experimentDraft.baseline_metric_key} onChange={(event) => setExperimentDraft((current) => ({ ...current, baseline_metric_key: event.target.value }))} /></Field>
                      <Field label="Baseline value"><input required inputMode="decimal" className={inputClass} value={experimentDraft.baseline_value} onChange={(event) => setExperimentDraft((current) => ({ ...current, baseline_value: event.target.value }))} /></Field>
                      <Field label="Measurement unit"><input required maxLength={40} className={inputClass} value={experimentDraft.unit} onChange={(event) => setExperimentDraft((current) => ({ ...current, unit: event.target.value }))} /></Field>
                      <div className="sm:col-span-2 flex flex-wrap gap-2"><button type="submit" disabled={busy} className={primaryButton}>Save experiment plan</button><button type="button" onClick={() => setShowExperimentForm(false)} className={secondaryButton}>Cancel</button></div>
                    </form> : null}
                    <div className="mt-4 space-y-3">{allExperiments.map((experiment: GrowthExperiment) => <article key={experiment.id} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold">{experiment.name}</h3><p className="mt-1 text-[10px] text-slate-500">{experiment.duration_days} days · owner {shortId(experiment.owner_user_id)} · created {dateTime(experiment.created_at)}</p></div><StatusPill value={experiment.status} /></div>
                      <p className="mt-2 text-xs text-slate-600">{experiment.objective}</p><p className="mt-1 text-xs text-slate-500">Hypothesis: {experiment.hypothesis}</p>
                      <div className="mt-2 flex flex-wrap gap-2">{experiment.leading_indicators.map((indicator) => <span key={indicator} className="rounded-full bg-slate-100 px-2 py-1 text-[10px]">{indicator}</span>)}</div>
                      {experiment.status === "PLANNED" && canReview ? <button type="button" onClick={() => startExperiment(experiment)} disabled={busy} className={primaryButton + " mt-3"}>Start experiment</button> : null}
                      {(experiment.results ?? []).map((result) => <div key={result.id} className="mt-3 rounded-lg bg-slate-50 p-3"><div className="flex justify-between gap-2"><strong className="text-xs">Result assessment: {result.assessment}</strong><StatusPill value={result.stop_condition_triggered ? "STOP TRIGGERED" : "RECORDED"} /></div><p className="mt-1 text-[10px] text-slate-500">{dateTime(result.observed_at)} · evidence {result.evidence_refs.join(", ")}</p></div>)}
                    </article>)}
                    {!allExperiments.length ? <p className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">No experiments planned yet.</p> : null}
                    </div>
                  </section>
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h2 className="text-sm font-bold text-slate-950">Recorded opportunity outcomes</h2>
                    <p className="mt-1 text-[11px] text-slate-500">Realized outcomes and KPI measurements remain separate from proposals and scenario sensitivities.</p>
                    <div className="mt-3 space-y-2">{allOutcomes.map((outcome) => <article key={outcome.id} className="rounded-xl border border-slate-200 p-3 text-xs"><div className="flex flex-wrap justify-between gap-2"><strong>{outcome.assessment}</strong><span className="text-[10px] text-slate-500">{dateTime(outcome.observed_at)}</span></div><p className="mt-1 text-[10px] text-slate-500">Evidence: {outcome.evidence_refs.join(", ")}</p>{outcome.kpi_measurements.map((kpi) => <p key={kpi.id} className="mt-2 text-xs">{kpi.metric_key}: {kpi.baseline_value} → {kpi.actual_value} {kpi.unit} · {kpi.direction}</p>)}</article>)}
                      {!allOutcomes.length ? <p className="text-xs text-slate-500">No realized outcome has been recorded.</p> : null}
                    </div>
                  </section>
                </div>
              ) : null}
            </>
          ) : !opportunityFormOpen ? <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center text-sm text-slate-500">{loadingDetail ? "Loading opportunity…" : "Select an opportunity from the portfolio."}</div> : null}
        </section>
      </div>

      {decisionDraft && selected ? (
        <section className="rounded-2xl border border-blue-200 bg-blue-50/40 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-bold text-slate-950">{decisionDraft.kind === "OPPORTUNITY" ? "Opportunity decision" : decisionDraft.kind === "ASSUMPTION" ? "Assumption review" : "Evidence-gap review"}</h2><p className="mt-1 text-[11px] text-slate-600">The decision is recorded with actor and reason. Required evidence references must already belong to this opportunity.</p></div><button type="button" onClick={() => setDecisionDraft(null)} className={secondaryButton}>Close</button></div>
          <form onSubmit={submitDecision} className="mt-3 grid gap-3 sm:grid-cols-3">
            {decisionDraft.kind !== "OPPORTUNITY" ? <Field label="Decision"><select className={inputClass} value={decisionDraft.decision} onChange={(event) => setDecisionDraft((current) => current ? { ...current, decision: event.target.value } : current)}>{(decisionDraft.kind === "ASSUMPTION" ? ["VALIDATED", "REFUTED", "DEFERRED", "NEEDS_EVIDENCE", "WAIVED"] : ["IN_REVIEW", "RESOLVED", "WAIVED", "REOPENED"]).map((value) => <option key={value}>{value}</option>)}</select></Field> : <Field label="Decision"><input readOnly className={inputClass} value={decisionDraft.decision} /></Field>}
            <Field label="Reason"><input required minLength={decisionDraft.kind === "OPPORTUNITY" ? 1 : 10} maxLength={2000} className={inputClass} value={decisionDraft.reason} onChange={(event) => setDecisionDraft((current) => current ? { ...current, reason: event.target.value } : current)} /></Field>
            {decisionDraft.kind !== "OPPORTUNITY" ? <Field label="Evidence references" hint="One per line; use exact linked evidence references."><textarea rows={2} className={inputClass + " py-2"} value={decisionDraft.evidence_refs} onChange={(event) => setDecisionDraft((current) => current ? { ...current, evidence_refs: event.target.value } : current)} /></Field> : null}
            <div className="flex items-end"><button type="submit" disabled={busy || (decisionDraft.kind !== "OPPORTUNITY" && !canReview)} className={primaryButton}>{busy ? "Recording…" : "Record decision"}</button></div>
          </form>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-700 sm:p-5">
        <h2 className="font-bold text-slate-900">Model and governance boundaries</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>All reads and writes use the shared authenticated FactoryOS session and its selected active factory. Tenant, user and factory context are supplied by the API session rather than editable tenant identifiers.</li>
          <li>Opportunity acceptance requires the named active DECISION_OWNER, independent of the creator, and the API's deterministic completeness gate across evidence, blocking assumptions, CAPACITY/QUALITY/CASH/DELIVERY constraints and blocking evidence gaps.</li>
          <li>Governance READY is a completeness checklist, not an approval, forecast, probability or causal conclusion. The assigned decision owner must explicitly accept or reject the proposal.</li>
          <li>Scenario sets use fixed assumptions, a versioned deterministic sensitivity model and immutable input hashes. They are not statistical forecasts, Monte Carlo simulations, calibrated confidence intervals or causal estimates.</li>
          <li>Scenario ranking is withheld when model, baseline source, data vintage, financial baseline or constraint gates are not comparable. The API remains authoritative for readiness.</li>
          <li>Experiments remain PLANNED until a user with growth.review starts them. Actual experiment and outcome records must be supported with observations and linked evidence; proposed values and scenario outputs must never be presented as realized results.</li>
        </ul>
      </section>
    </main>
  );
}
