import test from "node:test";
import assert from "node:assert/strict";
import {
 buildUtilityAllocationReversePayload,buildUtilityEventPayload,buildUtilityEventTransitionPayload,
 buildUtilityListQuery,buildUtilityMeterPayload,buildUtilityReadingPayload,buildUtilitySourceBindingPayload,
 buildUtilitySourceBindingTransitionPayload,buildUtilitySourceEventPayload,buildUtilityThresholdPolicyPayload,
 buildUtilityThresholdPolicyTransitionPayload,buildUtilityWorkOrderAllocationPayload,normalizeUtilityRows,summarizeUtilities
} from "./utilities-workbench.mjs";

const ID="a3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";
const ID2="b3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";
const NOW="2026-11-26T10:00:00.000Z";

test("normalizes utility list response envelopes without inventing rows",()=>{
 const rows=[{id:"m-1"}];
 assert.deepEqual(normalizeUtilityRows(rows),rows);
 assert.deepEqual(normalizeUtilityRows({items:rows}),rows);
 assert.deepEqual(normalizeUtilityRows({data:{items:rows}}),rows);
 assert.deepEqual(normalizeUtilityRows({events:rows},"events"),rows);
 assert.deepEqual(normalizeUtilityRows(null),[]);
});

test("builds bounded meter payloads with governed units and currency",()=>{
 const payload=buildUtilityMeterPayload({meter_code:"elec-1",name:"Main meter",utility_type:"electricity",
  reading_mode:"cumulative",unit_code:"kWh",multiplier_factor:"1.25",unit_cost:"12.5",currency_code:"bdt"});
 assert.equal(payload.meter_code,"ELEC-1");
 assert.equal(payload.utility_type,"ELECTRICITY");
 assert.equal(payload.currency_code,"BDT");
 assert.equal(payload.multiplier_factor,1.25);
 assert.throws(()=>buildUtilityMeterPayload({meter_code:"x",name:"X",utility_type:"STEAM",reading_mode:"CUMULATIVE",unit_code:"kg",currency_code:"BD"}),/three-letter/);
 assert.throws(()=>buildUtilityMeterPayload({meter_code:"x",name:"X",utility_type:"WATER",reading_mode:"UNKNOWN",unit_code:"m3"}),/reading_mode/);
 assert.throws(()=>buildUtilityMeterPayload({meter_code:"x",name:"X",utility_type:"WATER",reading_mode:"CUMULATIVE",unit_code:"m3",parent_meter_id:"nope"}),/UUID/);
});

test("constructs reading records with timestamp, source and positive production quantity",()=>{
 const payload=buildUtilityReadingPayload({reading_at:NOW,reading_value:"42.125",source_type:"manual",production_quantity:"5",notes:"shift end"});
 assert.equal(payload.reading_value,42.125);
 assert.equal(payload.source_type,"MANUAL");
 assert.equal(payload.production_quantity,5);
 assert.throws(()=>buildUtilityReadingPayload({reading_at:"bad",reading_value:1,source_type:"API"}),/valid date/);
 assert.throws(()=>buildUtilityReadingPayload({reading_at:NOW,reading_value:-1,source_type:"API"}),/numeric range/);
 assert.throws(()=>buildUtilityReadingPayload({reading_at:NOW,reading_value:1,source_type:"API",production_quantity:"0"}),/numeric range/);
});

test("builds utility events and validates severity, meter and impact bounds",()=>{
 const payload=buildUtilityEventPayload({event_type:"outage",severity:"critical",title:"Main feeder trip",description:"Supply interrupted",occurred_at:NOW,impact_minutes:"30",meter_id:ID});
 assert.equal(payload.event_type,"OUTAGE");
 assert.equal(payload.severity,"CRITICAL");
 assert.equal(payload.impact_minutes,30);
 assert.throws(()=>buildUtilityEventPayload({event_type:"unknown",severity:"LOW",title:"x",description:"x",occurred_at:NOW}),/event_type/);
 assert.throws(()=>buildUtilityEventPayload({event_type:"LEAK",severity:"LOW",title:"x",description:"x",occurred_at:NOW,meter_id:"x"}),/UUID/);
});

test("requires row version, reason and resolution before event close-out",()=>{
 assert.deepEqual(buildUtilityEventTransitionPayload({expected_version:4,action:"ACKNOWLEDGE",reason:"Operator notified"}),{
  expected_version:4,action:"ACKNOWLEDGE",reason:"Operator notified"
 });
 assert.throws(()=>buildUtilityEventTransitionPayload({expected_version:4,action:"RESOLVE",reason:"Fixed"}),/resolution/);
 assert.equal(buildUtilityEventTransitionPayload({expected_version:4,action:"RESOLVE",reason:"Fixed",resolution:"Leak sealed"}).resolution,"Leak sealed");
 assert.throws(()=>buildUtilityEventTransitionPayload({expected_version:3,action:"CANCEL",reason:""}),/reason/);
});

