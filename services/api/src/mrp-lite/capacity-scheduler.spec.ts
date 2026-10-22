import { compareCapacityScenarios, scheduleFiniteCapacity } from './capacity-scheduler';
import type { CapacityBucket, CapacityDemand, PriorCapacityOperation } from './capacity-scheduler';

const day1='2026-10-23';
const day2='2026-10-24';

function demand(overrides:Partial<CapacityDemand>={}):CapacityDemand{
 return {order_id:'order-1',order_line_id:'line-1',order_number:'SO-001',order_line_number:1,product_id:'product-1',
  product_version_id:'revision-1',product_version_number:1,product_code:'STYLE-A',need_by_date:day1,planned_quantity:10,
  material_status:'READY',material_ready_on:null,route_step_id:'route-1',step_number:1,operation_code:'SEW',operation_name:'Sewing',
  work_centre_id:'line-a',required_skill:'sewing',setup_minutes:10,sam_smv_minutes_per_unit:5,queue_minutes:0,transfer_minutes:0,...overrides};
}
function bucket(overrides:Partial<CapacityBucket>={}):CapacityBucket{
 return {id:'slot-1',work_centre_id:'line-a',capacity_date:day1,shift_code:'A',available_minutes:60,efficiency_percent:100,skill_codes:['sewing'],...overrides};
}

describe('finite-capacity scheduler',()=>{
 it('calculates setup plus SAM/SMV and never allocates more than shift capacity',()=>{
  const rows=scheduleFiniteCapacity([demand()], [bucket()], day1,day2,day1,day1);
  expect(rows).toHaveLength(1);
  expect(rows[0].required_minutes).toBe(60);
  expect(rows[0].scheduled_minutes).toBe(60);
  expect(rows[0].unscheduled_minutes).toBe(0);
  expect(rows[0].capacity_status).toBe('SCHEDULED');
 });

 it('detects a constrained-capacity conflict and remains deterministic',()=>{
  const demandRows=[demand(),demand({order_id:'order-2',order_line_id:'line-2',order_number:'SO-002',route_step_id:'route-2'})];
  const once=scheduleFiniteCapacity(demandRows,[bucket()],day1,day1,day1,day1);
  const twice=scheduleFiniteCapacity(demandRows,[bucket()],day1,day1,day1,day1);
  expect(once).toEqual(twice);
  expect(once.filter(x=>x.capacity_status==='CAPACITY_CONFLICT')).toHaveLength(1);
  expect(once.reduce((sum,x)=>sum+x.scheduled_minutes,0)).toBeLessThanOrEqual(60);
  expect(once.reduce((sum,x)=>sum+x.unscheduled_minutes,0)).toBe(60);
 });

 it('blocks unsupplied material without using capacity',()=>{
  const rows=scheduleFiniteCapacity([demand({material_status:'UNSUPPLIED'})],[bucket()],day1,day2,day1,day1);
  expect(rows[0].capacity_status).toBe('MATERIAL_BLOCKED');
  expect(rows[0].scheduled_minutes).toBe(0);
  expect(rows[0].unscheduled_minutes).toBe(60);
 });

 it('reports missing skill coverage as a capacity conflict',()=>{
  const rows=scheduleFiniteCapacity([demand()], [bucket({skill_codes:['cutting']})],day1,day1,day1,day1);
  expect(rows[0].capacity_status).toBe('CAPACITY_CONFLICT');
  expect(rows[0].conflict_codes).toContain('NO_SKILL_CAPACITY');
 });

 it('preserves a prior schedule through the frozen horizon and flags changed pinned revisions',()=>{
  const existing:PriorCapacityOperation={order_line_id:'line-1',product_version_id:'revision-old',step_number:1,work_centre_id:'line-a',
   required_minutes:60,scheduled_start_date:day1,scheduled_finish_date:day1,schedule_segments:[
    {calendar_id:'slot-1',work_centre_id:'line-a',capacity_date:day1,shift_code:'A',minutes:60}],capacity_status:'SCHEDULED'};
  const rows=scheduleFiniteCapacity([demand()], [bucket()],day1,day2,day1,day1,[existing]);
  expect(rows[0].frozen_horizon_protected).toBe(true);
  expect(rows[0].scheduled_start_date).toBe(day1);
  expect(rows[0].schedule_segments).toEqual(existing.schedule_segments);
  expect(rows[0].capacity_status).toBe('FROZEN_HORIZON_CONFLICT');
  expect(rows[0].conflict_codes).toContain('FROZEN_REVISION_OR_WORK_CENTRE_CHANGED');
 });

 it('diffs scenario additions, changes and removals in a stable identity order',()=>{
  const prior:PriorCapacityOperation[]=[{order_line_id:'line-1',product_version_id:'revision-1',step_number:1,work_centre_id:'line-a',
   required_minutes:60,scheduled_start_date:day1,scheduled_finish_date:day1,schedule_segments:[],capacity_status:'SCHEDULED'},
   {order_line_id:'line-removed',product_version_id:'revision-1',step_number:2,work_centre_id:'line-a',
   required_minutes:12,scheduled_start_date:day1,scheduled_finish_date:day1,schedule_segments:[],capacity_status:'SCHEDULED'}];
  const changed=scheduleFiniteCapacity([demand({product_version_id:'revision-2',sam_smv_minutes_per_unit:6})],[bucket({available_minutes:80})],day1,day2,day1,day1,prior);
  const diff=compareCapacityScenarios(changed,prior);
  expect(diff.map(x=>x.change)).toEqual(['CHANGED','REMOVED']);
  expect(diff[0]).toHaveProperty('old_version_id','revision-1');
  expect(diff[0]).toHaveProperty('new_version_id','revision-2');
 });
});
