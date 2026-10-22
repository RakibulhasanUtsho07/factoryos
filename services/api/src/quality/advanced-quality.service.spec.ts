import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { QualityService } from './quality.service';
import { AdvancedQualityService } from './advanced-quality.service';
import type {
  CreateQualityAqlProfileDto, QualityDefectParetoQueryDto, RecordFabricRollScoreDto, RecordQualityAqlSampleDto,
} from './advanced-quality.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const INSPECTION='0f2e4f11-d513-4c27-8c0b-e2c4ab55e1f1';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('AdvancedQualityService request guardrails',()=>{
  let service:AdvancedQualityService;
  const database={transaction:jest.fn(),query:jest.fn()};
  const qualityService={decideInspection:jest.fn()};
  beforeEach(()=>{
    jest.clearAllMocks();
    service=new AdvancedQualityService(database as unknown as DatabaseService,qualityService as unknown as QualityService);
  });

  it('requires idempotency before creating an AQL profile',async()=>{
    const dto:CreateQualityAqlProfileDto={
      profile_code:'INCOMING-FABRIC',inspection_type:'INCOMING',aql_percent:2.5,inspection_level:'II',
      lot_size_min:50,lot_size_max:500,sample_size:50,accept_number:1,reject_number:3,
    };
    await expect(service.createAqlProfile(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects contradictory AQL lot, sample and rejection limits before opening a transaction',async()=>{
    const dto:CreateQualityAqlProfileDto={
      profile_code:'INCOMING-FABRIC',inspection_type:'INCOMING',aql_percent:2.5,inspection_level:'II',
      lot_size_min:50,lot_size_max:40,sample_size:51,accept_number:3,reject_number:3,
    };
    await expect(service.createAqlProfile(context,dto,'aql-profile-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires traceable non-empty evidence for an AQL sample',async()=>{
    const dto:RecordQualityAqlSampleDto={lot_size:120,observed_nonconforming:2,evidence:{}};
    await expect(service.recordAqlSample(context,INSPECTION,dto,'aql-sample-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects fabric scores whose breakdown does not reconcile to total points',async()=>{
    const dto:RecordFabricRollScoreDto={
      roll_code:'ROLL-001',roll_length_yards:100,roll_width_inches:60,total_defect_points:2,
      defects:[{points:1}],evidence:{sample_sheet:'ROLL-QC-001'},
    };
    await expect(service.recordFabricRollScore(context,INSPECTION,dto,'roll-score-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects fabric score evidence with excessive point precision',async()=>{
    const dto:RecordFabricRollScoreDto={
      roll_code:'ROLL-001',roll_length_yards:100,roll_width_inches:60,total_defect_points:0,
      defects:[{points:0.00001}],evidence:{sample_sheet:'ROLL-QC-001'},
    };
    await expect(service.recordFabricRollScore(context,INSPECTION,dto,'roll-score-precision-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects inverted Pareto date bounds before querying data',async()=>{
    const query:QualityDefectParetoQueryDto={
      dimension:'LINE',from:'2026-10-22T13:00:00Z',to:'2026-10-21T13:00:00Z',
    };
    await expect(service.defectPareto(context,query)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects a malformed tenant context before querying supplier analytics',async()=>{
    await expect(service.supplierQuality({...context,factoryId:'not-a-uuid'})).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });
});
