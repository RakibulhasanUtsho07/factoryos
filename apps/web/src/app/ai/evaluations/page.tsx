"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildAiEvaluationPolicyPayload,
  buildAiForecastReconciliationPayload,
  buildAiObservedEvaluationPayload,
  buildAiOperationalQuery,
  filterAiOperationalSeries,
  normalizeAiOperationalRows,
  summarizeAiOperationalSeries,
} from "@/lib/ai-operational-evaluation.mjs";

type Row = Record<string, unknown>;
type Tab = "PERFORMANCE" | "COMPARE" | "POLICIES" | "LABELS";
type PolicyDraft = {
  policy_key: string; policy_version: string; domain: string; metric_key: string; minimum_samples: string;
  max_mean_absolute_error: string; max_mean_absolute_percentage_error: string;
  min_within_tolerance_rate: string; max_expected_calibration_error: string;
};
type LabelDraft = {
  decision_id: string; domain: string; metric_key: string; model_version: string;
  confidence: string; prediction_correct: string; observed_at: string;
};
type ForecastDraft = {
  source_outcome_id: string; domain: string; metric_key: string; model_version: string;
  confidence: string; tolerance: string;
};

const DOMAINS = ["PLANNING", "QUALITY", "MAINTENANCE", "FINANCE", "ENERGY"];
const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const PANEL = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
function display(value: unknown, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}
function numberValue(value: unknown, digits = 3) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}
function percent(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed * 100).toFixed(1) + "%" : "—";
}
function countValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString() : "—";
}
function dateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
function secureKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure evaluation key generation is unavailable.");
  return "ai-eval:" + globalThis.crypto.randomUUID();
}
function rows(value: unknown, key: string) {
  return normalizeAiOperationalRows(value, key).map(record);
}
function initialPolicy(): PolicyDraft {
  return {
    policy_key: "", policy_version: "v1", domain: "PLANNING", metric_key: "",
    minimum_samples: "100", max_mean_absolute_error: "", max_mean_absolute_percentage_error: "",
    min_within_tolerance_rate: "", max_expected_calibration_error: "0.1",
  };
}
function initialLabel(): LabelDraft {
  return {
    decision_id: "", domain: "PLANNING", metric_key: "", model_version: "",
    confidence: "0.8", prediction_correct: "true", observed_at: "",
  };
}
function initialForecast(): ForecastDraft {
  return {
    source_outcome_id: "", domain: "PLANNING", metric_key: "", model_version: "",
    confidence: "0.8", tolerance: "1",
  };
}
function Status({ value }: { value: unknown }) {
  const state = display(value, "UNKNOWN").toUpperCase();
  const tone = ["MEETS_POLICY", "PASS", "TRUE"].includes(state)
    ? "bg-emerald-50 text-emerald-800"
    : ["INSUFFICIENT_DATA", "UNKNOWN", "INCONCLUSIVE"].includes(state)
      ? "bg-amber-50 text-amber-900"
      : ["DOES_NOT_MEET_POLICY", "FAIL", "FALSE"].includes(state)
        ? "bg-rose-50 text-rose-800"
        : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + tone}>{state.replaceAll("_", " ")}</span>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>{children}{hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}</label>;
}
function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return <article className={PANEL}><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-[10px] text-slate-500">{hint}</p></article>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">{children}</div>;
}

