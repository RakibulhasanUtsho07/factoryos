import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { SupplierPerformanceService } from './supplier-performance.service';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const SUPPLIER='a0f10000-0000-4000-8000-000000000001';

describe('SupplierPerformanceService',()=>{
  function setup(report:Record<string,unknown>|null={supplier:{id:SUPPLIER,code:'SUP-1',name:'Supplier One'}}){
    const query=jest.fn().mockResolvedValue({rows:[{report}]});
    return {service:new SupplierPerformanceService({query} as unknown as DatabaseService),query};
  }
  it('uses authenticated tenant context and a read-only database transaction',async()=>{
    const {service,query}=setup();
    const report=await service.getSupplierPerformance(TENANT,FACTORY,SUPPLIER,{from:'2026-09-01',to:'2026-09-30',as_of:'2026-10-15'});
    expect(report.supplier).toMatchObject({id:SUPPLIER,code:'SUP-1'});
    expect(query).toHaveBeenCalledWith(expect.stringContaining('factoryos_supplier_performance_report'),
      [FACTORY,SUPPLIER,'2026-09-01','2026-09-30','2026-10-15'],{tenantId:TENANT,readOnly:true});
  });
  it('uses database UTC as-of date when as_of is omitted',async()=>{
    const {service,query}=setup();
    await service.getSupplierPerformance(TENANT,FACTORY,SUPPLIER,{from:'2026-01-01',to:'2026-01-01'});
    expect(query.mock.calls[0]?.[1]).toEqual([FACTORY,SUPPLIER,'2026-01-01','2026-01-01',null]);
  });
  it('rejects invalid calendar dates, reversed and excessive ranges',async()=>{
    const {service,query}=setup();
    await expect(service.getSupplierPerformance(TENANT,FACTORY,SUPPLIER,{from:'2026-02-30',to:'2026-03-01'})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getSupplierPerformance(TENANT,FACTORY,SUPPLIER,{from:'2026-03-02',to:'2026-03-01'})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getSupplierPerformance(TENANT,FACTORY,SUPPLIER,{from:'2025-01-01',to:'2026-01-02'})).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
  it('hides suppliers outside the authenticated tenant',async()=>{
    const {service}=setup({supplier:null});
    await expect(service.getSupplierPerformance(TENANT,FACTORY,SUPPLIER,{from:'2026-09-01',to:'2026-09-30'})).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects malformed factory identifier before querying',async()=>{
    const {service,query}=setup();
    await expect(service.getSupplierPerformance(TENANT,'bad-id',SUPPLIER,{from:'2026-09-01',to:'2026-09-30'})).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});
