import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MaintenanceService } from './maintenance.service';
import type {
  CreateMaintenanceAssetDto,
  CreateMaintenanceBreakdownWorkOrderDto,
  CreateMaintenancePmPlanDto,
  IssueMaintenanceSparePartDto,
  MaintenanceWorkOrderTransitionDto,
  UpdateMaintenanceAssetDto,
} from './maintenance.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ASSET='27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const WORK_ORDER='6e0a7b09-9fcb-4d54-a5f1-49a13d41f6bc';
const PART='18bd617e-985f-4ce7-a96b-c2b51c6c2c9a';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('MaintenanceService request validation',()=>{
  let service:MaintenanceService;
  const database={transaction:jest.fn(),query:jest.fn()};
  beforeEach(()=>{
    jest.clearAllMocks();
    service=new MaintenanceService(database as unknown as DatabaseService);
  });

  it('requires an idempotency key before creating an asset',async()=>{
    const dto:CreateMaintenanceAssetDto={asset_code:'LINE-01',name:'Main production line',asset_type:'LINE'};
    await expect(service.createAsset(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed actor or factory context before reading data',async()=>{
    const dto:CreateMaintenanceAssetDto={asset_code:'LINE-02',name:'Second line',asset_type:'LINE'};
    await expect(service.createAsset({...context,factoryId:'not-a-uuid'},dto,'asset-create-2'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate checklist codes in a preventive plan',async()=>{
    const dto:CreateMaintenancePmPlanDto={
      asset_id:ASSET,plan_code:'WEEKLY-LINE-01',name:'Weekly line inspection',
      interval_value:1,interval_unit:'WEEK',next_due_on:'2026-11-01',
      checklist:[
        {code:'LUBE',description:'Check lubrication',required:true},
        {code:'lube',description:'Check bearing lubrication',required:true},
      ],
    };
    await expect(service.createPmPlan(context,dto,'pm-plan-create-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid calendar dates before creating a PM plan',async()=>{
    const dto:CreateMaintenancePmPlanDto={
      asset_id:ASSET,plan_code:'MONTHLY-LINE-01',name:'Monthly inspection',
      interval_value:1,interval_unit:'MONTH',next_due_on:'2026-02-30',
    };
    await expect(service.createPmPlan(context,dto,'pm-plan-date')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate checklist codes in a breakdown work order',async()=>{
    const dto:CreateMaintenanceBreakdownWorkOrderDto={
      asset_id:ASSET,priority:'HIGH',title:'Motor vibration',
      description:'Unexpected vibration detected on the drive motor',
      checklist:[
        {code:'ISOLATE',description:'Isolate power before work'},
        {code:'isolate',description:'Verify energy isolation'},
      ],
    };
    await expect(service.createBreakdownWorkOrder(context,dto,'breakdown-checklist'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for work-order transitions',async()=>{
    const dto:MaintenanceWorkOrderTransitionDto={expected_version:1,action:'APPROVE',reason:'Reviewed maintenance plan'};
    await expect(service.transitionWorkOrder(context,WORK_ORDER,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a transition reason before opening a work-order transaction',async()=>{
    const dto={expected_version:1,action:'CANCEL',reason:'   '} as MaintenanceWorkOrderTransitionDto;
    await expect(service.transitionWorkOrder(context,WORK_ORDER,dto,'wo-cancel-reason'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key and actor reason for spare-part stock issue',async()=>{
    const dto:IssueMaintenanceSparePartDto={expected_version:1,quantity:1,reason:'Replacement bearing'};
    await expect(service.issueSparePart(context,WORK_ORDER,PART,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects spare-part quantities beyond four decimal places before stock access',async()=>{
    const dto={expected_version:1,quantity:1.23456,reason:'Replacement bearing'} as IssueMaintenanceSparePartDto;
    await expect(service.issueSparePart(context,WORK_ORDER,PART,dto,'spare-issue-precision'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a reason and at least one mutable field for an asset update',async()=>{
    const dto={expected_version:1,reason:'Asset reviewed'} as UpdateMaintenanceAssetDto;
    await expect(service.updateAsset(context,ASSET,dto,'asset-update-empty'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
