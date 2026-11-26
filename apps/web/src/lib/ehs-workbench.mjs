const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INCIDENT_TYPES=["INCIDENT","NEAR_MISS","UNSAFE_OBSERVATION","INJURY","ENVIRONMENTAL_RELEASE","AUDIT_FINDING"];
const SEVERITIES=["LOW","MEDIUM","HIGH","CRITICAL"];
const PERMIT_TYPES=["HOT_WORK","ELECTRICAL_LOTO","CONFINED_SPACE","WORK_AT_HEIGHT","CHEMICAL_HANDLING","GENERAL"];
const RISK_LEVELS=SEVERITIES;
const DRILL_TYPES=["FIRE","EVACUATION","CHEMICAL_SPILL","MEDICAL","NATURAL_DISASTER","OTHER"];

function text(value,field,max){
  const result=typeof value==="string"?value.trim():"";
  if(!result||result.length>max)throw new Error(field+" must contain 1 to "+max+" characters.");
  return result;
}
function optional(value,field,max){
  const result=typeof value==="string"?value.trim():"";
  if(result.length>max)throw new Error(field+" must not exceed "+max+" characters.");
  return result||"";
}
function uuid(value,field){
  const result=typeof value==="string"?value.trim():"";
  if(!UUID.test(result))throw new Error(field+" must be a valid UUID.");
  return result;
}
function integer(value,field,min,max){
  const result=Number(value);
  if(!Number.isInteger(result)||result<min||result>max)throw new Error(field+" must be an integer from "+min+" to "+max+".");
  return result;
}
function instant(value,field){
  const raw=typeof value==="string"?value.trim():"";
  if(!raw)throw new Error(field+" is required.");
  const parsed=new Date(raw);
  if(!Number.isFinite(parsed.getTime()))throw new Error(field+" must be a valid date and time.");
  return parsed.toISOString();
}
function enumValue(value,field,allowed){
  const result=typeof value==="string"?value.trim().toUpperCase():"";
  if(!allowed.includes(result))throw new Error("Unsupported "+field+".");
  return result;
}
function evidenceValue(value,field){
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length===0){
    throw new Error(field+" must contain structured evidence.");
  }
  return value;
}
function jsonEvidence(reference,notes){
  const ref=text(reference,"evidence reference",500);
  const comment=optional(notes,"evidence notes",2000);
  return {reference:ref,...(comment?{notes:comment}:{})};
}

export function normalizeEhsRows(value,preferredKey="items"){
  if(Array.isArray(value))return value;
  if(!value||typeof value!=="object")return [];
  if(preferredKey&&Array.isArray(value[preferredKey]))return value[preferredKey];
  for(const key of ["items","rows","records","permits","incidents","actions","drills","chemicals","inductions","attendance","responses"]){
    if(Array.isArray(value[key]))return value[key];
  }
  if(value.data!==undefined)return normalizeEhsRows(value.data,preferredKey);
  return [];
}
export function buildEhsListQuery(input={},kind="incidents"){
  const limit=integer(input.limit??100,"limit",1,200);
  const params=new URLSearchParams({limit:String(limit)});
  const status=optional(input.status,"status",32).toUpperCase();
  const statuses={
    permits:["DRAFT","PENDING_APPROVAL","APPROVED","REJECTED","ACTIVE","CLOSED","CANCELLED","EXPIRED"],
    incidents:["OPEN","INVESTIGATING","ACTION_REQUIRED","RESOLVED","CLOSED","CANCELLED"],
    drills:["PLANNED","IN_PROGRESS","COMPLETED","CANCELLED"],
    chemicals:["DRAFT","ACTIVE","INACTIVE","RETIRED"],
    contractors:["ACTIVE","EXPIRED","REVOKED"],
  };
  if(!Object.hasOwn(statuses,kind))throw new Error("Unsupported EHS list.");
  if(status&&!statuses[kind].includes(status))throw new Error("Unsupported "+kind+" status.");
  if(status)params.set("status",status);
  const risk=optional(input.risk_level,"risk_level",16).toUpperCase();
  if(risk){
    if(!RISK_LEVELS.includes(risk))throw new Error("Unsupported risk level.");
    params.set("risk_level",risk);
  }
  const severity=optional(input.severity,"severity",16).toUpperCase();
  if(severity){
    if(!SEVERITIES.includes(severity))throw new Error("Unsupported severity.");
    params.set("severity",severity);
  }
  return "?"+params.toString();
}

