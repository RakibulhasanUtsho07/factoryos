"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildShouldCostAssessmentPayload,
  buildShouldCostProfilePayload,
  buildShouldCostQuery,
  buildShouldCostTransitionPayload,
  filterShouldCostProfiles,
  formatShouldCostMoney,
  normalizeShouldCostRows,
  shouldCostMarginTone,
  summarizeShouldCost,
} from "@/lib/should-cost-workbench.mjs";
import type {
  ShouldCostAssessment,
  ShouldCostCategory,
  ShouldCostMethod,
  ShouldCostProfile,
  ShouldCostProfileComponent,
} from "@/lib/should-cost-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "PROFILES" | "ASSESSMENTS";
type ProfileAction = "SUBMIT" | "APPROVE" | "REJECT";
type ComponentDraft = {
  category: ShouldCostCategory;
  calculation_method: ShouldCostMethod;
  is_required: boolean;
  base_categories: ShouldCostCategory[];
  guidance: string;
};
type ProfileDraft = {
  profile_code: string;
  product_id: string;
  currency: string;
  output_unit: string;
  components: ComponentDraft[];
};
type EvidenceDraft = {
  category: ShouldCostCategory;
  applicable: boolean;
  source_type: string;
  source_reference: string;
  source_as_of: string;
  source_snapshot: string;
  notes: string;
  input_quantity: string;
  unit_code: string;
  unit_rate: string;
  fixed_amount: string;
  percentage_rate: string;
  source_currency: string;
  quantity_source_reference: string;
  quantity_source_snapshot: string;
};
type AssessmentDraft = {
  scope_type: "PRODUCT_VERSION" | "ORDER" | "QUOTATION";
  target_id: string;
  profile_id: string;
  target_quantity: string;
  target_unit: string;
  evidence: EvidenceDraft[];
};
type TransitionDraft = {
  profileId: string;
  action: ProfileAction;
  version: number;
  reason: string;
};

