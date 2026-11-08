import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { UtilityWorkOrderCostAllocationService } from './utility-work-order-cost-allocation.service';
import type { CreateUtilityWorkOrderCostAllocationDto, ReverseUtilityWorkOrderCostAllocationDto } from './utilities.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const METER='27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const READING='40c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const ALLOCATION='50c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const WORK_ORDER='60c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

type SqlResult={rows:Array<Record<string,unknown>>;rowCount?:number};
type QueryHandler=(sql:string,values?:unknown[])=>Promise<SqlResult>;

function makeDatabase(handler:QueryHandler){
  const client={query:jest.fn(handler)};
  const transaction=jest.fn(async (_context:unknown,callback:(client:PoolClient)=>Promise<unknown>) =>
    callback(client as unknown as PoolClient));
  const database={transaction,query:jest.fn()};
  return {database,client,transaction};
}

function allocationHandler(overrides:{capacity?:boolean;currency?:string|null;alreadyExists?:boolean}={}):QueryHandler{
  return async sql=>{
    if(sql.startsWith('SELECT id::text,request_hash FROM utility_reading_work_order_cost_allocations')){
      return {rows:overrides.alreadyExists?[{id:ALLOCATION,request_hash:'different-hash'}]:[]};
    }
    if(sql.includes('FROM utility_meter_readings')&&sql.includes('FOR UPDATE')){
      return {rows:[{
        reading_id:READING,meter_id:METER,reading_at:'2026-11-07T10:00:00.000Z',
        consumption_quantity:'20.00000000',unit_code:'KWH',unit_cost_snapshot:'0.12500000',
        currency_code_snapshot:overrides.currency===undefined?'BDT':overrides.currency,
        cost_center_code_snapshot:'CC-UTIL',
      }]};
    }
    if(sql.includes('FROM work_orders WHERE id=$1')){
      return {rows:[{work_order_number:'WO-100',status:'IN_PROGRESS',released_at:'2026-11-07T08:00:00.000Z',completed_at:null}]};
    }
    if(sql.startsWith('SELECT COALESCE(SUM')){
      return {rows:[{net_quantity:'0.00000000'}]};
    }
    if(sql.startsWith('SELECT ($1::numeric')){
      return {rows:[{within_capacity:overrides.capacity!==false}]};
    }
    if(sql.startsWith('SELECT ROUND')){
      return {rows:[{allocated_cost:'1.31250000'}]};
    }
    if(sql.startsWith('INSERT INTO utility_reading_work_order_cost_allocations')){
      return {rows:[{id:ALLOCATION}]};
    }
    if(sql.includes('FROM utility_reading_work_order_cost_allocations a')&&sql.includes('JOIN work_orders')){
      return {rows:[{
        id:ALLOCATION,reading_id:READING,meter_id:METER,work_order_id:WORK_ORDER,
        work_order_number:'WO-100',allocation_kind:'ALLOCATE',allocated_quantity:'10.5',
        unit_code:'kWh',unit_cost_snapshot:'0.125',allocated_cost:'1.3125',
        currency_code:'BDT',cost_center_code:'CC-UTIL',
      }]};
    }
    throw new Error('Unexpected SQL in allocation fixture: '+sql);
  };
}


function reversalHandler(alreadyReversed=false):QueryHandler{
  return async sql=>{
    if(sql.startsWith('SELECT id::text,request_hash FROM utility_reading_work_order_cost_allocations'))return {rows:[]};
    if(sql.startsWith('SELECT * FROM utility_reading_work_order_cost_allocations')){
      return {rows:[{
        id:ALLOCATION,reading_id:READING,meter_id:METER,work_order_id:WORK_ORDER,
        allocation_basis:'OPERATOR_ASSIGNED',allocated_quantity:'10.50000000',unit_code:'KWH',
        unit_cost_snapshot:'0.12500000',allocated_cost:'1.31250000',currency_code:'BDT',cost_center_code:'CC-UTIL',
      }]};
    }
    if(sql.startsWith('SELECT id FROM utility_meter_readings'))return {rows:[{id:READING}]};
    if(sql.startsWith('SELECT id::text FROM utility_reading_work_order_cost_allocations WHERE reverses_allocation_id')){
      return {rows:alreadyReversed?[{id:'70c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a'}]:[]};
    }
    if(sql.startsWith('INSERT INTO utility_reading_work_order_cost_allocations')){
      return {rows:[{id:'70c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a'}]};
    }
    if(sql.includes('FROM utility_reading_work_order_cost_allocations a')&&sql.includes('JOIN work_orders')){
      return {rows:[{
        id:'70c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a',reading_id:READING,meter_id:METER,
        work_order_id:WORK_ORDER,work_order_number:'WO-100',allocation_kind:'REVERSAL',
        reverses_allocation_id:ALLOCATION,allocated_quantity:'10.5',unit_code:'KWH',
        unit_cost_snapshot:'0.125',allocated_cost:'1.3125',currency_code:'BDT',cost_center_code:'CC-UTIL',
      }]};
    }
    throw new Error('Unexpected SQL in reversal fixture: '+sql);
  };
}

