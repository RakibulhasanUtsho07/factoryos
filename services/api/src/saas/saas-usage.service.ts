import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { CreateSaasMeterRateDto, SaasMeterMetric } from './dto/create-saas-meter-rate.dto';
import { CreateSaasUsageAdjustmentDto, SaasAdjustmentReasonCode } from './dto/create-saas-usage-adjustment.dto';
import { ReconcileSaasUsageDto } from './dto/reconcile-saas-usage.dto';
import { RecordSaasUsageEventDto, SaasUsageSourceSystem, SaasWorkloadClass } from './dto/record-saas-usage-event.dto';
import { CreateSaasUsageBudgetDto, SaasBudgetPeriodKind } from './dto/create-saas-usage-budget.dto';
import { SetSaasWorkloadControlDto, SaasNonCriticalWorkloadClass } from './dto/set-saas-workload-control.dto';

type RateRow = QueryResultRow & {
 id:string; tenant_id:string; metric_code:SaasMeterMetric; rate_version:number; rate_minor_per_block:string|number;
 block_quantity:string|number; currency:string; effective_from:string; idempotency_key:string; request_hash:string;
 created_by:string; created_at:string;
};
type UsageRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; metric_code:SaasMeterMetric; capability_code:string; workload_class:SaasWorkloadClass;
 quantity:string|number; occurred_at:string; source_system:SaasUsageSourceSystem; source_event_ref:string;
 rate_card_id:string|null; rate_version_snapshot:number|null; rate_minor_per_block_snapshot:string|number|null;
 rate_block_quantity_snapshot:string|number|null; currency:string|null; estimated_cost_minor:string|number|null;
 request_hash:string; idempotency_key:string; recorded_by:string; created_at:string;
};
type AdjustmentRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; period_start:string; period_end:string; metric_code:SaasMeterMetric|null;
 quantity_delta:string|number; cost_delta_minor:string|number; currency:string; reason_code:SaasAdjustmentReasonCode;
 reason:string; reference_ref:string|null; request_hash:string; idempotency_key:string; created_by:string; created_at:string;
};
type ReconciliationRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; invoice_reference:string; reconciliation_version:number;
 period_start:string; period_end:string; currency:string; event_count:string|number; unpriced_event_count:string|number;
 ledger_estimated_amount_minor:string|number|null; adjustment_amount_minor:string|number; expected_amount_minor:string|number|null;
 invoiced_amount_minor:string|number; variance_minor:string|number|null; status:'MATCHED'|'VARIANCE'|'UNPRICED_USAGE';
 report_hash:string; request_hash:string; idempotency_key:string; recorded_by:string; created_at:string;
};

type BudgetRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; budget_code:string; policy_version:number; period_kind:SaasBudgetPeriodKind;
 metric_code:SaasMeterMetric|null; capability_code:string|null; workload_class:SaasWorkloadClass|null; currency:string;
 soft_limit_minor:string|number; hard_limit_minor:string|number; pause_noncritical_on_hard_limit:boolean;
 anomaly_multiplier:string|number; anomaly_min_events:number; effective_from:string; effective_to:string|null;
 idempotency_key:string; request_hash:string; created_by:string; created_at:string;
};
type BudgetEvaluationRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; budget_id:string; period_start:string; period_end:string; evaluated_at:string;
 event_count:string|number; unpriced_event_count:string|number; usage_cost_minor:string|number;
 soft_limit_minor:string|number; hard_limit_minor:string|number; anomaly_window_cost_minor:string|number;
 anomaly_baseline_hourly_minor:string|number; status:'SAFE'|'WARNING'|'HARD_LIMIT'|'UNPRICED_USAGE'|'ANOMALY';
 report_hash:string; idempotency_key:string; request_hash:string; evaluated_by:string; created_at:string;
};

const METRICS = new Set<string>(Object.values(SaasMeterMetric));
const WORKLOADS = new Set<string>(Object.values(SaasWorkloadClass));
const SOURCES = new Set<string>(Object.values(SaasUsageSourceSystem));
const REASONS = new Set<string>(Object.values(SaasAdjustmentReasonCode));
const UNITS:Record<SaasMeterMetric,string> = {
 ACTIVE_USER:'user', ROLE_ASSIGNMENT:'role_assignment', TRANSACTION:'transaction',
 STORAGE_BYTE_HOUR:'byte_hour', TELEMETRY_EVENT:'event', AI_INPUT_TOKEN:'token',
 AI_OUTPUT_TOKEN:'token', AI_TOOL_CALL:'tool_call', PREMIUM_WORKLOAD:'workload_unit',
 INTEGRATION_CALL:'call', EDGE_INFERENCE:'inference',
};
const RATE_COLUMNS='id::text AS id,tenant_id::text AS tenant_id,metric_code,rate_version,rate_minor_per_block::text AS rate_minor_per_block,block_quantity::text AS block_quantity,currency,effective_from::text AS effective_from,idempotency_key,request_hash,created_by::text AS created_by,created_at::text AS created_at';
const USAGE_COLUMNS='id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,metric_code,capability_code,workload_class,quantity::text AS quantity,occurred_at::text AS occurred_at,source_system,source_event_ref,rate_card_id::text AS rate_card_id,rate_version_snapshot,rate_minor_per_block_snapshot::text AS rate_minor_per_block_snapshot,rate_block_quantity_snapshot::text AS rate_block_quantity_snapshot,currency,estimated_cost_minor::text AS estimated_cost_minor,request_hash,idempotency_key,recorded_by::text AS recorded_by,created_at::text AS created_at';
const ADJUSTMENT_COLUMNS='id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,period_start::text AS period_start,period_end::text AS period_end,metric_code,quantity_delta::text AS quantity_delta,cost_delta_minor::text AS cost_delta_minor,currency,reason_code,reason,reference_ref,request_hash,idempotency_key,created_by::text AS created_by,created_at::text AS created_at';
const RECONCILIATION_COLUMNS='id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,invoice_reference,reconciliation_version,period_start::text AS period_start,period_end::text AS period_end,currency,event_count,unpriced_event_count,ledger_estimated_amount_minor::text AS ledger_estimated_amount_minor,adjustment_amount_minor::text AS adjustment_amount_minor,expected_amount_minor::text AS expected_amount_minor,invoiced_amount_minor::text AS invoiced_amount_minor,variance_minor::text AS variance_minor,status,report_hash,request_hash,idempotency_key,recorded_by::text AS recorded_by,created_at::text AS created_at';

@Injectable()
export class SaasUsageService {
 constructor(private readonly database:DatabaseService,private readonly iamService:IamService,private readonly auditService:AuditService) {}