const CATEGORIES: ShouldCostCategory[] = [
  "MATERIAL", "LABOUR", "ENERGY", "FREIGHT", "DUTY", "OVERHEAD", "SCRAP",
];
const METHODS_BY_CATEGORY: Record<ShouldCostCategory, ShouldCostMethod[]> = {
  MATERIAL: ["DIRECT_RATE"],
  LABOUR: ["DIRECT_RATE"],
  ENERGY: ["DIRECT_RATE"],
  FREIGHT: ["DIRECT_RATE", "FIXED_PER_BATCH"],
  DUTY: ["DIRECT_RATE", "PERCENT_OF_BASE"],
  OVERHEAD: ["DIRECT_RATE", "FIXED_PER_BATCH", "PERCENT_OF_BASE"],
  SCRAP: ["DIRECT_RATE", "SCRAP_GROSS_UP"],
};
const SOURCE_TYPES = [
  "SUPPLIER_QUOTE", "PURCHASE_ORDER", "COST_RATE_CARD", "UTILITY_BILL",
  "FREIGHT_QUOTE", "DUTY_SCHEDULE", "OVERHEAD_POLICY", "QUALITY_STANDARD", "MANUAL_APPROVED",
];
const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";
const BASE_PROFILE_TEMPLATE: ComponentDraft[] = [
  { category: "MATERIAL", calculation_method: "DIRECT_RATE", is_required: true, base_categories: [], guidance: "Use approved BOM quantities and traceable supplier or purchase-order rates." },
  { category: "LABOUR", calculation_method: "DIRECT_RATE", is_required: true, base_categories: [], guidance: "Use approved routing time and an effective labour cost rate." },
  { category: "ENERGY", calculation_method: "DIRECT_RATE", is_required: true, base_categories: [], guidance: "Use metered or approved utility consumption and the applicable tariff." },
  { category: "FREIGHT", calculation_method: "FIXED_PER_BATCH", is_required: true, base_categories: [], guidance: "Use a current freight quote or approved batch allocation." },
  { category: "DUTY", calculation_method: "PERCENT_OF_BASE", is_required: false, base_categories: ["MATERIAL"], guidance: "Apply the approved duty schedule to eligible material cost." },
  { category: "OVERHEAD", calculation_method: "PERCENT_OF_BASE", is_required: true, base_categories: ["MATERIAL", "LABOUR", "ENERGY"], guidance: "Apply the approved overhead allocation policy to defined cost bases." },
  { category: "SCRAP", calculation_method: "SCRAP_GROSS_UP", is_required: true, base_categories: ["MATERIAL", "LABOUR"], guidance: "Apply the approved quality/scrap allowance as a gross-up." },
];

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function rows(value: unknown) {
  return normalizeShouldCostRows(value) as Row[];
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function display(value: unknown, fallback = "—") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function dateTime(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function localDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function key() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure idempotency-key generation is unavailable.");
  return "should-cost:" + globalThis.crypto.randomUUID();
}

function profileDraft(): ProfileDraft {
  return {
    profile_code: "",
    product_id: "",
    currency: "BDT",
    output_unit: "PCS",
    components: BASE_PROFILE_TEMPLATE.map((component) => ({ ...component, base_categories: [...component.base_categories] })),
  };
}

function evidenceDraft(): EvidenceDraft[] {
  return CATEGORIES.map((category) => ({
    category,
    applicable: true,
    source_type: "MANUAL_APPROVED",
    source_reference: "",
    source_as_of: localDate(),
    source_snapshot: JSON.stringify({ approval_reference: "", basis: "" }, null, 2),
    notes: "",
    input_quantity: "1",
    unit_code: category === "LABOUR" ? "HOUR" : category === "ENERGY" ? "KWH" : "PCS",
    unit_rate: "",
    fixed_amount: "",
    percentage_rate: "",
    source_currency: "BDT",
    quantity_source_reference: "",
    quantity_source_snapshot: JSON.stringify({ approved_quantity_reference: "", basis: "" }, null, 2),
  }));
}

function assessmentDraft(): AssessmentDraft {
  return {
    scope_type: "PRODUCT_VERSION",
    target_id: "",
    profile_id: "",
    target_quantity: "1",
    target_unit: "PCS",
    evidence: evidenceDraft(),
  };
}

function labelCategory(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusPill({ value }: { value: unknown }) {
  const status = display(value, "UNKNOWN").toUpperCase();
  const tone = ["APPROVED", "READY"].includes(status)
    ? "bg-emerald-50 text-emerald-800"
    : ["DRAFT", "PENDING_APPROVAL"].includes(status)
      ? "bg-amber-50 text-amber-900"
      : status === "REJECTED"
        ? "bg-rose-50 text-rose-800"
        : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + tone}>{status.replaceAll("_", " ")}</span>;
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

function Metric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{typeof value === "number" ? value.toLocaleString() : value}</p>
      <p className="mt-1 text-[10px] text-slate-500">{detail}</p>
    </article>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">{children}</div>;
}

function versionNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export default function ShouldCostWorkbenchPage() {
  const { status: sessionStatus, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const canReadProfiles = hasPermission("should_cost.profiles.read");
  const canWriteProfiles = hasPermission("should_cost.profiles.write");
  const canSubmitProfiles = hasPermission("should_cost.profiles.submit");
  const canApproveProfiles = hasPermission("should_cost.profiles.approve");
  const canReadAssessments = hasPermission("should_cost.assessments.read");
  const canCalculateAssessments = hasPermission("should_cost.assessments.calculate");
  const canRead = canReadProfiles || canReadAssessments;

  const [tab, setTab] = useState<Tab>("PROFILES");
  const [profiles, setProfiles] = useState<ShouldCostProfile[]>([]);
  const [assessments, setAssessments] = useState<ShouldCostAssessment[]>([]);
  const [loadedFactoryId, setLoadedFactoryId] = useState("");

  const [profileStatus, setProfileStatus] = useState("ALL");
  const [profileSearch, setProfileSearch] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileDetail, setProfileDetail] = useState<ShouldCostProfile | null>(null);
  const [profileDetailLoading, setProfileDetailLoading] = useState(false);

  const [assessmentScopeFilter, setAssessmentScopeFilter] = useState("ALL");
  const [assessmentTargetFilter, setAssessmentTargetFilter] = useState("");
  const [selectedAssessmentId, setSelectedAssessmentId] = useState("");
  const [assessmentDetail, setAssessmentDetail] = useState<ShouldCostAssessment | null>(null);
  const [assessmentDetailLoading, setAssessmentDetailLoading] = useState(false);
  const [assessmentProfileDetail, setAssessmentProfileDetail] = useState<ShouldCostProfile | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [createProfileOpen, setCreateProfileOpen] = useState(false);
  const [newProfile, setNewProfile] = useState<ProfileDraft>(profileDraft());
  const [transition, setTransition] = useState<TransitionDraft | null>(null);

  const [createAssessmentOpen, setCreateAssessmentOpen] = useState(false);
  const [newAssessment, setNewAssessment] = useState<AssessmentDraft>(assessmentDraft());

  const visibleProfiles = useMemo(
    () => filterShouldCostProfiles(profiles, profileSearch, "ALL"),
    [profiles, profileSearch],
  );
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const selectedAssessment = assessments.find((assessment) => assessment.id === selectedAssessmentId) ?? null;
  const approvedProfiles = profiles.filter((profile) =>
    profile.status === "APPROVED" && profile.is_current === true,
  );
  const summary = useMemo(() => summarizeShouldCost(profiles, assessments), [profiles, assessments]);

  const load = useCallback(async () => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setError("");
    setLoadedFactoryId("");
    setProfiles([]);
    setAssessments([]);
    setProfileDetail(null);
    setAssessmentDetail(null);
    setSelectedProfileId("");
    setSelectedAssessmentId("");
    try {
      const [profileResponse, assessmentResponse] = await Promise.all([
        canReadProfiles
          ? request("/should-cost/profiles" + buildShouldCostQuery({ status: profileStatus }, "profiles"))
          : Promise.resolve({ items: [] }),
        canReadAssessments
          ? request("/should-cost/assessments" + buildShouldCostQuery({
            scope_type: assessmentScopeFilter,
            target_id: assessmentTargetFilter,
            limit: 20,
          }, "assessments"))
          : Promise.resolve({ items: [] }),
      ]);
      setProfiles(rows(profileResponse) as ShouldCostProfile[]);
      setAssessments(rows(assessmentResponse) as ShouldCostAssessment[]);
      setLoadedFactoryId(activeFactoryId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [
    sessionStatus, activeFactoryId, canRead, canReadProfiles, canReadAssessments,
    request, profileStatus, assessmentScopeFilter, assessmentTargetFilter,
  ]);

  useEffect(() => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, activeFactoryId, canRead, load]);

  useEffect(() => {
    if (!selectedProfileId || !canReadProfiles || loadedFactoryId !== activeFactoryId) return;
    let current = true;
    setProfileDetailLoading(true);
    void request("/should-cost/profiles/" + selectedProfileId)
      .then((value) => {
        if (current) setProfileDetail(object(value) as ShouldCostProfile);
      })
      .catch((cause) => {
        if (current) setError(messageOf(cause));
      })
      .finally(() => {
        if (current) setProfileDetailLoading(false);
      });
    return () => { current = false; };
  }, [selectedProfileId, canReadProfiles, loadedFactoryId, activeFactoryId, request]);

  useEffect(() => {
    if (!selectedAssessmentId || !canReadAssessments || loadedFactoryId !== activeFactoryId) return;
    let current = true;
    setAssessmentDetailLoading(true);
    void request("/should-cost/assessments/" + selectedAssessmentId)
      .then((value) => {
        if (current) setAssessmentDetail(object(value) as ShouldCostAssessment);
      })
      .catch((cause) => {
        if (current) setError(messageOf(cause));
      })
      .finally(() => {
        if (current) setAssessmentDetailLoading(false);
      });
    return () => { current = false; };
  }, [selectedAssessmentId, canReadAssessments, loadedFactoryId, activeFactoryId, request]);

  useEffect(() => {
    if (!createAssessmentOpen || !newAssessment.profile_id || !canReadProfiles) {
      setAssessmentProfileDetail(null);
      return;
    }
    let current = true;
    void request("/should-cost/profiles/" + newAssessment.profile_id)
      .then((value) => {
        if (current) {
          const detail = object(value) as ShouldCostProfile;
          setAssessmentProfileDetail(detail);
          setNewAssessment((draft) => ({ ...draft, target_unit: detail.output_unit }));
        }
      })
      .catch((cause) => {
        if (current) setError(messageOf(cause));
      });
    return () => { current = false; };
  }, [createAssessmentOpen, newAssessment.profile_id, canReadProfiles, request]);

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      setNotice(success);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function updateProfileComponent(category: ShouldCostCategory, patch: Partial<ComponentDraft>) {
    setNewProfile((draft) => ({
      ...draft,
      components: draft.components.map((component) =>
        component.category === category ? { ...component, ...patch } : component,
      ),
    }));
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    let idempotencyKey: string;
    try {
      body = buildShouldCostProfilePayload({
        factory_id: activeFactoryId,
        ...newProfile,
      }) as Row;
      idempotencyKey = key();
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const saved = await perform(
      () => request("/should-cost/profiles", { method: "POST", body, idempotencyKey }),
      "Should-cost profile draft created. It is not active until submitted and independently approved.",
    );
    if (saved) {
      setCreateProfileOpen(false);
      setNewProfile(profileDraft());
    }
  }

  async function submitTransition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transition) return;
    let body: Row;
    try {
      body = buildShouldCostTransitionPayload(transition.version, transition.reason) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const endpoint = "/should-cost/profiles/" + transition.profileId + "/" + transition.action.toLowerCase();
    const saved = await perform(
      () => request(endpoint, { method: "POST", body }),
      transition.action === "SUBMIT"
        ? "Profile submitted for independent approval."
        : transition.action === "APPROVE"
          ? "Costing profile approved and made current."
          : "Costing profile rejected; it remains non-current.",
    );
    if (saved) setTransition(null);
  }

  function updateEvidence(category: ShouldCostCategory, patch: Partial<EvidenceDraft>) {
    setNewAssessment((draft) => ({
      ...draft,
      evidence: draft.evidence.map((line) => line.category === category ? { ...line, ...patch } : line),
    }));
  }

  async function createAssessment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assessmentProfileDetail) {
      setError("Load the selected profile and confirm it is the current approved version before calculating.");
      return;
    }
    let body: Row;
    let idempotencyKey: string;
    try {
      body = buildShouldCostAssessmentPayload(newAssessment, assessmentProfileDetail) as Row;
      idempotencyKey = key();
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const saved = await perform(
      () => request("/should-cost/assessments", { method: "POST", body, idempotencyKey }),
      "Should-cost assessment calculated and stored with its versioned evidence snapshot.",
    );
    if (saved) {
      setCreateAssessmentOpen(false);
      setNewAssessment(assessmentDraft());
      setAssessmentProfileDetail(null);
      setTab("ASSESSMENTS");
    }
  }

  const hasSession = sessionStatus === "connected" && Boolean(activeFactoryId);
  const factoryChanged = Boolean(loadedFactoryId && loadedFactoryId !== activeFactoryId);
  const isProfileCreator = Boolean(
    profileDetail?.created_by_user_id && snapshot?.user?.id
      && profileDetail.created_by_user_id === snapshot.user.id,
  );
  const selectedProfileComponents = profileDetail?.components ?? [];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-5 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 p-6 text-white sm:p-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-emerald-200">FactoryOS · Product economics</p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Should-Cost & Costing Governance</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              Build controlled seven-category cost formulas, approve versioned costing policy and calculate traceable costs for product versions, orders and quotations.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold">
              {hasSession ? "Factory scope active" : "Session required"}
            </span>
            <button type="button" className={SECONDARY} onClick={() => void load()} disabled={!canRead || loading || !hasSession}>
              {loading ? "Refreshing…" : "Refresh workbench"}
            </button>
          </div>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Profiles" value={loading || factoryChanged ? "…" : canReadProfiles ? summary.profiles : "—"} detail={canReadProfiles ? summary.currentProfiles + " current approved versions" : "Profile read permission not granted"} />
          <Metric label="Pending approvals" value={loading || factoryChanged ? "…" : canReadProfiles ? summary.pendingProfiles : "—"} detail="Profiles awaiting a different reviewer" />
          <Metric label="Assessments" value={loading || factoryChanged ? "…" : canReadAssessments ? summary.assessments : "—"} detail="Latest assessment rows returned" />
          <Metric label="Costed targets" value={loading || factoryChanged ? "…" : canReadAssessments ? summary.costedTargets : "—"} detail="Distinct product/order/quotation scopes in this view" />
        </div>
      </section>

      {!hasSession ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
          Connect an authenticated FactoryOS session and select an active factory before using cost governance.
          <div className="mt-3"><Link href="/session" className="font-semibold underline underline-offset-2">Open session setup</Link></div>
        </section>
      ) : !canRead ? (
        <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
          Your current permission snapshot does not include should-cost profile or assessment read access.
        </section>
      ) : null}

      {factoryChanged ? (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Factory context changed. Previous factory data is cleared while the new workspace loads.
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <span>{error}</span>
          <button type="button" className="text-xs font-semibold underline" onClick={() => setError("")}>Dismiss</button>
        </div>
      ) : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</div> : null}

      {canRead && hasSession && !factoryChanged ? (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200">
            <button type="button" aria-pressed={tab === "PROFILES"} onClick={() => setTab("PROFILES")} className={"-mb-px min-h-10 border-b-2 px-3 text-xs font-semibold " + (tab === "PROFILES" ? "border-emerald-700 text-emerald-800" : "border-transparent text-slate-500 hover:text-slate-900")}>Costing profiles</button>
            <button type="button" aria-pressed={tab === "ASSESSMENTS"} onClick={() => setTab("ASSESSMENTS")} className={"-mb-px min-h-10 border-b-2 px-3 text-xs font-semibold " + (tab === "ASSESSMENTS" ? "border-emerald-700 text-emerald-800" : "border-transparent text-slate-500 hover:text-slate-900")}>Cost assessments</button>
          </div>

          {tab === "PROFILES" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
                  <div>
                    <h2 className="text-sm font-bold text-slate-950">Versioned costing policy register</h2>
                    <p className="mt-1 text-[11px] text-slate-500">Only the current approved version can be used for new assessments.</p>
                  </div>
                  {canWriteProfiles ? <button type="button" className={PRIMARY} onClick={() => setCreateProfileOpen(true)}>Create profile version</button> : null}
                </div>
                <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[1fr_180px]">
                  <input aria-label="Search costing profiles" className={INPUT} placeholder="Search profile code, currency or unit" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} />
                  <select aria-label="Profile status filter" className={INPUT} value={profileStatus} onChange={(event) => setProfileStatus(event.target.value)}>
                    <option value="ALL">All statuses</option>
                    <option value="DRAFT">Draft</option>
                    <option value="PENDING_APPROVAL">Pending approval</option>
                    <option value="APPROVED">Approved</option>
                    <option value="REJECTED">Rejected</option>
                  </select>
                </div>
                {!canReadProfiles ? <Empty>Profile read access is not included in your current permissions.</Empty> : visibleProfiles.length === 0 ? <Empty>No costing profiles match the current filters.</Empty> : (
                  <div className="divide-y divide-slate-100">
                    {visibleProfiles.map((profile) => (
                      <button
                        type="button"
                        key={profile.id}
                        onClick={() => setSelectedProfileId(profile.id)}
                        className={"flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 " + (selectedProfileId === profile.id ? "bg-emerald-50/70" : "")}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-slate-900">{profile.profile_code} · v{profile.version}</span>
                          <span className="mt-1 block truncate text-[10px] text-slate-500">{profile.currency} / {profile.output_unit} · {profile.product_id ? "Product-specific" : "Factory-level"}</span>
                          <span className="mt-1 block text-[10px] text-slate-400">Updated {dateTime(profile.updated_at)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          {profile.is_current ? <span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-800">CURRENT</span> : null}
                          <StatusPill value={profile.status} />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="border-t border-slate-100 px-4 py-3 text-[10px] text-slate-500">The API returns at most 100 profile versions for this factory and filter.</div>
              </div>

              <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h2 className="text-sm font-bold text-slate-950">Profile configuration & approval</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Profile transitions use an optimistic row version and an explicit reason.</p>
                </div>
                {!selectedProfile ? <Empty>Select a profile version to inspect its seven formulas and governance history.</Empty> : profileDetailLoading ? <Empty>Loading full profile and history…</Empty> : !profileDetail ? <Empty>Profile detail is not available.</Empty> : (
                  <>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-slate-900">{profileDetail.profile_code} · v{profileDetail.version}</p>
                        <StatusPill value={profileDetail.status} />
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">{profileDetail.currency} per {profileDetail.output_unit} · {profileDetail.product_id ? "Product-specific policy" : "Factory-level policy"}</p>
                      <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                        <div><dt className="text-slate-500">Row version</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{profileDetail.row_version}</dd></div>
                        <div><dt className="text-slate-500">Current version</dt><dd className="mt-1 font-semibold text-slate-800">{profileDetail.is_current ? "Yes" : "No"}</dd></div>
                        <div><dt className="text-slate-500">Created</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(profileDetail.created_at)}</dd></div>
                        <div><dt className="text-slate-500">Approved</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(profileDetail.approved_at)}</dd></div>
                      </dl>
                      {profileDetail.decision_reason ? <p className="mt-3 border-t border-slate-200 pt-3 text-[11px] leading-5 text-slate-600">Latest transition: {profileDetail.decision_reason}</p> : null}
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Seven category formulas</p>
                      <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
                        {selectedProfileComponents.map((component) => (
                          <div key={component.category} className="p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-[11px] font-bold text-slate-900">{labelCategory(component.category)}</p>
                              <span className="rounded-md bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-700">{component.calculation_method.replaceAll("_", " ")}</span>
                            </div>
                            <p className="mt-1 text-[10px] leading-4 text-slate-500">{component.guidance}</p>
                            <p className="mt-1 text-[9px] text-slate-400">{component.is_required ? "Required" : "Optional"} · Bases: {(component.base_categories ?? []).join(", ") || "None"}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {profileDetail.status === "DRAFT" && canSubmitProfiles ? (
                        <button type="button" className={PRIMARY} disabled={busy} onClick={() => setTransition({ profileId: profileDetail.id, action: "SUBMIT", version: versionNumber(profileDetail.row_version), reason: "" })}>Submit for approval</button>
                      ) : null}
                      {profileDetail.status === "PENDING_APPROVAL" && canApproveProfiles && !isProfileCreator ? <>
                        <button type="button" className={PRIMARY} disabled={busy} onClick={() => setTransition({ profileId: profileDetail.id, action: "APPROVE", version: versionNumber(profileDetail.row_version), reason: "" })}>Approve & make current</button>
                        <button type="button" className={DANGER} disabled={busy} onClick={() => setTransition({ profileId: profileDetail.id, action: "REJECT", version: versionNumber(profileDetail.row_version), reason: "" })}>Reject</button>
                      </> : null}
                      {profileDetail.status === "PENDING_APPROVAL" && isProfileCreator ? (
                        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[10px] leading-4 text-amber-900">Maker-checker enforced: the profile creator cannot approve or reject this profile version.</p>
                      ) : null}
                    </div>
                    <div className="border-t border-slate-100 pt-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Governance history</p>
                      {!(profileDetail.history ?? []).length ? <p className="mt-2 text-[11px] text-slate-500">No profile history rows returned.</p> : (
                        <ol className="mt-2 space-y-2">
                          {(profileDetail.history ?? []).map((entry) => (
                            <li key={String(entry.id)} className="border-l-2 border-slate-200 pl-3">
                              <p className="text-[11px] font-bold text-slate-800">{display(entry.action)}</p>
                              <p className="mt-0.5 text-[10px] leading-4 text-slate-500">{display(entry.reason)} · {dateTime(entry.created_at)}</p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </>
                )}
              </aside>
            </section>
          ) : null}

          {tab === "ASSESSMENTS" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
                  <div>
                    <h2 className="text-sm font-bold text-slate-950">Deterministic cost assessment register</h2>
                    <p className="mt-1 text-[11px] text-slate-500">Each assessment locks its profile version and evidence snapshot.</p>
                  </div>
                  {canCalculateAssessments ? <button type="button" className={PRIMARY} onClick={() => { setNewAssessment(assessmentDraft()); setCreateAssessmentOpen(true); }}>Calculate assessment</button> : null}
                </div>
                <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[190px_1fr_auto]">
                  <select aria-label="Assessment scope filter" className={INPUT} value={assessmentScopeFilter} onChange={(event) => setAssessmentScopeFilter(event.target.value)}>
                    <option value="ALL">All target scopes</option>
                    <option value="PRODUCT_VERSION">Product version</option>
                    <option value="ORDER">Order</option>
                    <option value="QUOTATION">Quotation</option>
                  </select>
                  <input aria-label="Target UUID filter" className={INPUT} placeholder="Optional target UUID" value={assessmentTargetFilter} onChange={(event) => setAssessmentTargetFilter(event.target.value)} />
                  <button type="button" className={SECONDARY} onClick={() => void load()} disabled={loading}>Apply</button>
                </div>
                {!canReadAssessments ? <Empty>Assessment read access is not included in your current permissions.</Empty> : assessments.length === 0 ? <Empty>No should-cost assessments match the current filters.</Empty> : (
                  <div className="divide-y divide-slate-100">
                    {assessments.map((assessment) => (
                      <button
                        key={assessment.id}
                        type="button"
                        onClick={() => setSelectedAssessmentId(assessment.id)}
                        className={"flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 " + (selectedAssessmentId === assessment.id ? "bg-emerald-50/70" : "")}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-slate-900">{assessment.scope_type.replaceAll("_", " ")} · {shortId(assessment.scope_id)}</span>
                          <span className="mt-1 block truncate text-[10px] text-slate-500">{assessment.profile_code} v{assessment.profile_version} · {assessment.target_quantity} {assessment.target_unit}</span>
                          <span className="mt-1 block text-[10px] text-slate-400">{dateTime(assessment.created_at)}</span>
                        </span>
                        <span className="text-right">
                          <span className="block text-xs font-bold tabular-nums text-slate-900">{formatShouldCostMoney(assessment.total_cost, assessment.currency)}</span>
                          <span className="mt-1 block text-[10px] text-slate-500">{assessment.currency} / {assessment.target_unit}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="border-t border-slate-100 px-4 py-3 text-[10px] text-slate-500">The API returns at most 100 assessment records per request; this view requests the latest 20.</div>
              </div>

              <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h2 className="text-sm font-bold text-slate-950">Assessment result & evidence</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Calculated amounts come from the backend fixed-precision formula engine.</p>
                </div>
                {!selectedAssessment ? <Empty>Select an assessment to inspect cost breakdown, revenue and traceable evidence.</Empty> : assessmentDetailLoading ? <Empty>Loading full assessment and evidence…</Empty> : !assessmentDetail ? <Empty>Assessment detail is not available.</Empty> : (
                  <>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-slate-900">{assessmentDetail.profile_code} · v{assessmentDetail.profile_version}</p>
                        <StatusPill value={assessmentDetail.status} />
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">{assessmentDetail.scope_type.replaceAll("_", " ")} · {shortId(assessmentDetail.scope_id)} · {assessmentDetail.target_quantity} {assessmentDetail.target_unit}</p>
                      <p className="mt-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Total should-cost</p>
                      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-950">{formatShouldCostMoney(assessmentDetail.total_cost, assessmentDetail.currency)}</p>
                      <p className="mt-1 text-[11px] text-slate-500">{formatShouldCostMoney(assessmentDetail.cost_per_unit, assessmentDetail.currency, 8)} per {assessmentDetail.target_unit}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Cost category totals</p>
                      <div className="mt-2 space-y-2">
                        {CATEGORIES.map((category) => {
                          const totals = object(assessmentDetail.component_totals);
                          const value = totals[category];
                          const amount = Number(value);
                          const all = Number(assessmentDetail.total_cost);
                          const share = Number.isFinite(amount) && all > 0 ? Math.max(0, Math.min(100, amount / all * 100)) : 0;
                          return (
                            <div key={category}>
                              <div className="flex items-center justify-between gap-2 text-[10px]">
                                <span className="font-semibold text-slate-700">{labelCategory(category)}</span>
                                <span className="tabular-nums text-slate-800">{formatShouldCostMoney(value, assessmentDetail.currency)}</span>
                              </div>
                              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-600" style={{ width: share + "%" }} /></div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {assessmentDetail.revenue_amount !== null && assessmentDetail.revenue_amount !== undefined ? (
                      <div className="rounded-xl border border-slate-200 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Gross margin</p>
                        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-lg font-bold tabular-nums text-slate-950">{formatShouldCostMoney(assessmentDetail.gross_margin_amount, assessmentDetail.currency)}</p>
                          <p className={"text-sm font-bold " + (
                            shouldCostMarginTone(assessmentDetail.gross_margin_percent) === "NEGATIVE" || shouldCostMarginTone(assessmentDetail.gross_margin_percent) === "LOW"
                              ? "text-rose-700" : "text-emerald-700"
                          )}>{assessmentDetail.gross_margin_percent === null ? "—" : Number(assessmentDetail.gross_margin_percent).toFixed(2) + "%"}</p>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-500">Revenue {formatShouldCostMoney(assessmentDetail.revenue_amount, assessmentDetail.currency)} · Source currency {display(assessmentDetail.revenue_source_currency)}</p>
                        <p className="mt-1 text-[9px] leading-4 text-slate-400">Margin uses the backend revenue and effective FX snapshot for this target. It is not a selling-price recommendation.</p>
                      </div>
                    ) : (
                      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[10px] leading-4 text-slate-600">Product-version assessments calculate cost only. Revenue and gross margin are not available for this scope.</p>
                    )}
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Evidence ledger</p>
                      <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
                        {(assessmentDetail.evidence ?? []).map((line) => (
                          <article key={String(line.id)} className="rounded-lg border border-slate-200 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-[10px] font-bold text-slate-900">{labelCategory(String(line.category))}</p>
                              <span className="rounded-md bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-700">{display(line.source_type)}</span>
                            </div>
                            <p className="mt-1 break-words text-[10px] text-slate-600">{display(line.source_reference, "Not applicable")} · as of {display(line.source_as_of)}</p>
                            <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px]">
                              <span className="text-slate-500">{line.input_quantity ? numberValue(line.input_quantity) + " " + display(line.unit_code) + " × " + display(line.unit_rate) : "Input " + display(line.fixed_amount ?? line.percentage_rate)}</span>
                              <span className="font-bold tabular-nums text-slate-900">{formatShouldCostMoney(line.cost_amount, assessmentDetail.currency)}</span>
                            </div>
                            <p className="mt-1 text-[9px] leading-4 text-slate-500">{display(line.notes)}</p>
                          </article>
                        ))}
                      </div>
                    </div>
                    <div className="border-t border-slate-100 pt-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Calculation history</p>
                      {(assessmentDetail.history ?? []).length === 0 ? <p className="mt-2 text-[10px] text-slate-500">No history rows returned.</p> : (
                        <ol className="mt-2 space-y-2">
                          {(assessmentDetail.history ?? []).map((entry) => (
                            <li key={String(entry.id)} className="border-l-2 border-slate-200 pl-3">
                              <p className="text-[10px] font-bold text-slate-800">{display(entry.action)}</p>
                              <p className="mt-0.5 text-[9px] leading-4 text-slate-500">{display(entry.reason)} · {dateTime(entry.created_at)}</p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </>
                )}
              </aside>
            </section>
          ) : null}
        </>
      ) : null}

      {createProfileOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <form onSubmit={createProfile} className="my-5 w-full max-w-5xl rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-950">Create should-cost profile version</h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">All seven cost categories are required in every profile. A created profile starts as DRAFT and must pass a separate submit/approve cycle before any assessment can use it.</p>
              </div>
              <button type="button" className={SECONDARY} onClick={() => setCreateProfileOpen(false)}>Close</button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Profile code"><input required maxLength={100} className={INPUT} placeholder="STANDARD-APPAREL" value={newProfile.profile_code} onChange={(event) => setNewProfile({ ...newProfile, profile_code: event.target.value })} /></Field>
              <Field label="Cost currency"><input required maxLength={3} minLength={3} className={INPUT} value={newProfile.currency} onChange={(event) => setNewProfile({ ...newProfile, currency: event.target.value.toUpperCase() })} /></Field>
              <Field label="Output unit"><input required maxLength={50} className={INPUT} placeholder="PCS" value={newProfile.output_unit} onChange={(event) => setNewProfile({ ...newProfile, output_unit: event.target.value.toUpperCase() })} /></Field>
              <Field label="Product ID (optional)" hint="Leave blank for a factory-level costing policy.">
                <input className={INPUT} placeholder="Active product UUID" value={newProfile.product_id} onChange={(event) => setNewProfile({ ...newProfile, product_id: event.target.value })} />
              </Field>
            </div>
            <div className="mt-5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div><h3 className="text-sm font-bold text-slate-950">Cost formula design</h3><p className="mt-1 text-[10px] text-slate-500">Percentage and scrap formulas can reference earlier categories only; the order is fixed.</p></div>
                <span className="text-[10px] font-semibold text-slate-500">7 of 7 categories</span>
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {newProfile.components.map((component) => {
                  const index = CATEGORIES.indexOf(component.category);
                  const availableBases = CATEGORIES.slice(0, index);
                  const needsBase = ["PERCENT_OF_BASE", "SCRAP_GROSS_UP"].includes(component.calculation_method);
                  return (
                    <article key={component.category} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-bold text-slate-950">{labelCategory(component.category)}</p>
                        <label className="flex items-center gap-2 text-[10px] font-semibold text-slate-600">
                          <input type="checkbox" checked={component.is_required} onChange={(event) => updateProfileComponent(component.category, { is_required: event.target.checked })} />
                          Required
                        </label>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Field label="Calculation method">
                          <select className={INPUT} value={component.calculation_method} onChange={(event) => updateProfileComponent(component.category, { calculation_method: event.target.value as ShouldCostMethod, base_categories: [] })}>
                            {METHODS_BY_CATEGORY[component.category].map((method) => <option key={method} value={method}>{method.replaceAll("_", " ")}</option>)}
                          </select>
                        </Field>
                        <Field label="Formula input" hint={needsBase ? "Select one or more earlier cost categories below." : component.calculation_method === "DIRECT_RATE" ? "Quantity × unit rate × effective FX." : "Fixed amount per production batch."}>
                          <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-700">{component.calculation_method.replaceAll("_", " ")}</div>
                        </Field>
                      </div>
                      {needsBase ? (
                        <div className="mt-3">
                          <p className="mb-2 text-[10px] font-semibold text-slate-600">Base categories</p>
                          <div className="flex flex-wrap gap-2">
                            {availableBases.map((base) => (
                              <label key={base} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[10px] text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={component.base_categories.includes(base)}
                                  onChange={(event) => updateProfileComponent(component.category, {
                                    base_categories: event.target.checked
                                      ? [...component.base_categories, base]
                                      : component.base_categories.filter((value) => value !== base),
                                  })}
                                />
                                {labelCategory(base)}
                              </label>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <div className="mt-3">
                        <Field label="Calculation guidance">
                          <textarea required maxLength={1000} rows={2} className={AREA} value={component.guidance} onChange={(event) => updateProfileComponent(component.category, { guidance: event.target.value })} />
                        </Field>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setCreateProfileOpen(false)}>Cancel</button>
              <button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Creating…" : "Create versioned draft"}</button>
            </div>
          </form>
        </div>
      ) : null}

      {transition ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:items-center">
          <form onSubmit={submitTransition} className="my-6 w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <h2 className="text-lg font-bold text-slate-950">{transition.action === "SUBMIT" ? "Submit profile for approval" : transition.action === "APPROVE" ? "Approve costing profile" : "Reject costing profile"}</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Expected row version {transition.version}. {transition.action === "APPROVE" ? "Approval makes this version current and retires the previous current profile." : "The API checks the current profile state and version before saving."}
            </p>
            <div className="mt-4">
              <Field label="Governance reason" hint="Required, maximum 1000 characters. The reason is retained in profile history.">
                <textarea required maxLength={1000} rows={4} className={AREA} value={transition.reason} onChange={(event) => setTransition({ ...transition, reason: event.target.value })} />
              </Field>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setTransition(null)}>Cancel</button>
              <button type="submit" className={transition.action === "REJECT" ? DANGER : PRIMARY} disabled={busy || transition.version < 1}>{busy ? "Saving…" : "Confirm " + transition.action.toLowerCase()}</button>
            </div>
          </form>
        </div>
      ) : null}

      {createAssessmentOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <form onSubmit={createAssessment} className="my-5 w-full max-w-6xl rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-950">Calculate should-cost assessment</h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">The backend calculates seven-category costs using the selected current approved profile. Evidence snapshots and effective FX rates are stored with the assessment.</p>
              </div>
              <button type="button" className={SECONDARY} onClick={() => setCreateAssessmentOpen(false)}>Close</button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Target scope">
                <select className={INPUT} value={newAssessment.scope_type} onChange={(event) => setNewAssessment({ ...newAssessment, scope_type: event.target.value as AssessmentDraft["scope_type"] })}>
                  <option value="PRODUCT_VERSION">Approved product version</option>
                  <option value="ORDER">Sales order</option>
                  <option value="QUOTATION">Current quotation revision</option>
                </select>
              </Field>
              <Field label="Target record UUID" hint="Must belong to the selected factory.">
                <input required className={INPUT} value={newAssessment.target_id} onChange={(event) => setNewAssessment({ ...newAssessment, target_id: event.target.value })} />
              </Field>
              <Field label="Approved profile">
                <select required className={INPUT} value={newAssessment.profile_id} onChange={(event) => setNewAssessment({ ...newAssessment, profile_id: event.target.value })}>
                  <option value="">Select current approved profile</option>
                  {approvedProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.profile_code} v{profile.version} · {profile.currency}/{profile.output_unit}</option>)}
                </select>
              </Field>
              <Field label="Target quantity">
                <input required type="number" min="0.0001" max="99999999999999" step="0.0001" className={INPUT} value={newAssessment.target_quantity} onChange={(event) => setNewAssessment({ ...newAssessment, target_quantity: event.target.value })} />
              </Field>
              <Field label="Target unit">
                <input required maxLength={50} className={INPUT} value={newAssessment.target_unit} onChange={(event) => setNewAssessment({ ...newAssessment, target_unit: event.target.value.toUpperCase() })} />
              </Field>
            </div>
            {newAssessment.scope_type === "PRODUCT_VERSION" ? (
              <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-[10px] leading-4 text-blue-900">Product-version costing requires an APPROVED version. Product-specific profiles can only assess their own product version. This scope calculates cost only; no revenue margin is derived.</p>
            ) : (
              <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-[10px] leading-4 text-blue-900">The target order/quotation must be open and in this factory. Revenue and gross margin are resolved from the current target and effective exchange-rate records by the API.</p>
            )}
            <div className="mt-5 flex flex-wrap items-end justify-between gap-2">
              <div><h3 className="text-sm font-bold text-slate-950">Seven evidence lines</h3><p className="mt-1 text-[10px] text-slate-500">This form uses manual-approved quantity snapshots for material, labour and energy. FX conversion is resolved from the factory exchange-rate register.</p></div>
              <span className="text-[10px] font-semibold text-slate-500">{assessmentProfileDetail ? "Profile detail loaded" : "Select profile to load formulas"}</span>
            </div>
            {!assessmentProfileDetail ? <Empty>Select an approved profile to load its formulas before entering evidence.</Empty> : assessmentProfileDetail.status !== "APPROVED" || assessmentProfileDetail.is_current !== true ? (
              <Empty>The selected profile is not the current approved version. Choose another profile or complete independent approval first.</Empty>
            ) : (
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {newAssessment.evidence.map((line) => {
                  const component = assessmentProfileDetail.components?.find((entry) => entry.category === line.category);
                  const method = component?.calculation_method;
                  const categoryNeedsQuantity = ["MATERIAL", "LABOUR", "ENERGY"].includes(line.category) && method === "DIRECT_RATE";
                  return (
                    <article key={line.category} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div><h4 className="text-xs font-bold text-slate-950">{labelCategory(line.category)}</h4><p className="mt-1 text-[9px] text-slate-500">{method?.replaceAll("_", " ") ?? "Formula unavailable"} · {component?.is_required ? "Required" : "Optional"}</p></div>
                        {component?.is_required === false ? (
                          <label className="flex items-center gap-2 text-[10px] font-semibold text-slate-600">
                            <input type="checkbox" checked={line.applicable} onChange={(event) => updateEvidence(line.category, { applicable: event.target.checked })} />
                            Applicable
                          </label>
                        ) : <span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-800">Required</span>}
                      </div>
                      {line.applicable ? (
                        <>
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <Field label="Evidence source type">
                              <select className={INPUT} value={line.source_type} onChange={(event) => updateEvidence(line.category, { source_type: event.target.value })}>
                                {SOURCE_TYPES.map((source) => <option key={source} value={source}>{source.replaceAll("_", " ")}</option>)}
                              </select>
                            </Field>
                            <Field label="Source reference">
                              <input required maxLength={500} className={INPUT} placeholder="Quote, purchase order, policy ID…" value={line.source_reference} onChange={(event) => updateEvidence(line.category, { source_reference: event.target.value })} />
                            </Field>
                            <Field label="Source date">
                              <input required type="date" max={localDate()} className={INPUT} value={line.source_as_of} onChange={(event) => updateEvidence(line.category, { source_as_of: event.target.value })} />
                            </Field>
                            {method === "DIRECT_RATE" ? <>
                              <Field label="Input quantity">
                                <input required type="number" min="0" step="0.000001" className={INPUT} value={line.input_quantity} onChange={(event) => updateEvidence(line.category, { input_quantity: event.target.value })} />
                              </Field>
                              <Field label="Unit code">
                                <input required maxLength={50} className={INPUT} value={line.unit_code} onChange={(event) => updateEvidence(line.category, { unit_code: event.target.value.toUpperCase() })} />
                              </Field>
                              <Field label="Unit rate">
                                <input required type="number" min="0" step="0.00000001" className={INPUT} value={line.unit_rate} onChange={(event) => updateEvidence(line.category, { unit_rate: event.target.value })} />
                              </Field>
                              <Field label="Source currency">
                                <input required maxLength={3} minLength={3} className={INPUT} value={line.source_currency} onChange={(event) => updateEvidence(line.category, { source_currency: event.target.value.toUpperCase() })} />
                              </Field>
                            </> : null}
                            {method === "FIXED_PER_BATCH" ? <>
                              <Field label="Fixed batch amount">
                                <input required type="number" min="0" step="0.0001" className={INPUT} value={line.fixed_amount} onChange={(event) => updateEvidence(line.category, { fixed_amount: event.target.value })} />
                              </Field>
                              <Field label="Source currency">
                                <input required maxLength={3} minLength={3} className={INPUT} value={line.source_currency} onChange={(event) => updateEvidence(line.category, { source_currency: event.target.value.toUpperCase() })} />
                              </Field>
                            </> : null}
                            {["PERCENT_OF_BASE", "SCRAP_GROSS_UP"].includes(method ?? "") ? (
                              <Field label="Percentage rate">
                                <input required type="number" min="0" max={method === "SCRAP_GROSS_UP" ? "99.9999" : "100"} step="0.0001" className={INPUT} value={line.percentage_rate} onChange={(event) => updateEvidence(line.category, { percentage_rate: event.target.value })} />
                              </Field>
                            ) : null}
                          </div>
                          {categoryNeedsQuantity ? (
                            <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/60 p-3">
                              <p className="text-[10px] font-bold text-blue-950">Manual-approved quantity lineage</p>
                              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                <Field label="Approved quantity reference">
                                  <input required maxLength={500} className={INPUT} value={line.quantity_source_reference} onChange={(event) => updateEvidence(line.category, { quantity_source_reference: event.target.value })} />
                                </Field>
                                <Field label="Quantity approval snapshot (JSON)">
                                  <textarea required rows={3} spellCheck={false} className={AREA + " font-mono text-[10px]"} value={line.quantity_source_snapshot} onChange={(event) => updateEvidence(line.category, { quantity_source_snapshot: event.target.value })} />
                                </Field>
                              </div>
                              <p className="mt-1 text-[9px] leading-4 text-blue-900">The API stores this snapshot; it does not treat a manually entered quantity as a BOM, routing or meter reading.</p>
                            </div>
                          ) : null}
                          <div className="mt-3">
                            <Field label="Rate/source snapshot (JSON)" hint="Store approved source identifiers and basis; do not paste passwords or secret material.">
                              <textarea required rows={3} spellCheck={false} className={AREA + " font-mono text-[10px]"} value={line.source_snapshot} onChange={(event) => updateEvidence(line.category, { source_snapshot: event.target.value })} />
                            </Field>
                          </div>
                        </>
                      ) : null}
                      <div className="mt-3">
                        <Field label={line.applicable ? "Evidence notes" : "Why not applicable"} hint="Required for all categories, including optional categories marked not applicable.">
                          <textarea required maxLength={2000} rows={2} className={AREA} value={line.notes} onChange={(event) => updateEvidence(line.category, { notes: event.target.value })} />
                        </Field>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <p className="max-w-2xl text-[10px] leading-4 text-slate-500">Calculation is performed only when submitted. The API checks target existence/state, profile current-version status, source dates, quantity lineage, formula compatibility and applicable FX records.</p>
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className={SECONDARY} onClick={() => setCreateAssessmentOpen(false)}>Cancel</button>
                <button type="submit" className={PRIMARY} disabled={busy || !assessmentProfileDetail || assessmentProfileDetail.status !== "APPROVED" || assessmentProfileDetail.is_current !== true}>{busy ? "Calculating…" : "Calculate & store assessment"}</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function shortId(value: unknown) {
  return typeof value === "string" ? value.slice(0, 8).toUpperCase() : "—";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—";
}
