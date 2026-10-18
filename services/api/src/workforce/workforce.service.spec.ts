import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkforceService } from './workforce.service';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const WORKER='27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const ASSIGNMENT='6e0a7b09-9fcb-4d54-a5f1-49a13d41f6bc';
const ORDER='18bd617e-985f-4ce7-a96b-c2b51c6c2c9a';
const OPERATION='3fdefb33-0eb3-4fbd-9cb9-7b4bbfd90b80';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('WorkforceService input and policy validation',()=>{
  let service:WorkforceService;
  const database={transaction:jest.fn(),query:jest.fn()};
  beforeEach(()=>{
    jest.clearAllMocks();
    service=new WorkforceService(database as unknown as DatabaseService);
  });

  it('requires an idempotency key before registering a worker',async()=>{
    await expect(service.createWorker(context,{employee_code:'OP-001',display_name:'Operator One'},null))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed authenticated tenant/factory context before DB access',async()=>{
    await expect(service.createWorker({...context,factoryId:'not-a-uuid'},
      {employee_code:'OP-002',display_name:'Operator Two'},'worker-create-2'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects invalid calendar dates before opening a roster transaction',async()=>{
    await expect(service.createAssignment(context,{
      shift_template_id:WORKER,worker_id:WORKER,shift_date:'2026-02-30',
    },'assignment-invalid-day')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects equal shift boundaries instead of silently producing a zero or 24-hour shift',async()=>{
    await expect(service.createShift(context,{
      shift_code:'DAY',name:'Day shift',starts_at_local:'08:00',ends_at_local:'08:00',
    },'shift-equal-boundary')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous half-hour daylight-saving overlap when resolving a shift',()=>{
    const internal=service as unknown as {
      localToUtc:(date:string,time:string,zone:string)=>Date;
    };
    expect(()=>internal.localToUtc('2026-04-05','01:45:00','Australia/Lord_Howe'))
      .toThrow(BadRequestException);
  });

  it('rejects an unrecognized time zone before creating a shift template',async()=>{
    await expect(service.createShift(context,{
      shift_code:'DAY',name:'Day shift',starts_at_local:'08:00',ends_at_local:'16:00',
      timezone_name:'Mars/Olympus_Mons',
    },'shift-invalid-zone')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires ordered production timestamps before calculating productivity',async()=>{
    await expect(service.captureProductivity(context,{
      shift_assignment_id:ASSIGNMENT,work_order_id:ORDER,work_order_operation_id:OPERATION,
      production_started_at:'2026-10-18T10:00:00Z',production_ended_at:'2026-10-18T09:59:59Z',
      good_quantity:1,scrap_quantity:0,standard_minutes_per_unit:2,actual_minutes:1,
    },'productivity-reversed-interval')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects productivity quantities with more precision than the inventory/production ledger',async()=>{
    await expect(service.captureProductivity(context,{
      shift_assignment_id:ASSIGNMENT,work_order_id:ORDER,work_order_operation_id:OPERATION,
      production_started_at:'2026-10-18T09:00:00Z',production_ended_at:'2026-10-18T10:00:00Z',
      good_quantity:1.12345,scrap_quantity:0,standard_minutes_per_unit:2,actual_minutes:30,
    },'productivity-precision')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a scrap reason before opening a productivity transaction',async()=>{
    await expect(service.captureProductivity(context,{
      shift_assignment_id:ASSIGNMENT,work_order_id:ORDER,work_order_operation_id:OPERATION,
      production_started_at:'2026-10-18T09:00:00Z',production_ended_at:'2026-10-18T10:00:00Z',
      good_quantity:9,scrap_quantity:1,standard_minutes_per_unit:2,actual_minutes:30,
    },'productivity-scrap-reason')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects actual labor longer than the captured production interval',async()=>{
    await expect(service.captureProductivity(context,{
      shift_assignment_id:ASSIGNMENT,work_order_id:ORDER,work_order_operation_id:OPERATION,
      production_started_at:'2026-10-18T09:00:00Z',production_ended_at:'2026-10-18T09:15:00Z',
      good_quantity:10,scrap_quantity:0,standard_minutes_per_unit:2,actual_minutes:16,
    },'productivity-actual-window')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects self-approval payloads that approve zero or unbounded overtime',async()=>{
    await expect(service.decideOvertime(context,ASSIGNMENT,{
      expected_version:1,action:'APPROVE',approved_minutes:0,reason:'Reviewed',
    },'overtime-zero-approval')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.decideOvertime(context,ASSIGNMENT,{
      expected_version:1,action:'APPROVE',approved_minutes:1500,reason:'Reviewed',
    },'overtime-out-of-range')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects date-range reads with an inverted range before querying PostgreSQL',async()=>{
    await expect(service.listOvertime(context,{
      from_date:'2026-10-20',to_date:'2026-10-19',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects an invalid attendance timestamp before ingesting evidence',async()=>{
    await expect(service.captureAttendance(context,{
      shift_assignment_id:ASSIGNMENT,event_type:'CLOCK_IN',source_type:'MANUAL',
      occurred_at:'not-a-timestamp',
    },'attendance-invalid-time')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects certificate expiry before the certification date',async()=>{
    await expect(service.assignWorkerSkill(context,WORKER,{
      skill_id:OPERATION,skill_level:3,certified_on:'2026-10-20',certificate_expires_on:'2026-10-19',
    },'worker-skill-reversed-expiry')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('aggregates productivity over the full date range instead of only the limited item page',async()=>{
    database.query
      .mockResolvedValueOnce({rows:[{
        id:'page-report',good_quantity:'1',scrap_quantity:'0',earned_minutes:'2',actual_minutes:'1',
      }]} as never)
      .mockResolvedValueOnce({rows:[{
        report_count:3,good_quantity:'9',scrap_quantity:'1',earned_minutes:'18',actual_minutes:'10',
      }]} as never);
    const result=await service.listProductivity(context,{
      from_date:'2026-10-01',to_date:'2026-10-31',limit:1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.returned_count).toBe(1);
    expect(result.totals).toEqual({
      report_count:3,good_quantity:9,scrap_quantity:1,earned_minutes:18,actual_minutes:10,
    });
    expect(result.weighted_efficiency_percent).toBe(180);
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a worker update with a blank reason or stale shape before database access',async()=>{
    await expect(service.transitionWorker(context,WORKER,{
      expected_version:1,status:'INACTIVE',reason:'   ',
    },'worker-status-no-reason')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
