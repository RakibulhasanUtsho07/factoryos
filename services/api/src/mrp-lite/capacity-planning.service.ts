import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateCapacityCalendarDto } from './dto/create-capacity-calendar.dto';
import { UpdateCapacityCalendarDto } from './dto/update-capacity-calendar.dto';
import { CreateCapacityPlanDto } from './dto/create-capacity-plan.dto';
import { compareCapacityScenarios, scheduleFiniteCapacity } from './capacity-scheduler';
import type { CapacityBucket, CapacityDemand, PriorCapacityOperation } from './capacity-scheduler';

interface CalendarRow extends QueryResultRow {
 id:string; tenant_id:string; factory_id:string; work_centre_id:string; capacity_date:string; shift_code:string;
 available_minutes:string; efficiency_percent:string; skill_codes:string[]; status:string; row_version:string;
 idempotency_key:string; request_hash:string; last_change_idempotency_key:string|null; last_change_request_hash:string|null;
 last_change_reason:string|null; created_by_user_id:string; updated_by_user_id:string; created_at:string; updated_at:string;
}
interface PlanRow extends QueryResultRow {
 id:string; tenant_id:string; factory_id:string; source_mrp_plan_id:string; plan_version:number; scenario_name:string;
 horizon_start:string; horizon_end:string; frozen_horizon_start:string; frozen_horizon_end:string; compare_to_plan_id:string|null;
 status:string; idempotency_key:string; request_hash:string; summary:Record<string,unknown>; conflicts:unknown[]; scenario_diff:unknown[];
 created_by_user_id:string; created_at:string;
}
interface DemandRow extends QueryResultRow {
 order_id:string; order_line_id:string; order_number:string; order_line_number:number; product_id:string; product_version_id:string;
 product_version_number:number; product_code:string; need_by_date:string; planned_quantity:string;
 material_status:'READY'|'LATE_SUPPLY'|'UNSUPPLIED'; material_ready_on:string|null;
}
interface RouteRow extends QueryResultRow {
 id:string; product_id:string; product_version_id:string; product_version_number:number; product_code:string;
 step_number:number; operation_code:string; operation_name:string; work_centre_id:string; required_skill:string|null;
 setup_minutes:string; run_minutes_per_unit:string; queue_minutes:string; transfer_minutes:string;
}
interface PriorRow extends QueryResultRow {
 order_line_id:string; product_version_id:string; step_number:number; work_centre_id:string; required_minutes:number;
 scheduled_start_date:string|null; scheduled_finish_date:string|null; schedule_segments:unknown[]; capacity_status:string;
}
const CALENDAR_COLUMNS=`id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,work_centre_id::text AS work_centre_id,
 capacity_date::text AS capacity_date,shift_code,available_minutes::text AS available_minutes,efficiency_percent::text AS efficiency_percent,
 skill_codes,status,row_version::text AS row_version,idempotency_key,request_hash,last_change_idempotency_key,last_change_request_hash,
 last_change_reason,created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,
 created_at::text AS created_at,updated_at::text AS updated_at`;
const PLAN_COLUMNS=`id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,source_mrp_plan_id::text AS source_mrp_plan_id,
 plan_version,scenario_name,horizon_start::text AS horizon_start,horizon_end::text AS horizon_end,
 frozen_horizon_start::text AS frozen_horizon_start,frozen_horizon_end::text AS frozen_horizon_end,compare_to_plan_id::text AS compare_to_plan_id,
 status,idempotency_key,request_hash,summary,conflicts,scenario_diff,created_by_user_id::text AS created_by_user_id,created_at::text AS created_at`;

@Injectable()
export class CapacityPlanningService {
 constructor(private readonly database:DatabaseService,private readonly audit:AuditService) {}

