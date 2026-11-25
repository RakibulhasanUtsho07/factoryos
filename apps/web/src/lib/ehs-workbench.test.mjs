import test from "node:test";
import assert from "node:assert/strict";
import {
 buildEhsAttendancePayload,buildEhsChemicalPayload,buildEhsChemicalTransitionPayload,
 buildEhsContractorPayload,buildEhsContractorTransitionPayload,buildEhsCorrectiveActionPayload,
 buildEhsCorrectiveActionTransitionPayload,buildEhsDrillPayload,buildEhsDrillResponsePayload,
 buildEhsDrillTransitionPayload,buildEhsIncidentPayload,buildEhsIncidentTransitionPayload,
 buildEhsListQuery,buildEhsPermitPayload,buildEhsPermitTransitionPayload,normalizeEhsRows,summarizeEhs
} from "./ehs-workbench.mjs";

const ID="a3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";
const ID2="b3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";
const NOW="2026-11-25T08:00:00.000Z";
const FUTURE="2027-01-01T09:00:00.000Z";
const PERMIT_END="2026-11-25T09:00:00.000Z";
const PAST="2026-11-24T08:00:00.000Z";

test("normalizes EHS lists and rejects unsupported list statuses",()=>{
 const rows=[{id:"x"}];
 assert.deepEqual(normalizeEhsRows({items:rows}),rows);
 assert.deepEqual(normalizeEhsRows({data:{items:rows}}),rows);
 assert.deepEqual(normalizeEhsRows({incidents:rows},"incidents"),rows);
 assert.deepEqual(normalizeEhsRows(null),[]);
 assert.equal(buildEhsListQuery({limit:50,status:"open"},"incidents"),"?limit=50&status=OPEN");
 assert.throws(()=>buildEhsListQuery({status:"PAUSED"},"permits"),/status/);
 assert.throws(()=>buildEhsListQuery({limit:201},"drills"),/limit/);
});

test("builds incident intake with due-date chronology and tenant-safe owner scope",()=>{
 const payload=buildEhsIncidentPayload({
  incident_type:"near_miss",severity:"high",title:"Loose guard",description:"A fastener was loose",
  location:"Line 2",occurred_at:NOW,due_at:FUTURE,assigned_owner_user_id:ID
 });
 assert.equal(payload.incident_type,"NEAR_MISS");
 assert.equal(payload.severity,"HIGH");
 assert.equal(payload.assigned_owner_user_id,ID);
 assert.equal(Object.hasOwn(payload,"factory_id"),false);
 assert.throws(()=>buildEhsIncidentPayload({
  incident_type:"INCIDENT",severity:"LOW",title:"x",description:"x",location:"x",occurred_at:FUTURE,due_at:NOW
 }),/before/);
 assert.throws(()=>buildEhsIncidentPayload({
  incident_type:"UNKNOWN",severity:"LOW",title:"x",description:"x",location:"x",occurred_at:NOW
 }),/incident type/);
});

test("requires structured evidence and root cause to resolve or close incidents",()=>{
 assert.equal(buildEhsIncidentTransitionPayload({action:"START_INVESTIGATION",expected_version:2,reason:"Investigate"}).expected_version,2);
 assert.throws(()=>buildEhsIncidentTransitionPayload({action:"RESOLVE",expected_version:2,reason:"Done",root_cause:"Cause"}),/structured evidence/);
 const payload=buildEhsIncidentTransitionPayload({
  action:"CLOSE",expected_version:3,reason:"Verified",root_cause:"Seal failure",
  closure_evidence:{inspection_ref:"INS-22"}
 });
 assert.deepEqual(payload.closure_evidence,{inspection_ref:"INS-22"});
});

test("builds versioned corrective action and independent verification evidence",()=>{
 const created=buildEhsCorrectiveActionPayload({
  incident_id:ID,action_number:"CA-01",description:"Replace guard",assigned_owner_user_id:ID2,due_at:FUTURE
 });
 assert.equal(created.incident_id,ID);
 assert.throws(()=>buildEhsCorrectiveActionPayload({
  incident_id:ID,action_number:"CA-01",description:"x",assigned_owner_user_id:"bad",due_at:FUTURE
 }),/UUID/);
 assert.throws(()=>buildEhsCorrectiveActionTransitionPayload({
  action:"SUBMIT_FOR_VERIFICATION",expected_version:2,reason:"Done",root_cause:"Cause"
 }),/structured evidence/);
 assert.throws(()=>buildEhsCorrectiveActionTransitionPayload({
  action:"VERIFY",expected_version:2,reason:"Verify"
 }),/structured evidence/);
 const verified=buildEhsCorrectiveActionTransitionPayload({
  action:"VERIFY",expected_version:4,reason:"Inspection done",verification_evidence:{inspection_id:"Q-22"}
 });
 assert.equal(verified.action,"VERIFY");
});

