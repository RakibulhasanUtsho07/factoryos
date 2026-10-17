import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { ProductDefinitionsService } from './products.service';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const PRODUCT='69ef2a43-8157-4d91-aa59-7b4260ef1778';
const VERSION='34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM='522ecb02-3e23-4416-9d13-ed9dcd780b81';
const TRACE='f7168be2-1b73-42b3-a930-72c31b2d6050';

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
