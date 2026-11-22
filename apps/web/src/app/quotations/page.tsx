"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  asCommercialRows,
  buildExchangeRatePayload,
  buildPricingRulePayload,
  buildQuotationConversionPayload,
  buildQuotationPayload,
  buildQuotationRevisionPayload,
  buildQuotationTransitionPayload,
  calculateQuotationPreview,
  filterQuotations,
  quotationStatusLabel,
  resolveCurrentPricingRule,
  resolveExchangeRate,
  summarizeQuotations,
} from "@/lib/commercial-quotation-workbench.mjs";
import type {
  CommercialQuotation,
  ExchangeRate,
  PricingRule,
  QuotationHistory,
  QuotationListItem,
  QuotationRevisionSnapshot,
} from "@/lib/commercial-quotation-workbench.mjs";

type Tab = "QUOTATIONS" | "PRICING" | "FX";
type FormMode = "CREATE" | "REVISE";
type ActionKind = "SUBMIT" | "APPROVE" | "REJECT" | "SEND" | "ACCEPT" | "CANCEL" | "CONVERT";

type QuoteLineDraft = {
  line_number: number;
  product_code: string;
  product_name: string;
  quantity: string;
  unit: string;
  unit_price: string;
  discount_percent: string;
  tax_percent: string;
  notes: string;
};

type QuoteDraft = {
  quote_number: string;
  customer_name: string;
  customer_reference: string;
  currency: string;
  pricing_rule_code: string;
  requested_delivery_date: string;
  valid_until: string;
  incoterms: string;
  payment_terms: string;
  notes: string;
  reason: string;
  lines: QuoteLineDraft[];
};

type ActionDraft = {
  kind: ActionKind;
  reason: string;
  order_number: string;
};

type RuleDraft = {
  rule_code: string;
  customer_reference: string;
  base_currency: string;
  allowed_currencies: string;
  default_tax_percent: string;
  max_discount_percent: string;
  approval_required: boolean;
  approval_total_threshold: string;
  approval_discount_threshold_percent: string;
  incoterms_required: boolean;
  payment_terms_required: boolean;
};