test("requires isolation for high-risk permits and enforces the seven-day validity window",()=>{
 const base={permit_number:"PTW-1",permit_type:"ELECTRICAL_LOTO",risk_level:"CRITICAL",title:"Isolate press",
  work_scope:"Lock out and test",location:"Press 1",valid_from:NOW,expires_at:PERMIT_END};
 assert.throws(()=>buildEhsPermitPayload(base),/at least one isolation point/);
 const payload=buildEhsPermitPayload({
  ...base,isolation_points:[{code:"MAIN",description:"Main supply breaker"}]
 });
 assert.equal(payload.requires_isolation,true);
 assert.equal(payload.isolation_points.length,1);
 assert.throws(()=>buildEhsPermitPayload({
  ...base,isolation_points:[{code:"MAIN",description:"x"},{code:"main",description:"y"}]
 }),/unique/);
 assert.throws(()=>buildEhsPermitPayload({
  ...base,permit_type:"GENERAL",risk_level:"LOW",valid_from:NOW,expires_at:"2026-12-03T08:00:00Z"
 }),/seven days/);
});

test("builds distinct permit decision, isolation verification and closure contracts",()=>{
 assert.throws(()=>buildEhsPermitTransitionPayload({
  action:"APPROVE",expected_version:2,reason:"Review"
 }),/decision_reason/);
 assert.throws(()=>buildEhsPermitTransitionPayload({
  action:"VERIFY_ISOLATION",expected_version:2,reason:"Check",
  isolation_verification:[{code:"M",verified:false,evidence:"Not tested"}]
 }),/positively verified/);
 const verified=buildEhsPermitTransitionPayload({
  action:"VERIFY_ISOLATION",expected_version:2,reason:"LOTO completed",
  isolation_verification:[{code:"M",verified:true,evidence:"Zero energy verified"}]
 });
 assert.equal(verified.isolation_verification[0].verified,true);
 assert.throws(()=>buildEhsPermitTransitionPayload({
  action:"CLOSE",expected_version:4,reason:"Closed",closure_reason:"Finished"
 }),/structured evidence/);
});

test("validates emergency drill, attendance and response evidence before submission",()=>{
 const drill=buildEhsDrillPayload({
  drill_number:"DR-1",drill_type:"EVACUATION",title:"North block",location:"North block",
  planned_at:FUTURE,owner_user_id:ID
 });
 assert.equal(drill.owner_user_id,ID);
 assert.throws(()=>buildEhsDrillTransitionPayload({
  action:"COMPLETE",expected_version:3,reason:"Done",outcome_summary:"Complete"
 }),/structured evidence/);
 assert.equal(buildEhsDrillTransitionPayload({
  action:"COMPLETE",expected_version:3,reason:"Done",outcome_summary:"Complete",
  close_evidence:{report:"DR-1"}
 }).action,"COMPLETE");
 assert.equal(buildEhsAttendancePayload({
  attendee_ref:"EMP-1",attendee_name:"Worker",attendance_status:"present"
 }).attendance_status,"PRESENT");
 assert.throws(()=>buildEhsDrillResponsePayload({
  response_code:"R1",response_action:"Evacuate",occurred_at:NOW,evidence:{}
 }),/structured evidence/);
});

test("validates controlled SDS document URIs and independent activation payloads",()=>{
 const dto={
  chemical_code:"chem-1",chemical_name:"Cleaning solution",hazard_class:"IRRITANT",storage_location:"Cabinet A",
  sds_revision:"REV-1",sds_document_uri:"https://docs.example.invalid/sds.pdf",
  sds_issued_at:PAST,sds_review_due_at:FUTURE,handling_instructions:"Use PPE",emergency_instructions:"Follow spill plan"
 };
 assert.equal(buildEhsChemicalPayload(dto).chemical_code,"CHEM-1");
 assert.throws(()=>buildEhsChemicalPayload({...dto,sds_document_uri:"file:///etc/passwd"}),/credential-free/);
 assert.throws(()=>buildEhsChemicalPayload({...dto,sds_review_due_at:PAST}),/precede/);
 assert.deepEqual(buildEhsChemicalTransitionPayload({action:"ACTIVATE",expected_version:1,reason:"Independent review"}),{
  expected_version:1,action:"ACTIVATE",reason:"Independent review"
 });
});

test("requires completed past contractor induction, topics, evidence and reasoned revocation",()=>{
 const input={
  contractor_code:"sub-1",company_name:"Contractor",person_name:"Worker",
  induction_at:PAST,expires_at:FUTURE,topics:["PPE","Evacuation"],evidence:{attendance_ref:"IND-22"}
 };
 assert.equal(buildEhsContractorPayload(input).contractor_code,"SUB-1");
 assert.throws(()=>buildEhsContractorPayload({...input,induction_at:FUTURE}),/future induction/);
 assert.throws(()=>buildEhsContractorPayload({...input,evidence:{}}),/structured evidence/);
 assert.equal(buildEhsContractorTransitionPayload({action:"REVOKE",expected_version:2,reason:"Badge invalid"}).action,"REVOKE");
});

test("summarizes only loaded EHS records without fabricating organization-wide counts",()=>{
 const result=summarizeEhs({
  incidents:[{status:"OPEN",severity:"CRITICAL"},{status:"CLOSED",severity:"HIGH"}],
  permits:[{status:"PENDING_APPROVAL"},{status:"ACTIVE"}],
  drills:[{status:"IN_PROGRESS"}],
  chemicals:[{status:"ACTIVE",sds_review_due_at:"2020-01-01T00:00:00.000Z"}],
  contractors:[{status:"ACTIVE"}]
 });
 assert.deepEqual(result,{
  incidentOpen:1,incidentCritical:1,permitsAwaitingApproval:1,permitsActive:1,
  drillsInProgress:1,chemicalReviewDue:1,contractorActive:1
 });
});