export function buildEhsIncidentPayload(input={}){
  const due=input.due_at?instant(input.due_at,"due_at"):"";
  const occurred=instant(input.occurred_at,"occurred_at");
  if(due&&Date.parse(due)<Date.parse(occurred))throw new Error("due_at cannot be before occurred_at.");
  return {
    incident_type:enumValue(input.incident_type,"incident type",INCIDENT_TYPES),
    severity:enumValue(input.severity,"severity",SEVERITIES),
    title:text(input.title,"title",255),
    description:text(input.description,"description",4000),
    location:text(input.location,"location",255),
    occurred_at:occurred,
    ...(optional(input.immediate_action,"immediate_action",2000)?{immediate_action:optional(input.immediate_action,"immediate_action",2000)}:{}),
    ...(optional(input.assigned_owner_user_id,"assigned_owner_user_id",36)?{assigned_owner_user_id:uuid(input.assigned_owner_user_id,"assigned_owner_user_id")} : {}),
    ...(due?{due_at:due}:{})
  };
}
export function buildEhsIncidentTransitionPayload(input={}){
  const action=enumValue(input.action,"incident action",["START_INVESTIGATION","REQUIRE_ACTION","RESOLVE","CLOSE","REOPEN","CANCEL"]);
  const payload={expected_version:integer(input.expected_version,"expected_version",1,2147483647),action,reason:text(input.reason,"reason",2000)};
  const investigation=optional(input.investigation_summary,"investigation_summary",4000);
  const root=optional(input.root_cause,"root_cause",4000);
  if(investigation)payload.investigation_summary=investigation;
  if(["RESOLVE","CLOSE"].includes(action)){
    if(!root)throw new Error("root_cause is required for incident resolution or closure.");
    payload.root_cause=root;
    payload.closure_evidence=evidenceValue(input.closure_evidence,"closure_evidence");
  }else if(root)payload.root_cause=root;
  return payload;
}
export function buildEhsCorrectiveActionPayload(input={}){
  return {
    incident_id:uuid(input.incident_id,"incident_id"),
    action_number:text(input.action_number,"action_number",100),
    description:text(input.description,"description",4000),
    assigned_owner_user_id:uuid(input.assigned_owner_user_id,"assigned_owner_user_id"),
    due_at:instant(input.due_at,"due_at")
  };
}
export function buildEhsCorrectiveActionTransitionPayload(input={}){
  const action=enumValue(input.action,"corrective-action command",["START","SUBMIT_FOR_VERIFICATION","VERIFY","REOPEN","CANCEL"]);
  const payload={expected_version:integer(input.expected_version,"expected_version",1,2147483647),action,reason:text(input.reason,"reason",2000)};
  const root=optional(input.root_cause,"root_cause",4000);
  if(action==="SUBMIT_FOR_VERIFICATION"){
    if(!root)throw new Error("root_cause is required before verification submission.");
    payload.root_cause=root;
    payload.completion_evidence=evidenceValue(input.completion_evidence,"completion_evidence");
  }else if(root)payload.root_cause=root;
  if(action==="VERIFY")payload.verification_evidence=evidenceValue(input.verification_evidence,"verification_evidence");
  return payload;
}

