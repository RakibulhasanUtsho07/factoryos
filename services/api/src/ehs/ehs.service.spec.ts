import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EhsService } from './ehs.service';
import type {
  CreateEhsIncidentDto, CreateEhsPermitDto, TransitionEhsCorrectiveActionDto, TransitionEhsPermitDto,
} from './ehs.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const PERMIT='27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const ACTION='6e0a7b09-9fcb-4d54-a5f1-49a13d41f6bc';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('EhsService request validation',()=>{
  let service:EhsService;
  const database={transaction:jest.fn(),query:jest.fn()};
  beforeEach(()=>{jest.clearAllMocks();service=new EhsService(database as unknown as DatabaseService);});

  it('requires an idempotency key when registering a safety permit',async()=>{
    const dto:CreateEhsPermitDto={
      permit_number:'PTW-001',permit_type:'GENERAL',risk_level:'LOW',title:'Routine service',
      work_scope:'Inspect a conveyor',location:'Line A',valid_from:'2026-10-18T10:00:00Z',
      expires_at:'2026-10-18T11:00:00Z',
    };
    await expect(service.createPermit(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires isolation points for electrical LOTO/high-risk permits',async()=>{
    const dto:CreateEhsPermitDto={
      permit_number:'PTW-002',permit_type:'ELECTRICAL_LOTO',risk_level:'CRITICAL',title:'Isolate machine',
      work_scope:'Lock out and test zero energy',location:'Switch room',valid_from:'2026-10-18T10:00:00Z',
      expires_at:'2026-10-18T11:00:00Z',requires_isolation:true,isolation_points:[],
    };
    await expect(service.createPermit(context,dto,'permit-loto')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects overlapping validity rules beyond the seven-day safety permit limit',async()=>{
    const dto:CreateEhsPermitDto={
      permit_number:'PTW-003',permit_type:'GENERAL',risk_level:'LOW',title:'Routine service',
      work_scope:'Inspect a conveyor',location:'Line A',valid_from:'2026-10-18T10:00:00Z',
      expires_at:'2026-10-26T11:00:00Z',
    };
    await expect(service.createPermit(context,dto,'permit-window')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires independent decision rationale before trying to approve a permit',async()=>{
    const dto={expected_version:2,action:'APPROVE',reason:'Looks okay'} as TransitionEhsPermitDto;
    await expect(service.transitionPermit(context,PERMIT,dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires incident idempotency key before persistence',async()=>{
    const dto:CreateEhsIncidentDto={
      incident_type:'NEAR_MISS',severity:'HIGH',title:'Loose machine guard',description:'Guard fastener came loose',
      location:'Line 2',occurred_at:'2026-10-18T10:00:00Z',
    };
    await expect(service.createIncident(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects incident due dates that precede the incident occurrence',async()=>{
    const dto:CreateEhsIncidentDto={
      incident_type:'UNSAFE_OBSERVATION',severity:'MEDIUM',title:'Oil on floor',description:'Leak near line end',
      location:'Line 2',occurred_at:'2026-10-18T10:00:00Z',due_at:'2026-10-17T10:00:00Z',
    };
    await expect(service.createIncident(context,dto,'incident-due')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires root cause and completion evidence before CAPA submission',async()=>{
    const dto={expected_version:2,action:'SUBMIT_FOR_VERIFICATION',reason:'Work done'} as TransitionEhsCorrectiveActionDto;
    await expect(service.transitionCorrectiveAction(context,ACTION,dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires structured evidence before independent CAPA verification',async()=>{
    const dto={expected_version:3,action:'VERIFY',reason:'Review done'} as TransitionEhsCorrectiveActionDto;
    await expect(service.transitionCorrectiveAction(context,ACTION,dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