describe('UtilityWorkOrderCostAllocationService',()=>{
  it('keeps decimal validation exact and rejects malformed identifiers before opening a transaction',async()=>{
    const fixture=makeDatabase(async()=>({rows:[]}));
    const service=new UtilityWorkOrderCostAllocationService(fixture.database as unknown as DatabaseService);
    const valid:CreateUtilityWorkOrderCostAllocationDto={work_order_id:WORK_ORDER,allocated_quantity:'1.25',reason:'Shift allocation'};
    await expect(service.allocate(context,METER,READING,valid,null)).rejects.toBeInstanceOf(BadRequestException);
    for(const allocated_quantity of ['0','-1','1e3','01.5','1.123456789','99999999999999999']){
      await expect(service.allocate(context,METER,READING,{...valid,allocated_quantity},'allocation-key'))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.allocate({...context,factoryId:'not-a-uuid'},METER,READING,valid,'allocation-key'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('records a source-backed exact cost allocation and binds all writes to the factory transaction',async()=>{
    const fixture=makeDatabase(allocationHandler());
    const service=new UtilityWorkOrderCostAllocationService(fixture.database as unknown as DatabaseService);
    const dto:CreateUtilityWorkOrderCostAllocationDto={
      work_order_id:WORK_ORDER,allocated_quantity:'10.50000000',reason:'Shift supervisor assigned shared meter consumption',
    };
    const result=await service.allocate(context,METER,READING,dto,'utility-wo-allocation-001');
    expect(result).toMatchObject({id:ALLOCATION,work_order_number:'WO-100',allocated_cost:'1.3125'});
    expect(fixture.transaction).toHaveBeenCalledWith(expect.objectContaining({
      tenantId:TENANT,userId:USER,advisoryLockKey:'utility-work-order-allocation:'+TENANT+':'+FACTORY+':'+READING,
    }),expect.any(Function));
    const insert=fixture.client.query.mock.calls.find(([sql])=>String(sql).startsWith('INSERT INTO utility_reading_work_order_cost_allocations'));
    expect(insert).toBeDefined();
    expect(insert?.[1]?.[5]).toBe('10.5');
    expect(insert?.[1]?.[7]).toBe('0.12500000');
    expect(insert?.[1]?.[8]).toBe('1.31250000');
    expect(insert?.[1]?.[9]).toBe('BDT');
  });

  it('fails closed for historical rows without currency snapshots and for source over-allocation',async()=>{
    const historical=makeDatabase(allocationHandler({currency:null}));
    const historicalService=new UtilityWorkOrderCostAllocationService(historical.database as unknown as DatabaseService);
    const dto:CreateUtilityWorkOrderCostAllocationDto={work_order_id:WORK_ORDER,allocated_quantity:'1',reason:'Backfill check'};
    await expect(historicalService.allocate(context,METER,READING,dto,'historical-1'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(historical.client.query).toHaveBeenCalledTimes(2);

    const exhausted=makeDatabase(allocationHandler({capacity:false}));
    const exhaustedService=new UtilityWorkOrderCostAllocationService(exhausted.database as unknown as DatabaseService);
    await expect(exhaustedService.allocate(context,METER,READING,dto,'over-allocation'))
      .rejects.toThrow('would exceed immutable utility reading consumption');
    expect(exhausted.client.query.mock.calls.some(([sql])=>String(sql).startsWith('INSERT INTO'))).toBe(false);
  });

  it('does not replay an idempotency key against a different payload',async()=>{
    const fixture=makeDatabase(allocationHandler({alreadyExists:true}));
    const service=new UtilityWorkOrderCostAllocationService(fixture.database as unknown as DatabaseService);
    const dto:CreateUtilityWorkOrderCostAllocationDto={work_order_id:WORK_ORDER,allocated_quantity:'1',reason:'Changed payload'};
    await expect(service.allocate(context,METER,READING,dto,'existing-key')).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.client.query).toHaveBeenCalledTimes(1);
  });

  it('records one full append-only reversal with the original immutable snapshots',async()=>{
    const fixture=makeDatabase(reversalHandler());
    const service=new UtilityWorkOrderCostAllocationService(fixture.database as unknown as DatabaseService);
    const dto:ReverseUtilityWorkOrderCostAllocationDto={reason:'Reverse a duplicate utility assignment'};
    const result=await service.reverse(context,METER,READING,ALLOCATION,dto,'utility-wo-reversal-001');
    expect(result).toMatchObject({allocation_kind:'REVERSAL',reverses_allocation_id:ALLOCATION,allocated_cost:'1.3125'});
    const insert=fixture.client.query.mock.calls.find(([sql])=>String(sql).startsWith('INSERT INTO utility_reading_work_order_cost_allocations'));
    expect(insert?.[1]?.[5]).toBe(ALLOCATION);
    expect(insert?.[1]?.[7]).toBe('10.50000000');
    expect(insert?.[1]?.[10]).toBe('1.31250000');
    expect(insert?.[1]?.[11]).toBe('BDT');
  });

  it('rejects a second reversal before inserting a duplicate reversal row',async()=>{
    const fixture=makeDatabase(reversalHandler(true));
    const service=new UtilityWorkOrderCostAllocationService(fixture.database as unknown as DatabaseService);
    await expect(service.reverse(context,METER,READING,ALLOCATION,
      {reason:'Second correction request'} as ReverseUtilityWorkOrderCostAllocationDto,'utility-wo-reversal-002'))
      .rejects.toThrow('already been fully reversed');
    expect(fixture.client.query.mock.calls.some(([sql])=>String(sql).startsWith('INSERT INTO'))).toBe(false);
  });

  it('requires a reason and an Idempotency-Key before recording an append-only reversal',async()=>{
    const fixture=makeDatabase(async()=>({rows:[]}));
    const service=new UtilityWorkOrderCostAllocationService(fixture.database as unknown as DatabaseService);
    await expect(service.reverse(context,METER,READING,ALLOCATION,{reason:' '} as ReverseUtilityWorkOrderCostAllocationDto,null))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.reverse(context,METER,READING,ALLOCATION,{reason:'Correct the mistaken work-order assignment'} as ReverseUtilityWorkOrderCostAllocationDto,null))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
});
