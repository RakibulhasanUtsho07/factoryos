export interface CapacityBucket {
  id:string; work_centre_id:string; capacity_date:string; shift_code:string;
  available_minutes:number; efficiency_percent:number; skill_codes:string[];
}
export interface CapacityDemand {
  order_id:string; order_line_id:string; order_number:string; order_line_number:number;
  product_id:string; product_version_id:string; product_version_number:number; product_code:string;
  need_by_date:string; planned_quantity:number; material_status:'READY'|'LATE_SUPPLY'|'UNSUPPLIED';
  material_ready_on:string|null; route_step_id:string; step_number:number; operation_code:string; operation_name:string;
  work_centre_id:string; required_skill:string|null; setup_minutes:number; sam_smv_minutes_per_unit:number;
  queue_minutes:number; transfer_minutes:number;
  alternate_material_scenarios?:unknown[];
}
export interface CapacitySegment {
  calendar_id:string; work_centre_id:string; capacity_date:string; shift_code:string; minutes:number;
}
export interface PriorCapacityOperation {
  order_line_id:string; product_version_id:string; step_number:number; work_centre_id:string;
  required_minutes:number; scheduled_start_date:string|null; scheduled_finish_date:string|null;
  schedule_segments:CapacitySegment[]; capacity_status:string;
}
export interface ScheduledCapacityOperation extends CapacityDemand {
  required_minutes:number; scheduled_minutes:number; unscheduled_minutes:number;
  scheduled_start_date:string|null; scheduled_finish_date:string|null; schedule_segments:CapacitySegment[];
  capacity_status:'SCHEDULED'|'LATE_SCHEDULE'|'CAPACITY_CONFLICT'|'MATERIAL_BLOCKED'|'FROZEN_HORIZON_CONFLICT';
  conflict_codes:string[]; frozen_horizon_protected:boolean; frozen_revision_snapshot:Record<string,unknown>;
}
const round4=(n:number)=>Math.ceil((n-1e-10)*10000)/10000;
const opKey=(line:string,step:number)=>line+':'+step;
const bKey=(wc:string,date:string,shift:string)=>wc+'|'+date+'|'+shift;

