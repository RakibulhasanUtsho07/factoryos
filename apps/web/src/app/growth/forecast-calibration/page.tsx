"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildGrowthCalibrationDecisionPayload,
  buildGrowthCalibrationPolicyPayload,
  buildGrowthForecastEvaluationPayload,
  normalizeGrowthForecastRows,
  summarizeGrowthCalibrationBuckets,
} from "@/lib/growth-forecast-calibration.mjs";
import type {
  GrowthCalibrationPolicy,
  GrowthForecastCalibrationBucket,
  GrowthForecastCalibrationResponse,
  GrowthForecastEvaluation,
  GrowthForecastKpi,
  GrowthForecastOpportunity,
  GrowthForecastOutcome,
} from "@/lib/growth-forecast-calibration.mjs";

type ForecastDraft = {
  model_version: string;
  forecast_origin_at: string;
  forecast_source_ref: string;
  forecast_value: string;
  lower_bound: string;
  upper_bound: string;
  nominal_coverage_pct: string;
};
type PolicyDraft = {
  domain: string;
  model_version: string;
  metric_key: string;
  unit: string;
  max_mean_absolute_error: string;
  max_root_mean_squared_error: string;
  max_absolute_mean_error: string;
  max_mean_symmetric_percentage_error_pct: string;
  max_absolute_calibration_gap_pct_points: string;
  residual_coverage_target_pct: string;
  max_empirical_absolute_residual: string;
  minimum_sample_count: string;
};
type ReviewDecision = "APPROVE" | "REJECT";
type KpiOption = {
  key: string;
  outcome: GrowthForecastOutcome;
  kpi: GrowthForecastKpi;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function localDateTime(value = new Date(Date.now() - 60 * 60_000)) {
  const offset = value.getTimezoneOffset();
  return new Date(value.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function initialForecastDraft(): ForecastDraft {
  return {
    model_version: "",
    forecast_origin_at: localDateTime(),
    forecast_source_ref: "",
    forecast_value: "",
    lower_bound: "",
    upper_bound: "",
    nominal_coverage_pct: "",
  };
}

function initialPolicyDraft(): PolicyDraft {
  return {
    domain: "FINANCE",
    model_version: "",
    metric_key: "",
    unit: "",
    max_mean_absolute_error: "",
    max_root_mean_squared_error: "",
    max_absolute_mean_error: "",
    max_mean_symmetric_percentage_error_pct: "",
    max_absolute_calibration_gap_pct_points: "",
    residual_coverage_target_pct: "",
    max_empirical_absolute_residual: "",
    minimum_sample_count: "10",
  };
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function numeric(value: unknown, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })
    : "—";
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function StatusPill({ value }: { value: string }) {
  const normalized = value.toUpperCase();
  const tone = ["APPROVED", "ASSESSABLE", "WITHIN_APPROVED_ERROR_THRESHOLDS", "WITHIN_APPROVED_RESIDUAL_THRESHOLD", "WITHIN_APPROVED_COVERAGE_THRESHOLD"].includes(normalized)
    ? "bg-emerald-50 text-emerald-800"
    : ["PENDING_REVIEW", "INSUFFICIENT_SAMPLE", "INSUFFICIENT_POLICY_SAMPLE", "NO_APPROVED_POLICY", "DOMAIN_REQUIRED"].includes(normalized)
      ? "bg-amber-50 text-amber-900"
      : ["REJECTED", "EXCEEDS_APPROVED_ERROR_THRESHOLDS", "EXCEEDS_APPROVED_RESIDUAL_THRESHOLD", "EXCEEDS_APPROVED_COVERAGE_THRESHOLD"].includes(normalized)
        ? "bg-rose-50 text-rose-800"
        : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide " + tone}>{normalized.replaceAll("_", " ")}</span>;
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string;
  value: string | number;
  detail: string;
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
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p>
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

export default function GrowthForecastCalibrationPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("growth.read");
  const canWrite = hasPermission("growth.write");
  const canReview = hasPermission("growth.review");
  const currentUserId = snapshot?.user?.id ?? "";

  const [opportunities, setOpportunities] = useState<GrowthForecastOpportunity[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<GrowthForecastOpportunity | null>(null);
  const [calibration, setCalibration] = useState<GrowthForecastCalibrationResponse | null>(null);
  const [policies, setPolicies] = useState<GrowthCalibrationPolicy[]>([]);
  const [domainFilter, setDomainFilter] = useState("ALL");
  const [policyStatusFilter, setPolicyStatusFilter] = useState("ALL");
  const [outcomeKpiChoice, setOutcomeKpiChoice] = useState("");
  const [forecastDraft, setForecastDraft] = useState<ForecastDraft>(initialForecastDraft);
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(initialPolicyDraft);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [lastEvaluation, setLastEvaluation] = useState<GrowthForecastEvaluation | null>(null);
  const [evaluationIdempotencyKey, setEvaluationIdempotencyKey] = useState("");

  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingCalibration, setLoadingCalibration] = useState(false);
  const [loadingPolicies, setLoadingPolicies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [policyFormOpen, setPolicyFormOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadPortfolio = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setOpportunities([]);
      setSelected(null);
      setSelectedId("");
      return;
    }
    setLoadingPortfolio(true);
    setError("");
    try {
      const result = await request("/growth/opportunities?limit=100");
      const next = normalizeGrowthForecastRows<GrowthForecastOpportunity>(result, "opportunities");
      setOpportunities(next);
      setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
    } catch (cause) {
      setError(messageOf(cause));
      setOpportunities([]);
    } finally {
      setLoadingPortfolio(false);
    }
  }, [status, activeFactoryId, canRead, request]);

  const loadPolicies = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setPolicies([]);
      return;
    }
    setLoadingPolicies(true);
    try {
      const result = await request("/growth/calibration-policies?limit=200");
      setPolicies(normalizeGrowthForecastRows<GrowthCalibrationPolicy>(result, "policies"));
    } catch (cause) {
      setError(messageOf(cause));
      setPolicies([]);
    } finally {
      setLoadingPolicies(false);
    }
  }, [status, activeFactoryId, canRead, request]);

  useEffect(() => {
    void loadPortfolio();
  }, [loadPortfolio]);

  useEffect(() => {
    let active = true;
    if (status !== "connected" || !activeFactoryId || !canRead || !selectedId) {
      setSelected(null);
      setLastEvaluation(null);
      setEvaluationIdempotencyKey("");
      return () => { active = false; };
    }
    setLoadingDetail(true);
    setError("");
    void request("/growth/opportunities/" + selectedId)
      .then((result) => {
        if (active) setSelected(result as GrowthForecastOpportunity);
      })
      .catch((cause) => {
        if (active) {
          setSelected(null);
          setError(messageOf(cause));
        }
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => { active = false; };
  }, [status, activeFactoryId, canRead, selectedId, request]);

  useEffect(() => {
    let active = true;
    if (status !== "connected" || !activeFactoryId || !canRead || !selectedId) {
      setCalibration(null);
      return () => { active = false; };
    }
    setLoadingCalibration(true);
    const query = domainFilter === "ALL" ? "" : "?domain=" + encodeURIComponent(domainFilter);
    void request("/growth/opportunities/" + selectedId + "/forecast-evaluations/calibration" + query)
      .then((result) => {
        if (active) setCalibration(result as GrowthForecastCalibrationResponse);
      })
      .catch((cause) => {
        if (active) {
          setCalibration(null);
          setError(messageOf(cause));
        }
      })
      .finally(() => {
        if (active) setLoadingCalibration(false);
      });
    return () => { active = false; };
  }, [status, activeFactoryId, canRead, selectedId, domainFilter, request]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  const kpiOptions = useMemo<KpiOption[]>(() => (selected?.outcomes ?? []).flatMap((outcome) =>
    (outcome.kpi_measurements ?? []).map((kpi) => ({
      key: outcome.id + "::" + kpi.metric_key,
      outcome,
      kpi,
    }))), [selected]);

  const evidenceOptions = useMemo(() => {
    const result: Array<{ value: string; description: string; captured_at: string }> = [];
    const seen = new Set<string>();
    for (const evidence of selected?.evidence ?? []) {
      for (const value of [evidence.reference_ref, evidence.citation_url]) {
        if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
        seen.add(value);
        result.push({
          value,
          description: evidence.description,
          captured_at: evidence.captured_at,
        });
      }
    }
    return result;
  }, [selected]);

  const selectedKpi = kpiOptions.find((item) => item.key === outcomeKpiChoice) ?? kpiOptions[0] ?? null;
  const calibrationRows = calibration?.calibration ?? [];
  const calibrationSummary = useMemo(
    () => summarizeGrowthCalibrationBuckets(calibrationRows),
    [calibrationRows],
  );
  const visiblePolicies = useMemo(
    () => policies.filter((policy) => policyStatusFilter === "ALL" || policy.status === policyStatusFilter),
    [policies, policyStatusFilter],
  );

  useEffect(() => {
    if (kpiOptions.length > 0 && !kpiOptions.some((item) => item.key === outcomeKpiChoice)) {
      setOutcomeKpiChoice(kpiOptions[0].key);
    }
    if (kpiOptions.length === 0) setOutcomeKpiChoice("");
  }, [kpiOptions, outcomeKpiChoice]);

  useEffect(() => {
    if (evidenceOptions.length > 0 && !evidenceOptions.some((item) => item.value === forecastDraft.forecast_source_ref)) {
      setForecastDraft((current) => ({ ...current, forecast_source_ref: evidenceOptions[0].value }));
    }
    if (evidenceOptions.length === 0 && forecastDraft.forecast_source_ref) {
      setForecastDraft((current) => ({ ...current, forecast_source_ref: "" }));
    }
  }, [evidenceOptions, forecastDraft.forecast_source_ref]);

  function updateForecastDraft<K extends keyof ForecastDraft>(key: K, value: ForecastDraft[K]) {
    setEvaluationIdempotencyKey("");
    setForecastDraft((current) => ({ ...current, [key]: value }));
  }

  function updatePolicyDraft<K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) {
    setPolicyDraft((current) => ({ ...current, [key]: value }));
  }

  async function recordForecastEvaluation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || !selected || !selectedKpi) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const idempotencyKey = evaluationIdempotencyKey || window.crypto.randomUUID();
      setEvaluationIdempotencyKey(idempotencyKey);
      const payload = buildGrowthForecastEvaluationPayload({
        ...forecastDraft,
        metric_key: selectedKpi.kpi.metric_key,
        unit: selectedKpi.kpi.unit,
        outcome_id: selectedKpi.outcome.id,
        idempotency_key: idempotencyKey,
      }, {
        outcome: selectedKpi.outcome,
        kpi: selectedKpi.kpi,
        evidence: selected.evidence,
      });
      const result = await request(
        "/growth/opportunities/" + selected.id + "/forecast-evaluations",
        { method: "POST", body: payload },
      ) as GrowthForecastEvaluation;
      setLastEvaluation(result);
      setEvaluationIdempotencyKey("");
      setNotice(result.replayed
        ? "The API returned the original idempotent forecast evaluation. No duplicate evaluation was created."
        : "Forecast evaluation recorded against the selected realized KPI. The API calculated and stored the error metrics.");
      const query = domainFilter === "ALL" ? "" : "?domain=" + encodeURIComponent(domainFilter);
      const refreshed = await request("/growth/opportunities/" + selected.id + "/forecast-evaluations/calibration" + query);
      setCalibration(refreshed as GrowthForecastCalibrationResponse);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthCalibrationPolicyPayload(policyDraft as unknown as Record<string, unknown>);
      const result = await request("/growth/calibration-policies", { method: "POST", body: payload }) as GrowthCalibrationPolicy;
      setPolicyFormOpen(false);
      setPolicyDraft(initialPolicyDraft());
      await loadPolicies();
      setNotice("Calibration policy v" + result.policy_version + " was proposed as PENDING_REVIEW. It is not active until a different reviewer approves it.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decidePolicy(policy: GrowthCalibrationPolicy, decision: ReviewDecision) {
    if (!canReview || policy.status !== "PENDING_REVIEW" || policy.created_by === currentUserId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGrowthCalibrationDecisionPayload({
        decision,
        reason: reviewReasons[policy.id] ?? "",
      });
      await request("/growth/calibration-policies/" + policy.id + "/decision", { method: "POST", body: payload });
      await loadPolicies();
      setNotice("Calibration policy " + decision.toLowerCase() + " decision recorded. Its configuration remains immutable.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refreshAll() {
    setError("");
    await Promise.all([loadPortfolio(), loadPolicies()]);
    if (selectedId) {
      const query = domainFilter === "ALL" ? "" : "?domain=" + encodeURIComponent(domainFilter);
      try {
        const result = await request("/growth/opportunities/" + selectedId + "/forecast-evaluations/calibration" + query);
        setCalibration(result as GrowthForecastCalibrationResponse);
      } catch (cause) {
        setError(messageOf(cause));
      }
    }
  }

  const ready = status === "connected" && Boolean(activeFactoryId);
  const policyCanReview = (policy: GrowthCalibrationPolicy) =>
    canReview && Boolean(currentUserId) && policy.status === "PENDING_REVIEW" && policy.created_by !== currentUserId;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <Link href="/growth" className="text-xs font-semibold text-blue-700 hover:text-blue-900">← Growth Intelligence</Link>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Growth / Model quality</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Forecast Evaluation & Calibration</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Compare historical forecasts with later realized KPIs, inspect held-out error cohorts, and govern immutable calibration thresholds for this active factory.
            </p>
          </div>
          <button type="button" onClick={() => void refreshAll()} disabled={!ready || !canRead || loadingPortfolio || loadingPolicies} className={secondaryButton}>
            Refresh evidence
          </button>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 text-[10px] font-semibold text-slate-600">
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Factory-scoped</span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Out-of-sample only</span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Immutable evaluations</span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Maker-checker policies</span>
        </div>
      </header>

      {!ready ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Connect an authenticated FactoryOS session and select an active factory to load forecast evidence.
        </section>
      ) : null}
      {ready && !canRead ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Your current permission snapshot does not include growth.read. The backend remains the final access-control authority.
        </section>
      ) : null}
      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Forecast cohorts" value={calibrationSummary.cohorts} detail="Model / metric / unit groups" tone="blue" />
        <Metric label="Assessable cohorts" value={calibrationSummary.assessed} detail="Backend sample floor satisfied" tone="emerald" />
        <Metric label="Insufficient sample" value={calibrationSummary.insufficient} detail="No threshold pass claimed" tone="amber" />
        <Metric label="Approved policy cohorts" value={calibrationSummary.approvedPolicy} detail="An approved matching policy is applied" />
        <Metric label="Threshold breaches" value={calibrationSummary.thresholdBreaches} detail="Backend-reported policy breaches" tone={calibrationSummary.thresholdBreaches > 0 ? "rose" : "slate"} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)]">
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">01 / Forecast capture</p>
              <h2 className="mt-1 text-lg font-bold text-slate-950">Record an out-of-sample forecast</h2>
            </div>
            {loadingPortfolio || loadingDetail ? <span className="text-xs text-slate-500">Loading opportunity…</span> : null}
          </div>

          <div className="mt-4 space-y-3">
            <Field label="Growth opportunity">
              <select className={inputClass} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setEvaluationIdempotencyKey(""); setLastEvaluation(null); }} disabled={!canRead || opportunities.length === 0}>
                {opportunities.length === 0 ? <option value="">No opportunities found</option> : null}
                {opportunities.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.status}</option>)}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Realized outcome / KPI">
                <select className={inputClass} value={selectedKpi?.key ?? ""} onChange={(event) => { setOutcomeKpiChoice(event.target.value); setEvaluationIdempotencyKey(""); }} disabled={kpiOptions.length === 0}>
                  {kpiOptions.length === 0 ? <option value="">No realized KPI</option> : null}
                  {kpiOptions.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.kpi.metric_key} · {item.kpi.unit} · outcome {shortId(item.outcome.id)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Forecast source evidence">
                <select className={inputClass} value={forecastDraft.forecast_source_ref} onChange={(event) => updateForecastDraft("forecast_source_ref", event.target.value)} disabled={evidenceOptions.length === 0}>
                  {evidenceOptions.length === 0 ? <option value="">No linked source reference</option> : null}
                  {evidenceOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.description.slice(0, 54)} · captured {dateTime(item.captured_at)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {selectedKpi ? (
              <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-3 text-xs text-blue-950">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold">{selectedKpi.kpi.metric_key} · {selectedKpi.kpi.unit}</span>
                  <span>Outcome {shortId(selectedKpi.outcome.id)}</span>
                </div>
                <p className="mt-1 text-blue-900">Realized value: <strong>{numeric(selectedKpi.kpi.actual_value, 8)} {selectedKpi.kpi.unit}</strong> · observed {dateTime(selectedKpi.outcome.observed_at)}</p>
                <p className="mt-1 text-blue-800">A forecast origin must precede that observation and the selected evidence capture timestamp.</p>
              </div>
            ) : (
              <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">Record a realized opportunity outcome with at least one KPI measurement in Growth Intelligence before evaluating a forecast.</p>
            )}
          </div>

          <form onSubmit={recordForecastEvaluation} className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Model version" hint="Stable model / pipeline identifier; not automatically inferred.">
                <input className={inputClass} value={forecastDraft.model_version} onChange={(event) => updateForecastDraft("model_version", event.target.value)} placeholder="e.g. factoryos.revenue.v1" required maxLength={128} />
              </Field>
              <Field label="Forecast origin" hint="Local browser time; submitted with an explicit UTC offset.">
                <input type="datetime-local" className={inputClass} value={forecastDraft.forecast_origin_at} onChange={(event) => updateForecastDraft("forecast_origin_at", event.target.value)} required />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Forecast value" hint={selectedKpi ? "Unit: " + selectedKpi.kpi.unit : "Select a realized KPI first."}>
                <input type="number" step="any" className={inputClass} value={forecastDraft.forecast_value} onChange={(event) => updateForecastDraft("forecast_value", event.target.value)} required />
              </Field>
              <Field label="Metric / unit">
                <input className={inputClass + " bg-slate-50"} value={selectedKpi ? selectedKpi.kpi.metric_key + " / " + selectedKpi.kpi.unit : "—"} readOnly />
              </Field>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-semibold text-slate-800">Optional prediction range</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field label="Lower bound">
                  <input type="number" step="any" className={inputClass} value={forecastDraft.lower_bound} onChange={(event) => updateForecastDraft("lower_bound", event.target.value)} />
                </Field>
                <Field label="Upper bound">
                  <input type="number" step="any" className={inputClass} value={forecastDraft.upper_bound} onChange={(event) => updateForecastDraft("upper_bound", event.target.value)} />
                </Field>
                <Field label="Nominal coverage (%)" hint="Required only when declaring a nominal interval.">
                  <input type="number" min="1" max="99.99" step="0.01" className={inputClass} value={forecastDraft.nominal_coverage_pct} onChange={(event) => updateForecastDraft("nominal_coverage_pct", event.target.value)} />
                </Field>
              </div>
            </div>
            <button type="submit" disabled={!canWrite || !selected || !selectedKpi || evidenceOptions.length === 0 || busy} className={primaryButton}>
              {busy ? "Saving…" : "Record immutable forecast evaluation"}
            </button>
            {!canWrite ? <p className="text-[11px] text-amber-800">growth.write is required to record an evaluation.</p> : null}
          </form>
        </article>

        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">02 / Evaluation register</p>
              <h2 className="mt-1 text-lg font-bold text-slate-950">Held-out forecast performance</h2>
              <p className="mt-1 text-xs text-slate-500">Aggregates returned by the forecast calibration API for the selected opportunity.</p>
            </div>
            <Field label="Policy domain">
              <select className={inputClass + " min-w-36"} value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)}>
                <option value="ALL">All domains</option>
                {["FINANCE", "PRODUCTION", "QUALITY", "DELIVERY", "COMMERCIAL", "OTHER"].map((domain) => <option key={domain} value={domain}>{domain}</option>)}
              </select>
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-600">
            <span className="rounded-lg bg-slate-100 px-3 py-2">Included: {calibration?.observations_included ?? 0}</span>
            <span className="rounded-lg bg-slate-100 px-3 py-2">Total: {calibration?.total_observations ?? 0}</span>
            <span className="rounded-lg bg-slate-100 px-3 py-2">Approved policies: {calibration?.approved_policy_count ?? 0}</span>
            {calibration?.sample_window_truncated ? <span className="rounded-lg bg-amber-100 px-3 py-2 text-amber-900">Sample window truncated</span> : null}
            {loadingCalibration ? <span className="px-2 py-2">Refreshing calibration…</span> : null}
          </div>
          {calibrationRows.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center">
              <p className="text-sm font-semibold text-slate-800">No forecast evaluations in this cohort yet</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">Record a forecast against a realized KPI to begin the held-out evaluation register. Empty data is not treated as zero error.</p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {calibrationRows.map((bucket) => (
                <CalibrationBucketCard key={bucket.model_version + "::" + bucket.metric_key + "::" + bucket.unit} bucket={bucket} />
              ))}
            </div>
          )}
          {calibration?.interpretation ? (
            <p className="mt-4 rounded-xl bg-slate-50 p-3 text-[11px] leading-5 text-slate-600">{calibration.interpretation}</p>
          ) : null}
          {lastEvaluation ? (
            <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold text-blue-950">Latest recorded evaluation · {shortId(lastEvaluation.id)}</p>
                {lastEvaluation.replayed ? <StatusPill value="IDEMPOTENT_REPLAY" /> : <StatusPill value="RECORDED" />}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><p className="text-[10px] text-blue-800">Forecast</p><p className="text-sm font-bold text-blue-950">{numeric(lastEvaluation.forecast_value, 4)}</p></div>
                <div><p className="text-[10px] text-blue-800">Actual</p><p className="text-sm font-bold text-blue-950">{numeric(lastEvaluation.actual_value, 4)}</p></div>
                <div><p className="text-[10px] text-blue-800">Absolute error</p><p className="text-sm font-bold text-blue-950">{numeric(lastEvaluation.absolute_error, 4)}</p></div>
                <div><p className="text-[10px] text-blue-800">sMAPE</p><p className="text-sm font-bold text-blue-950">{numeric(lastEvaluation.symmetric_percentage_error, 4)}%</p></div>
              </div>
              <p className="mt-2 text-[10px] text-blue-800">Range semantics: {lastEvaluation.interval_semantics.replaceAll("_", " ")}. Stored input hash: {lastEvaluation.input_hash.slice(0, 16)}…</p>
            </div>
          ) : null}
        </article>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">03 / Calibration governance</p>
            <h2 className="mt-1 text-lg font-bold text-slate-950">Calibration policy register</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
              Threshold sets are versioned and immutable. A different reviewer must approve or reject a proposal; only approved policies are applied to matching forecast cohorts.
            </p>
          </div>
          <button type="button" onClick={() => { setPolicyFormOpen((current) => !current); setError(""); }} disabled={!canWrite} className={primaryButton}>
            {policyFormOpen ? "Close policy form" : "Propose calibration policy"}
          </button>
        </div>

        {policyFormOpen ? (
          <form onSubmit={createPolicy} className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-950">New immutable threshold version</h3>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-800">Starts as pending review</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Domain">
                <select className={inputClass} value={policyDraft.domain} onChange={(event) => updatePolicyDraft("domain", event.target.value)}>
                  {["FINANCE", "PRODUCTION", "QUALITY", "DELIVERY", "COMMERCIAL", "OTHER"].map((domain) => <option key={domain} value={domain}>{domain}</option>)}
                </select>
              </Field>
              <Field label="Model version">
                <input className={inputClass} value={policyDraft.model_version} onChange={(event) => updatePolicyDraft("model_version", event.target.value)} required maxLength={128} placeholder="e.g. factoryos.revenue.v1" />
              </Field>
              <Field label="Metric key">
                <input className={inputClass} value={policyDraft.metric_key} onChange={(event) => updatePolicyDraft("metric_key", event.target.value)} required maxLength={100} placeholder="e.g. net_revenue" />
              </Field>
              <Field label="Unit">
                <input className={inputClass} value={policyDraft.unit} onChange={(event) => updatePolicyDraft("unit", event.target.value)} required maxLength={40} placeholder="e.g. BDT" />
              </Field>
              <Field label="Maximum mean absolute error">
                <input type="number" min="0" step="any" className={inputClass} value={policyDraft.max_mean_absolute_error} onChange={(event) => updatePolicyDraft("max_mean_absolute_error", event.target.value)} required />
              </Field>
              <Field label="Maximum RMSE">
                <input type="number" min="0" step="any" className={inputClass} value={policyDraft.max_root_mean_squared_error} onChange={(event) => updatePolicyDraft("max_root_mean_squared_error", event.target.value)} required />
              </Field>
              <Field label="Maximum absolute bias">
                <input type="number" min="0" step="any" className={inputClass} value={policyDraft.max_absolute_mean_error} onChange={(event) => updatePolicyDraft("max_absolute_mean_error", event.target.value)} required />
              </Field>
              <Field label="Maximum mean sMAPE (%)">
                <input type="number" min="0" max="200" step="0.0001" className={inputClass} value={policyDraft.max_mean_symmetric_percentage_error_pct} onChange={(event) => updatePolicyDraft("max_mean_symmetric_percentage_error_pct", event.target.value)} required />
              </Field>
              <Field label="Maximum calibration gap (pp)">
                <input type="number" min="0" max="100" step="0.0001" className={inputClass} value={policyDraft.max_absolute_calibration_gap_pct_points} onChange={(event) => updatePolicyDraft("max_absolute_calibration_gap_pct_points", event.target.value)} required />
              </Field>
              <Field label="Residual coverage target (%)">
                <input type="number" min="50" max="99.99" step="0.01" className={inputClass} value={policyDraft.residual_coverage_target_pct} onChange={(event) => updatePolicyDraft("residual_coverage_target_pct", event.target.value)} required />
              </Field>
              <Field label="Maximum empirical absolute residual">
                <input type="number" min="0" step="any" className={inputClass} value={policyDraft.max_empirical_absolute_residual} onChange={(event) => updatePolicyDraft("max_empirical_absolute_residual", event.target.value)} required />
              </Field>
              <Field label="Minimum held-out sample count" hint="API minimum is 10; choose a domain-appropriate operational floor.">
                <input type="number" min="10" max="1000000" step="1" className={inputClass} value={policyDraft.minimum_sample_count} onChange={(event) => updatePolicyDraft("minimum_sample_count", event.target.value)} required />
              </Field>
            </div>
            <p className="mt-3 rounded-lg bg-white/80 p-3 text-[11px] leading-5 text-slate-600">
              Thresholds are operator-proposed governance criteria, not FactoryOS defaults or statistically inferred guarantees. They are applied only after independent approval and adequate held-out sample size.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="submit" disabled={!canWrite || busy} className={primaryButton}>{busy ? "Submitting…" : "Submit policy for independent review"}</button>
              <button type="button" onClick={() => setPolicyFormOpen(false)} className={secondaryButton}>Cancel</button>
            </div>
          </form>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">{policies.length} policies returned · maximum 200 rows</p>
          <Field label="Policy status">
            <select className={inputClass + " min-w-40"} value={policyStatusFilter} onChange={(event) => setPolicyStatusFilter(event.target.value)}>
              <option value="ALL">All statuses</option>
              <option value="PENDING_REVIEW">Pending review</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </Field>
        </div>
        {loadingPolicies ? <p className="mt-3 text-xs text-slate-500">Loading calibration policies…</p> : null}
        {visiblePolicies.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">No policies match this filter.</div>
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {visiblePolicies.map((policy) => (
              <article key={policy.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-950">{policy.domain} · v{policy.policy_version}</h3>
                    <p className="mt-1 text-xs text-slate-600">{policy.model_version} / {policy.metric_key} / {policy.unit}</p>
                  </div>
                  <StatusPill value={policy.status} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-slate-600 sm:grid-cols-3">
                  <p>Min sample <strong className="text-slate-900">{policy.minimum_sample_count}</strong></p>
                  <p>MAE max <strong className="text-slate-900">{numeric(policy.max_mean_absolute_error)}</strong></p>
                  <p>RMSE max <strong className="text-slate-900">{numeric(policy.max_root_mean_squared_error)}</strong></p>
                  <p>Bias max <strong className="text-slate-900">{numeric(policy.max_absolute_mean_error)}</strong></p>
                  <p>sMAPE max <strong className="text-slate-900">{numeric(policy.max_mean_symmetric_percentage_error_pct)}%</strong></p>
                  <p>Gap max <strong className="text-slate-900">{numeric(policy.max_absolute_calibration_gap_pct_points)} pp</strong></p>
                  <p>Residual target <strong className="text-slate-900">{numeric(policy.residual_coverage_target_pct)}%</strong></p>
                  <p>Residual max <strong className="text-slate-900">{numeric(policy.max_empirical_absolute_residual)}</strong></p>
                  <p>Proposed {dateTime(policy.created_at)}</p>
                </div>
                {policy.status === "PENDING_REVIEW" ? (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    {policy.created_by === currentUserId ? (
                      <p className="text-[11px] text-amber-800">You proposed this policy. Maker-checker rules prevent self-approval or self-rejection.</p>
                    ) : policyCanReview(policy) ? (
                      <div className="space-y-2">
                        <Field label="Independent review reason">
                          <textarea className={inputClass + " min-h-20 py-2"} value={reviewReasons[policy.id] ?? ""} onChange={(event) => setReviewReasons((current) => ({ ...current, [policy.id]: event.target.value }))} minLength={8} maxLength={1000} placeholder="Explain the threshold review and decision…" />
                        </Field>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" disabled={busy || (reviewReasons[policy.id] ?? "").trim().length < 8} onClick={() => void decidePolicy(policy, "APPROVE")} className={primaryButton}>Approve policy</button>
                          <button type="button" disabled={busy || (reviewReasons[policy.id] ?? "").trim().length < 8} onClick={() => void decidePolicy(policy, "REJECT")} className={dangerButton}>Reject policy</button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500">growth.review is required for an independent decision.</p>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
                    {policy.decided_by ? "Reviewed by " + shortId(policy.decided_by) + " · " + dateTime(policy.decided_at) : "No final decision recorded."}
                    {policy.decision_reason ? <p className="mt-1 text-slate-700">“{policy.decision_reason}”</p> : null}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <footer className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-[11px] leading-5 text-slate-600">
        <strong className="text-slate-800">Interpretation boundary:</strong> all reported metrics come from backend-held forecast evaluations matched to later realized KPI measurements. A range without declared nominal coverage is a heuristic range, not a confidence or calibrated prediction interval. Residual thresholds are empirical order statistics from held-out errors; they are not confidence intervals and do not guarantee future coverage under drift or non-exchangeable data. No forecast is generated, no model is refit, and no probability is inferred by this page.
      </footer>
    </main>
  );
}

function CalibrationBucketCard({ bucket }: { bucket: GrowthForecastCalibrationBucket }) {
  return (
    <article className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-950">{bucket.model_version}</h3>
          <p className="mt-1 text-xs text-slate-600">{bucket.metric_key} · {bucket.unit} · {bucket.sample_count} samples</p>
        </div>
        <StatusPill value={bucket.status} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><p className="text-[10px] text-slate-500">Mean error / bias</p><p className="text-sm font-bold text-slate-900">{numeric(bucket.mean_error)}</p></div>
        <div><p className="text-[10px] text-slate-500">MAE</p><p className="text-sm font-bold text-slate-900">{numeric(bucket.mean_absolute_error)}</p></div>
        <div><p className="text-[10px] text-slate-500">RMSE</p><p className="text-sm font-bold text-slate-900">{numeric(bucket.root_mean_squared_error)}</p></div>
        <div><p className="text-[10px] text-slate-500">Mean sMAPE</p><p className="text-sm font-bold text-slate-900">{numeric(bucket.mean_symmetric_percentage_error_pct)}%</p></div>
      </div>
      <div className="mt-4 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Point-error policy assessment</p>
          <div className="mt-1"><StatusPill value={bucket.error_threshold_assessment ?? "NO_APPROVED_POLICY"} /></div>
          {bucket.error_threshold_failures?.length ? <p className="mt-1 text-[10px] text-rose-700">Failures: {bucket.error_threshold_failures.join(", ")}</p> : null}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Interval assessment</p>
          <div className="mt-1"><StatusPill value={bucket.interval_threshold_assessment ?? "NOT_ASSESSED"} /></div>
          <p className="mt-1 text-[10px] text-slate-500">
            {bucket.interval_sample_count} interval samples
            {bucket.empirical_interval_coverage_pct === null ? "" : " · observed coverage " + numeric(bucket.empirical_interval_coverage_pct) + "%"}
            {bucket.calibration_gap_pct_points === null ? "" : " · gap " + numeric(bucket.calibration_gap_pct_points) + " pp"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Empirical residual threshold</p>
          <div className="mt-1"><StatusPill value={bucket.uncertainty_threshold_assessment ?? bucket.empirical_residual_threshold?.status ?? "NO_APPROVED_POLICY"} /></div>
          <p className="mt-1 text-[10px] text-slate-500">
            {bucket.empirical_residual_threshold?.threshold_value === null || bucket.empirical_residual_threshold?.threshold_value === undefined
              ? "No threshold emitted"
              : "Order-statistic threshold: " + numeric(bucket.empirical_residual_threshold.threshold_value, 6)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Applied policy</p>
          {bucket.calibration_policy ? (
            <p className="mt-1 text-xs font-semibold text-slate-900">{bucket.calibration_policy.domain} · v{bucket.calibration_policy.policy_version}</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">No matching approved policy</p>
          )}
          {bucket.calibration_policy ? <p className="mt-1 text-[10px] text-slate-500">Minimum sample: {bucket.calibration_policy.minimum_sample_count}</p> : null}
        </div>
      </div>
      {bucket.empirical_residual_threshold?.interpretation ? <p className="mt-3 text-[10px] leading-4 text-slate-500">{bucket.empirical_residual_threshold.interpretation}</p> : null}
    </article>
  );
}
