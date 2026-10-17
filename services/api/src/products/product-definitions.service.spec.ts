import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { ProductDefinitionsService, type VersionRow } from './products.service';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const PRODUCT='69ef2a43-8157-4d91-aa59-7b4260ef1778';
const VERSION='34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM='522ecb02-3e23-4416-9d13-ed9dcd780b81';
const TRACE='f7168be2-1b73-42b3-a930-72c31b2d6050';
const OLD_VERSION='e1111111-1111-4111-8111-111111111111';

function makeVersion(overrides:Partial<VersionRow>={}):VersionRow {
  return {
    id:VERSION,tenant_id:TENANT,factory_id:FACTORY,product_id:PRODUCT,version_number:2,
    state:'DRAFT',effective_from:'2026-11-01',effective_to:null,effective_to_override:null,
    superseded_by_version_id:null,expected_yield_percent:'98.5000',change_summary:'Engineering revision',
    row_version:'1',idempotency_key:'version-draft-key',request_hash:'a'.repeat(64),
    approval_idempotency_key:null,approval_request_hash:null,retirement_idempotency_key:null,
    retirement_request_hash:null,created_by_user_id:TRACE,updated_by_user_id:TRACE,
    approved_by_user_id:null,approved_at:null,created_at:'2026-10-01T00:00:00.000Z',
    updated_at:'2026-10-01T00:00:00.000Z',...overrides,
  };
}


