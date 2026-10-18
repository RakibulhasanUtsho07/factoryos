import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { calculateGrossMargin, calculateShouldCost, fromScaled, normalizeCostCurrency, toScaled, type ShouldCostCategory, type ShouldCostEvidenceInput, type ShouldCostRule } from './should-cost-engine';
import { CreateShouldCostAssessmentDto, CreateShouldCostProfileDto, ListShouldCostAssessmentsDto, ListShouldCostProfilesDto, ShouldCostEvidenceDto, TransitionShouldCostProfileDto } from './dto/should-cost.dto';

type ScopeType = 'PRODUCT_VERSION'|'ORDER'|'QUOTATION';
type ProfileStatus = 'DRAFT'|'PENDING_APPROVAL'|'APPROVED'|'REJECTED';
interface EventContext { requestId:string|null; traceId:string|null; }
interface ProfileRow extends QueryResultRow {
 id:string; tenant_id:string; factory_id:string; product_id:string|null; profile_code:string; version:number;
 currency:string; output_unit:string; status:ProfileStatus; is_current:boolean; row_version:string;
 idempotency_key:string; request_hash:string; created_by_user_id:string; updated_by_user_id:string;
 submitted_by_user_id:string|null; approved_by_user_id:string|null; decision_reason:string|null;
 created_at:string; updated_at:string; submitted_at:string|null; approved_at:string|null;
}
interface ProfileComponentRow extends QueryResultRow {
 category:ShouldCostCategory; calculation_method:ShouldCostRule['calculation_method'];
 is_required:boolean; base_categories:ShouldCostCategory[]; guidance:string;
}
type TargetSnapshot = Record<string,any>;
type PlainObject = Record<string,unknown>;
const CATEGORIES:ShouldCostCategory[]=['MATERIAL','LABOUR','ENERGY','FREIGHT','DUTY','OVERHEAD','SCRAP'];
const METHODS:Record<ShouldCostCategory,string[]> = {
 MATERIAL:['DIRECT_RATE'],LABOUR:['DIRECT_RATE'],ENERGY:['DIRECT_RATE'],
 FREIGHT:['DIRECT_RATE','FIXED_PER_BATCH'],DUTY:['DIRECT_RATE','PERCENT_OF_BASE'],
 OVERHEAD:['DIRECT_RATE','FIXED_PER_BATCH','PERCENT_OF_BASE'],SCRAP:['DIRECT_RATE','SCRAP_GROSS_UP'],
};
const RATE_SOURCES=new Set(['SUPPLIER_QUOTE','PURCHASE_ORDER','COST_RATE_CARD','UTILITY_BILL','FREIGHT_QUOTE','DUTY_SCHEDULE','OVERHEAD_POLICY','QUALITY_STANDARD','MANUAL_APPROVED']);
function canonical(value:unknown):unknown {
 if(Array.isArray(value)) return value.map(canonical);
 if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value as PlainObject).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
 return value;
}
function stableJson(value:unknown):string { return JSON.stringify(canonical(value)); }
function sha(value:unknown):string { return createHash('sha256').update(stableJson(value)).digest('hex'); }

@Injectable()
export class ShouldCostService {
 constructor(private readonly database:DatabaseService) {}