type RateDraft = {
  currency: string;
  base_currency: string;
  rate_to_base: string;
  effective_on: string;
  source: string;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function rows<T>(value: unknown, key: string): T[] {
  return asCommercialRows(value, key) as T[];
}

function amount(value: unknown, currency = "") {
  const parsed = Number(value);
  const display = Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : "—";
  return currency ? currency + " " + display : display;
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function localDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
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
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
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

function StatusPill({ value }: { value: string }) {
  const status = value.toUpperCase();
  const tone = status === "APPROVED" || status === "ACCEPTED" || status === "CONVERTED"
    ? "bg-emerald-50 text-emerald-800"
    : status === "PENDING_APPROVAL" || status === "SENT"
      ? "bg-blue-50 text-blue-800"
      : status === "REJECTED" || status === "CANCELLED" || status === "EXPIRED"
        ? "bg-rose-50 text-rose-800"
        : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold " + tone}>{quotationStatusLabel(value)}</span>;
}

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const dangerButton = buttonClass + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

function initialLine(lineNumber = 1): QuoteLineDraft {
  return {
    line_number: lineNumber, product_code: "", product_name: "", quantity: "1",
    unit: "PCS", unit_price: "0", discount_percent: "", tax_percent: "", notes: "",
  };
}

function initialQuoteDraft(): QuoteDraft {
  return {
    quote_number: "", customer_name: "", customer_reference: "", currency: "BDT",
    pricing_rule_code: "", requested_delivery_date: "", valid_until: "",
    incoterms: "", payment_terms: "", notes: "", reason: "", lines: [initialLine()],
  };
}

function initialRuleDraft(): RuleDraft {
  return {
    rule_code: "", customer_reference: "", base_currency: "BDT", allowed_currencies: "BDT",
    default_tax_percent: "0", max_discount_percent: "0", approval_required: true,
    approval_total_threshold: "", approval_discount_threshold_percent: "0",
    incoterms_required: false, payment_terms_required: false,
  };
}

function initialRateDraft(): RateDraft {
  return { currency: "USD", base_currency: "BDT", rate_to_base: "", effective_on: localDate(), source: "" };
}

function actionLabel(kind: ActionKind) {
  const labels: Record<ActionKind, string> = {
    SUBMIT: "Submit for approval",
    APPROVE: "Approve quotation",
    REJECT: "Reject quotation",
    SEND: "Record as sent",
    ACCEPT: "Record customer acceptance",
    CANCEL: "Cancel quotation",
    CONVERT: "Convert to sales order",
  };
  return labels[kind];
}

function actionEndpoint(kind: ActionKind) {
  if (kind === "CONVERT") return "convert";
  return kind.toLowerCase();
}

export default function CommercialQuotationWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("quotations.read");
  const canWrite = hasPermission("quotations.write");
  const canApprove = hasPermission("quotations.approve");
  const canSend = hasPermission("quotations.send");
  const canAccept = hasPermission("quotations.accept");
  const canConvert = hasPermission("quotations.convert");
  const canRuleRead = hasPermission("quotation_rules.read");
  const canRuleWrite = hasPermission("quotation_rules.write");
  const canRateRead = hasPermission("exchange_rates.read");
  const canRateWrite = hasPermission("exchange_rates.write");

  const [tab, setTab] = useState<Tab>("QUOTATIONS");
  const [quotations, setQuotations] = useState<QuotationListItem[]>([]);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [selectedQuote, setSelectedQuote] = useState<CommercialQuotation | null>(null);
  const [revisions, setRevisions] = useState<QuotationRevisionSnapshot[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [rateSearch, setRateSearch] = useState("");

  const [quoteFormOpen, setQuoteFormOpen] = useState(false);
  const [quoteFormMode, setQuoteFormMode] = useState<FormMode>("CREATE");
  const [quoteDraft, setQuoteDraft] = useState<QuoteDraft>(initialQuoteDraft);
  const [actionDraft, setActionDraft] = useState<ActionDraft | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(initialRuleDraft);
  const [rateDraft, setRateDraft] = useState<RateDraft>(initialRateDraft);

  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createdOrder, setCreatedOrder] = useState<{ id: string; order_number: string; status: string } | null>(null);

  const selectedRule = useMemo(
    () => resolveCurrentPricingRule(rules, quoteDraft.customer_reference, quoteDraft.pricing_rule_code) as PricingRule | null,
    [rules, quoteDraft.customer_reference, quoteDraft.pricing_rule_code],
  );
  const allowedCurrencies = selectedRule?.allowed_currencies ?? ["BDT"];
  const baseCurrency = selectedRule?.base_currency ?? "BDT";
  const today = localDate();
  const selectedRate = useMemo(
    () => resolveExchangeRate(rates, quoteDraft.currency || baseCurrency, baseCurrency, today),
    [rates, quoteDraft.currency, baseCurrency, today],
  );
  const preview = useMemo(() => {
    if (quoteDraft.currency && !allowedCurrencies.includes(quoteDraft.currency.toUpperCase())) {
      return { value: null, error: "The selected currency is not allowed by the active pricing rule." };
    }
    if (!selectedRate) {
      return { value: null, error: "No effective exchange rate exists for " + quoteDraft.currency + " to " + baseCurrency + ". Record a sourced rate first." };
    }
    try {
      return {
        value: calculateQuotationPreview(
          quoteDraft.lines,
          selectedRule?.default_tax_percent ?? 0,
          selectedRule?.max_discount_percent ?? 0,
          selectedRate.rate_to_base,
        ),
        error: "",
      };
    } catch (cause) {
      return { value: null, error: errorMessage(cause) };
    }
  }, [quoteDraft.lines, quoteDraft.currency, allowedCurrencies, selectedRate, baseCurrency, selectedRule]);

  const visibleQuotations = useMemo(
    () => filterQuotations(quotations, search, statusFilter),
    [quotations, search, statusFilter],
  );
  const summary = useMemo(() => summarizeQuotations(quotations), [quotations]);
  const visibleRates = useMemo(() => {
    const query = rateSearch.trim().toLowerCase();
    if (!query) return rates;
    return rates.filter((rate) =>
      [rate.currency, rate.base_currency, rate.source, rate.effective_on]
        .some((value) => String(value ?? "").toLowerCase().includes(query)));
  }, [rates, rateSearch]);

  const loadWorkspace = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId) {
      setQuotations([]);
      setRules([]);
      setRates([]);
      setSelectedQuoteId("");
      setSelectedQuote(null);
      return;
    }
    setLoading(true);
    setError("");
    const tasks: Promise<unknown>[] = [
      canRead ? request("/quotations?page=1&limit=100") : Promise.resolve({ items: [] }),
      canRuleRead ? request("/quotation-rules") : Promise.resolve({ items: [] }),
      canRateRead ? request("/exchange-rates") : Promise.resolve({ items: [] }),
    ];
    try {
      const results = await Promise.allSettled(tasks);
      const valueAt = (index: number) => results[index]?.status === "fulfilled"
        ? (results[index] as PromiseFulfilledResult<unknown>).value : null;
      const nextQuotations = rows<QuotationListItem>(valueAt(0), "items");
      setQuotations(nextQuotations);
      setRules(rows<PricingRule>(valueAt(1), "items"));
      setRates(rows<ExchangeRate>(valueAt(2), "items"));
      setSelectedQuoteId((current) =>
        nextQuotations.some((quote) => quote.id === current) ? current : nextQuotations[0]?.id ?? "");
      const failures: string[] = [];
      if (results[0]?.status === "rejected" && canRead) failures.push("quotation register");
      if (results[1]?.status === "rejected" && canRuleRead) failures.push("pricing rules");
      if (results[2]?.status === "rejected" && canRateRead) failures.push("exchange rates");
      if (failures.length) setError("Could not load " + failures.join(", ") + ". Check the corresponding read permission and refresh.");
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canRead, canRuleRead, canRateRead, request]);

  const loadQuoteDetail = useCallback(async (quoteId: string) => {
    if (!quoteId || !canRead) {
      setSelectedQuote(null);
      setRevisions([]);
      return;
    }
    setLoadingDetail(true);
    setError("");
    const [detailResult, revisionResult] = await Promise.allSettled([
      request("/quotations/" + quoteId),
      request("/quotations/" + quoteId + "/revisions"),
    ]);
    if (detailResult.status === "fulfilled") {
      setSelectedQuote(detailResult.value as CommercialQuotation);
    } else {
      setSelectedQuote(null);
      setError(errorMessage(detailResult.reason));
    }
    if (revisionResult.status === "fulfilled") {
      setRevisions(rows<QuotationRevisionSnapshot>(revisionResult.value, "items"));
    } else {
      setRevisions([]);
      if (detailResult.status === "fulfilled") setError("Quotation loaded, but immutable revision snapshots could not be read: " + messageOf(revisionResult.reason));
    }
    setLoadingDetail(false);
  }, [canRead, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedQuoteId) void loadQuoteDetail(selectedQuoteId);
      else {
        setSelectedQuote(null);
        setRevisions([]);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedQuoteId, loadQuoteDetail]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!allowedCurrencies.includes(quoteDraft.currency.toUpperCase())) {
        setQuoteDraft((current) => ({ ...current, currency: baseCurrency }));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [allowedCurrencies, baseCurrency, quoteDraft.currency]);

  function openCreateForm() {
    setQuoteFormMode("CREATE");
    setQuoteDraft(initialQuoteDraft());
    setQuoteFormOpen(true);
    setSelectedQuoteId("");
    setSelectedQuote(null);
    setError("");
    setNotice("");
    setCreatedOrder(null);
  }

  function openRevisionForm(quote: CommercialQuotation) {
    setQuoteFormMode("REVISE");
    setQuoteDraft({
      quote_number: quote.quote_number,
      customer_name: quote.customer_name,
      customer_reference: quote.customer_reference ?? "",
      currency: quote.currency,
      pricing_rule_code: "",
      requested_delivery_date: quote.requested_delivery_date ?? "",
      valid_until: quote.valid_until ?? "",
      incoterms: quote.incoterms ?? "",
      payment_terms: quote.payment_terms ?? "",
      notes: quote.notes ?? "",
      reason: "",
      lines: quote.lines.map((line) => ({
        line_number: line.line_number,
        product_code: line.product_code,
        product_name: line.product_name,
        quantity: String(line.quantity),
        unit: line.unit,
        unit_price: String(line.unit_price),
        discount_percent: String(line.discount_percent ?? ""),
        tax_percent: String(line.tax_percent ?? ""),
        notes: line.notes ?? "",
      })),
    });
    setQuoteFormOpen(true);
    setError("");
    setNotice("");
  }

  function updateLine(index: number, field: keyof QuoteLineDraft, value: string) {
    setQuoteDraft((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index
        ? { ...line, [field]: field === "line_number" ? Number(value) : value }
        : line),
    }));
  }

  function addLine() {
    setQuoteDraft((current) => ({ ...current, lines: [...current.lines, initialLine(current.lines.length + 1)] }));
  }

  function removeLine(index: number) {
    setQuoteDraft((current) => ({
      ...current,
      lines: current.lines.filter((_, lineIndex) => lineIndex !== index)
        .map((line, lineIndex) => ({ ...line, line_number: lineIndex + 1 })),
    }));
  }

  async function submitQuoteForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeFactoryId || !canWrite) return;
    if (!preview.value) {
      setError(preview.error || "Complete the quotation fields and pricing checks before saving.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setCreatedOrder(null);
    try {
      if (quoteFormMode === "CREATE") {
        const body = buildQuotationPayload(quoteDraft as unknown as Record<string, unknown>, activeFactoryId);
        const result = await request("/quotations", {
          method: "POST",
          idempotencyKey: "commercial-quotation-" + crypto.randomUUID(),
          body,
        }) as CommercialQuotation;
        setQuoteFormOpen(false);
        setSelectedQuoteId(result.id);
        await loadWorkspace();
        setNotice("Quotation " + result.quote_number + " created at revision " + result.current_revision + ". " + (result.approval_required ? "The active policy requires maker-checker approval." : "The active policy allows auto-approval on submission."));
      } else if (selectedQuote) {
        const body = buildQuotationRevisionPayload(quoteDraft as unknown as Record<string, unknown>, selectedQuote);
        const result = await request("/quotations/" + selectedQuote.id + "/revise", {
          method: "PATCH",
          body,
        }) as CommercialQuotation;
        setQuoteFormOpen(false);
        setSelectedQuote(result);
        setSelectedQuoteId(result.id);
        await loadWorkspace();
        setNotice("A new immutable quotation revision was recorded. Previous revision lines, FX and pricing policy snapshots remain unchanged.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function beginAction(kind: ActionKind) {
    if (!selectedQuote) return;
    setActionDraft({ kind, reason: "", order_number: "" });
    setError("");
    setNotice("");
  }

  async function runAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedQuote || !actionDraft) return;
    setBusy(true);
    setError("");
    setNotice("");
    setCreatedOrder(null);
    try {
      const body = actionDraft.kind === "CONVERT"
        ? buildQuotationConversionPayload(actionDraft as unknown as Record<string, unknown>, selectedQuote)
        : buildQuotationTransitionPayload(actionDraft, selectedQuote);
      const result = await request(
        "/quotations/" + selectedQuote.id + "/" + actionEndpoint(actionDraft.kind),
        { method: "POST", body },
      ) as { quotation?: CommercialQuotation; order?: { id: string; order_number: string; status: string }; id?: string; status?: string };
      const nextQuote = actionDraft.kind === "CONVERT" ? result.quotation : result as CommercialQuotation;
      if (nextQuote) setSelectedQuote(nextQuote);
      if (result.order) setCreatedOrder(result.order);
      const success = actionDraft.kind === "CONVERT"
        ? "Accepted quotation converted to a DRAFT sales order. The conversion, quotation history and outbox events were committed together."
        : actionDraft.kind === "SUBMIT"
          ? "Quotation submitted. Its current pricing policy determined whether independent approval is required."
          : actionDraft.kind === "APPROVE"
            ? "Quotation approved by an authenticated reviewer."
            : actionDraft.kind === "REJECT"
              ? "Quotation rejected with a recorded reason."
              : actionDraft.kind === "SEND"
                ? "Quotation marked as sent. This records operator evidence; it does not send an email or customer message."
                : actionDraft.kind === "ACCEPT"
                  ? "Customer acceptance recorded with an immutable lifecycle-history event."
                  : "Quotation cancelled with an immutable lifecycle-history event.";
      setNotice(success);
      setActionDraft(null);
      await loadWorkspace();
      await loadQuoteDetail(selectedQuote.id);
    } catch (cause) {
      setError(errorMessage(cause));
      if (messageOf(cause).toLowerCase().includes("version") || messageOf(cause).includes("409")) {
        await loadQuoteDetail(selectedQuote.id);
      }
    } finally {
      setBusy(false);
    }
  }

  async function createPricingRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeFactoryId || !canRuleWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildPricingRulePayload(ruleDraft as unknown as Record<string, unknown>, activeFactoryId);
      const result = await request("/quotation-rules", { method: "POST", body }) as PricingRule;
      setNotice("Pricing rule " + result.rule_code + " version " + result.version + " created. Its predecessor is retained as an immutable superseded version.");
      setRuleDraft(initialRuleDraft());
      await loadWorkspace();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createExchangeRate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeFactoryId || !canRateWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildExchangeRatePayload(rateDraft as unknown as Record<string, unknown>, activeFactoryId);
      await request("/exchange-rates", { method: "POST", body });
      setNotice("Sourced exchange rate recorded as immutable evidence. Existing quotation revisions are not repriced.");
      setRateDraft(initialRateDraft());
      await loadWorkspace();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function mayAct(kind: ActionKind, quote: CommercialQuotation) {
    if (kind === "SUBMIT") return canWrite && quote.status === "DRAFT";
    if (kind === "APPROVE" || kind === "REJECT") {
      return canApprove && quote.status === "PENDING_APPROVAL" && quote.created_by_user_id !== snapshot?.user.id;
    }
    if (kind === "SEND") return canSend && quote.status === "APPROVED";
    if (kind === "ACCEPT") return canAccept && quote.status === "SENT";
    if (kind === "CANCEL") return canWrite && ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT"].includes(quote.status);
    if (kind === "CONVERT") return canConvert && quote.status === "ACCEPTED";
    return false;
  }

  if (status !== "connected" || !activeFactoryId) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Commercial operations</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-950">Quotation & pricing workbench</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">Connect an authenticated FactoryOS session and select an active factory to manage versioned quotes, pricing policies, sourced FX rates and sales-order conversion.</p>
          <Link href="/session" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white">Open session setup</Link>
        </div>
      </main>
    );
  }

  if (!canRead && !canRuleRead && !canRateRead) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="rounded-3xl border border-amber-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Permission required</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-950">Commercial workbench access is restricted</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">The authenticated account needs quotations.read, quotation_rules.read or exchange_rates.read to inspect commercial records. Write and approval actions require their own specific permissions.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Commercial · FR-FIN-01</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Quotation & pricing workbench</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Build priced customer quotations, capture independent decisions, preserve immutable revisions and convert accepted quotes into draft sales orders.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">Factory {shortId(activeFactoryId)}</span>
          <button type="button" onClick={() => { void loadWorkspace(); if (selectedQuoteId) void loadQuoteDetail(selectedQuoteId); }} disabled={loading || busy} className={secondaryButton}>{loading ? "Refreshing…" : "Refresh registers"}</button>
        </div>
      </header>

      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Quotations" value={summary.total} detail="Current factory register" />
        <Metric label="Draft / rejected" value={summary.draft + summary.rejected} detail={summary.draft + " draft · " + summary.rejected + " rejected"} />
        <Metric label="Pending approval" value={summary.pendingApproval} detail="Independent maker-checker review" tone="amber" />
        <Metric label="Approved / sent" value={summary.approved + summary.sent} detail={summary.approved + " approved · " + summary.sent + " sent"} tone="blue" />
        <Metric label="Accepted / converted" value={summary.accepted + summary.converted} detail={summary.accepted + " accepted · " + summary.converted + " converted"} tone="emerald" />
      </section>

      <nav aria-label="Commercial workbench sections" className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {([
          ["QUOTATIONS", "Quotation register"],
          ["PRICING", "Pricing rules"],
          ["FX", "Exchange rates"],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => setTab(value)} aria-pressed={tab === value}
            className={"min-h-10 rounded-xl px-4 text-xs font-semibold transition " + (tab === value ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "QUOTATIONS" ? (
        <div className="space-y-5">
          {quoteFormOpen ? (
            <section className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">{quoteFormMode === "CREATE" ? "New commercial record" : "Immutable revision"}</p>
                  <h2 className="mt-1 text-lg font-bold text-slate-950">{quoteFormMode === "CREATE" ? "Create quotation" : "Revise " + (selectedQuote?.quote_number ?? "quotation")}</h2>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{quoteFormMode === "CREATE" ? "The active customer pricing rule, tax, discount cap and effective-dated FX rate are snapshotted by the API." : "Only DRAFT and REJECTED quotations can be revised. The API creates a new immutable revision using expected_version; previous revision data is preserved."}</p>
                </div>
                <button type="button" onClick={() => setQuoteFormOpen(false)} className={secondaryButton}>Close form</button>
              </div>

              <form onSubmit={submitQuoteForm} className="mt-5 space-y-5">
                {quoteFormMode === "REVISE" ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                    Editing revision {selectedQuote?.current_revision ?? "—"} → {Number(selectedQuote?.current_revision ?? 0) + 1}, based on quotation version {selectedQuote?.version}. The customer identity and quote number remain immutable.
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Field label="Quote number">
                    <input required maxLength={100} disabled={quoteFormMode === "REVISE"} className={inputClass} value={quoteDraft.quote_number} onChange={(event) => setQuoteDraft((current) => ({ ...current, quote_number: event.target.value }))} placeholder="QT-2026-0001" />
                  </Field>
                  <Field label="Customer name">
                    <input required maxLength={255} disabled={quoteFormMode === "REVISE"} className={inputClass} value={quoteDraft.customer_name} onChange={(event) => setQuoteDraft((current) => ({ ...current, customer_name: event.target.value }))} placeholder="Customer or buying entity" />
                  </Field>
                  <Field label="Customer reference" hint="Used to resolve customer-specific pricing rules.">
                    <input maxLength={255} disabled={quoteFormMode === "REVISE"} className={inputClass} value={quoteDraft.customer_reference} onChange={(event) => setQuoteDraft((current) => ({ ...current, customer_reference: event.target.value, pricing_rule_code: "" }))} placeholder="Customer account / reference" />
                  </Field>
                  <Field label="Pricing rule">
                    <select className={inputClass} value={quoteDraft.pricing_rule_code} onChange={(event) => setQuoteDraft((current) => ({ ...current, pricing_rule_code: event.target.value }))}>
                      <option value="">Auto-resolve for this customer</option>
                      {rules.filter((rule) => rule.is_current).map((rule) => <option key={rule.id} value={rule.rule_code}>{rule.rule_code} · {rule.customer_reference || "Factory default"} · v{rule.version}</option>)}
                    </select>
                  </Field>
                  <Field label="Quote currency">
                    <select className={inputClass} value={quoteDraft.currency} onChange={(event) => setQuoteDraft((current) => ({ ...current, currency: event.target.value }))}>
                      {allowedCurrencies.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </Field>
                  <Field label="Requested delivery">
                    <input type="date" className={inputClass} value={quoteDraft.requested_delivery_date} onChange={(event) => setQuoteDraft((current) => ({ ...current, requested_delivery_date: event.target.value }))} />
                  </Field>
                  <Field label="Valid until">
                    <input type="date" min={today} className={inputClass} value={quoteDraft.valid_until} onChange={(event) => setQuoteDraft((current) => ({ ...current, valid_until: event.target.value }))} />
                  </Field>
                  <Field label="Incoterms" hint={selectedRule?.incoterms_required ? "Required by the active pricing rule." : "Optional delivery responsibility term."}>
                    <input maxLength={80} className={inputClass} value={quoteDraft.incoterms} onChange={(event) => setQuoteDraft((current) => ({ ...current, incoterms: event.target.value }))} placeholder="EXW / FCA / FOB…" />
                  </Field>
                  <Field label="Payment terms" hint={selectedRule?.payment_terms_required ? "Required by the active pricing rule." : undefined}>
                    <input maxLength={255} className={inputClass} value={quoteDraft.payment_terms} onChange={(event) => setQuoteDraft((current) => ({ ...current, payment_terms: event.target.value }))} placeholder="Net 30, advance…" />
                  </Field>
                  <div className="sm:col-span-2 xl:col-span-3">
                    <Field label="Commercial notes">
                      <textarea rows={2} maxLength={4000} className={inputClass + " py-2"} value={quoteDraft.notes} onChange={(event) => setQuoteDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Scope, assumptions, exclusions and customer-specific terms…" />
                    </Field>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
                    <div><h3 className="text-sm font-bold text-slate-900">Quotation lines</h3><p className="mt-1 text-[11px] text-slate-500">Quantity and price support four decimal places; discount and tax support two.</p></div>
                    <button type="button" onClick={addLine} className={secondaryButton}>Add line</button>
                  </div>
                  <div className="space-y-3 p-3">
                    {quoteDraft.lines.map((line, index) => (
                      <div key={index} className="rounded-xl border border-slate-200 p-3">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-slate-700">Line {index + 1}</span>
                          <button type="button" onClick={() => removeLine(index)} disabled={quoteDraft.lines.length <= 1} className={dangerButton}>Remove line</button>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          <Field label="Product code"><input required maxLength={100} className={inputClass} value={line.product_code} onChange={(event) => updateLine(index, "product_code", event.target.value)} placeholder="SKU-001" /></Field>
                          <Field label="Product name"><input required maxLength={255} className={inputClass} value={line.product_name} onChange={(event) => updateLine(index, "product_name", event.target.value)} placeholder="Product description" /></Field>
                          <Field label="Quantity"><input required inputMode="decimal" className={inputClass} value={line.quantity} onChange={(event) => updateLine(index, "quantity", event.target.value)} /></Field>
                          <Field label="Unit"><input required maxLength={50} className={inputClass} value={line.unit} onChange={(event) => updateLine(index, "unit", event.target.value)} placeholder="PCS / KG / M" /></Field>
                          <Field label={"Unit price (" + quoteDraft.currency + ")"}><input required inputMode="decimal" className={inputClass} value={line.unit_price} onChange={(event) => updateLine(index, "unit_price", event.target.value)} /></Field>
                          <Field label="Discount %" hint={"Rule maximum: " + (selectedRule?.max_discount_percent ?? "0") + "%"}>
                            <input inputMode="decimal" className={inputClass} value={line.discount_percent} onChange={(event) => updateLine(index, "discount_percent", event.target.value)} placeholder="0" />
                          </Field>
                          <Field label="Tax %" hint={"Blank uses rule default: " + (selectedRule?.default_tax_percent ?? "0") + "%"}>
                            <input inputMode="decimal" className={inputClass} value={line.tax_percent} onChange={(event) => updateLine(index, "tax_percent", event.target.value)} placeholder="Policy default" />
                          </Field>
                          <Field label="Line notes"><input maxLength={2000} className={inputClass} value={line.notes} onChange={(event) => updateLine(index, "notes", event.target.value)} placeholder="Optional" /></Field>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {quoteFormMode === "REVISE" ? (
                  <Field label="Revision reason" hint="Required, max 1,000 characters. This reason is appended to quotation history.">
                    <textarea required maxLength={1000} rows={2} className={inputClass + " py-2"} value={quoteDraft.reason} onChange={(event) => setQuoteDraft((current) => ({ ...current, reason: event.target.value }))} placeholder="Explain what changed and why…" />
                  </Field>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(270px,0.65fr)]">
                  <div className="rounded-xl border border-slate-200 p-4">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-slate-700">Policy and FX snapshot preview</h3>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div><p className="text-[10px] uppercase text-slate-500">Effective rule</p><p className="mt-1 text-sm font-semibold">{selectedRule?.rule_code ?? "DEFAULT_BDT"}</p><p className="text-[11px] text-slate-500">{selectedRule ? "Version " + selectedRule.version + " · " + (selectedRule.customer_reference || "Factory default") : "Restrictive fallback · BDT only · no discount"}</p></div>
                      <div><p className="text-[10px] uppercase text-slate-500">Approval policy</p><p className="mt-1 text-sm font-semibold">{selectedRule?.approval_required === false ? "Threshold-based" : "Approval required"}</p><p className="text-[11px] text-slate-500">Discount threshold {selectedRule?.approval_discount_threshold_percent ?? "0"}%</p></div>
                      <div><p className="text-[10px] uppercase text-slate-500">FX rate</p><p className="mt-1 text-sm font-semibold">{selectedRate?.rate_to_base ?? "Unavailable"}</p><p className="text-[11px] text-slate-500">{quoteDraft.currency} → {baseCurrency} · {selectedRate?.effective_on ?? "No effective rate"} · {selectedRate?.source ?? ""}</p></div>
                      <div><p className="text-[10px] uppercase text-slate-500">Commercial requirements</p><p className="mt-1 text-sm font-semibold">{selectedRule?.incoterms_required ? "Incoterms required" : "Incoterms optional"}</p><p className="text-[11px] text-slate-500">{selectedRule?.payment_terms_required ? "Payment terms required" : "Payment terms optional"}</p></div>
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-slate-700">Calculated totals</h3>
                    {preview.value ? (
                      <div className="mt-3 space-y-2 text-xs">
                        <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><strong>{amount(preview.value.totals.subtotal, quoteDraft.currency)}</strong></div>
                        <div className="flex justify-between"><span className="text-slate-500">Discount</span><strong>−{amount(preview.value.totals.discount_total, quoteDraft.currency)}</strong></div>
                        <div className="flex justify-between"><span className="text-slate-500">Tax</span><strong>{amount(preview.value.totals.tax_total, quoteDraft.currency)}</strong></div>
                        <div className="border-t border-slate-200 pt-2"><div className="flex justify-between text-sm"><span className="font-bold">Quote total</span><strong>{amount(preview.value.totals.total, quoteDraft.currency)}</strong></div><div className="mt-1 flex justify-between"><span className="text-slate-500">Base total</span><strong>{amount(preview.value.totals.total_base, baseCurrency)}</strong></div></div>
                      </div>
                    ) : <p className="mt-3 text-xs leading-5 text-rose-700">{preview.error}</p>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="max-w-2xl text-[11px] leading-5 text-slate-500">The UI preview is informative. The API revalidates pricing policy, line math, discount cap, effective FX, delivery dates and approval thresholds inside the database transaction.</p>
                  <button type="submit" disabled={busy || !canWrite || !preview.value || (quoteFormMode === "REVISE" && !quoteDraft.reason.trim())} className={primaryButton}>{busy ? "Saving…" : quoteFormMode === "CREATE" ? "Create quotation" : "Save new immutable revision"}</button>
                </div>
              </form>
            </section>
          ) : null}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="text-base font-bold text-slate-950">Quotation register</h2><p className="mt-1 text-xs text-slate-500">Search by quote number, customer or external customer reference.</p></div>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular-nums text-slate-500">{visibleQuotations.length} shown</span>
                  {canWrite ? <button type="button" onClick={openCreateForm} className={primaryButton}>New quotation</button> : null}
                </div>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_180px]">
                <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quotes or customers…" />
                <select className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="ALL">All statuses</option>
                  {["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT", "ACCEPTED", "CONVERTED", "CANCELLED", "EXPIRED"].map((value) => <option key={value} value={value}>{quotationStatusLabel(value)}</option>)}
                </select>
              </div>
              <div className="mt-4 max-h-[720px] space-y-2 overflow-y-auto">
                {visibleQuotations.map((quote) => (
                  <button key={quote.id} type="button" onClick={() => { setSelectedQuoteId(quote.id); setQuoteFormOpen(false); setActionDraft(null); setCreatedOrder(null); }}
                    className={"w-full rounded-xl border p-3 text-left transition " + (selectedQuoteId === quote.id ? "border-blue-300 bg-blue-50/70 ring-1 ring-blue-100" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50")}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-bold text-slate-950">{quote.quote_number}</span>
                      <StatusPill value={quote.status} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-700">{quote.customer_name}</span>
                      <strong className="tabular-nums">{amount(quote.total, quote.currency)}</strong>
                    </div>
                    <div className="mt-1 flex flex-wrap justify-between gap-2 text-[10px] text-slate-500">
                      <span>{quote.customer_reference || "No customer reference"} · Revision {quote.current_revision} · v{quote.version}</span>
                      <span>Base {amount(quote.total_base, quote.base_currency)}</span>
                    </div>
                  </button>
                ))}
                {!visibleQuotations.length ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">{loading ? "Loading quotations…" : "No quotations match the current filters."}</div> : null}
              </div>
            </section>

            <section className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><h2 className="text-base font-bold text-slate-950">Quotation detail & lifecycle</h2><p className="mt-1 text-xs text-slate-500">Current immutable revision, FX and commercial policy snapshots.</p></div>
                  {selectedQuote ? <StatusPill value={selectedQuote.status} /> : null}
                </div>
                {loadingDetail ? <p className="mt-5 text-sm text-slate-500">Loading quotation detail…</p> : null}
                {!selectedQuote && !loadingDetail ? <div className="mt-5 rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">Select a quotation from the register.</div> : null}
                {selectedQuote ? (
                  <div className="mt-4 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div><h3 className="text-lg font-bold text-slate-950">{selectedQuote.quote_number}</h3><p className="mt-1 text-xs text-slate-600">{selectedQuote.customer_name} · {selectedQuote.customer_reference || "No customer reference"}</p><p className="mt-1 text-[10px] text-slate-400">ID {shortId(selectedQuote.id)} · Creator {shortId(selectedQuote.created_by_user_id)} · Version {selectedQuote.version}</p></div>
                      <div className="text-right"><p className="text-lg font-bold tabular-nums">{amount(selectedQuote.total, selectedQuote.currency)}</p><p className="mt-1 text-[11px] text-slate-500">Base {amount(selectedQuote.total_base, selectedQuote.base_currency)}</p></div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Revision</p><p className="mt-1 text-sm font-bold">{selectedQuote.current_revision}</p><p className="text-[10px] text-slate-500">Immutable snapshot</p></div>
                      <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Pricing rule</p><p className="mt-1 text-sm font-bold">{selectedQuote.pricing_rule_code}</p><p className="text-[10px] text-slate-500">Rule v{selectedQuote.pricing_rule_version ?? "fallback"}</p></div>
                      <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Approval</p><p className="mt-1 text-sm font-bold">{selectedQuote.approval_required ? "Required" : "Policy allows auto-approval"}</p><p className="text-[10px] text-slate-500">Current revision policy</p></div>
                    </div>
                    <div className="rounded-xl border border-slate-200 p-3">
                      <h3 className="text-xs font-bold text-slate-800">FX snapshot</h3>
                      <div className="mt-2 grid gap-2 sm:grid-cols-3 text-xs">
                        <div><p className="text-[10px] text-slate-500">Conversion rate</p><p className="font-semibold">{selectedQuote.exchange_rate_to_base}</p></div>
                        <div><p className="text-[10px] text-slate-500">Effective date</p><p className="font-semibold">{selectedQuote.exchange_rate_as_of}</p></div>
                        <div><p className="text-[10px] text-slate-500">Source</p><p className="font-semibold">{selectedQuote.exchange_rate_source}</p></div>
                      </div>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full min-w-[560px] text-left text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Product</th><th className="px-3 py-2">Qty</th><th className="px-3 py-2">Unit price</th><th className="px-3 py-2">Discount</th><th className="px-3 py-2">Tax</th><th className="px-3 py-2">Line total</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                          {selectedQuote.lines.map((line) => <tr key={line.id ?? line.line_number}>
                            <td className="px-3 py-3"><p className="font-semibold">{line.product_code}</p><p className="text-[10px] text-slate-500">{line.product_name}</p></td>
                            <td className="px-3 py-3 tabular-nums">{amount(line.quantity)} {line.unit}</td>
                            <td className="px-3 py-3 tabular-nums">{amount(line.unit_price, selectedQuote.currency)}</td>
                            <td className="px-3 py-3">{line.discount_percent ?? "0"}%</td>
                            <td className="px-3 py-3">{line.tax_percent ?? "0"}%</td>
                            <td className="px-3 py-3 font-semibold tabular-nums">{amount(line.line_total, selectedQuote.currency)}</td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3 text-xs">
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Subtotal</p><p className="mt-1 font-bold">{amount(selectedQuote.subtotal, selectedQuote.currency)}</p></div>
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Discount / tax</p><p className="mt-1 font-bold">{amount(selectedQuote.discount_total, selectedQuote.currency)} / {amount(selectedQuote.tax_total, selectedQuote.currency)}</p></div>
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Valid until</p><p className="mt-1 font-bold">{selectedQuote.valid_until || "Not specified"}</p></div>
                    </div>
                    {selectedQuote.requested_delivery_date || selectedQuote.incoterms || selectedQuote.payment_terms || selectedQuote.notes ? (
                      <div className="rounded-xl border border-slate-200 p-3 text-xs">
                        <h3 className="font-bold text-slate-800">Commercial terms</h3>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <p><span className="text-slate-500">Requested delivery: </span>{selectedQuote.requested_delivery_date || "—"}</p>
                          <p><span className="text-slate-500">Incoterms: </span>{selectedQuote.incoterms || "—"}</p>
                          <p><span className="text-slate-500">Payment: </span>{selectedQuote.payment_terms || "—"}</p>
                          <p><span className="text-slate-500">Last reason: </span>{selectedQuote.last_change_reason}</p>
                        </div>
                        {selectedQuote.notes ? <p className="mt-2 whitespace-pre-wrap text-slate-600">{selectedQuote.notes}</p> : null}
                      </div>
                    ) : null}
                    {selectedQuote.converted_order_id ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">Converted order ID: <span className="font-mono">{selectedQuote.converted_order_id}</span></div> : null}
                    <div className="flex flex-wrap gap-2">
                      {mayAct("SUBMIT", selectedQuote) ? <button type="button" onClick={() => beginAction("SUBMIT")} className={primaryButton}>Submit</button> : null}
                      {mayAct("APPROVE", selectedQuote) ? <button type="button" onClick={() => beginAction("APPROVE")} className={primaryButton}>Approve</button> : null}
                      {mayAct("REJECT", selectedQuote) ? <button type="button" onClick={() => beginAction("REJECT")} className={dangerButton}>Reject</button> : null}
                      {mayAct("SEND", selectedQuote) ? <button type="button" onClick={() => beginAction("SEND")} className={primaryButton}>Record sent</button> : null}
                      {mayAct("ACCEPT", selectedQuote) ? <button type="button" onClick={() => beginAction("ACCEPT")} className={primaryButton}>Record acceptance</button> : null}
                      {mayAct("CANCEL", selectedQuote) ? <button type="button" onClick={() => beginAction("CANCEL")} className={dangerButton}>Cancel</button> : null}
                      {mayAct("CONVERT", selectedQuote) ? <button type="button" onClick={() => beginAction("CONVERT")} className={primaryButton}>Convert to order</button> : null}
                      {canWrite && ["DRAFT", "REJECTED"].includes(selectedQuote.status) ? <button type="button" onClick={() => openRevisionForm(selectedQuote)} className={secondaryButton}>Create revision</button> : null}
                    </div>
                    {selectedQuote.status === "PENDING_APPROVAL" && selectedQuote.created_by_user_id === snapshot?.user.id ? <p className="rounded-lg bg-amber-50 p-3 text-[11px] leading-5 text-amber-900">Maker-checker protection: the quotation creator cannot approve or reject their own quotation. An independent user with quotations.approve is required.</p> : null}
                    {actionDraft ? (
                      <form onSubmit={runAction} className="rounded-xl border border-blue-200 bg-blue-50/40 p-4">
                        <h3 className="text-sm font-bold text-slate-900">{actionLabel(actionDraft.kind)}</h3>
                        <p className="mt-1 text-[11px] leading-5 text-slate-600">This command is bound to expected quotation version {selectedQuote.version}. A stale version returns a conflict; refresh and review the current record before retrying.</p>
                        {actionDraft.kind === "CONVERT" ? <Field label="New sales order number"><input required maxLength={100} className={inputClass} value={actionDraft.order_number} onChange={(event) => setActionDraft((current) => current ? { ...current, order_number: event.target.value } : current)} placeholder="SO-2026-0001" /></Field> : null}
                        <Field label="Decision / action reason" hint="Required, max 1,000 characters; appended to quotation history.">
                          <textarea required maxLength={1000} rows={2} className={inputClass + " mt-1 py-2"} value={actionDraft.reason} onChange={(event) => setActionDraft((current) => current ? { ...current, reason: event.target.value } : current)} placeholder="Record the commercial reason and evidence…" />
                        </Field>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="submit" disabled={busy || !actionDraft.reason.trim() || (actionDraft.kind === "CONVERT" && !actionDraft.order_number.trim())} className={primaryButton}>{busy ? "Recording…" : "Confirm " + actionLabel(actionDraft.kind).toLowerCase()}</button>
                          <button type="button" onClick={() => setActionDraft(null)} className={secondaryButton}>Back</button>
                        </div>
                      </form>
                    ) : null}
                    {createdOrder ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900"><p className="font-bold">Sales order created: {createdOrder.order_number}</p><p className="mt-1">ID {createdOrder.id} · Status {createdOrder.status}. Order confirmation, inventory reservation and production release remain separate workflow actions.</p></div> : null}
                  </div>
                ) : null}
              </div>

              {selectedQuote ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Revision & decision history</h2><p className="mt-1 text-xs text-slate-500">Immutable commercial snapshots and append-only lifecycle evidence.</p></div><span className="text-xs text-slate-500">{revisions.length} revisions</span></div>
                  <div className="mt-4 space-y-3">
                    {selectedQuote.history.map((entry: QuotationHistory) => <article key={entry.id} className="border-l-2 border-slate-200 pl-3">
                      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{entry.action} · revision {entry.revision_number}</p><StatusPill value={entry.to_status} /></div>
                      <p className="mt-1 text-xs text-slate-700">{entry.reason}</p>
                      <p className="mt-1 text-[10px] text-slate-400">{dateTime(entry.created_at)} · actor {shortId(entry.actor_user_id)}{entry.order_id ? " · order " + shortId(entry.order_id) : ""}</p>
                    </article>)}
                    {!selectedQuote.history.length ? <p className="text-xs text-slate-500">No lifecycle history returned.</p> : null}
                  </div>
                  {revisions.length ? <div className="mt-5 border-t border-slate-200 pt-4">
                    <h3 className="text-xs font-bold text-slate-800">Immutable revision snapshots</h3>
                    <div className="mt-2 space-y-2">
                      {revisions.map((revision) => <article key={revision.quotation_version_id} className="rounded-lg bg-slate-50 p-3 text-xs">
                        <div className="flex flex-wrap justify-between gap-2"><strong>Revision {revision.current_revision ?? revision.revision_number}</strong><strong>{amount(revision.total, revision.currency)}</strong></div>
                        <p className="mt-1 text-[10px] text-slate-500">{revision.currency} → {revision.base_currency} · FX {revision.exchange_rate_to_base} · {revision.exchange_rate_as_of} · {revision.exchange_rate_source}</p>
                        <p className="mt-1 text-[10px] text-slate-500">{revision.lines?.length ?? 0} line snapshots · rule {revision.pricing_rule_code} v{revision.pricing_rule_version ?? "fallback"}</p>
                      </article>)}
                    </div>
                  </div> : null}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      ) : null}

      {tab === "PRICING" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.2fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-bold text-slate-950">Create pricing-rule version</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">Rules are immutable versions. Creating a replacement retires the prior current rule for the same customer scope; historical versions stay visible.</p>
            {canRuleWrite ? (
              <form onSubmit={createPricingRule} className="mt-4 space-y-3">
                <Field label="Rule code"><input required maxLength={80} className={inputClass} value={ruleDraft.rule_code} onChange={(event) => setRuleDraft((current) => ({ ...current, rule_code: event.target.value }))} placeholder="BDT-DEFAULT / ACME-USD" /></Field>
                <Field label="Customer reference" hint="Leave blank to define the factory default rule.">
                  <input maxLength={255} className={inputClass} value={ruleDraft.customer_reference} onChange={(event) => setRuleDraft((current) => ({ ...current, customer_reference: event.target.value }))} placeholder="Customer-specific reference (optional)" />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Base currency"><input required maxLength={3} className={inputClass} value={ruleDraft.base_currency} onChange={(event) => setRuleDraft((current) => ({ ...current, base_currency: event.target.value.toUpperCase() }))} /></Field>
                  <Field label="Allowed currencies" hint="Comma-separated; include base currency."><input required className={inputClass} value={ruleDraft.allowed_currencies} onChange={(event) => setRuleDraft((current) => ({ ...current, allowed_currencies: event.target.value.toUpperCase() }))} placeholder="BDT, USD, EUR" /></Field>
                  <Field label="Default tax %"><input inputMode="decimal" className={inputClass} value={ruleDraft.default_tax_percent} onChange={(event) => setRuleDraft((current) => ({ ...current, default_tax_percent: event.target.value }))} /></Field>
                  <Field label="Maximum discount %"><input inputMode="decimal" className={inputClass} value={ruleDraft.max_discount_percent} onChange={(event) => setRuleDraft((current) => ({ ...current, max_discount_percent: event.target.value }))} /></Field>
                  <Field label="Approval total threshold" hint={"In " + ruleDraft.base_currency + "; blank means no total threshold."}><input inputMode="decimal" className={inputClass} value={ruleDraft.approval_total_threshold} onChange={(event) => setRuleDraft((current) => ({ ...current, approval_total_threshold: event.target.value }))} /></Field>
                  <Field label="Approval discount threshold %"><input inputMode="decimal" className={inputClass} value={ruleDraft.approval_discount_threshold_percent} onChange={(event) => setRuleDraft((current) => ({ ...current, approval_discount_threshold_percent: event.target.value }))} /></Field>
                </div>
                <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-xs">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={ruleDraft.approval_required} onChange={(event) => setRuleDraft((current) => ({ ...current, approval_required: event.target.checked }))} /> Maker-checker approval required by default</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={ruleDraft.incoterms_required} onChange={(event) => setRuleDraft((current) => ({ ...current, incoterms_required: event.target.checked }))} /> Require Incoterms</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={ruleDraft.payment_terms_required} onChange={(event) => setRuleDraft((current) => ({ ...current, payment_terms_required: event.target.checked }))} /> Require payment terms</label>
                </div>
                <button type="submit" disabled={busy || !ruleDraft.rule_code.trim()} className={primaryButton + " w-full"}>{busy ? "Creating…" : "Create immutable rule version"}</button>
              </form>
            ) : <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">quotation_rules.write is required to create rule versions.</p>}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Pricing-rule register</h2><p className="mt-1 text-xs text-slate-500">Current rules are resolved by customer-reference specificity, then factory default.</p></div><span className="text-xs text-slate-500">{rules.length} versions</span></div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Rule / version</th><th className="px-3 py-3">Customer</th><th className="px-3 py-3">Currency</th><th className="px-3 py-3">Tax / discount</th><th className="px-3 py-3">Approval</th><th className="px-3 py-3">Status</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rules.map((rule) => <tr key={rule.id} className={!rule.is_current ? "text-slate-400" : ""}>
                    <td className="px-3 py-3"><p className="font-bold">{rule.rule_code}</p><p className="text-[10px]">Version {rule.version}</p></td>
                    <td className="px-3 py-3">{rule.customer_reference || "Factory default"}</td>
                    <td className="px-3 py-3">{rule.base_currency}<p className="text-[10px] text-slate-500">{rule.allowed_currencies.join(", ")}</p></td>
                    <td className="px-3 py-3">{rule.default_tax_percent}% / {rule.max_discount_percent}%</td>
                    <td className="px-3 py-3">{rule.approval_required ? "Required" : "Threshold-based"}<p className="text-[10px] text-slate-500">{rule.approval_total_threshold ? "Total " + amount(rule.approval_total_threshold, rule.base_currency) : "No total threshold"}</p></td>
                    <td className="px-3 py-3"><span className={"rounded-full px-2 py-1 text-[10px] font-semibold " + (rule.is_current ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-500")}>{rule.is_current ? "CURRENT" : "SUPERSEDED"}</span></td>
                  </tr>)}
                  {!rules.length ? <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">No pricing-rule versions are configured. Quotations fall back to restrictive BDT-only pricing until a rule is recorded.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {tab === "FX" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(340px,0.75fr)_minmax(0,1.25fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-bold text-slate-950">Record sourced exchange rate</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">The API stores source currency → base currency. Example: USD / BDT at 120 means 1 USD = 120 BDT. Rates are append-only.</p>
            {canRateWrite ? (
              <form onSubmit={createExchangeRate} className="mt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Source currency"><input required maxLength={3} className={inputClass} value={rateDraft.currency} onChange={(event) => setRateDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} /></Field>
                  <Field label="Base currency"><input required maxLength={3} className={inputClass} value={rateDraft.base_currency} onChange={(event) => setRateDraft((current) => ({ ...current, base_currency: event.target.value.toUpperCase() }))} /></Field>
                </div>
                <Field label="Rate to base"><input required inputMode="decimal" className={inputClass} value={rateDraft.rate_to_base} onChange={(event) => setRateDraft((current) => ({ ...current, rate_to_base: event.target.value }))} placeholder="120.0000000000" hint="Positive, up to ten decimal places." /></Field>
                <Field label="Effective on"><input required type="date" className={inputClass} value={rateDraft.effective_on} onChange={(event) => setRateDraft((current) => ({ ...current, effective_on: event.target.value }))} /></Field>
                <Field label="Source / provenance"><input required maxLength={120} className={inputClass} value={rateDraft.source} onChange={(event) => setRateDraft((current) => ({ ...current, source: event.target.value }))} placeholder="Bank circular, approved treasury rate…" /></Field>
                <button type="submit" disabled={busy || !rateDraft.rate_to_base || !rateDraft.source.trim()} className={primaryButton + " w-full"}>{busy ? "Recording…" : "Record immutable FX rate"}</button>
              </form>
            ) : <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">exchange_rates.write is required to record rates.</p>}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Effective-dated FX register</h2><p className="mt-1 text-xs text-slate-500">A quotation uses the latest rate effective on or before the database's current date; the applied rate is snapshotted.</p></div><span className="text-xs text-slate-500">{visibleRates.length} shown</span></div>
            <input className={inputClass + " mt-4"} value={rateSearch} onChange={(event) => setRateSearch(event.target.value)} placeholder="Filter currency pair, source or date…" />
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[620px] text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Pair</th><th className="px-3 py-3">Rate</th><th className="px-3 py-3">Effective</th><th className="px-3 py-3">Source</th><th className="px-3 py-3">Recorded</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRates.map((rate) => <tr key={rate.id}>
                    <td className="px-3 py-3 font-bold">{rate.currency} → {rate.base_currency}</td>
                    <td className="px-3 py-3 font-mono tabular-nums">{rate.rate_to_base}</td>
                    <td className="px-3 py-3">{rate.effective_on}</td>
                    <td className="px-3 py-3">{rate.source}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{dateTime(rate.created_at)}</td>
                  </tr>)}
                  {!visibleRates.length ? <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-500">No exchange rates match the filter.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-700 sm:p-5">
        <h2 className="font-bold text-slate-900">Commercial governance and evidence boundaries</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>All API calls use the shared authenticated session and the selected active factory. Tenant, actor and factory scope are never taken from editable form fields except the DTO factory ID that is cross-checked against authenticated scope by the API.</li>
          <li>Quotation revisions, line snapshots, FX rates and lifecycle history are append-only. The UI creates new versions instead of mutating historical records.</li>
          <li>Approval is maker-checker: the quotation creator cannot approve or reject their own quotation. The database independently enforces this rule.</li>
          <li>Lifecycle commands use expected_version and a mandatory reason. A conflict means a newer quotation version exists; refresh and review before issuing another command.</li>
          <li>“Record sent” and “Record acceptance” capture manual operator evidence. This page does not send customer emails, obtain a digital customer signature or confirm an external delivery.</li>
          <li>Accepted-quote conversion creates a DRAFT sales order atomically. Order confirmation, inventory reservation and production release remain separate workflows.</li>
        </ul>
      </section>
    </main>
  );
}
