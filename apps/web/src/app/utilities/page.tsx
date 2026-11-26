"use client";
import { useCallback,useEffect,useMemo,useState,type Dispatch,type FormEvent,type ReactNode,type SetStateAction } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
 buildUtilityAllocationReversePayload,buildUtilityEventPayload,buildUtilityEventTransitionPayload,buildUtilityListQuery,
 buildUtilityMeterPayload,buildUtilityReadingPayload,buildUtilitySourceBindingPayload,buildUtilitySourceBindingTransitionPayload,
 buildUtilitySourceEventPayload,buildUtilityThresholdPolicyPayload,buildUtilityThresholdPolicyTransitionPayload,
 buildUtilityWorkOrderAllocationPayload,normalizeUtilityRows,summarizeUtilities
} from "@/lib/utilities-workbench.mjs";

type Row=Record<string,unknown>;
type Item=Row&{id:string;status?:string;row_version?:number};
type Tab="meters"|"events"|"governance"|"costing";
type Editor="METER"|"READING"|"EVENT"|"EVENT_TRANSITION"|"BINDING"|"BINDING_TRANSITION"|"INGEST"|"POLICY"|"POLICY_TRANSITION"|"ALLOCATE"|"REVERSE"|"";
const input="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100";
const primary="inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 text-[11px] font-semibold text-white disabled:opacity-50";
const secondary="inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-[11px] font-semibold text-slate-700 disabled:opacity-50";
const warning="inline-flex min-h-9 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 px-3 text-[11px] font-semibold text-amber-900";
function obj(v:unknown):Row{return v&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function s(v:unknown,fallback="—"):string{return typeof v==="string"&&v.trim()?v:typeof v==="number"?String(v):fallback;}
function n(v:unknown):number{const x=Number(v);return Number.isFinite(x)?x:0;}
function err(v:unknown):string{return v instanceof Error?v.message:"The utility request could not be completed.";}
function dateInput(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function dateLabel(v:unknown){if(typeof v!=="string"||!v)return "—";const d=new Date(v);return Number.isNaN(d.getTime())?v:d.toLocaleString();}
function qty(v:unknown){const x=Number(v);return Number.isFinite(x)?x.toLocaleString(undefined,{maximumFractionDigits:8}):"—";}
function Pill({value}:{value:string}){const color=["ACTIVE","RESOLVED","APPROVED"].includes(value)?"bg-emerald-50 text-emerald-800":value==="CRITICAL"||value==="HIGH"?"bg-rose-50 text-rose-800":"bg-slate-100 text-slate-700";return <span className={"rounded-full px-2.5 py-1 text-[9px] font-bold uppercase "+color}>{value.replaceAll("_"," ")}</span>;}
function Panel({title,subtitle,action,children}:{title:string;subtitle?:string;action?:ReactNode;children:ReactNode}){return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4"><div><h2 className="text-sm font-bold text-slate-950">{title}</h2>{subtitle?<p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p>:null}</div>{action}</div><div className="p-4">{children}</div></section>;}
function Empty({children}:{children:ReactNode}){return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-center text-xs text-slate-500">{children}</div>;}
function Field({label,value,onChange,type="text",required=true,placeholder,step,min}:{label:string;value:string;onChange(v:string):void;type?:string;required?:boolean;placeholder?:string;step?:string;min?:string}){return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span><input className={input} type={type} value={value} onChange={e=>onChange(e.target.value)} required={required} placeholder={placeholder} step={step} min={min}/></label>;}
function Select({label,value,onChange,options,required=true}:{label:string;value:string;onChange(v:string):void;options:Array<[string,string]>;required?:boolean}){return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span><select className={input} value={value} onChange={e=>onChange(e.target.value)} required={required}>{options.map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>;}
function Area({label,value,onChange,required=true}:{label:string;value:string;onChange(v:string):void;required?:boolean}){return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span><textarea className={input+" min-h-24 py-2.5"} rows={3} value={value} onChange={e=>onChange(e.target.value)} required={required}/></label>;}
const TABS:Array<[Tab,string,string]>=[
 ["meters","Meters & readings","Meter register, chronological readings and measured consumption"],
 ["events","Events & alerts","Utility interruptions, anomalies and threshold evidence"],
 ["governance","Sources & policies","Approved ingestion mappings and independent threshold activation"],
 ["costing","Work-order costing","Allocate measured consumption to released production work orders"]
];
export default function UtilitiesEnergyPage(){
 const {status,activeFactoryId,hasPermission,request,snapshot}=useFactoryOsSession();
 const connected=status==="connected"&&Boolean(activeFactoryId);
 const currentUserId=snapshot?.user?.id??"";
 const canMeterRead=hasPermission("utilities.meters.read"),canMeterManage=hasPermission("utilities.meters.manage");
 const canReadingRead=hasPermission("utilities.readings.read"),canReadingCapture=hasPermission("utilities.readings.capture");
 const canEventRead=hasPermission("utilities.events.read"),canEventManage=hasPermission("utilities.events.manage");
 const canSourceManage=hasPermission("utilities.sources.manage"),canAlertRead=hasPermission("utilities.alerts.read");
 const canAlertManage=hasPermission("utilities.alerts.manage"),canProductionRead=hasPermission("production.workorders.read");
 const canAllocate=canReadingCapture&&canProductionRead;
 const [tab,setTab]=useState<Tab>("meters");
 const [meters,setMeters]=useState<Item[]>([]),[events,setEvents]=useState<Item[]>([]),[policies,setPolicies]=useState<Item[]>([]);
 const [alerts,setAlerts]=useState<Row[]>([]),[bindings,setBindings]=useState<Item[]>([]),[workOrders,setWorkOrders]=useState<Item[]>([]);
 const [readings,setReadings]=useState<Item[]>([]),[allocations,setAllocations]=useState<Row[]>([]),[allocationSource,setAllocationSource]=useState<Row>({});
 const [meterId,setMeterId]=useState(""),[readingId,setReadingId]=useState(""),[eventId,setEventId]=useState("");
 const [bindingId,setBindingId]=useState(""),[policyId,setPolicyId]=useState("");
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[related,setRelated]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState(""),[editor,setEditor]=useState<Editor>(""),[draft,setDraft]=useState<Record<string,string>>({});
 const [search,setSearch]=useState(""),[filter,setFilter]=useState("ALL");
 const meter=meters.find(x=>x.id===meterId)??null,reading=readings.find(x=>x.id===readingId)??null;
 const event=events.find(x=>x.id===eventId)??null,binding=bindings.find(x=>x.id===bindingId)??null,policy=policies.find(x=>x.id===policyId)??null;
 const summary=useMemo(()=>summarizeUtilities({meters,events,policies,alerts,readings}),[meters,events,policies,alerts,readings]);
 const visibleMeters=useMemo(()=>meters.filter(x=>(filter==="ALL"||x.status===filter)&&[x.meter_code,x.name,x.location,x.utility_type].some(v=>String(v??"").toLowerCase().includes(search.toLowerCase()))),[meters,filter,search]);
 const visibleEvents=useMemo(()=>events.filter(x=>(filter==="ALL"||x.status===filter)&&[x.event_number,x.title,x.event_type,x.description].some(v=>String(v??"").toLowerCase().includes(search.toLowerCase()))),[events,filter,search]);
 const reversed=useMemo(()=>new Set(allocations.filter(x=>x.allocation_kind==="REVERSAL").map(x=>String(x.reverses_allocation_id??""))),[allocations]);
 const load=useCallback(async()=>{
  if(!connected){setMeters([]);setEvents([]);setPolicies([]);setAlerts([]);setBindings([]);setWorkOrders([]);setMeterId("");setEventId("");setBindingId("");setPolicyId("");return;}
  setLoading(true);setError("");const errors:string[]=[];
  const run=async(name:string,path:string,allowed:boolean,setter:(rows:Item[])=>void,select?:Dispatch<SetStateAction<string>>)=>{
   if(!allowed){setter([]);select?.("");return;}
   try{const rows=normalizeUtilityRows(await request(path)) as Item[];setter(rows);select?.(old=>old&&rows.some(x=>x.id===old)?old:rows[0]?.id??"");}
   catch(e){errors.push(name+": "+err(e));setter([]);select?.("");}
  };
  await Promise.all([
   run("Meters","/utilities/meters"+buildUtilityListQuery({},"meters"),canMeterRead,setMeters,setMeterId),
   run("Events","/utilities/events"+buildUtilityListQuery({},"events"),canEventRead,setEvents,setEventId),
   run("Policies","/utilities/threshold-policies"+buildUtilityListQuery({},"policies"),canAlertRead,setPolicies,setPolicyId),
   run("Alerts","/utilities/threshold-alerts"+buildUtilityListQuery({},"alerts"),canAlertRead,setAlerts),
   run("Source bindings","/utilities/source-bindings"+buildUtilityListQuery({},"bindings"),canMeterRead,setBindings,setBindingId),
   run("Work orders","/production/work-orders?limit=100",canProductionRead,setWorkOrders)
  ]);
  if(errors.length)setError(errors.join(" · "));setLoading(false);
 },[connected,request,canMeterRead,canEventRead,canAlertRead,canProductionRead]);
 useEffect(()=>{const id=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(id);},[load]);
 const loadReadings=useCallback(async(id:string)=>{
  if(!id||!canReadingRead){setReadings([]);setReadingId("");return;}
  setRelated(true);try{const rows=normalizeUtilityRows(await request("/utilities/meters/"+encodeURIComponent(id)+"/readings"+buildUtilityListQuery({},"readings"))) as Item[];setReadings(rows);setReadingId(old=>old&&rows.some(x=>x.id===old)?old:rows[0]?.id??"");}
  catch(e){setReadings([]);setReadingId("");setError(err(e));}finally{setRelated(false);}
 },[request,canReadingRead]);
 useEffect(()=>{if(tab!=="meters"&&tab!=="costing")return;if(!meterId)return;const id=window.setTimeout(()=>void loadReadings(meterId),0);return()=>window.clearTimeout(id);},[tab,meterId,loadReadings]);
 const loadAllocations=useCallback(async(mid:string,rid:string)=>{
  if(!mid||!rid||!canReadingRead){setAllocations([]);setAllocationSource({});return;}
  setRelated(true);try{const result=obj(await request("/utilities/meters/"+encodeURIComponent(mid)+"/readings/"+encodeURIComponent(rid)+"/work-order-cost-allocations"));setAllocations(normalizeUtilityRows(result) as Row[]);setAllocationSource(obj(result.source));}
  catch(e){setAllocations([]);setAllocationSource({});setError(err(e));}finally{setRelated(false);}
 },[request,canReadingRead]);
 useEffect(()=>{if(tab!=="costing"||!meterId||!readingId)return;const id=window.setTimeout(()=>void loadAllocations(meterId,readingId),0);return()=>window.clearTimeout(id);},[tab,meterId,readingId,loadAllocations]);
 const update=(key:string,value:string)=>setDraft(old=>({...old,[key]:value}));
 const open=(kind:Editor,values:Record<string,string>={})=>{setEditor(kind);setDraft(values);setError("");setNotice("");};
 const close=()=>{setEditor("");setDraft({});};
 const refresh=async(message:string)=>{setNotice(message);close();await load();if(meterId)await loadReadings(meterId);if(tab==="costing"&&meterId&&readingId)await loadAllocations(meterId,readingId);};
 function startEvent(x:Item){setEventId(x.id);open("EVENT_TRANSITION",{expected_version:String(x.row_version??""),action:x.status==="OPEN"?"ACKNOWLEDGE":"RESOLVE",reason:"",resolution:""});}
 function startBinding(x:Item){setBindingId(x.id);open("BINDING_TRANSITION",{expected_version:String(x.row_version??""),action:x.status==="ACTIVE"?"DEACTIVATE":x.status==="INACTIVE"?"ACTIVATE":"RETIRE",reason:""});}
 function startPolicy(x:Item){setPolicyId(x.id);open("POLICY_TRANSITION",{expected_version:String(x.row_version??""),action:x.status==="ACTIVE"?"DEACTIVATE":x.status==="INACTIVE"?"ACTIVATE":"ACTIVATE",reason:""});}
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setBusy(true);setError("");setNotice("");
  try{
   switch(editor){
    case "METER":
     if(!canMeterManage)throw new Error("Missing utilities.meters.manage permission.");
     await request("/utilities/meters",{method:"POST",body:buildUtilityMeterPayload(draft),idempotencyKey:"utility-meter-"+window.crypto.randomUUID()});
     await refresh("Utility meter registered. The API controls reading sequence and calculated consumption.");break;
    case "READING":
     if(!canReadingCapture||!meter)throw new Error("Select a meter and check utilities.readings.capture permission.");
     await request("/utilities/meters/"+encodeURIComponent(meter.id)+"/readings",{method:"POST",body:buildUtilityReadingPayload(draft),idempotencyKey:"utility-reading-"+window.crypto.randomUUID()});
     await refresh("Meter reading recorded. Consumption and cost were calculated by the API.");break;
    case "EVENT":
     if(!canEventManage)throw new Error("Missing utilities.events.manage permission.");
     await request("/utilities/events",{method:"POST",body:buildUtilityEventPayload(draft),idempotencyKey:"utility-event-"+window.crypto.randomUUID()});
     await refresh("Utility event recorded.");break;
    case "EVENT_TRANSITION":
     if(!event||!canEventManage)throw new Error("Select an event and check utilities.events.manage permission.");
     await request("/utilities/events/"+encodeURIComponent(event.id)+"/transition",{method:"POST",body:buildUtilityEventTransitionPayload(draft)});
     await refresh("Utility event transition saved.");break;
    case "BINDING":
     if(!canSourceManage)throw new Error("Missing utilities.sources.manage permission.");
     await request("/utilities/source-bindings",{method:"POST",body:buildUtilitySourceBindingPayload(draft),idempotencyKey:"utility-binding-"+window.crypto.randomUUID()});
     await refresh("Source binding created as a draft; another user must activate it.");break;
    case "BINDING_TRANSITION":
     if(!binding||!canSourceManage)throw new Error("Select a source binding and verify permission.");
     await request("/utilities/source-bindings/"+encodeURIComponent(binding.id)+"/transition",{method:"POST",body:buildUtilitySourceBindingTransitionPayload(draft)});
     await refresh("Source binding state updated.");break;
    case "INGEST":
     if(!canReadingCapture)throw new Error("Missing utilities.readings.capture permission.");
     await request("/utilities/source-events",{method:"POST",body:buildUtilitySourceEventPayload(draft)});
     await refresh("Source event normalized through its approved active mapping.");break;
    case "POLICY":
     if(!canAlertManage)throw new Error("Missing utilities.alerts.manage permission.");
     await request("/utilities/threshold-policies",{method:"POST",body:buildUtilityThresholdPolicyPayload(draft),idempotencyKey:"utility-policy-"+window.crypto.randomUUID()});
     await refresh("Threshold policy created as a draft; independent activation is required.");break;
    case "POLICY_TRANSITION":
     if(!policy||!canAlertManage)throw new Error("Select a policy and verify utilities.alerts.manage permission.");
     await request("/utilities/threshold-policies/"+encodeURIComponent(policy.id)+"/transition",{method:"POST",body:buildUtilityThresholdPolicyTransitionPayload(draft)});
     await refresh("Threshold policy state updated.");break;
    case "ALLOCATE":
     if(!canAllocate||!meter||!reading)throw new Error("Choose a reading and verify utilities.readings.capture and production.workorders.read.");
     await request("/utilities/meters/"+encodeURIComponent(meter.id)+"/readings/"+encodeURIComponent(reading.id)+"/work-order-cost-allocations",{method:"POST",body:buildUtilityWorkOrderAllocationPayload(draft),idempotencyKey:"utility-allocation-"+window.crypto.randomUUID()});
     await refresh("Utility consumption allocated to a production work order.");break;
    case "REVERSE":
     if(!canAllocate||!meter||!reading)throw new Error("A selected reading and allocation permissions are required.");
     await request("/utilities/meters/"+encodeURIComponent(meter.id)+"/readings/"+encodeURIComponent(reading.id)+"/work-order-cost-allocations/"+encodeURIComponent(draft.allocation_id??"")+"/reverse",{method:"POST",body:buildUtilityAllocationReversePayload(draft),idempotencyKey:"utility-reversal-"+window.crypto.randomUUID()});
     await refresh("Append-only reversal entry recorded.");break;
   }
  }catch(cause){setError(err(cause));}finally{setBusy(false);}
 }
 const title:Record<Exclude<Editor,"">,string>={METER:"Register meter",READING:"Capture meter reading",EVENT:"Record utility event",EVENT_TRANSITION:"Transition utility event",BINDING:"Register meter source",BINDING_TRANSITION:"Transition source mapping",INGEST:"Ingest source event",POLICY:"Create threshold policy",POLICY_TRANSITION:"Transition threshold policy",ALLOCATE:"Allocate consumption",REVERSE:"Reverse allocation"};
 return <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
  <header className="flex flex-wrap items-start justify-between gap-4"><div className="max-w-3xl"><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Factory utilities · metering · energy cost</p><h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Utilities & Energy Performance</h1><p className="mt-2 text-sm leading-6 text-slate-600">Manage meter hierarchies, capture governed readings, respond to interruptions, approve automated source mappings, monitor thresholds and allocate measured utility usage to production.</p></div><div className="flex items-center gap-2"><Pill value={connected?"FACTORY_SCOPED":"SESSION_REQUIRED"}/><button onClick={()=>void load()} disabled={!connected||loading} className={secondary}>{loading?"Refreshing…":"Refresh"}</button></div></header>
  {!connected?<div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">Connect an authenticated FactoryOS session and select an active factory before using the utility workspace. The server derives tenant and factory scope from the session.</div>:null}
  {error?<div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{error}</div>:null}
  {notice?<div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">{notice}</div>:null}
  <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
   ["Active meters",summary.metersActive,summary.metersLoaded+" meters loaded"],["Open events",summary.eventsOpen,summary.eventsCritical+" unresolved critical"],["Threshold alerts",summary.alertsOpen,summary.policiesActive+" active policies"],["Readings loaded",summary.readingsLoaded,"Latest selected-meter history"]
  ].map(([label,value,hint])=><article key={String(label)} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-[11px] text-slate-500">{hint}</p></article>)}</section>
  <nav className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-100 p-1">{TABS.map(([id,label])=><button key={id} onClick={()=>{setTab(id);setSearch("");setFilter("ALL");}} aria-pressed={tab===id} className={"min-h-10 shrink-0 rounded-lg px-3 text-[11px] font-semibold "+(tab===id?"bg-white text-slate-950 shadow-sm":"text-slate-600")}>{label}</button>)}</nav>
  <p className="-mt-3 text-xs text-slate-500">{TABS.find(x=>x[0]===tab)?.[2]}</p>

  {tab==="meters"?<div className="grid gap-4 xl:grid-cols-[.85fr_1.15fr]">
   <Panel title="Meter register" subtitle="Factory-scoped meters and parent-child metering hierarchy" action={canMeterManage?<button className={primary} onClick={()=>open("METER",{utility_type:"ELECTRICITY",reading_mode:"CUMULATIVE",unit_code:"kWh",multiplier_factor:"1",unit_cost:"0",currency_code:"BDT"})}>+ Register</button>:null}>
    <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_140px]"><input className={input} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search meters…"/><select className={input} value={filter} onChange={e=>setFilter(e.target.value)}><option>ALL</option><option>ACTIVE</option><option>INACTIVE</option><option>RETIRED</option></select></div>
    {visibleMeters.length?<div className="space-y-2">{visibleMeters.map(x=><button key={x.id} onClick={()=>{setMeterId(x.id);setReadingId("");}} className={"w-full rounded-xl border p-3 text-left "+(meterId===x.id?"border-blue-300 bg-blue-50":"border-slate-200 hover:bg-slate-50")}><div className="flex justify-between gap-2"><span className="text-xs font-bold text-slate-900">{s(x.meter_code)} · {s(x.name)}</span><Pill value={s(x.status,"UNKNOWN")}/></div><p className="mt-1 text-[10px] text-slate-500">{s(x.utility_type)} · {s(x.unit_code)} · {s(x.location,"No location")}</p><p className="mt-1 text-[10px] text-slate-400">Multiplier {s(x.multiplier_factor)} · {s(x.currency_code)} {qty(x.unit_cost)} / unit · {n(x.child_count)} child meters</p></button>)}</div>:<Empty>{canMeterRead?"No utility meters match this filter.":"Missing utilities.meters.read permission."}</Empty>}
   </Panel>
   <div className="space-y-4">
    <Panel title="Selected meter" subtitle={meter?s(meter.meter_code)+" · "+s(meter.name):"Select a meter to inspect its reading configuration."} action={meter&&canReadingCapture?<button className={primary} onClick={()=>open("READING",{reading_at:dateInput(),reading_value:"",source_type:"MANUAL",production_quantity:"",notes:""})}>+ Capture reading</button>:null}>
     {meter?<div className="grid gap-2 sm:grid-cols-3">{[["Utility",meter.utility_type],["Mode",meter.reading_mode],["Unit",meter.unit_code],["Multiplier",meter.multiplier_factor],["Unit cost",meter.unit_cost],["Currency",meter.currency_code],["Cost centre",meter.cost_center_code],["Parent meter",meter.parent_meter_id],["Row version",meter.row_version]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-slate-50 p-2"><p className="text-[9px] uppercase text-slate-500">{k}</p><p className="mt-1 break-all text-xs font-semibold text-slate-800">{s(v)}</p></div>)}</div>:<Empty>Select a meter. The API accepts readings only for ACTIVE meters and enforces chronological sequence.</Empty>}
    </Panel>
    <Panel title="Reading history" subtitle="Latest readings, calculated consumption, frozen unit cost and source provenance">{related?<p className="text-xs text-slate-500">Loading readings…</p>:readings.length?<div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-xs"><thead><tr className="border-b text-[9px] uppercase text-slate-500"><th className="pb-2">Time</th><th className="pb-2">Counter</th><th className="pb-2">Consumption</th><th className="pb-2">Cost</th><th className="pb-2">Source</th></tr></thead><tbody>{readings.map(x=><tr key={x.id} onClick={()=>setReadingId(x.id)} className={"cursor-pointer border-b border-slate-100 "+(readingId===x.id?"bg-blue-50":"")}><td className="py-2 pr-2">{dateLabel(x.reading_at)}</td><td className="py-2 pr-2">{qty(x.reading_value)} {s(x.unit_code)}</td><td className="py-2 pr-2 font-semibold">{qty(x.consumption_quantity)} {s(x.unit_code)}</td><td className="py-2 pr-2">{s(x.currency_code_snapshot)} {qty(x.cost_amount)}</td><td className="py-2">{s(x.source_type)}</td></tr>)}</tbody></table></div>:<Empty>{meter?"No readings exist for this meter yet.":"Select a meter to view readings."}</Empty>}</Panel>
   </div>
  </div>:null}

  {tab==="events"?<div className="grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
   <Panel title="Utility event register" subtitle="Outages, peak load, leaks, pressure drops, meter faults and efficiency exceptions" action={canEventManage?<button className={primary} onClick={()=>open("EVENT",{event_type:"OUTAGE",severity:"HIGH",title:"",description:"",occurred_at:dateInput(),impact_minutes:"0",meter_id:"",cause:""})}>+ Record event</button>:null}>
    <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_150px]"><input className={input} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search event register…"/><select className={input} value={filter} onChange={e=>setFilter(e.target.value)}><option>ALL</option>{["OPEN","ACKNOWLEDGED","RESOLVED","CANCELLED"].map(x=><option key={x}>{x}</option>)}</select></div>
    {visibleEvents.length?<div className="space-y-2">{visibleEvents.map(x=><article key={x.id} className={"rounded-xl border p-3 "+(eventId===x.id?"border-blue-300 bg-blue-50/50":"border-slate-200")}><button onClick={()=>setEventId(x.id)} className="w-full text-left"><div className="flex flex-wrap justify-between gap-2"><strong className="text-xs">{s(x.event_number)} · {s(x.title)}</strong><span className="flex gap-1"><Pill value={s(x.severity,"LOW")}/><Pill value={s(x.status,"OPEN")}/></span></div><p className="mt-1 text-[10px] text-slate-500">{s(x.event_type)} · {dateLabel(x.occurred_at)} · {n(x.impact_minutes)} impact minutes</p><p className="mt-2 text-xs text-slate-600">{s(x.description)}</p>{x.resolution?<p className="mt-1 text-[10px] text-emerald-700">Resolution: {s(x.resolution)}</p>:null}</button>{canEventManage&&["OPEN","ACKNOWLEDGED"].includes(String(x.status))?<div className="mt-2 flex justify-end"><button className={secondary} onClick={()=>startEvent(x)}>{x.status==="OPEN"?"Acknowledge / cancel":"Resolve / cancel"}</button></div>:null}</article>)}</div>:<Empty>{canEventRead?"No utility events match the current filter.":"Missing utilities.events.read permission."}</Empty>}
   </Panel>
   <Panel title="Threshold alerts" subtitle="Alerts link the evaluated policy, source reading and utility event." >
    {alerts.length?<div className="space-y-2">{alerts.map(x=><article key={String(x.alert_id)} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap justify-between gap-2"><strong className="text-xs">{s(x.policy_code)} · {s(x.policy_name)}</strong><Pill value={s(x.severity,"MEDIUM")}/></div><p className="mt-1 text-[10px] text-slate-500">{s(x.metric)} {s(x.unit_code)} · observed {qty(x.observed_value)} vs limit {qty(x.threshold_value)}</p><p className="mt-2 text-[11px] font-semibold">{s(x.event_number)} · {s(x.title)}</p><p className="text-[10px] text-slate-500">Reading {dateLabel(x.reading_at)} · {qty(x.consumption_quantity)} {s(x.unit_code)}</p></article>)}</div>:<Empty>{canAlertRead?"No threshold alerts are returned.":"Missing utilities.alerts.read permission."}</Empty>}
   </Panel>
  </div>:null}

  {tab==="governance"?<div className="grid gap-4 xl:grid-cols-2">
   <Panel title="Meter source bindings" subtitle="External source-to-meter maps; only secret-manager references may be stored." action={<div className="flex gap-2">{canReadingCapture?<button className={secondary} onClick={()=>open("INGEST",{source_system_code:"",source_meter_code:"",source_event_id:"",reading_at:dateInput(),reading_value:"",source_unit_code:"",production_quantity:"",notes:""})}>Ingest event</button>:null}{canSourceManage?<button className={primary} onClick={()=>open("BINDING",{vendor_adapter:"REST_POLL",factor_to_meter_unit:"1",polling_interval_seconds:"300",config_metadata:"{}"})}>+ Add source</button>:null}</div>}>
    {bindings.length?<div className="space-y-2">{bindings.map(x=><article key={x.id} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap justify-between gap-2"><strong className="text-xs">{s(x.source_system_code)} / {s(x.source_meter_code)}</strong><Pill value={s(x.status,"DRAFT")}/></div><p className="mt-1 text-[10px] text-slate-500">{s(x.vendor_adapter)} · {s(x.meter_code)} · {s(x.source_unit_code)} → {s(x.meter_unit_code)} · factor {s(x.factor_to_meter_unit)}</p><p className="mt-1 text-[10px] text-slate-400">Credential configured: {x.credential_configured?"Yes (reference only)":"No"} · version {s(x.row_version)}</p>{canSourceManage&&x.status!=="RETIRED"&&!(x.status!=="ACTIVE"&&String(x.created_by_user_id??"")===currentUserId)?<div className="mt-2 flex justify-end"><button className={secondary} onClick={()=>startBinding(x)}>Change state</button></div>:null}</article>)}</div>:<Empty>{canMeterRead?"No meter source mappings exist.":"Missing utilities.meters.read permission."}</Empty>}
   <p className="mt-3 rounded-lg bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">An approved mapping and source-event contract do not prove live adapter deployment. Vendor connectivity, polling delivery and hardware commissioning remain external acceptance evidence.</p>
   </Panel>
   <Panel title="Threshold policies" subtitle="Consumption, cost or intensity thresholds; server enforces target unit and independent activation." action={canAlertManage?<button className={primary} onClick={()=>open("POLICY",{metric:"CONSUMPTION",comparison:"GT",threshold_value:"",threshold_unit_code:"kWh",severity:"HIGH",meter_id:"",utility_type:"ELECTRICITY"})}>+ Create policy</button>:null}>
    {policies.length?<div className="space-y-2">{policies.map(x=><article key={x.id} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap justify-between gap-2"><strong className="text-xs">{s(x.policy_code)} · {s(x.name)}</strong><Pill value={s(x.status,"DRAFT")}/></div><p className="mt-1 text-[10px] text-slate-500">{s(x.metric)} {s(x.comparison)} {qty(x.threshold_value)} {s(x.threshold_unit_code)} · {s(x.severity)}</p><p className="mt-1 text-[10px] text-slate-400">{x.meter_id?"Meter-specific":"Utility "+s(x.utility_type)} · version {s(x.row_version)}</p>{canAlertManage&&x.status!=="RETIRED"&&!(x.status!=="ACTIVE"&&String(x.created_by_user_id??"")===currentUserId)?<div className="mt-2 flex justify-end"><button className={secondary} onClick={()=>startPolicy(x)}>Change state</button></div>:null}</article>)}</div>:<Empty>{canAlertRead?"No threshold policies exist.":"Missing utilities.alerts.read permission."}</Empty>}
   <p className="mt-3 rounded-lg bg-slate-50 p-3 text-[10px] leading-5 text-slate-600">For meter-specific policies the API validates currency or meter unit compatibility. Activation is a separate permission-controlled action.</p>
   </Panel>
  </div>:null}

  {tab==="costing"?<div className="grid gap-4 xl:grid-cols-[.85fr_1.15fr]">
   <Panel title="Reading source" subtitle="Only non-zero readings with frozen unit-cost/currency snapshots can be allocated.">
    <div className="space-y-3"><Select label="Meter" value={meterId} onChange={v=>{setMeterId(v);setReadingId("");}} options={[["","Select meter"],...meters.map(x=>[x.id,s(x.meter_code)+" · "+s(x.name)] as [string,string])]}/>
    <Select label="Reading" value={readingId} onChange={setReadingId} options={[["","Select reading"],...readings.map(x=>[x.id,dateLabel(x.reading_at)+" · "+qty(x.consumption_quantity)+" "+s(x.unit_code)] as [string,string])]}/>
    {reading?<div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs"><strong>Frozen cost snapshot</strong><div className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><span>Consumption</span><b className="text-right">{qty(reading.consumption_quantity)} {s(reading.unit_code)}</b><span>Unit cost</span><b className="text-right">{s(reading.currency_code_snapshot)} {qty(reading.unit_cost_snapshot)}</b><span>Recorded cost</span><b className="text-right">{s(reading.currency_code_snapshot)} {qty(reading.cost_amount)}</b><span>Remaining</span><b className="text-right">{qty(allocationSource.remaining_quantity)} {s(reading.unit_code)}</b></div></div>:<Empty>Select a meter reading to inspect allocation capacity.</Empty>}
    <p className="text-[10px] leading-5 text-slate-500">The API locks the reading, validates the work-order date window and checks net allocation capacity inside one transaction. Corrections are append-only reversals.</p></div>
   </Panel>
   <Panel title="Work-order energy allocations" subtitle="Amounts and quantities are preserved as decimal strings; allocations must fit inside the released work-order window." action={canAllocate&&reading?<button className={primary} onClick={()=>open("ALLOCATE",{work_order_id:"",allocated_quantity:"",reason:""})}>+ Allocate</button>:null}>
    {allocations.length?<div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead><tr className="border-b text-[9px] uppercase text-slate-500"><th className="pb-2">Work order</th><th className="pb-2">Kind</th><th className="pb-2">Quantity</th><th className="pb-2">Cost</th><th className="pb-2">Action</th></tr></thead><tbody>{allocations.map(x=><tr key={String(x.id)} className="border-b border-slate-100"><td className="py-2">{s(x.work_order_number)}</td><td className="py-2"><Pill value={s(x.allocation_kind)}/></td><td className="py-2">{qty(x.allocated_quantity)} {s(x.unit_code)}</td><td className="py-2">{s(x.currency_code)} {qty(x.allocated_cost)}</td><td className="py-2">{canAllocate&&x.allocation_kind==="ALLOCATE"&&!reversed.has(String(x.id))?<button className={warning} onClick={()=>open("REVERSE",{allocation_id:String(x.id),reason:""})}>Reverse</button>:"—"}</td></tr>)}</tbody></table></div>:<Empty>{reading?"No work-order allocations for this reading.":"Select a reading."}</Empty>}
    {reading?<p className="mt-3 border-t border-slate-100 pt-3 text-[10px] text-slate-400">Work orders loaded: {workOrders.length} · Reading {reading.id}</p>:null}
   </Panel>
  </div>:null}

  {editor?<div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)close();}}><section role="dialog" aria-modal="true" aria-labelledby="utility-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"><header className="sticky top-0 flex items-center justify-between border-b bg-white px-4 py-4"><div><h2 id="utility-title" className="text-sm font-bold">{title[editor]}</h2><p className="mt-1 text-[10px] text-slate-500">Authenticated factory scope · expected versions and server validations apply</p></div><button className={secondary} onClick={close} disabled={busy}>Close</button></header>
   <form onSubmit={submit} className="grid gap-3 p-4 sm:grid-cols-2">
    {editor==="METER"?<>
     <Field label="Meter code" value={draft.meter_code??""} onChange={v=>update("meter_code",v)}/><Field label="Meter name" value={draft.name??""} onChange={v=>update("name",v)}/>
     <Select label="Utility type" value={draft.utility_type??"ELECTRICITY"} onChange={v=>update("utility_type",v)} options={["ELECTRICITY","GAS","STEAM","WATER","COMPRESSED_AIR","FUEL","OTHER"].map(x=>[x,x.replaceAll("_"," ")] as [string,string])}/>
     <Select label="Reading mode" value={draft.reading_mode??"CUMULATIVE"} onChange={v=>update("reading_mode",v)} options={[["CUMULATIVE","Cumulative counter"],["INTERVAL","Interval reading"]]}/>
     <Field label="Unit code" value={draft.unit_code??""} onChange={v=>update("unit_code",v)} placeholder="kWh, m3, kg"/>
     <Field label="Multiplier" type="number" min="0.00000001" step="0.00000001" value={draft.multiplier_factor??"1"} onChange={v=>update("multiplier_factor",v)}/>
     <Field label="Unit cost" type="number" min="0" step="0.00000001" value={draft.unit_cost??"0"} onChange={v=>update("unit_cost",v)}/>
     <Field label="Currency code" value={draft.currency_code??"BDT"} onChange={v=>update("currency_code",v)}/>
     <Field label="Cost centre" required={false} value={draft.cost_center_code??""} onChange={v=>update("cost_center_code",v)}/>
     <Field label="Location" required={false} value={draft.location??""} onChange={v=>update("location",v)}/>
     <Select label="Parent meter (optional)" required={false} value={draft.parent_meter_id??""} onChange={v=>update("parent_meter_id",v)} options={[["","No parent"],...meters.filter(x=>x.status==="ACTIVE").map(x=>[x.id,s(x.meter_code)] as [string,string])]}/>
    </>:null}
    {editor==="READING"?<>
     <Field label="Reading time" type="datetime-local" value={draft.reading_at??""} onChange={v=>update("reading_at",v)}/>
     <Field label={"Counter / interval value ("+s(meter?.unit_code)+")"} type="number" min="0" step="0.00000001" value={draft.reading_value??""} onChange={v=>update("reading_value",v)}/>
     <Select label="Source type" value={draft.source_type??"MANUAL"} onChange={v=>update("source_type",v)} options={["MANUAL","API","METER_GATEWAY","IMPORT"].map(x=>[x,x.replaceAll("_"," ")] as [string,string])}/>
     <Field label="Production quantity (optional)" type="number" min="0.00000001" step="0.00000001" required={false} value={draft.production_quantity??""} onChange={v=>update("production_quantity",v)}/>
     <Field label="Source event ID" required={false} value={draft.source_event_id??""} onChange={v=>update("source_event_id",v)}/>
     <Field label="Notes" required={false} value={draft.notes??""} onChange={v=>update("notes",v)}/>
    </>:null}
    {editor==="EVENT"?<>
     <Select label="Event type" value={draft.event_type??"OUTAGE"} onChange={v=>update("event_type",v)} options={["OUTAGE","PEAK_LOAD","LEAK","PRESSURE_DROP","METER_FAULT","EFFICIENCY_EXCEPTION","OTHER"].map(x=>[x,x.replaceAll("_"," ")] as [string,string])}/>
     <Select label="Severity" value={draft.severity??"HIGH"} onChange={v=>update("severity",v)} options={["LOW","MEDIUM","HIGH","CRITICAL"].map(x=>[x,x])}/>
     <Field label="Title" value={draft.title??""} onChange={v=>update("title",v)}/>
     <Field label="Occurred at" type="datetime-local" value={draft.occurred_at??""} onChange={v=>update("occurred_at",v)}/>
     <Select label="Related meter" required={false} value={draft.meter_id??""} onChange={v=>update("meter_id",v)} options={[["","No linked meter"],...meters.map(x=>[x.id,s(x.meter_code)] as [string,string])]}/>
     <Field label="Impact minutes" type="number" min="0" step="1" value={draft.impact_minutes??"0"} onChange={v=>update("impact_minutes",v)}/>
     <Field label="Impact quantity" required={false} type="number" min="0" step="0.00000001" value={draft.impact_quantity??""} onChange={v=>update("impact_quantity",v)}/>
     <Field label="Cause" required={false} value={draft.cause??""} onChange={v=>update("cause",v)}/>
     <div className="sm:col-span-2"><Area label="Description" value={draft.description??""} onChange={v=>update("description",v)}/></div>
    </>:null}
    {editor==="EVENT_TRANSITION"?<>
     <Field label="Expected version" type="number" min="1" value={draft.expected_version??""} onChange={v=>update("expected_version",v)}/>
     <Select label="Action" value={draft.action??"ACKNOWLEDGE"} onChange={v=>update("action",v)} options={["ACKNOWLEDGE","RESOLVE","CANCEL"].map(x=>[x,x])}/>
     <div className="sm:col-span-2"><Field label="Reason" value={draft.reason??""} onChange={v=>update("reason",v)}/></div>
     {draft.action==="RESOLVE"?<div className="sm:col-span-2"><Area label="Resolution evidence" value={draft.resolution??""} onChange={v=>update("resolution",v)}/></div>:null}
    </>:null}
    {editor==="BINDING"?<>
     <Field label="Source system code" value={draft.source_system_code??""} onChange={v=>update("source_system_code",v)}/>
     <Field label="Source meter code" value={draft.source_meter_code??""} onChange={v=>update("source_meter_code",v)}/>
     <Select label="Adapter" value={draft.vendor_adapter??"REST_POLL"} onChange={v=>update("vendor_adapter",v)} options={["REST_POLL","OPC_UA","MQTT","MODBUS","FILE_IMPORT","MANUAL_IMPORT"].map(x=>[x,x.replaceAll("_"," ")] as [string,string])}/>
     <Select label="Active factory meter" value={draft.meter_id??""} onChange={v=>update("meter_id",v)} options={[["","Select meter"],...meters.filter(x=>x.status==="ACTIVE").map(x=>[x.id,s(x.meter_code)] as [string,string])]}/>
     <Field label="Source unit" value={draft.source_unit_code??""} onChange={v=>update("source_unit_code",v)}/>
     <Field label="Conversion factor" type="number" min="0.00000001" step="0.00000001" value={draft.factor_to_meter_unit??"1"} onChange={v=>update("factor_to_meter_unit",v)}/>
     <Field label="Polling interval (s)" type="number" min="5" max="86400" step="1" required={["REST_POLL","OPC_UA","MODBUS"].includes(draft.vendor_adapter??"REST_POLL")} value={draft.polling_interval_seconds??""} onChange={v=>update("polling_interval_seconds",v)}/>
     <Field label="Secret-manager reference" required={false} value={draft.credential_reference??""} onChange={v=>update("credential_reference",v)} placeholder="vault://... or secrets://..."/>
     <div className="sm:col-span-2"><Area label="Non-secret configuration metadata (JSON)" required={false} value={draft.config_metadata??"{}"} onChange={v=>update("config_metadata",v)}/></div>
    </>:null}
    {editor==="BINDING_TRANSITION"||editor==="POLICY_TRANSITION"?<>
     <Field label="Expected version" type="number" min="1" value={draft.expected_version??""} onChange={v=>update("expected_version",v)}/>
     <Select label="Action" value={draft.action??"ACTIVATE"} onChange={v=>update("action",v)} options={["ACTIVATE","DEACTIVATE","RETIRE"].map(x=>[x,x])}/>
     <div className="sm:col-span-2"><Field label="Reason" value={draft.reason??""} onChange={v=>update("reason",v)}/></div>
     <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-[10px] text-amber-900">Activation requires a different authenticated user than the record creator. The API enforces this and the expected row version.</p>
    </>:null}
    {editor==="INGEST"?<>
     <Field label="Source system" value={draft.source_system_code??""} onChange={v=>update("source_system_code",v)}/>
     <Field label="Source meter code" value={draft.source_meter_code??""} onChange={v=>update("source_meter_code",v)}/>
     <Field label="Source event ID" value={draft.source_event_id??""} onChange={v=>update("source_event_id",v)}/>
     <Field label="Reading time" type="datetime-local" value={draft.reading_at??""} onChange={v=>update("reading_at",v)}/>
     <Field label="Source value" type="number" min="0" step="0.00000001" value={draft.reading_value??""} onChange={v=>update("reading_value",v)}/>
     <Field label="Source unit" value={draft.source_unit_code??""} onChange={v=>update("source_unit_code",v)}/>
     <Field label="Production quantity" type="number" min="0.00000001" required={false} value={draft.production_quantity??""} onChange={v=>update("production_quantity",v)}/>
     <Field label="Notes" required={false} value={draft.notes??""} onChange={v=>update("notes",v)}/>
    </>:null}
    {editor==="POLICY"?<>
     <Field label="Policy code" value={draft.policy_code??""} onChange={v=>update("policy_code",v)}/>
     <Field label="Policy name" value={draft.name??""} onChange={v=>update("name",v)}/>
     <Select label="Target meter (optional)" required={false} value={draft.meter_id??""} onChange={v=>update("meter_id",v)} options={[["","No meter target"],...meters.filter(x=>x.status==="ACTIVE").map(x=>[x.id,s(x.meter_code)] as [string,string])]}/>
     <Select label="Utility type" value={draft.utility_type??"ELECTRICITY"} onChange={v=>update("utility_type",v)} options={["ELECTRICITY","GAS","STEAM","WATER","COMPRESSED_AIR","FUEL","OTHER"].map(x=>[x,x.replaceAll("_"," ")] as [string,string])}/>
     <Select label="Metric" value={draft.metric??"CONSUMPTION"} onChange={v=>update("metric",v)} options={[["CONSUMPTION","Consumption"],["COST","Cost"],["INTENSITY","Intensity"]]}/>
     <Select label="Comparison" value={draft.comparison??"GT"} onChange={v=>update("comparison",v)} options={[["GT","Greater than"],["GTE","Greater than or equal"],["LT","Less than"],["LTE","Less than or equal"]]}/>
     <Field label="Threshold value" type="number" min="0" step="0.00000001" value={draft.threshold_value??""} onChange={v=>update("threshold_value",v)}/>
     <Field label="Threshold unit code" value={draft.threshold_unit_code??""} onChange={v=>update("threshold_unit_code",v)}/>
     <Select label="Severity" value={draft.severity??"HIGH"} onChange={v=>update("severity",v)} options={["LOW","MEDIUM","HIGH","CRITICAL"].map(x=>[x,x])}/>
    </>:null}
    {editor==="ALLOCATE"?<>
     <Select label="Released work order" value={draft.work_order_id??""} onChange={v=>update("work_order_id",v)} options={[["","Select work order"],...workOrders.filter(x=>["IN_PROGRESS","COMPLETED"].includes(String(x.status))).map(x=>[x.id,s(x.work_order_number)+" · "+s(x.status)] as [string,string])]}/>
     <Field label="Allocated quantity" value={draft.allocated_quantity??""} onChange={v=>update("allocated_quantity",v)} placeholder="Exact decimal quantity"/>
     <div className="sm:col-span-2"><Field label="Reason" value={draft.reason??""} onChange={v=>update("reason",v)}/></div>
     <p className="sm:col-span-2 text-[10px] text-slate-500">Remaining capacity: {qty(allocationSource.remaining_quantity)} {s(reading?.unit_code)}. The server transaction is authoritative.</p>
    </>:null}
    {editor==="REVERSE"?<>
     <Field label="Allocation ID" value={draft.allocation_id??""} onChange={v=>update("allocation_id",v)}/>
     <div className="sm:col-span-2"><Field label="Reversal reason" value={draft.reason??""} onChange={v=>update("reason",v)}/></div>
     <p className="sm:col-span-2 rounded-lg bg-rose-50 p-3 text-[10px] text-rose-900">Creates a separate reversal ledger entry; the original allocation is not edited.</p>
    </>:null}
    <div className="sm:col-span-2 flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={close} disabled={busy} className={secondary}>Cancel</button><button type="submit" disabled={busy} className={primary}>{busy?"Saving…":"Submit"}</button></div>
   </form>
  </section></div>:null}
 </main>;
}
