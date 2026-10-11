import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';
import { GrowthOpportunityService } from './growth-opportunity.service';
import { GrowthScenarioExperimentService } from './growth-scenario-experiment.service';
interface ScopeRow{tenant_id:string;factory_id:string;user_id:string;}
describe('Growth scenarios and experiments PostgreSQL integration',()=>{
 let pool!:Pool,client!:PoolClient,opportunities!:GrowthOpportunityService,svc!:GrowthScenarioExperimentService,t!:string,f!:string,u!:string;
 beforeAll(async()=>{const url=process.env.TEST_ADMIN_DATABASE_URL;if(!url)throw new Error('TEST_ADMIN_DATABASE_URL is required');pool=new Pool({connectionString:url});client=await pool.connect();await client.query('BEGIN');const r=await client.query<ScopeRow>("SELECT t.id::text tenant_id,f.id::text factory_id,u.id::text user_id FROM tenants t JOIN factories f ON f.tenant_id=t.id JOIN tenant_memberships tm ON tm.tenant_id=t.id AND tm.status='ACTIVE' JOIN users u ON u.id=tm.user_id AND u.status='ACTIVE' WHERE t.status='ACTIVE' AND f.status='ACTIVE' ORDER BY t.created_at,f.created_at,u.created_at LIMIT 1");if(!r.rows[0])throw new Error('No active fixture scope');t=r.rows[0].tenant_id;f=r.rows[0].factory_id;u=r.rows[0].user_id;const db={query:(q:string,v?:unknown[])=>client.query(q,v)},iam={authorize:jest.fn<(...a:unknown[])=>Promise<void>>().mockResolvedValue(undefined)},audit={record:jest.fn<(...a:unknown[])=>Promise<string>>().mockResolvedValue('audit')};opportunities=new GrowthOpportunityService(db as never,iam as never,audit as never);svc=new GrowthScenarioExperimentService(db as never,iam as never,audit as never);},60000);
 afterAll(async()=>{if(client){await client.query('ROLLBACK');client.release();}if(pool)await pool.end();});
 async function opportunity(n:string){const x=await opportunities.createOpportunity(t,f,u,{opportunity_key:'growth.integration.'+n,opportunity_version:'v1',category:'CAPACITY_UNLOCK' as never,statement:'Verify controlled setup improvement.',evidence:[{kind:'PRIVATE_OPERATIONAL' as never,label:'MES baseline',reference_id:'MES:'+n}],assumptions:['Matched-run sample is representative.'],affected_nodes:[{node_type:'KPI' as never,node_ref:'production.changeover_minutes'}],expected_value_min:1,expected_value_max:4,expected_value_metric:'changeover_minutes_saved',expected_value_unit:'minutes',expected_value_currency:'BDT',uncertainty:{level:'MEDIUM' as never,limitations:['Limited sample.'],sensitivity_factors:['shift'],evidence_gaps:['second product family']},effort_estimate:4,effort_unit:'PERSON_HOURS' as never,dependencies:[],time_to_impact:'NEAR_TERM' as never,risk_class:'OPERATIONAL' as never,validation_plan:'Compare matched production runs.',decision_owner_role:'OPERATIONS_MANAGER',idempotency_key:'growth-opp-'+n} as never);return x.opportunity.id as string;}
 const band=(metric:string,unit:string)=>({metric,min:1,max:4,unit});
 it('enforces approval, start, completion, source-backed measures and scenario immutability',async()=>{
  const n=randomUUID(),o=await opportunity(n);
  const s=await svc.createScenarioSnapshot(t,f,u,o,{scenario_key:'integration.base.'+n,scenario_version:'v1',scenario_type:'BASE' as never,model_version:'planner.v1',data_vintage_at:'2026-10-10T00:00:00Z',input_snapshot_sha256:'a'.repeat(64),source_snapshot_refs:[{source_system:'MES' as never,source_record_ref:'MES:snapshot:'+n,snapshot_sha256:'b'.repeat(64)}],assumptions:['Demand is stable.'],impact_bands:{kpi:band('throughput','units/day'),cash:band('cash','BDT'),margin:band('margin','bps'),capacity:band('capacity','units/day')} as never,constraints_violated:[],validation_questions:['Is result stable across shifts?'],uncertainty:{level:'MEDIUM' as never,limitations:['Limited observations.'],sensitivity_factors:['shift'],evidence_gaps:['forecast']},idempotency_key:'scenario-'+n} as never);
  expect(s.scenario.semantics).toBe('SIMULATION_NOT_REALIZED_PERFORMANCE');
  const e=await svc.createExperiment(t,f,u,o,{experiment_key:'integration.experiment.'+n,experiment_version:'v1',scenario_snapshot_id:s.scenario.id,hypothesis:'New setup reduces changeover without adding defects.',objective:'Compare ten matched runs.',primary_metric:'changeover_minutes',baseline_definition:{description:'Prior 20 matched runs.'},control_definition:{description:'Current setup.'},treatment_definition:{description:'Revised setup.',guardrails:['Stop if defect rate rises.']},duration_days:14,owner_role:'OPERATIONS_MANAGER',stop_conditions:['Stop on quality regression.'],sample_scope:{description:'Authorized line and day shift.',factory_line_refs:['LINE-A'],shift_refs:['DAY']},idempotency_key:'experiment-'+n} as never);
  const eid=e.experiment.id as string;
  const measure=(stage:string,key:string,value:number)=>({measurement_stage:stage,metric_key:'changeover_minutes',actual_value:value,metric_unit:'minutes',observed_at:'2026-10-10T12:00:00Z',source_system:'MES',source_record_ref:'MES:'+key+':'+n,source_snapshot_sha256:'c'.repeat(64),idempotency_key:key+'-'+n});
  await svc.recordExperimentMeasurement(t,f,u,o,eid,measure('BASELINE','baseline',17) as never);
  await svc.recordExperimentDecision(t,f,u,o,eid,{decision:'APPROVED' as never,rationale:'Scope and stop conditions reviewed.',idempotency_key:'approved-'+n} as never);
  await svc.recordExperimentMeasurement(t,f,u,o,eid,measure('PRE','pre',18) as never);
  await svc.recordExperimentDecision(t,f,u,o,eid,{decision:'STARTED' as never,rationale:'Baseline and pre measurement captured.',idempotency_key:'started-'+n} as never);
  await svc.recordExperimentMeasurement(t,f,u,o,eid,measure('POST','post',13) as never);
  await svc.recordExperimentDecision(t,f,u,o,eid,{decision:'COMPLETED' as never,rationale:'Sample and duration completed.',idempotency_key:'completed-'+n} as never);
  const realized=await svc.recordExperimentMeasurement(t,f,u,o,eid,measure('REALIZED','realized',13) as never);
  expect(realized.measurement.semantics).toBe('SOURCE_REFERENCED_OBSERVATION_NOT_AUTOMATIC_CAUSAL_ATTRIBUTION');
  expect((await svc.listExperimentMeasurements(t,f,u,o,eid)).measurements).toHaveLength(4);
  await client.query('SAVEPOINT growth_scenario_immutable');
  await expect(client.query('UPDATE growth_scenario_snapshots SET model_version=$1 WHERE id=$2',['mutated',s.scenario.id])).rejects.toThrow('Growth scenario snapshots are immutable');
  await client.query('ROLLBACK TO SAVEPOINT growth_scenario_immutable');
 });
 it('rejects an attempted POST before approval/start',async()=>{
  const n=randomUUID(),o=await opportunity(n);
  const e=await svc.createExperiment(t,f,u,o,{experiment_key:'pending.'+n,experiment_version:'v1',hypothesis:'A revised check reduces scrap.',objective:'Compare matched batches.',primary_metric:'scrap_rate',baseline_definition:{description:'Prior median.'},control_definition:{description:'Current check.'},treatment_definition:{description:'Revised check.'},duration_days:7,owner_role:'QUALITY_MANAGER',stop_conditions:['Stop if throughput falls.'],sample_scope:{description:'One line.'},idempotency_key:'pending-exp-'+n} as never);
  await expect(svc.recordExperimentMeasurement(t,f,u,o,e.experiment.id,{measurement_stage:'POST' as never,metric_key:'scrap_rate',actual_value:2,metric_unit:'percent',observed_at:'2026-10-10T12:00:00Z',source_system:'QUALITY' as never,source_record_ref:'QUALITY:post:'+n,idempotency_key:'post-denied-'+n} as never)).rejects.toThrow('POST measurements require a STARTED experiment');
 });
});
