import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { QualityService } from './quality.service';
import type {
  CreateQualityDefectDto, CreateQualityInspectionDto, CreateQualityInspectionPlanDto,
  CreateQualityInspectionResultDto, QualityDispositionDto, QualityInspectionDecisionDto,
} from './quality.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const INSPECTION='0f2e4f11-d513-4c27-8c0b-e2c4ab55e1f1';
const TARGET='27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('QualityService request validation',()=>{
  let service:QualityService;
  const database={transaction:jest.fn(),query:jest.fn()};
  beforeEach(()=>{
    jest.clearAllMocks();
    service=new QualityService(database as unknown as DatabaseService);
  });

  it('requires an idempotency key before creating an inspection',async()=>{
    const dto:CreateQualityInspectionDto={inspection_type:'INCOMING',target_type:'INVENTORY_ITEM',target_id:TARGET};
    await expect(service.createInspection(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid target UUID before opening a transaction',async()=>{
    const dto:CreateQualityInspectionDto={inspection_type:'FINAL',target_type:'WORK_ORDER',target_id:'not-a-uuid'};
    await expect(service.createInspection(context,dto,'inspection-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects sample quantities with more than four decimals',async()=>{
    const dto={inspection_type:'IN_PROCESS',target_type:'WORK_ORDER',target_id:TARGET,sample_quantity:1.00001} as CreateQualityInspectionDto;
    await expect(service.createInspection(context,dto,'inspection-precision')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a defect idempotency key before touching the database',async()=>{
    const dto:CreateQualityDefectDto={defect_code:'SURFACE-01',severity:'MAJOR',description:'Surface defect'};
    await expect(service.recordDefect(context,INSPECTION,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a reason for inspection FAIL, HOLD and CANCEL decisions',async()=>{
    for(const action of ['FAIL','HOLD','CANCEL'] as const){
      const dto:QualityInspectionDecisionDto={expected_version:1,action};
      await expect(service.decideInspection(context,INSPECTION,dto,'decision-'+action)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an explicit reason for disposition decisions',async()=>{
    const dto={expected_version:1,action:'RELEASE',reason:'   '} as QualityDispositionDto;
    await expect(service.disposeInspection(context,INSPECTION,dto,'release-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a quantity for scrap and supplier-return disposition',async()=>{
    for(const action of ['SCRAP','RETURN_TO_SUPPLIER'] as const){
      const dto:QualityDispositionDto={expected_version:1,action,reason:'Approved quality disposition'};
      await expect(service.disposeInspection(context,INSPECTION,dto,'dispose-'+action)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid context IDs before a write',async()=>{
    await expect(service.recordDefect({...context,userId:'bad'},INSPECTION,{
      defect_code:'DEFECT',severity:'MINOR',description:'Invalid request',
    },'defect-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key before creating a reusable inspection plan',async()=>{
    const dto={plan_code:'FINAL-1',name:'Final inspection',inspection_type:'FINAL',criteria:[
      {criterion_code:'SIZE',name:'Size',value_type:'NUMERIC',comparison_operator:'BETWEEN',lower_limit:10,upper_limit:12},
    ]} as CreateQualityInspectionPlanDto;
    await expect(service.createInspectionPlan(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects criteria whose acceptance operator is incompatible with the value type',async()=>{
    const dto={plan_code:'FINAL-2',name:'Final inspection',inspection_type:'FINAL',criteria:[
      {criterion_code:'STATE',name:'State',value_type:'BOOLEAN',comparison_operator:'GT',target_value:'true'},
    ]} as CreateQualityInspectionPlanDto;
    await expect(service.createInspectionPlan(context,dto,'plan-invalid-operator')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate criterion codes in a plan revision',async()=>{
    const dto={plan_code:'FINAL-3',name:'Final inspection',inspection_type:'FINAL',criteria:[
      {criterion_code:'SIZE',name:'Size upper',value_type:'NUMERIC',comparison_operator:'LTE',target_value:'12'},
      {criterion_code:'size',name:'Size lower',value_type:'NUMERIC',comparison_operator:'GTE',target_value:'10'},
    ]} as CreateQualityInspectionPlanDto;
    await expect(service.createInspectionPlan(context,dto,'plan-duplicate-code')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key before recording a criterion result',async()=>{
    const dto:CreateQualityInspectionResultDto={criterion_code:'SIZE',observed_value:'10.5'};
    await expect(service.recordInspectionResult(context,INSPECTION,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
