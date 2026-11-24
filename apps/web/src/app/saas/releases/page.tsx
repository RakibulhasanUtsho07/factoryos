"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildCreateReleasePayload,
  buildDeploymentProfilePayload,
  buildDeploymentProfileTransitionPayload,
  buildPhysicalOperationPayload,
  buildReleasePromotionPayload,
  buildReleaseRollbackPayload,
  buildReleaseTransitionPayload,
  createSaasReleaseControlClient,
  normalizePhysicalRunDetail,
  normalizePhysicalRunRows,
  normalizeSaasRows,
  summarizeDeploymentProfiles,
  summarizeReleaseRollouts,
} from "@/lib/saas-release-control-plane.mjs";
import type { SaasReleaseControlClient } from "@/lib/saas-release-control-plane.mjs";

type Row = Record<string, unknown>;
type Tab = "RELEASES" | "DEPLOYMENT" | "PHYSICAL";
type Scope = "ORGANIZATION" | "FACTORY" | "MODULE" | "AGENT";
type Channel = "STABLE" | "PREVIEW" | "EXPERIMENTAL";
type ProfileScope = "TENANT" | "FACTORY";
type ProfileType = "SHARED_SAAS" | "SINGLE_TENANT" | "DEDICATED_VPC" | "HYBRID_EDGE_CLOUD";
type PhysicalTarget = { kind: "RELEASE"; key: string; version: number } | { kind: "PROFILE"; id: string; version: number };

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const BUTTON = "inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = BUTTON + " bg-slate-950 text-white hover:bg-slate-800";
const SECONDARY = BUTTON + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const DANGER = BUTTON + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function textOf(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function dateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function errorOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The SaaS control-plane request could not be completed.";
}
function digestShort(value: unknown): string {
  const digest = textOf(value, "");
  return digest ? digest.slice(0, 12) + "…" + digest.slice(-8) : "Not recorded";
}
function stageClass(value: string): string {
  if (value === "PRODUCTION" || value === "ACTIVE" || value === "SUCCEEDED" || value === "ROLLED_BACK") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (value === "CANARY" || value === "IN_PROGRESS" || value === "PROVISIONING" || value === "MIGRATING") return "border-blue-200 bg-blue-50 text-blue-800";
  if (value === "FAILED" || value === "HALTED" || value === "ROLLBACK_FAILED") return "border-rose-200 bg-rose-50 text-rose-800";
  if (value === "PAUSED" || value === "ROLLBACK_IN_PROGRESS") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-slate-200 bg-slate-100 text-slate-700";
}
function Badge({ value }: { value: string }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " + stageClass(value)}>{value.replaceAll("_", " ")}</span>;
}
function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div><h2 className="text-sm font-bold text-slate-950">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{subtitle}</p> : null}</div>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>{children}{hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}</label>;
}
function Metric({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return <article className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-[10px] text-slate-500">{hint}</p></article>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs leading-5 text-slate-500">{children}</div>;
}
function safeEvidenceSummary(value: unknown): string[] {
  const evidence = row(value);
  const lines: string[] = [];
  for (const key of ["topology", "isolationVerified", "storageProvisioned", "datasetMaterialized", "datasetMode", "artifactDigest", "controlPlanePaused", "failurePolicy"]) {
    if (evidence[key] !== undefined && evidence[key] !== null) lines.push(key + ": " + String(evidence[key]));
  }
  const health = row(evidence.healthCheck);
  if (typeof health.healthy === "boolean") lines.push("healthCheck.healthy: " + String(health.healthy));
  if (typeof health.checkedAt === "string") lines.push("healthCheck.checkedAt: " + dateTime(health.checkedAt));
  return lines;
}

export default function SaasReleaseControlPlanePage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(snapshot);
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const client = useMemo<SaasReleaseControlClient>(() => createSaasReleaseControlClient(request), [request]);

  const canReleaseRead = hasPermission("saas.releases.read");
  const canReleaseWrite = hasPermission("saas.releases.write");
  const canReleasePromote = hasPermission("saas.releases.promote");
  const canReleaseControl = hasPermission("saas.releases.control");
  const canReleaseRollback = hasPermission("saas.releases.rollback");
  const canProfileRead = hasPermission("saas.deployment_profiles.read");
  const canProfileWrite = hasPermission("saas.deployment_profiles.write");
  const canProfileControl = hasPermission("saas.deployment_profiles.control");
  const canPhysicalRead = hasPermission("saas.physical_provisioning.read");
  const canDeployRelease = canReleasePromote && (canReleaseControl || canReleaseRollback);

  const [tab, setTab] = useState<Tab>("RELEASES");
  const [releases, setReleases] = useState<Row[]>([]);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [effectiveProfile, setEffectiveProfile] = useState<Row | null>(null);
  const [runs, setRuns] = useState<Row[]>([]);
  const [selectedReleaseKey, setSelectedReleaseKey] = useState("");
  const [selectedRelease, setSelectedRelease] = useState<Row | null>(null);
  const [releaseHistory, setReleaseHistory] = useState<Row[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<Row | null>(null);
  const [profileHistory, setProfileHistory] = useState<Row[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<Row | null>(null);
  const [runEvents, setRunEvents] = useState<Row[]>([]);
  const [resolveResult, setResolveResult] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const [showReleaseForm, setShowReleaseForm] = useState(false);
  const [releaseDraft, setReleaseDraft] = useState({
    rollout_key: "", scope_type: "ORGANIZATION" as Scope, factory_id: "", module_key: "", agent_key: "",
    release_channel: "STABLE" as Channel, artifact_version: "", artifact_digest: "",
    evaluation_reference: "", reason: "",
  });
  const [promotionDraft, setPromotionDraft] = useState({ stage: "CANARY" as "CANARY" | "PRODUCTION", rollout_percentage: "10", reason: "" });
  const [releaseTransitionDraft, setReleaseTransitionDraft] = useState({ action: "PAUSE" as "PAUSE" | "RESUME" | "RETIRE", reason: "" });
  const [rollbackDraft, setRollbackDraft] = useState({ target_rollout_key: "", target_version: "", reason: "" });
  const [resolveDraft, setResolveDraft] = useState({ channel: "STABLE" as Channel, subject_key: "", module_key: "", agent_key: "" });

  const [showProfileForm, setShowProfileForm] = useState(false);
  const [profileDraft, setProfileDraft] = useState({
    scope_type: "TENANT" as ProfileScope, profile_type: "SHARED_SAAS" as ProfileType,
    deployment_reference: "", region_code: "", residency_domain: "", edge_site_code: "", reason: "",
  });
  const [profileTransitionDraft, setProfileTransitionDraft] = useState({
    action: "PAUSE", target_profile_type: "DEDICATED_VPC" as ProfileType,
    target_deployment_reference: "", target_region_code: "", target_residency_domain: "", target_edge_site_code: "", reason: "",
  });

  const [physicalTarget, setPhysicalTarget] = useState<PhysicalTarget | null>(null);
  const [physicalPolicy, setPhysicalPolicy] = useState<"HALT" | "ROLLBACK">(canReleaseControl ? "HALT" : "ROLLBACK");
  const [healthTimeout, setHealthTimeout] = useState("60");
  const [physicalAcknowledged, setPhysicalAcknowledged] = useState(false);

  const releaseSummary = useMemo(() => summarizeReleaseRollouts(releases), [releases]);
  const profileSummary = useMemo(() => summarizeDeploymentProfiles(profiles), [profiles]);
  const selectedReleaseStage = textOf(selectedRelease?.stage, "");
  const selectedProfileStatus = textOf(selectedProfile?.status, "");
  const releaseRollbackTargets = releases.filter((item) =>
    textOf(item.rolloutKey) !== selectedReleaseKey
    && textOf(item.scopeType) === textOf(selectedRelease?.scopeType)
    && textOf(item.factoryId, "") === textOf(selectedRelease?.factoryId, "")
    && textOf(item.moduleKey, "") === textOf(selectedRelease?.moduleKey, "")
    && textOf(item.agentKey, "") === textOf(selectedRelease?.agentKey, "")
    && textOf(item.channel) === textOf(selectedRelease?.channel)
    && ["CANARY", "PRODUCTION"].includes(textOf(item.stage)),
  );

  const refreshAll = useCallback(() => {
    setLoading(true);
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!connected) {
        await Promise.resolve();
        if (live) {
          setReleases([]); setProfiles([]); setEffectiveProfile(null); setRuns([]);
          setSelectedRelease(null); setSelectedProfile(null); setSelectedRun(null); setLoading(false);
        }
        return;
      }
      const [releaseResult, profileResult, effectiveResult, runResult] = await Promise.allSettled([
        canReleaseRead ? client.listReleases() : Promise.resolve({ items: [] }),
        canProfileRead ? client.listProfiles(activeFactoryId || undefined) : Promise.resolve([]),
        canProfileRead ? client.effectiveProfile(activeFactoryId || undefined) : Promise.resolve(null),
        canPhysicalRead ? client.listPhysicalRuns(25, 0) : Promise.resolve({ runs: [] }),
      ]);
      if (!live) return;
      if (releaseResult.status === "fulfilled") {
        const next = normalizeSaasRows(releaseResult.value).map(row);
        setReleases(next);
        setSelectedReleaseKey((current) => next.some((item) => textOf(item.rolloutKey, "") === current)
          ? current : textOf(next[0]?.rolloutKey, ""));
        setLoadError("");
      } else if (canReleaseRead) setLoadError(errorOf(releaseResult.reason));
      if (profileResult.status === "fulfilled") {
        const next = normalizeSaasRows(profileResult.value, ["profiles", "items"]).map(row);
        setProfiles(next);
        setSelectedProfileId((current) => next.some((item) => textOf(item.id, "") === current)
          ? current : textOf(next[0]?.id, ""));
      } else if (canProfileRead) setLoadError(errorOf(profileResult.reason));
      if (effectiveResult.status === "fulfilled") {
        const root = row(effectiveResult.value);
        setEffectiveProfile(Object.keys(row(root.profile)).length ? row(root.profile) : null);
      }
      if (runResult.status === "fulfilled") {
        setRuns(normalizePhysicalRunRows(runResult.value).map(row));
      } else if (canPhysicalRead) setLoadError(errorOf(runResult.reason));
      setLoading(false);
    };
    void load();
    return () => { live = false; };
  }, [connected, client, activeFactoryId, canReleaseRead, canProfileRead, canPhysicalRead, refreshTick]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!connected || !canReleaseRead || !selectedReleaseKey) {
        await Promise.resolve();
        if (live) { setSelectedRelease(null); setReleaseHistory([]); }
        return;
      }
      try {
        const [history, current] = await Promise.all([
          client.releaseHistory(selectedReleaseKey),
          Promise.resolve(releases.find((item) => textOf(item.rolloutKey, "") === selectedReleaseKey) ?? null),
        ]);
        if (live) {
          setReleaseHistory(normalizeSaasRows(history).map(row));
          setSelectedRelease(current ? row(current) : null);
          setDetailError("");
        }
      } catch (cause) { if (live) setDetailError(errorOf(cause)); }
    };
    void load();
    return () => { live = false; };
  }, [connected, canReleaseRead, client, selectedReleaseKey, releases]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!connected || !canProfileRead || !selectedProfileId) {
        await Promise.resolve();
        if (live) { setSelectedProfile(null); setProfileHistory([]); }
        return;
      }
      const current = profiles.find((item) => textOf(item.id, "") === selectedProfileId) ?? null;
      if (live) setSelectedProfile(current ? row(current) : null);
      try {
        const history = textOf(current?.scopeType) === "FACTORY" && textOf(current?.factoryId, "")
          ? await client.factoryProfileHistory(textOf(current?.factoryId))
          : await client.tenantProfileHistory();
        if (live) setProfileHistory(normalizeSaasRows(history).map(row));
      } catch (cause) { if (live) setDetailError(errorOf(cause)); }
    };
    void load();
    return () => { live = false; };
  }, [connected, canProfileRead, client, selectedProfileId, profiles]);

  const chooseRun = async (runId: string) => {
    setSelectedRunId(runId);
    setSelectedRun(null);
    setRunEvents([]);
    setDetailLoading(true);
    setDetailError("");
    try {
      const detail = normalizePhysicalRunDetail(await client.getPhysicalRun(runId));
      setSelectedRun(detail.run);
      setRunEvents(detail.events.map(row));
    } catch (cause) { setDetailError(errorOf(cause)); }
    finally { setDetailLoading(false); }
  };

  const submitCreateRelease = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setNotice(null);
    try {
      const payload = buildCreateReleasePayload({
        ...releaseDraft,
        factory_id: releaseDraft.scope_type === "FACTORY" ? activeFactoryId || "" : releaseDraft.factory_id,
        idempotency_key: globalThis.crypto.randomUUID(),
      });
      const result = row(await client.createRelease(payload));
      const key = textOf(row(result.rollout).rolloutKey, releaseDraft.rollout_key.toUpperCase());
      setNotice({ tone: "success", message: "Release candidate " + key + " was registered in DRAFT. Registration does not deploy or activate an artifact." });
      setShowReleaseForm(false);
      setReleaseDraft((current) => ({ ...current, rollout_key: "", artifact_version: "", artifact_digest: "", evaluation_reference: "", reason: "" }));
      setSelectedReleaseKey(key);
      refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };

  const submitPromotion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRelease) return;
    setBusy(true); setNotice(null);
    try {
      const payload = buildReleasePromotionPayload({
        ...promotionDraft, stage: targetPromotionStage, expected_version: Number(selectedRelease.version),
        rollout_percentage: targetPromotionStage === "PRODUCTION" ? 100 : Number(promotionDraft.rollout_percentage), idempotency_key: globalThis.crypto.randomUUID(),
      });
      const result = row(await client.promoteRelease(selectedReleaseKey, payload));
      const next = row(result.rollout);
      setNotice({ tone: "success", message: selectedReleaseKey + " control-plane stage updated to " + textOf(next.stage, promotionDraft.stage) + ". A physical deployment receipt is still required before release resolution can select this artifact." });
      refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };

  const submitReleaseTransition = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRelease) return;
    setBusy(true); setNotice(null);
    try {
      await client.transitionRelease(selectedReleaseKey, buildReleaseTransitionPayload({
        ...releaseTransitionDraft, action: effectiveReleaseTransitionAction, expected_version: Number(selectedRelease.version),
        idempotency_key: globalThis.crypto.randomUUID(),
      }));
      setNotice({ tone: "success", message: selectedReleaseKey + " transition " + effectiveReleaseTransitionAction + " was recorded." });
      refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };

  const submitRollback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRelease) return;
    setBusy(true); setNotice(null);
    try {
      const payload = buildReleaseRollbackPayload({
        ...rollbackDraft, expected_version: Number(selectedRelease.version),
        target_version: Number(rollbackDraft.target_version), idempotency_key: globalThis.crypto.randomUUID(),
      });
      await client.rollbackRelease(selectedReleaseKey, payload);
      setNotice({ tone: "success", message: "Control-plane rollback target was recorded. The physical release provider must still complete and verify the rollback before resolution can use it." });
      refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };

  const submitProfileCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setNotice(null);
    try {
      const payload = buildDeploymentProfilePayload({
        ...profileDraft,
        factory_id: profileDraft.scope_type === "FACTORY" ? activeFactoryId : "",
        idempotency_key: globalThis.crypto.randomUUID(),
      });
      const result = row(await client.createProfile(payload));
      const profile = row(result.profile);
      setNotice({ tone: "success", message: "Deployment profile " + textOf(profile.profileType, profileDraft.profile_type) + " was registered as " + textOf(profile.status, "PLANNED") + ". It is not physically provisioned or effective yet." });
      setShowProfileForm(false);
      setProfileDraft((current) => ({ ...current, deployment_reference: "", region_code: "", residency_domain: "", edge_site_code: "", reason: "" }));
      refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };

  const submitProfileTransition = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProfile) return;
    setBusy(true); setNotice(null);
    try {
      const payload = buildDeploymentProfileTransitionPayload({
        ...profileTransitionDraft, action: effectiveProfileTransitionAction, current_profile_type: textOf(selectedProfile.profileType),
        expected_version: Number(selectedProfile.version), idempotency_key: globalThis.crypto.randomUUID(),
      });
      const scope = textOf(selectedProfile.scopeType);
      if (scope === "FACTORY") await client.transitionFactoryProfile(textOf(selectedProfile.factoryId), payload);
      else await client.transitionTenantProfile(payload);
      setNotice({ tone: "success", message: "Deployment profile transition " + effectiveProfileTransitionAction + " was recorded. Reloading the effective profile." });
      refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };

  const submitResolver = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setNotice(null);
    try {
      const result = row(await client.resolveRelease({
        ...resolveDraft, factory_id: activeFactoryId || undefined,
      }));
      setResolveResult(result);
      setNotice({ tone: "success", message: result.release ? "An effective release was resolved using a healthy physical deployment receipt." : "No physically accepted release matched this subject and channel." });
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };

  const confirmPhysical = async () => {
    event.preventDefault();
    if (!physicalTarget || !physicalAcknowledged) return;
    setBusy(true); setNotice(null);
    try {
      if (physicalTarget.kind === "RELEASE") {
        const payload = buildPhysicalOperationPayload({
          expected_version: physicalTarget.version, idempotency_key: globalThis.crypto.randomUUID(),
          health_timeout_seconds: Number(healthTimeout), failure_policy: physicalPolicy,
        });
        const detail = normalizePhysicalRunDetail(await client.deployRelease(physicalTarget.key, payload));
        setSelectedRun(detail.run);
        setSelectedRunId(textOf(detail.run.id, ""));
        setRunEvents(detail.events.map(row));
        setNotice({ tone: "success", message: "Physical release deployment returned status " + textOf(detail.run.status, "unknown") + ". Review the provider evidence timeline before further promotion." });
      } else {
        const payload = buildPhysicalOperationPayload({
          expected_version: physicalTarget.version, idempotency_key: globalThis.crypto.randomUUID(),
          health_timeout_seconds: Number(healthTimeout),
        });
        const detail = normalizePhysicalRunDetail(await client.provisionProfile(physicalTarget.id, payload));
        setSelectedRun(detail.run);
        setSelectedRunId(textOf(detail.run.id, ""));
        setRunEvents(detail.events.map(row));
        setNotice({ tone: "success", message: "Physical deployment-profile provisioning returned status " + textOf(detail.run.status, "unknown") + ". Review provider evidence and refresh the effective profile." });
      }
      setTab("PHYSICAL");
      setPhysicalTarget(null);
      setPhysicalAcknowledged(false);
      refreshAll();
    } catch (cause) {
      setNotice({ tone: "error", message: errorOf(cause) + " Do not assume infrastructure changed; inspect the immutable physical run evidence." });
      refreshAll();
    } finally { setBusy(false); }
  };

  const selectedReleaseCanPromote = Boolean(selectedRelease && canReleasePromote
    && ((selectedReleaseStage === "DRAFT") || selectedReleaseStage === "CANARY"));
  const selectedReleaseCanPauseResume = Boolean(selectedRelease && canReleaseControl
    && (selectedReleaseStage === "CANARY" || selectedReleaseStage === "PRODUCTION" || selectedReleaseStage === "PAUSED"));
  const targetPromotionStage = selectedReleaseStage === "CANARY" ? "PRODUCTION" : "CANARY";
  const releaseTransitionActions = ["CANARY", "PRODUCTION"].includes(selectedReleaseStage)
    ? ["PAUSE", "RETIRE"] : selectedReleaseStage === "PAUSED" ? ["RESUME", "RETIRE"] : selectedReleaseStage !== "RETIRED" ? ["RETIRE"] : [];
  const effectiveReleaseTransitionAction = releaseTransitionActions.includes(releaseTransitionDraft.action)
    ? releaseTransitionDraft.action : releaseTransitionActions[0] ?? "RETIRE";
  const selectedReleaseCanRetire = Boolean(selectedRelease && canReleaseControl && selectedReleaseStage !== "RETIRED");
  const canProvisionSelectedProfile = Boolean(selectedProfile && canProfileControl
    && ["PLANNED", "PROVISIONING", "FAILED"].includes(selectedProfileStatus));
  const profileTransitionOptions = selectedProfileStatus === "ACTIVE"
    ? ["START_MIGRATION", "PAUSE", "RETIRE"]
    : selectedProfileStatus === "PAUSED"
      ? ["RESUME", "RETIRE"]
      : selectedProfileStatus === "MIGRATING"
        ? ["COMPLETE_MIGRATION", "PAUSE", "RETIRE"]
        : selectedProfileStatus === "RETIRED"
          ? []
          : ["RETIRE"];
  const effectiveProfileTransitionAction = profileTransitionOptions.includes(profileTransitionDraft.action)
    ? profileTransitionDraft.action : profileTransitionOptions[0] ?? "RETIRE";

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">SaaS operations / release engineering</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Release & Deployment Control Plane</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Register immutable artifacts, govern staged rollout, manage tenant/factory deployment topology and inspect physical provider receipts.</p>
          <p className="mt-2 text-xs font-medium text-slate-500">Tenant: {textOf(snapshot?.tenant.name, "Not connected")} · Factory context: {activeFactory ? activeFactory.name : "Tenant scope"}</p>
        </div>
        <button type="button" className={SECONDARY} onClick={refreshAll} disabled={!connected || loading}>Refresh control plane</button>
      </header>

      {notice ? <div role="status" className={"rounded-xl border px-4 py-3 text-sm " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900")}>{notice.message}</div> : null}
      {!connected ? <Empty>Connect an authenticated FactoryOS session to access the SaaS release control plane.</Empty> : null}
      {connected && !canReleaseRead && !canProfileRead && !canPhysicalRead ? <Empty>Your current IAM permissions do not include SaaS release, deployment-profile or physical-provisioning read access.</Empty> : null}

      {connected ? (
        <>
          <nav className="flex flex-wrap gap-2" aria-label="SaaS control plane sections">
            {([
              ["RELEASES", "Release rollouts"],
              ["DEPLOYMENT", "Deployment profiles"],
              ["PHYSICAL", "Physical run evidence"],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" className={tab === value ? PRIMARY : SECONDARY} onClick={() => setTab(value)}>{label}</button>
            ))}
          </nav>

          {tab === "RELEASES" ? (
            <div className="space-y-5">
              {canReleaseRead ? (
                <>
                  <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                    <Metric label="Latest rollouts" value={releaseSummary.total} hint="Maximum 100 latest keys" />
                    <Metric label="Draft" value={releaseSummary.draft} hint="Registered, not deployed" />
                    <Metric label="Canary" value={releaseSummary.canary} hint="1–99% cohort stage" />
                    <Metric label="Production" value={releaseSummary.production} hint="100% control-plane stage" />
                    <Metric label="Paused" value={releaseSummary.paused} hint="Not eligible for resolution" />
                    <Metric label="Deployable stage" value={releaseSummary.physicallyDeployable} hint="Still requires healthy provider receipt" />
                  </section>
                  <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(480px,0.95fr)]">
                    <Panel title="Release registry" subtitle="Each rollout key identifies one immutable artifact candidate. New artifact versions require a new rollout key."
                      action={canReleaseWrite ? <button type="button" className={PRIMARY} onClick={() => setShowReleaseForm((value) => !value)}>{showReleaseForm ? "Close registration" : "Register artifact"}</button> : undefined}>
                      {loadError ? <p role="alert" className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{loadError}</p> : null}
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[720px] text-left text-xs">
                          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-3">Rollout key</th><th className="px-2 py-3">Scope</th><th className="px-2 py-3">Artifact</th><th className="px-2 py-3">Stage</th><th className="px-2 py-3">Cohort</th><th className="px-2 py-3">Version</th></tr></thead>
                          <tbody>{loading ? <tr><td colSpan={6} className="px-2 py-10 text-center text-slate-500">Loading release rollouts...</td></tr>
                            : releases.length === 0 ? <tr><td colSpan={6} className="px-2 py-8"><Empty>No release rollouts are registered for this tenant.</Empty></td></tr>
                              : releases.map((item) => {
                                const key = textOf(item.rolloutKey, "");
                                return <tr key={key} onClick={() => { setSelectedReleaseKey(key); setSelectedRelease(row(item)); setDetailError(""); }} className={"cursor-pointer border-b border-slate-100 hover:bg-slate-50 " + (selectedReleaseKey === key ? "bg-blue-50/70" : "")}>
                                  <td className="px-2 py-3"><p className="font-bold text-slate-900">{key}</p><p className="mt-1 text-[10px] text-slate-500">{textOf(item.channel)}</p></td>
                                  <td className="px-2 py-3">{textOf(item.scopeType)}<p className="mt-1 text-[10px] text-slate-500">{textOf(item.moduleKey, textOf(item.agentKey, textOf(item.factoryId, "Tenant-wide")))}</p></td>
                                  <td className="px-2 py-3"><p className="font-semibold text-slate-800">{textOf(item.artifactVersion)}</p><p className="mt-1 font-mono text-[9px] text-slate-500">{digestShort(item.artifactDigest)}</p></td>
                                  <td className="px-2 py-3"><Badge value={textOf(item.stage, "UNKNOWN")} /></td>
                                  <td className="px-2 py-3 tabular-nums">{textOf(item.rolloutPercentage, "0")}%</td>
                                  <td className="px-2 py-3 tabular-nums">{textOf(item.version)}</td>
                                </tr>;
                              })}</tbody>
                        </table>
                      </div>
                    </Panel>

                    <Panel title="Selected rollout" subtitle="Control-plane history, staged promotion, pause/resume/retire and rollback. Each write is version-checked and audited.">
                      {!selectedRelease ? <Empty>Select a rollout from the registry.</Empty> : (
                        <div className="space-y-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Rollout key</p><h3 className="mt-1 text-xl font-bold text-slate-950">{selectedReleaseKey}</h3><p className="mt-1 text-xs text-slate-500">{textOf(selectedRelease.artifactVersion)} · {textOf(selectedRelease.channel)} · SHA-256 {digestShort(selectedRelease.artifactDigest)}</p></div>
                            <div className="text-right"><Badge value={selectedReleaseStage} /><p className="mt-1 text-[10px] text-slate-500">Version {textOf(selectedRelease.version)}</p></div>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Scope</p><p className="mt-1 text-xs font-semibold">{textOf(selectedRelease.scopeType)}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Last action</p><p className="mt-1 text-xs font-semibold">{textOf(selectedRelease.action)}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Evaluation reference</p><p className="mt-1 break-all text-xs font-semibold">{textOf(selectedRelease.evaluationReference)}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Created</p><p className="mt-1 text-xs font-semibold">{dateTime(selectedRelease.createdAt)}</p></div>
                          </div>
                          {detailError ? <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{detailError}</p> : null}
                          {selectedReleaseCanPromote ? (
                            <form className="rounded-xl border border-slate-200 p-3" onSubmit={submitPromotion}>
                              <h4 className="text-xs font-bold text-slate-900">Promote release stage</h4>
                              <p className="mt-1 text-[11px] leading-5 text-slate-500">The control plane enforces DRAFT → CANARY → PRODUCTION. Production requires exactly 100%; physical deploy/health evidence is a separate operation.</p>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <Field label="Target stage"><select className={INPUT} value={targetPromotionStage} disabled><option value="CANARY">CANARY</option><option value="PRODUCTION">PRODUCTION</option></select></Field>
                                <Field label="Rollout percentage" hint="Canary: 1–99; production: fixed at 100."><input className={INPUT} type="number" min={targetPromotionStage === "CANARY" ? 1 : 100} max={targetPromotionStage === "CANARY" ? 99 : 100} value={targetPromotionStage === "PRODUCTION" ? "100" : promotionDraft.rollout_percentage} onChange={(event) => setPromotionDraft((current) => ({ ...current, rollout_percentage: event.currentTarget.value }))} disabled={targetPromotionStage === "PRODUCTION"} /></Field>
                                <div className="sm:col-span-2"><Field label="Promotion reason"><textarea className={AREA} required maxLength={1000} value={promotionDraft.reason} onChange={(event) => setPromotionDraft((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field></div>
                              </div>
                              <button type="submit" className={PRIMARY + " mt-3"} disabled={busy}>{busy ? "Promoting..." : "Record promotion"}</button>
                            </form>
                          ) : null}
                          {selectedReleaseCanPauseResume || selectedReleaseCanRetire ? (
                            <form className="rounded-xl border border-slate-200 p-3" onSubmit={submitReleaseTransition}>
                              <h4 className="text-xs font-bold text-slate-900">Lifecycle control</h4>
                              <div className="mt-3 grid gap-3 sm:grid-cols-[170px_minmax(0,1fr)]">
                                <Field label="Action"><select className={INPUT} value={effectiveReleaseTransitionAction} onChange={(event) => setReleaseTransitionDraft((current) => ({ ...current, action: event.currentTarget.value as "PAUSE" | "RESUME" | "RETIRE" }))}>
                                  {releaseTransitionActions.map((action) => <option key={action} value={action}>{action}</option>)}
                                </select></Field>
                                <Field label="Reason"><input className={INPUT} required maxLength={1000} value={releaseTransitionDraft.reason} onChange={(event) => setReleaseTransitionDraft((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field>
                              </div>
                              <button type="submit" className={DANGER + " mt-3"} disabled={busy}>Apply lifecycle action</button>
                            </form>
                          ) : null}
                          {selectedRelease && canReleaseRollback && releaseRollbackTargets.length > 0 && ["CANARY", "PRODUCTION", "PAUSED"].includes(selectedReleaseStage) ? (
                            <form className="rounded-xl border border-amber-200 bg-amber-50/40 p-3" onSubmit={submitRollback}>
                              <h4 className="text-xs font-bold text-amber-950">Control-plane rollback</h4>
                              <p className="mt-1 text-[11px] leading-5 text-amber-900/80">Only the latest live candidate with exactly matching scope and channel is eligible. Physical deployment/rollback confirmation is still separate.</p>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <Field label="Target live rollout"><select className={INPUT} value={rollbackDraft.target_rollout_key} onChange={(event) => { const target = releaseRollbackTargets.find((item) => textOf(item.rolloutKey) === event.currentTarget.value); setRollbackDraft((current) => ({ ...current, target_rollout_key: event.currentTarget.value, target_version: textOf(target?.version, "") })); }} required><option value="">Choose a matching target</option>{releaseRollbackTargets.map((item) => <option key={textOf(item.rolloutKey)} value={textOf(item.rolloutKey)}>{textOf(item.rolloutKey)} · v{textOf(item.version)} · {textOf(item.stage)}</option>)}</select></Field>
                                <Field label="Target version"><input className={INPUT} value={rollbackDraft.target_version} readOnly /></Field>
                                <div className="sm:col-span-2"><Field label="Rollback reason"><textarea className={AREA} required maxLength={1000} value={rollbackDraft.reason} onChange={(event) => setRollbackDraft((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field></div>
                              </div>
                              <button type="submit" className={DANGER + " mt-3"} disabled={busy || !rollbackDraft.target_rollout_key}>Record control-plane rollback</button>
                            </form>
                          ) : null}
                          {selectedRelease && canDeployRelease && ["CANARY", "PRODUCTION"].includes(selectedReleaseStage) ? (
                            <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3">
                              <h4 className="text-xs font-bold text-rose-950">Physical provider deployment</h4>
                              <p className="mt-1 text-[11px] leading-5 text-rose-900/80">This operation calls the registered infrastructure adapter and performs artifact, topology/isolation and health verification. If no approved adapter exists, the backend fails closed. Choose a failure policy and explicitly authorize the provider operation.</p>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                <Field label="Failure policy"><select className={INPUT} value={physicalPolicy} onChange={(event) => setPhysicalPolicy(event.currentTarget.value as "HALT" | "ROLLBACK")}><option value="HALT" disabled={!canReleaseControl}>HALT and pause control plane</option><option value="ROLLBACK" disabled={!canReleaseRollback}>ROLLBACK to previous production artifact</option></select></Field>
                                <Field label="Health timeout (seconds)"><input className={INPUT} type="number" min={5} max={300} value={healthTimeout} onChange={(event) => setHealthTimeout(event.currentTarget.value)} /></Field>
                              </div>
                              <button type="button" className={DANGER + " mt-3"} onClick={() => { setPhysicalTarget({ kind: "RELEASE", key: selectedReleaseKey, version: Number(selectedRelease.version) }); setPhysicalAcknowledged(false); }}>Review physical deploy authorization</button>
                            </div>
                          ) : null}
                          <div className="border-t border-slate-100 pt-3">
                            <h4 className="text-xs font-bold text-slate-900">Immutable rollout history</h4>
                            {releaseHistory.length === 0 ? <p className="mt-2 text-[11px] text-slate-500">No history snapshot was returned.</p> : (
                              <ol className="mt-3 space-y-2">{releaseHistory.map((item) => <li key={textOf(item.id)} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2"><div><p className="text-xs font-semibold text-slate-800">v{textOf(item.version)} · {textOf(item.action)}</p><p className="mt-1 text-[10px] text-slate-500">{textOf(item.reason)}</p><p className="mt-1 text-[10px] text-slate-400">{dateTime(item.createdAt)}</p></div><div className="text-right"><Badge value={textOf(item.stage, "UNKNOWN")} /><p className="mt-1 text-[10px] text-slate-500">{textOf(item.rolloutPercentage, "0")}% cohort</p></div></li>)}</ol>
                            )}
                          </div>
                        </div>
                      )}
                    </Panel>
                  </div>

                  {showReleaseForm && canReleaseWrite ? (
                    <Panel title="Register immutable release artifact" subtitle="Registration creates a DRAFT candidate only. The digest must be a SHA-256 hex value; do not paste tokens, URLs or secrets into opaque reference fields.">
                      <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={submitCreateRelease}>
                        <Field label="Unique rollout key"><input className={INPUT} required maxLength={80} value={releaseDraft.rollout_key} onChange={(event) => setReleaseDraft((current) => ({ ...current, rollout_key: event.currentTarget.value.toUpperCase() }))} placeholder="RELEASE-2026-11" /></Field>
                        <Field label="Scope"><select className={INPUT} value={releaseDraft.scope_type} onChange={(event) => setReleaseDraft((current) => ({ ...current, scope_type: event.currentTarget.value as Scope }))}><option value="ORGANIZATION">Organization</option><option value="FACTORY" disabled={!activeFactoryId}>Factory</option><option value="MODULE">Module</option><option value="AGENT">Agent</option></select></Field>
                        <Field label="Release channel"><select className={INPUT} value={releaseDraft.release_channel} onChange={(event) => setReleaseDraft((current) => ({ ...current, release_channel: event.currentTarget.value as Channel }))}><option value="STABLE">Stable</option><option value="PREVIEW">Preview</option><option value="EXPERIMENTAL">Experimental</option></select></Field>
                        <Field label="Artifact version"><input className={INPUT} required maxLength={120} value={releaseDraft.artifact_version} onChange={(event) => setReleaseDraft((current) => ({ ...current, artifact_version: event.currentTarget.value }))} placeholder="2026.11.24" /></Field>
                        {releaseDraft.scope_type === "MODULE" || releaseDraft.scope_type === "AGENT" ? <Field label="Module key"><input className={INPUT} value={releaseDraft.module_key} onChange={(event) => setReleaseDraft((current) => ({ ...current, module_key: event.currentTarget.value }))} maxLength={80} placeholder="inventory.core" /></Field> : null}
                        {releaseDraft.scope_type === "AGENT" ? <Field label="Agent key"><input className={INPUT} required value={releaseDraft.agent_key} onChange={(event) => setReleaseDraft((current) => ({ ...current, agent_key: event.currentTarget.value }))} maxLength={160} placeholder="planner.agent" /></Field> : null}
                        {releaseDraft.scope_type !== "ORGANIZATION" && releaseDraft.scope_type !== "FACTORY" ? <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600"><input id="release-active-factory" type="checkbox" checked={Boolean(releaseDraft.factory_id)} onChange={(event) => setReleaseDraft((current) => ({ ...current, factory_id: event.currentTarget.checked ? activeFactoryId : "" }))} disabled={!activeFactoryId} /><label htmlFor="release-active-factory">Constrain to selected factory</label></div> : null}
                        <Field label="Artifact SHA-256 digest" hint="64 hexadecimal characters."><input className={INPUT + " font-mono"} required maxLength={64} minLength={64} value={releaseDraft.artifact_digest} onChange={(event) => setReleaseDraft((current) => ({ ...current, artifact_digest: event.currentTarget.value.toLowerCase() }))} placeholder="64-char SHA-256" /></Field>
                        <Field label="Evaluation reference" hint="Optional opaque reference, not a URL or credential."><input className={INPUT} maxLength={200} value={releaseDraft.evaluation_reference} onChange={(event) => setReleaseDraft((current) => ({ ...current, evaluation_reference: event.currentTarget.value }))} /></Field>
                        <div className="sm:col-span-2 xl:col-span-4"><Field label="Registration reason"><textarea className={AREA} required maxLength={1000} value={releaseDraft.reason} onChange={(event) => setReleaseDraft((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field></div>
                        <div className="flex flex-wrap justify-end gap-2 sm:col-span-2 xl:col-span-4"><button type="button" className={SECONDARY} onClick={() => setShowReleaseForm(false)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Registering..." : "Register DRAFT candidate"}</button></div>
                      </form>
                    </Panel>
                  ) : null}

                  <Panel title="Resolve effective release" subtitle="The resolver only returns an eligible stage with a healthy physical deployment receipt; deterministic canary cohort selection is performed server-side.">
                    <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={submitResolver}>
                      <Field label="Channel"><select className={INPUT} value={resolveDraft.channel} onChange={(event) => setResolveDraft((current) => ({ ...current, channel: event.currentTarget.value as Channel }))}><option value="STABLE">Stable</option><option value="PREVIEW">Preview</option><option value="EXPERIMENTAL">Experimental</option></select></Field>
                      <Field label="Subject key"><input className={INPUT} required maxLength={200} value={resolveDraft.subject_key} onChange={(event) => setResolveDraft((current) => ({ ...current, subject_key: event.currentTarget.value }))} placeholder="Tenant/user/cohort identity" /></Field>
                      <Field label="Module key"><input className={INPUT} value={resolveDraft.module_key} onChange={(event) => setResolveDraft((current) => ({ ...current, module_key: event.currentTarget.value }))} maxLength={80} /></Field>
                      <Field label="Agent key"><input className={INPUT} value={resolveDraft.agent_key} onChange={(event) => setResolveDraft((current) => ({ ...current, agent_key: event.currentTarget.value }))} maxLength={160} /></Field>
                      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 xl:col-span-4"><button type="submit" className={SECONDARY} disabled={busy || !canReleaseRead}>Resolve for selected factory context</button>{resolveResult ? <span className="text-xs text-slate-600">{resolveResult.release ? "Resolved: " + textOf(row(resolveResult.release).rolloutKey) + " · " + textOf(row(resolveResult.release).stage) + " · bucket " + textOf(resolveResult.rolloutBucket, "n/a") : "No eligible release for this target."}</span> : null}</div>
                    </form>
                  </Panel>
                </>
              ) : <Empty>You do not have saas.releases.read permission.</Empty>}
            </div>
          ) : null}

          {tab === "DEPLOYMENT" ? (
            <div className="space-y-5">
              {canProfileRead ? (
                <>
                  <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                    <Metric label="Profiles loaded" value={profileSummary.total} hint="Latest snapshot by scope" />
                    <Metric label="Planned" value={profileSummary.planned} hint="Awaiting infrastructure" />
                    <Metric label="Provisioning" value={profileSummary.provisioning} hint="Provider action may be running" />
                    <Metric label="Active" value={profileSummary.active} hint="Effective topology candidate" />
                    <Metric label="Migrating" value={profileSummary.migrating} hint="Target profile recorded" />
                    <Metric label="Failed / retired" value={profileSummary.failed + profileSummary.retired} hint="Requires review or terminal" />
                  </section>
                  <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(440px,0.9fr)]">
                    <Panel title="Deployment profile assignments" subtitle="Tenant and active-factory assignments are immutable versioned snapshots; tenant scope may be the effective fallback."
                      action={canProfileWrite ? <button type="button" className={PRIMARY} onClick={() => setShowProfileForm((value) => !value)}>{showProfileForm ? "Close profile form" : "Register profile"}</button> : undefined}>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[620px] text-left text-xs">
                          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-3">Scope</th><th className="px-2 py-3">Topology</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Region / Edge</th><th className="px-2 py-3">Version</th></tr></thead>
                          <tbody>{loading ? <tr><td colSpan={5} className="px-2 py-10 text-center text-slate-500">Loading deployment profiles...</td></tr>
                            : profiles.length === 0 ? <tr><td colSpan={5} className="px-2 py-8"><Empty>No tenant or selected-factory deployment profile is registered.</Empty></td></tr>
                              : profiles.map((item) => <tr key={textOf(item.id)} onClick={() => { setSelectedProfileId(textOf(item.id)); setDetailError(""); }} className={"cursor-pointer border-b border-slate-100 hover:bg-slate-50 " + (selectedProfileId === textOf(item.id) ? "bg-blue-50/70" : "")}>
                                <td className="px-2 py-3"><p className="font-semibold">{textOf(item.scopeType)}</p><p className="mt-1 font-mono text-[9px] text-slate-500">{textOf(item.factoryId, "Tenant")}</p></td>
                                <td className="px-2 py-3 font-semibold">{textOf(item.profileType)}</td>
                                <td className="px-2 py-3"><Badge value={textOf(item.status, "UNKNOWN")} /></td>
                                <td className="px-2 py-3">{textOf(item.regionCode, textOf(item.edgeSiteCode))}</td>
                                <td className="px-2 py-3 tabular-nums">{textOf(item.version)}</td>
                              </tr>)}</tbody>
                        </table>
                      </div>
                      <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-blue-900">Effective deployment profile</p>
                        {effectiveProfile ? <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-bold text-slate-950">{textOf(effectiveProfile.profileType)}</p><p className="mt-1 text-[10px] text-slate-600">Matched scope: {textOf(effectiveProfile.scopeType)} · Tenant fallback: {effectiveProfile.fallbackToTenant === true ? "Yes" : "No"}</p></div><Badge value={textOf(effectiveProfile.status, "UNKNOWN")} /></div> : <p className="mt-2 text-xs text-slate-600">No active tenant/factory deployment profile is currently effective.</p>}
                      </div>
                    </Panel>
                    <Panel title="Selected profile lifecycle" subtitle="Physical provisioning invokes a provider adapter and activates this profile only after verified topology/isolation evidence.">
                      {!selectedProfile ? <Empty>Select a deployment profile.</Empty> : (
                        <div className="space-y-4">
                          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-950">{textOf(selectedProfile.profileType)}</h3><p className="mt-1 text-xs text-slate-500">{textOf(selectedProfile.scopeType)} · {textOf(selectedProfile.factoryId, "Tenant assignment")}</p></div><div className="text-right"><Badge value={selectedProfileStatus} /><p className="mt-1 text-[10px] text-slate-500">Version {textOf(selectedProfile.version)}</p></div></div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Deployment reference</p><p className="mt-1 break-all text-xs font-semibold">{textOf(selectedProfile.deploymentReference)}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Region / residency</p><p className="mt-1 text-xs font-semibold">{textOf(selectedProfile.regionCode)} · {textOf(selectedProfile.residencyDomain)}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Edge site</p><p className="mt-1 text-xs font-semibold">{textOf(selectedProfile.edgeSiteCode)}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Created</p><p className="mt-1 text-xs font-semibold">{dateTime(selectedProfile.createdAt)}</p></div>
                          </div>
                          {canProvisionSelectedProfile ? (
                            <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3">
                              <p className="text-xs font-bold text-rose-950">Physical provisioning operation</p>
                              <p className="mt-1 text-[11px] leading-5 text-rose-900/80">The API selects only an approved infrastructure adapter. Success requires a provider receipt proving the requested topology, isolation, namespace, quota and storage boundaries. No adapter means fail-closed behavior.</p>
                              <button type="button" className={DANGER + " mt-3"} onClick={() => { setPhysicalTarget({ kind: "PROFILE", id: textOf(selectedProfile.id), version: Number(selectedProfile.version) }); setPhysicalAcknowledged(false); }}>Review profile provisioning authorization</button>
                            </div>
                          ) : null}
                          {canProfileControl && profileTransitionOptions.length > 0 ? (
                            <form className="rounded-xl border border-slate-200 p-3" onSubmit={submitProfileTransition}>
                              <h4 className="text-xs font-bold text-slate-900">Profile lifecycle transition</h4>
                              {selectedProfileStatus === "MIGRATING" ? <p className="mt-1 text-[11px] leading-5 text-amber-800">Complete migration is a control-plane attestation. Verify the provider-side migration and evidence independently before recording completion.</p> : null}
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <Field label="Action"><select className={INPUT} value={effectiveProfileTransitionAction} onChange={(event) => setProfileTransitionDraft((current) => ({ ...current, action: event.currentTarget.value }))}>{profileTransitionOptions.map((action) => <option key={action} value={action}>{action.replaceAll("_", " ")}</option>)}</select></Field>
                                {effectiveProfileTransitionAction === "START_MIGRATION" ? <>
                                  <Field label="Target topology"><select className={INPUT} value={profileTransitionDraft.target_profile_type} onChange={(event) => setProfileTransitionDraft((current) => ({ ...current, target_profile_type: event.currentTarget.value as ProfileType }))}>{(["SHARED_SAAS", "SINGLE_TENANT", "DEDICATED_VPC", "HYBRID_EDGE_CLOUD"] as const).map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
                                  <Field label="Target deployment reference"><input className={INPUT} value={profileTransitionDraft.target_deployment_reference} onChange={(event) => setProfileTransitionDraft((current) => ({ ...current, target_deployment_reference: event.currentTarget.value }))} maxLength={200} /></Field>
                                  <Field label="Target region"><input className={INPUT} value={profileTransitionDraft.target_region_code} onChange={(event) => setProfileTransitionDraft((current) => ({ ...current, target_region_code: event.currentTarget.value }))} maxLength={64} /></Field>
                                  <Field label="Target residency domain"><input className={INPUT} value={profileTransitionDraft.target_residency_domain} onChange={(event) => setProfileTransitionDraft((current) => ({ ...current, target_residency_domain: event.currentTarget.value }))} maxLength={64} /></Field>
                                  <Field label="Target edge site"><input className={INPUT} value={profileTransitionDraft.target_edge_site_code} onChange={(event) => setProfileTransitionDraft((current) => ({ ...current, target_edge_site_code: event.currentTarget.value }))} maxLength={80} /></Field>
                                </> : null}
                                <Field label="Reason"><input className={INPUT} required maxLength={1000} value={profileTransitionDraft.reason} onChange={(event) => setProfileTransitionDraft((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field>
                              </div>
                              <button type="submit" className={SECONDARY + " mt-3"} disabled={busy}>Record profile transition</button>
                            </form>
                          ) : null}
                          <div className="border-t border-slate-100 pt-3"><h4 className="text-xs font-bold text-slate-900">Scope history</h4>{profileHistory.length === 0 ? <p className="mt-2 text-[11px] text-slate-500">No history returned.</p> : <ol className="mt-3 space-y-2">{profileHistory.map((item) => <li key={textOf(item.id)} className="rounded-lg border border-slate-100 px-3 py-2"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold">v{textOf(item.version)} · {textOf(item.action)}</p><Badge value={textOf(item.status, "UNKNOWN")} /></div><p className="mt-1 text-[10px] text-slate-500">{textOf(item.reason)} · {dateTime(item.createdAt)}</p></li>)}</ol>}</div>
                        </div>
                      )}
                    </Panel>
                  </div>
                  {showProfileForm && canProfileWrite ? (
                    <Panel title="Register deployment profile" subtitle="Opaque provider references only. Never enter a cloud URL, credential, API key or secret. Registration creates a PLANNED assignment only.">
                      <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={submitProfileCreate}>
                        <Field label="Scope"><select className={INPUT} value={profileDraft.scope_type} onChange={(event) => setProfileDraft((current) => ({ ...current, scope_type: event.currentTarget.value as ProfileScope }))}><option value="TENANT">Tenant</option><option value="FACTORY" disabled={!activeFactoryId}>Selected factory</option></select></Field>
                        <Field label="Deployment topology"><select className={INPUT} value={profileDraft.profile_type} onChange={(event) => setProfileDraft((current) => ({ ...current, profile_type: event.currentTarget.value as ProfileType }))}><option value="SHARED_SAAS">Shared SaaS</option><option value="SINGLE_TENANT">Single tenant</option><option value="DEDICATED_VPC">Dedicated VPC</option><option value="HYBRID_EDGE_CLOUD">Hybrid edge/cloud</option></select></Field>
                        <Field label="Deployment reference"><input className={INPUT} value={profileDraft.deployment_reference} onChange={(event) => setProfileDraft((current) => ({ ...current, deployment_reference: event.currentTarget.value }))} maxLength={200} /></Field>
                        <Field label="Region code"><input className={INPUT} value={profileDraft.region_code} onChange={(event) => setProfileDraft((current) => ({ ...current, region_code: event.currentTarget.value }))} maxLength={64} placeholder="ap-south-1" /></Field>
                        <Field label="Residency domain"><input className={INPUT} value={profileDraft.residency_domain} onChange={(event) => setProfileDraft((current) => ({ ...current, residency_domain: event.currentTarget.value }))} maxLength={64} /></Field>
                        <Field label="Edge site code"><input className={INPUT} value={profileDraft.edge_site_code} onChange={(event) => setProfileDraft((current) => ({ ...current, edge_site_code: event.currentTarget.value }))} maxLength={80} placeholder="DHK-EDGE-01" /></Field>
                        <div className="sm:col-span-2 xl:col-span-4"><Field label="Reason"><textarea className={AREA} required maxLength={1000} value={profileDraft.reason} onChange={(event) => setProfileDraft((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field></div>
                        <div className="flex flex-wrap justify-end gap-2 sm:col-span-2 xl:col-span-4"><button type="button" className={SECONDARY} onClick={() => setShowProfileForm(false)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Register PLANNED profile</button></div>
                      </form>
                    </Panel>
                  ) : null}
                </>
              ) : <Empty>You do not have saas.deployment_profiles.read permission.</Empty>}
            </div>
          ) : null}

          {tab === "PHYSICAL" ? (
            <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
              {canPhysicalRead ? (
                <>
                  <Panel title="Physical provisioning runs" subtitle="Append-only infrastructure operation ledger. A successful control-plane promotion alone is not a deployment receipt.">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] text-left text-xs">
                        <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-3">Resource</th><th className="px-2 py-3">Operation</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Version</th><th className="px-2 py-3">Started</th></tr></thead>
                        <tbody>{loading ? <tr><td colSpan={5} className="px-2 py-10 text-center text-slate-500">Loading physical runs...</td></tr>
                          : runs.length === 0 ? <tr><td colSpan={5} className="px-2 py-8"><Empty>No physical provider operations were returned.</Empty></td></tr>
                            : runs.map((item) => <tr key={textOf(item.id)} onClick={() => void chooseRun(textOf(item.id))} className={"cursor-pointer border-b border-slate-100 hover:bg-slate-50 " + (selectedRunId === textOf(item.id) ? "bg-blue-50/70" : "")}>
                              <td className="px-2 py-3"><p className="font-semibold">{textOf(item.resourceKey)}</p><p className="mt-1 text-[10px] text-slate-500">{textOf(item.resourceType)} · {textOf(item.topology)}</p></td>
                              <td className="px-2 py-3">{textOf(item.operation)}</td>
                              <td className="px-2 py-3"><Badge value={textOf(item.status, "REQUESTED")} /></td>
                              <td className="px-2 py-3 tabular-nums">{textOf(item.resourceVersion)}</td>
                              <td className="px-2 py-3 text-[10px] text-slate-500">{dateTime(item.createdAt)}</td>
                            </tr>)}</tbody>
                      </table>
                    </div>
                    <p className="mt-3 text-[10px] text-slate-500">Showing latest 25 runs. Select a run to inspect event versions, provider references, evidence digest and safe verification summary.</p>
                  </Panel>
                  <Panel title="Physical run evidence timeline" subtitle="Provider references and evidence digests are displayed as audit metadata; this view deliberately does not expose raw provider payloads or credentials.">
                    {detailLoading ? <Empty>Loading immutable run and event evidence...</Empty>
                      : !selectedRun ? <Empty>Select a physical run to inspect its timeline.</Empty>
                        : (
                          <div className="space-y-4">
                            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-950">{textOf(selectedRun.resourceKey)}</h3><p className="mt-1 text-xs text-slate-500">{textOf(selectedRun.operation)} · {textOf(selectedRun.topology)}</p></div><Badge value={textOf(selectedRun.status, "UNKNOWN")} /></div>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Provider run ID</p><p className="mt-1 break-all font-mono text-[10px]">{textOf(selectedRun.id)}</p></div>
                              <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Resource version</p><p className="mt-1 text-xs font-semibold">{textOf(selectedRun.resourceVersion)}</p></div>
                              <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Failure policy</p><p className="mt-1 text-xs font-semibold">{textOf(selectedRun.failurePolicy)}</p></div>
                              <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Artifact digest</p><p className="mt-1 font-mono text-[10px]">{digestShort(selectedRun.artifactDigest)}</p></div>
                            </div>
                            {runEvents.length === 0 ? <Empty>No event evidence was returned for this physical run.</Empty> : (
                              <ol className="space-y-3">{runEvents.map((event) => (
                                <li key={textOf(event.version)} className="relative rounded-xl border border-slate-200 p-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">Event v{textOf(event.version)}</p><Badge value={textOf(event.status, "UNKNOWN")} /></div>
                                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                    <div><p className="text-[10px] uppercase text-slate-500">Provider</p><p className="mt-1 text-xs font-semibold">{textOf(event.providerCode)}</p></div>
                                    <div><p className="text-[10px] uppercase text-slate-500">Reason code</p><p className="mt-1 text-xs font-semibold">{textOf(event.reasonCode)}</p></div>
                                    <div><p className="text-[10px] uppercase text-slate-500">Provider reference</p><p className="mt-1 break-all font-mono text-[10px]">{textOf(event.providerReference)}</p></div>
                                    <div><p className="text-[10px] uppercase text-slate-500">Evidence digest</p><p className="mt-1 break-all font-mono text-[10px]">{digestShort(event.evidenceDigest)}</p></div>
                                  </div>
                                  {safeEvidenceSummary(event.evidence).length > 0 ? <ul className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] text-slate-600">{safeEvidenceSummary(event.evidence).map((entry) => <li key={entry}>{entry}</li>)}</ul> : null}
                                  <p className="mt-2 text-[10px] text-slate-400">{dateTime(event.createdAt)}</p>
                                </li>
                              ))}</ol>
                            )}
                          </div>
                        )}
                  </Panel>
                </>
              ) : <Empty>You do not have saas.physical_provisioning.read permission. Physical action responses can still be inspected immediately after an authorized operation.</Empty>}
            </div>
          ) : null}
        </>
      ) : null}

      {physicalTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="physical-confirm-title">
          <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl">
            <p className="text-[10px] font-bold uppercase tracking-widest text-rose-700">Infrastructure provider operation</p>
            <h2 id="physical-confirm-title" className="mt-2 text-lg font-bold text-slate-950">{physicalTarget.kind === "RELEASE" ? "Deploy release " + physicalTarget.key : "Provision deployment profile"}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">This sends a real physical operation request to the configured provider adapter. The backend records an immutable run and verifies provider receipt/evidence. An unapproved or unavailable adapter fails closed; it will not be reported as a simulated success. An in-progress or unknown run must be inspected before any retry.</p>
            {physicalTarget.kind === "RELEASE" ? <Field label="Failure policy"><select className={INPUT + " mt-2"} value={physicalPolicy} onChange={(event) => setPhysicalPolicy(event.currentTarget.value as "HALT" | "ROLLBACK")}><option value="HALT" disabled={!canReleaseControl}>HALT and pause control plane</option><option value="ROLLBACK" disabled={!canReleaseRollback}>Rollback to prior production artifact</option></select></Field> : null}
            <Field label="Health timeout (seconds)"><input className={INPUT + " mt-2"} type="number" min={5} max={300} value={healthTimeout} onChange={(event) => setHealthTimeout(event.currentTarget.value)} /></Field>
            <label className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-900"><input type="checkbox" className="mt-1" checked={physicalAcknowledged} onChange={(event) => setPhysicalAcknowledged(event.currentTarget.checked)} /><span>I explicitly authorize this infrastructure provider operation for the selected resource and exact version. I understand that failure or timeout may require manual recovery using the run evidence.</span></label>
            <div className="mt-5 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => { setPhysicalTarget(null); setPhysicalAcknowledged(false); }} disabled={busy}>Cancel</button><button type="button" className={DANGER} onClick={() => void confirmPhysical()} disabled={!physicalAcknowledged || busy}>{busy ? "Submitting provider operation..." : "Authorize operation"}</button></div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