 async createRateCard(tenantId:string,actorUserId:string,input:CreateSaasMeterRateDto) {
  this.scope(tenantId,actorUserId);
  await this.authorize(actorUserId,tenantId,'saas.rates.write');
  const n=this.normalizeRate(input), {idempotency_key:key,...content}=n, hash=this.hash({tenantId,...content});
  const prior=await this.database.query<RateRow>('SELECT '+RATE_COLUMNS+' FROM saas_usage_rate_cards WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,key],{tenantId,userId:actorUserId});
  if(prior.rows[0]) {if(prior.rows[0].request_hash!==hash)throw new ConflictException('Rate idempotency key was reused for different content');return {idempotent:true,rate:this.mapRate(prior.rows[0])};}
  const insert=await this.database.query<RateRow>(
   'INSERT INTO saas_usage_rate_cards(tenant_id,metric_code,rate_version,rate_minor_per_block,block_quantity,currency,effective_from,idempotency_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING '+RATE_COLUMNS,
   [tenantId,n.metric_code,n.rate_version,n.rate_minor_per_block,n.block_quantity,n.currency,n.effective_from,key,hash,actorUserId],{tenantId,userId:actorUserId});
  let row=insert.rows[0];
  if(!row) {
   const conflict=await this.database.query<RateRow>('SELECT '+RATE_COLUMNS+' FROM saas_usage_rate_cards WHERE tenant_id=$1 AND ((metric_code=$2 AND rate_version=$3) OR (metric_code=$2 AND effective_from=$4)) LIMIT 1',[tenantId,n.metric_code,n.rate_version,n.effective_from],{tenantId,userId:actorUserId});
   if(conflict.rows[0])throw new ConflictException('Rate version or effective timestamp already exists');
   throw new ConflictException('Rate was concurrently written; retry with the same idempotency key');
  }
  await this.auditSafely({tenantId,actorUserId,eventType:'SAAS_USAGE_RATE',action:'CREATE_EFFECTIVE_DATED_RATE',resourceType:'SAAS_USAGE_RATE_CARD',resourceId:row.id,payload:{metricCode:row.metric_code,rateVersion:row.rate_version,currency:row.currency,effectiveFrom:row.effective_from,requestHash:hash}});
  return {idempotent:false,rate:this.mapRate(row)};
 }

 async listRateCards(tenantId:string,actorUserId:string,metricCode?:string) {
  this.scope(tenantId,actorUserId);await this.authorize(actorUserId,tenantId,'saas.usage.read');
  if(metricCode!==undefined)this.enum(metricCode,METRICS,'metric_code');
  const r=await this.database.query<RateRow>('SELECT '+RATE_COLUMNS+' FROM saas_usage_rate_cards WHERE tenant_id=$1 AND ($2::text IS NULL OR metric_code=$2) ORDER BY metric_code, effective_from DESC, rate_version DESC',[tenantId,metricCode??null],{tenantId,userId:actorUserId});
  return {count:r.rows.length,rates:r.rows.map(x=>this.mapRate(x))};
 }

 async recordUsageEvent(tenantId:string,factoryId:string|null,actorUserId:string,input:RecordSaasUsageEventDto) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.usage.write');
  const n=this.normalizeEvent(input), hash=this.hash({tenantId,factoryId,...n.content});
  const existing=await this.database.query<UsageRow>('SELECT '+USAGE_COLUMNS+' FROM saas_usage_events WHERE tenant_id=$1 AND (idempotency_key=$2 OR (source_system=$3 AND source_event_ref=$4)) LIMIT 1',[tenantId,n.idempotency_key,n.content.source_system,n.content.source_event_ref],{tenantId,userId:actorUserId});
  if(existing.rows[0]) {if(existing.rows[0].request_hash!==hash)throw new ConflictException('Usage idempotency key or source event reference was reused for different content');return {idempotent:true,event:this.mapUsage(existing.rows[0])};}
  const effectiveRate=await this.database.query<RateRow>('SELECT '+RATE_COLUMNS+' FROM saas_usage_rate_cards WHERE tenant_id=$1 AND metric_code=$2 AND effective_from <= $3 ORDER BY effective_from DESC,rate_version DESC LIMIT 1',[tenantId,n.content.metric_code,n.content.occurred_at],{tenantId,userId:actorUserId});
  const rate=effectiveRate.rows[0]??null;
  let rateId:string|null=null, rateVersion:number|null=null, rateAmount:number|null=null, rateBlock:number|null=null, currency:string|null=null, cost:number|null=null;
  if(rate) {
   if(UNITS[rate.metric_code]!==UNITS[n.content.metric_code])throw new ConflictException('Effective rate card unit does not match the meter contract');
   rateId=rate.id;rateVersion=Number(rate.rate_version);rateAmount=Number(rate.rate_minor_per_block);rateBlock=Number(rate.block_quantity);currency=rate.currency;
   cost=Math.round(Number(n.content.quantity)/rateBlock*rateAmount);
   if(!Number.isSafeInteger(cost)||cost<0)throw new BadRequestException('Estimated usage cost exceeds the supported integer range');
  }
  const inserted=await this.database.query<UsageRow>(
   'INSERT INTO saas_usage_events(tenant_id,factory_id,metric_code,capability_code,workload_class,quantity,occurred_at,source_system,source_event_ref,rate_card_id,rate_version_snapshot,rate_minor_per_block_snapshot,rate_block_quantity_snapshot,currency,estimated_cost_minor,request_hash,idempotency_key,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING '+USAGE_COLUMNS,
   [tenantId,factoryId,n.content.metric_code,n.content.capability_code,n.content.workload_class,n.content.quantity,n.content.occurred_at,n.content.source_system,n.content.source_event_ref,rateId,rateVersion,rateAmount,rateBlock,currency,cost,hash,n.idempotency_key,actorUserId],{tenantId,userId:actorUserId});
  let row=inserted.rows[0];
  if(!row) {
   const raced=await this.database.query<UsageRow>('SELECT '+USAGE_COLUMNS+' FROM saas_usage_events WHERE tenant_id=$1 AND (idempotency_key=$2 OR (source_system=$3 AND source_event_ref=$4)) LIMIT 1',[tenantId,n.idempotency_key,n.content.source_system,n.content.source_event_ref],{tenantId,userId:actorUserId});
   row=raced.rows[0];if(!row||row.request_hash!==hash)throw new ConflictException('Usage event was concurrently recorded with conflicting content');return {idempotent:true,event:this.mapUsage(row)};
  }
  await this.auditSafely({tenantId,factoryId,actorUserId,eventType:'SAAS_USAGE_EVENT',action:'RECORD_USAGE_EVENT',resourceType:'SAAS_USAGE_EVENT',resourceId:row.id,payload:{metricCode:row.metric_code,capabilityCode:row.capability_code,workloadClass:row.workload_class,quantity:Number(row.quantity),currency:row.currency,estimatedCostMinor:row.estimated_cost_minor===null?null:String(row.estimated_cost_minor),sourceRefSha256:this.sha(row.source_event_ref),requestHash:hash}});
  return {idempotent:false,event:this.mapUsage(row)};
 }

