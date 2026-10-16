import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';
import { SaasUsageService } from './saas-usage.service';
interface ScopeRow{tenant_id:string;factory_id:string;user_id:string;}
describe('SaasUsageService PostgreSQL integration',()=>{
 let pool!:Pool,client!:PoolClient,service!:SaasUsageService,tenantId!:string,factoryId!:string,userId!:string;
 beforeAll(async()=>{const url=process.env.TEST_ADMIN_DATABASE_URL;if(!url)throw new Error('TEST_ADMIN_DATABASE_URL is required');pool=new Pool({connectionString:url});client=await pool.connect();await client.query('BEGIN');const scope=await client.query<ScopeRow>("SELECT t.id::text tenant_id,f.id::text factory_id,u.id::text user_id FROM tenants t JOIN factories f ON f.tenant_id=t.id JOIN tenant_memberships tm ON tm.tenant_id=t.id AND tm.status='ACTIVE' JOIN users u ON u.id=tm.user_id AND u.status='ACTIVE' WHERE t.status='ACTIVE' AND f.status='ACTIVE' ORDER BY t.created_at,f.created_at,u.created_at LIMIT 1");if(!scope.rows[0])throw new Error('No active tenant/factory/user fixture');tenantId=scope.rows[0].tenant_id;factoryId=scope.rows[0].factory_id;userId=scope.rows[0].user_id;const db={query:(q:string,v?:unknown[])=>client.query(q,v)},iam={authorize:jest.fn<(...a:unknown[])=>Promise<void>>().mockResolvedValue(undefined)},audit={record:jest.fn<(...a:unknown[])=>Promise<string>>().mockResolvedValue('audit')};service=new SaasUsageService(db as never,iam as never,audit as never);},60000);
 afterAll(async()=>{if(client){await client.query('ROLLBACK');client.release();}if(pool)await pool.end();});
 it('meters by effective rate, deduplicates events, applies adjustment and reconciles invoice at immutable snapshot',async()=>{
  const n=randomUUID(),start='2026-10-01T00:00:00.000Z',end='2026-10-31T23:59:59.999Z';
  const rate=await service.createRateCard(tenantId,userId,{metric_code:'AI_INPUT_TOKEN' as never,rate_version:1,rate_minor_per_block:40,block_quantity:1000,currency:'BDT',effective_from:start,idempotency_key:'rate-'+n} as never);
  expect(rate.rate.unit).toBe('token');
  const input={metric_code:'AI_INPUT_TOKEN' as never,capability_code:'ai.runtime.inference',workload_class:'PRODUCTION' as never,quantity:1250,occurred_at:'2026-10-10T12:00:00.000Z',source_system:'AI_GATEWAY' as never,source_event_ref:'ai:integration:'+n,idempotency_key:'event-'+n};
  const recorded=await service.recordUsageEvent(tenantId,factoryId,userId,input as never);
  expect(recorded.event.estimatedCostMinor).toBe('50');
  const duplicate=await service.recordUsageEvent(tenantId,factoryId,userId,input as never);
  expect(duplicate.idempotent).toBe(true);
  const adjustment=await service.createAdjustment(tenantId,factoryId,userId,{period_start:start,period_end:'2026-11-01T00:00:00.000Z',metric_code:'AI_INPUT_TOKEN' as never,quantity_delta:0,cost_delta_minor:-5,currency:'BDT',reason_code:'PRICING_CORRECTION' as never,reason:'Approved adjustment for contracted discount.',reference_ref:'credit-note:'+n,idempotency_key:'adjust-'+n} as never);
  expect(adjustment.adjustment.costDeltaMinor).toBe('-5');
  const report=await service.getUsageReport(tenantId,factoryId,userId,start,'2026-11-01T00:00:00.000Z');
  expect(report.eventCount).toBe(1);
  expect(report.events[0]?.quantity).toBe('1250.000000');
  expect(report.adjustments[0]?.costDeltaMinor).toBe('-5');
  const reconciled=await service.reconcileInvoice(tenantId,factoryId,userId,{invoice_reference:'INV-'+n,reconciliation_version:1,period_start:start,period_end:'2026-11-01T00:00:00.000Z',currency:'BDT',invoiced_amount_minor:45,idempotency_key:'recon-'+n} as never);
  expect(reconciled.reconciliation.status).toBe('MATCHED');
  expect(reconciled.reconciliation.expectedAmountMinor).toBe('45');
  expect(reconciled.reconciliation.varianceMinor).toBe('0');
  const replay=await service.reconcileInvoice(tenantId,factoryId,userId,{invoice_reference:'INV-'+n,reconciliation_version:1,period_start:start,period_end:'2026-11-01T00:00:00.000Z',currency:'BDT',invoiced_amount_minor:45,idempotency_key:'recon-'+n} as never);
  expect(replay.idempotent).toBe(true);
  await client.query('SAVEPOINT saas_usage_immutable');
  await expect(client.query('UPDATE saas_usage_events SET quantity=1 WHERE id=$1',[recorded.event.id])).rejects.toThrow('SaaS metering records are immutable');
  await client.query('ROLLBACK TO SAVEPOINT saas_usage_immutable');
 });
 it('marks an invoice reconciliation unpriced when a usage event has no effective rate',async()=>{
  const n=randomUUID(),start='2026-09-01T00:00:00.000Z',end='2026-09-30T23:59:59.999Z';
  await service.recordUsageEvent(tenantId,factoryId,userId,{metric_code:'TRANSACTION' as never,capability_code:'orders.create',workload_class:'NON_AI' as never,quantity:1,occurred_at:'2026-09-10T12:00:00.000Z',source_system:'API' as never,source_event_ref:'api:transaction:'+n,idempotency_key:'unpriced-'+n} as never);
  const result=await service.reconcileInvoice(tenantId,factoryId,userId,{invoice_reference:'INV-UNPRICED-'+n,reconciliation_version:1,period_start:start,period_end:'2026-10-01T00:00:00.000Z',currency:'BDT',invoiced_amount_minor:100,idempotency_key:'recon-unpriced-'+n} as never);
  expect(result.reconciliation.status).toBe('UNPRICED_USAGE');
  expect(result.reconciliation.expectedAmountMinor).toBe(null);
  expect(result.reconciliation.unpricedEventCount).toBe(1);
 });
 it('creates immutable daily budgets, detects hard-limit spend and pauses only non-critical workloads',async()=>{
  const n=randomUUID(),start='2026-10-01T00:00:00.000Z';
  await service.createRateCard(tenantId,userId,{metric_code:'AI_TOOL_CALL' as never,rate_version:1,rate_minor_per_block:2,block_quantity:1,currency:'BDT',effective_from:start,idempotency_key:'budget-rate-'+n} as never);
  const budget=await service.createBudget(tenantId,factoryId,userId,{budget_code:'ai-tool-daily-'+n,policy_version:1,period_kind:'DAILY',scope_level:'FACTORY',metric_code:'AI_TOOL_CALL',currency:'BDT',soft_limit_minor:20,hard_limit_minor:30,pause_noncritical_on_hard_limit:true,effective_from:start,idempotency_key:'budget-policy-'+n} as never);
  expect(budget.budget.factoryId).toBe(factoryId);
  await service.recordUsageEvent(tenantId,factoryId,userId,{metric_code:'AI_TOOL_CALL' as never,capability_code:'ai.runtime.tool',workload_class:'DEVELOPMENT' as never,quantity:20,occurred_at:new Date().toISOString(),source_system:'TOOL_GATEWAY' as never,source_event_ref:'tool:budget:'+n,idempotency_key:'budget-usage-'+n} as never);
  const result=await service.evaluateBudgets(tenantId,factoryId,userId);
  expect(result.evaluations.some((x:any)=>x.status==='HARD_LIMIT')).toBe(true);
  const controls=await service.listWorkloadControls(tenantId,factoryId,userId);
  expect(controls.controls.some((x:any)=>x.state==='PAUSED'&&x.workloadClass==='DEVELOPMENT')).toBe(true);
  await expect(service.assertWorkloadExecutionAllowed(tenantId,factoryId,userId,'DEVELOPMENT')).rejects.toThrow('paused');
  await expect(service.assertWorkloadExecutionAllowed(tenantId,factoryId,userId,'PRODUCTION')).rejects.toThrow();
  const inbox=await service.listBudgetAlerts(tenantId,factoryId,userId,25,0,true);
  const hardAlert=inbox.alerts.find((a:any)=>a.type==='HARD_LIMIT');
  expect(hardAlert).toBeDefined();
  await service.acknowledgeBudgetAlert(tenantId,factoryId,userId,hardAlert.id,{idempotency_key:'alert-ack-'+n} as never);
  const unread=await service.listBudgetAlerts(tenantId,factoryId,userId,25,0,true);
  expect(unread.alerts.some((a:any)=>a.id===hardAlert.id)).toBe(false);
 });

 it('records provider-reported AI costs idempotently and reconciles them to a provider invoice',async()=>{
  const n=randomUUID(),now=new Date(),start=new Date(now);start.setUTCHours(0,0,0,0);const end=new Date(start.getTime()+86400000);
  const occurredAt=now.toISOString(),periodStart=start.toISOString(),periodEnd=end.toISOString(),invoice='OPENAI-'+n;
  const input={provider_code:'openai',model_code:'gpt-test',metric_code:'AI_INPUT_TOKEN' as never,workload_class:'PRODUCTION' as never,quantity:3000,currency:'USD',provider_cost_minor:150,occurred_at:occurredAt,provider_invoice_reference:invoice,source_system:'PROVIDER_EXPORT' as never,source_event_ref:'provider-event:'+n,idempotency_key:'provider-cost-'+n};
  const first=await service.recordProviderCostEvent(tenantId,factoryId,userId,input as never);
  expect(first.event.providerCostMinor).toBe('150');
  const duplicate=await service.recordProviderCostEvent(tenantId,factoryId,userId,input as never);
  expect(duplicate.idempotent).toBe(true);
  const reconciled=await service.reconcileProviderCostInvoice(tenantId,factoryId,userId,{provider_code:'openai',invoice_reference:invoice,reconciliation_version:1,period_start:periodStart,period_end:periodEnd,currency:'USD',invoiced_provider_cost_minor:150,idempotency_key:'provider-reconcile-'+n} as never);
  expect(reconciled.reconciliation.status).toBe('MATCHED');
  expect(reconciled.reconciliation.varianceMinor).toBe('0');
  const differentInvoiceTotal=await service.reconcileProviderCostInvoice(tenantId,factoryId,userId,{provider_code:'openai',invoice_reference:invoice,reconciliation_version:2,period_start:periodStart,period_end:periodEnd,currency:'USD',invoiced_provider_cost_minor:175,idempotency_key:'provider-reconcile-var-'+n} as never);
  expect(differentInvoiceTotal.reconciliation.status).toBe('VARIANCE');
  expect(differentInvoiceTotal.reconciliation.varianceMinor).toBe('25');
 });

});
