"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  filterUomConversions,
  filterUomUnits,
  formatUomFactor,
  summarizeUomGovernance,
} from "@/lib/uom-governance.mjs";

type Row = Record<string, unknown>;
type Unit = Row & {
  id: string; unit_code: string; name: string; dimension_code: string;
  decimal_precision: number; created_by_user_id: string; created_at: string;
};
type Conversion = Row & {
  id: string; from_unit_code: string; from_unit_name: string; to_unit_code: string; to_unit_name: string;
  dimension_code: string; factor_numerator: string; factor_denominator: string; rounding_mode: string;
  status: string; submitted_by_user_id: string; decided_by_user_id: string | null; decided_at: string | null;
  decision_reason: string | null; retired_by_user_id: string | null; retired_at: string | null;
  retirement_reason: string | null; version: string; created_at: string; updated_at: string;
};
type Tab = "units" | "conversions" | "calculator";

function list<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return [];
}
function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function label(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
function dateLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function Metric({ title, value, detail, tone = "slate" }: { title: string; value: string; detail: string; tone?: "slate" | "blue" | "amber" | "emerald" }) {
  const tones = { slate: "border-slate-200 bg-white", blue: "border-blue-100 bg-blue-50/60", amber: "border-amber-100 bg-amber-50/60", emerald: "border-emerald-100 bg-emerald-50/60" };
  return <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{title}</p>
    <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
    <p className="mt-1 text-xs text-slate-500">{detail}</p>
  </article>;
}
function Status({ value }: { value: unknown }) {
  const state = label(value, "UNKNOWN").toUpperCase();
  const tone = state === "APPROVED" ? "bg-emerald-50 text-emerald-700"
    : state === "PENDING_APPROVAL" ? "bg-amber-50 text-amber-800"
    : state === "REJECTED" ? "bg-rose-50 text-rose-700"
    : state === "RETIRED" ? "bg-slate-100 text-slate-600"
    : "bg-slate-100 text-slate-600";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold " + tone}>{state.replaceAll("_", " ")}</span>;
}

export default function UomGovernanceWorkbenchPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("uom.read");
  const canWrite = hasPermission("uom.write");
  const canApprove = hasPermission("uom.approve");

  const [units, setUnits] = useState<Unit[]>([]);
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [tab, setTab] = useState<Tab>("units");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unitSearch, setUnitSearch] = useState("");
  const [dimensionFilter, setDimensionFilter] = useState("ALL");
  const [conversionSearch, setConversionSearch] = useState("");
  const [conversionStatus, setConversionStatus] = useState("ALL");
  const [selectedRuleId, setSelectedRuleId] = useState("");

  const [unitCode, setUnitCode] = useState("");
  const [unitName, setUnitName] = useState("");
  const [dimensionCode, setDimensionCode] = useState("");
  const [precision, setPrecision] = useState("4");

  const [fromUnitCode, setFromUnitCode] = useState("");
  const [toUnitCode, setToUnitCode] = useState("");
  const [numerator, setNumerator] = useState("1");
  const [denominator, setDenominator] = useState("1");
  const [roundingMode, setRoundingMode] = useState("REJECT");
  const [conversionReason, setConversionReason] = useState("");

  const [reviewAction, setReviewAction] = useState<"APPROVE" | "REJECT" | "RETIRE">("APPROVE");
  const [reviewReason, setReviewReason] = useState("");

  const [convertQuantity, setConvertQuantity] = useState("1");
  const [convertFrom, setConvertFrom] = useState("");
  const [convertTo, setConvertTo] = useState("");
  const [convertResult, setConvertResult] = useState<Row | null>(null);
  const [converting, setConverting] = useState(false);

  const selectedRule = conversions.find((rule) => rule.id === selectedRuleId) ?? null;
  const visibleUnits = useMemo(() => filterUomUnits(units, unitSearch, dimensionFilter), [units, unitSearch, dimensionFilter]);
  const visibleConversions = useMemo(() => filterUomConversions(conversions, conversionSearch, conversionStatus), [conversions, conversionSearch, conversionStatus]);
  const summary = useMemo(() => summarizeUomGovernance(units, conversions), [units, conversions]);
  const dimensions = useMemo(() => [...new Set(units.map((unit) => unit.dimension_code))].sort(), [units]);

  const refreshAll = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setError("");
    try {
      const [unitResult, conversionResult] = await Promise.all([
        request("/inventory/uom/units?limit=200"),
        request("/inventory/uom/conversions?limit=200"),
      ]);
      const nextUnits = list<Unit>(record(unitResult).units);
      const nextConversions = list<Conversion>(record(conversionResult).conversions);
      setUnits(nextUnits);
      setConversions(nextConversions);
      setSelectedRuleId((current) => nextConversions.some((rule) => rule.id === current) ? current : nextConversions.find((rule) => rule.status === "PENDING_APPROVAL")?.id ?? nextConversions[0]?.id ?? "");
      setFromUnitCode((current) => nextUnits.some((unit) => unit.unit_code === current) ? current : nextUnits[0]?.unit_code ?? "");
      setToUnitCode((current) => nextUnits.some((unit) => unit.unit_code === current) ? current : nextUnits[1]?.unit_code ?? nextUnits[0]?.unit_code ?? "");
      setConvertFrom((current) => nextUnits.some((unit) => unit.unit_code === current) ? current : nextUnits[0]?.unit_code ?? "");
      setConvertTo((current) => nextUnits.some((unit) => unit.unit_code === current) ? current : nextUnits[1]?.unit_code ?? nextUnits[0]?.unit_code ?? "");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canRead, request]);

  useEffect(() => {
    let active = true;
    async function initialLoad() {
      await Promise.resolve();
      if (!active) return;
      if (status !== "connected" || !activeFactoryId || !canRead) {
        setUnits([]);
        setConversions([]);
        setLoading(false);
        return;
      }
      void refreshAll();
    }
    void initialLoad();
    return () => { active = false; };
  }, [status, activeFactoryId, canRead, refreshAll]);

  async function createUnit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = unitCode.trim().toUpperCase();
    const dimension = dimensionCode.trim().toUpperCase();
    const precisionValue = Number(precision);
    if (!code || !unitName.trim() || !dimension || !Number.isInteger(precisionValue) || precisionValue < 0 || precisionValue > 8) {
      setError("Provide a unit code, name, dimension and precision from 0 to 8.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/inventory/uom/units", {
        method: "POST",
        idempotencyKey: "uom-unit-" + crypto.randomUUID(),
        body: { unit_code: code, name: unitName.trim(), dimension_code: dimension, decimal_precision: precisionValue },
      });
      setUnitCode(""); setUnitName(""); setDimensionCode(""); setPrecision("4");
      setNotice("Unit registered in this factory.");
      await refreshAll();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function createConversion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fromUnitCode || !toUnitCode || fromUnitCode === toUnitCode) {
      setError("Choose two different units.");
      return;
    }
    if (!/^[1-9][0-9]{0,23}$/.test(numerator) || !/^[1-9][0-9]{0,23}$/.test(denominator)) {
      setError("Use positive integer numerator and denominator values (up to 24 digits).");
      return;
    }
    const source = units.find((unit) => unit.unit_code === fromUnitCode);
    const target = units.find((unit) => unit.unit_code === toUnitCode);
    if (!source || !target || source.dimension_code !== target.dimension_code) {
      setError("Both units must belong to the same registered dimension.");
      return;
    }
    if (!conversionReason.trim()) {
      setError("A reason is required for every conversion request.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const created = record(await request("/inventory/uom/conversions", {
        method: "POST",
        idempotencyKey: "uom-conversion-" + crypto.randomUUID(),
        body: {
          from_unit_code: fromUnitCode, to_unit_code: toUnitCode,
          factor_numerator: numerator, factor_denominator: denominator,
          rounding_mode: roundingMode, reason: conversionReason.trim(),
        },
      }));
      setConversionReason("");
      setNotice("Conversion submitted for independent approval. It is not active until approved.");
      await refreshAll();
      if (created.id) setSelectedRuleId(String(created.id));
      setConversionStatus("PENDING_APPROVAL");
      setTab("conversions");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function reviewRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRule) return;
    const action = selectedRule.status === "APPROVED" ? "RETIRE" : reviewAction;
    if (!reviewReason.trim()) {
      setError("A review reason is required.");
      return;
    }
    if (selectedRule.status === "PENDING_APPROVAL" && selectedRule.submitted_by_user_id === snapshot?.user.id) {
      setError("You submitted this conversion. A different authorized user must approve or reject it.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/inventory/uom/conversions/" + encodeURIComponent(selectedRule.id) + "/review", {
        method: "POST",
        idempotencyKey: "uom-review-" + action.toLowerCase() + "-" + crypto.randomUUID(),
        body: { action, reason: reviewReason.trim() },
      });
      setReviewReason("");
      setNotice(action === "APPROVE" ? "Conversion approved and now eligible for quantity conversion." : action === "REJECT" ? "Conversion request rejected." : "Approved conversion retired.");
      await refreshAll();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function convert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!convertQuantity.trim() || !convertFrom || !convertTo) return;
    setConverting(true); setError(""); setNotice(""); setConvertResult(null);
    try {
      const result = await request("/inventory/uom/convert", {
        method: "POST",
        body: { quantity: convertQuantity.trim(), from_unit_code: convertFrom, to_unit_code: convertTo },
      });
      setConvertResult(record(result));
    } catch (cause) { setError(errorText(cause)); }
    finally { setConverting(false); }
  }

  if (status !== "connected" || !snapshot) {
    return <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6"><section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Measurement governance</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Units and conversion rules are factory-scoped. Connect a FactoryOS session and select the active factory to continue.</p>
      <Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white">Connect session</Link>
    </section></main>;
  }
  if (!activeFactoryId) return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">Select an active factory from the workspace header before opening measurement governance.</div></main>;
  if (!canRead) return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold">UoM read access required</h1><p className="mt-2 text-sm">Your current IAM snapshot does not include <code>uom.read</code>.</p></div></main>;

  const activeFactory = snapshot.factories.find((factory) => factory.id === activeFactoryId);
  return <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
    <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Inventory foundations · precision controls</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">UoM Governance Workbench</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Register factory measurement units, submit exact rational conversion contracts for independent approval, and test approved conversions at target precision.</p>
        <p className="mt-2 text-xs font-medium text-slate-500">{snapshot.tenant.name} · {activeFactory?.name ?? "Active factory"}</p>
      </div>
      <button type="button" onClick={() => void refreshAll()} disabled={loading} className="min-h-10 self-start rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 lg:self-auto">{loading ? "Refreshing…" : "Refresh governance"}</button>
    </header>

    {error ? <div role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
    {notice ? <div role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

    <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric title="Registered units" value={String(summary.units)} detail={"Across " + summary.dimensions + " dimensions"} tone="blue" />
      <Metric title="Conversion contracts" value={String(summary.conversions)} detail="All lifecycle states" />
      <Metric title="Pending review" value={String(summary.pending)} detail="Not usable for conversion" tone="amber" />
      <Metric title="Approved rules" value={String(summary.approved)} detail="Eligible for quantity conversion" tone="emerald" />
    </section>

    <section className="mt-7 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Measurement governance views">
          {([{ id: "units", label: "Unit registry" }, { id: "conversions", label: "Conversion contracts" }, { id: "calculator", label: "Conversion calculator" }] as const).map((item) =>
            <button type="button" role="tab" aria-selected={tab === item.id} key={item.id} onClick={() => setTab(item.id)} className={"min-h-9 rounded-lg px-3 text-xs font-bold " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>
          )}
        </div>
        <span className="text-[11px] font-semibold text-slate-500">{loading ? "Refreshing source data…" : "Factory-scoped API data"}</span>
      </div>

      {tab === "units" ? <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4 sm:p-5"><div><h2 className="text-lg font-bold text-slate-950">Unit registry</h2><p className="mt-1 text-xs text-slate-500">Unit codes are unique within the factory. Conversion is allowed only within the same dimension.</p></div><span className="text-xs font-semibold text-slate-500">{visibleUnits.length} shown · {units.length} total</span></div>
          <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[minmax(0,1fr)_180px]">
            <input aria-label="Search units" value={unitSearch} onChange={(event) => setUnitSearch(event.target.value)} placeholder="Search unit code, name or dimension…" className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm" />
            <select aria-label="Filter by dimension" value={dimensionFilter} onChange={(event) => setDimensionFilter(event.target.value)} className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="ALL">All dimensions</option>{dimensions.map((dimension) => <option key={dimension} value={dimension}>{dimension}</option>)}</select>
          </div>
          {visibleUnits.length ? <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs"><thead className="bg-slate-50 uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Unit code</th><th className="px-4 py-3">Name</th><th className="px-4 py-3">Dimension</th><th className="px-4 py-3">Precision</th><th className="px-4 py-3">Created</th></tr></thead><tbody className="divide-y divide-slate-100">{visibleUnits.map((unit) => <tr key={unit.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-mono font-bold text-slate-900">{unit.unit_code}</td><td className="px-4 py-3">{unit.name}</td><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold">{unit.dimension_code}</span></td><td className="px-4 py-3 tabular-nums">{unit.decimal_precision} decimal places</td><td className="px-4 py-3 text-slate-500">{dateLabel(unit.created_at)}</td></tr>)}</tbody></table></div> : <p className="p-10 text-center text-sm text-slate-500">{loading ? "Loading unit registry…" : "No registered units match this filter."}</p>}
          <div className="border-t border-slate-100 p-4 text-[11px] leading-5 text-slate-500">Dimensions are domain-specific identifiers (for example MASS, LENGTH, VOLUME or COUNT). Units from different dimensions cannot be converted.</div>
        </section>
        {canWrite ? <form onSubmit={createUnit} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="text-lg font-bold text-slate-950">Register a unit</h2><p className="mt-1 text-xs leading-5 text-slate-500">Choose a stable code and dimension. Precision defines the number of decimal places accepted for quantities in this unit.</p>
          <label className="mt-4 block text-xs font-semibold text-slate-600">Unit code<input required maxLength={50} value={unitCode} onChange={(event) => setUnitCode(event.target.value.toUpperCase())} placeholder="e.g. KG" className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm uppercase" /></label>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Display name<input required maxLength={160} value={unitName} onChange={(event) => setUnitName(event.target.value)} placeholder="e.g. Kilogram" className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Dimension code<input required maxLength={50} value={dimensionCode} onChange={(event) => setDimensionCode(event.target.value.toUpperCase())} placeholder="e.g. MASS" className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm uppercase" /></label>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Decimal precision<select value={precision} onChange={(event) => setPrecision(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm">{Array.from({ length: 9 }, (_, index) => <option key={index} value={String(index)}>{index} decimal place(s)</option>)}</select></label>
          <button disabled={busy || !unitCode.trim() || !unitName.trim() || !dimensionCode.trim()} className="mt-4 min-h-11 w-full rounded-xl bg-blue-700 px-4 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-50">{busy ? "Registering…" : "Register unit"}</button>
          <p className="mt-3 text-[10px] leading-5 text-slate-500">Writes require <code>uom.write</code>. A registered unit does not automatically authorize conversions to another unit.</p>
        </form> : <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">Read-only unit registry. Creating units requires <code>uom.write</code>.</div>}
      </div> : null}

      {tab === "conversions" ? <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4 sm:p-5"><div><h2 className="text-lg font-bold text-slate-950">Conversion contracts</h2><p className="mt-1 text-xs leading-5 text-slate-500">A rational factor is exact: target quantity = source quantity × numerator ÷ denominator. Only APPROVED contracts are used by stock and BOM conversions.</p></div><span className="text-xs font-semibold text-slate-500">{visibleConversions.length} shown</span></div>
          <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[minmax(0,1fr)_180px]">
            <input aria-label="Search conversion rules" value={conversionSearch} onChange={(event) => setConversionSearch(event.target.value)} placeholder="Search units, dimensions, factors…" className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm" />
            <select aria-label="Filter conversion state" value={conversionStatus} onChange={(event) => setConversionStatus(event.target.value)} className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="ALL">All states</option><option value="PENDING_APPROVAL">Pending approval</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="RETIRED">Retired</option></select>
          </div>
          {visibleConversions.length ? <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-xs"><thead className="bg-slate-50 uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Conversion</th><th className="px-4 py-3">Factor</th><th className="px-4 py-3">Rounding</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Version</th><th className="px-4 py-3">Updated</th></tr></thead><tbody className="divide-y divide-slate-100">{visibleConversions.map((rule) => <tr key={rule.id} className={"hover:bg-slate-50 " + (selectedRuleId === rule.id ? "bg-blue-50/70" : "")}><td className="px-4 py-3"><button type="button" onClick={() => setSelectedRuleId(rule.id)} className="text-left"><span className="font-bold text-slate-900">{rule.from_unit_code} → {rule.to_unit_code}</span><span className="mt-1 block text-[10px] text-slate-500">{rule.from_unit_name} to {rule.to_unit_name} · {rule.dimension_code}</span></button></td><td className="px-4 py-3 font-mono font-bold tabular-nums">{formatUomFactor(rule.factor_numerator, rule.factor_denominator)}</td><td className="px-4 py-3">{rule.rounding_mode}</td><td className="px-4 py-3"><Status value={rule.status} /></td><td className="px-4 py-3 tabular-nums">{rule.version}</td><td className="px-4 py-3 text-slate-500">{dateLabel(rule.updated_at)}</td></tr>)}</tbody></table></div> : <p className="p-10 text-center text-sm text-slate-500">{loading ? "Loading conversion rules…" : "No conversion contracts match this filter."}</p>}
          <div className="border-t border-slate-100 p-4 text-[11px] leading-5 text-slate-500">The reverse conversion uses the reciprocal rational factor. The API checks target precision and the selected rounding policy; REJECT refuses a value that cannot be represented exactly.</div>
        </section>
        <div className="space-y-4">
          {canWrite ? <form onSubmit={createConversion} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <h2 className="text-lg font-bold text-slate-950">Submit conversion rule</h2><p className="mt-1 text-xs leading-5 text-slate-500">New rules enter PENDING_APPROVAL and are not used until a different authorized user approves them.</p>
            <label className="mt-3 block text-xs font-semibold text-slate-600">From unit<select required value={fromUnitCode} onChange={(event) => setFromUnitCode(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="">Select source…</option>{units.map((unit) => <option key={unit.id} value={unit.unit_code}>{unit.unit_code} · {unit.name} ({unit.dimension_code})</option>)}</select></label>
            <label className="mt-3 block text-xs font-semibold text-slate-600">To unit<select required value={toUnitCode} onChange={(event) => setToUnitCode(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="">Select target…</option>{units.map((unit) => <option key={unit.id} value={unit.unit_code}>{unit.unit_code} · {unit.name} ({unit.dimension_code})</option>)}</select></label>
            <div className="mt-3 grid grid-cols-2 gap-2"><label className="block text-xs font-semibold text-slate-600">Factor numerator<input required inputMode="numeric" pattern="[1-9][0-9]{0,23}" value={numerator} onChange={(event) => setNumerator(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm" /></label><label className="block text-xs font-semibold text-slate-600">Factor denominator<input required inputMode="numeric" pattern="[1-9][0-9]{0,23}" value={denominator} onChange={(event) => setDenominator(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm" /></label></div>
            <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-700">1 {fromUnitCode || "source"} = {numerator || "?"} / {denominator || "?"} {toUnitCode || "target"}</p>
            <label className="mt-3 block text-xs font-semibold text-slate-600">Rounding policy<select value={roundingMode} onChange={(event) => setRoundingMode(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="REJECT">REJECT · exact precision only</option><option value="HALF_UP">HALF_UP · round half away from zero</option></select></label>
            <label className="mt-3 block text-xs font-semibold text-slate-600">Reason<input required maxLength={2000} value={conversionReason} onChange={(event) => setConversionReason(event.target.value)} placeholder="Why is this conversion required?" className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label>
            <button disabled={busy || !fromUnitCode || !toUnitCode || fromUnitCode === toUnitCode || !conversionReason.trim()} className="mt-4 min-h-11 w-full rounded-xl bg-blue-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Submitting…" : "Submit for approval"}</button>
          </form> : <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-500">Creating conversion rules requires <code>uom.write</code>.</div>}
          {selectedRule ? <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex items-start justify-between gap-2"><div><h3 className="font-bold text-slate-950">{selectedRule.from_unit_code} → {selectedRule.to_unit_code}</h3><p className="mt-1 text-xs text-slate-500">{selectedRule.dimension_code} · rule version {selectedRule.version}</p></div><Status value={selectedRule.status} /></div>
            <div className="mt-3 rounded-xl bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Exact rational factor</p><p className="mt-1 font-mono text-lg font-bold">{formatUomFactor(selectedRule.factor_numerator, selectedRule.factor_denominator)}</p><p className="mt-1 text-xs text-slate-500">Rounding: {selectedRule.rounding_mode}</p></div>
            <div className="mt-3 space-y-2 text-xs"><div className="flex justify-between gap-3"><span className="text-slate-500">Submitted by</span><span className="font-mono text-right">{selectedRule.submitted_by_user_id}</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Decided by</span><span className="font-mono text-right">{label(selectedRule.decided_by_user_id)}</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Decision time</span><span className="text-right">{dateLabel(selectedRule.decided_at)}</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Retired by</span><span className="font-mono text-right">{label(selectedRule.retired_by_user_id)}</span></div></div>
            {selectedRule.decision_reason ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Decision reason: {selectedRule.decision_reason}</p> : null}
            {selectedRule.retirement_reason ? <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-700">Retirement reason: {selectedRule.retirement_reason}</p> : null}
            {canApprove && (selectedRule.status === "PENDING_APPROVAL" || selectedRule.status === "APPROVED") ? <form onSubmit={reviewRule} className="mt-4 border-t border-slate-200 pt-4">
              <h4 className="text-sm font-bold text-slate-900">Independent review</h4>
              {selectedRule.status === "PENDING_APPROVAL" && selectedRule.submitted_by_user_id === snapshot.user.id ? <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">You submitted this rule. Another authorized user must review it.</p> : null}
              <label className="mt-3 block text-xs font-semibold text-slate-600">Action<select value={selectedRule.status === "APPROVED" ? "RETIRE" : reviewAction} onChange={(event) => setReviewAction(event.target.value as "APPROVE" | "REJECT" | "RETIRE")} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm">{selectedRule.status === "PENDING_APPROVAL" ? <><option value="APPROVE">Approve</option><option value="REJECT">Reject</option></> : <option value="RETIRE">Retire</option>}</select></label>
              <label className="mt-3 block text-xs font-semibold text-slate-600">Review reason<textarea required maxLength={2000} rows={3} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm" /></label>
              <button disabled={busy || !reviewReason.trim() || (selectedRule.status === "PENDING_APPROVAL" && selectedRule.submitted_by_user_id === snapshot.user.id)} className="mt-3 min-h-10 w-full rounded-lg bg-slate-950 px-4 text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving review…" : selectedRule.status === "APPROVED" || reviewAction === "RETIRE" ? "Retire conversion" : reviewAction === "APPROVE" ? "Approve conversion" : "Reject conversion"}</button>
              <p className="mt-2 text-[10px] leading-5 text-slate-500">Approval/rejection requires <code>uom.approve</code> and a reviewer different from the submitter. Retirement is permitted only for approved rules.</p>
            </form> : null}
          </section> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">Select a conversion contract to inspect its lifecycle and review options.</div>}
        </div>
      </div> : null}

      {tab === "calculator" ? <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><h2 className="text-lg font-bold text-slate-950">Precision conversion calculator</h2><p className="mt-1 text-xs leading-5 text-slate-500">This calculator calls the authenticated API. It does not calculate with browser floating-point approximations or treat pending rules as active.</p>
          <form onSubmit={convert} className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-600 sm:col-span-2">Quantity<input required maxLength={48} pattern="[0-9]+([.][0-9]{1,8})?" value={convertQuantity} onChange={(event) => setConvertQuantity(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-lg" /></label>
            <label className="block text-xs font-semibold text-slate-600">From unit<select required value={convertFrom} onChange={(event) => setConvertFrom(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="">Select source…</option>{units.map((unit) => <option key={unit.id} value={unit.unit_code}>{unit.unit_code} · {unit.name}</option>)}</select></label>
            <label className="block text-xs font-semibold text-slate-600">To unit<select required value={convertTo} onChange={(event) => setConvertTo(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="">Select target…</option>{units.map((unit) => <option key={unit.id} value={unit.unit_code}>{unit.unit_code} · {unit.name}</option>)}</select></label>
            <button disabled={converting || !convertFrom || !convertTo || !convertQuantity.trim()} className="min-h-11 rounded-xl bg-blue-700 px-4 text-sm font-bold text-white sm:col-span-2 disabled:opacity-50">{converting ? "Converting…" : "Convert using approved rule"}</button>
          </form>
          {convertResult ? <div role="status" className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5"><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">API conversion result</p><p className="mt-2 text-3xl font-bold tracking-tight text-emerald-950 tabular-nums">{label(convertResult.converted_quantity)} <span className="text-lg">{label(convertResult.converted_unit_code)}</span></p><p className="mt-2 text-sm text-emerald-900">{label(convertResult.input_quantity)} {label(convertResult.input_unit_code)} converted via {formatUomFactor(convertResult.factor_numerator, convertResult.factor_denominator)}</p><div className="mt-3 grid gap-2 text-xs text-emerald-900 sm:grid-cols-2"><p>Dimension: {label(convertResult.dimension_code)}</p><p>Rounding: {label(convertResult.rounding_mode)}</p><p>Target precision: {String(convertResult.target_precision ?? "—")}</p><p>Rule ID: {label(convertResult.conversion_rule_id)}</p></div></div> : <div className="mt-5 rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-500">The API enforces registered unit precision, same-dimension compatibility, an approved conversion rule and its rounding mode. Missing rules and non-representable values are rejected.</div>}
        </section>
        <aside className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><h3 className="font-bold text-slate-950">Conversion control model</h3><div className="mt-3 space-y-3"><div className="rounded-xl border border-slate-200 p-3"><p className="text-xs font-bold">1 · Register units</p><p className="mt-1 text-xs leading-5 text-slate-500">Each unit is tied to a factory and a dimension with fixed decimal precision.</p></div><div className="rounded-xl border border-slate-200 p-3"><p className="text-xs font-bold">2 · Submit rational rule</p><p className="mt-1 text-xs leading-5 text-slate-500">Numerator and denominator are stored as integers, avoiding approximate floating-point factors.</p></div><div className="rounded-xl border border-slate-200 p-3"><p className="text-xs font-bold">3 · Independent approval</p><p className="mt-1 text-xs leading-5 text-slate-500">The submitter cannot approve or reject their own conversion request.</p></div><div className="rounded-xl border border-slate-200 p-3"><p className="text-xs font-bold">4 · Use approved version</p><p className="mt-1 text-xs leading-5 text-slate-500">Inventory and BOM conversions use only approved rules and persist the conversion snapshot.</p></div></div></aside>
      </div> : null}
    </section>
    <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4 text-[11px] text-slate-500"><span>Factory-scoped · Exact rational factors · Independent approval</span><span>Pending, rejected and retired rules are never active conversion sources.</span></footer>
  </main>;
}
