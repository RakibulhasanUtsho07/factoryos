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
import { RecordSaasProviderCostEventDto } from './dto/record-saas-provider-cost-event.dto';
import { ReconcileSaasProviderCostInvoiceDto } from './dto/reconcile-saas-provider-cost-invoice.dto';
import { AcknowledgeSaasBudgetAlertDto } from './dto/acknowledge-saas-budget-alert.dto';

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


type ProviderCostRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; provider_code:string; model_code:string|null;
 metric_code:SaasMeterMetric; workload_class:SaasWorkloadClass; quantity:string|number; currency:string;
 provider_cost_minor:string|number; occurred_at:string; provider_invoice_reference:string|null;
 source_system:string; source_event_ref:string; request_hash:string; idempotency_key:string;
 recorded_by:string; created_at:string;
};
type ProviderCostReconciliationRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; provider_code:string; invoice_reference:string;
 reconciliation_version:number; period_start:string; period_end:string; currency:string; event_count:string|number;
 ledger_provider_cost_minor:string|number; invoiced_provider_cost_minor:string|number; variance_minor:string|number;
 status:'MATCHED'|'VARIANCE'|'NO_PROVIDER_DATA'; report_hash:string; request_hash:string;
 idempotency_key:string; recorded_by:string; created_at:string;
};
type BudgetAlertRow = QueryResultRow & {
 id:string; tenant_id:string; factory_id:string|null; budget_id:string; budget_evaluation_id:string;
 alert_type:string; severity:string; title:string; message_code:string; payload:Record<string,unknown>;
 payload_hash:string; created_at:string; acknowledged_at:string|null;
};
const PROVIDER_COST_COLUMNS='id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,provider_code,model_code,metric_code,workload_class,quantity::text AS quantity,currency,provider_cost_minor::text AS provider_cost_minor,occurred_at::text AS occurred_at,provider_invoice_reference,source_system,source_event_ref,request_hash,idempotency_key,recorded_by::text AS recorded_by,created_at::text AS created_at';
const PROVIDER_RECON_COLUMNS='id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,provider_code,invoice_reference,reconciliation_version,period_start::text AS period_start,period_end::text AS period_end,currency,event_count,ledger_provider_cost_minor::text AS ledger_provider_cost_minor,invoiced_provider_cost_minor::text AS invoiced_provider_cost_minor,variance_minor::text AS variance_minor,status,report_hash,request_hash,idempotency_key,recorded_by::text AS recorded_by,created_at::text AS created_at';

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
  if(existing.rows[0]) {if(existing.rows[0].request_hash!==hash)throw new ConflictException('Usage idempotency key or source event reference was reused for different content');await this.evaluateBudgetsInternal(tenantId,factoryId,actorUserId,existing.rows[0].occurred_at);return {idempotent:true,event:this.mapUsage(existing.rows[0])};}
  const effectiveRate=await this.database.query<RateRow>('SELECT '+RATE_COLUMNS+' FROM saas_usage_rate_cards WHERE tenant_id=$1 AND metric_code=$2 AND effective_from <= $3 ORDER BY effective_from DESC,rate_version DESC LIMIT 1',[tenantId,n.content.metric_code,n.content.occurred_at],{tenantId,userId:actorUserId});
  const rate=effectiveRate.rows[0]??null;
  let rateId:string|null=null, rateVersion:number|null=null, rateAmount:string|null=null, rateBlock:string|null=null, currency:string|null=null, cost:number|null=null;
  if(rate) {
   if(UNITS[rate.metric_code]!==UNITS[n.content.metric_code])throw new ConflictException('Effective rate card unit does not match the meter contract');
   rateId=rate.id;rateVersion=Number(rate.rate_version);rateAmount=String(rate.rate_minor_per_block);rateBlock=String(rate.block_quantity);currency=rate.currency;
   cost=this.calculateUsageCostMinor(n.content.quantity,rateBlock,rateAmount);
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
  await this.evaluateBudgetsInternal(tenantId,factoryId,actorUserId,row.occurred_at);
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
  const eventCountBigInt=BigInt(String(ledger.rows[0]?.event_count??0)),unpriced=Number(ledger.rows[0]?.unpriced_count??0);
  if(eventCountBigInt>BigInt(Number.MAX_SAFE_INTEGER))throw new BadRequestException('Reconciliation event count exceeds the supported integer range');
  const eventCount=Number(eventCountBigInt);
  const ledgerAmount=BigInt(String(ledger.rows[0]?.ledger_sum??0)),adjustmentAmount=BigInt(String(adjustment.rows[0]?.adjustment_sum??0));
  this.assertMoneyAggregateRange(ledgerAmount,'ledger amount');
  this.assertMoneyAggregateRange(adjustmentAmount,'adjustment amount');
  const expected=unpriced>0?null:ledgerAmount+adjustmentAmount;
  if(expected!==null)this.assertMoneyAggregateRange(expected,'expected amount');
  const variance=expected===null?null:BigInt(n.invoiced_amount_minor)-expected;
  if(variance!==null)this.assertMoneyAggregateRange(variance,'invoice variance');
  const status=unpriced>0?'UNPRICED_USAGE':variance===0n?'MATCHED':'VARIANCE';
  const reportHash=this.hash({tenantId,factoryId,periodStart:n.period_start,periodEnd:n.period_end,currency:n.currency,eventCount,unpriced,ledgerAmount:unpriced?null:ledgerAmount.toString(),adjustmentAmount:adjustmentAmount.toString(),expected:expected?.toString()??null,invoice:String(n.invoiced_amount_minor),status});
  const inserted=await this.database.query<ReconciliationRow>(
   'INSERT INTO saas_usage_reconciliations(tenant_id,factory_id,invoice_reference,reconciliation_version,period_start,period_end,currency,event_count,unpriced_event_count,ledger_estimated_amount_minor,adjustment_amount_minor,expected_amount_minor,invoiced_amount_minor,variance_minor,status,report_hash,request_hash,idempotency_key,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT DO NOTHING RETURNING '+RECONCILIATION_COLUMNS,
   [tenantId,factoryId,n.invoice_reference,n.reconciliation_version,n.period_start,n.period_end,n.currency,eventCount,unpriced,unpriced?null:ledgerAmount.toString(),adjustmentAmount.toString(),expected?.toString()??null,n.invoiced_amount_minor,variance?.toString()??null,status,reportHash,hash,key,actorUserId],{tenantId,userId:actorUserId});
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
  await this.authorize(actorUserId,tenantId,'saas.budgets.write');
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
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read');
  const r=await this.database.query<BudgetRow>('SELECT '+this.budgetColumns()+' FROM saas_usage_budgets WHERE tenant_id=$1 AND (factory_id IS NULL OR ($2::uuid IS NOT NULL AND factory_id=$2)) ORDER BY effective_from DESC,budget_code,policy_version DESC',[tenantId,factoryId],{tenantId,userId:actorUserId});
  return {count:r.rows.length,budgets:r.rows.map(x=>this.mapBudget(x))};
 }

 async evaluateBudgets(tenantId:string,factoryId:string|null,actorUserId:string,asOf?:string) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read');
  const evaluatedAt=this.timestamp(asOf??new Date().toISOString(),'as_of');
  const evaluations=await this.evaluateBudgetsInternal(tenantId,factoryId,actorUserId,evaluatedAt);
  return {evaluatedAt,budgetCount:evaluations.length,evaluations,semantics:'USAGE_COST_ESTIMATE_NOT_AN_INVOICE'};
 }

 async listBudgetEvaluations(tenantId:string,factoryId:string|null,actorUserId:string,limit=25,offset=0) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read');this.page(limit,offset);
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
  await this.authorize(actorUserId,tenantId,'saas.workloads.control');
  const reasonCode=state==='PAUSED'?'ADMIN_PAUSE':'ADMIN_RESUME';
  const reason=this.str(input.reason,'reason',1000);
  const key=this.idem(input.idempotency_key);
  const content={tenantId,factoryId,workloadClass,state,reasonCode,reason};
  const hash=this.hash(content);
  const result=await this.recordWorkloadControlInternal({tenantId,factoryId,actorUserId,workloadClass,state,source:'MANUAL',reasonCode,reason,idempotencyKey:key,requestHash:hash});
  return {idempotent:result.idempotent,control:result.control};
 }

 async listWorkloadControls(tenantId:string,factoryId:string|null,actorUserId:string) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.budgets.read');
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
    ORDER BY (factory_id=$2) DESC NULLS LAST,created_at DESC,id DESC`,
   [tenantId,factoryId,workloadClass],{tenantId,userId:actorUserId});
  if(latest.rows[0]?.control_state==='PAUSED')throw new ForbiddenException('Non-critical AI workload is paused by a tenant/factory SaaS budget control');
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
   if(status!=='SAFE') await this.persistBudgetAlert(tenantId,factoryScope,budget.id,evaluation.id,status,snapshot,actorUserId);
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


 async recordAiToolCall(tenantId:string,factoryId:string,actorUserId:string,input:{executionKey:string;toolId:string;workloadClass:string;occurredAt?:string}) {
  const executionKey=this.str(input.executionKey,'executionKey',255);
  const workloadClass=this.enum(input.workloadClass,WORKLOADS,'workloadClass') as SaasWorkloadClass;
  const toolId=this.str(input.toolId,'toolId',180);
  const capabilityCode='ai.tool.'+toolId.toLowerCase().replace(/[^a-z0-9._:-]/g,'-').slice(0,85);
  const key='ai-tool-call:'+this.sha(executionKey);
  const sourceRef='ai-tool-execution:'+this.sha(executionKey);
  this.scope(tenantId,actorUserId,factoryId);
  await this.authorize(actorUserId,tenantId,'saas.usage.write');
  const existing=await this.database.query<UsageRow>('SELECT '+USAGE_COLUMNS+' FROM saas_usage_events WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,key],{tenantId,userId:actorUserId});
  if(existing.rows[0]) {
   const row=existing.rows[0];
   if(row.metric_code!=='AI_TOOL_CALL'||row.capability_code!==capabilityCode||row.workload_class!==workloadClass||Number(row.quantity)!==1||row.source_event_ref!==sourceRef)throw new ConflictException('AI tool execution key was reused for different metering content');
   await this.evaluateBudgetsInternal(tenantId,factoryId,actorUserId,row.occurred_at);
   return {idempotent:true,event:this.mapUsage(row)};
  }
  return this.recordUsageEvent(tenantId,factoryId,actorUserId,{
   metric_code:SaasMeterMetric.AI_TOOL_CALL,capability_code:capabilityCode,workload_class:workloadClass,
   quantity:1,occurred_at:this.timestamp(input.occurredAt??new Date().toISOString(),'occurred_at'),
   source_system:SaasUsageSourceSystem.TOOL_GATEWAY,source_event_ref:sourceRef,idempotency_key:key,
  } as RecordSaasUsageEventDto);
 }

 async listBudgetAlerts(tenantId:string,factoryId:string|null,actorUserId:string,limit=25,offset=0,unreadOnly=false) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.alerts.read');this.page(limit,offset);
  const r=await this.database.query<BudgetAlertRow>(
   'SELECT a.id::text AS id,a.tenant_id::text AS tenant_id,a.factory_id::text AS factory_id,a.budget_id::text AS budget_id,a.budget_evaluation_id::text AS budget_evaluation_id,a.alert_type,a.severity,a.title,a.message_code,a.payload,a.payload_hash,a.created_at::text AS created_at,ack.acknowledged_at::text AS acknowledged_at FROM saas_budget_alerts a LEFT JOIN saas_budget_alert_acknowledgements ack ON ack.tenant_id=a.tenant_id AND ack.alert_id=a.id AND ack.acknowledged_by=$3 WHERE a.tenant_id=$1 AND (a.factory_id IS NULL OR $2::uuid IS NULL OR a.factory_id=$2) AND (NOT $4::boolean OR ack.id IS NULL) ORDER BY a.created_at DESC,a.id DESC LIMIT $5 OFFSET $6',
   [tenantId,factoryId,actorUserId,unreadOnly,limit,offset],{tenantId,userId:actorUserId});
  return {count:r.rows.length,alerts:r.rows.map(x=>this.mapBudgetAlert(x)),limit,offset,unreadOnly};
 }

 async acknowledgeBudgetAlert(tenantId:string,factoryId:string|null,actorUserId:string,alertId:string,input:AcknowledgeSaasBudgetAlertDto) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));
  if(!isUUID(alertId))throw new BadRequestException('alertId must be a UUID');
  await this.authorize(actorUserId,tenantId,'saas.alerts.ack');
  const visible=await this.database.query<QueryResultRow & {id:string}>('SELECT id::text AS id FROM saas_budget_alerts WHERE tenant_id=$1 AND id=$2 AND (factory_id IS NULL OR $3::uuid IS NULL OR factory_id=$3) LIMIT 1',[tenantId,alertId,factoryId],{tenantId,userId:actorUserId});
  if(!visible.rows[0])throw new NotFoundException('SaaS budget alert was not found in the current tenant/factory scope');
  const key=this.idem(input.idempotency_key), hash=this.hash({tenantId,alertId,actorUserId});
  const prior=await this.database.query<QueryResultRow & {id:string;alert_id:string;request_hash:string;acknowledged_at:string}>('SELECT id::text AS id,alert_id::text AS alert_id,request_hash,acknowledged_at::text AS acknowledged_at FROM saas_budget_alert_acknowledgements WHERE tenant_id=$1 AND (idempotency_key=$2 OR (alert_id=$3 AND acknowledged_by=$4)) LIMIT 1',[tenantId,key,alertId,actorUserId],{tenantId,userId:actorUserId});
  if(prior.rows[0]) {
   if(prior.rows[0].request_hash!==hash||prior.rows[0].alert_id!==alertId)throw new ConflictException('Alert acknowledgement idempotency key was reused for different content');
   return {idempotent:true,acknowledgement:{id:prior.rows[0].id,alertId,acknowledgedAt:prior.rows[0].acknowledged_at}};
  }
  const ins=await this.database.query<QueryResultRow & {id:string;acknowledged_at:string}>('INSERT INTO saas_budget_alert_acknowledgements(tenant_id,alert_id,acknowledged_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id::text AS id,acknowledged_at::text AS acknowledged_at',[tenantId,alertId,actorUserId,key,hash],{tenantId,userId:actorUserId});
  if(!ins.rows[0]) {
   const raced=await this.database.query<QueryResultRow & {id:string;alert_id:string;request_hash:string;acknowledged_at:string}>('SELECT id::text AS id,alert_id::text AS alert_id,request_hash,acknowledged_at::text AS acknowledged_at FROM saas_budget_alert_acknowledgements WHERE tenant_id=$1 AND (idempotency_key=$2 OR (alert_id=$3 AND acknowledged_by=$4)) LIMIT 1',[tenantId,key,alertId,actorUserId],{tenantId,userId:actorUserId});
   if(!raced.rows[0]||raced.rows[0].request_hash!==hash||raced.rows[0].alert_id!==alertId)throw new ConflictException('Alert acknowledgement conflicts with a concurrent request');
   return {idempotent:true,acknowledgement:{id:raced.rows[0].id,alertId,acknowledgedAt:raced.rows[0].acknowledged_at}};
  }
  await this.auditSafely({tenantId,factoryId,actorUserId,eventType:'SAAS_BUDGET_ALERT',action:'ACKNOWLEDGE_BUDGET_ALERT',resourceType:'SAAS_BUDGET_ALERT',resourceId:alertId,payload:{acknowledgementId:ins.rows[0].id,requestHash:hash}});
  return {idempotent:false,acknowledgement:{id:ins.rows[0].id,alertId,acknowledgedAt:ins.rows[0].acknowledged_at}};
 }

 async recordProviderCostEvent(tenantId:string,requestFactoryId:string|null,actorUserId:string,input:RecordSaasProviderCostEventDto) {
  this.scope(tenantId,actorUserId,...(requestFactoryId?[requestFactoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.provider_costs.write');
  const n=this.normalizeProviderCost(input,requestFactoryId),hash=this.hash({tenantId,factoryId:n.factory_id,...n.content});
  const existing=await this.database.query<ProviderCostRow>('SELECT '+PROVIDER_COST_COLUMNS+' FROM saas_provider_cost_events WHERE tenant_id=$1 AND (idempotency_key=$2 OR (provider_code=$3 AND source_system=$4 AND source_event_ref=$5)) LIMIT 1',[tenantId,n.idempotency_key,n.content.provider_code,n.content.source_system,n.content.source_event_ref],{tenantId,userId:actorUserId});
  if(existing.rows[0]) {if(existing.rows[0].request_hash!==hash)throw new ConflictException('Provider cost event idempotency key/source reference conflicts with different content');return {idempotent:true,event:this.mapProviderCost(existing.rows[0])};}
  const r=await this.database.query<ProviderCostRow>('INSERT INTO saas_provider_cost_events(tenant_id,factory_id,provider_code,model_code,metric_code,workload_class,quantity,currency,provider_cost_minor,occurred_at,provider_invoice_reference,source_system,source_event_ref,request_hash,idempotency_key,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING RETURNING '+PROVIDER_COST_COLUMNS,
   [tenantId,n.factory_id,n.content.provider_code,n.content.model_code,n.content.metric_code,n.content.workload_class,n.content.quantity,n.content.currency,n.content.provider_cost_minor,n.content.occurred_at,n.content.provider_invoice_reference,n.content.source_system,n.content.source_event_ref,hash,n.idempotency_key,actorUserId],{tenantId,userId:actorUserId});
  let row=r.rows[0];
  if(!row) {
   const raced=await this.database.query<ProviderCostRow>('SELECT '+PROVIDER_COST_COLUMNS+' FROM saas_provider_cost_events WHERE tenant_id=$1 AND (idempotency_key=$2 OR (provider_code=$3 AND source_system=$4 AND source_event_ref=$5)) LIMIT 1',[tenantId,n.idempotency_key,n.content.provider_code,n.content.source_system,n.content.source_event_ref],{tenantId,userId:actorUserId});
   row=raced.rows[0];if(!row||row.request_hash!==hash)throw new ConflictException('Provider cost event was concurrently recorded with conflicting content');return {idempotent:true,event:this.mapProviderCost(row)};
  }
  await this.auditSafely({tenantId,factoryId:n.factory_id,actorUserId,eventType:'SAAS_PROVIDER_COST',action:'RECORD_PROVIDER_COST_EVENT',resourceType:'SAAS_PROVIDER_COST_EVENT',resourceId:row.id,payload:{providerCode:row.provider_code,modelCode:row.model_code,metricCode:row.metric_code,quantity:String(row.quantity),currency:row.currency,providerCostMinor:String(row.provider_cost_minor),sourceRefSha256:this.sha(row.source_event_ref),requestHash:hash}});
  return {idempotent:false,event:this.mapProviderCost(row)};
 }

 async reconcileProviderCostInvoice(tenantId:string,factoryId:string|null,actorUserId:string,input:ReconcileSaasProviderCostInvoiceDto) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.provider_costs.reconcile');
  const n=this.normalizeProviderReconciliation(input),hash=this.hash({tenantId,factoryId,...n.content});
  const prior=await this.database.query<ProviderCostReconciliationRow>('SELECT '+PROVIDER_RECON_COLUMNS+' FROM saas_provider_cost_reconciliations WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,n.idempotency_key],{tenantId,userId:actorUserId});
  if(prior.rows[0]) {if(prior.rows[0].request_hash!==hash)throw new ConflictException('Provider reconciliation idempotency key conflicts with different content');return {idempotent:true,reconciliation:this.mapProviderReconciliation(prior.rows[0])};}
  const totals=await this.database.query<QueryResultRow & {event_count:string|number;ledger_cost_minor:string|number}>('SELECT COUNT(*)::text AS event_count,COALESCE(SUM(provider_cost_minor),0)::text AS ledger_cost_minor FROM saas_provider_cost_events WHERE tenant_id=$1 AND ($2::uuid IS NULL OR factory_id=$2) AND provider_code=$3 AND currency=$4 AND occurred_at >= $5 AND occurred_at < $6 AND provider_invoice_reference=$7',
   [tenantId,factoryId,n.content.provider_code,n.content.currency,n.content.period_start,n.content.period_end,n.content.invoice_reference],{tenantId,userId:actorUserId});
  const eventCountBigInt=BigInt(String(totals.rows[0]?.event_count??0));
  if(eventCountBigInt>BigInt(Number.MAX_SAFE_INTEGER))throw new BadRequestException('Provider reconciliation event count exceeds the supported integer range');
  const eventCount=Number(eventCountBigInt),ledger=BigInt(String(totals.rows[0]?.ledger_cost_minor??0)),invoice=BigInt(n.content.invoiced_provider_cost_minor);
  this.assertMoneyAggregateRange(ledger,'provider ledger cost');
  const variance=invoice-ledger;
  this.assertMoneyAggregateRange(variance,'provider invoice variance');
  const ledgerAmount=ledger.toString(),varianceAmount=variance.toString();
  const status=eventCount===0?'NO_PROVIDER_DATA':variance===0n?'MATCHED':'VARIANCE';
  const snapshot={tenantId,factoryId,...n.content,eventCount,ledger:ledgerAmount,variance:varianceAmount,status};
  const reportHash=this.hash(snapshot);
  const r=await this.database.query<ProviderCostReconciliationRow>('INSERT INTO saas_provider_cost_reconciliations(tenant_id,factory_id,provider_code,invoice_reference,reconciliation_version,period_start,period_end,currency,event_count,ledger_provider_cost_minor,invoiced_provider_cost_minor,variance_minor,status,report_hash,request_hash,idempotency_key,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING '+PROVIDER_RECON_COLUMNS,
   [tenantId,factoryId,n.content.provider_code,n.content.invoice_reference,n.content.reconciliation_version,n.content.period_start,n.content.period_end,n.content.currency,eventCount,ledgerAmount,n.content.invoiced_provider_cost_minor,varianceAmount,status,reportHash,hash,n.idempotency_key,actorUserId],{tenantId,userId:actorUserId});
  let row=r.rows[0];
  if(!row) {const raced=await this.database.query<ProviderCostReconciliationRow>('SELECT '+PROVIDER_RECON_COLUMNS+' FROM saas_provider_cost_reconciliations WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',[tenantId,n.idempotency_key],{tenantId,userId:actorUserId});row=raced.rows[0];if(!row||row.request_hash!==hash)throw new ConflictException('Provider invoice reconciliation conflicts with an existing snapshot');return {idempotent:true,reconciliation:this.mapProviderReconciliation(row)};}
  await this.auditSafely({tenantId,factoryId,actorUserId,eventType:'SAAS_PROVIDER_COST_RECONCILIATION',action:'RECONCILE_PROVIDER_INVOICE',resourceType:'SAAS_PROVIDER_COST_RECONCILIATION',resourceId:row.id,payload:{providerCode:row.provider_code,invoiceRefSha256:this.sha(row.invoice_reference),reconciliationVersion:row.reconciliation_version,eventCount:Number(row.event_count),ledgerCostMinor:String(row.ledger_provider_cost_minor),invoicedCostMinor:String(row.invoiced_provider_cost_minor),varianceMinor:String(row.variance_minor),status:row.status,reportHash:row.report_hash}});
  return {idempotent:false,reconciliation:this.mapProviderReconciliation(row)};
 }

 async listProviderCostReconciliations(tenantId:string,factoryId:string|null,actorUserId:string,limit=25,offset=0) {
  this.scope(tenantId,actorUserId,...(factoryId?[factoryId]:[]));await this.authorize(actorUserId,tenantId,'saas.provider_costs.read');this.page(limit,offset);
  const r=await this.database.query<ProviderCostReconciliationRow>('SELECT '+PROVIDER_RECON_COLUMNS+' FROM saas_provider_cost_reconciliations WHERE tenant_id=$1 AND ($2::uuid IS NULL OR factory_id=$2) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',[tenantId,factoryId,limit,offset],{tenantId,userId:actorUserId});
  return {count:r.rows.length,reconciliations:r.rows.map(x=>this.mapProviderReconciliation(x)),limit,offset};
 }


 private assertMoneyAggregateRange(value:bigint,field:string):void {
  // Aggregate columns are widened in migration 153, but PostgreSQL NUMERIC(30,0)
  // still has an explicit product limit. Reject rather than hash a rounded value.
  const max=999_999_999_999_999_999_999_999_999_999n;
  if(value>max||value< -max)throw new BadRequestException(field+' exceeds the supported 30-digit minor-unit range');
 }

 private async persistBudgetAlert(tenantId:string,factoryId:string|null,budgetId:string,evaluationId:string,status:'SAFE'|'WARNING'|'HARD_LIMIT'|'UNPRICED_USAGE'|'ANOMALY',snapshot:Record<string,unknown>,actorUserId:string) {
  const details=status==='WARNING'?{type:'WARNING',severity:'WARNING',title:'SaaS usage budget warning',message:'BUDGET_SOFT_LIMIT'}:status==='HARD_LIMIT'?{type:'HARD_LIMIT',severity:'CRITICAL',title:'SaaS usage budget hard limit reached',message:'BUDGET_HARD_LIMIT'}:status==='ANOMALY'?{type:'ANOMALY',severity:'CRITICAL',title:'Unusual SaaS spend detected',message:'SPEND_ANOMALY'}:{type:'UNPRICED_USAGE',severity:'WARNING',title:'Usage could not be priced',message:'USAGE_UNPRICED'};
  const payload={status,periodStart:snapshot['periodStart']??null,periodEnd:snapshot['periodEnd']??null,eventCount:snapshot['eventCount']??0,unpricedEventCount:snapshot['unpriced']??0,usageCostMinor:snapshot['usageCostMinor']??0,softLimitMinor:snapshot['soft']??0,hardLimitMinor:snapshot['hard']??0,anomalyWindowCostMinor:snapshot['recentCost']??0,reportHash:this.hash(snapshot)};
  const payloadHash=this.hash(payload);
  await this.database.query('INSERT INTO saas_budget_alerts(tenant_id,factory_id,budget_id,budget_evaluation_id,alert_type,severity,title,message_code,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT DO NOTHING',[tenantId,factoryId,budgetId,evaluationId,details.type,details.severity,details.title,details.message,JSON.stringify(payload),payloadHash],{tenantId,userId:actorUserId});
 }
 private normalizeProviderCost(input:RecordSaasProviderCostEventDto,requestFactoryId:string|null) {
  const provider_code=this.pattern(input.provider_code,'provider_code',/^[a-z][a-z0-9._:-]{0,59}$/);
  const model_code=input.model_code==null?null:this.pattern(input.model_code,'model_code',/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/);
  const metric_code=this.enum(input.metric_code,new Set(['AI_INPUT_TOKEN','AI_OUTPUT_TOKEN','AI_TOOL_CALL','PREMIUM_WORKLOAD','EDGE_INFERENCE','INTEGRATION_CALL']),'metric_code') as SaasMeterMetric;
  const workload_class=this.enum(input.workload_class,WORKLOADS,'workload_class') as SaasWorkloadClass;
  const parsedQuantity=this.decimalUnits(input.quantity,'quantity');
  const quantityUnits=parsedQuantity.units;
  if(quantityUnits<=0n||quantityUnits>1_000_000_000_000_000_000n)throw new BadRequestException('quantity must be positive and within the supported range');
  const quantity=parsedQuantity.value;
  const currency=this.pattern(input.currency,'currency',/^[A-Z]{3}$/);
  const provider_cost_minor=this.num(input.provider_cost_minor,'provider_cost_minor');
  if(!Number.isSafeInteger(provider_cost_minor)||provider_cost_minor<0||provider_cost_minor>9000000000000000)throw new BadRequestException('provider_cost_minor must be a supported non-negative minor-unit integer');
  const occurred_at=this.timestamp(input.occurred_at,'occurred_at');
  const provider_invoice_reference=input.provider_invoice_reference?this.str(input.provider_invoice_reference,'provider_invoice_reference',180):null;
  const source_system=this.enum(input.source_system,new Set(['PROVIDER_EXPORT','PROVIDER_API','MANUAL']),'source_system');
  const source_event_ref=this.str(input.source_event_ref,'source_event_ref',255);
  const idempotency_key=this.idem(input.idempotency_key);
  return {factory_id:requestFactoryId,idempotency_key,content:{provider_code,model_code,metric_code,workload_class,quantity,currency,provider_cost_minor,occurred_at,provider_invoice_reference,source_system,source_event_ref}};
 }
 private normalizeProviderReconciliation(input:ReconcileSaasProviderCostInvoiceDto) {
  const provider_code=this.pattern(input.provider_code,'provider_code',/^[a-z][a-z0-9._:-]{0,59}$/);
  const invoice_reference=this.str(input.invoice_reference,'invoice_reference',180);
  const reconciliation_version=this.num(input.reconciliation_version,'reconciliation_version');
  if(!Number.isInteger(reconciliation_version)||reconciliation_version<1||reconciliation_version>1000000)throw new BadRequestException('reconciliation_version must be between 1 and 1000000');
  const period=this.normalizePeriod(input.period_start,input.period_end,35);
  const currency=this.pattern(input.currency,'currency',/^[A-Z]{3}$/);
  const invoiced_provider_cost_minor=this.num(input.invoiced_provider_cost_minor,'invoiced_provider_cost_minor');
  if(!Number.isSafeInteger(invoiced_provider_cost_minor)||invoiced_provider_cost_minor<0||invoiced_provider_cost_minor>9000000000000000)throw new BadRequestException('invoiced_provider_cost_minor must be a supported non-negative minor-unit integer');
  const idempotency_key=this.idem(input.idempotency_key);
  return {idempotency_key,content:{provider_code,invoice_reference,reconciliation_version,period_start:period.start,period_end:period.end,currency,invoiced_provider_cost_minor}};
 }
 private mapBudgetAlert(r:BudgetAlertRow) {return {id:r.id,factoryId:r.factory_id,budgetId:r.budget_id,evaluationId:r.budget_evaluation_id,type:r.alert_type,severity:r.severity,title:r.title,messageCode:r.message_code,payload:r.payload,payloadHash:r.payload_hash,createdAt:r.created_at,acknowledgedAt:r.acknowledged_at};}
 private mapProviderCost(r:ProviderCostRow) {return {id:r.id,factoryId:r.factory_id,providerCode:r.provider_code,modelCode:r.model_code,metricCode:r.metric_code,workloadClass:r.workload_class,quantity:String(r.quantity),currency:r.currency,providerCostMinor:String(r.provider_cost_minor),occurredAt:r.occurred_at,providerInvoiceReference:r.provider_invoice_reference,sourceSystem:r.source_system,sourceRefHash:this.sha(r.source_event_ref),recordedBy:r.recorded_by,createdAt:r.created_at};}
 private mapProviderReconciliation(r:ProviderCostReconciliationRow) {return {id:r.id,factoryId:r.factory_id,providerCode:r.provider_code,invoiceReference:r.invoice_reference,reconciliationVersion:Number(r.reconciliation_version),periodStart:r.period_start,periodEnd:r.period_end,currency:r.currency,eventCount:Number(r.event_count),ledgerProviderCostMinor:String(r.ledger_provider_cost_minor),invoicedProviderCostMinor:String(r.invoiced_provider_cost_minor),varianceMinor:String(r.variance_minor),status:r.status,reportHash:r.report_hash,recordedBy:r.recorded_by,createdAt:r.created_at};}

 private decimalUnits(value:unknown,field:string):{units:bigint;value:string} {
  // NUMERIC(24,6) is the storage contract. Parse the submitted decimal spelling,
  // not its binary floating-point representation, and reject excess precision.
  const raw=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value.trim():'';
  const match=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if(!match)throw new BadRequestException(field+' must be a valid decimal number');
  const sign=match[1]==='-'?-1n:1n;
  const whole=match[2]??'0';
  const fraction=match[3]??match[4]??'';
  const exponent=match[5]===undefined?0:Number(match[5]);
  if(!Number.isInteger(exponent)||Math.abs(exponent)>30)throw new BadRequestException(field+' exponent is outside the supported range');
  const digits=whole+fraction;
  const decimalPoint=whole.length+exponent;
  let integerPart:string;
  let fractionPart:string;
  if(decimalPoint<=0){integerPart='0';fractionPart='0'.repeat(-decimalPoint)+digits;}
  else if(decimalPoint>=digits.length){integerPart=digits+'0'.repeat(decimalPoint-digits.length);fractionPart='';}
  else{integerPart=digits.slice(0,decimalPoint);fractionPart=digits.slice(decimalPoint);}
  integerPart=integerPart.replace(/^0+(?=\d)/,'')||'0';
  fractionPart=fractionPart.replace(/0+$/,'');
  if(fractionPart.length>6)throw new BadRequestException(field+' supports at most 6 decimal places');
  const scaledFraction=fractionPart.padEnd(6,'0');
  let units=(BigInt(integerPart)*1_000_000n)+BigInt(scaledFraction||'0');
  if(units!==0n)units*=sign;
  const canonicalSign=units<0n?'-':'';
  const magnitude=units<0n?-units:units;
  const canonicalInteger=(magnitude/1_000_000n).toString();
  const canonicalFraction=(magnitude%1_000_000n).toString().padStart(6,'0');
  return {units,value:canonicalSign+canonicalInteger+'.'+canonicalFraction};
 }

 private calculateUsageCostMinor(quantity:unknown,blockQuantity:unknown,rateMinorPerBlock:unknown):number {
  const q=this.decimalUnits(quantity,'quantity').units;
  const block=this.decimalUnits(blockQuantity,'block_quantity').units;
  const rate=typeof rateMinorPerBlock==='bigint'?rateMinorPerBlock:BigInt(String(rateMinorPerBlock));
  if(q<0n||block<=0n||rate<0n)throw new BadRequestException('Usage pricing inputs are outside the supported range');
  // Quantity and block share a six-decimal scale, so the scale cancels.
  // Integer half-up rounding prevents binary-float drift in minor currency units.
  const cost=(q*rate+(block/2n))/block;
  if(cost<0n||cost>9_000_000_000_000_000n)throw new BadRequestException('Estimated usage cost exceeds the supported integer range');
  return Number(cost);
 }

 private normalizeRate(input:CreateSaasMeterRateDto) {
  const metric=this.enum(input?.metric_code,METRICS,'metric_code') as SaasMeterMetric;
  const version=this.num(input?.rate_version,'rate_version');if(!Number.isInteger(version)||version<1||version>1000000)throw new BadRequestException('rate_version must be an integer between 1 and 1000000');
  const rate=this.num(input?.rate_minor_per_block,'rate_minor_per_block');if(!Number.isSafeInteger(rate)||rate<0||rate>9000000000000000)throw new BadRequestException('rate_minor_per_block must be a supported non-negative integer');
  const parsedBlock=this.decimalUnits(input?.block_quantity,'block_quantity');
  if(parsedBlock.units<1n||parsedBlock.units>1_000_000_000_000_000_000n)throw new BadRequestException('block_quantity is outside supported range');
  const block=parsedBlock.value;
  const currency=this.pattern(input?.currency,'currency',/^[A-Z]{3}$/),effective=this.timestamp(input?.effective_from,'effective_from'),key=this.idem(input?.idempotency_key);
  return {metric_code:metric,rate_version:version,rate_minor_per_block:rate,block_quantity:block,currency,effective_from:effective,idempotency_key:key,unit:UNITS[metric]};
 }
 private normalizeEvent(input:RecordSaasUsageEventDto) {
  const metric=this.enum(input?.metric_code,METRICS,'metric_code') as SaasMeterMetric,cap=this.pattern(input?.capability_code,'capability_code',/^[a-z][a-z0-9._:-]{0,99}$/);
  const workload=this.enum(input?.workload_class,WORKLOADS,'workload_class') as SaasWorkloadClass;
  const parsedQuantity=this.decimalUnits(input?.quantity,'quantity');
  if(parsedQuantity.units<=0n||parsedQuantity.units>1_000_000_000_000_000_000n)throw new BadRequestException('quantity must be greater than zero and within the supported range');
  const quantity=parsedQuantity.value;
  const occurred=this.timestamp(input?.occurred_at,'occurred_at'),source=this.enum(input?.source_system,SOURCES,'source_system') as SaasUsageSourceSystem;
  const ref=this.str(input?.source_event_ref,'source_event_ref',255),key=this.idem(input?.idempotency_key);
  return {idempotency_key:key,content:{metric_code:metric,capability_code:cap,workload_class:workload,quantity,occurred_at:occurred,source_system:source,source_event_ref:ref,unit:UNITS[metric]}};
 }
 private normalizeAdjustment(input:CreateSaasUsageAdjustmentDto) {
  const period=this.normalizePeriod(input?.period_start,input?.period_end,366),metric=input?.metric_code===undefined?null:this.enum(input.metric_code,METRICS,'metric_code') as SaasMeterMetric;
  const parsedQuantity=this.decimalUnits(input?.quantity_delta,'quantity_delta');
  if(parsedQuantity.units>1_000_000_000_000_000_000n||parsedQuantity.units< -1_000_000_000_000_000_000n)throw new BadRequestException('quantity_delta is outside the supported range');
  const quantity=parsedQuantity.value;
  const cost=this.num(input?.cost_delta_minor,'cost_delta_minor');if(!Number.isSafeInteger(cost)||Math.abs(cost)>9000000000000000)throw new BadRequestException('cost_delta_minor must be a supported integer');
  if(parsedQuantity.units===0n&&cost===0)throw new BadRequestException('An adjustment must change quantity or cost');
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