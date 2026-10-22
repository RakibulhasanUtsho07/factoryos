import { jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { UtilitiesService } from './utilities.service';
import { UtilitiesClosureService } from './utilities-closure.service';
import type { IngestUtilitySourceEventDto } from './utilities-closure.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const METER='27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('UtilitiesClosureService request validation',()=>{
  let service:UtilitiesClosureService;
  const database={transaction:jest.fn(),query:jest.fn()};
  const utilities={recordReading:jest.fn(),transitionEvent:jest.fn()};
  beforeEach(()=>{
    jest.clearAllMocks();
    service=new UtilitiesClosureService(database as unknown as DatabaseService,utilities as unknown as UtilitiesService);
  });

  it('requires an idempotency key before creating an approved source mapping',async()=>{
    await expect(service.createSourceBinding(context,{
      source_system_code:'GATEWAY-01',source_meter_code:'METER-01',vendor_adapter:'MQTT',
      meter_id:METER,source_unit_code:'Wh',factor_to_meter_unit:0.001,
    },null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a meter or utility-type selector before creating a threshold policy',async()=>{
    await expect(service.createThresholdPolicy(context,{
      policy_code:'ENERGY-HIGH',name:'High energy',metric:'CONSUMPTION',comparison:'GTE',
      threshold_value:10,threshold_unit_code:'kWh',severity:'HIGH',
    },'threshold-policy-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when a vendor reading has no approved source mapping',async()=>{
    database.query.mockResolvedValueOnce({rows:[]} as never);
    const dto:IngestUtilitySourceEventDto={
      source_system_code:'GW-01',source_meter_code:'M-01',source_event_id:'evt-001',
      reading_at:'2026-10-22T10:00:00Z',reading_value:20000,source_unit_code:'Wh',
    };
    await expect(service.ingestSourceEvent(context,dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(utilities.recordReading).not.toHaveBeenCalled();
  });

  it('normalizes vendor units through the approved factor and uses a stable event idempotency key',async()=>{
    database.query.mockResolvedValueOnce({rows:[{
      id:'a9e3e3e3-2345-4c12-8b6b-05bb9ceac0d1',meter_id:METER,source_unit_code:'Wh',
      factor_to_meter_unit:'0.001',meter_status:'ACTIVE',unit_code:'kWh',reading_mode:'INTERVAL',
    }]} as never);
    utilities.recordReading.mockResolvedValueOnce({id:'reading-01',replayed:false} as never);
    const dto:IngestUtilitySourceEventDto={
      source_system_code:'gw-01',source_meter_code:'M-01',source_event_id:'evt-001',
      reading_at:'2026-10-22T10:00:00Z',reading_value:20000,source_unit_code:'Wh',notes:'gateway sample',
    };
    const result=await service.ingestSourceEvent(context,dto);
    expect(utilities.recordReading).toHaveBeenCalledTimes(1);
    const args=utilities.recordReading.mock.calls[0] as unknown as [unknown,string,{reading_value:number;source_type:string;source_event_id:string},string];
    expect(args[1]).toBe(METER);
    expect(args[2].reading_value).toBe(20);
    expect(args[2].source_type).toBe('METER_GATEWAY');
    expect(args[2].source_event_id).toBe('GW-01:evt-001');
    expect(args[3]).toBe('vendor-event:GW-01:evt-001');
    expect(result.normalization).toEqual(expect.objectContaining({
      source_unit_code:'Wh',meter_unit_code:'kWh',conversion_factor:'0.001',normalized_reading_value:20,
      vendor_adapter_status:'INGESTION_CONTRACT_ONLY',
    }));
  });

  it('rejects malformed tenant context before querying source data',async()=>{
    await expect(service.listSourceBindings({...context,factoryId:'bad'})).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });
});