 async createAdjustment(tenantId:string,factoryId:string|null,actorUserId:string,input:CreateSaasUsageAdjustmentDto) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.adjustments.write');
  const n=this.normalizeAdjustment(input), hash=this.hash({tenantId,factoryId,...n.content});
  const prior=await this.database.query<AdjustmentRow>('SELECT '+ADJUSTMENT_COLUMNS+' FROM saas_usage_adjustments WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,n.idempotency_key],{tenantId,userId:actorUserId});
  if(prior.rows[0]){if(prior.rows[0].request_hash!==hash)throw new ConflictException('Adjustment idempotency key was reused for different content');return {idempotent:true,adjustment:this.mapAdjustment(prior.rows[0])};}
  const ins=await this.database.query<AdjustmentRow>('INSERT INTO saas_usage_adjustments(tenant_id,factory_id,period_start,period_end,metric_code,quantity_delta,cost_delta_minor,currency,reason_code,reason,reference_ref,request_hash,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING '+ADJUSTMENT_COLUMNS,[tenantId,factoryId,n.content.period_start,n.content.period_end,n.content.metric_code,n.content.quantity_delta,n.content.cost_delta_minor,n.content.currency,n.content.reason_code,n.content.reason,n.content.reference_ref,hash,n.idempotency_key,actorUserId],{tenantId,userId:actorUserId});
  let row=ins.rows[0];
  if(!row){const raced=await this.database.query<AdjustmentRow>('SELECT '+ADJUSTMENT_COLUMNS+' FROM saas_usage_adjustments WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,n.idempotency_key],{tenantId,userId:actorUserId});row=raced.rows[0];if(!row||row.request_hash!==hash)throw new ConflictException('Adjustment was concurrently recorded with conflicting content');return {idempotent:true,adjustment:this.mapAdjustment(row)};}
  await this.auditSafely({tenantId,factoryId,actorUserId,eventType:'SAAS_USAGE_ADJUSTMENT',action:'RECORD_BILLING_ADJUSTMENT',resourceType:'SAAS_USAGE_ADJUSTMENT',resourceId:row.id,payload:{periodStart:row.period_start,periodEnd:row.period_end,metricCode:row.metric_code,quantityDelta:String(row.quantity_delta),costDeltaMinor:String(row.cost_delta_minor),currency:row.currency,reasonCode:row.reason_code,reasonSha256:this.sha(row.reason),referenceSha256:row.reference_ref?this.sha(row.reference_ref):null}});
  return {idempotent:false,adjustment:this.mapAdjustment(row)};
 }

 async getUsageReport(tenantId:string,factoryId:string|null,actorUserId:string,from:string,to:string) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.usage.read');
  const period=this.normalizePeriod(from,to,366);
  const r=await this.database.query<QueryResultRow & {metric_code:SaasMeterMetric;capability_code:string;workload_class:SaasWorkloadClass;currency:string|null;event_count:string|number;total_quantity:string|number;estimated_cost_minor:string|number|null;unpriced_count:string|number}>(
   'SELECT metric_code,capability_code,workload_class,currency,COUNT(*)::bigint AS event_count,SUM(quantity)::text AS total_quantity,SUM(estimated_cost_minor)::text AS estimated_cost_minor,COUNT(*) FILTER(WHERE rate_card_id IS NULL)::bigint AS unpriced_count FROM saas_usage_events WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3 AND ($4::uuid IS NULL OR factory_id=$4) GROUP BY metric_code,capability_code,workload_class,currency ORDER BY metric_code,capability_code,workload_class,currency',
   [tenantId,period.start,period.end,factoryId],{tenantId,userId:actorUserId});
  const adj=await this.database.query<QueryResultRow & {metric_code:SaasMeterMetric|null;currency:string;quantity_delta:string;cost_delta_minor:string;adjustment_count:string|number}>(
   'SELECT metric_code,currency,SUM(quantity_delta)::text AS quantity_delta,SUM(cost_delta_minor)::text AS cost_delta_minor,COUNT(*)::bigint AS adjustment_count FROM saas_usage_adjustments WHERE tenant_id=$1 AND period_start < $3 AND period_end > $2 AND ($4::uuid IS NULL OR factory_id=$4) GROUP BY metric_code,currency ORDER BY metric_code,currency',
   [tenantId,period.start,period.end,factoryId],{tenantId,userId:actorUserId});
  const events=r.rows.map(x=>({metricCode:x.metric_code,capabilityCode:x.capability_code,workloadClass:x.workload_class,currency:x.currency,eventCount:Number(x.event_count),quantity:String(x.total_quantity),estimatedCostMinor:x.estimated_cost_minor===null?null:String(x.estimated_cost_minor),unpricedCount:Number(x.unpriced_count),costComplete:Number(x.unpriced_count)===0}));
  const adjustments=adj.rows.map(x=>({metricCode:x.metric_code,currency:x.currency,quantityDelta:String(x.quantity_delta),costDeltaMinor:String(x.cost_delta_minor),adjustmentCount:Number(x.adjustment_count)}));
  return {tenantId,factoryId,periodStart:period.start,periodEnd:period.end,eventCount:events.reduce((sum,x)=>sum+x.eventCount,0),unpricedEventCount:events.reduce((sum,x)=>sum+x.unpricedCount,0),events,adjustments,semantics:'USAGE_ESTIMATE_NOT_AN_INVOICE'};
 }

 async reconcileInvoice(tenantId:string,factoryId:string|null,actorUserId:string,input:ReconcileSaasUsageDto) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.reconciliation.write');
  const n=this.normalizeReconciliation(input), {idempotency_key:key,...body}=n, hash=this.hash({tenantId,factoryId,...body});
  const prior=await this.database.query<ReconciliationRow>('SELECT '+RECONCILIATION_COLUMNS+' FROM saas_usage_reconciliations WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,key],{tenantId,userId:actorUserId});
  if(prior.rows[0]){if(prior.rows[0].request_hash!==hash)throw new ConflictException('Reconciliation idempotency key was reused for different content');return {idempotent:true,reconciliation:this.mapReconciliation(prior.rows[0])};}
  const ledger=await this.database.query<QueryResultRow & {event_count:string|number;unpriced_count:string|number;ledger_sum:string;other_currency_count:string|number}>(
   'SELECT COUNT(*) FILTER(WHERE currency=$4 OR currency IS NULL)::bigint AS event_count,COUNT(*) FILTER(WHERE estimated_cost_minor IS NULL)::bigint AS unpriced_count,COALESCE(SUM(estimated_cost_minor) FILTER(WHERE currency=$4),0)::text AS ledger_sum,COUNT(*) FILTER(WHERE currency IS NOT NULL AND currency<>$4)::bigint AS other_currency_count FROM saas_usage_events WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3 AND ($5::uuid IS NULL OR factory_id=$5)',
   [tenantId,n.period_start,n.period_end,n.currency,factoryId],{tenantId,userId:actorUserId});
  if(Number(ledger.rows[0]?.other_currency_count??0)>0)throw new BadRequestException('The selected scope/period contains usage priced in another currency; reconcile that currency separately');
  const adjustment=await this.database.query<QueryResultRow & {adjustment_sum:string}>(
   'SELECT COALESCE(SUM(cost_delta_minor),0)::text AS adjustment_sum FROM saas_usage_adjustments WHERE tenant_id=$1 AND period_start < $3 AND period_end > $2 AND currency=$4 AND ($5::uuid IS NULL OR factory_id=$5)',
   [tenantId,n.period_start,n.period_end,n.currency,factoryId],{tenantId,userId:actorUserId});
  const eventCount=Number(ledger.rows[0]?.event_count??0),unpriced=Number(ledger.rows[0]?.unpriced_count??0);
  const ledgerAmount=Number(ledger.rows[0]?.ledger_sum??0),adjustmentAmount=Number(adjustment.rows[0]?.adjustment_sum??0);
  const expected=unpriced>0?null:ledgerAmount+adjustmentAmount;
  if(expected!==null&&(!Number.isSafeInteger(expected)||!Number.isSafeInteger(Number(n.invoiced_amount_minor)-expected)))throw new BadRequestException('Reconciliation amount exceeds the supported integer range');
  const variance=expected===null?null:Number(n.invoiced_amount_minor)-expected;
  const status=unpriced>0?'UNPRICED_USAGE':variance===0?'MATCHED':'VARIANCE';
  const reportHash=this.hash({tenantId,factoryId,periodStart:n.period_start,periodEnd:n.period_end,currency:n.currency,eventCount,unpriced,ledgerAmount:unpriced?null:ledgerAmount,adjustmentAmount,expected,invoice:n.invoiced_amount_minor,status});
  const inserted=await this.database.query<ReconciliationRow>(
   'INSERT INTO saas_usage_reconciliations(tenant_id,factory_id,invoice_reference,reconciliation_version,period_start,period_end,currency,event_count,unpriced_event_count,ledger_estimated_amount_minor,adjustment_amount_minor,expected_amount_minor,invoiced_amount_minor,variance_minor,status,report_hash,request_hash,idempotency_key,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT DO NOTHING RETURNING '+RECONCILIATION_COLUMNS,
   [tenantId,factoryId,n.invoice_reference,n.reconciliation_version,n.period_start,n.period_end,n.currency,eventCount,unpriced,unpriced?null:ledgerAmount,adjustmentAmount,expected,n.invoiced_amount_minor,variance,status,reportHash,hash,key,actorUserId],{tenantId,userId:actorUserId});
  let row=inserted.rows[0];
  if(!row){const raced=await this.database.query<ReconciliationRow>('SELECT '+RECONCILIATION_COLUMNS+' FROM saas_usage_reconciliations WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,key],{tenantId,userId:actorUserId});row=raced.rows[0];if(!row||row.request_hash!==hash)throw new ConflictException('Reconciliation version or idempotency key conflicts with an existing snapshot');return {idempotent:true,reconciliation:this.mapReconciliation(row)};}
  await this.auditSafely({tenantId,factoryId,actorUserId,eventType:'SAAS_USAGE_RECONCILIATION',action:'RECONCILE_USAGE_TO_INVOICE',resourceType:'SAAS_USAGE_RECONCILIATION',resourceId:row.id,payload:{invoiceReferenceSha256:this.sha(row.invoice_reference),version:row.reconciliation_version,periodStart:row.period_start,periodEnd:row.period_end,currency:row.currency,eventCount,unpricedEventCount:unpriced,ledgerEstimatedAmountMinor:expected===null?null:String(ledgerAmount),adjustmentAmountMinor:String(adjustmentAmount),invoicedAmountMinor:String(row.invoiced_amount_minor),varianceMinor:variance===null?null:String(variance),status,reportHash}});
  return {idempotent:false,reconciliation:this.mapReconciliation(row)};
 }

 async listReconciliations(tenantId:string,factoryId:string|null,actorUserId:string,limit=25,offset=0) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.usage.read');this.page(limit,offset);
  const r=await this.database.query<ReconciliationRow>('SELECT '+RECONCILIATION_COLUMNS+' FROM saas_usage_reconciliations WHERE tenant_id=$1 AND ($2::uuid IS NULL OR factory_id=$2) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',[tenantId,factoryId,limit+1,offset],{tenantId,userId:actorUserId});
  const more=r.rows.length>limit,rows=r.rows.slice(0,limit);return {limit,offset,resultCount:rows.length,hasMore:more,nextOffset:more?offset+rows.length:null,reconciliations:rows.map(x=>this.mapReconciliation(x))};
 }


 async createBudget(tenantId:string,requestFactoryId:string|null,actorUserId:string,input:CreateSaasUsageBudgetDto) {
  this.scope(tenantId,actorUserId,...(requestFactoryId?[requestFactoryId]:[]));
  const n=this.normalizeBudget(input,requestFactoryId);
  await this.iamService.authorize(actorUserId,tenantId,'saas.budgets.write',n.factory_id??undefined);
  const hash=this.hash({tenantId,...n.content,factory_id:n.factory_id});
  const prior=await this.database.query<BudgetRow>('SELECT '+this.budgetColumns()+' FROM saas_usage_budgets WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,n.idempotency_key],{tenantId,userId:actorUserId});
  if(prior.rows[0]) {if(prior.rows[0].request_hash!==hash)throw new ConflictException('Budget idempotency key was reused for different content');return {idempotent:true,budget:this.mapBudget(prior.rows[0])};}
  const ins=await this.database.query<BudgetRow>(
   'INSERT INTO saas_usage_budgets(tenant_id,factory_id,budget_code,policy_version,period_kind,metric_code,capability_code,workload_class,currency,soft_limit_minor,hard_limit_minor,pause_noncritical_on_hard_limit,anomaly_multiplier,anomaly_min_events,effective_from,effective_to,idempotency_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT DO NOTHING RETURNING '+this.budgetColumns(),
   [tenantId,n.factory_id,n.content.budget_code,n.content.policy_version,n.content.period_kind,n.content.metric_code,n.content.capability_code,n.content.workload_class,n.content.currency,n.content.soft_limit_minor,n.content.hard_limit_minor,n.content.pause_noncritical_on_hard_limit,n.content.anomaly_multiplier,n.content.anomaly_min_events,n.content.effective_from,n.content.effective_to,n.idempotency_key,hash,actorUserId],{tenantId,userId:actorUserId});
  let row=ins.rows[0];
  if(!row) {
   const raced=await this.database.query<BudgetRow>('SELECT '+this.budgetColumns()+' FROM saas_usage_budgets WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,n.idempotency_key],{tenantId,userId:actorUserId});
   row=raced.rows[0];
   if(!row||row.request_hash!==hash)throw new ConflictException('Budget policy conflicts with an existing scope/version');
   return {idempotent:true,budget:this.mapBudget(row)};
  }
  await this.auditSafely({tenantId,factoryId:n.factory_id,actorUserId,eventType:'SAAS_BUDGET_POLICY',action:'CREATE_BUDGET_POLICY',resourceType:'SAAS_USAGE_BUDGET',resourceId:row.id,payload:{budgetCode:row.budget_code,policyVersion:row.policy_version,periodKind:row.period_kind,currency:row.currency,softLimitMinor:String(row.soft_limit_minor),hardLimitMinor:String(row.hard_limit_minor),pauseNoncriticalOnHardLimit:row.pause_noncritical_on_hard_limit,requestHash:hash}});
  return {idempotent:false,budget:this.mapBudget(row)};
 }

 async listBudgets(tenantId:string,factoryId:string|null,actorUserId:string) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read',factoryId??undefined);
  const r=await this.database.query<BudgetRow>('SELECT '+this.budgetColumns()+' FROM saas_usage_budgets WHERE tenant_id=$1 AND (factory_id IS NULL OR ($2::uuid IS NOT NULL AND factory_id=$2)) ORDER BY effective_from DESC,budget_code,policy_version DESC',[tenantId,factoryId],{tenantId,userId:actorUserId});
  return {count:r.rows.length,budgets:r.rows.map(x=>this.mapBudget(x))};
 }

 async evaluateBudgets(tenantId:string,factoryId:string|null,actorUserId:string,asOf?:string) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read',factoryId??undefined);
  const evaluatedAt=this.timestamp(asOf??new Date().toISOString(),'as_of');
  const evaluations=await this.evaluateBudgetsInternal(tenantId,factoryId,actorUserId,evaluatedAt);
  return {evaluatedAt,budgetCount:evaluations.length,evaluations,semantics:'USAGE_COST_ESTIMATE_NOT_AN_INVOICE'};
 }

 async listBudgetEvaluations(tenantId:string,factoryId:string|null,actorUserId:string,limit=25,offset=0) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read',factoryId??undefined);this.page(limit,offset);
  const r=await this.database.query<BudgetEvaluationRow>('SELECT '+this.budgetEvaluationColumns()+' FROM saas_budget_evaluations WHERE tenant_id=$1 AND ($2::uuid IS NULL OR factory_id=$2) ORDER BY evaluated_at DESC,id DESC LIMIT $3 OFFSET $4',[tenantId,factoryId,limit,offset],{tenantId,userId:actorUserId});
  return {count:r.rows.length,evaluations:r.rows.map(x=>this.mapBudgetEvaluation(x)),limit,offset};
 }

 async setWorkloadControl(tenantId:string,requestFactoryId:string|null,actorUserId:string,input:SetSaasWorkloadControlDto) {
  this.scope(tenantId,actorUserId,...(requestFactoryId?[requestFactoryId]:[]));
  const workloadClass=this.enum(input.workload_class,new Set(Object.values(SaasNonCriticalWorkloadClass)),'workload_class') as SaasNonCriticalWorkloadClass;
  const state=this.enum(input.control_state,new Set(['PAUSED','RESUMED']),'control_state') as 'PAUSED'|'RESUMED';
  const scopeLevel=this.enum(input.scope_level,new Set(['TENANT','FACTORY']),'scope_level');
  if(scopeLevel==='FACTORY'&&!requestFactoryId)throw new BadRequestException('A verified factory context is required for factory-scoped workload controls');
  const factoryId=scopeLevel==='FACTORY'?requestFactoryId:null;
  await this.iamService.authorize(actorUserId,tenantId,'saas.workloads.control',factoryId??undefined);
  const reasonCode=state==='PAUSED'?'ADMIN_PAUSE':'ADMIN_RESUME';
  const reason=this.str(input.reason,'reason',1000);
  const key=this.idem(input.idempotency_key);
  const content={tenantId,factoryId,workloadClass,state,reasonCode,reason};
  const hash=this.hash(content);
  const result=await this.recordWorkloadControlInternal({tenantId,factoryId,actorUserId,workloadClass,state,source:'MANUAL',reasonCode,reason,idempotencyKey:key,requestHash:hash});
  return {idempotent:result.idempotent,control:result.control};
 }

 async listWorkloadControls(tenantId:string,factoryId:string|null,actorUserId:string) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read',factoryId??undefined);
  const q=await this.database.query<QueryResultRow & {id:string;factory_id:string|null;workload_class:string;control_state:string;source:string;reason_code:string;created_at:string}>(
   'SELECT DISTINCT ON (factory_id,workload_class) id::text AS id,factory_id::text AS factory_id,workload_class,control_state,source,reason_code,created_at::text AS created_at FROM saas_workload_control_events WHERE tenant_id=$1 AND (factory_id IS NULL OR ($2::uuid IS NOT NULL AND factory_id=$2)) ORDER BY factory_id,workload_class,created_at DESC,id DESC',
   [tenantId,factoryId],{tenantId,userId:actorUserId});
  return {controls:q.rows.map(x=>({id:x.id,factoryId:x.factory_id,workloadClass:x.workload_class,state:x.control_state,source:x.source,reasonCode:x.reason_code,createdAt:x.created_at}))};
 }

