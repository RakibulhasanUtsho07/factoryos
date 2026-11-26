"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildEhsAttendancePayload,
  buildEhsChemicalPayload,
  buildEhsChemicalTransitionPayload,
  buildEhsContractorPayload,
  buildEhsContractorTransitionPayload,
  buildEhsCorrectiveActionPayload,
  buildEhsCorrectiveActionTransitionPayload,
  buildEhsDrillPayload,
  buildEhsDrillResponsePayload,
  buildEhsDrillTransitionPayload,
  buildEhsIncidentPayload,
  buildEhsIncidentTransitionPayload,
  buildEhsListQuery,
  buildEhsPermitPayload,
  buildEhsPermitTransitionPayload,
  normalizeEhsRows,
  summarizeEhs,
} from "@/lib/ehs-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "incidents" | "permits" | "drills" | "chemicals" | "contractors";
type Editor =
  | "INCIDENT_CREATE" | "INCIDENT_TRANSITION" | "CAPA_CREATE" | "CAPA_TRANSITION"
  | "PERMIT_CREATE" | "PERMIT_TRANSITION"
  | "DRILL_CREATE" | "DRILL_TRANSITION" | "ATTENDANCE_CREATE" | "RESPONSE_CREATE"
  | "CHEMICAL_CREATE" | "CHEMICAL_TRANSITION"
  | "CONTRACTOR_CREATE" | "CONTRACTOR_TRANSITION" | "";
type EhsItem = Row & { id: string; status: string; row_version?: number };