test("requires safe credentials references and secret-free source binding metadata",()=>{
 const payload=buildUtilitySourceBindingPayload({source_system_code:"PLC-A",source_meter_code:"EM-01",vendor_adapter:"REST_POLL",
  meter_id:ID,source_unit_code:"Wh",factor_to_meter_unit:"0.001",polling_interval_seconds:30,
  credential_reference:"vault://factory/energy",config_metadata:{site:"Line-1"}});
 assert.equal(payload.vendor_adapter,"REST_POLL");
 assert.equal(payload.factor_to_meter_unit,0.001);
 assert.throws(()=>buildUtilitySourceBindingPayload({source_system_code:"A",source_meter_code:"M",vendor_adapter:"OPC_UA",
  meter_id:ID,source_unit_code:"kWh",factor_to_meter_unit:1}),/polling interval/);
 assert.throws(()=>buildUtilitySourceBindingPayload({source_system_code:"A",source_meter_code:"M",vendor_adapter:"MQTT",
  meter_id:ID,source_unit_code:"kWh",credential_reference:"password=secret"}),/secret-manager/);
 assert.throws(()=>buildUtilitySourceBindingPayload({source_system_code:"A",source_meter_code:"M",vendor_adapter:"MQTT",
  meter_id:ID,source_unit_code:"kWh",config_metadata:{api_token:"no"}}),/secret or credential/);
});

test("validates independent source binding transitions and ingestion contracts",()=>{
 assert.equal(buildUtilitySourceBindingTransitionPayload({expected_version:2,action:"ACTIVATE",reason:"Reviewed by engineer"}).action,"ACTIVATE");
 const payload=buildUtilitySourceEventPayload({source_system_code:"PLC-A",source_meter_code:"EM-01",source_event_id:"evt-1",
  reading_at:NOW,reading_value:"100.5",source_unit_code:"Wh"});
 assert.equal(payload.source_event_id,"evt-1");
 assert.throws(()=>buildUtilitySourceEventPayload({source_system_code:"bad code",source_meter_code:"M",source_event_id:"E",reading_at:NOW,reading_value:1,source_unit_code:"kWh"}),/alphanumeric/);
});

test("threshold policies must bind a target and maintain comparable units",()=>{
 const payload=buildUtilityThresholdPolicyPayload({policy_code:"ENERGY-HI",name:"High energy",meter_id:ID,metric:"cost",
  comparison:"gt",threshold_value:"100",threshold_unit_code:"BDT",severity:"high"});
 assert.equal(payload.metric,"COST");
 assert.equal(payload.comparison,"GT");
 assert.throws(()=>buildUtilityThresholdPolicyPayload({policy_code:"X",name:"No target",metric:"COST",comparison:"GT",threshold_value:1,threshold_unit_code:"BDT",severity:"LOW"}),/select a meter/);
 assert.throws(()=>buildUtilityThresholdPolicyPayload({policy_code:"X",name:"Bad",utility_type:"WATER",metric:"BAD",comparison:"GT",threshold_value:1,threshold_unit_code:"m3",severity:"LOW"}),/metric/);
});

test("validates versioned threshold policy lifecycle",()=>{
 assert.equal(buildUtilityThresholdPolicyTransitionPayload({expected_version:7,action:"DEACTIVATE",reason:"Maintenance window"}).expected_version,7);
 assert.throws(()=>buildUtilityThresholdPolicyTransitionPayload({expected_version:0,action:"ACTIVATE",reason:"Approved"}),/integer/);
});

test("preserves decimal work-order allocation quantities as strings",()=>{
 const payload=buildUtilityWorkOrderAllocationPayload({work_order_id:ID,allocated_quantity:"12.34560000",reason:"Shift consumption"});
 assert.equal(payload.allocated_quantity,"12.34560000");
 assert.throws(()=>buildUtilityWorkOrderAllocationPayload({work_order_id:ID2,allocated_quantity:"-1",reason:"Bad"}),/positive decimal string/);
 assert.throws(()=>buildUtilityWorkOrderAllocationPayload({work_order_id:"bad",allocated_quantity:"1",reason:"Bad"}),/UUID/);
 assert.equal(buildUtilityAllocationReversePayload({reason:"Wrong work order"}).reason,"Wrong work order");
});

test("builds safe meter and event list filters",()=>{
 assert.equal(buildUtilityListQuery({limit:50,status:"open"},"events"),"?limit=50&status=OPEN");
 assert.equal(buildUtilityListQuery({limit:20,utility_type:"water",status:"active"},"meters"),"?limit=20&status=ACTIVE&utility_type=WATER");
 assert.throws(()=>buildUtilityListQuery({limit:201},"meters"),/integer/);
 assert.throws(()=>buildUtilityListQuery({status:"PAUSED"},"alerts"),/event status/);
 assert.throws(()=>buildUtilityListQuery({},"unknown"),/kind/);
});

test("summarizes only loaded energy records",()=>{
 assert.deepEqual(summarizeUtilities({
  meters:[{status:"ACTIVE"},{status:"RETIRED"}],
  events:[{status:"OPEN",severity:"CRITICAL"},{status:"RESOLVED",severity:"HIGH"}],
  policies:[{status:"ACTIVE"}],
  alerts:[{status:"ACKNOWLEDGED"}],
  readings:[{id:"r"}]
 }),{metersLoaded:2,metersActive:1,eventsOpen:1,eventsCritical:1,policiesActive:1,alertsOpen:1,readingsLoaded:1});
});