 /** Runtime guard: only explicit non-critical AI classes can reach the pause gate. */
 async assertWorkloadExecutionAllowed(tenantId:string,factoryId:string,actorUserId:string,workloadClass:string):Promise<void> {
  this.scope(tenantId,actorUserId,factoryId);
  const allowed=new Set<string>(Object.values(SaasNonCriticalWorkloadClass));
  if(!allowed.has(workloadClass))throw new ConflictException('Only an explicitly non-critical AI workload may use the budget pause gate');
  await this.evaluateBudgetsInternal(tenantId,factoryId,actorUserId,new Date().toISOString());
  const latest=await this.database.query<QueryResultRow & {control_state:string;factory_id:string|null}>(
   `SELECT control_state,factory_id::text AS factory_id FROM saas_workload_control_events
    WHERE tenant_id=$1 AND control_key='AI.NONCRITICAL' AND workload_class=$3
      AND (factory_id IS NULL OR factory_id=$2)
      AND id IN (
       SELECT DISTINCT ON (factory_id) id FROM saas_workload_control_events
       WHERE tenant_id=$1 AND control_key='AI.NONCRITICAL' AND workload_class=$3
         AND (factory_id IS NULL OR factory_id=$2)
       ORDER BY factory_id,created_at DESC,id DESC
      )
    ORDER BY (factory_id=$2) DESC,created_at DESC,id DESC`,
   [tenantId,factoryId,workloadClass],{tenantId,userId:actorUserId});
  if(latest.rows.some(x=>x.control_state==='PAUSED'))throw new ForbiddenException('Non-critical AI workload is paused by a tenant/factory SaaS budget control');
 }