const TABS: Array<{ id: Tab; label: string; description: string }> = [
  { id: "incidents", label: "Incidents & CAPA", description: "Report, investigate and independently verify corrective action" },
  { id: "permits", label: "Permit to Work", description: "Risk permits, isolation verification and close-out evidence" },
  { id: "drills", label: "Emergency Drills", description: "Plan drills, record attendance and response evidence" },
  { id: "chemicals", label: "Chemical & SDS", description: "Controlled safety data sheet register and independent activation" },
  { id: "contractors", label: "Contractor Induction", description: "Completed site inductions and expiry/revocation evidence" },
];
const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-9 items-center justify-center rounded-lg px-3 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const warningButton = buttonClass + " border border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100";
const dangerButton = buttonClass + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function textOf(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function numberOf(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The EHS request could not be completed.";
}
function dateTimeLocal(offsetMinutes = 0): string {
  const date = new Date(Date.now() + offsetMinutes * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function localDateTimeLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function dateLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}
function statusTone(value: string): string {
  const status = value.toUpperCase();
  if (["ACTIVE", "APPROVED", "CLOSED", "COMPLETED", "VERIFIED", "PRESENT"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["PENDING_APPROVAL", "IN_PROGRESS", "INVESTIGATING", "READY_FOR_VERIFICATION"].includes(status)) return "border-blue-200 bg-blue-50 text-blue-800";
  if (["HIGH", "CRITICAL", "ACTION_REQUIRED", "EXPIRED", "REVOKED", "REJECTED"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-900";
  if (["CANCELLED", "RETIRED", "INACTIVE", "ABSENT"].includes(status)) return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}
function StatusPill({ value }: { value: string }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide " + statusTone(value)}>{value.replaceAll("_", " ")}</span>;
}
function Metric({ label, value, hint, tone = "slate" }: {
  label: string; value: string | number; hint: string; tone?: "slate" | "blue" | "amber" | "emerald";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
  };
  return <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
    <p className="mt-1 text-[11px] leading-4 text-slate-500">{hint}</p>
  </article>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0">
    <span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>
    {children}
    {hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}
  </label>;
}
function Panel({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: ReactNode; children: ReactNode;
}) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
      <div><h2 className="text-sm font-bold text-slate-950">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{subtitle}</p> : null}</div>
      {action}
    </div>
    <div className="p-4 sm:p-5">{children}</div>
  </section>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs leading-5 text-slate-500">{children}</div>;
}
function SearchFilter({ search, onSearch, status, onStatus, statuses }: {
  search: string; onSearch(value: string): void; status: string; onStatus(value: string): void; statuses: string[];
}) {
  return <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_190px]">
    <input value={search} onChange={(event) => onSearch(event.target.value)} className={inputClass} placeholder="Search loaded records…" aria-label="Search EHS records" />
    <select value={status} onChange={(event) => onStatus(event.target.value)} className={inputClass} aria-label="Filter by status">
      <option value="ALL">All statuses</option>{statuses.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
    </select>
  </div>;
}
function EvidenceBox({ evidence, reason }: { evidence: unknown; reason: unknown }) {
  return <div className="mt-2 rounded-lg bg-slate-50 p-2.5 text-[10px] leading-5 text-slate-600">
    {reason ? <p>Last reason: {String(reason)}</p> : null}
    {evidence ? <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(evidence, null, 2)}</pre> : null}
  </div>;
}

export default function EhsSafetyComplianceWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(snapshot) && Boolean(activeFactoryId);
  const canIncidentRead = hasPermission("ehs.incidents.read");
  const canIncidentReport = hasPermission("ehs.incidents.report");
  const canIncidentManage = hasPermission("ehs.incidents.manage");
  const canCapaVerify = hasPermission("ehs.corrective_actions.verify");
  const canPermitRead = hasPermission("ehs.permits.read");
  const canPermitManage = hasPermission("ehs.permits.manage");
  const canPermitExecute = hasPermission("ehs.permits.execute");
  const canPermitApprove = hasPermission("ehs.permits.approve");
  const canDrillRead = hasPermission("ehs.drills.read");
  const canDrillManage = hasPermission("ehs.drills.manage");
  const canChemicalRead = hasPermission("ehs.chemicals.read");
  const canChemicalManage = hasPermission("ehs.chemicals.manage");
  const canContractorRead = hasPermission("ehs.contractors.read");
  const canContractorManage = hasPermission("ehs.contractors.manage");
  const currentUserId = snapshot?.user?.id ?? "";
  const [clockNow, setClockNow] = useState(0);
  useEffect(() => { const timer = window.setTimeout(() => setClockNow(Date.now()), 0); return () => window.clearTimeout(timer); }, []);

  const [tab, setTab] = useState<Tab>("incidents");
  const [incidents, setIncidents] = useState<EhsItem[]>([]);
  const [permits, setPermits] = useState<EhsItem[]>([]);
  const [drills, setDrills] = useState<EhsItem[]>([]);
  const [chemicals, setChemicals] = useState<EhsItem[]>([]);
  const [contractors, setContractors] = useState<EhsItem[]>([]);
  const [correctiveActions, setCorrectiveActions] = useState<EhsItem[]>([]);
  const [attendance, setAttendance] = useState<EhsItem[]>([]);
  const [responses, setResponses] = useState<EhsItem[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState("");
  const [selectedPermitId, setSelectedPermitId] = useState("");
  const [selectedDrillId, setSelectedDrillId] = useState("");
  const [selectedChemicalId, setSelectedChemicalId] = useState("");
  const [selectedContractorId, setSelectedContractorId] = useState("");
  const [loading, setLoading] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor>("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const selectedIncident = incidents.find(item => item.id === selectedIncidentId) ?? null;
  const selectedPermit = permits.find(item => item.id === selectedPermitId) ?? null;
  const selectedDrill = drills.find(item => item.id === selectedDrillId) ?? null;
  const selectedChemical = chemicals.find(item => item.id === selectedChemicalId) ?? null;
  const selectedContractor = contractors.find(item => item.id === selectedContractorId) ?? null;
  const permitIsolationVerified = selectedPermit?.requires_isolation !== true || Boolean(selectedPermit.isolation_verified_at);
  const drillHasCompletionEvidence = Boolean(selectedDrill && numberOf(selectedDrill.present_count) > 0 && numberOf(selectedDrill.response_count) > 0);
  const activeFactory = snapshot?.factories.find(factory => factory.id === activeFactoryId);
  const summary = useMemo(() => summarizeEhs({ incidents, permits, drills, chemicals, contractors }), [incidents, permits, drills, chemicals, contractors]);

  const visibleIncidents = useMemo(() => incidents.filter(item =>
    (statusFilter === "ALL" || item.status === statusFilter)
    && [item.incident_number,item.title,item.location,item.incident_type].some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
  ), [incidents,statusFilter,search]);
  const visiblePermits = useMemo(() => permits.filter(item =>
    (statusFilter === "ALL" || item.status === statusFilter)
    && [item.permit_number,item.title,item.location,item.permit_type].some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
  ), [permits,statusFilter,search]);
  const visibleDrills = useMemo(() => drills.filter(item =>
    (statusFilter === "ALL" || item.status === statusFilter)
    && [item.drill_number,item.title,item.location,item.drill_type].some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
  ), [drills,statusFilter,search]);
  const visibleChemicals = useMemo(() => chemicals.filter(item =>
    (statusFilter === "ALL" || item.status === statusFilter)
    && [item.chemical_code,item.chemical_name,item.hazard_class,item.storage_location].some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
  ), [chemicals,statusFilter,search]);
  const visibleContractors = useMemo(() => contractors.filter(item =>
    (statusFilter === "ALL" || item.status === statusFilter)
    && [item.contractor_code,item.company_name,item.person_name].some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
  ), [contractors,statusFilter,search]);

  const loadWorkspace = useCallback(async () => {
    if (!connected) {
      setIncidents([]); setPermits([]); setDrills([]); setChemicals([]); setContractors([]);
      setSelectedIncidentId(""); setSelectedPermitId(""); setSelectedDrillId(""); setSelectedChemicalId(""); setSelectedContractorId("");
      return;
    }
    setLoading(true);
    setError("");
    const errors: string[] = [];
    const safe = async (
      name: string,
      endpoint: string,
      permitted: boolean,
      setter: (rows: EhsItem[]) => void,
      kind: string,
      select: Dispatch<SetStateAction<string>>,
    ) => {
      if (!permitted) { setter([]); select(""); return; }
      try {
        const response = await request(endpoint + buildEhsListQuery({ limit: 100 }, kind));
        const next = normalizeEhsRows(response) as EhsItem[];
        setter(next);
        select(current => current && next.some(item => item.id === current) ? current : next[0]?.id ?? "");
      } catch (cause) {
        errors.push(name + ": " + messageOf(cause));
        setter([]);
        select("");
      }
    };
    await Promise.all([
      safe("Incidents","/ehs/incidents",canIncidentRead,setIncidents,"incidents",setSelectedIncidentId),
      safe("Permits","/ehs/permits",canPermitRead,setPermits,"permits",setSelectedPermitId),
      safe("Drills","/ehs/drills",canDrillRead,setDrills,"drills",setSelectedDrillId),
      safe("Chemical SDS","/ehs/chemicals",canChemicalRead,setChemicals,"chemicals",setSelectedChemicalId),
      safe("Contractor inductions","/ehs/contractors/inductions",canContractorRead,setContractors,"contractors",setSelectedContractorId),
    ]);
    if (errors.length) setError(errors.join(" · "));
    setLoading(false);
  }, [
    connected,canIncidentRead,canPermitRead,canDrillRead,canChemicalRead,canContractorRead,request
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  const loadIncidentActions = useCallback(async (incidentId: string) => {
    if (!incidentId || !canIncidentRead) { setCorrectiveActions([]); return; }
    setRelatedLoading(true);
    try {
      const response = await request("/ehs/incidents/" + encodeURIComponent(incidentId) + "/corrective-actions?limit=100");
      setCorrectiveActions(normalizeEhsRows(response) as EhsItem[]);
    } catch (cause) {
      setCorrectiveActions([]);
      setError(messageOf(cause));
    } finally { setRelatedLoading(false); }
  }, [request,canIncidentRead]);

  useEffect(() => {
    if (tab !== "incidents" || !selectedIncidentId) return;
    const timer = window.setTimeout(() => { void loadIncidentActions(selectedIncidentId); }, 0);
    return () => window.clearTimeout(timer);
  }, [tab,selectedIncidentId,loadIncidentActions]);

  const loadDrillEvidence = useCallback(async (drillId: string) => {
    if (!drillId || !canDrillRead) { setAttendance([]); setResponses([]); return; }
    setRelatedLoading(true);
    try {
      const [a,r] = await Promise.all([
        request("/ehs/drills/" + encodeURIComponent(drillId) + "/attendance?limit=200"),
        request("/ehs/drills/" + encodeURIComponent(drillId) + "/responses?limit=200"),
      ]);
      setAttendance(normalizeEhsRows(a) as EhsItem[]);
      setResponses(normalizeEhsRows(r) as EhsItem[]);
    } catch (cause) {
      setAttendance([]); setResponses([]);
      setError(messageOf(cause));
    } finally { setRelatedLoading(false); }
  }, [request,canDrillRead]);

  useEffect(() => {
    if (tab !== "drills" || !selectedDrillId) return;
    const timer = window.setTimeout(() => { void loadDrillEvidence(selectedDrillId); }, 0);
    return () => window.clearTimeout(timer);
  }, [tab,selectedDrillId,loadDrillEvidence]);

  function openEditor(kind: Editor, values: Record<string,string> = {}) {
    setEditor(kind);
    setDraft(values);
    setError("");
    setNotice("");
  }
  function update(field: string, value: string) {
    setDraft(current => ({ ...current, [field]: value }));
  }
  function closeEditor() {
    setEditor("");
    setDraft({});
  }

  async function refreshAfterMutation(message: string) {
    setNotice(message);
    closeEditor();
    await loadWorkspace();
    if (selectedIncidentId) await loadIncidentActions(selectedIncidentId);
    if (selectedDrillId) await loadDrillEvidence(selectedDrillId);
  }

  async function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      switch (editor) {
        case "INCIDENT_CREATE": {
          if (!canIncidentReport) throw new Error("Missing ehs.incidents.report permission.");
          await request("/ehs/incidents", {
            method: "POST",
            body: buildEhsIncidentPayload({
              ...draft,
              occurred_at: draft.occurred_at,
              due_at: draft.due_at,
            }),
            idempotencyKey: "ehs-incident-" + window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Safety incident reported. The server assigned its incident number and OPEN status.");
          break;
        }
        case "INCIDENT_TRANSITION": {
          if (!selectedIncident || !canIncidentManage) throw new Error("Missing incident-management permission or selected incident.");
          await request("/ehs/incidents/" + encodeURIComponent(selectedIncident.id) + "/transition", {
            method: "POST",
            body: buildEhsIncidentTransitionPayload({
              ...draft, expected_version: selectedIncident.row_version,
              closure_evidence: draft.closure_evidence_ref ? { reference: draft.closure_evidence_ref, notes: draft.closure_evidence_notes ?? "" } : undefined,
            }),
          });
          await refreshAfterMutation("Incident lifecycle transition recorded with expected-version protection.");
          break;
        }
        case "CAPA_CREATE": {
          if (!selectedIncident || !canIncidentManage) throw new Error("Select an incident and confirm corrective-action permission.");
          await request("/ehs/corrective-actions", {
            method: "POST",
            body: buildEhsCorrectiveActionPayload({ ...draft, incident_id: selectedIncident.id }),
            idempotencyKey: "ehs-capa-" + window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Corrective action created and linked to the selected incident.");
          break;
        }
        case "CAPA_TRANSITION": {
          const action = correctiveActions.find(item => item.id === draft.action_id);
          const command = draft.action ?? "";
          if (!action) throw new Error("Select a corrective action before continuing.");
          if (command === "VERIFY" ? !canCapaVerify : !canIncidentManage) {
            throw new Error(command === "VERIFY" ? "Independent verification permission is required." : "Corrective-action management permission is required.");
          }
          await request("/ehs/corrective-actions/" + encodeURIComponent(action.id) + (command === "VERIFY" ? "/verify" : "/transition"), {
            method: "POST",
            body: buildEhsCorrectiveActionTransitionPayload({
              ...draft, expected_version: action.row_version,
              completion_evidence: draft.completion_evidence_ref ? { reference: draft.completion_evidence_ref, notes: draft.completion_evidence_notes ?? "" } : undefined,
              verification_evidence: draft.verification_evidence_ref ? { reference: draft.verification_evidence_ref, notes: draft.verification_evidence_notes ?? "" } : undefined,
            }),
          });
          await refreshAfterMutation("Corrective-action transition recorded. Verification remains a separate permission-controlled step.");
          break;
        }
        case "PERMIT_CREATE": {
          if (!canPermitManage) throw new Error("Missing ehs.permits.manage permission.");
          const isolationPoints = (draft.isolation_points_text ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
            const index = line.indexOf("|");
            return index < 0 ? { code: line, description: "" } : { code: line.slice(0,index).trim(), description: line.slice(index+1).trim() };
          });
          await request("/ehs/permits", {
            method: "POST",
            body: buildEhsPermitPayload({ ...draft, isolation_points: isolationPoints }),
            idempotencyKey: "ehs-permit-" + window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Permit-to-work request created as a draft. Approval and activation are separate steps.");
          break;
        }
        case "PERMIT_TRANSITION": {
          if (!selectedPermit) throw new Error("Select a safety permit before taking an action.");
          const action = draft.action ?? "";
          const isDecision = ["APPROVE","REJECT"].includes(action);
          if (isDecision && !canPermitApprove) throw new Error("Permit decision permission is required.");
          if (!isDecision && !canPermitExecute) throw new Error("Permit execution permission is required.");
          const verification = (draft.isolation_verification_text ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
            const index=line.indexOf("|");
            return { code:index<0?line:line.slice(0,index).trim(), verified:true, evidence:index<0?"Evidence confirmed by operator":line.slice(index+1).trim() };
          });
          const payload = buildEhsPermitTransitionPayload({
            ...draft, expected_version:selectedPermit.row_version,
            isolation_verification:verification,
            closure_evidence:draft.closure_evidence_ref?{reference:draft.closure_evidence_ref,notes:draft.closure_evidence_notes??""}:undefined,
          });
          const route = isDecision ? "/decision" : "/transition";
          await request("/ehs/permits/" + encodeURIComponent(selectedPermit.id) + route, { method:"POST", body:payload });
          await refreshAfterMutation("Permit action recorded. Isolation and approval evidence remain separately auditable.");
          break;
        }
        case "DRILL_CREATE": {
          if (!canDrillManage) throw new Error("Missing ehs.drills.manage permission.");
          await request("/ehs/drills", {
            method:"POST",body:buildEhsDrillPayload(draft),
            idempotencyKey:"ehs-drill-"+window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Emergency drill planned. Attendance and response evidence are captured during execution.");
          break;
        }
        case "DRILL_TRANSITION": {
          if (!selectedDrill || !canDrillManage) throw new Error("Select a drill and confirm drill-management permission.");
          const payload=buildEhsDrillTransitionPayload({
            ...draft,expected_version:selectedDrill.row_version,
            close_evidence:draft.close_evidence_ref?{reference:draft.close_evidence_ref,notes:draft.close_evidence_notes??""}:undefined,
          });
          await request("/ehs/drills/"+encodeURIComponent(selectedDrill.id)+"/transition",{method:"POST",body:payload});
          await refreshAfterMutation("Emergency drill lifecycle action recorded.");
          break;
        }
        case "ATTENDANCE_CREATE": {
          if (!selectedDrill || !canDrillManage) throw new Error("Select a drill and confirm drill-management permission.");
          await request("/ehs/drills/"+encodeURIComponent(selectedDrill.id)+"/attendance",{
            method:"POST",body:buildEhsAttendancePayload({...draft,user_id:draft.user_id||undefined}),
            idempotencyKey:"ehs-attendance-"+window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Drill attendance recorded. Duplicate attendee references are rejected by the API.");
          break;
        }
        case "RESPONSE_CREATE": {
          if (!selectedDrill || !canDrillManage) throw new Error("Select a drill and confirm drill-management permission.");
          await request("/ehs/drills/"+encodeURIComponent(selectedDrill.id)+"/responses",{
            method:"POST",
            body:buildEhsDrillResponsePayload({
              ...draft,
              occurred_at:draft.occurred_at,
              responder_user_id:draft.responder_user_id||undefined,
              elapsed_seconds:draft.elapsed_seconds||undefined,
              evidence:draft.evidence_ref?{reference:draft.evidence_ref,notes:draft.evidence_notes??""}:{},
            }),
            idempotencyKey:"ehs-drill-response-"+window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Drill response evidence recorded with timestamp and provenance.");
          break;
        }
        case "CHEMICAL_CREATE": {
          if (!canChemicalManage) throw new Error("Missing ehs.chemicals.manage permission.");
          await request("/ehs/chemicals",{
            method:"POST",body:buildEhsChemicalPayload(draft),
            idempotencyKey:"ehs-chemical-sds-"+window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Chemical/SDS record registered as a draft. Activation requires an independent approver.");
          break;
        }
        case "CHEMICAL_TRANSITION": {
          if (!selectedChemical || !canChemicalManage) throw new Error("Select an SDS record and confirm management permission.");
          await request("/ehs/chemicals/"+encodeURIComponent(selectedChemical.id)+"/transition",{
            method:"POST",body:buildEhsChemicalTransitionPayload({...draft,expected_version:selectedChemical.row_version}),
          });
          await refreshAfterMutation("Chemical/SDS lifecycle action recorded.");
          break;
        }
        case "CONTRACTOR_CREATE": {
          if (!canContractorManage) throw new Error("Missing ehs.contractors.manage permission.");
          const topics=(draft.topics_text??"").split(/[,;\n]+/).map(value=>value.trim()).filter(Boolean);
          await request("/ehs/contractors/inductions",{
            method:"POST",
            body:buildEhsContractorPayload({...draft,topics,evidence:draft.evidence_ref?{reference:draft.evidence_ref,notes:draft.evidence_notes??""}:{}}),
            idempotencyKey:"ehs-contractor-induction-"+window.crypto.randomUUID(),
          });
          await refreshAfterMutation("Completed contractor induction evidence recorded. Future training cannot be marked complete.");
          break;
        }
        case "CONTRACTOR_TRANSITION": {
          if (!selectedContractor || !canContractorManage) throw new Error("Select a contractor induction and confirm management permission.");
          await request("/ehs/contractors/inductions/"+encodeURIComponent(selectedContractor.id)+"/transition",{
            method:"POST",body:buildEhsContractorTransitionPayload({...draft,expected_version:selectedContractor.row_version}),
          });
          await refreshAfterMutation("Contractor induction status updated with reason and version protection.");
          break;
        }
        default:
          throw new Error("Select a supported EHS action.");
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function startIncidentTransition(action: string) {
    openEditor("INCIDENT_TRANSITION",{action,reason:"",investigation_summary:String(selectedIncident?.investigation_summary??""),root_cause:String(selectedIncident?.root_cause??""),closure_evidence_ref:"",closure_evidence_notes:""});
  }
  function startPermitTransition(action: string) {
    const points=Array.isArray(selectedPermit?.isolation_points)?selectedPermit?.isolation_points as Array<Row>:[];
    openEditor("PERMIT_TRANSITION",{
      action,reason:"",decision_reason:"",closure_reason:"",
      isolation_verification_text:points.map(point=>textOf(point.code)+"|").join("\n"),
      closure_evidence_ref:"",closure_evidence_notes:"",
    });
  }

  function renderEditorFields(): ReactNode {
    switch (editor) {
      case "INCIDENT_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Incident type"><select required className={inputClass} value={draft.incident_type??"NEAR_MISS"} onChange={e=>update("incident_type",e.target.value)}>{["INCIDENT","NEAR_MISS","UNSAFE_OBSERVATION","INJURY","ENVIRONMENTAL_RELEASE","AUDIT_FINDING"].map(v=><option key={v}>{v}</option>)}</select></Field>
            <Field label="Severity"><select required className={inputClass} value={draft.severity??"MEDIUM"} onChange={e=>update("severity",e.target.value)}>{["LOW","MEDIUM","HIGH","CRITICAL"].map(v=><option key={v}>{v}</option>)}</select></Field>
            <Field label="Title"><input required maxLength={255} className={inputClass} value={draft.title??""} onChange={e=>update("title",e.target.value)}/></Field>
            <Field label="Location"><input required maxLength={255} className={inputClass} value={draft.location??""} onChange={e=>update("location",e.target.value)}/></Field>
            <Field label="Occurred at"><input required type="datetime-local" className={inputClass} value={draft.occurred_at??""} onChange={e=>update("occurred_at",e.target.value)}/></Field>
            <Field label="Corrective action due (optional)"><input type="datetime-local" className={inputClass} value={draft.due_at??""} onChange={e=>update("due_at",e.target.value)}/></Field>
            <Field label="Assigned owner user UUID" hint="Must identify an existing user in the authenticated tenant."><input className={inputClass} value={draft.assigned_owner_user_id??""} onChange={e=>update("assigned_owner_user_id",e.target.value)} placeholder="Optional user UUID"/></Field>
            <Field label="Immediate action"><input className={inputClass} maxLength={2000} value={draft.immediate_action??""} onChange={e=>update("immediate_action",e.target.value)}/></Field>
          </div>
          <Field label="Description"><textarea required rows={4} maxLength={4000} className={inputClass} value={draft.description??""} onChange={e=>update("description",e.target.value)}/></Field>
        </>;
      case "INCIDENT_TRANSITION":
        return <>
          <Field label="Action"><select className={inputClass} value={draft.action??""} onChange={e=>update("action",e.target.value)}>{["START_INVESTIGATION","REQUIRE_ACTION","RESOLVE","CLOSE","REOPEN","CANCEL"].map(v=><option key={v}>{v}</option>)}</select></Field>
          <Field label="Reason"><textarea required rows={2} maxLength={2000} className={inputClass} value={draft.reason??""} onChange={e=>update("reason",e.target.value)}/></Field>
          {["START_INVESTIGATION","REQUIRE_ACTION"].includes(draft.action??"")?<Field label="Investigation summary"><textarea rows={3} maxLength={4000} className={inputClass} value={draft.investigation_summary??""} onChange={e=>update("investigation_summary",e.target.value)}/></Field>:null}
          {["RESOLVE","CLOSE"].includes(draft.action??"")?<><Field label="Root cause"><textarea required rows={3} maxLength={4000} className={inputClass} value={draft.root_cause??""} onChange={e=>update("root_cause",e.target.value)}/></Field><Field label="Closure evidence reference"><input required maxLength={500} className={inputClass} value={draft.closure_evidence_ref??""} onChange={e=>update("closure_evidence_ref",e.target.value)}/></Field><Field label="Closure evidence notes"><textarea rows={2} className={inputClass} value={draft.closure_evidence_notes??""} onChange={e=>update("closure_evidence_notes",e.target.value)}/></Field></>:null}
        </>;
      case "CAPA_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Action number"><input required maxLength={100} className={inputClass} value={draft.action_number??""} onChange={e=>update("action_number",e.target.value)}/></Field><Field label="Owner user UUID"><input required className={inputClass} value={draft.assigned_owner_user_id??currentUserId} onChange={e=>update("assigned_owner_user_id",e.target.value)}/></Field><Field label="Due at"><input required type="datetime-local" className={inputClass} value={draft.due_at??""} onChange={e=>update("due_at",e.target.value)}/></Field></div>
          <Field label="Corrective action description"><textarea required rows={3} maxLength={4000} className={inputClass} value={draft.description??""} onChange={e=>update("description",e.target.value)}/></Field>
        </>;
      case "CAPA_TRANSITION":
        return <>
          <Field label="Corrective-action command"><select className={inputClass} value={draft.action??""} onChange={e=>update("action",e.target.value)}>{["START","SUBMIT_FOR_VERIFICATION","VERIFY","REOPEN","CANCEL"].map(v=><option key={v}>{v}</option>)}</select></Field>
          <Field label="Reason"><textarea required rows={2} maxLength={2000} className={inputClass} value={draft.reason??""} onChange={e=>update("reason",e.target.value)}/></Field>
          {draft.action==="SUBMIT_FOR_VERIFICATION"?<><Field label="Root cause"><textarea required rows={2} className={inputClass} value={draft.root_cause??""} onChange={e=>update("root_cause",e.target.value)}/></Field><Field label="Completion evidence reference"><input required className={inputClass} value={draft.completion_evidence_ref??""} onChange={e=>update("completion_evidence_ref",e.target.value)}/></Field><Field label="Completion notes"><textarea rows={2} className={inputClass} value={draft.completion_evidence_notes??""} onChange={e=>update("completion_evidence_notes",e.target.value)}/></Field></>:null}
          {draft.action==="VERIFY"?<><Field label="Independent verification evidence reference"><input required className={inputClass} value={draft.verification_evidence_ref??""} onChange={e=>update("verification_evidence_ref",e.target.value)}/></Field><Field label="Verification notes"><textarea rows={2} className={inputClass} value={draft.verification_evidence_notes??""} onChange={e=>update("verification_evidence_notes",e.target.value)}/></Field></>:null}
        </>;
      case "PERMIT_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="Permit number"><input required className={inputClass} maxLength={100} value={draft.permit_number??""} onChange={e=>update("permit_number",e.target.value)}/></Field>
            <Field label="Permit type"><select className={inputClass} value={draft.permit_type??"GENERAL"} onChange={e=>update("permit_type",e.target.value)}>{["HOT_WORK","ELECTRICAL_LOTO","CONFINED_SPACE","WORK_AT_HEIGHT","CHEMICAL_HANDLING","GENERAL"].map(v=><option key={v}>{v}</option>)}</select></Field>
            <Field label="Risk level"><select className={inputClass} value={draft.risk_level??"LOW"} onChange={e=>update("risk_level",e.target.value)}>{["LOW","MEDIUM","HIGH","CRITICAL"].map(v=><option key={v}>{v}</option>)}</select></Field>
            <Field label="Title"><input required className={inputClass} maxLength={255} value={draft.title??""} onChange={e=>update("title",e.target.value)}/></Field>
            <Field label="Location"><input required className={inputClass} maxLength={255} value={draft.location??""} onChange={e=>update("location",e.target.value)}/></Field>
            <Field label="Linked work order UUID (optional)"><input className={inputClass} value={draft.work_order_id??""} onChange={e=>update("work_order_id",e.target.value)}/></Field>
            <Field label="Valid from"><input required type="datetime-local" className={inputClass} value={draft.valid_from??""} onChange={e=>update("valid_from",e.target.value)}/></Field>
            <Field label="Expires at"><input required type="datetime-local" className={inputClass} value={draft.expires_at??""} onChange={e=>update("expires_at",e.target.value)}/></Field>
          </div>
          <Field label="Work scope"><textarea required rows={3} maxLength={4000} className={inputClass} value={draft.work_scope??""} onChange={e=>update("work_scope",e.target.value)}/></Field>
          <Field label="Isolation points" hint="For high/critical risk, LOTO or confined-space permits, enter one per line as CODE | description.">
            <textarea rows={3} className={inputClass} value={draft.isolation_points_text??""} onChange={e=>update("isolation_points_text",e.target.value)} placeholder={"MAIN-BREAKER | Isolate main supply\nAIR-VALVE | Lock pneumatic supply"}/>
          </Field>
        </>;
      case "PERMIT_TRANSITION":
        return <>
          <Field label="Permit action"><select className={inputClass} value={draft.action??""} onChange={e=>update("action",e.target.value)}>{["SUBMIT","APPROVE","REJECT","VERIFY_ISOLATION","ACTIVATE","CLOSE","CANCEL","EXPIRE"].map(v=><option key={v}>{v}</option>)}</select></Field>
          <Field label="Reason"><textarea required rows={2} maxLength={2000} className={inputClass} value={draft.reason??""} onChange={e=>update("reason",e.target.value)}/></Field>
          {["APPROVE","REJECT"].includes(draft.action??"")?<Field label="Independent decision reason"><textarea required rows={2} maxLength={2000} className={inputClass} value={draft.decision_reason??""} onChange={e=>update("decision_reason",e.target.value)}/></Field>:null}
          {draft.action==="VERIFY_ISOLATION"?<Field label="Isolation verification" hint="Every declared isolation point must be listed as CODE | positive verification evidence. All entries are submitted as verified; only report checks actually performed."><textarea required rows={4} className={inputClass} value={draft.isolation_verification_text??""} onChange={e=>update("isolation_verification_text",e.target.value)}/></Field>:null}
          {draft.action==="CLOSE"?<><Field label="Closure reason"><textarea required rows={2} maxLength={2000} className={inputClass} value={draft.closure_reason??""} onChange={e=>update("closure_reason",e.target.value)}/></Field><Field label="Close-out evidence reference"><input required className={inputClass} value={draft.closure_evidence_ref??""} onChange={e=>update("closure_evidence_ref",e.target.value)}/></Field><Field label="Evidence notes"><textarea rows={2} className={inputClass} value={draft.closure_evidence_notes??""} onChange={e=>update("closure_evidence_notes",e.target.value)}/></Field></>:null}
        </>;
      case "DRILL_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Drill number"><input required className={inputClass} maxLength={100} value={draft.drill_number??""} onChange={e=>update("drill_number",e.target.value)}/></Field>
            <Field label="Drill type"><select className={inputClass} value={draft.drill_type??"EVACUATION"} onChange={e=>update("drill_type",e.target.value)}>{["FIRE","EVACUATION","CHEMICAL_SPILL","MEDICAL","NATURAL_DISASTER","OTHER"].map(v=><option key={v}>{v}</option>)}</select></Field>
            <Field label="Title"><input required className={inputClass} value={draft.title??""} onChange={e=>update("title",e.target.value)}/></Field>
            <Field label="Location"><input required className={inputClass} value={draft.location??""} onChange={e=>update("location",e.target.value)}/></Field>
            <Field label="Planned at"><input required type="datetime-local" className={inputClass} value={draft.planned_at??""} onChange={e=>update("planned_at",e.target.value)}/></Field>
            <Field label="Owner user UUID"><input required className={inputClass} value={draft.owner_user_id??currentUserId} onChange={e=>update("owner_user_id",e.target.value)}/></Field>
          </div>
        </>;
      case "DRILL_TRANSITION":
        return <>
          <Field label="Drill action"><select className={inputClass} value={draft.action??""} onChange={e=>update("action",e.target.value)}>{selectedDrill?.status==="PLANNED"?<option>START</option>:null}{selectedDrill?.status==="IN_PROGRESS"&&drillHasCompletionEvidence?<option>COMPLETE</option>:null}{["PLANNED","IN_PROGRESS"].includes(selectedDrill?.status??"")?<option>CANCEL</option>:null}</select></Field>
          <Field label="Reason"><textarea required rows={2} className={inputClass} value={draft.reason??""} onChange={e=>update("reason",e.target.value)}/></Field>
          {draft.action==="COMPLETE"?<><Field label="Outcome summary"><textarea required rows={3} maxLength={4000} className={inputClass} value={draft.outcome_summary??""} onChange={e=>update("outcome_summary",e.target.value)}/></Field><Field label="Close-out evidence reference"><input required className={inputClass} value={draft.close_evidence_ref??""} onChange={e=>update("close_evidence_ref",e.target.value)}/></Field><Field label="Evidence notes"><textarea rows={2} className={inputClass} value={draft.close_evidence_notes??""} onChange={e=>update("close_evidence_notes",e.target.value)}/></Field></>:null}
        </>;
      case "ATTENDANCE_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Attendee reference"><input required maxLength={160} className={inputClass} value={draft.attendee_ref??""} onChange={e=>update("attendee_ref",e.target.value)}/></Field>
            <Field label="Attendee name"><input required maxLength={255} className={inputClass} value={draft.attendee_name??""} onChange={e=>update("attendee_name",e.target.value)}/></Field>
            <Field label="Tenant user UUID (optional)"><input className={inputClass} value={draft.user_id??""} onChange={e=>update("user_id",e.target.value)}/></Field>
            <Field label="Attendance"><select className={inputClass} value={draft.attendance_status??"PRESENT"} onChange={e=>update("attendance_status",e.target.value)}>{["PRESENT","ABSENT","EXCUSED"].map(v=><option key={v}>{v}</option>)}</select></Field>
          </div>
          <Field label="Attendance notes"><textarea rows={2} className={inputClass} value={draft.notes??""} onChange={e=>update("notes",e.target.value)}/></Field>
        </>;
      case "RESPONSE_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Response code"><input required maxLength={100} className={inputClass} value={draft.response_code??""} onChange={e=>update("response_code",e.target.value)}/></Field>
            <Field label="Responder user UUID (optional)"><input className={inputClass} value={draft.responder_user_id??""} onChange={e=>update("responder_user_id",e.target.value)}/></Field>
            <Field label="Occurred at"><input type="datetime-local" required className={inputClass} value={draft.occurred_at??""} onChange={e=>update("occurred_at",e.target.value)}/></Field>
            <Field label="Elapsed seconds"><input type="number" min="0" max="604800" step="1" className={inputClass} value={draft.elapsed_seconds??""} onChange={e=>update("elapsed_seconds",e.target.value)}/></Field>
          </div>
          <Field label="Response action"><textarea required rows={3} maxLength={4000} className={inputClass} value={draft.response_action??""} onChange={e=>update("response_action",e.target.value)}/></Field>
          <Field label="Evidence reference"><input required className={inputClass} value={draft.evidence_ref??""} onChange={e=>update("evidence_ref",e.target.value)}/></Field>
          <Field label="Evidence notes"><textarea rows={2} className={inputClass} value={draft.evidence_notes??""} onChange={e=>update("evidence_notes",e.target.value)}/></Field>
        </>;
      case "CHEMICAL_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Chemical code"><input required className={inputClass} maxLength={100} value={draft.chemical_code??""} onChange={e=>update("chemical_code",e.target.value)}/></Field>
            <Field label="Chemical name"><input required className={inputClass} maxLength={255} value={draft.chemical_name??""} onChange={e=>update("chemical_name",e.target.value)}/></Field>
            <Field label="Manufacturer"><input className={inputClass} maxLength={255} value={draft.manufacturer??""} onChange={e=>update("manufacturer",e.target.value)}/></Field>
            <Field label="Hazard class"><input required className={inputClass} maxLength={100} value={draft.hazard_class??""} onChange={e=>update("hazard_class",e.target.value)}/></Field>
            <Field label="Storage location"><input required className={inputClass} maxLength={255} value={draft.storage_location??""} onChange={e=>update("storage_location",e.target.value)}/></Field>
            <Field label="SDS revision"><input required className={inputClass} maxLength={100} value={draft.sds_revision??""} onChange={e=>update("sds_revision",e.target.value)}/></Field>
            <Field label="SDS issue date"><input required type="datetime-local" className={inputClass} value={draft.sds_issued_at??""} onChange={e=>update("sds_issued_at",e.target.value)}/></Field>
            <Field label="Review due date"><input required type="datetime-local" className={inputClass} value={draft.sds_review_due_at??""} onChange={e=>update("sds_review_due_at",e.target.value)}/></Field>
          </div>
          <Field label="Controlled SDS document URI" hint="Only credential-free HTTPS, S3 or Google Cloud Storage URIs are supported; this form does not upload files."><input required type="url" maxLength={2048} className={inputClass} placeholder="https://… or s3://… or gs://…" value={draft.sds_document_uri??""} onChange={e=>update("sds_document_uri",e.target.value)}/></Field>
          <Field label="Handling instructions"><textarea required rows={3} maxLength={4000} className={inputClass} value={draft.handling_instructions??""} onChange={e=>update("handling_instructions",e.target.value)}/></Field>
          <Field label="Emergency instructions"><textarea required rows={3} maxLength={4000} className={inputClass} value={draft.emergency_instructions??""} onChange={e=>update("emergency_instructions",e.target.value)}/></Field>
        </>;
      case "CHEMICAL_TRANSITION":
        return <>
          <Field label="Chemical/SDS action"><select className={inputClass} value={draft.action??""} onChange={e=>update("action",e.target.value)}>{["ACTIVATE","DEACTIVATE","RETIRE"].map(v=><option key={v}>{v}</option>)}</select></Field>
          <Field label="Reason"><textarea required rows={3} maxLength={2000} className={inputClass} value={draft.reason??""} onChange={e=>update("reason",e.target.value)}/></Field>
        </>;
      case "CONTRACTOR_CREATE":
        return <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Contractor code"><input required maxLength={100} className={inputClass} value={draft.contractor_code??""} onChange={e=>update("contractor_code",e.target.value)}/></Field>
            <Field label="Company name"><input required maxLength={255} className={inputClass} value={draft.company_name??""} onChange={e=>update("company_name",e.target.value)}/></Field>
            <Field label="Person name"><input required maxLength={255} className={inputClass} value={draft.person_name??""} onChange={e=>update("person_name",e.target.value)}/></Field>
            <Field label="Induction completed at"><input required type="datetime-local" className={inputClass} value={draft.induction_at??""} onChange={e=>update("induction_at",e.target.value)}/></Field>
            <Field label="Induction expires at"><input required type="datetime-local" className={inputClass} value={draft.expires_at??""} onChange={e=>update("expires_at",e.target.value)}/></Field>
          </div>
          <Field label="Completed induction topics" hint="Comma or newline separated; only completed topics should be entered."><textarea required rows={3} className={inputClass} value={draft.topics_text??""} onChange={e=>update("topics_text",e.target.value)} placeholder="PPE, Emergency routes, Restricted areas"/></Field>
          <Field label="Training evidence reference"><input required className={inputClass} value={draft.evidence_ref??""} onChange={e=>update("evidence_ref",e.target.value)}/></Field>
          <Field label="Evidence notes"><textarea rows={2} className={inputClass} value={draft.evidence_notes??""} onChange={e=>update("evidence_notes",e.target.value)}/></Field>
        </>;
      case "CONTRACTOR_TRANSITION":
        return <>
          <Field label="Induction action"><select className={inputClass} value={draft.action??"REVOKE"} onChange={e=>update("action",e.target.value)}><option>REVOKE</option>{selectedContractor&&clockNow>0&&Date.parse(String(selectedContractor.expires_at??""))<=clockNow?<option>EXPIRE</option>:null}</select></Field>
          <Field label="Reason"><textarea required rows={3} maxLength={2000} className={inputClass} value={draft.reason??""} onChange={e=>update("reason",e.target.value)}/></Field>
        </>;
      default:
        return <p className="text-xs text-slate-500">Select an EHS action to continue.</p>;
    }
  }

  const editorTitle: Record<Exclude<Editor,"">,string> = {
    INCIDENT_CREATE:"Report safety incident / near miss",
    INCIDENT_TRANSITION:"Update incident lifecycle",
    CAPA_CREATE:"Create corrective action",
    CAPA_TRANSITION:"Corrective action execution / verification",
    PERMIT_CREATE:"Create permit to work",
    PERMIT_TRANSITION:"Permit review / execution",
    DRILL_CREATE:"Plan emergency drill",
    DRILL_TRANSITION:"Update emergency drill",
    ATTENDANCE_CREATE:"Record drill attendance",
    RESPONSE_CREATE:"Record drill response evidence",
    CHEMICAL_CREATE:"Register chemical / SDS revision",
    CHEMICAL_TRANSITION:"Update chemical/SDS status",
    CONTRACTOR_CREATE:"Record completed contractor induction",
    CONTRACTOR_TRANSITION:"Revoke / expire contractor induction",
  };

  if (status !== "connected" || !snapshot) {
    return <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Environment, health & safety</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-950">Connect a FactoryOS session</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Safety incidents, permits, drills and contractor evidence are factory-scoped. Connect an authenticated workspace to open the EHS workbench.</p>
        <a href="/session" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white">Open session</a>
      </section>
    </main>;
  }
  if (!activeFactoryId) {
    return <main className="mx-auto max-w-5xl px-4 py-12"><section className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-lg font-bold text-slate-950">Select an active factory</h1><p className="mt-2 text-sm text-slate-700">EHS controls and records are scoped to the active factory returned by the authenticated session.</p></section></main>;
  }

  return <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
    <header className="overflow-hidden rounded-3xl bg-slate-950 p-6 text-white shadow-sm sm:p-8">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div className="max-w-3xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">Environment · health · safety · compliance</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">EHS Safety & Compliance Workbench</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Report incidents, investigate and verify corrective actions, control high-risk work permits, preserve emergency drill evidence, manage chemical SDS revisions and record completed contractor inductions.</p>
        </div>
        <div className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-xs">
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Active factory</p>
          <p className="mt-1 font-semibold text-white">{activeFactory?.name ?? "Selected factory"}</p>
          <p className="mt-0.5 text-slate-400">{snapshot.tenant.name}</p>
        </div>
      </div>
    </header>

    {error ? <div role="alert" className="flex flex-col justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 sm:flex-row sm:items-center"><p className="text-sm text-rose-800">{error}</p><button type="button" onClick={()=>setError("")} className={secondaryButton}>Dismiss</button></div> : null}
    {notice ? <div role="status" className="flex flex-col justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 sm:flex-row sm:items-center"><p className="text-sm text-emerald-900">{notice}</p><button type="button" onClick={()=>setNotice("")} className={secondaryButton}>Dismiss</button></div> : null}

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <Metric label="Open incidents" value={summary.incidentOpen} hint="Open / investigating / action required" tone="blue"/>
      <Metric label="Critical incidents" value={summary.incidentCritical} hint="Loaded critical records not closed" tone="amber"/>
      <Metric label="Permits awaiting decision" value={summary.permitsAwaitingApproval} hint="Pending independent approval"/>
      <Metric label="Active permits" value={summary.permitsActive} hint="Approved and activated permits" tone="emerald"/>
      <Metric label="Drills in progress" value={summary.drillsInProgress} hint="Current execution records" tone="blue"/>
      <Metric label="Contractor / SDS alerts" value={summary.contractorActive+" / "+summary.chemicalReviewDue} hint="Active inductions / overdue SDS reviews" tone="amber"/>
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="EHS workbench areas">
        {TABS.map(item=><button key={item.id} type="button" role="tab" aria-selected={tab===item.id} onClick={()=>{setTab(item.id);setSearch("");setStatusFilter("ALL");setError("");setNotice("");}} className={"min-h-10 rounded-xl px-3 text-xs font-semibold "+(tab===item.id?"bg-slate-950 text-white":"text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
        <div className="ml-auto flex items-center gap-2 px-2">
          {loading?<span className="text-[10px] text-slate-500">Refreshing…</span>:null}
          <button type="button" disabled={loading} onClick={()=>void loadWorkspace()} className={secondaryButton}>Refresh</button>
        </div>
      </div>
    </section>

    {tab==="incidents"?<section className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Safety incident register</h2><p className="mt-1 text-xs text-slate-500">Incident, near-miss, injury, environmental release and audit finding</p></div><button type="button" className={primaryButton} disabled={!canIncidentReport} onClick={()=>openEditor("INCIDENT_CREATE",{incident_type:"NEAR_MISS",severity:"MEDIUM",occurred_at:dateTimeLocal(),assigned_owner_user_id:currentUserId})}>Report incident</button></div>
        {!canIncidentRead?<Empty>Your session does not include <code>ehs.incidents.read</code>.</Empty>:<>
          <div className="mt-4"><SearchFilter search={search} onSearch={setSearch} status={statusFilter} onStatus={setStatusFilter} statuses={["OPEN","INVESTIGATING","ACTION_REQUIRED","RESOLVED","CLOSED","CANCELLED"]}/></div>
          <div className="mt-4 space-y-2">
            {visibleIncidents.map(item=><button type="button" key={item.id} onClick={()=>setSelectedIncidentId(item.id)} className={"w-full rounded-xl border p-3 text-left hover:bg-slate-50 "+(selectedIncidentId===item.id?"border-blue-300 bg-blue-50/60":"border-slate-200")}>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-950">{textOf(item.incident_number)} · {textOf(item.title)}</span><StatusPill value={item.status}/></div>
              <p className="mt-1 text-[10px] text-slate-500">{textOf(item.incident_type)} · {textOf(item.location)} · {localDateTimeLabel(item.occurred_at)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2"><StatusPill value={textOf(item.severity)}/><span className="text-[10px] text-slate-500">Version {textOf(item.row_version)}</span>{item.due_at?<span className="text-[10px] text-slate-500">Due {localDateTimeLabel(item.due_at)}</span>:null}</div>
            </button>)}
            {!visibleIncidents.length?<Empty>{loading?"Loading incidents…":"No incidents match the current filter."}</Empty>:null}
          </div>
        </>}
      </div>
      <div className="space-y-5">
        {selectedIncident?<>
          <Panel title="Incident investigation" subtitle="Version-fenced lifecycle. Resolution/closure requires root cause and structured evidence." action={<StatusPill value={selectedIncident.status}/>}>
            <h3 className="text-sm font-bold text-slate-950">{textOf(selectedIncident.incident_number)} · {textOf(selectedIncident.title)}</h3>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-700">{textOf(selectedIncident.description)}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><p className="text-[9px] uppercase text-slate-500">Immediate action</p><p className="mt-1 text-xs text-slate-800">{textOf(selectedIncident.immediate_action)}</p></div>
              <div><p className="text-[9px] uppercase text-slate-500">Assigned owner</p><p className="mt-1 break-all text-xs text-slate-800">{textOf(selectedIncident.assigned_owner_user_id)}</p></div>
              <div><p className="text-[9px] uppercase text-slate-500">Investigation summary</p><p className="mt-1 text-xs text-slate-800">{textOf(selectedIncident.investigation_summary)}</p></div>
              <div><p className="text-[9px] uppercase text-slate-500">Root cause</p><p className="mt-1 text-xs text-slate-800">{textOf(selectedIncident.root_cause)}</p></div>
            </div>
            <EvidenceBox evidence={selectedIncident.closure_evidence} reason={selectedIncident.last_change_reason}/>
            {canIncidentManage?<div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {selectedIncident.status==="OPEN"?<button type="button" className={primaryButton} onClick={()=>startIncidentTransition("START_INVESTIGATION")}>Start investigation</button>:null}
              {["INVESTIGATING","ACTION_REQUIRED"].includes(selectedIncident.status)?<><button type="button" className={secondaryButton} onClick={()=>startIncidentTransition("REQUIRE_ACTION")}>Require action</button><button type="button" className={primaryButton} onClick={()=>startIncidentTransition("RESOLVE")}>Resolve</button></>:null}
              {selectedIncident.status==="RESOLVED"?<button type="button" className={primaryButton} onClick={()=>startIncidentTransition("CLOSE")}>Close incident</button>:null}
              {["RESOLVED","ACTION_REQUIRED"].includes(selectedIncident.status)?<button type="button" className={warningButton} onClick={()=>startIncidentTransition("REOPEN")}>Reopen</button>:null}
              {["OPEN","INVESTIGATING","ACTION_REQUIRED"].includes(selectedIncident.status)?<button type="button" className={dangerButton} onClick={()=>startIncidentTransition("CANCEL")}>Cancel</button>:null}
            </div>:null}
          </Panel>
          <Panel title="Corrective action register" subtitle="Each action has its own owner, due date, completion evidence and independent verification." action={<button type="button" disabled={!canIncidentManage} className={primaryButton} onClick={()=>openEditor("CAPA_CREATE",{action_number:"CA-"+String(correctiveActions.length+1).padStart(3,"0"),assigned_owner_user_id:currentUserId,due_at:dateTimeLocal(24*60)})}>Add corrective action</button>}>
            <div className="space-y-2">
              {correctiveActions.map(action=><div key={action.id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{textOf(action.action_number)} · {textOf(action.description)}</p><StatusPill value={action.status}/></div>
                <p className="mt-1 text-[10px] text-slate-500">Owner {textOf(action.assigned_owner_user_id)} · Due {localDateTimeLabel(action.due_at)} · v{numberOf(action.row_version)}</p>
                {action.root_cause?<p className="mt-1 text-[10px] text-slate-600">Root cause: {String(action.root_cause)}</p>:null}
                <EvidenceBox evidence={action.verification_evidence??action.completion_evidence} reason={action.last_change_reason}/>
                <div className="mt-2 flex flex-wrap gap-2">
                  {canIncidentManage&&["OPEN","IN_PROGRESS","READY_FOR_VERIFICATION"].includes(action.status)?<button type="button" className={secondaryButton} onClick={()=>openEditor("CAPA_TRANSITION",{action_id:action.id,action:action.status==="OPEN"?"START":action.status==="IN_PROGRESS"?"SUBMIT_FOR_VERIFICATION":"REOPEN",reason:""})}>Update action</button>:null}
                  {canCapaVerify&&action.status==="READY_FOR_VERIFICATION"&&action.submitted_by_user_id!==currentUserId?<button type="button" className={primaryButton} onClick={()=>openEditor("CAPA_TRANSITION",{action_id:action.id,action:"VERIFY",reason:"Independent verification",verification_evidence_ref:""})}>Verify independently</button>:null}
                {canCapaVerify&&action.status==="READY_FOR_VERIFICATION"&&action.submitted_by_user_id===currentUserId?<p className="mt-2 text-[10px] font-medium text-amber-900">The submitting user cannot verify this corrective action from this session.</p>:null}
                </div>
              </div>)}
              {!correctiveActions.length?<Empty>{relatedLoading?"Loading corrective actions…":"No corrective actions linked to this incident yet."}</Empty>:null}
            </div>
          </Panel>
        </>:<Empty>Select an incident to inspect its investigation record and corrective actions.</Empty>}
      </div>
    </section>:null}

    {tab==="permits"?<section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Permit-to-work register</h2><p className="mt-1 text-xs text-slate-500">Hot work, LOTO, confined space, work at height and chemical handling</p></div><button type="button" className={primaryButton} disabled={!canPermitManage} onClick={()=>openEditor("PERMIT_CREATE",{permit_type:"GENERAL",risk_level:"LOW",valid_from:dateTimeLocal(),expires_at:dateTimeLocal(4*60*60)})}>Create permit</button></div>
        {!canPermitRead?<div className="mt-4"><Empty>Your session does not include <code>ehs.permits.read</code>.</Empty></div>:<>
          <div className="mt-4"><SearchFilter search={search} onSearch={setSearch} status={statusFilter} onStatus={setStatusFilter} statuses={["DRAFT","PENDING_APPROVAL","APPROVED","REJECTED","ACTIVE","CLOSED","CANCELLED","EXPIRED"]}/></div>
          <div className="mt-4 space-y-2">{visiblePermits.map(item=><button type="button" key={item.id} onClick={()=>setSelectedPermitId(item.id)} className={"w-full rounded-xl border p-3 text-left hover:bg-slate-50 "+(selectedPermitId===item.id?"border-blue-300 bg-blue-50/60":"border-slate-200")}>
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{textOf(item.permit_number)} · {textOf(item.title)}</p><StatusPill value={item.status}/></div>
            <p className="mt-1 text-[10px] text-slate-500">{textOf(item.permit_type)} · {textOf(item.location)} · valid until {localDateTimeLabel(item.expires_at)}</p>
            <div className="mt-2 flex flex-wrap gap-2"><StatusPill value={textOf(item.risk_level)}/>{item.requires_isolation?<span className="rounded-full bg-violet-50 px-2 py-1 text-[9px] font-semibold text-violet-800">Isolation required</span>:null}<span className="text-[10px] text-slate-500">v{numberOf(item.row_version)}</span></div>
          </button>)}{!visiblePermits.length?<Empty>No permits match this filter.</Empty>:null}</div>
        </>}
      </div>
      <div className="min-w-0">
        {selectedPermit?<Panel title="Permit details & controls" subtitle="Approval, isolation verification, activation and close-out are separate lifecycle steps." action={<StatusPill value={selectedPermit.status}/>}>
          <h3 className="text-sm font-bold text-slate-950">{textOf(selectedPermit.permit_number)} · {textOf(selectedPermit.title)}</h3>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-700">{textOf(selectedPermit.work_scope)}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><p className="text-[9px] uppercase text-slate-500">Permit validity</p><p className="mt-1 text-xs text-slate-800">{localDateTimeLabel(selectedPermit.valid_from)} — {localDateTimeLabel(selectedPermit.expires_at)}</p></div>
            <div><p className="text-[9px] uppercase text-slate-500">Linked work order</p><p className="mt-1 break-all text-xs text-slate-800">{textOf(selectedPermit.work_order_id)}</p></div>
            <div><p className="text-[9px] uppercase text-slate-500">Approved by</p><p className="mt-1 break-all text-xs text-slate-800">{textOf(selectedPermit.approved_by_user_id)}</p></div>
            <div><p className="text-[9px] uppercase text-slate-500">Isolation verified by</p><p className="mt-1 break-all text-xs text-slate-800">{textOf(selectedPermit.isolation_verified_by_user_id)}</p></div>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 p-3"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-600">Isolation points</p>
            {Array.isArray(selectedPermit.isolation_points)?(selectedPermit.isolation_points as Array<Row>).map((point,index)=><div key={index} className="mt-2 border-t border-slate-100 pt-2"><p className="text-xs font-semibold text-slate-900">{textOf(point.code)} · {textOf(point.description)}</p><p className="mt-1 text-[10px] text-slate-500">Verification: {textOf((Array.isArray(selectedPermit.isolation_verification)?(selectedPermit.isolation_verification as Array<Row>).find(v=>String(v.code).toLowerCase()===String(point.code).toLowerCase()):null)?.evidence)}</p></div>):<p className="mt-2 text-xs text-slate-500">No isolation points declared.</p>}
          </div>
          <EvidenceBox evidence={selectedPermit.closure_evidence} reason={selectedPermit.last_change_reason}/>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {selectedPermit.status==="DRAFT"&&canPermitExecute?<button type="button" className={primaryButton} onClick={()=>startPermitTransition("SUBMIT")}>Submit for approval</button>:null}
            {selectedPermit.status==="PENDING_APPROVAL"&&canPermitApprove&&selectedPermit.requested_by_user_id!==currentUserId?<><button type="button" className={primaryButton} onClick={()=>startPermitTransition("APPROVE")}>Approve permit</button><button type="button" className={warningButton} onClick={()=>startPermitTransition("REJECT")}>Reject permit</button></>:null}
            {selectedPermit.status==="PENDING_APPROVAL"&&canPermitApprove&&selectedPermit.requested_by_user_id===currentUserId?<p className="self-center text-[10px] font-medium text-amber-900">The permit requester cannot approve their own permit from this session.</p>:null}
            {selectedPermit.status==="APPROVED"&&selectedPermit.requires_isolation&&canPermitExecute?<button type="button" className={secondaryButton} onClick={()=>startPermitTransition("VERIFY_ISOLATION")}>Verify isolation</button>:null}
            {selectedPermit.status==="APPROVED"&&canPermitExecute&&permitIsolationVerified?<button type="button" className={primaryButton} onClick={()=>startPermitTransition("ACTIVATE")}>Activate permit</button>:null}
            {selectedPermit.status==="APPROVED"&&canPermitExecute&&!permitIsolationVerified?<p className="self-center text-[10px] font-medium text-amber-900">Verify every declared isolation point before permit activation.</p>:null}
            {selectedPermit.status==="ACTIVE"&&canPermitExecute?<><button type="button" className={primaryButton} onClick={()=>startPermitTransition("CLOSE")}>Close permit</button><button type="button" className={dangerButton} onClick={()=>startPermitTransition("EXPIRE")}>Expire permit</button></>:null}
            {["DRAFT","PENDING_APPROVAL","APPROVED"].includes(selectedPermit.status)&&canPermitExecute?<button type="button" className={dangerButton} onClick={()=>startPermitTransition("CANCEL")}>Cancel permit</button>:null}
          </div>
        </Panel>:<Empty>Select a permit to inspect risk controls, isolation and lifecycle actions.</Empty>}
      </div>
    </section>:null}

    {tab==="drills"?<section className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Emergency drill register</h2><p className="mt-1 text-xs text-slate-500">Fire, evacuation, chemical spill, medical and disaster response drills</p></div><button type="button" disabled={!canDrillManage} className={primaryButton} onClick={()=>openEditor("DRILL_CREATE",{drill_type:"EVACUATION",planned_at:dateTimeLocal(24*60),owner_user_id:currentUserId})}>Plan drill</button></div>
        {!canDrillRead?<div className="mt-4"><Empty>Your session does not include <code>ehs.drills.read</code>.</Empty></div>:<>
          <div className="mt-4"><SearchFilter search={search} onSearch={setSearch} status={statusFilter} onStatus={setStatusFilter} statuses={["PLANNED","IN_PROGRESS","COMPLETED","CANCELLED"]}/></div>
          <div className="mt-4 space-y-2">{visibleDrills.map(item=><button key={item.id} type="button" onClick={()=>setSelectedDrillId(item.id)} className={"w-full rounded-xl border p-3 text-left hover:bg-slate-50 "+(selectedDrillId===item.id?"border-blue-300 bg-blue-50/60":"border-slate-200")}>
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{textOf(item.drill_number)} · {textOf(item.title)}</p><StatusPill value={item.status}/></div>
            <p className="mt-1 text-[10px] text-slate-500">{textOf(item.drill_type)} · {textOf(item.location)} · {localDateTimeLabel(item.planned_at)}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-600"><span>{numberOf(item.present_count)} present / {numberOf(item.attendance_count)} attendance</span><span>{numberOf(item.response_count)} responses</span><span>v{numberOf(item.row_version)}</span></div>
          </button>)}{!visibleDrills.length?<Empty>No emergency drills match this filter.</Empty>:null}</div>
        </>}
      </div>
      <div className="min-w-0 space-y-5">
        {selectedDrill?<>
          <Panel title="Drill execution" subtitle="Completion requires at least one PRESENT attendee and one recorded response/action." action={<StatusPill value={selectedDrill.status}/>}>
            <h3 className="text-sm font-bold text-slate-950">{textOf(selectedDrill.drill_number)} · {textOf(selectedDrill.title)}</h3>
            <p className="mt-1 text-xs text-slate-600">{textOf(selectedDrill.drill_type)} · {textOf(selectedDrill.location)} · planned {localDateTimeLabel(selectedDrill.planned_at)}</p>
            <div className="mt-3 grid grid-cols-3 gap-2"><Metric label="Attendance" value={numberOf(selectedDrill.attendance_count)} hint={numberOf(selectedDrill.present_count)+" present"}/><Metric label="Responses" value={numberOf(selectedDrill.response_count)} hint="Persisted action evidence"/><Metric label="Version" value={"v"+numberOf(selectedDrill.row_version)} hint="Expected-version guard"/></div>
            {selectedDrill.outcome_summary?<p className="mt-3 text-xs leading-5 text-slate-700">{String(selectedDrill.outcome_summary)}</p>:null}
            <EvidenceBox evidence={selectedDrill.close_evidence} reason={selectedDrill.last_change_reason}/>
            {canDrillManage?<div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {selectedDrill.status==="PLANNED"?<button type="button" className={primaryButton} onClick={()=>openEditor("DRILL_TRANSITION",{action:"START",reason:"Drill started"})}>Start drill</button>:null}
              {selectedDrill.status==="IN_PROGRESS"?<><button type="button" className={secondaryButton} onClick={()=>openEditor("ATTENDANCE_CREATE",{attendance_status:"PRESENT"})}>Record attendance</button><button type="button" className={secondaryButton} onClick={()=>openEditor("RESPONSE_CREATE",{occurred_at:dateTimeLocal()})}>Record response</button><button type="button" disabled={!drillHasCompletionEvidence} className={primaryButton} onClick={()=>openEditor("DRILL_TRANSITION",{action:"COMPLETE",reason:"Drill completed",outcome_summary:"",close_evidence_ref:""})}>Complete drill</button>{!drillHasCompletionEvidence?<p className="self-center text-[10px] text-amber-900">At least one PRESENT attendee and one response are required first.</p>:null}</>:null}
              {["PLANNED","IN_PROGRESS"].includes(selectedDrill.status)?<button type="button" className={dangerButton} onClick={()=>openEditor("DRILL_TRANSITION",{action:"CANCEL",reason:""})}>Cancel drill</button>:null}
            </div>:null}
          </Panel>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Attendance register" subtitle="One attendance result per attendee reference.">
              <div className="space-y-2">{attendance.map(item=><div key={item.id} className="rounded-lg border border-slate-200 p-2.5"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-900">{textOf(item.attendee_name)}</p><StatusPill value={textOf(item.attendance_status)}/></div><p className="mt-1 text-[10px] text-slate-500">{textOf(item.attendee_ref)} · {textOf(item.user_id)}</p></div>)}{!attendance.length?<Empty>{relatedLoading?"Loading attendance…":"No attendance results recorded."}</Empty>:null}</div>
            </Panel>
            <Panel title="Response evidence" subtitle="Recorded response actions with elapsed time and evidence reference.">
              <div className="space-y-2">{responses.map(item=><div key={item.id} className="rounded-lg border border-slate-200 p-2.5"><p className="text-xs font-semibold text-slate-900">{textOf(item.response_code)} · {textOf(item.response_action)}</p><p className="mt-1 text-[10px] text-slate-500">{localDateTimeLabel(item.occurred_at)} · {item.elapsed_seconds===null?"":numberOf(item.elapsed_seconds)+" sec"}</p><EvidenceBox evidence={item.evidence} reason={null}/></div>)}{!responses.length?<Empty>{relatedLoading?"Loading response evidence…":"No drill response evidence recorded."}</Empty>:null}</div>
            </Panel>
          </div>
        </>:<Empty>Select a drill to manage attendance and response evidence.</Empty>}
      </div>
    </section>:null}

    {tab==="chemicals"?<section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Chemical & SDS register</h2><p className="mt-1 text-xs text-slate-500">Controlled SDS revision, hazard class, handling and emergency instructions</p></div><button type="button" className={primaryButton} disabled={!canChemicalManage} onClick={()=>openEditor("CHEMICAL_CREATE",{sds_issued_at:dateTimeLocal(),sds_review_due_at:dateTimeLocal(365*24*60)})}>Register chemical</button></div>
        {!canChemicalRead?<div className="mt-4"><Empty>Your session does not include <code>ehs.chemicals.read</code>.</Empty></div>:<>
          <div className="mt-4"><SearchFilter search={search} onSearch={setSearch} status={statusFilter} onStatus={setStatusFilter} statuses={["DRAFT","ACTIVE","INACTIVE","RETIRED"]}/></div>
          <div className="mt-4 space-y-2">{visibleChemicals.map(item=><button key={item.id} type="button" onClick={()=>setSelectedChemicalId(item.id)} className={"w-full rounded-xl border p-3 text-left hover:bg-slate-50 "+(selectedChemicalId===item.id?"border-blue-300 bg-blue-50/60":"border-slate-200")}>
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{textOf(item.chemical_code)} · {textOf(item.chemical_name)}</p><StatusPill value={item.status}/></div>
            <p className="mt-1 text-[10px] text-slate-500">{textOf(item.hazard_class)} · {textOf(item.storage_location)} · {textOf(item.sds_revision)}</p>
            <p className="mt-1 text-[10px] text-slate-500">Review due {dateLabel(item.sds_review_due_at)} · v{numberOf(item.row_version)}</p>
          </button>)}{!visibleChemicals.length?<Empty>No chemical/SDS records match this filter.</Empty>:null}</div>
        </>}
      </div>
      <div className="min-w-0">{selectedChemical?<Panel title="SDS revision and status" subtitle="Activation requires an independent user and a current review date." action={<StatusPill value={selectedChemical.status}/>}>
        <h3 className="text-sm font-bold text-slate-950">{textOf(selectedChemical.chemical_name)} · {textOf(selectedChemical.chemical_code)}</h3>
        <p className="mt-1 text-xs text-slate-600">{textOf(selectedChemical.manufacturer)} · {textOf(selectedChemical.hazard_class)} · {textOf(selectedChemical.storage_location)}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><div><p className="text-[9px] uppercase text-slate-500">SDS revision / issue</p><p className="mt-1 text-xs text-slate-800">{textOf(selectedChemical.sds_revision)} · {dateLabel(selectedChemical.sds_issued_at)}</p></div><div><p className="text-[9px] uppercase text-slate-500">Review due</p><p className="mt-1 text-xs text-slate-800">{dateLabel(selectedChemical.sds_review_due_at)}</p></div><div><p className="text-[9px] uppercase text-slate-500">Approved by</p><p className="mt-1 break-all text-xs text-slate-800">{textOf(selectedChemical.approved_by_user_id)}</p></div><div><p className="text-[9px] uppercase text-slate-500">Approved at</p><p className="mt-1 text-xs text-slate-800">{localDateTimeLabel(selectedChemical.approved_at)}</p></div></div>
        <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase text-slate-600">Handling instructions</p><p className="whitespace-pre-wrap text-xs leading-5 text-slate-700">{textOf(selectedChemical.handling_instructions)}</p><p className="pt-2 text-[10px] font-bold uppercase text-slate-600">Emergency instructions</p><p className="whitespace-pre-wrap text-xs leading-5 text-slate-700">{textOf(selectedChemical.emergency_instructions)}</p></div>
        <p className="mt-3 break-all text-[10px] text-blue-800"><a href={String(selectedChemical.sds_document_uri??"#")} target="_blank" rel="noreferrer">Open controlled SDS document reference</a></p>
        <EvidenceBox evidence={null} reason={selectedChemical.last_change_reason}/>
        {canChemicalManage?<div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          {["DRAFT","INACTIVE"].includes(selectedChemical.status)&&selectedChemical.created_by_user_id!==currentUserId?<button type="button" className={primaryButton} onClick={()=>openEditor("CHEMICAL_TRANSITION",{action:"ACTIVATE",reason:"Independent SDS review"})}>Activate SDS</button>:null}
          {selectedChemical.status==="ACTIVE"?<button type="button" className={warningButton} onClick={()=>openEditor("CHEMICAL_TRANSITION",{action:"DEACTIVATE",reason:""})}>Deactivate</button>:null}
          {["DRAFT","ACTIVE","INACTIVE"].includes(selectedChemical.status)?<button type="button" className={dangerButton} onClick={()=>openEditor("CHEMICAL_TRANSITION",{action:"RETIRE",reason:""})}>Retire revision</button>:null}
        </div>:null}
      </Panel>:<Empty>Select a chemical/SDS record to inspect instructions and approval evidence.</Empty>}</div>
    </section>:null}

    {tab==="contractors"?<section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">Contractor induction register</h2><p className="mt-1 text-xs text-slate-500">Completed training record, covered topics and expiry controls</p></div><button type="button" className={primaryButton} disabled={!canContractorManage} onClick={()=>openEditor("CONTRACTOR_CREATE",{induction_at:dateTimeLocal(-60*60),expires_at:dateTimeLocal(365*24*60)})}>Record completed induction</button></div>
        {!canContractorRead?<div className="mt-4"><Empty>Your session does not include <code>ehs.contractors.read</code>.</Empty></div>:<>
          <div className="mt-4"><SearchFilter search={search} onSearch={setSearch} status={statusFilter} onStatus={setStatusFilter} statuses={["ACTIVE","EXPIRED","REVOKED"]}/></div>
          <div className="mt-4 space-y-2">{visibleContractors.map(item=><button key={item.id} type="button" onClick={()=>setSelectedContractorId(item.id)} className={"w-full rounded-xl border p-3 text-left hover:bg-slate-50 "+(selectedContractorId===item.id?"border-blue-300 bg-blue-50/60":"border-slate-200")}>
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{textOf(item.contractor_code)} · {textOf(item.person_name)}</p><StatusPill value={item.status}/></div>
            <p className="mt-1 text-[10px] text-slate-500">{textOf(item.company_name)} · expires {dateLabel(item.expires_at)}</p>
            <p className="mt-1 text-[10px] text-slate-500">{Array.isArray(item.topics)?(item.topics as unknown[]).map(String).join(" · "):"No topics"} · v{numberOf(item.row_version)}</p>
          </button>)}{!visibleContractors.length?<Empty>No contractor induction records match this filter.</Empty>:null}</div>
        </>}
      </div>
      <div className="min-w-0">{selectedContractor?<Panel title="Contractor training evidence" subtitle="The register accepts only completed inductions; revoke/expire operations require an explicit reason." action={<StatusPill value={selectedContractor.status}/>}>
        <h3 className="text-sm font-bold text-slate-950">{textOf(selectedContractor.person_name)}</h3>
        <p className="mt-1 text-xs text-slate-600">{textOf(selectedContractor.company_name)} · {textOf(selectedContractor.contractor_code)}</p>
        <div className="mt-3 grid grid-cols-2 gap-3"><div><p className="text-[9px] uppercase text-slate-500">Induction completed</p><p className="mt-1 text-xs text-slate-800">{localDateTimeLabel(selectedContractor.induction_at)}</p></div><div><p className="text-[9px] uppercase text-slate-500">Expires</p><p className="mt-1 text-xs text-slate-800">{localDateTimeLabel(selectedContractor.expires_at)}</p></div></div>
        <div className="mt-3 rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase text-slate-600">Topics covered</p><div className="mt-2 flex flex-wrap gap-2">{Array.isArray(selectedContractor.topics)?(selectedContractor.topics as unknown[]).map((topic,index)=><span key={index} className="rounded-full bg-white px-2.5 py-1 text-[10px] font-medium text-slate-700">{String(topic)}</span>):<span className="text-xs text-slate-500">No topic evidence</span>}</div></div>
        <EvidenceBox evidence={selectedContractor.evidence} reason={selectedContractor.last_change_reason}/>
        {canContractorManage&&selectedContractor.status==="ACTIVE"?<div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3"><button type="button" className={dangerButton} onClick={()=>openEditor("CONTRACTOR_TRANSITION",{action:"REVOKE",reason:""})}>Revoke induction</button><button type="button" className={secondaryButton} onClick={()=>openEditor("CONTRACTOR_TRANSITION",{action:"EXPIRE",reason:""})}>Mark expired</button></div>:null}
      </Panel>:<Empty>Select a contractor induction to inspect topic and evidence records.</Empty>}</div>
    </section>:null}

    {editor?<div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="ehs-editor-title" className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
        <div className="flex items-start justify-between gap-3"><div><h2 id="ehs-editor-title" className="text-lg font-bold text-slate-950">{editorTitle[editor]}</h2><p className="mt-1 text-xs text-slate-500">Selected factory scope · authenticated user context · server-side lifecycle guards remain authoritative</p></div><button type="button" className={secondaryButton} disabled={busy} onClick={closeEditor}>Close</button></div>
        <form onSubmit={submitEditor} className="mt-5 space-y-4">
          {renderEditorFields()}
          <div className="rounded-xl bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">
            EHS evidence must reference real records. This UI records references and notes; it does not upload documents, certify safety conditions, substitute for a competent-person inspection or bypass independent approval.
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className={secondaryButton} disabled={busy} onClick={closeEditor}>Cancel</button><button type="submit" className={primaryButton} disabled={busy}>{busy?"Saving…":"Save EHS record"}</button></div>
        </form>
      </section>
    </div>:null}
  </main>;
}
