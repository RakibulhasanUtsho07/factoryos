"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildAuthIdentityPayload,
  buildEntitlementPayload,
  buildFeatureFlagPayload,
  buildFlagEvaluationPath,
  buildGovernanceListQuery,
  filterGovernanceRows,
  normalizeGovernanceRows,
  summarizeGovernanceWorkspace,
} from "@/lib/tenant-governance-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "ACCESS" | "FLAGS" | "ENTITLEMENTS";
type Notice = { tone: "success" | "error" | "warning"; message: string };

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "ACCESS", label: "Identity & access", description: "Tenant membership, user directory, role catalogue, permission catalogue and external identity linking" },
  { id: "FLAGS", label: "Feature flags", description: "Immutable versions, effective windows, privileged changes and safe runtime evaluation" },
  { id: "ENTITLEMENTS", label: "Entitlements", description: "Versioned package capabilities, limits, billing periods and effective dates" },
];

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function list(value: unknown, key = "items"): Row[] {
  return normalizeGovernanceRows(value, key).map((entry) => object(entry));
}

function display(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The governance request could not be completed.";
}

function dateTime(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function StatusPill({ value }: { value: unknown }) {
  const status = display(value, "UNKNOWN").toUpperCase();
  const tone = ["ACTIVE", "ENABLED", "TRUE"].includes(status)
    ? "bg-emerald-50 text-emerald-800"
    : ["DISABLED", "EXPIRED", "INACTIVE", "FALSE"].includes(status)
      ? "bg-slate-100 text-slate-700"
      : ["TRIAL", "PENDING", "SUSPENDED"].includes(status)
        ? "bg-amber-50 text-amber-900"
        : "bg-blue-50 text-blue-800";
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

function Section({ title, subtitle, children, action }: { title: string; subtitle: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div><h2 className="text-sm font-bold text-slate-950">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p></div>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>{headers.map((header) => <th key={header} className="whitespace-nowrap px-3 py-3 font-bold">{header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>
      </table>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">{children}</div>;
}

function Kpi({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p>
    </div>
  );
}

export default function TenantGovernanceWorkbenchPage() {
  const { status: sessionStatus, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const permissions = {
    accessRead: hasPermission("iam.access.read"),
    usersRead: hasPermission("iam.users.read"),
    rolesRead: hasPermission("iam.roles.read"),
    permissionsRead: hasPermission("iam.permissions.read"),
    identityWrite: hasPermission("iam.users.identities.write"),
    flagsRead: hasPermission("feature_flags.read"),
    flagsWrite: hasPermission("feature_flags.write"),
    criticalFlagWrite: hasPermission("feature_flags.security_critical.write"),
    entitlementsRead: hasPermission("entitlements.read"),
    entitlementsWrite: hasPermission("entitlements.write"),
  };
  const canOpen = Object.values(permissions).some(Boolean);

  const [tab, setTab] = useState<Tab>("ACCESS");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadedFactoryId, setLoadedFactoryId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  const [users, setUsers] = useState<Row[]>([]);
  const [roles, setRoles] = useState<Row[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<Row[]>([]);
  const [factories, setFactories] = useState<Row[]>([]);
  const [featureFlags, setFeatureFlags] = useState<Row[]>([]);
  const [entitlements, setEntitlements] = useState<Row[]>([]);

  const [userSearch, setUserSearch] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [flagSearch, setFlagSearch] = useState("");
  const [entitlementSearch, setEntitlementSearch] = useState("");

  const [identityDraft, setIdentityDraft] = useState({ user_id: "", issuer: "", subject: "" });
  const [identityAcknowledged, setIdentityAcknowledged] = useState(false);

  const [flagDraft, setFlagDraft] = useState({
    key: "", enabled: true, owner: "", security_critical: false, change_reason: "",
    effective_from: "", expires_at: "", config: "{}",
  });
  const [evaluationDraft, setEvaluationDraft] = useState({ key: "", at: "" });
  const [evaluation, setEvaluation] = useState<Row | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  const [entitlementDraft, setEntitlementDraft] = useState({
    package: "", feature_key: "", limit_value: "", period: "MONTH", status: "ACTIVE",
    effective_from: "", effective_to: "", config: "{}",
  });

  const visibleUsers = useMemo(() => filterGovernanceRows(users, userSearch), [users, userSearch]);
  const visibleCatalog = useMemo(() => filterGovernanceRows([...roles, ...permissionCatalog], catalogSearch), [roles, permissionCatalog, catalogSearch]);
  const visibleFlags = useMemo(() => filterGovernanceRows(featureFlags, flagSearch), [featureFlags, flagSearch]);
  const visibleEntitlements = useMemo(() => filterGovernanceRows(entitlements, entitlementSearch), [entitlements, entitlementSearch]);
  const summary = useMemo(() => summarizeGovernanceWorkspace({
    users, roles, permissions: permissionCatalog, factories, featureFlags, entitlements,
  }), [users, roles, permissionCatalog, factories, featureFlags, entitlements]);

  useEffect(() => {
    let cancelled = false;
    async function loadGovernance() {
      if (sessionStatus !== "connected" || !activeFactoryId || !canOpen) return;
      setLoading(true);
      setNotice(null);
      setLoadedFactoryId("");
      const jobs: Array<{ key: string; enabled: boolean; path: string; preferred: string }> = [
        { key: "users", enabled: permissions.usersRead, path: "/iam/users" + buildGovernanceListQuery({ limit: 100 }, "users"), preferred: "items" },
        { key: "roles", enabled: permissions.rolesRead, path: "/iam/roles", preferred: "items" },
        { key: "permissions", enabled: permissions.permissionsRead, path: "/iam/permissions", preferred: "items" },
        { key: "factories", enabled: permissions.accessRead, path: "/iam/factories", preferred: "items" },
        { key: "flags", enabled: permissions.flagsRead, path: "/admin/v1/feature-flags" + buildGovernanceListQuery({ limit: 100, offset: 0 }, "feature-flags"), preferred: "items" },
        { key: "entitlements", enabled: permissions.entitlementsRead, path: "/admin/v1/entitlements" + buildGovernanceListQuery({ limit: 100, offset: 0 }, "entitlements"), preferred: "items" },
      ];
      const enabled = jobs.filter((job) => job.enabled);
      const results = await Promise.all(enabled.map(async (job) => {
        try { return { key: job.key, value: await request(job.path) }; }
        catch (error) { return { key: job.key, error }; }
      }));
      if (cancelled) return;
      const values: Record<string, unknown> = {};
      const failures: unknown[] = [];
      for (const result of results) {
        if ("error" in result) failures.push(result.error);
        else values[result.key] = result.value;
      }
      setUsers(list(values.users, "items"));
      setRoles(list(values.roles, "items"));
      setPermissionCatalog(list(values.permissions, "items"));
      setFactories(list(values.factories, "items"));
      setFeatureFlags(list(values.flags, "items"));
      setEntitlements(list(values.entitlements, "items"));
      if (failures.length) {
        setNotice({ tone: "warning", message: "Some governance catalogues did not load. Check the required IAM or tenant-admin permissions." });
      }
      setLoadedFactoryId(activeFactoryId);
      setLoading(false);
    }
    const timer = window.setTimeout(() => void loadGovernance(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    sessionStatus, activeFactoryId, canOpen, request, refreshVersion,
    permissions.usersRead, permissions.rolesRead, permissions.permissionsRead,
    permissions.accessRead, permissions.flagsRead, permissions.entitlementsRead,
  ]);

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setRefreshVersion((value) => value + 1);
      setNotice({ tone: "success", message: success });
      return result;
    } catch (error) {
      setNotice({ tone: "error", message: messageOf(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function linkIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identityAcknowledged) {
      setNotice({ tone: "error", message: "Confirm that the external issuer and subject belong to the selected tenant user." });
      return;
    }
    let body: Row;
    try { body = buildAuthIdentityPayload(identityDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: messageOf(error) }); return; }
    const result = await perform(
      () => request("/iam/users/auth-identities", { method: "POST", body }),
      "External authentication identity linked. The change is audit-recorded by the IAM service.",
    );
    if (result) {
      setIdentityDraft({ user_id: "", issuer: "", subject: "" });
      setIdentityAcknowledged(false);
    }
  }

  async function createFlagVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildFeatureFlagPayload(flagDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: messageOf(error) }); return; }
    if (body.security_critical === true && !permissions.criticalFlagWrite) {
      setNotice({ tone: "error", message: "This account is missing feature_flags.security_critical.write." });
      return;
    }
    const result = await perform(
      () => request("/admin/v1/feature-flags", { method: "POST", body }),
      "New immutable feature-flag version created.",
    );
    if (result) {
      setFlagDraft({ key: "", enabled: true, owner: "", security_critical: false, change_reason: "", effective_from: "", expires_at: "", config: "{}" });
    }
  }

  async function evaluateFlag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = evaluationDraft.key.trim();
    if (!key) {
      setNotice({ tone: "error", message: "Enter a feature-flag key to evaluate." });
      return;
    }
    setEvaluating(true);
    setNotice(null);
    try {
      const result = object(await request(buildFlagEvaluationPath(key, evaluationDraft.at)));
      setEvaluation(result);
    } catch (error) {
      setEvaluation(null);
      setNotice({ tone: "error", message: messageOf(error) });
    } finally {
      setEvaluating(false);
    }
  }

  async function createEntitlementVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildEntitlementPayload(entitlementDraft) as Row; }
    catch (error) { setNotice({ tone: "error", message: messageOf(error) }); return; }
    const result = await perform(
      () => request("/admin/v1/entitlements", { method: "POST", body }),
      "New immutable entitlement version created.",
    );
    if (result) {
      setEntitlementDraft({ package: "", feature_key: "", limit_value: "", period: "MONTH", status: "ACTIVE", effective_from: "", effective_to: "", config: "{}" });
    }
  }

  const currentUserPermissions = snapshot?.permissions ?? [];
  const currentUserRoles = snapshot?.roles ?? [];
  const currentFactories = snapshot?.factories ?? [];
  const currentUser = snapshot?.user;

  if (sessionStatus !== "connected") {
    return <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8"><Section title="Tenant governance" subtitle="Connect an authenticated FactoryOS session to review identity and tenant controls."><Empty>Connect from the workspace header first.</Empty></Section></main>;
  }
  if (!activeFactoryId) {
    return <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8"><Section title="Tenant governance" subtitle="The shared session requires an active factory context."><Empty>Select an active factory from the workspace header.</Empty></Section></main>;
  }
  if (!canOpen) {
    return <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8"><Section title="Tenant governance" subtitle="This account does not have a tenant IAM or admin governance permission."><Empty>Ask a tenant administrator to grant an applicable IAM, feature-flag or entitlement permission.</Empty></Section></main>;
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Tenant administration · Governance</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Identity, Access & Feature Governance</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Review tenant membership and authorization, link federated identities, and govern immutable feature and entitlement versions.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600">{display(snapshot?.tenant.name)} · {display(currentFactories.find((factory) => factory.id === activeFactoryId)?.code)}</span>
          <button type="button" className={SECONDARY} onClick={() => setRefreshVersion((value) => value + 1)} disabled={loading || busy}>Refresh</button>
        </div>
      </div>

      {notice ? (
        <div role="status" className={"rounded-xl border px-4 py-3 text-xs leading-5 " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : notice.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-rose-200 bg-rose-50 text-rose-900")}>
          {notice.message}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Active tenant users" value={summary.users} detail="IAM directory rows returned" />
        <Kpi label="Roles" value={summary.roles} detail="Tenant role catalogue" />
        <Kpi label="Permissions" value={summary.permissions} detail="Permission catalogue" />
        <Kpi label="Active factories" value={summary.activeFactories} detail="Tenant factory catalogue" />
        <Kpi label="Latest enabled flags" value={summary.enabledLatestFlags + " / " + summary.latestFlags} detail={summary.securityCriticalLatestFlags + " security-critical keys"} />
        <Kpi label="Active entitlements" value={summary.activeEntitlements} detail={summary.featureFlagVersions + " flag versions loaded"} />
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
        {TABS.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} className={"min-h-10 shrink-0 rounded-lg px-3 text-xs font-semibold " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
      </div>
      <p className="text-xs text-slate-500">{TABS.find((item) => item.id === tab)?.description}</p>
      {loading ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">Loading tenant governance records…</div> : null}
      {loadedFactoryId && loadedFactoryId !== activeFactoryId ? <Empty>Selected factory changed. Reloading tenant-scoped governance data…</Empty> : null}

      {tab === "ACCESS" ? (
        <div className="space-y-5">
          <Section title="Your authenticated access" subtitle="This is the verified IAM snapshot associated with the connected identity and active tenant membership. It is not a global role assignment editor.">
            <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Authenticated principal</p>
                <p className="mt-2 text-base font-bold text-slate-950">{display(currentUser?.displayName)}</p>
                <p className="mt-1 text-xs text-slate-600">{display(currentUser?.email)}</p>
                <p className="mt-3 break-all font-mono text-[10px] text-slate-500">{display(currentUser?.id)}</p>
                <div className="mt-3 flex flex-wrap gap-2"><StatusPill value="ACTIVE" /><StatusPill value={snapshot?.membership.status} /></div>
              </div>
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Current roles</p>
                <div className="mt-3 flex flex-wrap gap-2">{currentUserRoles.length ? currentUserRoles.map((role) => <span key={role.id} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-800">{role.code}</span>) : <span className="text-xs text-slate-500">No role assignment was returned by the IAM snapshot.</span>}</div>
                <p className="mt-4 text-[10px] font-bold uppercase tracking-wider text-slate-500">Granted permission codes</p>
                <p className="mt-2 text-xs font-semibold text-slate-800">{currentUserPermissions.length} permissions in this access snapshot</p>
                <div className="mt-2 max-h-36 overflow-y-auto rounded-lg bg-slate-50 p-2">
                  {currentUserPermissions.map((permission) => <p key={permission.id} className="py-1 font-mono text-[10px] text-slate-600">{permission.code}</p>)}
                </div>
              </div>
            </div>
          </Section>

          <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
            <Section title="Active tenant user directory" subtitle="The IAM endpoint returns users with active tenant membership. Role membership for other users is not inferred from the current-user snapshot.">
              <input className={INPUT + " mb-3"} value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="Search email, display name or user UUID" />
              {permissions.usersRead ? visibleUsers.length ? (
                <Table headers={["User", "Email", "State", "User ID", "Created"]}>
                  {visibleUsers.map((user) => <tr key={String(user.id)}>
                    <td className="px-3 py-3 font-semibold text-slate-900">{display(user.display_name)}</td>
                    <td className="px-3 py-3">{display(user.email)}</td>
                    <td className="px-3 py-3"><StatusPill value={user.status} /></td>
                    <td className="max-w-44 break-all px-3 py-3 font-mono text-[10px] text-slate-500">{display(user.id)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{dateTime(user.created_at)}</td>
                  </tr>)}
                </Table>
              ) : <Empty>No active tenant users were returned.</Empty> : <Empty>Missing permission: iam.users.read.</Empty>}
            </Section>

            <div className="space-y-5">
              <Section title="Tenant roles" subtitle="Catalogue only. Role assignments and edits are not exposed by the current IAM API.">
                {permissions.rolesRead ? roles.length ? <div className="space-y-2">{roles.map((role) => <div key={String(role.id)} className="rounded-lg border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-slate-900">{display(role.code)}</span>{role.is_system ? <StatusPill value="SYSTEM" /> : <StatusPill value="CUSTOM" />}</div><p className="mt-1 text-[11px] text-slate-500">{display(role.name)}</p><p className="mt-1 text-[10px] text-slate-400">{display(role.description)}</p></div>)}</div> : <Empty>No roles were returned.</Empty> : <Empty>Missing permission: iam.roles.read.</Empty>}
              </Section>
              <Section title="Permission catalogue" subtitle="Permission definitions are separate from the grants in your authenticated snapshot.">
                {permissions.permissionsRead ? (
                  <>
                    <input className={INPUT + " mb-3"} value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="Search role or permission catalogue" />
                    <div className="max-h-64 overflow-y-auto space-y-1">
                      {visibleCatalog.filter((item) => item.code).map((item) => <div key={String(item.id)} className="rounded-lg bg-slate-50 px-3 py-2"><p className="font-mono text-[10px] font-semibold text-slate-800">{display(item.code)}</p><p className="mt-1 text-[10px] text-slate-500">{display(item.description, display(item.name))}</p></div>)}
                    </div>
                  </>
                ) : <Empty>Missing permission: iam.permissions.read.</Empty>}
              </Section>
            </div>
          </div>

          <Section title="Link external authentication identity" subtitle="Links an issuer + subject pair to an active tenant user. The API checks uniqueness, verifies membership and writes an audit event. There is no unlink operation exposed here.">
            {permissions.identityWrite ? (
              <form onSubmit={linkIdentity} className="grid gap-3 md:grid-cols-2">
                <Field label="Active tenant user">
                  <select required className={INPUT} value={identityDraft.user_id} onChange={(event) => setIdentityDraft({ ...identityDraft, user_id: event.target.value })}>
                    <option value="">Choose a user</option>
                    {users.map((user) => <option key={String(user.id)} value={String(user.id)}>{display(user.display_name)} · {display(user.email)}</option>)}
                  </select>
                </Field>
                <Field label="Issuer URL / identifier" hint="The exact issuer configured by the external identity provider.">
                  <input required maxLength={500} className={INPUT} value={identityDraft.issuer} onChange={(event) => setIdentityDraft({ ...identityDraft, issuer: event.target.value })} placeholder="https://id.example.com/tenant" />
                </Field>
                <Field label="External subject" hint="Exact subject identifier from the verified IdP; do not enter an email unless that is the IdP subject.">
                  <input required maxLength={255} className={INPUT} value={identityDraft.subject} onChange={(event) => setIdentityDraft({ ...identityDraft, subject: event.target.value })} placeholder="External subject ID" />
                </Field>
                <div className="flex items-end"><label className="flex items-start gap-2 text-[11px] leading-5 text-slate-600"><input type="checkbox" checked={identityAcknowledged} onChange={(event) => setIdentityAcknowledged(event.target.checked)} className="mt-1" />I verified the issuer and subject belong to the selected active tenant user. I understand the API exposes linking but no unlink action in this workbench.</label></div>
                <div className="md:col-span-2 flex justify-end"><button className={PRIMARY} disabled={busy || !users.length || !identityAcknowledged}>Link authentication identity</button></div>
              </form>
            ) : <Empty>Missing permission: iam.users.identities.write.</Empty>}
          </Section>

          <Section title="Factory scope catalogue" subtitle="Active factory context is selected in the workspace header. This list comes from the authenticated tenant snapshot.">
            {currentFactories.length ? <Table headers={["Code", "Factory", "State", "Timezone"]}>{currentFactories.map((factory) => <tr key={factory.id}><td className="px-3 py-3 font-semibold">{factory.code}</td><td className="px-3 py-3">{factory.name}</td><td className="px-3 py-3"><StatusPill value={factory.status} /></td><td className="px-3 py-3">{display(factory.timezone)}</td></tr>)}</Table> : <Empty>No factories were returned.</Empty>}
          </Section>
        </div>
      ) : null}

      {tab === "FLAGS" ? (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
            <Section title="Create new feature-flag version" subtitle="Feature flags are immutable. Creating a new version never edits or deletes an earlier version.">
              {permissions.flagsWrite ? (
                <form onSubmit={createFlagVersion} className="space-y-3">
                  <Field label="Feature key"><input required maxLength={200} className={INPUT} value={flagDraft.key} onChange={(event) => setFlagDraft({ ...flagDraft, key: event.target.value })} placeholder="e.g. wms.offline-sync" /></Field>
                  <Field label="Owner"><input required maxLength={150} className={INPUT} value={flagDraft.owner} onChange={(event) => setFlagDraft({ ...flagDraft, owner: event.target.value })} /></Field>
                  <Field label="New version state"><select className={INPUT} value={String(flagDraft.enabled)} onChange={(event) => setFlagDraft({ ...flagDraft, enabled: event.target.value === "true" })}><option value="true">Enabled</option><option value="false">Disabled</option></select></Field>
                  <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs text-slate-700"><input type="checkbox" checked={flagDraft.security_critical} onChange={(event) => setFlagDraft({ ...flagDraft, security_critical: event.target.checked })} className="mt-0.5" disabled={!permissions.criticalFlagWrite} /><span><span className="font-semibold">Security-critical flag</span><span className="mt-1 block text-[10px] text-slate-500">{permissions.criticalFlagWrite ? "Requires an additional IAM permission and a change reason." : "This account cannot create security-critical versions (missing privileged IAM permission)."}</span></span></label>
                  {flagDraft.security_critical ? <Field label="Security change reason"><textarea required className={AREA} maxLength={2000} value={flagDraft.change_reason} onChange={(event) => setFlagDraft({ ...flagDraft, change_reason: event.target.value })} /></Field> : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Effective from"><input type="datetime-local" className={INPUT} value={flagDraft.effective_from} onChange={(event) => setFlagDraft({ ...flagDraft, effective_from: event.target.value })} /></Field>
                    <Field label="Expires at"><input type="datetime-local" className={INPUT} value={flagDraft.expires_at} onChange={(event) => setFlagDraft({ ...flagDraft, expires_at: event.target.value })} /></Field>
                  </div>
                  <Field label="Config JSON"><textarea spellCheck={false} className={AREA + " min-h-28 font-mono text-[11px]"} value={flagDraft.config} onChange={(event) => setFlagDraft({ ...flagDraft, config: event.target.value })} /></Field>
                  <button className={PRIMARY} disabled={busy || (flagDraft.security_critical && !permissions.criticalFlagWrite)}>Create immutable version</button>
                </form>
              ) : <Empty>Missing permission: feature_flags.write.</Empty>}
            </Section>

            <Section title="Runtime flag evaluation" subtitle="Uses the server's effective-window and subscription-aware resolver. Evaluation failure returns disabled as the safe default.">
              {permissions.flagsRead ? (
                <form onSubmit={evaluateFlag} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                  <Field label="Feature key">
                    <input required list="tenant-governance-flag-keys" className={INPUT} value={evaluationDraft.key} onChange={(event) => setEvaluationDraft({ ...evaluationDraft, key: event.target.value })} placeholder="wms.offline-sync" />
                    <datalist id="tenant-governance-flag-keys">{Array.from(new Set(featureFlags.map((flag) => String(flag.key ?? "")))).filter(Boolean).map((key) => <option key={key} value={key} />)}</datalist>
                  </Field>
                  <Field label="Evaluate at (optional)"><input type="datetime-local" className={INPUT} value={evaluationDraft.at} onChange={(event) => setEvaluationDraft({ ...evaluationDraft, at: event.target.value })} /></Field>
                  <div className="flex items-end"><button className={SECONDARY} disabled={evaluating}>{evaluating ? "Evaluating…" : "Evaluate"}</button></div>
                </form>
              ) : <Empty>Missing permission: feature_flags.read.</Empty>}
              {evaluation ? (
                <div className="mt-4 rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">Server evaluation result</p><StatusPill value={evaluation.enabled === true ? "ENABLED" : "DISABLED"} /></div>
                  <p className="mt-2 text-[11px] text-slate-600">{evaluation.safeDefault === true ? "Safe default applied: the resolver did not return an active flag for this evaluation." : "An effective feature-flag version was resolved by the API."}</p>
                  {evaluation.flag ? <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><p>Key: <strong>{display(object(evaluation.flag).key)}</strong></p><p>Version: <strong>{display(object(evaluation.flag).version)}</strong></p><p>Owner: <strong>{display(object(evaluation.flag).owner)}</strong></p><p>Security critical: <strong>{String(object(evaluation.flag).securityCritical === true)}</strong></p></div> : null}
                </div>
              ) : null}
            </Section>
          </div>

          <Section title="Feature-flag version history" subtitle="API records are sorted by key and descending version. Each row represents a separately persisted immutable version.">
            {permissions.flagsRead ? (
              <>
                <input className={INPUT + " mb-3"} value={flagSearch} onChange={(event) => setFlagSearch(event.target.value)} placeholder="Search feature key, owner, change reason or version" />
                {visibleFlags.length ? <Table headers={["Key", "Version", "State", "Owner", "Critical", "Effective window", "Change reason"]}>{visibleFlags.map((flag) => <tr key={String(flag.id)}>
                  <td className="px-3 py-3 font-mono text-[11px] font-semibold text-slate-900">{display(flag.key)}</td>
                  <td className="px-3 py-3">v{display(flag.version)}</td>
                  <td className="px-3 py-3"><StatusPill value={flag.enabled ? "ENABLED" : "DISABLED"} /></td>
                  <td className="px-3 py-3">{display(flag.owner)}</td>
                  <td className="px-3 py-3">{flag.securityCritical ? <StatusPill value="CRITICAL" /> : "—"}</td>
                  <td className="min-w-44 px-3 py-3 text-[10px] text-slate-600">{dateTime(flag.effectiveFrom)}<span className="block mt-1 text-slate-400">until {dateTime(flag.expiresAt)}</span></td>
                  <td className="max-w-60 px-3 py-3 text-[10px] text-slate-600">{display(flag.changeReason)}</td>
                </tr>)}</Table> : <Empty>No feature-flag versions were returned.</Empty>}
              </>
            ) : <Empty>Missing permission: feature_flags.read.</Empty>}
          </Section>
          <p className="text-[10px] leading-5 text-slate-500">A feature flag is not a substitute for API authorization. The runtime result is informational; backend controllers and permission guards remain authoritative for every protected operation.</p>
        </div>
      ) : null}

      {tab === "ENTITLEMENTS" ? (
        <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
          <Section title="Create new entitlement version" subtitle="Package entitlement rows are append-only versions. Use a new version to change a limit, status, config or effective window.">
            {permissions.entitlementsWrite ? (
              <form onSubmit={createEntitlementVersion} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Package"><input required maxLength={100} className={INPUT} value={entitlementDraft.package} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, package: event.target.value })} placeholder="enterprise" /></Field>
                  <Field label="Feature key"><input required maxLength={150} className={INPUT} value={entitlementDraft.feature_key} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, feature_key: event.target.value })} placeholder="api.calls" /></Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Limit value" hint="Leave blank for an unbounded / null limit."><input type="number" min="0" step="any" className={INPUT} value={entitlementDraft.limit_value} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, limit_value: event.target.value })} /></Field>
                  <Field label="Period"><input maxLength={50} className={INPUT} value={entitlementDraft.period} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, period: event.target.value })} placeholder="MONTH / YEAR / NONE" /></Field>
                </div>
                <Field label="Entitlement status"><select className={INPUT} value={entitlementDraft.status} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, status: event.target.value })}>{["ACTIVE", "DISABLED", "EXPIRED"].map((item) => <option key={item}>{item}</option>)}</select></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Effective from"><input type="datetime-local" className={INPUT} value={entitlementDraft.effective_from} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, effective_from: event.target.value })} /></Field>
                  <Field label="Effective to"><input type="datetime-local" className={INPUT} value={entitlementDraft.effective_to} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, effective_to: event.target.value })} /></Field>
                </div>
                <Field label="Config JSON"><textarea spellCheck={false} className={AREA + " min-h-28 font-mono text-[11px]"} value={entitlementDraft.config} onChange={(event) => setEntitlementDraft({ ...entitlementDraft, config: event.target.value })} /></Field>
                <button className={PRIMARY} disabled={busy}>Create immutable entitlement version</button>
              </form>
            ) : <Empty>Missing permission: entitlements.write.</Empty>}
          </Section>

          <Section title="Entitlement version register" subtitle="Rows are shown in package, feature key and descending version order. Existing entitlement versions are never edited or deleted in this workbench.">
            {permissions.entitlementsRead ? (
              <>
                <input className={INPUT + " mb-3"} value={entitlementSearch} onChange={(event) => setEntitlementSearch(event.target.value)} placeholder="Search package, feature key or status" />
                {visibleEntitlements.length ? <Table headers={["Package / feature", "Version", "Limit", "Period", "State", "Effective window"]}>{visibleEntitlements.map((item) => <tr key={String(item.id)}>
                  <td className="px-3 py-3"><p className="font-semibold text-slate-900">{display(item.package)}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{display(item.featureKey)}</p></td>
                  <td className="px-3 py-3">v{display(item.version)}</td>
                  <td className="px-3 py-3">{display(item.limitValue, "Unbounded")}</td>
                  <td className="px-3 py-3">{display(item.period)}</td>
                  <td className="px-3 py-3"><StatusPill value={item.status} /></td>
                  <td className="min-w-44 px-3 py-3 text-[10px] text-slate-600">{dateTime(item.effectiveFrom)}<span className="mt-1 block text-slate-400">until {dateTime(item.effectiveTo)}</span></td>
                </tr>)}</Table> : <Empty>No entitlement versions were returned.</Empty>}
              </>
            ) : <Empty>Missing permission: entitlements.read.</Empty>}
          </Section>
        </div>
      ) : null}

      <p className="text-[10px] leading-5 text-slate-500">
        This console uses the authenticated tenant session and server permission guards. It does not assign roles, revoke memberships, modify existing versions, or bypass privileged security-critical authorization. External auth linking has no unlink endpoint exposed by the current API. Subscription, feature-flag and entitlement runtime enforcement remains server-side.
      </p>
    </main>
  );
}