export function buildEhsPermitPayload(input={}){
  const start=instant(input.valid_from,"valid_from"),end=instant(input.expires_at,"expires_at");
  const duration=Date.parse(end)-Date.parse(start);
  if(duration<=0||duration>7*86400000)throw new Error("Permit expiry must be after start and no more than seven days later.");
  const permitType=enumValue(input.permit_type,"permit type",PERMIT_TYPES);
  const risk=enumValue(input.risk_level,"risk level",RISK_LEVELS);
  const requiresIsolation=input.requires_isolation==="true"||input.requires_isolation===true
    ||["ELECTRICAL_LOTO","CONFINED_SPACE"].includes(permitType)||["HIGH","CRITICAL"].includes(risk);
  const points=(Array.isArray(input.isolation_points)?input.isolation_points:[])
    .filter(point=>optional(point.code,"isolation point code",100)||optional(point.description,"isolation description",500))
    .map(point=>({code:text(point.code,"isolation point code",100),description:text(point.description,"isolation point description",500)}));
  if(requiresIsolation&&!points.length)throw new Error("High-risk or isolation permits require at least one isolation point.");
  if(new Set(points.map(point=>point.code.toLowerCase())).size!==points.length)throw new Error("Isolation point codes must be unique.");
  const workOrder=input.work_order_id?uuid(input.work_order_id,"work_order_id"):"";
  return {
    ...(workOrder?{work_order_id:workOrder}:{}),
    permit_number:text(input.permit_number,"permit_number",100),
    permit_type:risk?permitType:permitType,
    risk_level:risk,
    title:text(input.title,"title",255),
    work_scope:text(input.work_scope,"work_scope",4000),
    location:text(input.location,"location",255),
    valid_from:start,expires_at:end,requires_isolation:requiresIsolation,
    ...(points.length?{isolation_points:points}:{})
  };
}
export function buildEhsPermitTransitionPayload(input={}){
  const action=enumValue(input.action,"permit action",["SUBMIT","APPROVE","REJECT","VERIFY_ISOLATION","ACTIVATE","CLOSE","CANCEL","EXPIRE"]);
  const payload={expected_version:integer(input.expected_version,"expected_version",1,2147483647),action,reason:text(input.reason,"reason",2000)};
  if(["APPROVE","REJECT"].includes(action))payload.decision_reason=text(input.decision_reason,"decision_reason",2000);
  if(action==="VERIFY_ISOLATION"){
    const values=Array.isArray(input.isolation_verification)?input.isolation_verification:[];
    if(!values.length)throw new Error("Isolation verification is required.");
    const codes=new Set();
    payload.isolation_verification=values.map(value=>{
      const code=text(value.code,"isolation code",100);
      if(codes.has(code.toLowerCase()))throw new Error("Isolation verification codes must be unique.");
      codes.add(code.toLowerCase());
      if(value.verified!==true)throw new Error("Every isolation point must be positively verified.");
      return {code,verified:true,evidence:text(value.evidence,"isolation evidence",2000)};
    });
  }
  if(action==="CLOSE"){
    payload.closure_evidence=evidenceValue(input.closure_evidence,"closure_evidence");
    payload.closure_reason=text(input.closure_reason,"closure_reason",2000);
  }
  return payload;
}

