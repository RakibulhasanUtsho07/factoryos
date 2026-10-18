import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ConvertUomQuantityDto, CreateUomConversionDto, CreateUomUnitDto, ReviewUomConversionDto } from './dto/uom.dto';

type State = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETIRED';
type Rounding = 'REJECT' | 'HALF_UP';
interface KeyRow extends QueryResultRow { id: string; request_hash: string; }
export interface UnitRow extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; unit_code: string; name: string;
  dimension_code: string; decimal_precision: number; created_by_user_id: string; correlation_id: string; created_at: string;
}
export interface RuleRow extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; from_unit_id: string; from_unit_code: string; from_unit_name: string;
  to_unit_id: string; to_unit_code: string; to_unit_name: string; dimension_code: string;
  factor_numerator: string; factor_denominator: string; rounding_mode: Rounding; status: State;
  submitted_by_user_id: string; decided_by_user_id: string | null; decided_at: string | null; decision_reason: string | null;
  retired_by_user_id: string | null; retired_at: string | null; retirement_reason: string | null;
  version: string; created_at: string; updated_at: string;
}
@Injectable()
export class UnitOfMeasureService {
  constructor(private readonly database: DatabaseService) {}

  async createUnit(userId: string, tenantId: string, factoryId: string, dto: CreateUomUnitDto,
    rawKey: string | null, requestId: string | null, traceId: string | null) {
    this.scope(userId, tenantId, factoryId);
    const key = this.key(rawKey), code = this.unitCode(dto.unit_code, 'unit_code');
    const name = this.required(dto.name, 'name', 160), dimension = this.dimension(dto.dimension_code);
    if (!Number.isInteger(dto.decimal_precision) || dto.decimal_precision < 0 || dto.decimal_precision > 8) {
      throw new BadRequestException('decimal_precision must be between 0 and 8');
    }
    const hash = this.hash({ code, name, dimension, precision: dto.decimal_precision });
    const req = this.uuidOrNull(requestId), trace = this.uuidOrNull(traceId), corr = trace ?? req ?? randomUUID();
    try {
      const result = await this.database.transaction({ tenantId, userId, requestId: req, traceId: trace }, async client => {
        await this.lock(client, tenantId, factoryId, 'unit:' + key);
        const old = await client.query<KeyRow>(`SELECT id::text AS id, request_hash FROM uom_units
          WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`, [tenantId, factoryId, key]);
        if (old.rows[0]) {
          if (old.rows[0].request_hash.trim() !== hash) throw new ConflictException('Idempotency-Key reused for a different unit request');
          return { id: old.rows[0].id, replayed: true };
        }
        const ins = await client.query<KeyRow>(`INSERT INTO uom_units
          (tenant_id,factory_id,unit_code,name,dimension_code,decimal_precision,idempotency_key,request_hash,created_by_user_id,correlation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text AS id,request_hash`,
          [tenantId,factoryId,code,name,dimension,dto.decimal_precision,key,hash,userId,corr]);
        const row = ins.rows[0]; if (!row) throw new Error('UOM_UNIT_INSERT_FAILED');
        await this.audit(client, tenantId, factoryId, userId, 'UOM_UNIT', row.id, 'CREATED', corr, req,
          { unit_code: code, name, dimension_code: dimension, decimal_precision: dto.decimal_precision });
        await this.outbox(client, tenantId, factoryId, 'UOM_UNIT', row.id, 'UOM.UNIT_CREATED', corr, userId,
          { unit_id: row.id, unit_code: code, name, dimension_code: dimension, decimal_precision: dto.decimal_precision });
        return { id: row.id, replayed: false };
      });
      return { ...(await this.getUnit(userId, tenantId, factoryId, result.id)), replayed: result.replayed };
    } catch (e) { throw this.mapError(e, 'UoM unit code or idempotency key already exists'); }
  }