 private async evaluateBudgetsInternal(tenantId:string,factoryId:string|null,actorUserId:string,asOf:string) {
  const budgets=await this.database.query<BudgetRow>(
   'SELECT '+this.budgetColumns()+' FROM saas_usage_budgets WHERE tenant_id=$1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2) AND (factory_id IS NULL OR ($3::uuid IS NOT NULL AND factory_id=$3)) ORDER BY (factory_id IS NOT NULL) DESC,budget_code,policy_version DESC',
   [tenantId,asOf,factoryId],{tenantId,userId:actorUserId});
  const output:Record<string,unknown>[]=[];
  for(const budget of budgets.rows) {
   const period=this.budgetPeriod(budget.period_kind,asOf);
   const factoryScope=budget.factory_id;
   const scoped=[tenantId,period.start,period.end,factoryScope,budget.metric_code,budget.capability_code,budget.workload_class,budget.currency];
   const usage=await this.database.query<QueryResultRow & {event_count:string|number;unpriced_count:string|number;cost_minor:string|number}>(
    `SELECT COUNT(*) FILTER(WHERE currency=$8 OR estimated_cost_minor IS NULL)::bigint AS event_count,
       COUNT(*) FILTER(WHERE estimated_cost_minor IS NULL)::bigint AS unpriced_count,
       COALESCE(SUM(estimated_cost_minor) FILTER(WHERE currency=$8),0)::bigint AS cost_minor
     FROM saas_usage_events WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3
       AND ($4::uuid IS NULL OR factory_id=$4) AND ($5::varchar IS NULL OR metric_code=$5)
       AND ($6::varchar IS NULL OR capability_code=$6) AND ($7::varchar IS NULL OR workload_class=$7)`,
    scoped,{tenantId,userId:actorUserId});
   const recent=await this.database.query<QueryResultRow & {recent_count:string|number;recent_cost:string|number;baseline_count:string|number;baseline_cost:string|number}>(
    `SELECT COUNT(*) FILTER(WHERE occurred_at >= $2::timestamptz - INTERVAL '1 hour' AND estimated_cost_minor IS NOT NULL AND currency=$7)::bigint AS recent_count,
       COALESCE(SUM(estimated_cost_minor) FILTER(WHERE occurred_at >= $2::timestamptz - INTERVAL '1 hour' AND currency=$7),0)::bigint AS recent_cost,
       COUNT(*) FILTER(WHERE occurred_at < $2::timestamptz - INTERVAL '1 hour' AND estimated_cost_minor IS NOT NULL AND currency=$7)::bigint AS baseline_count,
       COALESCE(SUM(estimated_cost_minor) FILTER(WHERE occurred_at < $2::timestamptz - INTERVAL '1 hour' AND currency=$7),0)::bigint AS baseline_cost
     FROM saas_usage_events WHERE tenant_id=$1 AND occurred_at >= $2::timestamptz - INTERVAL '24 hours' AND occurred_at < $2
       AND ($3::uuid IS NULL OR factory_id=$3) AND ($4::varchar IS NULL OR metric_code=$4)
       AND ($5::varchar IS NULL OR capability_code=$5) AND ($6::varchar IS NULL OR workload_class=$6)`,
    [tenantId,asOf,factoryScope,budget.metric_code,budget.capability_code,budget.workload_class,budget.currency],{tenantId,userId:actorUserId});
   const eventCount=Number(usage.rows[0]?.event_count??0),unpriced=Number(usage.rows[0]?.unpriced_count??0),cost=Number(usage.rows[0]?.cost_minor??0);
   const recentCount=Number(recent.rows[0]?.recent_count??0),recentCost=Number(recent.rows[0]?.recent_cost??0),baselineCount=Number(recent.rows[0]?.baseline_count??0),baselineCost=Number(recent.rows[0]?.baseline_cost??0);
   const baselineHourly=baselineCost/23;
   const anomaly=recentCount>=Number(budget.anomaly_min_events)&&baselineCount>=Number(budget.anomaly_min_events)&&baselineHourly>0&&recentCost>baselineHourly*Number(budget.anomaly_multiplier);
   const soft=Number(budget.soft_limit_minor),hard=Number(budget.hard_limit_minor);
   const status:'SAFE'|'WARNING'|'HARD_LIMIT'|'UNPRICED_USAGE'|'ANOMALY'=cost>=hard&&(hard>0||cost>0)?'HARD_LIMIT':unpriced>0?'UNPRICED_USAGE':anomaly?'ANOMALY':soft>0&&cost>=soft?'WARNING':'SAFE';
   const snapshot={budgetId:budget.id,tenantId,factoryId:factoryScope,periodStart:period.start,periodEnd:period.end,eventCount,unpriced,usageCostMinor:cost,soft,hard,recentCost,baselineHourly,status};
   const reportHash=this.hash(snapshot);
   const key=this.idem('ev:'+budget.id+':'+this.hash(snapshot));
   const reqHash=this.hash({...snapshot,idempotencyKey:key});
   const inserted=await this.database.query<BudgetEvaluationRow>(
    'INSERT INTO saas_budget_evaluations(tenant_id,factory_id,budget_id,period_start,period_end,evaluated_at,event_count,unpriced_event_count,usage_cost_minor,soft_limit_minor,hard_limit_minor,anomaly_window_cost_minor,anomaly_baseline_hourly_minor,status,report_hash,idempotency_key,request_hash,evaluated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING '+this.budgetEvaluationColumns(),
    [tenantId,factoryScope,budget.id,period.start,period.end,asOf,eventCount,unpriced,cost,soft,hard,recentCost,baselineHourly,status,reportHash,key,reqHash,actorUserId],{tenantId,userId:actorUserId});
   let evaluation=inserted.rows[0];
   if(!evaluation) {
    const old=await this.database.query<BudgetEvaluationRow>('SELECT '+this.budgetEvaluationColumns()+' FROM saas_budget_evaluations WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,key],{tenantId,userId:actorUserId});
    evaluation=old.rows[0];if(!evaluation||evaluation.request_hash!==reqHash)throw new ConflictException('Budget evaluation idempotency key conflicts with different content');
   }
   output.push(this.mapBudgetEvaluation(evaluation));
   if(status==='HARD_LIMIT'&&budget.pause_noncritical_on_hard_limit) {
    for(const cls of Object.values(SaasNonCriticalWorkloadClass)) {
     const reason='Budget '+budget.budget_code+' reached the configured hard limit for '+period.start;
     const controlKey=this.idem('budgetpause:'+evaluation.id+':'+cls);
     await this.recordWorkloadControlInternal({tenantId,factoryId:factoryScope,actorUserId,workloadClass:cls,state:'PAUSED',source:'BUDGET',reasonCode:'BUDGET_HARD_LIMIT',reason,budgetId:budget.id,budgetEvaluationId:evaluation.id,idempotencyKey:controlKey,requestHash:this.hash({budgetId:budget.id,evaluationId:evaluation.id,cls,state:'PAUSED'})});
    }
   }
  }
  return output;
 }

 private async recordWorkloadControlInternal(i:{tenantId:string;factoryId:string|null;actorUserId:string;workloadClass:SaasNonCriticalWorkloadClass;state:'PAUSED'|'RESUMED';source:'MANUAL'|'BUDGET'|'ANOMALY';reasonCode:'ADMIN_PAUSE'|'ADMIN_RESUME'|'BUDGET_HARD_LIMIT'|'SPEND_ANOMALY'|'BUDGET_RECOVERED';reason:string;budgetId?:string;budgetEvaluationId?:string;idempotencyKey:string;requestHash:string}) {
  const prior=await this.database.query<QueryResultRow & {id:string;request_hash:string;control_state:string;created_at:string}>('SELECT id::text AS id,request_hash,control_state,created_at::text AS created_at FROM saas_workload_control_events WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[i.tenantId,i.idempotencyKey],{tenantId:i.tenantId,userId:i.actorUserId});
  if(prior.rows[0]) {if(prior.rows[0].request_hash!==i.requestHash)throw new ConflictException('Workload control idempotency key conflicts with different content');return {idempotent:true,control:{id:prior.rows[0].id,workloadClass:i.workloadClass,state:prior.rows[0].control_state,createdAt:prior.rows[0].created_at}};}
  const latest=await this.database.query<QueryResultRow & {control_state:string}>('SELECT control_state FROM saas_workload_control_events WHERE tenant_id=$1 AND factory_id IS NOT DISTINCT FROM $2::uuid AND control_key=$3 AND workload_class=$4 ORDER BY created_at DESC,id DESC LIMIT 1',[i.tenantId,i.factoryId,'AI.NONCRITICAL',i.workloadClass],{tenantId:i.tenantId,userId:i.actorUserId});
  if(latest.rows[0]?.control_state===i.state) return {idempotent:true,control:{id:null,workloadClass:i.workloadClass,state:i.state,createdAt:null}};
  const reasonHash=this.sha(i.reason);
  const r=await this.database.query<QueryResultRow & {id:string;created_at:string}>(
   'INSERT INTO saas_workload_control_events(tenant_id,factory_id,control_key,workload_class,control_state,source,reason_code,reason_hash,budget_id,budget_evaluation_id,idempotency_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id::text AS id,created_at::text AS created_at',
   [i.tenantId,i.factoryId,'AI.NONCRITICAL',i.workloadClass,i.state,i.source,i.reasonCode,reasonHash,i.budgetId??null,i.budgetEvaluationId??null,i.idempotencyKey,i.requestHash,i.actorUserId],{tenantId:i.tenantId,userId:i.actorUserId});
  if(!r.rows[0]) {
   const same=await this.database.query<QueryResultRow & {id:string;request_hash:string;control_state:string;created_at:string}>('SELECT id::text AS id,request_hash,control_state,created_at::text AS created_at FROM saas_workload_control_events WHERE tenant_id=$1 AND idempotency_key=$2',[i.tenantId,i.idempotencyKey],{tenantId:i.tenantId,userId:i.actorUserId});
   if(!same.rows[0]||same.rows[0].request_hash!==i.requestHash)throw new ConflictException('Workload control was concurrently recorded with conflicting content');
   return {idempotent:true,control:{id:same.rows[0].id,workloadClass:i.workloadClass,state:same.rows[0].control_state,createdAt:same.rows[0].created_at}};
  }
  await this.auditSafely({tenantId:i.tenantId,factoryId:i.factoryId,actorUserId:i.actorUserId,eventType:'SAAS_WORKLOAD_CONTROL',action:i.state==='PAUSED'?'PAUSE_NONCRITICAL_AI_WORKLOAD':'RESUME_NONCRITICAL_AI_WORKLOAD',resourceType:'SAAS_WORKLOAD_CONTROL',resourceId:r.rows[0].id,payload:{workloadClass:i.workloadClass,state:i.state,source:i.source,reasonCode:i.reasonCode,reasonSha256:reasonHash,budgetId:i.budgetId??null,budgetEvaluationId:i.budgetEvaluationId??null,requestHash:i.requestHash}});
  return {idempotent:false,control:{id:r.rows[0].id,workloadClass:i.workloadClass,state:i.state,createdAt:r.rows[0].created_at}};
 }

 private normalizeBudget(input:CreateSaasUsageBudgetDto,requestFactoryId:string|null) {
  const budget_code=this.pattern(input.budget_code,'budget_code',/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/);
  const policy_version=this.num(input.policy_version,'policy_version');
  const period_kind=this.enum(input.period_kind,new Set(Object.values(SaasBudgetPeriodKind)),'period_kind') as SaasBudgetPeriodKind;
  const scope_level=this.enum(input.scope_level,new Set(['TENANT','FACTORY']),'scope_level');
  if(!Number.isInteger(policy_version)||policy_version<1||policy_version>1000000)throw new BadRequestException('policy_version must be an integer between 1 and 1000000');
  if(scope_level==='FACTORY'&&!requestFactoryId)throw new BadRequestException('A verified factory context is required for factory-scoped budgets');
  const factory_id=scope_level==='FACTORY'?requestFactoryId:null;
  const metric_code=input.metric_code==null?null:this.enum(input.metric_code,METRICS,'metric_code') as SaasMeterMetric;
  const capability_code=input.capability_code==null?null:this.pattern(input.capability_code,'capability_code',/^[a-z][a-z0-9._:-]{0,99}$/);
  const workload_class=input.workload_class==null?null:this.enum(input.workload_class,WORKLOADS,'workload_class') as SaasWorkloadClass;
  const currency=this.pattern(input.currency,'currency',/^[A-Z]{3}$/);
  const soft_limit_minor=this.num(input.soft_limit_minor,'soft_limit_minor'),hard_limit_minor=this.num(input.hard_limit_minor,'hard_limit_minor');
  if(!Number.isSafeInteger(soft_limit_minor)||!Number.isSafeInteger(hard_limit_minor)||soft_limit_minor<0||hard_limit_minor<soft_limit_minor||hard_limit_minor>9000000000000000)throw new BadRequestException('Budget limits must be safe non-negative minor-unit integers and hard limit must be >= soft limit');
  const pause=input.pause_noncritical_on_hard_limit??false;
  if(typeof pause!=='boolean')throw new BadRequestException('pause_noncritical_on_hard_limit must be a boolean');
  const anomaly_multiplier=this.num(input.anomaly_multiplier??3,'anomaly_multiplier'),anomaly_min_events=this.num(input.anomaly_min_events??10,'anomaly_min_events');
  if(anomaly_multiplier<1.5||anomaly_multiplier>100||!Number.isInteger(anomaly_min_events)||anomaly_min_events<3||anomaly_min_events>100000)throw new BadRequestException('Anomaly settings are outside supported bounds');
  const effective_from=this.timestamp(input.effective_from,'effective_from'),effective_to=input.effective_to?this.timestamp(input.effective_to,'effective_to'):null;
  if(effective_to&&Date.parse(effective_to)<=Date.parse(effective_from))throw new BadRequestException('effective_to must be later than effective_from');
  const idempotency_key=this.idem(input.idempotency_key);
  return {factory_id,idempotency_key,content:{budget_code,policy_version,period_kind,metric_code,capability_code,workload_class,currency,soft_limit_minor,hard_limit_minor,pause_noncritical_on_hard_limit:pause,anomaly_multiplier,anomaly_min_events,effective_from,effective_to}};
 }

 private budgetPeriod(kind:SaasBudgetPeriodKind,asOf:string) {
  const d=new Date(asOf);
  const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),kind==='DAILY'?d.getUTCDate():1));
  const end=kind==='DAILY'?new Date(start.getTime()+86400000):new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
  return {start:start.toISOString(),end:end.toISOString()};
 }
 private budgetColumns(){return 'id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,budget_code,policy_version,period_kind,metric_code,capability_code,workload_class,currency,soft_limit_minor::text AS soft_limit_minor,hard_limit_minor::text AS hard_limit_minor,pause_noncritical_on_hard_limit,anomaly_multiplier::text AS anomaly_multiplier,anomaly_min_events,effective_from::text AS effective_from,effective_to::text AS effective_to,idempotency_key,request_hash,created_by::text AS created_by,created_at::text AS created_at';}
 private budgetEvaluationColumns(){return 'id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,budget_id::text AS budget_id,period_start::text AS period_start,period_end::text AS period_end,evaluated_at::text AS evaluated_at,event_count,unpriced_event_count,usage_cost_minor::text AS usage_cost_minor,soft_limit_minor::text AS soft_limit_minor,hard_limit_minor::text AS hard_limit_minor,anomaly_window_cost_minor::text AS anomaly_window_cost_minor,anomaly_baseline_hourly_minor::text AS anomaly_baseline_hourly_minor,status,report_hash,idempotency_key,request_hash,evaluated_by::text AS evaluated_by,created_at::text AS created_at';}
 private mapBudget(r:BudgetRow){return {id:r.id,factoryId:r.factory_id,budgetCode:r.budget_code,policyVersion:Number(r.policy_version),periodKind:r.period_kind,metricCode:r.metric_code,capabilityCode:r.capability_code,workloadClass:r.workload_class,currency:r.currency,softLimitMinor:String(r.soft_limit_minor),hardLimitMinor:String(r.hard_limit_minor),pauseNoncriticalOnHardLimit:r.pause_noncritical_on_hard_limit,anomalyMultiplier:String(r.anomaly_multiplier),anomalyMinEvents:Number(r.anomaly_min_events),effectiveFrom:r.effective_from,effectiveTo:r.effective_to,createdBy:r.created_by,createdAt:r.created_at};}
 private mapBudgetEvaluation(r:BudgetEvaluationRow){return {id:r.id,factoryId:r.factory_id,budgetId:r.budget_id,periodStart:r.period_start,periodEnd:r.period_end,evaluatedAt:r.evaluated_at,eventCount:Number(r.event_count),unpricedEventCount:Number(r.unpriced_event_count),usageCostMinor:String(r.usage_cost_minor),softLimitMinor:String(r.soft_limit_minor),hardLimitMinor:String(r.hard_limit_minor),anomalyWindowCostMinor:String(r.anomaly_window_cost_minor),anomalyBaselineHourlyMinor:String(r.anomaly_baseline_hourly_minor),status:r.status,reportHash:r.report_hash};}

 private normalizeRate(input:CreateSaasMeterRateDto) {
  const metric=this.enum(input?.metric_code,METRICS,'metric_code') as SaasMeterMetric;
  const version=this.num(input?.rate_version,'rate_version');if(!Number.isInteger(version)||version<1||version>1000000)throw new BadRequestException('rate_version must be an integer between 1 and 1000000');
  const rate=this.num(input?.rate_minor_per_block,'rate_minor_per_block');if(!Number.isSafeInteger(rate)||rate<0||rate>9000000000000000)throw new BadRequestException('rate_minor_per_block must be a supported non-negative integer');
  const block=this.num(input?.block_quantity,'block_quantity');if(block<0.000001||block>1e12)throw new BadRequestException('block_quantity is outside supported range');
  const currency=this.pattern(input?.currency,'currency',/^[A-Z]{3}$/),effective=this.timestamp(input?.effective_from,'effective_from'),key=this.idem(input?.idempotency_key);
  return {metric_code:metric,rate_version:version,rate_minor_per_block:rate,block_quantity:block,currency,effective_from:effective,idempotency_key:key,unit:UNITS[metric]};
 }
 private normalizeEvent(input:RecordSaasUsageEventDto) {
  const metric=this.enum(input?.metric_code,METRICS,'metric_code') as SaasMeterMetric,cap=this.pattern(input?.capability_code,'capability_code',/^[a-z][a-z0-9._:-]{0,99}$/);
  const workload=this.enum(input?.workload_class,WORKLOADS,'workload_class') as SaasWorkloadClass,quantity=this.num(input?.quantity,'quantity');
  if(quantity<=0||quantity>1e12)throw new BadRequestException('quantity must be greater than zero and within the supported range');
  const occurred=this.timestamp(input?.occurred_at,'occurred_at'),source=this.enum(input?.source_system,SOURCES,'source_system') as SaasUsageSourceSystem;
  const ref=this.str(input?.source_event_ref,'source_event_ref',255),key=this.idem(input?.idempotency_key);
  return {idempotency_key:key,content:{metric_code:metric,capability_code:cap,workload_class:workload,quantity,occurred_at:occurred,source_system:source,source_event_ref:ref,unit:UNITS[metric]}};
 }
 private normalizeAdjustment(input:CreateSaasUsageAdjustmentDto) {
  const period=this.normalizePeriod(input?.period_start,input?.period_end,366),metric=input?.metric_code===undefined?null:this.enum(input.metric_code,METRICS,'metric_code') as SaasMeterMetric;
  const quantity=this.num(input?.quantity_delta,'quantity_delta');if(Math.abs(quantity)>1e12)throw new BadRequestException('quantity_delta is outside the supported range');
  const cost=this.num(input?.cost_delta_minor,'cost_delta_minor');if(!Number.isSafeInteger(cost)||Math.abs(cost)>9000000000000000)throw new BadRequestException('cost_delta_minor must be a supported integer');
  if(quantity===0&&cost===0)throw new BadRequestException('An adjustment must change quantity or cost');
  const currency=this.pattern(input?.currency,'currency',/^[A-Z]{3}$/),reasonCode=this.enum(input?.reason_code,REASONS,'reason_code') as SaasAdjustmentReasonCode;
  const reason=this.str(input?.reason,'reason',2000),ref=input?.reference_ref===undefined?null:this.str(input.reference_ref,'reference_ref',255),key=this.idem(input?.idempotency_key);
  return {idempotency_key:key,content:{period_start:period.start,period_end:period.end,metric_code:metric,quantity_delta:quantity,cost_delta_minor:cost,currency,reason_code:reasonCode,reason,reference_ref:ref}};
 }
 private normalizeReconciliation(input:ReconcileSaasUsageDto) {
  const period=this.normalizePeriod(input?.period_start,input?.period_end,35),version=this.num(input?.reconciliation_version,'reconciliation_version');
  if(!Number.isInteger(version)||version<1||version>1000000)throw new BadRequestException('reconciliation_version must be an integer between 1 and 1000000');
  const invoice=this.pattern(input?.invoice_reference,'invoice_reference',/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/),currency=this.pattern(input?.currency,'currency',/^[A-Z]{3}$/);
  const amount=this.num(input?.invoiced_amount_minor,'invoiced_amount_minor');if(!Number.isSafeInteger(amount)||amount<0||amount>9000000000000000)throw new BadRequestException('invoiced_amount_minor must be a supported non-negative integer');
  return {idempotency_key:this.idem(input?.idempotency_key),invoice_reference:invoice,reconciliation_version:version,period_start:period.start,period_end:period.end,currency,invoiced_amount_minor:amount};
 }
 private normalizePeriod(from:unknown,to:unknown,maxDays:number) {
  const start=this.timestamp(from,'period_start'),end=this.timestamp(to,'period_end'),a=Date.parse(start),b=Date.parse(end);
  if(b<=a)throw new BadRequestException('period_end must be after period_start');
  if(b-a>maxDays*24*60*60*1000)throw new BadRequestException('period exceeds the supported '+maxDays+' day limit');
  return {start,end};
 }
 private async authorize(user:string,tenant:string,permission:string){await this.iamService.authorize(user,tenant,permission);}
 private scope(tenant:string,user:string,...ids:string[]){if(!isUUID(tenant)||!isUUID(user)||ids.some(x=>!isUUID(x)))throw new BadRequestException('Authenticated tenant, user and factory UUIDs are required');}
 private enum(value:unknown,allowed:Set<string>,field:string){if(typeof value!=='string'||!allowed.has(value))throw new BadRequestException(field+' is invalid');return value;}
 private num(value:unknown,field:string){const n=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;if(!Number.isFinite(n))throw new BadRequestException(field+' must be a finite number');return n;}
 private pattern(value:unknown,field:string,pattern:RegExp){const s=this.str(value,field,255);if(!pattern.test(s))throw new BadRequestException(field+' contains unsupported characters');return s;}
 private str(value:unknown,field:string,max:number){if(typeof value!=='string')throw new BadRequestException(field+' must be a string');const s=value.normalize('NFC').trim();if(!s||s.length>max)throw new BadRequestException(field+' must contain 1-'+max+' characters');return s;}
 private idem(value:unknown){return this.pattern(value,'idempotency_key',/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);}
 private timestamp(value:unknown,field:string){if(typeof value!=='string'||!value.trim()||Number.isNaN(Date.parse(value)))throw new BadRequestException(field+' must be a valid timestamp');return new Date(value).toISOString();}
 private sha(value:string){return createHash('sha256').update(value,'utf8').digest('hex');}
 private hash(value:Record<string,unknown>){return this.sha(JSON.stringify(value));}
 private async auditSafely(i:{tenantId:string;factoryId?:string|null;actorUserId:string;eventType:string;action:string;resourceType:string;resourceId:string;payload:Record<string,unknown>}){try{await this.auditService.record({tenantId:i.tenantId,factoryId:i.factoryId??null,actorUserId:i.actorUserId,eventType:i.eventType,action:i.action,resourceType:i.resourceType,resourceId:i.resourceId,dataClass:'INTERNAL',payload:i.payload});}catch{/* The immutable metering ledger remains authoritative if audit delivery is temporarily unavailable. */}}
 private mapRate(r:RateRow){return {id:r.id,metricCode:r.metric_code,unit:UNITS[r.metric_code],rateVersion:Number(r.rate_version),rateMinorPerBlock:String(r.rate_minor_per_block),blockQuantity:String(r.block_quantity),currency:r.currency,effectiveFrom:r.effective_from,createdBy:r.created_by,createdAt:r.created_at};}
 private mapUsage(r:UsageRow){return {id:r.id,factoryId:r.factory_id,metricCode:r.metric_code,capabilityCode:r.capability_code,workloadClass:r.workload_class,quantity:String(r.quantity),unit:UNITS[r.metric_code],occurredAt:r.occurred_at,sourceSystem:r.source_system,rateCardId:r.rate_card_id,rateVersion:r.rate_version_snapshot,currency:r.currency,estimatedCostMinor:r.estimated_cost_minor===null?null:String(r.estimated_cost_minor),billable:r.estimated_cost_minor!==null,semantics:'METERED_USAGE_ESTIMATE_NOT_AN_INVOICE',recordedBy:r.recorded_by,createdAt:r.created_at};}
 private mapAdjustment(r:AdjustmentRow){return {id:r.id,factoryId:r.factory_id,periodStart:r.period_start,periodEnd:r.period_end,metricCode:r.metric_code,quantityDelta:String(r.quantity_delta),costDeltaMinor:String(r.cost_delta_minor),currency:r.currency,reasonCode:r.reason_code,reason:r.reason,referenceRef:r.reference_ref,createdBy:r.created_by,createdAt:r.created_at};}
 private mapReconciliation(r:ReconciliationRow){return {id:r.id,factoryId:r.factory_id,invoiceReference:r.invoice_reference,reconciliationVersion:Number(r.reconciliation_version),periodStart:r.period_start,periodEnd:r.period_end,currency:r.currency,eventCount:Number(r.event_count),unpricedEventCount:Number(r.unpriced_event_count),ledgerEstimatedAmountMinor:r.ledger_estimated_amount_minor===null?null:String(r.ledger_estimated_amount_minor),adjustmentAmountMinor:String(r.adjustment_amount_minor),expectedAmountMinor:r.expected_amount_minor===null?null:String(r.expected_amount_minor),invoicedAmountMinor:String(r.invoiced_amount_minor),varianceMinor:r.variance_minor===null?null:String(r.variance_minor),status:r.status,reportHash:r.report_hash,recordedBy:r.recorded_by,createdAt:r.created_at};}
 private page(limit:number,offset:number){if(!Number.isInteger(limit)||limit<1||limit>100)throw new BadRequestException('limit must be between 1 and 100');if(!Number.isInteger(offset)||offset<0||offset>10000)throw new BadRequestException('offset must be between 0 and 10000');}
}