 async createCalendar(userId:string,tenantId:string,factoryId:string,dto:CreateCapacityCalendarDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
  this.scope(userId,tenantId,factoryId);
  const key=this.key(keyRaw),wc=this.uuid(dto.work_centre_id,'work_centre_id'),date=this.date(dto.capacity_date);
  const shift=this.text(dto.shift_code,'shift_code',80),minutes=this.decimal(dto.available_minutes,'available_minutes',4,0,10080);
  const efficiency=this.decimal(dto.efficiency_percent??100,'efficiency_percent',3,.001,150),skills=this.skills(dto.skill_codes??[]);
  const hash=this.hash({work_centre_id:wc,capacity_date:date,shift_code:shift,available_minutes:minutes,efficiency_percent:efficiency,skill_codes:skills});
  const correlation=this.correlation(requestId,traceId);
  const result=await this.database.transaction({tenantId,userId,requestId,traceId,advisoryLockKey:'mrp-capacity-calendar:'+tenantId+':'+factoryId+':'+key},async client=>{
   const old=await client.query<CalendarRow>('SELECT '+CALENDAR_COLUMNS+' FROM mrp_work_centre_capacity_calendar WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[tenantId,factoryId,key]);
   if(old.rows[0]){if(old.rows[0].request_hash!==hash)throw new ConflictException('Idempotency-Key was used for a different capacity calendar entry');return {id:old.rows[0].id,replayed:true};}
   const centre=await client.query<{status:string}>('SELECT status FROM manufacturing_work_centres WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR KEY SHARE',[wc,tenantId,factoryId]);
   if(!centre.rows[0]||centre.rows[0].status!=='ACTIVE')throw new NotFoundException('Active work centre was not found in this factory');
   const same=await client.query<{id:string}>(`SELECT id::text AS id FROM mrp_work_centre_capacity_calendar
     WHERE tenant_id=$1 AND factory_id=$2 AND work_centre_id=$3 AND capacity_date=$4::date AND shift_code=$5 FOR UPDATE`,[tenantId,factoryId,wc,date,shift]);
   if(same.rows[0])throw new ConflictException('A calendar slot already exists; update it with expected_version');
   const inserted=await client.query<{id:string}>(`INSERT INTO mrp_work_centre_capacity_calendar(
     tenant_id,factory_id,work_centre_id,capacity_date,shift_code,available_minutes,efficiency_percent,skill_codes,status,row_version,
     idempotency_key,request_hash,created_by_user_id,updated_by_user_id)
     VALUES($1,$2,$3,$4::date,$5,$6::numeric,$7::numeric,$8::text[],'ACTIVE',1,$9,$10,$11,$11) RETURNING id::text AS id`,
     [tenantId,factoryId,wc,date,shift,minutes,efficiency,skills,key,hash,userId]);
   const id=inserted.rows[0]?.id;if(!id)throw new Error('MRP_CAPACITY_CALENDAR_INSERT_FAILED');
   await this.outbox(client,{tenantId,factoryId,id,event:'MRP.CAPACITY_CALENDAR_CREATED',aggregateType:'MRP_CAPACITY_CALENDAR',correlation,requestId,userId,
    payload:{work_centre_id:wc,capacity_date:date,shift_code:shift,available_minutes:minutes,efficiency_percent:efficiency,skill_codes:skills}});
   return {id,replayed:false};
  });
  if(!result.replayed)await this.auditSafe({tenantId,factoryId,userId,action:'MRP_CAPACITY_CALENDAR_CREATED',id:result.id,requestId,traceId,payload:{workCentreId:wc,capacityDate:date,shiftCode:shift}});
  return this.getCalendar(userId,tenantId,factoryId,result.id);
 }

 async updateCalendar(userId:string,tenantId:string,factoryId:string,calendarId:string,dto:UpdateCapacityCalendarDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
  this.scope(userId,tenantId,factoryId);const id=this.uuid(calendarId,'calendarId'),key=this.key(keyRaw);
  if(!Number.isInteger(dto.expected_version)||dto.expected_version<1)throw new BadRequestException('expected_version must be a positive integer');
  const minutes=this.decimal(dto.available_minutes,'available_minutes',4,0,10080),efficiency=this.decimal(dto.efficiency_percent,'efficiency_percent',3,.001,150);
  const skills=this.skills(dto.skill_codes),reason=this.text(dto.change_reason,'change_reason',2000);
  const hash=this.hash({calendar_id:id,expected_version:dto.expected_version,available_minutes:minutes,efficiency_percent:efficiency,skill_codes:skills,change_reason:reason});
  const correlation=this.correlation(requestId,traceId);
  const result=await this.database.transaction({tenantId,userId,requestId,traceId},async client=>{
   const q=await client.query<CalendarRow>('SELECT '+CALENDAR_COLUMNS+' FROM mrp_work_centre_capacity_calendar WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[id,tenantId,factoryId]);
   const row=q.rows[0];if(!row)throw new NotFoundException('Capacity calendar entry was not found in this factory');
   if(row.last_change_idempotency_key===key){if(row.last_change_request_hash!==hash)throw new ConflictException('Idempotency-Key was used for a different calendar update');return {row,replayed:true};}
   if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Capacity calendar row version is stale');
   const changed=await client.query<CalendarRow>(`UPDATE mrp_work_centre_capacity_calendar
    SET available_minutes=$1::numeric,efficiency_percent=$2::numeric,skill_codes=$3::text[],row_version=row_version+1,
        updated_by_user_id=$4,updated_at=clock_timestamp(),last_change_idempotency_key=$5,last_change_request_hash=$6,last_change_reason=$7
    WHERE id=$8 AND tenant_id=$9 AND factory_id=$10 AND row_version=$11 RETURNING `+CALENDAR_COLUMNS+``,
    [minutes,efficiency,skills,userId,key,hash,reason,id,tenantId,factoryId,dto.expected_version]);
   if(!changed.rows[0])throw new ConflictException('Capacity calendar entry changed concurrently');
   await this.outbox(client,{tenantId,factoryId,id,event:'MRP.CAPACITY_CALENDAR_UPDATED',aggregateType:'MRP_CAPACITY_CALENDAR',correlation,requestId,userId,
    payload:{row_version:changed.rows[0].row_version,change_reason:reason}});
   return {row:changed.rows[0],replayed:false};
  });
  if(!result.replayed)await this.auditSafe({tenantId,factoryId,userId,action:'MRP_CAPACITY_CALENDAR_UPDATED',id,requestId,traceId,payload:{rowVersion:result.row.row_version,changeReason:reason}});
  return result.row;
 }

 async listCalendars(userId:string,tenantId:string,factoryId:string,startRaw?:string,endRaw?:string) {
  this.scope(userId,tenantId,factoryId);const start=startRaw?this.date(startRaw):'0001-01-01',end=endRaw?this.date(endRaw):'9999-12-31';
  if(end<start)throw new BadRequestException('end must be on or after start');
  return (await this.database.query<CalendarRow>('SELECT '+CALENDAR_COLUMNS+' FROM mrp_work_centre_capacity_calendar WHERE tenant_id=$1 AND factory_id=$2 AND capacity_date BETWEEN $3::date AND $4::date ORDER BY capacity_date,shift_code,work_centre_id,id',
    [tenantId,factoryId,start,end],{tenantId,userId})).rows;
 }
 async getCalendar(userId:string,tenantId:string,factoryId:string,calendarId:string) {
  this.scope(userId,tenantId,factoryId);this.uuid(calendarId,'calendarId');
  const q=await this.database.query<CalendarRow>('SELECT '+CALENDAR_COLUMNS+' FROM mrp_work_centre_capacity_calendar WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
   [calendarId,tenantId,factoryId],{tenantId,userId});
  if(!q.rows[0])throw new NotFoundException('Capacity calendar entry was not found in this factory');return q.rows[0];
 }

 async createPlan(userId:string,tenantId:string,factoryId:string,dto:CreateCapacityPlanDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
  this.scope(userId,tenantId,factoryId);const key=this.key(keyRaw),sourceId=this.uuid(dto.source_mrp_plan_id,'source_mrp_plan_id');
  const start=this.date(dto.horizon_start),end=this.date(dto.horizon_end),frozenStart=this.date(dto.frozen_horizon_start),frozenEnd=this.date(dto.frozen_horizon_end);
  const scenario=this.text(dto.scenario_name,'scenario_name',120),compareId=dto.compare_to_plan_id?this.uuid(dto.compare_to_plan_id,'compare_to_plan_id'):null;
  if(end<start||this.days(start,end)>365)throw new BadRequestException('Planning horizon must be ordered and no more than 366 days');
  if(frozenStart<start||frozenEnd<frozenStart||frozenEnd>end)throw new BadRequestException('Frozen horizon must sit inside the planning horizon');
  const requestHash=this.hash({source_mrp_plan_id:sourceId,scenario_name:scenario,horizon_start:start,horizon_end:end,
    frozen_horizon_start:frozenStart,frozen_horizon_end:frozenEnd,compare_to_plan_id:compareId});
  const correlation=this.correlation(requestId,traceId);
  const created=await this.database.transaction({tenantId,userId,requestId,traceId,isolationLevel:'REPEATABLE READ',
    advisoryLockKey:'mrp-capacity-plan:'+tenantId+':'+factoryId+':'+sourceId},async client=>{
   const seen=await client.query<PlanRow>('SELECT '+PLAN_COLUMNS+' FROM mrp_capacity_plans WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[tenantId,factoryId,key]);
   if(seen.rows[0]){if(seen.rows[0].request_hash!==requestHash)throw new ConflictException('Idempotency-Key was used for a different capacity-plan request');return {id:seen.rows[0].id,replayed:true};}
   const source=await client.query<{horizon_start:string;horizon_end:string}>('SELECT horizon_start::text AS horizon_start,horizon_end::text AS horizon_end FROM mrp_plans WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR KEY SHARE',[sourceId,tenantId,factoryId]);
   if(!source.rows[0])throw new NotFoundException('Source MRP-lite plan was not found in this factory');
   if(start<source.rows[0].horizon_start||end>source.rows[0].horizon_end)throw new BadRequestException('Capacity horizon must be within its source MRP-lite horizon');
   let priorOps:PriorCapacityOperation[]=[];
   if(compareId){
    const p=await client.query<{id:string;source_mrp_plan_id:string}>('SELECT id::text AS id,source_mrp_plan_id::text AS source_mrp_plan_id FROM mrp_capacity_plans WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR KEY SHARE',[compareId,tenantId,factoryId]);
    if(!p.rows[0])throw new NotFoundException('Comparison capacity plan was not found in this factory');
    if(p.rows[0].source_mrp_plan_id!==sourceId)throw new ConflictException('Scenario comparison must use the same source MRP-lite plan');
    const old=await client.query<PriorRow>(`SELECT order_line_id::text AS order_line_id,product_version_id::text AS product_version_id,step_number,
      work_centre_id::text AS work_centre_id,required_minutes::float8 AS required_minutes,scheduled_start_date::text AS scheduled_start_date,
      scheduled_finish_date::text AS scheduled_finish_date,schedule_segments,capacity_status
      FROM mrp_capacity_plan_operations WHERE plan_id=$1 AND tenant_id=$2 AND factory_id=$3`,[compareId,tenantId,factoryId]);
    priorOps=old.rows.map(x=>({...x,required_minutes:Number(x.required_minutes),schedule_segments:Array.isArray(x.schedule_segments)?x.schedule_segments as never:[]}));
   }
   const demandRows=await client.query<DemandRow>(`SELECT r.order_id::text AS order_id,r.order_line_id::text AS order_line_id,r.order_number,r.order_line_number,
      r.product_id::text AS product_id,r.product_version_id::text AS product_version_id,MAX(r.product_version_number)::int AS product_version_number,
      MAX(r.product_code) AS product_code,MIN(r.need_by_date)::text AS need_by_date,MAX(r.remaining_finished_quantity)::text AS planned_quantity,
      CASE WHEN BOOL_OR(r.shortage_quantity>0 AND r.allocation_status='UNSUPPLIED') THEN 'UNSUPPLIED'
        WHEN BOOL_OR(r.shortage_quantity>0 AND r.allocation_status='LATE_SUPPLY') THEN 'LATE_SUPPLY' ELSE 'READY' END AS material_status,
      MIN(COALESCE(r.projected_available_date,r.shortage_date)) FILTER(WHERE r.shortage_quantity>0)::text AS material_ready_on
      FROM mrp_plan_requirements r WHERE r.plan_id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 AND r.need_by_date BETWEEN $4::date AND $5::date
      GROUP BY r.order_id,r.order_line_id,r.order_number,r.order_line_number,r.product_id,r.product_version_id
      ORDER BY MIN(r.need_by_date),r.order_number,r.order_line_number`,[sourceId,tenantId,factoryId,start,end]);
   const versions=[...new Set(demandRows.rows.map(x=>x.product_version_id))];
   const routes=versions.length?await client.query<RouteRow>(`SELECT r.product_id::text AS product_id,r.product_version_id::text AS product_version_id,
      pv.version_number AS product_version_number,p.product_code,r.id::text AS id,r.step_number,r.operation_code,r.operation_name,
      r.work_centre_id::text AS work_centre_id,r.required_skill,r.setup_minutes::text AS setup_minutes,r.run_minutes_per_unit::text AS run_minutes_per_unit,
      r.queue_minutes::text AS queue_minutes,r.transfer_minutes::text AS transfer_minutes
      FROM product_routing_steps r JOIN product_versions pv ON pv.id=r.product_version_id AND pv.tenant_id=r.tenant_id AND pv.factory_id=r.factory_id
      JOIN product_definitions p ON p.id=r.product_id AND p.tenant_id=r.tenant_id AND p.factory_id=r.factory_id
      JOIN manufacturing_work_centres wc ON wc.id=r.work_centre_id AND wc.tenant_id=r.tenant_id AND wc.factory_id=r.factory_id
      WHERE r.tenant_id=$1 AND r.factory_id=$2 AND r.product_version_id=ANY($3::uuid[]) AND wc.status='ACTIVE'
      ORDER BY r.product_version_id,r.step_number`,[tenantId,factoryId,versions]):{rows:[] as RouteRow[]};
   const demand:CapacityDemand[]=[],exceptions:Array<Record<string,unknown>>=[];
   for(const d of demandRows.rows){
    const routings=routes.rows.filter(x=>x.product_version_id===d.product_version_id);
    if(!routings.length){exceptions.push({code:'NO_ROUTING',order_line_id:d.order_line_id,product_version_id:d.product_version_id});continue;}
    for(const route of routings){
     const n=(v:string)=>Number(v);
     demand.push({order_id:d.order_id,order_line_id:d.order_line_id,order_number:d.order_number,order_line_number:d.order_line_number,
      product_id:d.product_id,product_version_id:d.product_version_id,product_version_number:d.product_version_number,product_code:d.product_code,
      need_by_date:d.need_by_date,planned_quantity:n(d.planned_quantity),material_status:d.material_status,material_ready_on:d.material_ready_on,
      route_step_id:route.id,step_number:route.step_number,operation_code:route.operation_code,operation_name:route.operation_name,
      work_centre_id:route.work_centre_id,required_skill:route.required_skill,setup_minutes:n(route.setup_minutes),sam_smv_minutes_per_unit:n(route.run_minutes_per_unit),
      queue_minutes:n(route.queue_minutes),transfer_minutes:n(route.transfer_minutes)});
    }
   }
   const cal=await client.query<CalendarRow>('SELECT '+CALENDAR_COLUMNS+' FROM mrp_work_centre_capacity_calendar WHERE tenant_id=$1 AND factory_id=$2 AND status=$3 AND capacity_date BETWEEN $4::date AND $5::date ORDER BY capacity_date,shift_code,work_centre_id',
    [tenantId,factoryId,'ACTIVE',start,end]);
   const buckets:CapacityBucket[]=cal.rows.map(c=>({id:c.id,work_centre_id:c.work_centre_id,capacity_date:c.capacity_date,shift_code:c.shift_code,
    available_minutes:Number(c.available_minutes),efficiency_percent:Number(c.efficiency_percent),skill_codes:c.skill_codes??[]}));
   const scheduled=scheduleFiniteCapacity(demand,buckets,start,end,frozenStart,frozenEnd,priorOps);
   const diff=compareId?compareCapacityScenarios(scheduled,priorOps):[];
   const materialBlocked=scheduled.filter(x=>x.capacity_status==='MATERIAL_BLOCKED').length;
   const capacityConflict=scheduled.filter(x=>x.capacity_status==='CAPACITY_CONFLICT'||x.capacity_status==='FROZEN_HORIZON_CONFLICT').length;
   const late=scheduled.filter(x=>x.capacity_status==='LATE_SCHEDULE').length;
   const status=materialBlocked?'MATERIAL_BLOCKED':capacityConflict?'CAPACITY_CONFLICTS':'CALCULATED';
   const v=await client.query<{next_version:number}>('SELECT COALESCE(MAX(plan_version),0)+1 AS next_version FROM mrp_capacity_plans WHERE tenant_id=$1 AND factory_id=$2 AND source_mrp_plan_id=$3',[tenantId,factoryId,sourceId]);
   const planVersion=v.rows[0]?.next_version??1;
   const summary={operation_count:scheduled.length,scheduled_count:scheduled.filter(x=>x.capacity_status==='SCHEDULED').length,late_schedule_count:late,
    capacity_conflict_count:capacityConflict,material_blocked_count:materialBlocked,unscheduled_minutes:scheduled.reduce((sum,x)=>sum+x.unscheduled_minutes,0),
    exception_count:exceptions.length,scenario_comparison_count:diff.length,source_mrp_plan_id:sourceId,compare_to_plan_id:compareId};
   const inserted=await client.query<{id:string}>(`INSERT INTO mrp_capacity_plans(
    tenant_id,factory_id,source_mrp_plan_id,plan_version,scenario_name,horizon_start,horizon_end,frozen_horizon_start,frozen_horizon_end,
    compare_to_plan_id,status,idempotency_key,request_hash,request_id,trace_id,correlation_id,summary,conflicts,scenario_diff,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6::date,$7::date,$8::date,$9::date,$10,$11,$12,$13,$14::uuid,$15::uuid,$16::uuid,$17::jsonb,$18::jsonb,$19::jsonb,$20)
    RETURNING id::text AS id`,[tenantId,factoryId,sourceId,planVersion,scenario,start,end,frozenStart,frozenEnd,compareId,status,key,requestHash,
      isUUID(requestId??'')?requestId:null,isUUID(traceId??'')?traceId:null,correlation,JSON.stringify(summary),JSON.stringify(exceptions),JSON.stringify(diff),userId]);
   const planId=inserted.rows[0]?.id;if(!planId)throw new Error('MRP_CAPACITY_PLAN_INSERT_FAILED');
   for(const row of scheduled){
    await client.query(`INSERT INTO mrp_capacity_plan_operations(
      tenant_id,factory_id,plan_id,order_id,order_line_id,product_id,product_version_id,product_routing_step_id,work_centre_id,
      order_number,order_line_number,product_code,product_version_number,need_by_date,step_number,operation_code,operation_name,required_skill,
      planned_quantity,setup_minutes,sam_smv_minutes_per_unit,queue_minutes,transfer_minutes,required_minutes,scheduled_minutes,unscheduled_minutes,
      material_ready_on,material_status,capacity_status,scheduled_start_date,scheduled_finish_date,schedule_segments,conflict_codes,
      frozen_horizon_protected,frozen_revision_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::date,$28,$29,$30::date,$31::date,$32::jsonb,$33::jsonb,$34,$35::jsonb)`,
      [tenantId,factoryId,planId,row.order_id,row.order_line_id,row.product_id,row.product_version_id,row.route_step_id,row.work_centre_id,row.order_number,
       row.order_line_number,row.product_code,row.product_version_number,row.need_by_date,row.step_number,row.operation_code,row.operation_name,row.required_skill,
       row.planned_quantity,row.setup_minutes,row.sam_smv_minutes_per_unit,row.queue_minutes,row.transfer_minutes,row.required_minutes,row.scheduled_minutes,row.unscheduled_minutes,
       row.material_ready_on,row.material_status,row.capacity_status,row.scheduled_start_date,row.scheduled_finish_date,JSON.stringify(row.schedule_segments),JSON.stringify(row.conflict_codes),
       row.frozen_horizon_protected,JSON.stringify(row.frozen_revision_snapshot)]);
   }
   await this.outbox(client,{tenantId,factoryId,id:planId,event:'MRP.CAPACITY_PLAN_CALCULATED',aggregateType:'MRP_CAPACITY_PLAN',correlation,requestId,userId,
    payload:{source_mrp_plan_id:sourceId,plan_version:planVersion,status,summary}});
   return {id:planId,replayed:false};
  });
  if(!created.replayed)await this.auditSafe({tenantId,factoryId,userId,action:'MRP_CAPACITY_PLAN_CALCULATED',id:created.id,requestId,traceId,
    payload:{sourceMrpPlanId:sourceId,horizonStart:start,horizonEnd:end,compareToPlanId:compareId}});
  return this.getPlan(userId,tenantId,factoryId,created.id);
 }

 async listPlans(userId:string,tenantId:string,factoryId:string,sourceMrpPlanId?:string,limit=50){
  this.scope(userId,tenantId,factoryId);if(!Number.isInteger(limit)||limit<1||limit>100)throw new BadRequestException('limit must be between 1 and 100');
  const source=sourceMrpPlanId?this.uuid(sourceMrpPlanId,'source_mrp_plan_id'):null;
  return (await this.database.query<PlanRow>('SELECT '+PLAN_COLUMNS+' FROM mrp_capacity_plans WHERE tenant_id=$1 AND factory_id=$2 AND ($3::uuid IS NULL OR source_mrp_plan_id=$3) ORDER BY created_at DESC,id DESC LIMIT $4',
    [tenantId,factoryId,source,limit],{tenantId,userId})).rows;
 }
 async getPlan(userId:string,tenantId:string,factoryId:string,planId:string){
  this.scope(userId,tenantId,factoryId);this.uuid(planId,'planId');
  const q=await this.database.query<PlanRow>('SELECT '+PLAN_COLUMNS+' FROM mrp_capacity_plans WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',[planId,tenantId,factoryId],{tenantId,userId});
  if(!q.rows[0])throw new NotFoundException('Finite-capacity plan was not found in this factory');
  const ops=await this.database.query(`SELECT id::text AS id,order_id::text AS order_id,order_line_id::text AS order_line_id,
   product_id::text AS product_id,product_version_id::text AS product_version_id,product_routing_step_id::text AS product_routing_step_id,
   work_centre_id::text AS work_centre_id,order_number,order_line_number,product_code,product_version_number,need_by_date::text AS need_by_date,
   step_number,operation_code,operation_name,required_skill,planned_quantity::text AS planned_quantity,setup_minutes::text AS setup_minutes,
   sam_smv_minutes_per_unit::text AS sam_smv_minutes_per_unit,queue_minutes::text AS queue_minutes,transfer_minutes::text AS transfer_minutes,
   required_minutes::text AS required_minutes,scheduled_minutes::text AS scheduled_minutes,unscheduled_minutes::text AS unscheduled_minutes,
   material_ready_on::text AS material_ready_on,material_status,capacity_status,scheduled_start_date::text AS scheduled_start_date,
   scheduled_finish_date::text AS scheduled_finish_date,schedule_segments,conflict_codes,frozen_horizon_protected,frozen_revision_snapshot
   FROM mrp_capacity_plan_operations WHERE plan_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY need_by_date,order_number,order_line_number,step_number`,
    [planId,tenantId,factoryId],{tenantId,userId});
  return {...q.rows[0],operations:ops.rows};
 }

 private async outbox(client:PoolClient,i:{tenantId:string;factoryId:string;id:string;event:string;aggregateType:string;correlation:string;requestId:string|null;userId:string;payload:Record<string,unknown>}){
  await client.query('INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,correlation_id,causation_id,actor,source,payload) VALUES($1,$2,$3,$4,$5,1,clock_timestamp(),$6::uuid,$7::uuid,$8::jsonb,$9::jsonb,$10::jsonb)',
   [i.tenantId,i.factoryId,i.aggregateType,i.id,i.event,i.correlation,isUUID(i.requestId??'')?i.requestId:null,JSON.stringify({type:'user',id:i.userId}),
    JSON.stringify({system:'FactoryOS',connector:'finite-capacity-planning',version:process.env.APP_VERSION??'0.1.0'}),JSON.stringify(i.payload)]);
 }
 private async auditSafe(i:{tenantId:string;factoryId:string;userId:string;action:string;id:string;requestId:string|null;traceId:string|null;payload:Record<string,unknown>}){
  try{await this.audit.record({tenantId:i.tenantId,factoryId:i.factoryId,actorUserId:i.userId,eventType:'MRP_CAPACITY',action:i.action,resourceType:'MRP_CAPACITY_PLAN',resourceId:i.id,
   requestId:isUUID(i.requestId??'')?i.requestId:null,correlationId:isUUID(i.traceId??'')?i.traceId:null,dataClass:'INTERNAL',payload:i.payload});}catch{/* outbox contains durable evidence */}
 }
 private key(value:string|null){const k=value?.trim()??'';if(!k)throw new BadRequestException('Idempotency-Key header is required');if(k.length>255)throw new BadRequestException('Idempotency-Key must not exceed 255 characters');return k;}
 private uuid(value:string,field:string){if(!isUUID(value))throw new BadRequestException(field+' must be a UUID');return value.toLowerCase();}
 private scope(user:string,tenant:string,factory:string){this.uuid(user,'userId');this.uuid(tenant,'tenantId');this.uuid(factory,'factoryId');}
 private text(value:string,field:string,max:number){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new BadRequestException(field+' must contain 1 to '+max+' characters');return value.trim();}
 private date(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new BadRequestException('Date must use YYYY-MM-DD');const d=new Date(value+'T00:00:00.000Z');if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value)throw new BadRequestException('Date must be valid');return value;}
 private days(a:string,b:string){return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);}
 private decimal(v:number,field:string,scale:number,min:number,max:number){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new BadRequestException(field+' is outside the allowed range');if(Math.abs(v*10**scale-Math.round(v*10**scale))>1e-6)throw new BadRequestException(field+' has too many decimal places');return v.toFixed(scale);}
 private skills(input:string[]){if(!Array.isArray(input)||input.some(x=>typeof x!=='string'||!x.trim()||x.trim().length>120)||new Set(input.map(x=>x.trim().toLowerCase())).size!==input.length)throw new BadRequestException('skill_codes must contain unique non-empty skill names');return input.map(x=>x.trim()).sort((a,b)=>a.localeCompare(b));}
 private correlation(requestId:string|null,traceId:string|null){return traceId&&isUUID(traceId)?traceId:requestId&&isUUID(requestId)?requestId:randomUUID();}
 private hash(v:Record<string,unknown>){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
}