  async listUnits(userId: string, tenantId: string, factoryId: string,
    options: { search?: string; dimensionCode?: string; limit?: number }) {
    this.scope(userId, tenantId, factoryId); const limit = this.limit(options.limit);
    const search = options.search?.trim() || null;
    const dim = options.dimensionCode ? this.dimension(options.dimensionCode) : null;
    const result = await this.database.query<UnitRow>(`SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,
      unit_code,name,dimension_code,decimal_precision,created_by_user_id::text AS created_by_user_id,
      correlation_id::text AS correlation_id,created_at::text AS created_at
      FROM uom_units WHERE tenant_id=$1 AND factory_id=$2
      AND ($3::text IS NULL OR unit_code ILIKE '%'||$3||'%' OR name ILIKE '%'||$3||'%')
      AND ($4::text IS NULL OR dimension_code=$4) ORDER BY dimension_code,unit_code LIMIT $5`,
      [tenantId,factoryId,search,dim,limit], { tenantId,userId });
    return { units: result.rows, limit };
  }

  async getUnit(userId: string, tenantId: string, factoryId: string, id: string) {
    this.scope(userId, tenantId, factoryId); this.uuid(id, 'unitId');
    const result = await this.database.query<UnitRow>(`SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,
      unit_code,name,dimension_code,decimal_precision,created_by_user_id::text AS created_by_user_id,
      correlation_id::text AS correlation_id,created_at::text AS created_at FROM uom_units
      WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 LIMIT 1`, [id,tenantId,factoryId], {tenantId,userId});
    if (!result.rows[0]) throw new NotFoundException('UoM unit not found in this factory');
    return result.rows[0];
  }