export default function AiOperationalEvaluationPage() {
  const { status: sessionStatus, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("ai.business.read");
  const canWriteOutcomes = hasPermission("ai.outcomes.write");
  const canWritePolicies = hasPermission("ai.evaluation.policies.write");

  const [tab, setTab] = useState<Tab>("PERFORMANCE");
  const [domainFilter, setDomainFilter] = useState("ALL");
  const [metricFilter, setMetricFilter] = useState("");
  const [versionFilter, setVersionFilter] = useState("");
  const [bins, setBins] = useState("10");
  const [accuracy, setAccuracy] = useState<Row | null>(null);
  const [calibration, setCalibration] = useState<Row | null>(null);
  const [policies, setPolicies] = useState<Row[]>([]);
  const [loadedFactory, setLoadedFactory] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [comparisonForm, setComparisonForm] = useState({
    domain: "PLANNING", metric_key: "", baseline_model_version: "", candidate_model_version: "", policy_key: "",
  });
  const [comparison, setComparison] = useState<Row | null>(null);
  const [comparisonFactoryId, setComparisonFactoryId] = useState("");
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(initialPolicy());
  const [policyOpen, setPolicyOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState<LabelDraft>(initialLabel());
  const [forecastDraft, setForecastDraft] = useState<ForecastDraft>(initialForecast());

  const loaded = sessionStatus === "connected" && Boolean(activeFactoryId) && loadedFactory === activeFactoryId;
  const accuracyRows = useMemo(() => loaded ? rows(accuracy, "series") : [], [accuracy, loaded]);
  const visibleSeries = useMemo(
    () => filterAiOperationalSeries(accuracyRows, { domain: domainFilter, metric_key: metricFilter, model_version: versionFilter }) as Row[],
    [accuracyRows, domainFilter, metricFilter, versionFilter],
  );
  const calibrationRows = loaded ? rows(calibration, "series") : [];
  const summary = summarizeAiOperationalSeries(loaded ? accuracy : null, loaded ? calibration : null, loaded ? policies : []);

  const load = useCallback(async () => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true); setError(""); setLoadedFactory("");
    setAccuracy(null); setCalibration(null); setPolicies([]);
    const filters = { domain: domainFilter, metric_key: metricFilter, model_version: versionFilter };
    const [accuracyResult, calibrationResult, policiesResult] = await Promise.allSettled([
      request("/v2/ai/operational-evaluations/forecast-accuracy" + buildAiOperationalQuery(filters, "accuracy")),
      request("/v2/ai/operational-evaluations/calibration" + buildAiOperationalQuery({ ...filters, bins }, "calibration")),
      request("/v2/ai/operational-evaluations/policies" + buildAiOperationalQuery({ domain: domainFilter, metric_key: metricFilter }, "policies")),
    ]);
    const failures: string[] = [];
    if (accuracyResult.status === "fulfilled") setAccuracy(record(accuracyResult.value));
    else failures.push("Forecast accuracy: " + messageOf(accuracyResult.reason));
    if (calibrationResult.status === "fulfilled") setCalibration(record(calibrationResult.value));
    else failures.push("Calibration: " + messageOf(calibrationResult.reason));
    if (policiesResult.status === "fulfilled") setPolicies(rows(policiesResult.value, "policies"));
    else failures.push("Evaluation policies: " + messageOf(policiesResult.reason));
    setLoadedFactory(activeFactoryId);
    if (failures.length) setError(failures.join(" · "));
    setLoading(false);
  }, [sessionStatus, activeFactoryId, canRead, request, domainFilter, metricFilter, versionFilter, bins]);

  useEffect(() => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, activeFactoryId, canRead, load]);

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await action();
      await load();
      setNotice(success);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally { setBusy(false); }
  }

  async function runComparison(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let query: string;
    try { query = buildAiOperationalQuery(comparisonForm, "comparison"); }
    catch (cause) { setError(messageOf(cause)); return; }
    setBusy(true); setError(""); setNotice(""); setComparison(null);
    try {
      const result = await request("/v2/ai/operational-evaluations/model-comparison" + query);
      setComparison(record(result));
      setComparisonFactoryId(activeFactoryId);
      setNotice("Model comparison loaded for the last 90 days. Policy result is evidence only, not a deployment authorization.");
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function createPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildAiEvaluationPolicyPayload(policyDraft) as Row; }
    catch (cause) { setError(messageOf(cause)); return; }
    const saved = await perform(
      () => request("/v2/ai/operational-evaluations/policies", { method: "POST", body }),
      "Immutable evaluation policy version created. Existing versions are preserved.",
    );
    if (saved) { setPolicyOpen(false); setPolicyDraft(initialPolicy()); }
  }

  async function recordLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    let evaluationKey: string;
    try {
      evaluationKey = secureKey();
      body = buildAiObservedEvaluationPayload({
        ...labelDraft,
        evaluation_key: evaluationKey,
        prediction_correct: labelDraft.prediction_correct === "true",
      }) as Row;
    } catch (cause) { setError(messageOf(cause)); return; }
    const saved = await perform(
      () => request("/v2/ai/operational-evaluations", { method: "POST", body }),
      "Observed classification evaluation recorded. The decision model version is checked by the API.",
    );
    if (saved) setLabelDraft(initialLabel());
  }

  async function reconcileForecast(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try {
      body = buildAiForecastReconciliationPayload({
        ...forecastDraft,
        evaluation_key: secureKey(),
      }) as Row;
    } catch (cause) { setError(messageOf(cause)); return; }
    const saved = await perform(
      () => request("/v2/ai/operational-evaluations/reconcile-forecast", { method: "POST", body }),
      "Forecast outcome reconciled. Predicted and actual metric values were read from the source outcome by the API.",
    );
    if (saved) setForecastDraft(initialForecast());
  }

  const hasSession = sessionStatus === "connected" && Boolean(activeFactoryId);
  const currentComparison = comparisonFactoryId === activeFactoryId ? comparison : null;
  const policyResult = record(currentComparison?.policyEvaluation);
  const baseline = record(currentComparison?.baseline);
  const candidate = record(currentComparison?.candidate);
  const delta = record(currentComparison?.delta);
  const checks = record(policyResult.checks);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-5 text-white shadow-sm sm:p-7">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">Factory-scoped AI observability</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Operational AI Model Evaluation</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">Measure confidence calibration and 90-day forecast accuracy, compare candidate model versions against immutable evaluation policies, and record observed outcomes for operational feedback.</p>
        <div className="mt-4 flex flex-wrap gap-2 text-[10px] text-slate-300"><span className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 text-cyan-100">90-day evidence window</span><span className="rounded-full border border-white/15 px-2.5 py-1">Authenticated factory scope</span><span className="rounded-full border border-white/15 px-2.5 py-1">Evaluation is not auto-promotion</span></div>
      </section>

      {!hasSession ? <section className={PANEL}><h2 className="text-sm font-bold text-slate-950">Connect a FactoryOS session</h2><p className="mt-1 text-xs text-slate-500">Select an active factory in the workspace header to load AI model metrics.</p><a href="/session" className="mt-4 inline-flex min-h-9 items-center rounded-lg bg-slate-950 px-3 text-xs font-semibold text-white">Open session setup</a></section> : null}
      {hasSession && !canRead ? <section className={PANEL}><h2 className="text-sm font-bold text-slate-950">Missing AI evaluation read permission</h2><p className="mt-1 text-xs text-slate-500">This page requires ai.business.read for factory-scoped model accuracy, calibration and evaluation policy reads.</p></section> : null}
      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">{notice}</div> : null}

      {hasSession && canRead ? (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Evaluation samples" value={summary.totalSamples.toLocaleString()} hint="Last 90 days · loaded factory" />
            <Metric label="Metric series" value={summary.seriesCount} hint="Domain / metric / model groups" />
            <Metric label="Within tolerance" value={summary.meanWithinTolerance === null ? "—" : percent(summary.meanWithinTolerance)} hint="Mean across loaded series" />
            <Metric label="Active policy versions" value={summary.policyCount} hint="Latest version per policy key" />
          </section>

          <section className={PANEL}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div><h2 className="text-sm font-bold text-slate-950">Evidence filters</h2><p className="mt-1 text-[10px] text-slate-500">Filters apply to accuracy, calibration and policy summaries.</p></div>
              <button type="button" className={SECONDARY} disabled={loading || busy} onClick={() => void load()}>Refresh metrics</button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Operational domain"><select className={INPUT} value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)}><option value="ALL">All domains</option>{DOMAINS.map((domain) => <option key={domain} value={domain}>{domain}</option>)}</select></Field>
              <Field label="Metric key"><input className={INPUT} value={metricFilter} onChange={(event) => setMetricFilter(event.target.value)} placeholder="e.g. defect_risk" maxLength={100} /></Field>
              <Field label="Model version"><input className={INPUT} value={versionFilter} onChange={(event) => setVersionFilter(event.target.value)} placeholder="e.g. v2.4.1" maxLength={100} /></Field>
              <Field label="Calibration bins"><select className={INPUT} value={bins} onChange={(event) => setBins(event.target.value)}>{[5, 8, 10, 12, 15, 20].map((value) => <option key={value} value={value}>{value} bins</option>)}</select></Field>
            </div>
          </section>

          <nav aria-label="Operational AI evaluation sections" className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            {([
              ["PERFORMANCE", "Performance"],
              ["COMPARE", "Model comparison"],
              ["POLICIES", "Evaluation policies"],
              ["LABELS", "Outcome recording"],
            ] as [Tab, string][]).map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)} className={"min-h-9 rounded-lg px-3 text-xs font-semibold " + (tab === id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{label}</button>)}
          </nav>

          {tab === "PERFORMANCE" ? (
            <section className="grid gap-4">
              <div className={PANEL}>
                <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Forecast accuracy by model</h2><p className="mt-1 text-xs text-slate-500">Only observed outcomes with numeric predicted/actual values are included in forecast accuracy.</p></div><span className="text-[10px] text-slate-500">Window {display(accuracy?.windowDays, "90")} days · {summary.totalSamples} samples</span></div>
                {loading ? <p className="py-8 text-center text-xs text-slate-500">Loading model evidence…</p> : null}
                {!loading && !visibleSeries.length ? <div className="mt-4"><Empty>No accuracy samples match these filters. Forecast scoring begins when an observed AI outcome is reconciled.</Empty></div> : null}
                {visibleSeries.length ? (
                  <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[820px] text-left text-xs">
                    <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500"><th className="px-2 py-2">Domain / metric</th><th className="px-2 py-2">Model version</th><th className="px-2 py-2 text-right">Samples</th><th className="px-2 py-2 text-right">MAE</th><th className="px-2 py-2 text-right">MAPE</th><th className="px-2 py-2 text-right">Signed error</th><th className="px-2 py-2 text-right">Within tolerance</th></tr></thead>
                    <tbody>{visibleSeries.map((item, index) => <tr key={String(item.domain) + ":" + String(item.metricKey) + ":" + String(item.modelVersion) + ":" + index} className="border-b border-slate-100"><td className="px-2 py-3"><p className="font-semibold text-slate-900">{display(item.domain)}</p><p className="mt-1 text-[10px] text-slate-500">{display(item.metricKey)}</p></td><td className="px-2 py-3 font-mono text-slate-700">{display(item.modelVersion)}</td><td className="px-2 py-3 text-right tabular-nums">{Number(item.sampleCount ?? 0).toLocaleString()}</td><td className="px-2 py-3 text-right tabular-nums">{numberValue(item.meanAbsoluteError)}</td><td className="px-2 py-3 text-right tabular-nums">{item.meanAbsolutePercentageError === null ? "—" : percent(item.meanAbsolutePercentageError)}</td><td className="px-2 py-3 text-right tabular-nums">{numberValue(item.meanSignedError)}</td><td className="px-2 py-3 text-right font-semibold tabular-nums">{percent(item.withinToleranceRate)}</td></tr>)}</tbody>
                  </table></div>
                ) : null}
              </div>

              <div className={PANEL}>
                <div><h2 className="text-base font-bold text-slate-950">Confidence calibration</h2><p className="mt-1 text-xs text-slate-500">Mean confidence vs observed accuracy, Brier score and expected calibration error by confidence bin.</p></div>
                {!calibrationRows.length ? <div className="mt-4"><Empty>No confidence-label samples are available for calibration yet.</Empty></div> : (
                  <div className="mt-4 grid gap-4">
                    {calibrationRows.map((item, index) => {
                      const binRows = Array.isArray(item.bins) ? item.bins as Row[] : [];
                      return <article key={String(item.domain) + ":" + String(item.metricKey) + ":" + String(item.modelVersion) + ":" + index} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold text-slate-900">{display(item.domain)} · {display(item.metricKey)}</p><p className="mt-1 text-[10px] text-slate-500">Model {display(item.modelVersion)} · {countValue(item.sampleCount)} labelled predictions</p></div><div className="flex flex-wrap gap-2 text-[10px]"><span className="rounded-md bg-slate-100 px-2 py-1">ECE {numberValue(item.expectedCalibrationError, 4)}</span><span className="rounded-md bg-slate-100 px-2 py-1">Brier {numberValue(item.brierScore, 4)}</span><span className="rounded-md bg-slate-100 px-2 py-1">Confidence {percent(item.meanConfidence)}</span></div></div>
                        <div className="mt-4 space-y-2">{binRows.map((bin, binIndex) => <div key={String(bin.index ?? binIndex)} className="grid grid-cols-[64px_minmax(0,1fr)_60px] items-center gap-2 text-[10px]"><span className="text-slate-500">{numberValue(bin.lowerBound, 1)}–{numberValue(bin.upperBound, 1)}</span><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-cyan-700" style={{ width: Math.max(0, Math.min(100, Number(bin.observedAccuracy ?? 0) * 100)) + "%" }} /></div><span className="text-right tabular-nums text-slate-600">{percent(bin.observedAccuracy)}</span></div>)}</div>
                        <p className="mt-3 text-[10px] text-slate-500">Each bar is observed accuracy in that confidence bin. ECE is lower when confidence aligns more closely with observed correctness.</p>
                      </article>;
                    })}
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {tab === "COMPARE" ? (
            <section className="grid gap-4">
              <div className={PANEL}>
                <h2 className="text-base font-bold text-slate-950">Compare candidate and baseline models</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">Descriptive comparison uses up to 90 days of forecast evaluations. Select an immutable policy key to add policy threshold checks; insufficient samples remain INSUFFICIENT_DATA, not a pass.</p>
                <form onSubmit={runComparison} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Domain"><select className={INPUT} value={comparisonForm.domain} onChange={(event) => setComparisonForm({ ...comparisonForm, domain: event.target.value })}>{DOMAINS.map((domain) => <option key={domain}>{domain}</option>)}</select></Field>
                  <Field label="Metric key"><input className={INPUT} required maxLength={100} value={comparisonForm.metric_key} onChange={(event) => setComparisonForm({ ...comparisonForm, metric_key: event.target.value })} placeholder="demand_units" /></Field>
                  <Field label="Baseline model version"><input className={INPUT} required maxLength={100} value={comparisonForm.baseline_model_version} onChange={(event) => setComparisonForm({ ...comparisonForm, baseline_model_version: event.target.value })} placeholder="v1.8.0" /></Field>
                  <Field label="Candidate model version"><input className={INPUT} required maxLength={100} value={comparisonForm.candidate_model_version} onChange={(event) => setComparisonForm({ ...comparisonForm, candidate_model_version: event.target.value })} placeholder="v2.0.0" /></Field>
                  <Field label="Policy key (optional)" hint="Leave blank for descriptive-only comparison."><select className={INPUT} value={comparisonForm.policy_key} onChange={(event) => setComparisonForm({ ...comparisonForm, policy_key: event.target.value })}><option value="">No policy · descriptive only</option>{policies.filter((policy) => policy.domain === comparisonForm.domain && policy.metricKey === comparisonForm.metric_key).map((policy) => <option key={String(policy.id)} value={String(policy.policyKey)}>{String(policy.policyKey)} · {String(policy.policyVersion)}</option>)}</select></Field>
                  <div className="flex items-end"><button type="submit" className={PRIMARY} disabled={busy}>Run comparison</button></div>
                </form>
              </div>
              {currentComparison ? (
                <div className={PANEL}>
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold text-slate-950">90-day comparison result</h3><p className="mt-1 text-[10px] text-slate-500">{display(currentComparison.domain)} · {display(currentComparison.metricKey)}</p></div><Status value={currentComparison.comparisonMode} /></div>
                  {!currentComparison.comparable ? <div className="mt-4"><Empty>Both model versions need eligible forecast evaluation samples before they can be compared.</Empty></div> : (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      {[{ title: "Baseline", model: baseline }, { title: "Candidate", model: candidate }].map(({ title, model }) => <article key={title} className="rounded-xl border border-slate-200 p-3"><p className="text-xs font-bold text-slate-900">{title} · {display(model.modelVersion)}</p><div className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><p className="text-[10px] text-slate-500">Samples</p><p className="mt-1 font-bold">{countValue(model.sampleCount)}</p></div><div><p className="text-[10px] text-slate-500">MAE</p><p className="mt-1 font-bold">{numberValue(model.meanAbsoluteError)}</p></div><div><p className="text-[10px] text-slate-500">MAPE</p><p className="mt-1 font-bold">{model.meanAbsolutePercentageError === null ? "—" : percent(model.meanAbsolutePercentageError)}</p></div><div><p className="text-[10px] text-slate-500">Within tolerance</p><p className="mt-1 font-bold">{percent(model.withinToleranceRate)}</p></div></div></article>)}
                    </div>
                  )}
                  {currentComparison.comparable ? <div className="mt-4 rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-900">Candidate minus baseline</p><div className="mt-2 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4"><div><p className="text-[10px] text-slate-500">MAE Δ</p><p className="mt-1 font-semibold">{numberValue(delta.meanAbsoluteError)}</p></div><div><p className="text-[10px] text-slate-500">MAPE Δ</p><p className="mt-1 font-semibold">{delta.meanAbsolutePercentageError === null ? "—" : percent(delta.meanAbsolutePercentageError)}</p></div><div><p className="text-[10px] text-slate-500">Signed error Δ</p><p className="mt-1 font-semibold">{numberValue(delta.meanSignedError)}</p></div><div><p className="text-[10px] text-slate-500">Within tolerance Δ</p><p className="mt-1 font-semibold">{percent(delta.withinToleranceRate)}</p></div></div></div> : null}
                  {comparison.policyEvaluation ? <div className="mt-4 rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold text-slate-900">Policy evaluation · {display(policyResult.policyKey)} {display(policyResult.policyVersion)}</p><p className="mt-1 text-[10px] text-slate-500">Minimum samples per evaluated model: {countValue(policyResult.minimumSamples)}</p></div><Status value={policyResult.status} /></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(checks).map(([key, value]) => <div key={key} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-2 text-xs"><span className="text-slate-700">{key.replaceAll(/([A-Z])/g, " $1")}</span><Status value={value === null ? "INSUFFICIENT_DATA" : value ? "PASS" : "FAIL"} /></div>)}</div></div> : null}
                  <p className="mt-3 text-[10px] leading-4 text-slate-500">Model comparison is an evidence view. It does not approve a release, change a production model, or authorize operational actions.</p>
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === "POLICIES" ? (
            <section className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className={PANEL}>
                <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Immutable evaluation policies</h2><p className="mt-1 text-xs text-slate-500">API returns the latest version per policy key.</p></div>{canWritePolicies ? <button type="button" className={PRIMARY} onClick={() => setPolicyOpen((value) => !value)}>{policyOpen ? "Close form" : "Create policy version"}</button> : null}</div>
                {policyOpen && canWritePolicies ? (
                  <form onSubmit={createPolicy} className="mt-4 grid gap-3 sm:grid-cols-2">
                    <Field label="Policy key"><input className={INPUT} required maxLength={150} value={policyDraft.policy_key} onChange={(event) => setPolicyDraft({ ...policyDraft, policy_key: event.target.value })} placeholder="quality-defect-risk" /></Field>
                    <Field label="Policy version"><input className={INPUT} required maxLength={50} value={policyDraft.policy_version} onChange={(event) => setPolicyDraft({ ...policyDraft, policy_version: event.target.value })} placeholder="v1.0" /></Field>
                    <Field label="Domain"><select className={INPUT} value={policyDraft.domain} onChange={(event) => setPolicyDraft({ ...policyDraft, domain: event.target.value })}>{DOMAINS.map((domain) => <option key={domain}>{domain}</option>)}</select></Field>
                    <Field label="Metric key"><input className={INPUT} required maxLength={100} value={policyDraft.metric_key} onChange={(event) => setPolicyDraft({ ...policyDraft, metric_key: event.target.value })} /></Field>
                    <Field label="Minimum samples"><input className={INPUT} required type="number" min={1} max={1000000} value={policyDraft.minimum_samples} onChange={(event) => setPolicyDraft({ ...policyDraft, minimum_samples: event.target.value })} /></Field>
                    <Field label="Maximum MAE (metric unit)"><input className={INPUT} type="number" min={0} step="0.000001" value={policyDraft.max_mean_absolute_error} onChange={(event) => setPolicyDraft({ ...policyDraft, max_mean_absolute_error: event.target.value })} /></Field>
                    <Field label="Maximum MAPE (ratio, not %)"><input className={INPUT} type="number" min={0} max={1000000000} step="0.000001" value={policyDraft.max_mean_absolute_percentage_error} onChange={(event) => setPolicyDraft({ ...policyDraft, max_mean_absolute_percentage_error: event.target.value })} /></Field>
                    <Field label="Minimum within-tolerance rate (0–1)"><input className={INPUT} type="number" min={0} max={1} step="0.000001" value={policyDraft.min_within_tolerance_rate} onChange={(event) => setPolicyDraft({ ...policyDraft, min_within_tolerance_rate: event.target.value })} /></Field>
                    <Field label="Maximum expected calibration error (0–1)"><input className={INPUT} type="number" min={0} max={1} step="0.000001" value={policyDraft.max_expected_calibration_error} onChange={(event) => setPolicyDraft({ ...policyDraft, max_expected_calibration_error: event.target.value })} /></Field>
                    <div className="flex items-end justify-end gap-2 sm:col-span-2"><button type="button" className={SECONDARY} onClick={() => { setPolicyOpen(false); setPolicyDraft(initialPolicy()); }}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Save immutable version</button></div>
                  </form>
                ) : null}
                {canWritePolicies ? null : <p className="mt-3 text-[10px] text-slate-500">Missing permission: ai.evaluation.policies.write.</p>}
              </div>
              <div className={PANEL}>
                <h2 className="text-base font-bold text-slate-950">Latest policy versions</h2>
                {!policies.length ? <div className="mt-4"><Empty>No evaluation policies match the current filters.</Empty></div> : <div className="mt-4 space-y-2">{policies.map((policy) => <article key={String(policy.id)} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{display(policy.policyKey)} · {display(policy.policyVersion)}</p><span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-600">{display(policy.domain)}</span></div><p className="mt-1 text-[11px] text-slate-500">Metric {display(policy.metricKey)} · Minimum samples {countValue(policy.minimumSamples)}</p><div className="mt-3 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">{[["Max MAE", policy.maxMeanAbsoluteError], ["Max MAPE", policy.maxMeanAbsolutePercentageError], ["Min within tolerance", policy.minWithinToleranceRate], ["Max ECE", policy.maxExpectedCalibrationError]].map(([label, value]) => <div key={String(label)} className="rounded-lg bg-slate-50 p-2"><p className="text-slate-500">{String(label)}</p><p className="mt-1 font-semibold text-slate-800">{value === null || value === undefined ? "Not configured" : numberValue(value, 4)}</p></div>)}</div><p className="mt-2 text-[10px] text-slate-400">Created {dateTime(policy.createdAt)}</p></article>)}</div>}
              </div>
            </section>
          ) : null}

          {tab === "LABELS" ? (
            <section className="grid gap-4 xl:grid-cols-2">
              <div className={PANEL}>
                <h2 className="text-base font-bold text-slate-950">Record observed classification result</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">Bind an evaluation label to its source AI decision. The API checks the immutable model version metadata and idempotency key.</p>
                {!canWriteOutcomes ? <div className="mt-3"><Empty>Missing permission: ai.outcomes.write.</Empty></div> : (
                  <form onSubmit={recordLabel} className="mt-4 grid gap-3">
                    <Field label="Decision UUID"><input className={INPUT} required value={labelDraft.decision_id} onChange={(event) => setLabelDraft({ ...labelDraft, decision_id: event.target.value })} placeholder="UUID of the source AI decision" /></Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Domain"><select className={INPUT} value={labelDraft.domain} onChange={(event) => setLabelDraft({ ...labelDraft, domain: event.target.value })}>{DOMAINS.map((domain) => <option key={domain}>{domain}</option>)}</select></Field>
                      <Field label="Metric key"><input className={INPUT} required maxLength={100} value={labelDraft.metric_key} onChange={(event) => setLabelDraft({ ...labelDraft, metric_key: event.target.value })} /></Field>
                      <Field label="Model version"><input className={INPUT} required maxLength={100} value={labelDraft.model_version} onChange={(event) => setLabelDraft({ ...labelDraft, model_version: event.target.value })} /></Field>
                      <Field label="Predicted confidence (0–1)"><input className={INPUT} required type="number" min={0} max={1} step="0.000001" value={labelDraft.confidence} onChange={(event) => setLabelDraft({ ...labelDraft, confidence: event.target.value })} /></Field>
                      <Field label="Was prediction correct?"><select className={INPUT} value={labelDraft.prediction_correct} onChange={(event) => setLabelDraft({ ...labelDraft, prediction_correct: event.target.value })}><option value="true">Yes · correct</option><option value="false">No · incorrect</option></select></Field>
                      <Field label="Observed at (optional)"><input className={INPUT} type="datetime-local" value={labelDraft.observed_at} onChange={(event) => setLabelDraft({ ...labelDraft, observed_at: event.target.value })} /></Field>
                    </div>
                    <button type="submit" className={PRIMARY} disabled={busy}>Record immutable evaluation</button>
                  </form>
                )}
              </div>
              <div className={PANEL}>
                <h2 className="text-base font-bold text-slate-950">Reconcile numeric forecast outcome</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">Select an existing OBSERVED outcome. The API reads predicted and actual metric values from that outcome; this form does not accept replacement actuals.</p>
                {!canWriteOutcomes ? <div className="mt-3"><Empty>Missing permission: ai.outcomes.write.</Empty></div> : (
                  <form onSubmit={reconcileForecast} className="mt-4 grid gap-3">
                    <Field label="Source outcome UUID"><input className={INPUT} required value={forecastDraft.source_outcome_id} onChange={(event) => setForecastDraft({ ...forecastDraft, source_outcome_id: event.target.value })} placeholder="UUID of an OBSERVED outcome" /></Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Domain"><select className={INPUT} value={forecastDraft.domain} onChange={(event) => setForecastDraft({ ...forecastDraft, domain: event.target.value })}>{DOMAINS.map((domain) => <option key={domain}>{domain}</option>)}</select></Field>
                      <Field label="Metric key"><input className={INPUT} required maxLength={100} value={forecastDraft.metric_key} onChange={(event) => setForecastDraft({ ...forecastDraft, metric_key: event.target.value })} /></Field>
                      <Field label="Model version"><input className={INPUT} required maxLength={100} value={forecastDraft.model_version} onChange={(event) => setForecastDraft({ ...forecastDraft, model_version: event.target.value })} /></Field>
                      <Field label="Confidence (0–1)"><input className={INPUT} type="number" min={0} max={1} step="0.000001" required value={forecastDraft.confidence} onChange={(event) => setForecastDraft({ ...forecastDraft, confidence: event.target.value })} /></Field>
                      <Field label="Absolute tolerance (metric unit)"><input className={INPUT} type="number" min={0} step="0.000001" required value={forecastDraft.tolerance} onChange={(event) => setForecastDraft({ ...forecastDraft, tolerance: event.target.value })} /></Field>
                    </div>
                    <button type="submit" className={PRIMARY} disabled={busy}>Reconcile observed outcome</button>
                  </form>
                )}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <footer className="border-t border-slate-200 pt-4 text-[10px] leading-5 text-slate-500">Metrics and calibration summarize loaded factory data for a rolling 90-day window. A policy result with insufficient samples is not a pass. This workbench records evaluations and displays evidence; it does not promote models or authorize AI operational actions.</footer>
    </main>
  );
}