describe('ProductDefinitionsService request contracts',()=>{
  let service:ProductDefinitionsService;
  let database:{transaction:ReturnType<typeof jest.fn>;query:ReturnType<typeof jest.fn>};
  let audit:{record:ReturnType<typeof jest.fn>};
  beforeEach(()=>{
    database={transaction:jest.fn(),query:jest.fn()};
    audit={record:jest.fn()};
    service=new ProductDefinitionsService(database as unknown as DatabaseService,audit as unknown as AuditService);
  });

  it('rejects malformed authenticated scope before any database call',async()=>{
    await expect(service.listProducts('not-a-uuid',TENANT,FACTORY)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for product creation',async()=>{
    await expect(service.createProduct(USER,TENANT,FACTORY,{
      inventory_item_id:ITEM,product_code:'FG-01',product_name:'Finished Good',base_unit:'PCS',
    },null,null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid dates when resolving an effective product version',async()=>{
    await expect(service.getEffectiveVersion(USER,TENANT,FACTORY,PRODUCT,'2026-02-30')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('supersedes the overlapping approved revision at the day before the new effective date',async()=>{
    const previous=makeVersion({
      id:OLD_VERSION,version_number:1,state:'APPROVED',effective_from:'2026-01-01',effective_to:null,
      row_version:'4',idempotency_key:'previous-version-key',created_by_user_id:ITEM,updated_by_user_id:ITEM,
      approved_by_user_id:TRACE,approved_at:'2026-01-01T00:00:00.000Z',
      approval_idempotency_key:'previous-approval-key',approval_request_hash:'b'.repeat(64),
    });
    const superseded=makeVersion({
      ...previous,state:'RETIRED',row_version:'5',updated_by_user_id:USER,
      effective_to_override:'2026-10-31',superseded_by_version_id:VERSION,
      retirement_idempotency_key:`system:superseded:${VERSION}`,retirement_request_hash:'c'.repeat(64),
    });
    const approved=makeVersion({
      state:'APPROVED',row_version:'2',updated_by_user_id:USER,
      approved_by_user_id:USER,approved_at:'2026-10-17T00:00:00.000Z',
      approval_idempotency_key:'release-key',approval_request_hash:'d'.repeat(64),
    });
    type MockQueryResult={rows:Array<Record<string,unknown>>};
    const query=jest.fn<(...args:unknown[])=>Promise<MockQueryResult>>();
    query.mockResolvedValueOnce({rows:[{id:PRODUCT,status:'ACTIVE'}]});
    query.mockResolvedValueOnce({rows:[makeVersion()]});
    query.mockResolvedValueOnce({rows:[]});
    query.mockResolvedValueOnce({rows:[previous]});
    query.mockResolvedValueOnce({rows:[superseded]});
    query.mockResolvedValueOnce({rows:[]});
    query.mockResolvedValueOnce({rows:[approved]});
    query.mockResolvedValueOnce({rows:[]});
    database.transaction.mockImplementation(async (...args:unknown[])=>{
      const run=args[1] as (client:unknown)=>Promise<unknown>;
      return run({query});
    });

    const result=await service.approveVersion(USER,TENANT,FACTORY,PRODUCT,VERSION,{expected_version:1},'release-key',null,null);

    expect(result.replayed).toBe(false);
    expect(result.version.state).toBe('APPROVED');
    expect(result.supersededVersions).toHaveLength(1);
    expect(result.supersededVersions[0]?.effective_to_override).toBe('2026-10-31');
    expect(query.mock.calls[4]?.[0]).toContain('effective_to_override');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action:'PRODUCT_VERSION_SUPERSEDED'}));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action:'PRODUCT_VERSION_APPROVED'}));
  });

  it('resolves historical dates through the immutable effective-end override',async()=>{
    const historical=makeVersion({
      id:OLD_VERSION,version_number:1,state:'RETIRED',effective_from:'2026-01-01',
      effective_to_override:'2026-10-31',superseded_by_version_id:VERSION,row_version:'5',
    });
    database.query.mockResolvedValueOnce({rows:[historical]});
    const query=jest.fn()
      .mockResolvedValueOnce({rows:[historical]})
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]});
    database.transaction.mockImplementation(async (...args:unknown[])=>{
      const run=args[1] as (client:unknown)=>Promise<unknown>;
      return run({query});
    });

    const result=await service.getEffectiveVersion(USER,TENANT,FACTORY,PRODUCT,'2026-10-15');

    expect(database.query.mock.calls[0]?.[0]).toContain("state IN ('APPROVED','RETIRED')");
    expect(database.query.mock.calls[0]?.[0]).toContain('COALESCE(effective_to_override,effective_to)');
    expect(result.version.id).toBe(OLD_VERSION);
    expect(result.version.effective_to_override).toBe('2026-10-31');
  });

  it('rejects impossible effective date windows before opening a transaction',async()=>{
    await expect(service.createVersion(USER,TENANT,FACTORY,PRODUCT,{
      effective_from:'2026-10-20',effective_to:'2026-10-19',expected_yield_percent:98.5,change_summary:'Revision',
    },'version-key',null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid calendar dates rather than normalizing them silently',async()=>{
    await expect(service.createVersion(USER,TENANT,FACTORY,PRODUCT,{
      effective_from:'2026-02-30',effective_to:null,expected_yield_percent:98.5,change_summary:'Revision',
    },'version-key',null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires distinct positive BOM line numbers',async()=>{
    await expect(service.replaceBom(USER,TENANT,FACTORY,PRODUCT,VERSION,{
      expected_version:1,lines:[
        {line_number:1,component_item_id:ITEM,quantity_per:1,unit:'PCS'},
        {line_number:1,component_item_id:TRACE,quantity_per:2,unit:'PCS'},
      ],
    },null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects material quantities that exceed supported decimal precision',async()=>{
    await expect(service.replaceBom(USER,TENANT,FACTORY,PRODUCT,VERSION,{
      expected_version:1,lines:[{line_number:1,component_item_id:ITEM,quantity_per:1.00001,unit:'PCS'}],
    },null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires unique routing step numbers',async()=>{
    await expect(service.replaceRouting(USER,TENANT,FACTORY,PRODUCT,VERSION,{
      expected_version:1,steps:[
        {step_number:1,operation_code:'CUT',operation_name:'Cut',work_centre_id:ITEM,run_minutes_per_unit:2},
        {step_number:1,operation_code:'SEW',operation_name:'Sew',work_centre_id:TRACE,run_minutes_per_unit:3},
      ],
    },null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects routing steps whose total planned duration is zero',async()=>{
    await expect(service.replaceRouting(USER,TENANT,FACTORY,PRODUCT,VERSION,{
      expected_version:1,steps:[{step_number:1,operation_code:'CUT',operation_name:'Cut',work_centre_id:ITEM}],
    },null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key to retire an alternate material contract',async()=>{
    await expect(service.retireAlternate(USER,TENANT,FACTORY,PRODUCT,VERSION,TRACE,{
      expected_version:1,
    },null,null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects a zero alternate-material conversion factor',async()=>{
    await expect(service.createAlternate(USER,TENANT,FACTORY,PRODUCT,VERSION,TRACE,{
      expected_version:1,alternate_item_id:ITEM,conversion_factor:0,unit:'PCS',rationale:'Substitute',
    },'alternate-key',null,null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects limits outside the shared API boundary',async()=>{
    await expect(service.listWorkCentres(USER,TENANT,FACTORY,101)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });
});