  async createConversion(userId: string, tenantId: string, factoryId: string, dto: CreateUomConversionDto,
    rawKey: string | null, requestId: string | null, traceId: string | null) {
    this.scope(userId, tenantId, factoryId);
    const key = this.key(rawKey), fromCode = this.unitCode(dto.from_unit_code, 'from_unit_code');
    const toCode = this.unitCode(dto.to_unit_code, 'to_unit_code');
    if (fromCode === toCode) throw new BadRequestException('Conversion source and target units must differ');
    const factor = this.factor(dto.factor_numerator, dto.factor_denominator);
    const rounding: Rounding = dto.rounding_mode ?? 'REJECT';
    const reason = this.required(dto.reason, 'reason', 2000);
    const hash = this.hash({ fromCode,toCode,numerator:factor.numerator,denominator:factor.denominator,rounding,reason });
    const req = this.uuidOrNull(requestId), trace = this.uuidOrNull(traceId), corr = trace ?? req ?? randomUUID();
    try {
      const result = await this.database.transaction({tenantId,userId,requestId:req,traceId:trace}, async client => {
        await this.lock(client,tenantId,factoryId,'conversion:'+key);
        const old = await client.query<KeyRow>(`SELECT id::text AS id,request_hash FROM uom_conversion_rules
          WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,[tenantId,factoryId,key]);
        if (old.rows[0]) {
          if (old.rows[0].request_hash.trim() !== hash) throw new ConflictException('Idempotency-Key reused for a different conversion request');
          return {id:old.rows[0].id,replayed:true};
        }
        const units = await client.query<{id:string;unit_code:string;dimension_code:string}>(`SELECT id::text AS id,unit_code,dimension_code
          FROM uom_units WHERE tenant_id=$1 AND factory_id=$2 AND unit_code=ANY($3::text[]) ORDER BY unit_code FOR SHARE`,
          [tenantId,factoryId,[fromCode,toCode]]);
        const from = units.rows.find(r=>r.unit_code===fromCode), to = units.rows.find(r=>r.unit_code===toCode);
        if (!from || !to) throw new NotFoundException('Both UoM units must exist in this factory');
        if (from.dimension_code !== to.dimension_code) throw new BadRequestException('Units from different dimensions cannot be converted');
        const ins = await client.query<KeyRow>(`INSERT INTO uom_conversion_rules
          (tenant_id,factory_id,from_unit_id,to_unit_id,factor_numerator,factor_denominator,rounding_mode,status,
           submitted_by_user_id,idempotency_key,request_hash,correlation_id)
          VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,'PENDING_APPROVAL',$8,$9,$10,$11)
          RETURNING id::text AS id,request_hash`,
          [tenantId,factoryId,from.id,to.id,factor.numerator,factor.denominator,rounding,userId,key,hash,corr]);
        if (!ins.rows[0]) throw new Error('UOM_CONVERSION_INSERT_FAILED');
        await this.conversionEvent(client,{tenantId,factoryId,ruleId:ins.rows[0].id,eventType:'SUBMITTED',
          fromStatus:null,toStatus:'PENDING_APPROVAL',reason,key,hash,userId,corr,req,outboxType:'UOM.CONVERSION_SUBMITTED',
          payload:{conversion_rule_id:ins.rows[0].id,from_unit_code:fromCode,to_unit_code:toCode,
            factor_numerator:factor.numerator,factor_denominator:factor.denominator,rounding_mode:rounding,status:'PENDING_APPROVAL'}});
        return {id:ins.rows[0].id,replayed:false};
      });
      return { ...(await this.getConversion(userId,tenantId,factoryId,result.id)), replayed:result.replayed };
    } catch (e) { throw this.mapError(e,'Conversion conflicts with an active unit pair or idempotency key'); }
  }

  async listConversions(userId: string, tenantId: string, factoryId: string,
    options: {status?:string;dimensionCode?:string;limit?:number}) {
    this.scope(userId,tenantId,factoryId); const limit = this.limit(options.limit);
    const status = options.status?.trim().toUpperCase() || null;
    if (status && !['PENDING_APPROVAL','APPROVED','REJECTED','RETIRED'].includes(status)) throw new BadRequestException('Unsupported conversion status');
    const dimension = options.dimensionCode ? this.dimension(options.dimensionCode) : null;
    const result = await this.database.query(this.ruleSelect(`WHERE r.tenant_id=$1 AND r.factory_id=$2
      AND ($3::text IS NULL OR r.status=$3) AND ($4::text IS NULL OR fu.dimension_code=$4)
      ORDER BY r.created_at DESC,r.id DESC LIMIT $5`),[tenantId,factoryId,status,dimension,limit],{tenantId,userId});
    return {conversions:result.rows,limit};
  }

  async getConversion(userId: string, tenantId: string, factoryId: string, id: string) {
    this.scope(userId,tenantId,factoryId); this.uuid(id,'ruleId');
    const result = await this.database.query<RuleRow>(this.ruleSelect(`WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 LIMIT 1`),
      [id,tenantId,factoryId],{tenantId,userId});
    if (!result.rows[0]) throw new NotFoundException('UoM conversion rule not found in this factory');
    return result.rows[0];
  }

  async reviewConversion(userId: string, tenantId: string, factoryId: string, ruleId: string, dto: ReviewUomConversionDto,
    rawKey: string | null, requestId: string | null, traceId: string | null) {
    this.scope(userId,tenantId,factoryId); this.uuid(ruleId,'ruleId');
    const key=this.key(rawKey), action=dto.action?.trim().toUpperCase();
    if (!['APPROVE','REJECT','RETIRE'].includes(action)) throw new BadRequestException('action must be APPROVE, REJECT or RETIRE');
    const reason=this.required(dto.reason,'reason',2000), hash=this.hash({ruleId:ruleId.toLowerCase(),action,reason});
    const req=this.uuidOrNull(requestId), trace=this.uuidOrNull(traceId), corr=trace??req??randomUUID();
    try {
      const result=await this.database.transaction({tenantId,userId,requestId:req,traceId:trace},async client=>{
        await this.lock(client,tenantId,factoryId,'review:'+key);
        const old=await client.query<KeyRow & {conversion_rule_id:string}>(`SELECT id::text AS id,request_hash,
          conversion_rule_id::text AS conversion_rule_id FROM uom_conversion_events
          WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,[tenantId,factoryId,key]);
        if(old.rows[0]) {
          if(old.rows[0].request_hash.trim()!==hash || old.rows[0].conversion_rule_id!==ruleId.toLowerCase())
            throw new ConflictException('Idempotency-Key reused for a different conversion review');
          return {id:old.rows[0].conversion_rule_id,replayed:true};
        }
        const curRes=await client.query<RuleRow>(this.ruleSelect(`WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 FOR UPDATE OF r`),
          [ruleId,tenantId,factoryId]);
        const current=curRes.rows[0]; if(!current) throw new NotFoundException('UoM conversion rule not found');
        let next:State, eventType:'APPROVED'|'REJECTED'|'RETIRED';
        if(action==='APPROVE'||action==='REJECT') {
          if(current.status!=='PENDING_APPROVAL') throw new ConflictException('Only pending conversions can be approved or rejected');
          if(current.submitted_by_user_id===userId) throw new ConflictException('Submitter cannot approve or reject their own conversion');
          next=action==='APPROVE'?'APPROVED':'REJECTED'; eventType=action==='APPROVE'?'APPROVED':'REJECTED';
          await client.query(`UPDATE uom_conversion_rules SET status=$1,decided_by_user_id=$2,decided_at=clock_timestamp(),
            decision_reason=$3,version=version+1,updated_at=clock_timestamp()
            WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND status='PENDING_APPROVAL'`,
            [next,userId,reason,ruleId,tenantId,factoryId]);
        } else {
          if(current.status!=='APPROVED') throw new ConflictException('Only approved conversions can be retired');
          next='RETIRED'; eventType='RETIRED';
          await client.query(`UPDATE uom_conversion_rules SET status='RETIRED',retired_by_user_id=$1,retired_at=clock_timestamp(),
            retirement_reason=$2,version=version+1,updated_at=clock_timestamp()
            WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND status='APPROVED'`,
            [userId,reason,ruleId,tenantId,factoryId]);
        }
        const outboxType=next==='APPROVED'?'UOM.CONVERSION_APPROVED':next==='REJECTED'?'UOM.CONVERSION_REJECTED':'UOM.CONVERSION_RETIRED';
        await this.conversionEvent(client,{tenantId,factoryId,ruleId,eventType,fromStatus:current.status,toStatus:next,reason,
          key,hash,userId,corr,req,outboxType,payload:{conversion_rule_id:ruleId,from_unit_code:current.from_unit_code,
            to_unit_code:current.to_unit_code,status:next,rounding_mode:current.rounding_mode,version:Number(current.version)+1}});
        return {id:ruleId,replayed:false};
      });
      return {...(await this.getConversion(userId,tenantId,factoryId,result.id)),replayed:result.replayed};
    } catch(e) { throw this.mapError(e,'Conversion review conflicts with lifecycle or idempotency rules'); }
  }

  async convert(userId:string,tenantId:string,factoryId:string,dto:ConvertUomQuantityDto) {
    this.scope(userId,tenantId,factoryId);
    const qty=this.quantity(dto.quantity), from=this.unitCode(dto.from_unit_code,'from_unit_code'), to=this.unitCode(dto.to_unit_code,'to_unit_code');
    const value=await this.database.transaction({tenantId,userId},client=>this.convertWithClient(client,tenantId,factoryId,from,to,qty,null));
    return {input_quantity:qty,input_unit_code:from,converted_quantity:value.quantity,converted_unit_code:to,
      dimension_code:value.dimension,source_precision:value.sourcePrecision,target_precision:value.targetPrecision,
      rounding_mode:value.rounding,conversion_rule_id:value.ruleId,factor_numerator:value.numerator,factor_denominator:value.denominator};
  }

  async convertForStockMovement(client:PoolClient,tenantId:string,factoryId:string,fromRaw:string,toRaw:string,quantityRaw:string) {
    const qty=this.quantity(quantityRaw);
    const value=await this.convertWithClient(client,tenantId,factoryId,this.unitCode(fromRaw,'input_unit_code'),
      this.unitCode(toRaw,'base_unit_code'),qty,4);
    return {inputQuantity:qty,quantity:this.fixed(value.quantity,4),conversionRuleId:value.ruleId,
      factorNumerator:value.ruleId?value.numerator:null,factorDenominator:value.ruleId?value.denominator:null,
      roundingMode:value.ruleId?value.rounding:null};
  }

  private async convertWithClient(client:PoolClient,tenantId:string,factoryId:string,fromCode:string,toCode:string,qty:string,stockPrecision:number|null) {
    const u=await client.query<{id:string;unit_code:string;dimension_code:string;decimal_precision:number}>(`
      SELECT id::text AS id,unit_code,dimension_code,decimal_precision FROM uom_units
      WHERE tenant_id=$1 AND factory_id=$2 AND unit_code=ANY($3::text[]) ORDER BY unit_code FOR SHARE`,
      [tenantId,factoryId,[...new Set([fromCode,toCode])]]);
    const from=u.rows.find(x=>x.unit_code===fromCode),to=u.rows.find(x=>x.unit_code===toCode);
    if(fromCode===toCode&&stockPrecision!==null&&(!from||!to)) {
      this.assertPrecision(qty,4);
      return {quantity:this.fixed(qty,4),dimension:'LEGACY',sourcePrecision:4,targetPrecision:4,rounding:'REJECT' as Rounding,
        ruleId:null as string|null,numerator:'1',denominator:'1'};
    }
    if(!from||!to) throw new NotFoundException('Both UoM codes must be registered in this factory');
    if(from.dimension_code!==to.dimension_code) throw new BadRequestException('Units from different dimensions cannot be converted');
    this.assertPrecision(qty,from.decimal_precision);
    const precision=stockPrecision===null?to.decimal_precision:Math.min(stockPrecision,to.decimal_precision);
    let numerator='1',denominator='1',ruleId:string|null=null,rounding:Rounding='REJECT';
    if(fromCode!==toCode) {
      const q=await client.query<{id:string;from_unit_id:string;factor_numerator:string;factor_denominator:string;rounding_mode:Rounding}>(`
        SELECT r.id::text AS id,r.from_unit_id::text AS from_unit_id,r.factor_numerator::text AS factor_numerator,
          r.factor_denominator::text AS factor_denominator,r.rounding_mode FROM uom_conversion_rules r
        WHERE r.tenant_id=$1 AND r.factory_id=$2 AND r.status='APPROVED'
          AND ((r.from_unit_id=$3 AND r.to_unit_id=$4) OR (r.from_unit_id=$4 AND r.to_unit_id=$3))
        LIMIT 1 FOR SHARE`,[tenantId,factoryId,from.id,to.id]);
      const r=q.rows[0]; if(!r) throw new ConflictException('No approved UoM conversion exists for this unit pair');
      ruleId=r.id; rounding=r.rounding_mode;
      if(r.from_unit_id===from.id){numerator=r.factor_numerator;denominator=r.factor_denominator;}
      else {numerator=r.factor_denominator;denominator=r.factor_numerator;}
    }
    let calc:{exact_quantity:string;rounded_quantity:string;exact_at_precision:boolean};
    try {
      const q=await client.query<{exact_quantity:string;rounded_quantity:string;exact_at_precision:boolean}>(`
        WITH value AS (SELECT $1::numeric*$2::numeric/$3::numeric AS exact_quantity)
        SELECT exact_quantity::text AS exact_quantity,
          CASE WHEN $5::boolean THEN round(exact_quantity,$4::int)::numeric(18,4)::text
            ELSE round(exact_quantity,$4::int)::numeric(38,8)::text END AS rounded_quantity,
          exact_quantity=trunc(exact_quantity,$4::int) AS exact_at_precision FROM value`,
        [qty,numerator,denominator,precision,stockPrecision!==null]);
      if(!q.rows[0]) throw new Error('UOM_CONVERSION_CALCULATION_FAILED'); calc=q.rows[0];
    } catch(e) {
      const code=this.errorCode(e); if(code==='22003'||code==='22012') throw new BadRequestException('Converted quantity exceeds the supported numeric range');
      throw e;
    }
    if(Number(calc.rounded_quantity)<=0) throw new BadRequestException('Converted quantity rounds to zero at target precision');
    if(rounding==='REJECT'&&!calc.exact_at_precision) throw new BadRequestException('Converted quantity is not exactly representable at target precision');
    return {quantity:this.fixed(calc.rounded_quantity,precision),dimension:from.dimension_code,sourcePrecision:from.decimal_precision,
      targetPrecision:precision,rounding,ruleId,numerator,denominator};
  }

  private ruleSelect(where:string) {
    return `SELECT r.id::text AS id,r.tenant_id::text AS tenant_id,r.factory_id::text AS factory_id,
      r.from_unit_id::text AS from_unit_id,fu.unit_code AS from_unit_code,fu.name AS from_unit_name,
      r.to_unit_id::text AS to_unit_id,tu.unit_code AS to_unit_code,tu.name AS to_unit_name,fu.dimension_code,
      r.factor_numerator::text AS factor_numerator,r.factor_denominator::text AS factor_denominator,r.rounding_mode,r.status,
      r.submitted_by_user_id::text AS submitted_by_user_id,r.decided_by_user_id::text AS decided_by_user_id,
      r.decided_at::text AS decided_at,r.decision_reason,r.retired_by_user_id::text AS retired_by_user_id,
      r.retired_at::text AS retired_at,r.retirement_reason,r.version::text AS version,
      r.created_at::text AS created_at,r.updated_at::text AS updated_at
      FROM uom_conversion_rules r
      JOIN uom_units fu ON fu.id=r.from_unit_id AND fu.tenant_id=r.tenant_id AND fu.factory_id=r.factory_id
      JOIN uom_units tu ON tu.id=r.to_unit_id AND tu.tenant_id=r.tenant_id AND tu.factory_id=r.factory_id ${where}`;
  }

  private async conversionEvent(client:PoolClient,x:{tenantId:string;factoryId:string;ruleId:string;eventType:'SUBMITTED'|'APPROVED'|'REJECTED'|'RETIRED';
    fromStatus:string|null;toStatus:string;reason:string;key:string;hash:string;userId:string;corr:string;req:string|null;
    outboxType:string;payload:Record<string,unknown>}) {
    await client.query(`INSERT INTO uom_conversion_events(tenant_id,factory_id,conversion_rule_id,event_type,from_status,to_status,
      reason,idempotency_key,request_hash,changed_by_user_id,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [x.tenantId,x.factoryId,x.ruleId,x.eventType,x.fromStatus,x.toStatus,x.reason,x.key,x.hash,x.userId,x.corr]);
    await this.audit(client,x.tenantId,x.factoryId,x.userId,'UOM_CONVERSION',x.ruleId,x.eventType,x.corr,x.req,x.payload);
    await this.outbox(client,x.tenantId,x.factoryId,'UOM_CONVERSION',x.ruleId,x.outboxType,x.corr,x.userId,x.payload);
  }
  private async audit(client:PoolClient,tenantId:string,factoryId:string,userId:string,resourceType:string,resourceId:string,
    action:string,correlation:string,requestId:string|null,payload:Record<string,unknown>) {
    await client.query(`INSERT INTO audit_events(tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,
      correlation_id,request_id,data_class,payload) VALUES($1,$2,$3,'UOM',$4,$5,$6,$7,$8,'INTERNAL',$9::jsonb)`,
      [tenantId,factoryId,userId,action,resourceType,resourceId,correlation,requestId,JSON.stringify(payload)]);
  }
  private async outbox(client:PoolClient,tenantId:string,factoryId:string,aggregateType:string,aggregateId:string,eventType:string,
    correlation:string,userId:string,payload:Record<string,unknown>) {
    await client.query(`INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,
      correlation_id,causation_id,actor,source,payload) VALUES($1,$2,$3,$4,$5,1,clock_timestamp(),$6::uuid,NULL,$7::jsonb,$8::jsonb,$9::jsonb)`,
      [tenantId,factoryId,aggregateType,aggregateId,eventType,correlation,JSON.stringify({type:'user',id:userId}),
      JSON.stringify({system:'FactoryOS',connector:'uom-service',version:process.env.APP_VERSION??'0.1.0'}),JSON.stringify(payload)]);
  }
  private async lock(client:PoolClient,tenantId:string,factoryId:string,key:string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[tenantId+':'+factoryId+':uom:'+key]);
  }
  private scope(user:string,tenant:string,factory:string){this.uuid(user,'userId');this.uuid(tenant,'tenantId');this.uuid(factory,'factoryId');}
  private uuid(value:string,field:string){if(!isUUID(value))throw new BadRequestException(field+' must be a UUID');}
  private key(raw:string|null){const v=raw?.trim()??'';if(!v||v.length>255)throw new BadRequestException('Idempotency-Key is required and must be at most 255 characters');return v;}
  private required(v:string|undefined,field:string,max:number){const s=v?.trim()??'';if(!s||s.length>max)throw new BadRequestException(field+' is required and must be at most '+max+' characters');return s;}
  private unitCode(raw:string,field:string){const s=raw?.trim().toUpperCase()??'';if(!/^[A-Z0-9][A-Z0-9._-]{0,49}$/.test(s))throw new BadRequestException(field+' is an invalid unit code');return s;}
  private dimension(raw:string){const s=raw?.trim().toUpperCase()??'';if(!/^[A-Z][A-Z0-9_]{0,49}$/.test(s))throw new BadRequestException('dimension_code is invalid');return s;}
  private quantity(raw:string){const s=raw?.trim()??'';if(!/^[0-9]+(?:\.[0-9]{1,8})?$/.test(s)||!Number.isFinite(Number(s))||Number(s)<=0)throw new BadRequestException('quantity must be a positive decimal with at most 8 fractional digits');const [i,f='']=s.split('.');const ni=i.replace(/^0+(?=\d)/,'');const nf=f.replace(/0+$/,'');return nf?ni+'.'+nf:ni;}
  private assertPrecision(q:string,p:number){if((q.split('.')[1]??'').length>p)throw new BadRequestException('quantity exceeds source-unit precision of '+p+' decimal places');}
  private fixed(raw:string,p:number){const q=this.quantity(raw);if(p===0){if(q.includes('.'))throw new BadRequestException('Converted quantity exceeds target precision');return q;}const [i,f='']=q.split('.');if(f.length>p)throw new BadRequestException('Converted quantity exceeds target precision');return i+'.'+f.padEnd(p,'0');}
  private factor(numRaw:string,denRaw:string){const parse=(s:string,f:string)=>{const v=s?.trim()??'';if(!/^[1-9][0-9]{0,23}$/.test(v))throw new BadRequestException(f+' must be a positive integer of at most 24 digits');return BigInt(v);};let n=parse(numRaw,'factor_numerator'),d=parse(denRaw,'factor_denominator');let a=n,b=d;while(b!==0n)[a,b]=[b,a%b];n/=a;d/=a;return{numerator:n.toString(),denominator:d.toString()};}
  private hash(v:unknown){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
  private uuidOrNull(v:string|null|undefined){return v&&isUUID(v)?v:null;}
  private limit(v?:number){const n=v??100;if(!Number.isInteger(n)||n<1||n>100)throw new BadRequestException('limit must be between 1 and 100');return n;}
  private errorCode(e:unknown){if(typeof e!=='object'||e===null||!('code'in e))return null;const c=(e as {code?:unknown}).code;return typeof c==='string'?c:null;}
  private mapError(e:unknown,fallback:string){const c=this.errorCode(e);if(c==='23505')return new ConflictException(fallback);if(c==='23503')return new BadRequestException('UoM references must exist in the same tenant and factory');if(c==='23514'||c==='55000')return new ConflictException(e instanceof Error?e.message:fallback);if(c==='22003'||c==='22012')return new BadRequestException('UoM quantity or factor exceeds numeric limits');return e;}
}
