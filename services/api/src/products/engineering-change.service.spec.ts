import { jest } from '@jest/globals';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { EngineeringChangeService } from './engineering-change.service';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const CREATOR='faaab63d-c447-46ce-950d-deebdd7f5f30';
const TENANT='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const FACTORY='162c82fc-8fd0-4977-a12a-9c51a5bbd12b';
const PRODUCT='2f5a1264-c81b-4a95-b204-436d911be76a';
const ECO='7b9b05f5-ea4a-414c-9a5d-a51b6cdb1486';
const SOURCE='d0785575-0953-4920-9c43-50db1c8bbd1e';
const TARGET='e0785575-0953-4920-9c43-50db1c8bbd1f';
const KEY='eco-review-2026-11';
const CORRELATION='4f74c4cf-3e49-45c5-9f15-9c5a42bc9fe1';

const ecoRow={
 id:ECO,tenant_id:TENANT,factory_id:FACTORY,product_id:PRODUCT,eco_number:'ECO-2026-11',title:'Updated sewing BOM',
 rationale:'Reduce waste and change route',source_version_id:SOURCE,target_version_id:TARGET,effective_on:'2026-11-01',status:'SUBMITTED',
 row_version:'2',source_snapshot:{version:{id:SOURCE,number:1,expected_yield_percent:'98.0000',change_summary:'Current'}},
 target_snapshot:{version:{id:TARGET,number:2,expected_yield_percent:'97.0000',change_summary:'Change'}},
 revision_diff:{bom_changed:true,alternate_materials_changed:false,routing_changed:true,specification_changed:true,any_change:true},
 affected_order_count:1,request_hash:'a'.repeat(64),created_by_user_id:CREATOR,decision_note:null,created_at:'2026-10-22T00:00:00Z',
 updated_at:'2026-10-22T00:00:00Z',submit_idempotency_key:'submit-1',submit_request_hash:'b'.repeat(64),
 decision_idempotency_key:null,decision_request_hash:null
};

describe('EngineeringChangeService approval transaction',()=>{
 let service:EngineeringChangeService;
 let database:{transaction:ReturnType<typeof jest.fn>;query:ReturnType<typeof jest.fn>};
 let audit:{record:ReturnType<typeof jest.fn>};
 let client:{query:ReturnType<typeof jest.fn>};
 let sql:string[];

 beforeEach(()=>{
  sql=[];
  client={query:jest.fn(async(text:string)=>{
   sql.push(text);
   if(text.includes('FROM product_engineering_changes')&&text.includes('FOR UPDATE'))
    return {rows:[{...ecoRow}],rowCount:1};
   if(text.includes('FROM product_versions')&&text.includes('id IN('))
    return {rows:[
     {id:SOURCE,state:'APPROVED',row_version:'3',effective_from:'2026-01-01',effective_to:null,effective_to_override:null,created_by_user_id:CREATOR},
     {id:TARGET,state:'DRAFT',row_version:'4',effective_from:'2026-11-01',effective_to:null,effective_to_override:null,created_by_user_id:CREATOR}
    ],rowCount:2};
   if(text.includes("FROM product_versions")&&text.includes("state='APPROVED'")) return {rows:[],rowCount:0};
   if(text.includes('FROM product_bom_alternates')) return {rows:[{count:'0'}],rowCount:1};
   if(text.startsWith('UPDATE product_versions SET state=\\'RETIRED\\'')) return {rows:[],rowCount:1};
   if(text.startsWith('UPDATE product_versions SET state=\\'APPROVED\\'')) return {rows:[],rowCount:1};
   if(text.startsWith('UPDATE product_engineering_changes SET status=')) return {rows:[],rowCount:1};
   return {rows:[],rowCount:1};
  })};
  const approved={...ecoRow,status:'APPROVED',row_version:'3',decision_by_user_id:USER,decision_note:null};
  database={
   transaction:jest.fn(async(_context:unknown,callback:(client:PoolClient)=>Promise<unknown>)=>callback(client as unknown as PoolClient)),
   query:jest.fn(async(text:string)=>{
    if(text.includes('FROM product_eco_events'))return {rows:[{event_type:'APPROVED',created_at:'2026-10-22T00:00:00Z'}],rowCount:1};
    if(text.includes('FROM product_engineering_changes'))return {rows:[approved],rowCount:1};
    return {rows:[],rowCount:0};
   })
  };
  audit={record:jest.fn(async()=> 'audit-id')};
  service=new EngineeringChangeService(database as unknown as DatabaseService,audit as unknown as AuditService);
 });

 it('approves a date-effective revision atomically without rewriting open-work-order snapshots',async()=>{
  const result=await service.decide(USER,TENANT,FACTORY,PRODUCT,ECO,'APPROVED',{expected_version:2},KEY,null,CORRELATION);
  expect(result.status).toBe('APPROVED');
  expect(result.effective_on).toBe('2026-11-01');
  expect(database.transaction).toHaveBeenCalledTimes(1);
  expect(sql.some(q=>q.startsWith("UPDATE product_versions SET state='RETIRED'"))).toBe(true);
  expect(sql.some(q=>q.startsWith("UPDATE product_versions SET state='APPROVED'"))).toBe(true);
  expect(sql.some(q=>q.startsWith('UPDATE product_engineering_changes SET status='))).toBe(true);
  expect(sql.some(q=>q.includes('UPDATE work_orders'))).toBe(false);
  expect(sql.some(q=>q.includes('UPDATE work_order_operations'))).toBe(false);
  expect(sql.some(q=>q.includes('UPDATE work_order_material_requirements'))).toBe(false);
  expect(sql.filter(q=>q.startsWith('INSERT INTO outbox_events')).length).toBeGreaterThanOrEqual(3);
  expect(audit.record).toHaveBeenCalled();
 });

 it('rejects stale ECO row versions before engineering versions are changed',async()=>{
  await expect(service.decide(USER,TENANT,FACTORY,PRODUCT,ECO,'APPROVED',{expected_version:1},KEY,null,CORRELATION))
   .rejects.toThrow(/Stale ECO version/);
  expect(sql.some(q=>q.startsWith("UPDATE product_versions SET state='RETIRED'"))).toBe(false);
  expect(sql.some(q=>q.startsWith("UPDATE product_versions SET state='APPROVED'"))).toBe(false);
 });
});