 async createProfile(userId:string,tenantId:string,factoryId:string,dto:CreateShouldCostProfileDto,keyInput:string|null,ctx:EventContext) {
  this.scope(userId,tenantId,factoryId);
  this.uuid(dto.factory_id,'factory_id');
  if(dto.factory_id.toLowerCase()!==factoryId.toLowerCase()) throw new ForbiddenException('factory_id must match authenticated factory scope');
  const key=this.idempotencyKey(keyInput), code=dto.profile_code.trim().toUpperCase(), currency=this.currency(dto.currency), unit=dto.output_unit.trim();
  if(!code||!unit) throw new BadRequestException('profile_code and output_unit are required');
  if(dto.components.length!==7||new Set(dto.components.map(x=>x.category)).size!==7||CATEGORIES.some(c=>!dto.components.some(x=>x.category===c))) {
   throw new BadRequestException('A profile must configure all seven cost categories exactly once');
  }
  const components=dto.components.map(c=>{
   const bases=c.base_categories??[];
   if(!METHODS[c.category].includes(c.calculation_method)) throw new BadRequestException(c.calculation_method+' is not supported for '+c.category);
   if(new Set(bases).size!==bases.length) throw new BadRequestException(c.category+' base categories must be unique');
   const pos=CATEGORIES.indexOf(c.category);
   if(['PERCENT_OF_BASE','SCRAP_GROSS_UP'].includes(c.calculation_method)) {
    if(!bases.length||bases.some(b=>CATEGORIES.indexOf(b)<0||CATEGORIES.indexOf(b)>=pos)) throw new BadRequestException(c.category+' may depend only on earlier cost categories');
   } else if(bases.length) throw new BadRequestException(c.category+' does not accept base categories for this method');
   if(!c.guidance.trim()) throw new BadRequestException(c.category+' guidance is required');
   return {category:c.category,calculation_method:c.calculation_method,is_required:c.is_required??true,base_categories:bases,guidance:c.guidance.trim()};
  });
  const requestHash=sha({...dto,profile_code:code,currency,output_unit:unit,components}), id=randomUUID();
  try {
   return await this.database.transaction({tenantId,userId,requestId:ctx.requestId,traceId:ctx.traceId,advisoryLockKey:'sc-profile:'+tenantId+':'+factoryId+':'+key},async client=>{
    await this.activeFactory(client,tenantId,factoryId);
    const prior=await client.query<{id:string;request_hash:string}>("SELECT id::text AS id,request_hash FROM should_cost_profiles WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[tenantId,factoryId,key]);
    if(prior.rows[0]) {
     if(prior.rows[0].request_hash!==requestHash) throw new ConflictException('Idempotency-Key was reused with a different profile request');
     return this.loadProfile(client,tenantId,factoryId,prior.rows[0].id);
    }
    if(dto.product_id) {
     const product=await client.query("SELECT 1 FROM product_definitions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE'",[dto.product_id,tenantId,factoryId]);
     if(!product.rows[0]) throw new NotFoundException('Active product definition was not found in this factory');
    }
    const vr=await client.query<{version:number|null}>("SELECT MAX(version)::int AS version FROM should_cost_profiles WHERE tenant_id=$1 AND factory_id=$2 AND lower(profile_code)=lower($3) AND product_id IS NOT DISTINCT FROM $4::uuid",[tenantId,factoryId,code,dto.product_id??null]);
    const version=Number(vr.rows[0]?.version??0)+1;
    await client.query("INSERT INTO should_cost_profiles(id,tenant_id,factory_id,product_id,profile_code,version,currency,output_unit,status,is_current,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',false,1,$9,$10,$11,$11)",[id,tenantId,factoryId,dto.product_id??null,code,version,currency,unit,key,requestHash,userId]);
    for(const c of components) await client.query("INSERT INTO should_cost_profile_components(tenant_id,factory_id,profile_id,category,calculation_method,is_required,base_categories,guidance,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[tenantId,factoryId,id,c.category,c.calculation_method,c.is_required,c.base_categories,c.guidance,userId]);
    await this.history(client,tenantId,factoryId,id,null,'PROFILE_CREATED',userId,'Created versioned should-cost profile draft',ctx,{profile_code:code,version,product_id:dto.product_id??null,currency,output_unit:unit,components});
    await this.event(client,tenantId,factoryId,id,'SHOULD_COST.PROFILE_CREATED',{profile_id:id,profile_code:code,version,currency},userId,ctx);
    return this.loadProfile(client,tenantId,factoryId,id);
   });
  } catch(error) {
   if(this.pgCode(error)==='23505') throw new ConflictException('Profile version or idempotency key conflicts with an existing record');
   throw error;
  }
 }

 async listProfiles(userId:string,tenantId:string,factoryId:string,query:ListShouldCostProfilesDto) {
  this.scope(userId,tenantId,factoryId);
  return this.database.transaction({tenantId,userId},async client=>{
   const result=await client.query("SELECT id::text AS id,product_id::text AS product_id,profile_code,version,currency,output_unit,status,is_current,row_version::text AS row_version,created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,submitted_by_user_id::text AS submitted_by_user_id,approved_by_user_id::text AS approved_by_user_id,decision_reason,created_at::text AS created_at,updated_at::text AS updated_at,submitted_at::text AS submitted_at,approved_at::text AS approved_at FROM should_cost_profiles WHERE tenant_id=$1 AND factory_id=$2 AND ($3::text IS NULL OR lower(profile_code)=lower($3)) AND ($4::uuid IS NULL OR product_id=$4) AND ($5::text IS NULL OR status=$5) ORDER BY profile_code,COALESCE(product_id,'00000000-0000-0000-0000-000000000000'::uuid),version DESC LIMIT 100",[tenantId,factoryId,query.profile_code?.trim()||null,query.product_id??null,query.status??null]);
   return {items:result.rows};
  });
 }

 async getProfile(userId:string,tenantId:string,factoryId:string,profileId:string) {
  this.scope(userId,tenantId,factoryId);this.uuid(profileId,'profileId');
  return this.database.transaction({tenantId,userId},async client=>{
   const result=await this.loadProfile(client,tenantId,factoryId,profileId);
   if(!result) throw new NotFoundException('Should-cost profile was not found');
   return result;
  });
 }

 async transitionProfile(userId:string,tenantId:string,factoryId:string,profileId:string,action:'SUBMIT'|'APPROVE'|'REJECT',dto:TransitionShouldCostProfileDto,ctx:EventContext) {
  this.scope(userId,tenantId,factoryId);this.uuid(profileId,'profileId');
  if(!Number.isInteger(dto.expected_version)||dto.expected_version<1||!dto.reason.trim()) throw new BadRequestException('expected_version and a non-empty reason are required');
  const reason=dto.reason.trim();
  return this.database.transaction({tenantId,userId,requestId:ctx.requestId,traceId:ctx.traceId},async client=>{
   const profile=await this.lockProfile(client,tenantId,factoryId,profileId);
   if(!profile) throw new NotFoundException('Should-cost profile was not found');
   if(Number(profile.row_version)!==dto.expected_version) throw new ConflictException('Profile row-version conflict');
   if(action==='SUBMIT') {
    if(profile.status!=='DRAFT') throw new ConflictException('Only a draft profile can be submitted');
    await client.query("UPDATE should_cost_profiles SET status='PENDING_APPROVAL',row_version=row_version+1,updated_by_user_id=$1,submitted_by_user_id=$1,submitted_at=clock_timestamp(),decision_reason=$2,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6",[userId,reason,profileId,tenantId,factoryId,dto.expected_version]);
   } else {
    if(profile.status!=='PENDING_APPROVAL') throw new ConflictException('Only a pending profile can be approved or rejected');
    if(profile.created_by_user_id===userId) throw new ForbiddenException('Profile creator cannot approve or reject their own costing policy');
    if(action==='APPROVE') {
     const old=await client.query<{id:string;row_version:string}>("SELECT id::text AS id,row_version::text AS row_version FROM should_cost_profiles WHERE tenant_id=$1 AND factory_id=$2 AND lower(profile_code)=lower($3) AND product_id IS NOT DISTINCT FROM $4::uuid AND is_current=true AND id<>$5 FOR UPDATE",[tenantId,factoryId,profile.profile_code,profile.product_id,profileId]);
     if(old.rows[0]) await client.query("UPDATE should_cost_profiles SET is_current=false,row_version=row_version+1,updated_by_user_id=$1,updated_at=clock_timestamp() WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND row_version=$5",[userId,old.rows[0].id,tenantId,factoryId,Number(old.rows[0].row_version)]);
    }
    const next=action==='APPROVE'?'APPROVED':'REJECTED';
    await client.query("UPDATE should_cost_profiles SET status=$1,is_current=$2,row_version=row_version+1,updated_by_user_id=$3,approved_by_user_id=$3,approved_at=clock_timestamp(),decision_reason=$4,updated_at=clock_timestamp() WHERE id=$5 AND tenant_id=$6 AND factory_id=$7 AND row_version=$8",[next,action==='APPROVE',userId,reason,profileId,tenantId,factoryId,dto.expected_version]);
   }
   const actionName=action==='SUBMIT'?'PROFILE_SUBMITTED':action==='APPROVE'?'PROFILE_APPROVED':'PROFILE_REJECTED';
   await this.history(client,tenantId,factoryId,profileId,null,actionName,userId,reason,ctx,{version:profile.version});
   await this.event(client,tenantId,factoryId,profileId,'SHOULD_COST.'+actionName,{profile_id:profileId,version:profile.version,status:action==='SUBMIT'?'PENDING_APPROVAL':action==='APPROVE'?'APPROVED':'REJECTED'},userId,ctx);
   return this.loadProfile(client,tenantId,factoryId,profileId);
  });
 }

 async createAssessment(userId:string,tenantId:string,factoryId:string,dto:CreateShouldCostAssessmentDto,keyInput:string|null,ctx:EventContext) {
  this.scope(userId,tenantId,factoryId);this.uuid(dto.target_id,'target_id');this.uuid(dto.profile_id,'profile_id');
  const key=this.idempotencyKey(keyInput),requestHash=sha({...dto,target_quantity:String(dto.target_quantity),target_unit:dto.target_unit.trim()}),id=randomUUID();
  try {
   return await this.database.transaction({tenantId,userId,requestId:ctx.requestId,traceId:ctx.traceId,advisoryLockKey:'sc-assessment:'+tenantId+':'+factoryId+':'+key},async client=>{
    const prior=await client.query<{id:string;request_hash:string}>("SELECT id::text AS id,request_hash FROM should_cost_assessments WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[tenantId,factoryId,key]);
    if(prior.rows[0]) {
     if(prior.rows[0].request_hash!==requestHash) throw new ConflictException('Idempotency-Key was reused with a different assessment request');
     return this.loadAssessment(client,tenantId,factoryId,prior.rows[0].id);
    }
    const pr=await client.query<ProfileRow>("SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,product_id::text AS product_id,profile_code,version,currency,output_unit,status,is_current,row_version::text AS row_version,idempotency_key,request_hash,created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,submitted_by_user_id::text AS submitted_by_user_id,approved_by_user_id::text AS approved_by_user_id,decision_reason,created_at::text AS created_at,updated_at::text AS updated_at,submitted_at::text AS submitted_at,approved_at::text AS approved_at FROM should_cost_profiles WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE",[dto.profile_id,tenantId,factoryId]);
    const profile=pr.rows[0];
    if(!profile) throw new NotFoundException('Should-cost profile was not found in this factory');
    if(profile.status!=='APPROVED'||!profile.is_current) throw new ConflictException('Assessment requires the current approved profile version');
    const cr=await client.query<ProfileComponentRow>("SELECT category,calculation_method,is_required,base_categories,guidance FROM should_cost_profile_components WHERE profile_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY array_position(ARRAY['MATERIAL','LABOUR','ENERGY','FREIGHT','DUTY','OVERHEAD','SCRAP']::varchar[],category)",[profile.id,tenantId,factoryId]);
    const rules:ShouldCostRule[]=cr.rows.map(row=>({category:row.category,calculation_method:row.calculation_method,is_required:row.is_required,base_categories:row.base_categories}));
    if(rules.length!==7) throw new ConflictException('Profile does not contain all seven approved formulas');
    const target=await this.resolveTarget(client,tenantId,factoryId,dto.scope_type,dto.target_id);
    if(dto.target_unit.trim().toUpperCase()!==profile.output_unit.trim().toUpperCase()) throw new BadRequestException('target_unit must match the approved profile output_unit');
    if(dto.scope_type==='PRODUCT_VERSION'&&target.base_unit&&dto.target_unit.trim().toUpperCase()!==String(target.base_unit).trim().toUpperCase()) throw new BadRequestException('Product-version target_unit must match the product base unit');
    if(profile.product_id&&(dto.scope_type!=='PRODUCT_VERSION'||profile.product_id!==target.product_id)) throw new BadRequestException('Product-specific profile may only cost its own product version');
    if(dto.scope_type!=='PRODUCT_VERSION'&&profile.product_id) throw new BadRequestException('Order and quotation assessments require a factory-level profile');
    const inputs:ShouldCostEvidenceInput[]=[];
    for(const line of dto.evidence) {
     const rule=rules.find(r=>r.category===line.category);
     if(!rule) throw new BadRequestException('Evidence category is not configured by the selected profile');
     inputs.push(await this.normalizeEvidence(client,tenantId,factoryId,dto.scope_type,dto.target_id,target,dto.target_quantity,profile.currency,rule,line));
    }
    let calculation:ReturnType<typeof calculateShouldCost>;
    try { calculation=calculateShouldCost({currency:profile.currency,target_quantity:dto.target_quantity,target_unit:dto.target_unit,rules,evidence:inputs}); }
    catch(error) { throw new BadRequestException(error instanceof Error?error.message:'Should-cost input is invalid'); }
    const revenue=await this.resolveRevenue(client,tenantId,factoryId,dto.scope_type,dto.target_id,profile.currency,target);
    const margin=calculateGrossMargin(revenue.amount,calculation.total_cost);
    const snapshot={formula_version:calculation.formula_version,scope_type:dto.scope_type,scope_id:dto.target_id,
      product_id:target.product_id??null,product_version_id:target.product_version_id??null,
      quotation_revision_number:target.quotation_revision_number??null,
      profile:{id:profile.id,code:profile.profile_code,version:profile.version,currency:profile.currency,output_unit:profile.output_unit},
      target_quantity:calculation.target_quantity,target_unit:calculation.target_unit,component_totals:calculation.component_totals,
      total_cost:calculation.total_cost,cost_per_unit:calculation.cost_per_unit,revenue,margin,
      evidence:calculation.evidence.map(e=>e.evidence_hash_payload)};
    await client.query("INSERT INTO should_cost_assessments(id,tenant_id,factory_id,scope_type,scope_id,product_id,product_version_id,order_id,quotation_id,quotation_revision_number,profile_id,profile_version,profile_code,target_quantity,target_unit,currency,total_cost,cost_per_unit,component_totals,revenue_source_currency,revenue_amount,revenue_fx_snapshot,gross_margin_amount,gross_margin_percent,request_snapshot,request_hash,idempotency_key,status,calculated_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22::jsonb,$23,$24,$25::jsonb,$26,$27,'READY',$28)",[
      id,tenantId,factoryId,dto.scope_type,dto.target_id,dto.scope_type==='PRODUCT_VERSION'?target.product_id:null,
      dto.scope_type==='PRODUCT_VERSION'?dto.target_id:null,dto.scope_type==='ORDER'?dto.target_id:null,
      dto.scope_type==='QUOTATION'?dto.target_id:null,dto.scope_type==='QUOTATION'?target.quotation_revision_number:null,
      profile.id,profile.version,profile.profile_code,calculation.target_quantity,calculation.target_unit,profile.currency,
      calculation.total_cost,calculation.cost_per_unit,JSON.stringify(calculation.component_totals),revenue.source_currency,
      revenue.amount,revenue.snapshot?JSON.stringify(revenue.snapshot):null,margin?.gross_margin_amount??null,margin?.gross_margin_percent??null,
      JSON.stringify(snapshot),requestHash,key,userId]);
    for(const line of calculation.evidence) await client.query(
      "INSERT INTO should_cost_component_evidence(tenant_id,factory_id,assessment_id,category,line_number,applicable,calculation_method,input_quantity,unit_code,unit_rate,fixed_amount,percentage_rate,source_currency,fx_rate_to_cost_currency,fx_rate_effective_on,fx_rate_source,source_amount,cost_amount,base_categories,base_amount,source_type,source_reference,source_as_of,notes,source_snapshot,evidence_hash,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$27)",[
        tenantId,factoryId,id,line.category,line.line_number,line.applicable,line.calculation_method,line.input_quantity,line.unit_code,
        line.unit_rate,line.fixed_amount,line.percentage_rate,line.source_currency,line.fx_rate_to_cost_currency,line.fx_rate_effective_on,
        line.fx_rate_source,line.source_amount,line.cost_amount,line.base_categories,line.base_amount,line.source_type,line.source_reference,
        line.source_as_of,line.notes,JSON.stringify(line.source_snapshot),sha(line.evidence_hash_payload),userId]);
    await this.history(client,tenantId,factoryId,null,id,'ASSESSMENT_CREATED',userId,'Deterministic assessment calculated from versioned evidence',ctx,snapshot);
    await this.event(client,tenantId,factoryId,id,'SHOULD_COST.ASSESSMENT_CREATED',{assessment_id:id,scope_type:dto.scope_type,scope_id:dto.target_id,
      profile_id:profile.id,profile_version:profile.version,currency:profile.currency,total_cost:calculation.total_cost,
      cost_per_unit:calculation.cost_per_unit,quotation_revision_number:target.quotation_revision_number??null},userId,ctx);
    return this.loadAssessment(client,tenantId,factoryId,id);
   });
  } catch(error) {
   if(this.pgCode(error)==='23505') throw new ConflictException('Should-cost assessment conflicts with an existing idempotency key');
   if(this.pgCode(error)==='23514') throw new ConflictException(this.pgMessage(error)||'A should-cost database invariant was not satisfied');
   throw error;
  }
 }

 async listAssessments(userId:string,tenantId:string,factoryId:string,query:ListShouldCostAssessmentsDto) {
  this.scope(userId,tenantId,factoryId);
  const result=await this.database.transaction({tenantId,userId},client=>client.query(
   "SELECT id::text AS id,scope_type,scope_id::text AS scope_id,product_version_id::text AS product_version_id,order_id::text AS order_id,quotation_id::text AS quotation_id,quotation_revision_number,profile_id::text AS profile_id,profile_code,profile_version,target_quantity::text AS target_quantity,target_unit,currency,total_cost::text AS total_cost,cost_per_unit::text AS cost_per_unit,component_totals,revenue_source_currency,revenue_amount::text AS revenue_amount,revenue_fx_snapshot,gross_margin_amount::text AS gross_margin_amount,gross_margin_percent::text AS gross_margin_percent,status,calculated_by_user_id::text AS calculated_by_user_id,created_at::text AS created_at FROM should_cost_assessments WHERE tenant_id=$1 AND factory_id=$2 AND ($3::text IS NULL OR scope_type=$3) AND ($4::uuid IS NULL OR scope_id=$4) ORDER BY created_at DESC,id DESC LIMIT $5",
   [tenantId,factoryId,query.scope_type??null,query.target_id??null,query.limit??20]));
  return {items:result.rows};
 }

 async getAssessment(userId:string,tenantId:string,factoryId:string,id:string) {
  this.scope(userId,tenantId,factoryId);this.uuid(id,'assessmentId');
  return this.database.transaction({tenantId,userId},async client=>{
   const result=await this.loadAssessment(client,tenantId,factoryId,id);
   if(!result) throw new NotFoundException('Should-cost assessment was not found');
   return result;
  });
 }

 private async resolveTarget(client:PoolClient,tenantId:string,factoryId:string,scopeType:ScopeType,targetId:string):Promise<TargetSnapshot> {
  if(scopeType==='PRODUCT_VERSION') {
   const result=await client.query("SELECT pv.id::text AS id,pv.product_id::text AS product_id,p.product_code,p.product_name,p.base_unit,pv.state,pv.expected_yield_percent::text AS expected_yield_percent FROM product_versions pv JOIN product_definitions p ON p.id=pv.product_id AND p.tenant_id=pv.tenant_id AND p.factory_id=pv.factory_id WHERE pv.id=$1 AND pv.tenant_id=$2 AND pv.factory_id=$3",[targetId,tenantId,factoryId]);
   const row=result.rows[0] as Record<string,any>|undefined;
   if(!row) throw new NotFoundException('Product version was not found in this factory');
   if(row.state!=='APPROVED') throw new ConflictException('Should-cost requires an approved product version');
   return {product_id:row.product_id,product_version_id:row.id,product_code:row.product_code,product_name:row.product_name};
  }
  if(scopeType==='ORDER') {
   const result=await client.query("SELECT id::text AS id,order_number,currency,status FROM orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[targetId,tenantId,factoryId]);
   const row=result.rows[0] as Record<string,any>|undefined;
   if(!row) throw new NotFoundException('Order was not found in this factory');
   if(['CANCELLED','CLOSED'].includes(row.status)) throw new ConflictException('A cancelled or closed order cannot be costed');
   return {order_number:row.order_number,source_currency:row.currency};
  }
  const result=await client.query("SELECT q.id::text AS id,q.quote_number,q.status,q.current_revision,v.currency,round(v.subtotal-v.discount_total,4)::numeric(20,4)::text AS net_revenue FROM sales_quotations q JOIN quotation_versions v ON v.quotation_id=q.id AND v.revision_number=q.current_revision AND v.tenant_id=q.tenant_id AND v.factory_id=q.factory_id WHERE q.id=$1 AND q.tenant_id=$2 AND q.factory_id=$3",[targetId,tenantId,factoryId]);
  const row=result.rows[0] as Record<string,any>|undefined;
  if(!row) throw new NotFoundException('Quotation/current revision was not found in this factory');
  if(['CANCELLED','EXPIRED','CONVERTED'].includes(row.status)) throw new ConflictException('A cancelled, expired or converted quotation cannot be costed');
  return {quote_number:row.quote_number,source_currency:row.currency,quotation_revision_number:Number(row.current_revision),net_revenue:row.net_revenue};
 }

 private async normalizeEvidence(client:PoolClient,tenantId:string,factoryId:string,scopeType:ScopeType,targetId:string,target:TargetSnapshot,targetQuantity:number,costCurrency:string,rule:ShouldCostRule,line:ShouldCostEvidenceDto):Promise<ShouldCostEvidenceInput> {
  if(!line.applicable) {
   if(rule.is_required) throw new BadRequestException('Required component '+line.category+' cannot be NOT_APPLICABLE');
   return {category:line.category,line_number:line.line_number,applicable:false,source_type:'NOT_APPLICABLE',notes:line.notes.trim(),
    source_snapshot:{reason:line.notes.trim(),profile_category:rule.category}};
  }
  if(!RATE_SOURCES.has(line.source_type)) throw new BadRequestException('Unsupported cost-rate evidence source type');
  if(!line.source_reference?.trim()) throw new BadRequestException(line.category+' source_reference is required');
  const sourceDate=this.dateOnly(line.source_as_of,'source_as_of');
  const ds=await client.query<{future:boolean}>('SELECT $1::date > CURRENT_DATE AS future',[sourceDate]);
  if(ds.rows[0]?.future) throw new BadRequestException(line.category+' source_as_of cannot be in the future');
  const rateSnapshot=line.source_snapshot;
  if(!rateSnapshot||!Object.keys(rateSnapshot).length) throw new BadRequestException(line.category+' needs a structured rate/source snapshot');
  let quantitySnapshot:PlainObject|null=null,inputQuantity:string|number|undefined=line.input_quantity,unitCode=line.unit_code?.trim()??null,unitRate:string|number|undefined=line.unit_rate;
  let sourceCurrency=line.source_currency?this.currency(line.source_currency):null;
  if(['MATERIAL','LABOUR','ENERGY'].includes(line.category)) {
   if(!line.quantity_source_type||!line.quantity_source_reference?.trim()) throw new BadRequestException(line.category+' requires a quantity source as well as rate evidence');
   if(line.quantity_source_type==='BOM') {
    if(line.category!=='MATERIAL') throw new BadRequestException('BOM evidence can only support MATERIAL');
    const resolved=await this.resolveBomQuantity(client,tenantId,factoryId,scopeType,targetId,target,line.quantity_source_reference,targetQuantity,inputQuantity,unitCode);
    inputQuantity=resolved.quantity;unitCode=resolved.unit;quantitySnapshot=resolved.snapshot;
   } else if(line.quantity_source_type==='ROUTING') {
    if(line.category!=='LABOUR') throw new BadRequestException('ROUTING evidence can only support LABOUR');
    const resolved=await this.resolveRoutingQuantity(client,tenantId,factoryId,scopeType,targetId,target,line.quantity_source_reference,targetQuantity,inputQuantity,unitCode);
    inputQuantity=resolved.quantity;unitCode=resolved.unit;quantitySnapshot=resolved.snapshot;
   } else if(line.quantity_source_type==='UTILITY_READING') {
    if(line.category!=='ENERGY') throw new BadRequestException('UTILITY_READING evidence can only support ENERGY');
    const resolved=await this.resolveUtilityQuantity(client,tenantId,factoryId,line.quantity_source_reference,targetQuantity,inputQuantity,unitCode,unitRate,sourceCurrency);
    inputQuantity=resolved.quantity;unitCode=resolved.unit;unitRate=resolved.rate;sourceCurrency=resolved.currency;quantitySnapshot=resolved.snapshot;
   } else {
    if(!line.quantity_source_snapshot||!Object.keys(line.quantity_source_snapshot).length||inputQuantity==null||!unitCode) throw new BadRequestException(line.category+' MANUAL_APPROVED quantity evidence requires snapshot, quantity and unit');
    quantitySnapshot={source_type:'MANUAL_APPROVED',source_reference:line.quantity_source_reference,source_snapshot:line.quantity_source_snapshot,submitted_quantity:String(inputQuantity),unit:unitCode};
   }
  } else if(line.quantity_source_type&&line.quantity_source_type!=='MANUAL_APPROVED') {
   throw new BadRequestException('Quantity source is only valid for material, labour or energy');
  } else if(line.quantity_source_type==='MANUAL_APPROVED') {
   if(!line.quantity_source_reference?.trim()||!line.quantity_source_snapshot||!Object.keys(line.quantity_source_snapshot).length) throw new BadRequestException(line.category+' manual quantity evidence needs reference and snapshot');
   quantitySnapshot={source_type:'MANUAL_APPROVED',source_reference:line.quantity_source_reference,source_snapshot:line.quantity_source_snapshot};
  }
  let fxRate:string|null=null,fxDate:string|null=null,fxSource:string|null=null;
  if(!['DIRECT_RATE','FIXED_PER_BATCH'].includes(rule.calculation_method)&&sourceCurrency!==null) throw new BadRequestException(line.category+' percentage-based formulas must not declare a source currency');
  if(['DIRECT_RATE','FIXED_PER_BATCH'].includes(rule.calculation_method)) {
   if(sourceCurrency==null) throw new BadRequestException(line.category+' source_currency is required');
   if(sourceCurrency===costCurrency) {fxRate='1.0000000000';fxDate=sourceDate;fxSource='IDENTITY';}
   else {const fx=await this.resolveFx(client,tenantId,factoryId,sourceCurrency,costCurrency,sourceDate);fxRate=fx.rate;fxDate=fx.effective_on;fxSource=fx.source;}
  } else if(line.percentage_rate==null) throw new BadRequestException(line.category+' percentage_rate is required');
  return {category:line.category,line_number:line.line_number,applicable:true,input_quantity:inputQuantity,unit_code:unitCode,
   unit_rate:unitRate,fixed_amount:line.fixed_amount,percentage_rate:line.percentage_rate,source_currency:sourceCurrency,
   fx_rate_to_cost_currency:fxRate,fx_rate_effective_on:fxDate,fx_rate_source:fxSource,source_type:line.source_type,
   source_reference:line.source_reference.trim(),source_as_of:sourceDate,notes:line.notes.trim(),
   source_snapshot:{rate_evidence:{source_type:line.source_type,source_reference:line.source_reference.trim(),source_as_of:sourceDate,snapshot:rateSnapshot},quantity_evidence:quantitySnapshot}};
 }

 private async resolveBomQuantity(client:PoolClient,tenantId:string,factoryId:string,scopeType:ScopeType,targetId:string,target:TargetSnapshot,sourceId:string,targetQty:number,inputQty:number|undefined,unitCode:string|null) {
  this.uuid(sourceId,'quantity_source_reference');
  const q=await client.query("SELECT b.id::text AS bom_line_id,b.line_number,b.quantity_per::text AS quantity_per,b.unit,b.wastage_percent::text AS wastage_percent,pv.id::text AS product_version_id,pv.state,p.product_code,p.product_name,i.sku AS component_sku,i.name AS component_name FROM product_bom_lines b JOIN product_versions pv ON pv.id=b.product_version_id AND pv.tenant_id=b.tenant_id AND pv.factory_id=b.factory_id AND pv.product_id=b.product_id JOIN product_definitions p ON p.id=b.product_id AND p.tenant_id=b.tenant_id AND p.factory_id=b.factory_id JOIN inventory_items i ON i.id=b.component_item_id AND i.tenant_id=b.tenant_id AND i.factory_id=b.factory_id WHERE b.id=$1 AND b.tenant_id=$2 AND b.factory_id=$3",[sourceId,tenantId,factoryId]);
  const row=q.rows[0] as Record<string,any>|undefined;
  if(!row||row.state!=='APPROVED') throw new NotFoundException('BOM quantity source must be an approved same-factory BOM line');
  await this.assertTargetHasProduct(client,tenantId,factoryId,scopeType,targetId,target,row.product_code,row.product_version_id);
  const scopedQty=await this.scopedProductQuantity(client,tenantId,factoryId,scopeType,targetId,row.product_code,targetQty);
  const expectedResult=await client.query<{quantity:string}>('SELECT round($1::numeric*$2::numeric*(1+$3::numeric/100),6)::text AS quantity',[scopedQty,row.quantity_per,row.wastage_percent]);
  const quantity=expectedResult.rows[0]?.quantity??'0';
  if(inputQty==null||toScaled(inputQty,6,'input_quantity')!==toScaled(quantity,6,'expected BOM quantity')) throw new BadRequestException('MATERIAL quantity must match BOM quantity plus configured wastage');
  if(!unitCode||unitCode.trim().toUpperCase()!==String(row.unit).trim().toUpperCase()) throw new BadRequestException('MATERIAL unit must match the BOM unit');
  return {quantity,unit:row.unit,snapshot:{source_type:'BOM',bom_line_id:row.bom_line_id,product_version_id:row.product_version_id,
   product_code:row.product_code,product_name:row.product_name,line_number:row.line_number,component_sku:row.component_sku,
   component_name:row.component_name,quantity_per:row.quantity_per,unit:row.unit,wastage_percent:row.wastage_percent,expected_quantity:quantity}};
 }

 private async resolveRoutingQuantity(client:PoolClient,tenantId:string,factoryId:string,scopeType:ScopeType,targetId:string,target:TargetSnapshot,sourceId:string,targetQty:number,inputQty:number|undefined,unitCode:string|null) {
  this.uuid(sourceId,'quantity_source_reference');
  const q=await client.query("SELECT r.id::text AS routing_step_id,r.step_number,r.operation_code,r.operation_name,r.setup_minutes::text AS setup_minutes,r.run_minutes_per_unit::text AS run_minutes_per_unit,r.queue_minutes::text AS queue_minutes,r.transfer_minutes::text AS transfer_minutes,pv.id::text AS product_version_id,pv.state,p.product_code,p.product_name,w.code AS work_centre_code,w.name AS work_centre_name FROM product_routing_steps r JOIN product_versions pv ON pv.id=r.product_version_id AND pv.tenant_id=r.tenant_id AND pv.factory_id=r.factory_id AND pv.product_id=r.product_id JOIN product_definitions p ON p.id=r.product_id AND p.tenant_id=r.tenant_id AND p.factory_id=r.factory_id JOIN manufacturing_work_centres w ON w.id=r.work_centre_id AND w.tenant_id=r.tenant_id AND w.factory_id=r.factory_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3",[sourceId,tenantId,factoryId]);
  const row=q.rows[0] as Record<string,any>|undefined;
  if(!row||row.state!=='APPROVED') throw new NotFoundException('Routing source must be an approved same-factory step');
  await this.assertTargetHasProduct(client,tenantId,factoryId,scopeType,targetId,target,row.product_code,row.product_version_id);
  const scopedQty=await this.scopedProductQuantity(client,tenantId,factoryId,scopeType,targetId,row.product_code,targetQty);
  const expectedResult=await client.query<{quantity:string}>('SELECT round(($1::numeric+$2::numeric*$3::numeric+$4::numeric+$5::numeric)/60,6)::text AS quantity',[row.setup_minutes,row.run_minutes_per_unit,scopedQty,row.queue_minutes,row.transfer_minutes]);
  const quantity=expectedResult.rows[0]?.quantity??'0';
  if(inputQty==null||toScaled(inputQty,6,'input_quantity')!==toScaled(quantity,6,'expected routing hours')) throw new BadRequestException('LABOUR quantity must match approved routing time for the target quantity');
  if(!unitCode||!['HOUR','HOURS','HR','HRS'].includes(unitCode.trim().toUpperCase())) throw new BadRequestException('ROUTING labour quantity must use HOUR units');
  return {quantity,unit:'HOUR',snapshot:{source_type:'ROUTING',routing_step_id:row.routing_step_id,product_version_id:row.product_version_id,
   product_code:row.product_code,product_name:row.product_name,step_number:row.step_number,operation_code:row.operation_code,
   operation_name:row.operation_name,work_centre_code:row.work_centre_code,work_centre_name:row.work_centre_name,
   setup_minutes:row.setup_minutes,run_minutes_per_unit:row.run_minutes_per_unit,queue_minutes:row.queue_minutes,
   transfer_minutes:row.transfer_minutes,expected_hours:quantity}};
 }

 private async resolveUtilityQuantity(client:PoolClient,tenantId:string,factoryId:string,readingId:string,targetQty:number,inputQty:number|undefined,unitCode:string|null,unitRate:number|undefined,sourceCurrency:string|null) {
  this.uuid(readingId,'quantity_source_reference');
  const q=await client.query("SELECT r.id::text AS reading_id,r.reading_at::text AS reading_at,r.consumption_quantity::text AS consumption_quantity,r.production_quantity::text AS production_quantity,r.unit_code,r.unit_cost_snapshot::text AS unit_cost_snapshot,r.cost_amount::text AS historical_cost_amount,m.id::text AS meter_id,m.meter_code,m.name AS meter_name,m.utility_type,m.currency_code FROM utility_meter_readings r JOIN utility_meters m ON m.id=r.meter_id AND m.tenant_id=r.tenant_id AND m.factory_id=r.factory_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3",[readingId,tenantId,factoryId]);
  const row=q.rows[0] as Record<string,any>|undefined;
  if(!row) throw new NotFoundException('Energy quantity source meter reading was not found');
  const eq=row.production_quantity&&Number(row.production_quantity)>0
    ? await client.query<{quantity:string}>('SELECT round($1::numeric/$2::numeric*$3::numeric,6)::text AS quantity',[row.consumption_quantity,row.production_quantity,targetQty])
    : {rows:[{quantity:row.consumption_quantity}]};
  const quantity=eq.rows[0]?.quantity??'0';
  if(inputQty==null||toScaled(inputQty,6,'input_quantity')!==toScaled(quantity,6,'expected utility allocation')) throw new BadRequestException('ENERGY quantity must match the referenced reading allocation');
  if(!unitCode||unitCode.trim().toUpperCase()!==String(row.unit_code).trim().toUpperCase()) throw new BadRequestException('ENERGY unit must match meter reading');
  if(unitRate==null||toScaled(unitRate,8,'unit_rate')!==toScaled(row.unit_cost_snapshot,8,'meter unit cost')) throw new BadRequestException('ENERGY rate must match the historical meter rate snapshot');
  if(sourceCurrency&&sourceCurrency!==row.currency_code) throw new BadRequestException('ENERGY currency must match meter currency');
  return {quantity,unit:row.unit_code,rate:row.unit_cost_snapshot,currency:row.currency_code,snapshot:{source_type:'UTILITY_READING',
   reading_id:row.reading_id,reading_at:row.reading_at,meter_id:row.meter_id,meter_code:row.meter_code,meter_name:row.meter_name,
   utility_type:row.utility_type,consumption_quantity:row.consumption_quantity,production_quantity:row.production_quantity,
   allocated_quantity:quantity,unit_code:row.unit_code,unit_cost_snapshot:row.unit_cost_snapshot,
   historical_cost_amount:row.historical_cost_amount,currency:row.currency_code}};
 }


 private async scopedProductQuantity(client:PoolClient,tenantId:string,factoryId:string,scopeType:ScopeType,targetId:string,productCode:string,fallback:number) {
  if(scopeType==='PRODUCT_VERSION') return fallback;
  const result=scopeType==='ORDER'
    ? await client.query<{quantity:string;unit_count:string}>(
      "SELECT COALESCE(SUM(quantity),0)::numeric(20,6)::text AS quantity,COUNT(DISTINCT upper(unit))::text AS unit_count FROM order_lines WHERE order_id=$1 AND tenant_id=$2 AND factory_id=$3 AND lower(product_code)=lower($4)",
      [targetId,tenantId,factoryId,productCode])
    : await client.query<{quantity:string;unit_count:string}>(
      "SELECT COALESCE(SUM(l.quantity),0)::numeric(20,6)::text AS quantity,COUNT(DISTINCT upper(l.unit))::text AS unit_count FROM sales_quotations q JOIN quotation_lines l ON l.quotation_id=q.id AND l.tenant_id=q.tenant_id AND l.factory_id=q.factory_id JOIN quotation_versions v ON v.id=l.quotation_version_id AND v.quotation_id=q.id AND v.tenant_id=q.tenant_id AND v.factory_id=q.factory_id WHERE q.id=$1 AND q.tenant_id=$2 AND q.factory_id=$3 AND v.revision_number=q.current_revision AND lower(l.product_code)=lower($4)",
      [targetId,tenantId,factoryId,productCode]);
  const row=result.rows[0];
  if(!row||Number(row.quantity)<=0) throw new BadRequestException('No positive target quantity exists for quantity-source product '+productCode);
  if(Number(row.unit_count)!==1) throw new BadRequestException('Target order/quotation line quantities for '+productCode+' use inconsistent units');
  return row.quantity;
 }

 private async assertTargetHasProduct(client:PoolClient,tenantId:string,factoryId:string,scopeType:ScopeType,targetId:string,target:TargetSnapshot,productCode:string,versionId:string) {
  if(scopeType==='PRODUCT_VERSION') { if(target.product_version_id!==versionId) throw new BadRequestException('Source must belong to assessed product version'); return; }
  const result=scopeType==='ORDER'
   ? await client.query('SELECT 1 FROM order_lines WHERE order_id=$1 AND tenant_id=$2 AND factory_id=$3 AND lower(product_code)=lower($4) LIMIT 1',[targetId,tenantId,factoryId,productCode])
   : await client.query("SELECT 1 FROM sales_quotations q JOIN quotation_lines l ON l.quotation_id=q.id AND l.tenant_id=q.tenant_id AND l.factory_id=q.factory_id JOIN quotation_versions v ON v.id=l.quotation_version_id AND v.quotation_id=q.id AND v.tenant_id=q.tenant_id AND v.factory_id=q.factory_id WHERE q.id=$1 AND q.tenant_id=$2 AND q.factory_id=$3 AND v.revision_number=q.current_revision AND lower(l.product_code)=lower($4) LIMIT 1",[targetId,tenantId,factoryId,productCode]);
  if(!result.rows[0]) throw new BadRequestException('Quantity-source product does not occur in this order or quotation');
 }

 private async resolveRevenue(client:PoolClient,tenantId:string,factoryId:string,scopeType:ScopeType,targetId:string,costCurrency:string,target:TargetSnapshot) {
  if(scopeType==='PRODUCT_VERSION') return {amount:null as string|null,source_currency:null as string|null,snapshot:null as PlainObject|null};
  let row:{currency:string;revenue:string}|undefined;
  if(scopeType==='ORDER') {
   const q=await client.query("SELECT o.currency,COALESCE(SUM(l.quantity*l.unit_price),0)::numeric(20,4)::text AS revenue FROM orders o LEFT JOIN order_lines l ON l.order_id=o.id AND l.tenant_id=o.tenant_id AND l.factory_id=o.factory_id WHERE o.id=$1 AND o.tenant_id=$2 AND o.factory_id=$3 GROUP BY o.id,o.currency",[targetId,tenantId,factoryId]);
   row=q.rows[0] as {currency:string;revenue:string}|undefined;
  } else row={currency:String(target.source_currency),revenue:String(target.net_revenue)};
  if(!row) throw new NotFoundException('Revenue source was not found');
  const source=this.currency(row.currency);
  if(source===costCurrency) return {amount:row.revenue,source_currency:source,snapshot:{source_currency:source,cost_currency:costCurrency,rate:'1.0000000000',effective_on:await this.today(client),source:'IDENTITY'}};
  const fx=await this.resolveFx(client,tenantId,factoryId,source,costCurrency,await this.today(client));
  const converted=fromScaled((toScaled(row.revenue,4,'revenue')*toScaled(fx.rate,10,'revenue FX rate')+5_000_000_000n)/10_000_000_000n,4);
  return {amount:converted,source_currency:source,snapshot:{source_currency:source,cost_currency:costCurrency,rate:fx.rate,effective_on:fx.effective_on,source:fx.source}};
 }

 private async resolveFx(client:PoolClient,tenantId:string,factoryId:string,source:string,target:string,asOf:string) {
  const result=await client.query("SELECT rate_to_base::text AS rate,effective_on::text AS effective_on,source FROM commercial_exchange_rates WHERE tenant_id=$1 AND factory_id=$2 AND base_currency=$3 AND quote_currency=$4 AND effective_on<=$5::date AND effective_on<=CURRENT_DATE ORDER BY effective_on DESC,created_at DESC,id DESC LIMIT 1",[tenantId,factoryId,source,target,asOf]);
  const row=result.rows[0] as {rate:string;effective_on:string;source:string}|undefined;
  if(!row) throw new BadRequestException('No effective FX rate is recorded from '+source+' to '+target+' for the evidence date');
  return row;
 }
 private async today(client:PoolClient) { const q=await client.query<{today:string}>('SELECT CURRENT_DATE::text AS today');return q.rows[0]?.today??'1970-01-01'; }

 private async loadProfile(client:PoolClient,tenantId:string,factoryId:string,id:string) {
  const q=await client.query("SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,product_id::text AS product_id,profile_code,version,currency,output_unit,status,is_current,row_version::text AS row_version,idempotency_key,request_hash,created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,submitted_by_user_id::text AS submitted_by_user_id,approved_by_user_id::text AS approved_by_user_id,decision_reason,created_at::text AS created_at,updated_at::text AS updated_at,submitted_at::text AS submitted_at,approved_at::text AS approved_at FROM should_cost_profiles WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[id,tenantId,factoryId]);
  const profile=q.rows[0];if(!profile)return null;
  const [components,history]=await Promise.all([
   client.query("SELECT id::text AS id,category,calculation_method,is_required,base_categories,guidance,created_at::text AS created_at FROM should_cost_profile_components WHERE profile_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY array_position(ARRAY['MATERIAL','LABOUR','ENERGY','FREIGHT','DUTY','OVERHEAD','SCRAP']::varchar[],category)",[id,tenantId,factoryId]),
   client.query("SELECT id::text AS id,action,actor_user_id::text AS actor_user_id,reason,request_id::text AS request_id,trace_id::text AS trace_id,details,created_at::text AS created_at FROM should_cost_history WHERE profile_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",[id,tenantId,factoryId]),
  ]);
  return {...profile,components:components.rows,history:history.rows};
 }
 private async lockProfile(client:PoolClient,tenantId:string,factoryId:string,id:string):Promise<ProfileRow|null> {
  const q=await client.query<ProfileRow>("SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,product_id::text AS product_id,profile_code,version,currency,output_unit,status,is_current,row_version::text AS row_version,idempotency_key,request_hash,created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,submitted_by_user_id::text AS submitted_by_user_id,approved_by_user_id::text AS approved_by_user_id,decision_reason,created_at::text AS created_at,updated_at::text AS updated_at,submitted_at::text AS submitted_at,approved_at::text AS approved_at FROM should_cost_profiles WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[id,tenantId,factoryId]);
  return q.rows[0]??null;
 }

 private async loadAssessment(client:PoolClient,tenantId:string,factoryId:string,id:string) {
  const q=await client.query("SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,scope_type,scope_id::text AS scope_id,product_id::text AS product_id,product_version_id::text AS product_version_id,order_id::text AS order_id,quotation_id::text AS quotation_id,quotation_revision_number,profile_id::text AS profile_id,profile_version,profile_code,target_quantity::text AS target_quantity,target_unit,currency,total_cost::text AS total_cost,cost_per_unit::text AS cost_per_unit,component_totals,revenue_source_currency,revenue_amount::text AS revenue_amount,revenue_fx_snapshot,gross_margin_amount::text AS gross_margin_amount,gross_margin_percent::text AS gross_margin_percent,request_snapshot,request_hash,idempotency_key,status,calculated_by_user_id::text AS calculated_by_user_id,created_at::text AS created_at FROM should_cost_assessments WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[id,tenantId,factoryId]);
  const head=q.rows[0];if(!head)return null;
  const [evidence,history]=await Promise.all([
   client.query("SELECT id::text AS id,category,line_number,applicable,calculation_method,input_quantity::text AS input_quantity,unit_code,unit_rate::text AS unit_rate,fixed_amount::text AS fixed_amount,percentage_rate::text AS percentage_rate,source_currency,fx_rate_to_cost_currency::text AS fx_rate_to_cost_currency,fx_rate_effective_on::text AS fx_rate_effective_on,fx_rate_source,source_amount::text AS source_amount,cost_amount::text AS cost_amount,base_categories,base_amount::text AS base_amount,source_type,source_reference,source_as_of::text AS source_as_of,notes,source_snapshot,evidence_hash,created_by_user_id::text AS created_by_user_id,created_at::text AS created_at FROM should_cost_component_evidence WHERE assessment_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY array_position(ARRAY['MATERIAL','LABOUR','ENERGY','FREIGHT','DUTY','OVERHEAD','SCRAP']::varchar[],category),line_number",[id,tenantId,factoryId]),
   client.query("SELECT id::text AS id,action,actor_user_id::text AS actor_user_id,reason,request_id::text AS request_id,trace_id::text AS trace_id,details,created_at::text AS created_at FROM should_cost_history WHERE assessment_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",[id,tenantId,factoryId]),
  ]);
  return {...head,evidence:evidence.rows,history:history.rows};
 }

 private async activeFactory(client:PoolClient,tenantId:string,factoryId:string) {
  const result=await client.query('SELECT 1 FROM factories WHERE id=$1 AND tenant_id=$2 AND status=$3',[factoryId,tenantId,'ACTIVE']);
  if(!result.rows[0]) throw new ForbiddenException('Factory is inactive or not scoped to this tenant');
 }
 private async history(client:PoolClient,tenantId:string,factoryId:string,profileId:string|null,assessmentId:string|null,action:string,userId:string,reason:string,ctx:EventContext,details:PlainObject) {
  await client.query("INSERT INTO should_cost_history(tenant_id,factory_id,profile_id,assessment_id,action,actor_user_id,reason,request_id,trace_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",[tenantId,factoryId,profileId,assessmentId,action,userId,reason,this.uuidOrNull(ctx.requestId),this.uuidOrNull(ctx.traceId),JSON.stringify(details)]);
 }
 private async event(client:PoolClient,tenantId:string,factoryId:string,id:string,eventType:string,payload:PlainObject,userId:string,ctx:EventContext) {
  await client.query("INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,correlation_id,causation_id,actor,source,payload) VALUES($1,$2,'SHOULD_COST',$3,$4,1,clock_timestamp(),$5,NULL,$6::jsonb,$7::jsonb,$8::jsonb)",[tenantId,factoryId,id,eventType,this.uuidOrNull(ctx.traceId)??this.uuidOrNull(ctx.requestId)??randomUUID(),JSON.stringify({type:'user',id:userId}),JSON.stringify({system:'FactoryOS',connector:'should-cost-service',version:process.env.APP_VERSION??'0.0.1'}),JSON.stringify(payload)]);
 }
 private scope(userId:string,tenantId:string,factoryId:string) { this.uuid(userId,'userId');this.uuid(tenantId,'tenantId');this.uuid(factoryId,'factoryId'); }
 private uuid(value:string,field:string) { if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new BadRequestException(field+' must be a valid UUID'); }
 private currency(value:string) { try{return normalizeCostCurrency(value);}catch(error){throw new BadRequestException(error instanceof Error?error.message:'Invalid currency');} }
 private idempotencyKey(value:string|null) { if(value===null||value===undefined)throw new BadRequestException('Idempotency-Key header is required');const k=value.trim();if(!k||k.length>255)throw new BadRequestException('Idempotency-Key must contain 1 to 255 characters');return k; }
 private dateOnly(value:string,field:string) { if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new BadRequestException(field+' must be YYYY-MM-DD');return value; }
 private uuidOrNull(value:string|null|undefined) { return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value:null; }
 private pgCode(error:unknown) { return error&&typeof error==='object'&&'code' in error?String((error as {code?:unknown}).code??''):''; }
 private pgMessage(error:unknown) { return error&&typeof error==='object'&&'message' in error?String((error as {message?:unknown}).message??''):''; }
}
