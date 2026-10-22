import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EhsClosureService } from './ehs-closure.service';
import type {
  CreateEhsChemicalSdsDto, CreateEhsContractorInductionDto, CreateEhsEmergencyDrillDto,
} from './ehs-closure.dto';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('EhsClosureService request validation',()=>{
  let service:EhsClosureService;
  const database={transaction:jest.fn(),query:jest.fn()};
  beforeEach(()=>{jest.clearAllMocks();service=new EhsClosureService(database as unknown as DatabaseService);});

  it('requires an idempotency key before planning an emergency drill',async()=>{
    const dto:CreateEhsEmergencyDrillDto={
      drill_number:'DRILL-001',drill_type:'EVACUATION',title:'North block evacuation',
      location:'North block',planned_at:'2026-10-23T10:00:00Z',owner_user_id:USER,
    };
    await expect(service.createDrill(context,dto,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a controlled HTTPS or object-store URI for SDS records',async()=>{
    const dto:CreateEhsChemicalSdsDto={
      chemical_code:'CHEM-001',chemical_name:'Cleaning agent',hazard_class:'IRRITANT',
      storage_location:'Chemical room A',sds_revision:'REV-1',sds_document_uri:'file:///etc/passwd',
      sds_issued_at:'2026-10-01T00:00:00Z',sds_review_due_at:'2027-10-01T00:00:00Z',
      handling_instructions:'Use specified PPE',emergency_instructions:'Follow the site response plan',
    };
    await expect(service.createChemicalSds(context,dto,'chemical-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('does not permit an SDS revision review date before issue date',async()=>{
    const dto:CreateEhsChemicalSdsDto={
      chemical_code:'CHEM-002',chemical_name:'Solvent',hazard_class:'FLAMMABLE',
      storage_location:'Flammable cabinet',sds_revision:'REV-1',sds_document_uri:'https://sds.example.invalid/solvent.pdf',
      sds_issued_at:'2026-10-20T00:00:00Z',sds_review_due_at:'2026-10-19T00:00:00Z',
      handling_instructions:'Keep away from ignition sources',emergency_instructions:'Use approved spill response',
    };
    await expect(service.createChemicalSds(context,dto,'chemical-date-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires completed training topics and evidence before contractor induction is persisted',async()=>{
    const dto:CreateEhsContractorInductionDto={
      contractor_code:'CONT-001',company_name:'Contractor Ltd',person_name:'Test person',
      induction_at:'2026-10-20T09:00:00Z',expires_at:'2027-10-20T09:00:00Z',
      topics:['PPE','EMERGENCY-ROUTES'],evidence:{},
    };
    await expect(service.createContractorInduction(context,dto,'contractor-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects a future contractor induction rather than treating planned training as completed',async()=>{
    const dto:CreateEhsContractorInductionDto={
      contractor_code:'CONT-002',company_name:'Contractor Ltd',person_name:'Test person',
      induction_at:'2027-01-20T09:00:00Z',expires_at:'2027-10-20T09:00:00Z',
      topics:['PPE'],evidence:{trainer:'EHS owner',evidence_ref:'IND-001'},
    };
    await expect(service.createContractorInduction(context,dto,'contractor-future-key')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed factory context before any EHS closure query',async()=>{
    await expect(service.listDrills({...context,factoryId:'not-a-uuid'})).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });
});
