import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SaasUsageService } from './saas-usage.service';

const tenant='faaab63d-c447-46ce-950d-deebdd7f5f30';
const factory='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const user='5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
function rate(extra:Record<string,unknown>={}){return {metric_code:'AI_INPUT_TOKEN',rate_version:1,rate_minor_per_block:40,block_quantity:1000,currency:'BDT',effective_from:'2026-10-01T00:00:00.000Z',idempotency_key:'rate-v1',...extra};}
function event(extra:Record<string,unknown>={}){return {metric_code:'AI_INPUT_TOKEN',capability_code:'ai.runtime.inference',workload_class:'PRODUCTION',quantity:1250,occurred_at:'2026-10-10T12:00:00.000Z',source_system:'AI_GATEWAY',source_event_ref:'ai:request:1',idempotency_key:'event-v1',...extra};}
describe('SaasUsageService',()=>{
 const db={query:jest.fn<(q:string,v?:unknown[],c?:unknown)=>Promise<{rows:unknown[]}>>()};
 const iam={authorize:jest.fn<(...a:unknown[])=>Promise<void>>()};
 const audit={record:jest.fn<(...a:unknown[])=>Promise<string>>()};
 let service:SaasUsageService;
 beforeEach(()=>{jest.clearAllMocks();db.query.mockReset();iam.authorize.mockResolvedValue(undefined);audit.record.mockResolvedValue('audit');service=new SaasUsageService(db as never,iam as never,audit as never);});
 it('authorizes metering writes before reading or writing rate/event records',async()=>{iam.authorize.mockRejectedValueOnce(new ForbiddenException('denied'));await expect(service.recordUsageEvent(tenant,factory,user,event() as never)).rejects.toBeInstanceOf(ForbiddenException);expect(db.query).not.toHaveBeenCalled();});
 it('rejects invalid quantities without database access',async()=>{await expect(service.recordUsageEvent(tenant,factory,user,event({quantity:0}) as never)).rejects.toBeInstanceOf(BadRequestException);expect(db.query).not.toHaveBeenCalled();});
 it('fails closed when an idempotency key is reused for a different usage event',async()=>{db.query.mockResolvedValueOnce({rows:[{id:'e',request_hash:'0'.repeat(64)}]});await expect(service.recordUsageEvent(tenant,factory,user,event() as never)).rejects.toBeInstanceOf(ConflictException);expect(db.query).toHaveBeenCalledTimes(1);});
 it('prices metered usage from the rate effective at event time and records a source fingerprint',async()=>{db.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'r',tenant_id:tenant,metric_code:'AI_INPUT_TOKEN',rate_version:1,rate_minor_per_block:'40',block_quantity:'1000.000000',currency:'BDT',effective_from:'2026-10-01T00:00:00.000Z',idempotency_key:'rate-v1',request_hash:'a'.repeat(64),created_by:user,created_at:'2026-10-01T00:00:00.000Z'}]}).mockResolvedValueOnce({rows:[{id:'e',tenant_id:tenant,factory_id:factory,metric_code:'AI_INPUT_TOKEN',capability_code:'ai.runtime.inference',workload_class:'PRODUCTION',quantity:'1250.000000',occurred_at:'2026-10-10T12:00:00.000Z',source_system:'AI_GATEWAY',source_event_ref:'ai:request:1',rate_card_id:'r',rate_version_snapshot:1,rate_minor_per_block_snapshot:'40',rate_block_quantity_snapshot:'1000',currency:'BDT',estimated_cost_minor:'50',request_hash:'b'.repeat(64),idempotency_key:'event-v1',recorded_by:user,created_at:'2026-10-10T12:00:01Z'}]}).mockResolvedValueOnce({rows:[]});const result=await service.recordUsageEvent(tenant,factory,user,event() as never);expect(result.event.estimatedCostMinor).toBe('50');expect(result.event.billable).toBe(true);expect(db.query.mock.calls[2]?.[1]?.[14]).toBe(50);});
 it('calculates metered costs with exact fixed-point half-up rounding',()=>{
  expect((service as any).calculateUsageCostMinor('1.000000','2.000000','1')).toBe(1);
  expect((service as any).calculateUsageCostMinor('1.000000','3.000000','1')).toBe(0);
  expect((service as any).calculateUsageCostMinor('2.000000','3.000000','1')).toBe(1);
  expect((service as any).calculateUsageCostMinor('0.000002','0.000004','1')).toBe(1);
 });

 it('rejects quantities that exceed the database six-decimal precision instead of silently rounding',async()=>{
  await expect(service.recordUsageEvent(tenant,factory,user,event({quantity:0.0000001}) as never)).rejects.toBeInstanceOf(BadRequestException);
  expect(db.query).not.toHaveBeenCalled();
 });

 it('rejects rate block sizes that exceed numeric storage precision',async()=>{
  await expect(service.createRateCard(tenant,user,rate({block_quantity:0.0000001}) as never)).rejects.toBeInstanceOf(BadRequestException);
  expect(db.query).not.toHaveBeenCalled();
 });

 it('reconciles provider invoice totals above Number safe-integer precision without rounding',async()=>{
  const invoiceReference='INV-OVER-SAFE';
  const idempotencyKey='provider-recon-over-safe';
  db.query
   .mockResolvedValueOnce({rows:[]})
   .mockResolvedValueOnce({rows:[{event_count:'2',ledger_cost_minor:'9007199254740993'}]})
   .mockResolvedValueOnce({rows:[{
    id:'provider-reconciliation',tenant_id:tenant,factory_id:factory,provider_code:'openai',
    invoice_reference:invoiceReference,reconciliation_version:1,
    period_start:'2026-10-01T00:00:00.000Z',period_end:'2026-10-03T00:00:00.000Z',
    currency:'USD',event_count:'2',ledger_provider_cost_minor:'9007199254740993',
    invoiced_provider_cost_minor:'9000000000000000',variance_minor:'-7199254740993',
    status:'VARIANCE',report_hash:'a'.repeat(64),request_hash:'b'.repeat(64),
    idempotency_key:idempotencyKey,recorded_by:user,created_at:'2026-10-03T00:00:00.000Z',
   }]});
  const result=await service.reconcileProviderCostInvoice(tenant,factory,user,{
   provider_code:'openai',invoice_reference:invoiceReference,reconciliation_version:1,
   period_start:'2026-10-01T00:00:00.000Z',period_end:'2026-10-03T00:00:00.000Z',
   currency:'USD',invoiced_provider_cost_minor:9000000000000000,idempotency_key:idempotencyKey,
  } as never);
  expect(result.reconciliation.ledgerProviderCostMinor).toBe('9007199254740993');
  expect(result.reconciliation.varianceMinor).toBe('-7199254740993');
  expect(db.query.mock.calls[2]?.[1]?.[9]).toBe('9007199254740993');
  expect(db.query.mock.calls[2]?.[1]?.[11]).toBe('-7199254740993');
 });

 it('evaluates current budget time when a historical usage event arrives',async()=>{
  const historicalEvent=event({occurred_at:'2020-01-01T00:00:00.000Z'});
  const evaluated=jest.spyOn(service as any,'evaluateBudgetsInternal').mockResolvedValue([]);
  const before=Date.now();
  db.query
   .mockResolvedValueOnce({rows:[]})
   .mockResolvedValueOnce({rows:[]})
   .mockResolvedValueOnce({rows:[{
    id:'historical-event',tenant_id:tenant,factory_id:factory,metric_code:'AI_INPUT_TOKEN',
    capability_code:'ai.runtime.inference',workload_class:'PRODUCTION',quantity:'1250.000000',
    occurred_at:'2020-01-01T00:00:00.000Z',source_system:'AI_GATEWAY',source_event_ref:'ai:request:historical',
    rate_card_id:null,rate_version_snapshot:null,rate_minor_per_block_snapshot:null,
    rate_block_quantity_snapshot:null,currency:null,estimated_cost_minor:null,
    request_hash:'a'.repeat(64),idempotency_key:'historical-event',recorded_by:user,
    created_at:'2026-10-20T00:00:00.000Z',
   }]});
  await service.recordUsageEvent(tenant,factory,user,historicalEvent as never);
  const evaluatedAt=Date.parse(String(evaluated.mock.calls[0]?.[3]));
  expect(evaluated).toHaveBeenCalledTimes(1);
  expect(evaluatedAt).toBeGreaterThanOrEqual(before);
  expect(evaluatedAt).not.toBe(Date.parse('2020-01-01T00:00:00.000Z'));
 });

 it('rejects adjustments that do not change quantity or cost before any database call',async()=>{await expect(service.createAdjustment(tenant,factory,user,{period_start:'2026-10-01T00:00:00Z',period_end:'2026-10-31T00:00:00Z',quantity_delta:0,cost_delta_minor:0,currency:'BDT',reason_code:'OTHER',reason:'No-op',idempotency_key:'adjustment-noop'} as never)).rejects.toBeInstanceOf(BadRequestException);expect(db.query).not.toHaveBeenCalled();});
 it('requires a bounded reconciliation period',async()=>{await expect(service.reconcileInvoice(tenant,factory,user,{invoice_reference:'INV-1',reconciliation_version:1,period_start:'2026-01-01T00:00:00Z',period_end:'2026-03-01T00:00:00Z',currency:'BDT',invoiced_amount_minor:100,idempotency_key:'recon-too-long'} as never)).rejects.toBeInstanceOf(BadRequestException);expect(db.query).not.toHaveBeenCalled();});
 it('rejects invalid budget limits before database access',async()=>{await expect(service.createBudget(tenant,null,user,{budget_code:'ai-monthly',policy_version:1,period_kind:'MONTHLY',scope_level:'TENANT',currency:'BDT',soft_limit_minor:500,hard_limit_minor:100,effective_from:'2026-10-01T00:00:00Z',idempotency_key:'budget-invalid'} as never)).rejects.toBeInstanceOf(BadRequestException);expect(db.query).not.toHaveBeenCalled();});
 it('does not permit production/NON_AI classes in a workload-pause request',async()=>{await expect(service.setWorkloadControl(tenant,null,user,{workload_class:'PRODUCTION',control_state:'PAUSED',scope_level:'TENANT',reason:'test',idempotency_key:'pause-production'} as never)).rejects.toBeInstanceOf(BadRequestException);expect(db.query).not.toHaveBeenCalled();});
 it('fails closed for a non-critical AI class with an active pause control',async()=>{db.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{control_state:'PAUSED',factory_id:null}]});await expect(service.assertWorkloadExecutionAllowed(tenant,factory,user,'DEVELOPMENT')).rejects.toBeInstanceOf(ForbiddenException);});
 it('fails closed for unsupported workload classes rather than applying an ambiguous pause policy',async()=>{await expect(service.assertWorkloadExecutionAllowed(tenant,factory,user,'PRODUCTION')).rejects.toBeInstanceOf(ConflictException);expect(db.query).not.toHaveBeenCalled();});

 it('rejects unsafe provider invoice costs before touching the database',async()=>{await expect(service.recordProviderCostEvent(tenant,factory,user,{provider_code:'openai',metric_code:'AI_INPUT_TOKEN',workload_class:'PRODUCTION',quantity:1,currency:'USD',provider_cost_minor:9007199254740992,occurred_at:'2026-10-10T12:00:00Z',provider_invoice_reference:'INV-1',source_system:'PROVIDER_EXPORT',source_event_ref:'provider:1',idempotency_key:'provider-unsafe'} as never)).rejects.toBeInstanceOf(BadRequestException);expect(db.query).not.toHaveBeenCalled();});
 it('rejects malformed alert identifiers before querying acknowledgement records',async()=>{await expect(service.acknowledgeBudgetAlert(tenant,factory,user,'not-a-uuid',{idempotency_key:'ack-invalid'} as never)).rejects.toBeInstanceOf(BadRequestException);expect(db.query).not.toHaveBeenCalled();});

 it('reconciles SaaS usage invoice totals above Number safe-integer precision without rounding',async()=>{
  const invoiceReference='INV-USAGE-OVER-SAFE';
  const idempotencyKey='usage-recon-over-safe';
  db.query
   .mockResolvedValueOnce({rows:[]})
   .mockResolvedValueOnce({rows:[{event_count:'1',unpriced_count:'0',ledger_sum:'9007199254740993',other_currency_count:'0'}]})
   .mockResolvedValueOnce({rows:[{adjustment_sum:'0'}]})
   .mockResolvedValueOnce({rows:[{
    id:'usage-reconciliation',tenant_id:tenant,factory_id:factory,invoice_reference:invoiceReference,
    reconciliation_version:1,period_start:'2026-10-01T00:00:00.000Z',period_end:'2026-10-03T00:00:00.000Z',
    currency:'BDT',event_count:'1',unpriced_event_count:'0',ledger_estimated_amount_minor:'9007199254740993',
    adjustment_amount_minor:'0',expected_amount_minor:'9007199254740993',invoiced_amount_minor:'9000000000000000',
    variance_minor:'-7199254740993',status:'VARIANCE',report_hash:'a'.repeat(64),request_hash:'b'.repeat(64),
    idempotency_key:idempotencyKey,recorded_by:user,created_at:'2026-10-03T00:00:00.000Z',
   }]});
  const result=await service.reconcileInvoice(tenant,factory,user,{
   invoice_reference:invoiceReference,reconciliation_version:1,
   period_start:'2026-10-01T00:00:00.000Z',period_end:'2026-10-03T00:00:00.000Z',
   currency:'BDT',invoiced_amount_minor:9000000000000000,idempotency_key:idempotencyKey,
  } as never);
  expect(result.reconciliation.expectedAmountMinor).toBe('9007199254740993');
  expect(result.reconciliation.varianceMinor).toBe('-7199254740993');
  expect(db.query.mock.calls[3]?.[1]?.[9]).toBe('9007199254740993');
  expect(db.query.mock.calls[3]?.[1]?.[11]).toBe('9007199254740993');
 });

 it('evaluates spend budgets with exact aggregates beyond Number safe-integer precision',async()=>{
  const cost='9007199254740993';
  const budgetRow={
   id:'budget-1',tenant_id:tenant,factory_id:null,budget_code:'AI-MONTHLY',policy_version:1,
   period_kind:'MONTHLY',metric_code:'AI_INPUT_TOKEN',capability_code:null,workload_class:null,currency:'BDT',
   soft_limit_minor:'8000000000000000',hard_limit_minor:'9000000000000000',pause_noncritical_on_hard_limit:false,
   anomaly_multiplier:'2.0000',anomaly_min_events:3,effective_from:'2026-01-01T00:00:00.000Z',
   effective_to:null,idempotency_key:'budget-idem',request_hash:'c'.repeat(64),created_by:user,created_at:'2026-01-01T00:00:00.000Z',
  };
  const evaluationRow={
   id:'evaluation-1',tenant_id:tenant,factory_id:null,budget_id:'budget-1',
   period_start:'2026-10-01T00:00:00.000Z',period_end:'2026-11-01T00:00:00.000Z',
   evaluated_at:'2026-10-20T00:00:00.000Z',event_count:'2',unpriced_event_count:'0',
   usage_cost_minor:cost,soft_limit_minor:'8000000000000000',hard_limit_minor:'9000000000000000',
   anomaly_window_cost_minor:'0',anomaly_baseline_hourly_minor:'0.0000',status:'HARD_LIMIT',
   report_hash:'d'.repeat(64),idempotency_key:'evaluation-idem',request_hash:'e'.repeat(64),
   evaluated_by:user,created_at:'2026-10-20T00:00:00.000Z',
  };
  db.query
   .mockResolvedValueOnce({rows:[budgetRow]})
   .mockResolvedValueOnce({rows:[{event_count:'2',unpriced_count:'0',cost_minor:cost}]})
   .mockResolvedValueOnce({rows:[{recent_count:'0',recent_cost:'0',baseline_count:'0',baseline_cost:'0'}]})
   .mockResolvedValueOnce({rows:[evaluationRow]})
   .mockResolvedValueOnce({rows:[]});
  const results=await (service as any).evaluateBudgetsInternal(tenant,factory,user,'2026-10-20T00:00:00.000Z');
  expect(results[0].usageCostMinor).toBe(cost);
  expect(results[0].status).toBe('HARD_LIMIT');
  expect(db.query.mock.calls[3]?.[1]?.[8]).toBe(cost);
 });

 it('lets a factory-level resume override a tenant-level pause for the same non-critical class',async()=>{
  db.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{control_state:'RESUMED',factory_id:factory},{control_state:'PAUSED',factory_id:null}]});
  await expect(service.assertWorkloadExecutionAllowed(tenant,factory,user,'DEVELOPMENT')).resolves.toBeUndefined();
  expect(db.query).toHaveBeenCalledTimes(2);
 });

});