export function buildEhsDrillPayload(input={}){
  return {
    drill_number:text(input.drill_number,"drill_number",100),
    drill_type:enumValue(input.drill_type,"drill type",DRILL_TYPES),
    title:text(input.title,"title",255),
    location:text(input.location,"location",255),
    planned_at:instant(input.planned_at,"planned_at"),
    owner_user_id:uuid(input.owner_user_id,"owner_user_id")
  };
}
export function buildEhsDrillTransitionPayload(input={}){
  const action=enumValue(input.action,"drill action",["START","COMPLETE","CANCEL"]);
  const payload={expected_version:integer(input.expected_version,"expected_version",1,2147483647),action,reason:text(input.reason,"reason",2000)};
  if(action==="COMPLETE"){
    payload.outcome_summary=text(input.outcome_summary,"outcome_summary",4000);
    payload.close_evidence=evidenceValue(input.close_evidence,"close_evidence");
  }
  return payload;
}
export function buildEhsAttendancePayload(input={}){
  return {
    attendee_ref:text(input.attendee_ref,"attendee_ref",160),
    attendee_name:text(input.attendee_name,"attendee_name",255),
    ...(input.user_id?{user_id:uuid(input.user_id,"user_id")}:{}),
    attendance_status:enumValue(input.attendance_status,"attendance status",["PRESENT","ABSENT","EXCUSED"]),
    ...(optional(input.notes,"notes",2000)?{notes:optional(input.notes,"notes",2000)}:{}),
    ...(input.evidence&&Object.keys(input.evidence).length?{evidence:evidenceValue(input.evidence,"evidence")}:{})
  };
}
export function buildEhsDrillResponsePayload(input={}){
  const evidence=evidenceValue(input.evidence,"response evidence");
  const elapsed=input.elapsed_seconds===""||input.elapsed_seconds===undefined?undefined:integer(input.elapsed_seconds,"elapsed_seconds",0,604800);
  return {
    response_code:text(input.response_code,"response_code",100),
    response_action:text(input.response_action,"response_action",4000),
    ...(input.responder_user_id?{responder_user_id:uuid(input.responder_user_id,"responder_user_id")}:{}),
    ...(elapsed===undefined?{}:{elapsed_seconds:elapsed}),
    occurred_at:instant(input.occurred_at,"occurred_at"),
    evidence
  };
}
export function buildEhsChemicalPayload(input={}){
  const issued=instant(input.sds_issued_at,"sds_issued_at"),review=instant(input.sds_review_due_at,"sds_review_due_at");
  if(Date.parse(issued)>Date.now())throw new Error("SDS issue date cannot be in the future.");
  if(Date.parse(review)<Date.parse(issued))throw new Error("SDS review due date cannot precede its issue date.");
  const uri=text(input.sds_document_uri,"sds_document_uri",2048);
  let url;
  try{url=new URL(uri);}catch{throw new Error("SDS document reference must be a valid URI.");}
  if(!["https:","s3:","gs:"].includes(url.protocol)||url.username||url.password||!url.hostname||/\s/.test(uri)){
    throw new Error("SDS document reference must be credential-free https://, s3:// or gs://.");
  }
  const manufacturer=optional(input.manufacturer,"manufacturer",255);
  return {
    chemical_code:text(input.chemical_code,"chemical_code",100).toUpperCase(),
    chemical_name:text(input.chemical_name,"chemical_name",255),
    ...(manufacturer?{manufacturer}:{}),
    hazard_class:text(input.hazard_class,"hazard_class",100),
    storage_location:text(input.storage_location,"storage_location",255),
    sds_revision:text(input.sds_revision,"sds_revision",100),
    sds_document_uri:uri,sds_issued_at:issued,sds_review_due_at:review,
    handling_instructions:text(input.handling_instructions,"handling_instructions",4000),
    emergency_instructions:text(input.emergency_instructions,"emergency_instructions",4000)
  };
}
export function buildEhsChemicalTransitionPayload(input={}){
  return {
    expected_version:integer(input.expected_version,"expected_version",1,2147483647),
    action:enumValue(input.action,"chemical/SDS action",["ACTIVATE","DEACTIVATE","RETIRE"]),
    reason:text(input.reason,"reason",2000)
  };
}
export function buildEhsContractorPayload(input={}){
  const induction=instant(input.induction_at,"induction_at"),expires=instant(input.expires_at,"expires_at");
  if(Date.parse(expires)<=Date.parse(induction))throw new Error("Induction expiry must be after induction time.");
  if(Date.parse(induction)>Date.now())throw new Error("A future induction cannot be recorded as completed training.");
  if(Date.parse(expires)<=Date.now())throw new Error("Expired induction cannot be registered as active.");
  const topics=Array.isArray(input.topics)?[...new Set(input.topics.map(topic=>text(topic,"topic",160)))]:[];
  if(!topics.length||topics.length>50)throw new Error("One to 50 induction topics are required.");
  return {
    contractor_code:text(input.contractor_code,"contractor_code",100).toUpperCase(),
    company_name:text(input.company_name,"company_name",255),
    person_name:text(input.person_name,"person_name",255),
    induction_at:induction,expires_at:expires,topics,
    evidence:evidenceValue(input.evidence,"induction evidence")
  };
}
export function buildEhsContractorTransitionPayload(input={}){
  return {
    expected_version:integer(input.expected_version,"expected_version",1,2147483647),
    action:enumValue(input.action,"contractor induction action",["REVOKE","EXPIRE"]),
    reason:text(input.reason,"reason",2000)
  };
}
export function summarizeEhs(input={}){
  const incidents=Array.isArray(input.incidents)?input.incidents:[];
  const permits=Array.isArray(input.permits)?input.permits:[];
  const drills=Array.isArray(input.drills)?input.drills:[];
  const chemicals=Array.isArray(input.chemicals)?input.chemicals:[];
  const contractors=Array.isArray(input.contractors)?input.contractors:[];
  const count=(rows,status)=>rows.filter(row=>String(row.status??"").toUpperCase()===status).length;
  return {
    incidentOpen:incidents.filter(row=>["OPEN","INVESTIGATING","ACTION_REQUIRED"].includes(String(row.status??"").toUpperCase())).length,
    incidentCritical:incidents.filter(row=>String(row.severity??"").toUpperCase()==="CRITICAL"&&!["CLOSED","CANCELLED"].includes(String(row.status??"").toUpperCase())).length,
    permitsAwaitingApproval:count(permits,"PENDING_APPROVAL"),
    permitsActive:count(permits,"ACTIVE"),
    drillsInProgress:count(drills,"IN_PROGRESS"),
    chemicalReviewDue:chemicals.filter(row=>row.status==="ACTIVE"&&row.sds_review_due_at&&Date.parse(String(row.sds_review_due_at))<Date.now()).length,
    contractorActive:count(contractors,"ACTIVE")
  };
}