export function scheduleFiniteCapacity(demand:CapacityDemand[],calendars:CapacityBucket[],horizonStart:string,horizonEnd:string,
  frozenHorizonStart:string,frozenHorizonEnd:string,prior:PriorCapacityOperation[]=[]):ScheduledCapacityOperation[] {
  const slots=calendars.filter(c=>c.capacity_date>=horizonStart&&c.capacity_date<=horizonEnd&&c.available_minutes>=0)
    .slice().sort((a,b)=>a.capacity_date.localeCompare(b.capacity_date)||a.shift_code.localeCompare(b.shift_code)||a.work_centre_id.localeCompare(b.work_centre_id));
  const free=new Map<string,number>();
  const byBucket=new Map<string,CapacityBucket[]>();
  for(const c of slots){free.set(c.id,round4(c.available_minutes*c.efficiency_percent/100));const k=bKey(c.work_centre_id,c.capacity_date,c.shift_code);byBucket.set(k,[...(byBucket.get(k)??[]),c]);}
  const priorMap=new Map(prior.map(p=>[opKey(p.order_line_id,p.step_number),p]));
  const sorted=demand.slice().sort((a,b)=>a.need_by_date.localeCompare(b.need_by_date)||a.order_number.localeCompare(b.order_number)
    ||a.order_line_number-b.order_line_number||a.step_number-b.step_number);
  const previousFinish=new Map<string,string>();
  const output:ScheduledCapacityOperation[]=[];
  for(const op of sorted){
    const required=round4(op.setup_minutes+op.sam_smv_minutes_per_unit*op.planned_quantity+op.queue_minutes+op.transfer_minutes);
    const conflicts:string[]=[]; const segments:CapacitySegment[]=[];
    let scheduled=0,start:string|null=null,finish:string|null=null,frozen=false;
    let earliest=op.material_ready_on&&op.material_ready_on>horizonStart?op.material_ready_on:horizonStart;
    const pred=previousFinish.get(op.order_line_id);if(pred&&pred>earliest)earliest=pred;
    if(op.material_status==='UNSUPPLIED'){
      output.push({...op,required_minutes:required,scheduled_minutes:0,unscheduled_minutes:required,scheduled_start_date:null,scheduled_finish_date:null,
        schedule_segments:[],capacity_status:'MATERIAL_BLOCKED',conflict_codes:['MATERIAL_UNSUPPLIED'],frozen_horizon_protected:false,frozen_revision_snapshot:{}});
      previousFinish.set(op.order_line_id,horizonEnd);continue;
    }
    const old=priorMap.get(opKey(op.order_line_id,op.step_number));
    if(old?.scheduled_start_date&&old.scheduled_start_date<=frozenHorizonEnd){
      const saved=(old.schedule_segments??[]).filter(s=>s.capacity_date>=frozenHorizonStart&&s.capacity_date<=frozenHorizonEnd);
      if(saved.length){
        frozen=true;
        for(const seg of saved){
          segments.push({...seg});scheduled=round4(scheduled+seg.minutes);
          const slot=(byBucket.get(bKey(seg.work_centre_id,seg.capacity_date,seg.shift_code))??[]).find(x=>x.id===seg.calendar_id);
          if(slot){const amount=free.get(slot.id)??0;if(seg.minutes>amount+0.0001)conflicts.push('FROZEN_CAPACITY_OVERBOOKED');free.set(slot.id,round4(Math.max(0,amount-seg.minutes)));}
          else conflicts.push('FROZEN_CALENDAR_SLOT_MISSING');
        }
        start=saved[0].capacity_date;finish=saved[saved.length-1].capacity_date;
        if(old.product_version_id!==op.product_version_id||old.work_centre_id!==op.work_centre_id) conflicts.push('FROZEN_REVISION_OR_WORK_CENTRE_CHANGED');
        if(Math.abs(old.required_minutes-required)>0.0001) conflicts.push('FROZEN_REQUIREMENT_CHANGED');
        if(scheduled>=required-0.0001){
          const status=conflicts.length?'FROZEN_HORIZON_CONFLICT':(finish!>op.need_by_date?'LATE_SCHEDULE':'SCHEDULED');
          output.push({...op,required_minutes:required,scheduled_minutes:scheduled,unscheduled_minutes:0,scheduled_start_date:start,scheduled_finish_date:finish,
            schedule_segments:segments,capacity_status:status,conflict_codes:[...new Set(conflicts)],frozen_horizon_protected:true,
            frozen_revision_snapshot:{product_version_id:old.product_version_id,work_centre_id:old.work_centre_id,required_minutes:old.required_minutes,segments:saved}});
          previousFinish.set(op.order_line_id,finish!);continue;
        }
        earliest=finish&&finish>earliest?finish:earliest;
      }
    }
    const requiredSkill=op.required_skill;
    const readySlots=slots.filter(c=>c.work_centre_id===op.work_centre_id&&c.capacity_date>=earliest
      &&(!requiredSkill||c.skill_codes.includes(requiredSkill)));
    const skillCovered=!requiredSkill||slots.some(c=>c.work_centre_id===op.work_centre_id&&c.capacity_date>=earliest&&c.capacity_date<=horizonEnd&&c.skill_codes.includes(requiredSkill));
    let left=round4(Math.max(0,required-scheduled));
    for(const slot of readySlots){
      if(left<=0.0001)break;
      const capacity=free.get(slot.id)??0;if(capacity<=0.0001)continue;
      const take=round4(Math.min(left,capacity));if(take<=0)continue;
      segments.push({calendar_id:slot.id,work_centre_id:slot.work_centre_id,capacity_date:slot.capacity_date,shift_code:slot.shift_code,minutes:take});
      scheduled=round4(scheduled+take);left=round4(Math.max(0,left-take));free.set(slot.id,round4(capacity-take));
      if(start===null)start=slot.capacity_date;finish=slot.capacity_date;
    }
    if(left>0.0001)conflicts.push(skillCovered?'INSUFFICIENT_FINITE_CAPACITY':'NO_SKILL_CAPACITY');
    const status:ScheduledCapacityOperation['capacity_status']=conflicts.some(c=>c.startsWith('FROZEN_'))?'FROZEN_HORIZON_CONFLICT'
      :left>0.0001?'CAPACITY_CONFLICT':finish&&finish>op.need_by_date?'LATE_SCHEDULE':'SCHEDULED';
    output.push({...op,required_minutes:required,scheduled_minutes:scheduled,unscheduled_minutes:left,scheduled_start_date:start,scheduled_finish_date:finish,
      schedule_segments:segments,capacity_status:status,conflict_codes:[...new Set(conflicts)],frozen_horizon_protected:frozen,
      frozen_revision_snapshot:frozen&&old?{product_version_id:old.product_version_id,work_centre_id:old.work_centre_id,required_minutes:old.required_minutes}:{}});
    previousFinish.set(op.order_line_id,finish??horizonEnd);
  }
  return output;
}

export function compareCapacityScenarios(current:ScheduledCapacityOperation[],prior:PriorCapacityOperation[]):Array<Record<string,unknown>> {
  const old=new Map(prior.map(p=>[opKey(p.order_line_id,p.step_number),p]));
  const seen=new Set<string>();const diff:Array<Record<string,unknown>>=[];
  for(const row of current){
    const key=opKey(row.order_line_id,row.step_number);seen.add(key);const before=old.get(key);
    if(!before){diff.push({order_line_id:row.order_line_id,step_number:row.step_number,change:'ADDED',new_start:row.scheduled_start_date,new_finish:row.scheduled_finish_date,new_status:row.capacity_status});continue;}
    if(before.product_version_id!==row.product_version_id||before.work_centre_id!==row.work_centre_id
      ||before.scheduled_start_date!==row.scheduled_start_date||before.scheduled_finish_date!==row.scheduled_finish_date
      ||Math.abs(before.required_minutes-row.required_minutes)>0.0001||before.capacity_status!==row.capacity_status){
      diff.push({order_line_id:row.order_line_id,step_number:row.step_number,change:'CHANGED',old_version_id:before.product_version_id,new_version_id:row.product_version_id,
        old_work_centre_id:before.work_centre_id,new_work_centre_id:row.work_centre_id,old_start:before.scheduled_start_date,new_start:row.scheduled_start_date,
        old_finish:before.scheduled_finish_date,new_finish:row.scheduled_finish_date,old_status:before.capacity_status,new_status:row.capacity_status,
        old_required_minutes:before.required_minutes,new_required_minutes:row.required_minutes});
    }
  }
  for(const before of prior){if(!seen.has(opKey(before.order_line_id,before.step_number)))diff.push({order_line_id:before.order_line_id,step_number:before.step_number,
    change:'REMOVED',old_start:before.scheduled_start_date,old_finish:before.scheduled_finish_date,old_status:before.capacity_status});}
  return diff;
}
