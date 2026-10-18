import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { UtilitiesService } from './utilities.service';
import type { CreateUtilityEventDto, CreateUtilityMeterDto, ListUtilityReadingsQueryDto, RecordUtilityReadingDto } from './utilities.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const METER='27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('UtilitiesService request validation',()=>{
  let service:UtilitiesService;
  const database={transaction:jest.fn(),query:jest.fn()};
  beforeEach(()=>{jest.clearAllMocks();service=new UtilitiesService(database as unknown as DatabaseService);});

  it('requires idempotency before a meter can be registered',async()=>{
    const dto:CreateUtilityMeterDto={meter_code:'ELEC-01',name:'Main electricity',utility_type:'ELECTRICITY',reading_mode:'CUMULATIVE',unit_code:'kWh'};
    await expect(service.createMeter(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed factory context before opening a transaction',async()=>{
    const dto:CreateUtilityMeterDto={meter_code:'ELEC-01',name:'Main electricity',utility_type:'ELECTRICITY',reading_mode:'CUMULATIVE',unit_code:'kWh'};
    await expect(service.createMeter({...context,factoryId:'not-a-uuid'},dto,'meter-create'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid currency source-to-cost mapping',async()=>{
    const dto:CreateUtilityMeterDto={meter_code:'ELEC-02',name:'Main electricity',utility_type:'ELECTRICITY',reading_mode:'CUMULATIVE',unit_code:'kWh',currency_code:'US'};
    await expect(service.createMeter(context,dto,'meter-currency')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects zero or negative meter multipliers before database work',async()=>{
    const dto={meter_code:'ELEC-03',name:'Main electricity',utility_type:'ELECTRICITY',reading_mode:'CUMULATIVE',unit_code:'kWh',multiplier_factor:0} as CreateUtilityMeterDto;
    await expect(service.createMeter(context,dto,'meter-multiplier')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires idempotency and a valid timestamp before recording a reading',async()=>{
    const dto={reading_at:'not-a-date',reading_value:12,source_type:'MANUAL'} as RecordUtilityReadingDto;
    await expect(service.recordReading(context,METER,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.recordReading(context,METER,dto,'reading-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects negative/non-finite meter values without a transaction',async()=>{
    const dto={reading_at:'2026-10-18T10:00:00Z',reading_value:-1,source_type:'MANUAL'} as RecordUtilityReadingDto;
    await expect(service.recordReading(context,METER,dto,'reading-negative')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects an inverted time range before querying readings',async()=>{
    const query={from:'2026-10-18T12:00:00Z',to:'2026-10-18T10:00:00Z'} as ListUtilityReadingsQueryDto;
    await expect(service.listReadings(context,METER,query)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires resolution evidence for utility-event completion',async()=>{
    const dto={action:'RESOLVE',expected_version:2,reason:'Restored'} as CreateUtilityEventDto;
    await expect(service.transitionEvent(context,METER,dto as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
