import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { UtilitiesService } from './utilities.service';
import type { UtilityContext } from './utilities.service';
import type {
  CreateUtilitySourceBindingDto, CreateUtilityThresholdPolicyDto, IngestUtilitySourceEventDto,
  TransitionUtilitySourceBindingDto, TransitionUtilityThresholdPolicyDto,
} from './utilities-closure.dto';
import type { RecordUtilityReadingDto } from './utilities.dto';

type Row = QueryResultRow;

@Injectable()
export class UtilitiesClosureService {
  constructor(private readonly database: DatabaseService, private readonly utilities: UtilitiesService) {}

  async createSourceBinding(c: UtilityContext, dto: CreateUtilitySourceBindingDto, rawKey: string | null) {
    this.scope(c);
    const key = this.key(rawKey);
    const payload = {
      source_system_code: this.code(dto.source_system_code, 'source_system_code', 100),
      source_meter_code: this.text(dto.source_meter_code, 'source_meter_code', 160),
      vendor_adapter: dto.vendor_adapter,
      meter_id: this.uuid(dto.meter_id, 'meter_id'),
      source_unit_code: this.text(dto.source_unit_code, 'source_unit_code', 24),
      factor_to_meter_unit: this.decimal(dto.factor_to_meter_unit, 'factor_to_meter_unit', 8, true),
      polling_interval_seconds: dto.polling_interval_seconds ?? null,
      credential_reference: this.optionalText(dto.credential_reference, 255),
      config_metadata: this.object(dto.config_metadata),
    };
    if (Buffer.byteLength(JSON.stringify(payload.config_metadata), 'utf8') > 8192) {
      throw new BadRequestException('config_metadata must be at most 8 KiB');
    }
    if (this.containsSensitiveKey(payload.config_metadata)) {
      throw new BadRequestException('config_metadata cannot store credentials, tokens, passwords or private keys; use credential_reference');
    }
    if (payload.credential_reference &&
      !/^(?:secrets?|vault|kms):\/\/[^\s]+$|^arn:aws:secretsmanager:[^\s]+$/i.test(payload.credential_reference)) {
      throw new BadRequestException('credential_reference must be a non-secret secret-manager reference, not a credential value');
    }
    const hash = this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`utility-source-binding:${c.tenantId}:${c.factoryId}:${key}`}, async client => {
      const existing = await client.query<Row>(
        'SELECT id::text AS id,request_hash FROM utility_meter_source_bindings WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key]);
      if (existing.rows[0]) {
        this.same(existing.rows[0].request_hash, hash);
        return {...(await this.sourceBindingDetail(client,c,String(existing.rows[0].id))), replayed:true};
      }
      const meter = await client.query<Row>(
        'SELECT id::text AS id,unit_code,status FROM utility_meters WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
        [payload.meter_id,c.tenantId,c.factoryId]);
      if (!meter.rows[0]) throw new NotFoundException('Utility meter was not found in this factory');
      if (String(meter.rows[0].status) !== 'ACTIVE') throw new ConflictException('A vendor source can only bind to an active meter');
      const id = await this.insertSourceBinding(client,c,payload,key,hash);
      return {...(await this.sourceBindingDetail(client,c,id)),replayed:false};
    });
  }

  async listSourceBindings(c: UtilityContext, limitRaw?: number) {
    this.scope(c);
    const limit = this.limit(limitRaw,100);
    const r = await this.database.query<Row>(
      `SELECT b.id::text AS id,b.source_system_code,b.source_meter_code,b.vendor_adapter,b.meter_id::text AS meter_id,
        m.meter_code,m.unit_code AS meter_unit_code,b.source_unit_code,b.factor_to_meter_unit::text AS factor_to_meter_unit,
        b.polling_interval_seconds,(b.credential_reference IS NOT NULL) AS credential_configured,b.config_metadata,b.status,b.row_version::int AS row_version,b.last_change_reason,
        b.created_by_user_id::text AS created_by_user_id,b.approved_by_user_id::text AS approved_by_user_id,
        b.approved_at::text AS approved_at,b.created_at::text AS created_at,b.updated_at::text AS updated_at
       FROM utility_meter_source_bindings b JOIN utility_meters m
        ON m.id=b.meter_id AND m.tenant_id=b.tenant_id AND m.factory_id=b.factory_id
       WHERE b.tenant_id=$1 AND b.factory_id=$2 ORDER BY b.created_at DESC,b.id LIMIT $3`,
      [c.tenantId,c.factoryId,limit],{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async transitionSourceBinding(c: UtilityContext, id: string, dto: TransitionUtilitySourceBindingDto) {
    this.scope(c); this.uuid(id,'bindingId');
    const reason = this.text(dto.reason,'reason',2000);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const q=await client.query<Row>(
        'SELECT status,row_version::int AS row_version,created_by_user_id::text AS created_by_user_id FROM utility_meter_source_bindings WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [id,c.tenantId,c.factoryId]);
      const row=q.rows[0]; if(!row)throw new NotFoundException('Meter source binding was not found in this factory');
      if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Meter source binding version is stale');
      const from=String(row.status);
      const next=dto.action==='ACTIVATE'?'ACTIVE':dto.action==='DEACTIVATE'?'INACTIVE':'RETIRED';
      const allowed:Record<string,string[]>={DRAFT:['ACTIVE','RETIRED'],ACTIVE:['INACTIVE','RETIRED'],INACTIVE:['ACTIVE','RETIRED']};
      if(!(allowed[from]??[]).includes(next))throw new ConflictException(`Invalid source binding transition ${from} -> ${next}`);
      if(dto.action==='ACTIVATE'&&String(row.created_by_user_id)===c.userId) {
        throw new ConflictException('Source binding activation requires a different approver than its creator');
      }
      await client.query(
        `UPDATE utility_meter_source_bindings SET status=$4,row_version=row_version+1,
          approved_by_user_id=CASE WHEN $4='ACTIVE' THEN $5::uuid ELSE NULL END,
          approved_at=CASE WHEN $4='ACTIVE' THEN clock_timestamp() ELSE NULL END,
          last_change_reason=$5,updated_by_user_id=$6,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$7`,
        [id,c.tenantId,c.factoryId,next,reason,c.userId,dto.expected_version]);
      return this.sourceBindingDetail(client,c,id);
    });
  }

  async ingestSourceEvent(c: UtilityContext, dto: IngestUtilitySourceEventDto) {
    this.scope(c);
    const sourceSystem=this.code(dto.source_system_code,'source_system_code',100);
    const sourceMeter=this.text(dto.source_meter_code,'source_meter_code',160);
    const eventId=this.text(dto.source_event_id,'source_event_id',160);
    const sourceUnit=this.text(dto.source_unit_code,'source_unit_code',24);
    const readingAt=this.instant(dto.reading_at,'reading_at');
    const sourceValue=this.decimal(dto.reading_value,'reading_value',8,false);
    const production=dto.production_quantity===undefined?undefined:this.decimal(dto.production_quantity,'production_quantity',8,true);
    const bindingResult=await this.database.query<Row>(
      `SELECT b.id::text AS id,b.meter_id::text AS meter_id,b.source_unit_code,b.factor_to_meter_unit::text AS factor_to_meter_unit,
        m.status AS meter_status,m.unit_code,m.reading_mode
       FROM utility_meter_source_bindings b JOIN utility_meters m
        ON m.id=b.meter_id AND m.tenant_id=b.tenant_id AND m.factory_id=b.factory_id
       WHERE b.tenant_id=$1 AND b.factory_id=$2 AND b.source_system_code=$3 AND b.source_meter_code=$4 AND b.status='ACTIVE'`,
      [c.tenantId,c.factoryId,sourceSystem,sourceMeter],{tenantId:c.tenantId,userId:c.userId});
    const binding=bindingResult.rows[0];
    if(!binding)throw new NotFoundException('No approved active meter-source mapping matches this source event');
    if(binding.meter_status!=='ACTIVE')throw new ConflictException('The mapped meter is not active');
    if(String(binding.source_unit_code)!==sourceUnit)throw new ConflictException('Source event unit does not match the approved meter-source mapping');
    const normalizedValue=Number((sourceValue*Number(binding.factor_to_meter_unit)).toFixed(8));
    if(!Number.isFinite(normalizedValue))throw new BadRequestException('Normalized source reading is outside the supported numeric range');
    const eventKey=`${sourceSystem}:${eventId}`;
    if(eventKey.length>187)throw new BadRequestException('source_system_code and source_event_id are too long for a stable idempotency key');
    const dtoForReading:RecordUtilityReadingDto={
      reading_at:readingAt,reading_value:normalizedValue,source_type:'METER_GATEWAY',source_event_id:eventKey,
      production_quantity:production,
      notes:[this.optionalText(dto.notes,600),`Normalized from ${sourceSystem}/${sourceMeter}; unit ${sourceUnit} x ${String(binding.factor_to_meter_unit)} -> ${String(binding.unit_code)}`]
        .filter(Boolean).join(' | ').slice(0,2000),
    };
    const idempotencyKey=`vendor-event:${eventKey}`;
    const result=await this.utilities.recordReading(c,String(binding.meter_id),dtoForReading,idempotencyKey).catch(async error=>{
      // A mismatched replay must remain a conflict; do not convert a duplicate-key failure into success.
      throw error;
    });
    return {...result,normalization:{source_system_code:sourceSystem,source_meter_code:sourceMeter,source_event_id:eventId,
      source_unit_code:sourceUnit,meter_unit_code:String(binding.unit_code),conversion_factor:String(binding.factor_to_meter_unit),
      normalized_reading_value:normalizedValue,vendor_adapter_status:'INGESTION_CONTRACT_ONLY'}};
  }

  async createThresholdPolicy(c: UtilityContext, dto: CreateUtilityThresholdPolicyDto, rawKey: string | null) {
    this.scope(c);const key=this.key(rawKey);
    const payload={
      policy_code:this.code(dto.policy_code,'policy_code',100),name:this.text(dto.name,'name',255),
      meter_id:dto.meter_id?this.uuid(dto.meter_id,'meter_id'):null,utility_type:dto.utility_type??null,
      metric:dto.metric,comparison:dto.comparison,threshold_value:this.decimal(dto.threshold_value,'threshold_value',8,false),
      threshold_unit_code:this.text(dto.threshold_unit_code,'threshold_unit_code',24),severity:dto.severity,
    };
    if(!payload.meter_id&&!payload.utility_type)throw new BadRequestException('A threshold policy must select a meter or utility_type');
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`utility-threshold-policy:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const existing=await client.query<Row>('SELECT id::text AS id,request_hash FROM utility_threshold_policies WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(existing.rows[0]){this.same(existing.rows[0].request_hash,hash);return {...(await this.policyDetail(client,c,String(existing.rows[0].id))),replayed:true};}
      if(payload.meter_id){
        const meter=await client.query<Row>('SELECT status,unit_code,currency_code,utility_type FROM utility_meters WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',[payload.meter_id,c.tenantId,c.factoryId]);
        if(!meter.rows[0])throw new NotFoundException('Utility meter was not found in this factory');
        if(meter.rows[0].status!=='ACTIVE')throw new ConflictException('Threshold policy requires an active meter');
        const expectedUnit=payload.metric==='COST'?String(meter.rows[0].currency_code):payload.metric==='INTENSITY'?`${String(meter.rows[0].unit_code)}/unit`:String(meter.rows[0].unit_code);
        if(payload.threshold_unit_code!==expectedUnit)throw new BadRequestException(`Metric ${payload.metric} must use unit ${expectedUnit}`);
      }
      const id=await this.insertPolicy(client,c,payload,key,hash);
      return {...(await this.policyDetail(client,c,id)),replayed:false};
    });
  }

  async listThresholdPolicies(c: UtilityContext, limitRaw?: number) {
    this.scope(c);const limit=this.limit(limitRaw,100);
    const r=await this.database.query<Row>(
      `SELECT p.id::text AS id,p.policy_code,p.name,p.meter_id::text AS meter_id,p.utility_type,p.metric,p.comparison,
        p.threshold_value::text AS threshold_value,p.threshold_unit_code,p.severity,p.status,p.row_version::int AS row_version,
        p.created_by_user_id::text AS created_by_user_id,p.approved_by_user_id::text AS approved_by_user_id,
        p.approved_at::text AS approved_at,p.last_change_reason,p.created_at::text AS created_at,p.updated_at::text AS updated_at
       FROM utility_threshold_policies p WHERE p.tenant_id=$1 AND p.factory_id=$2
       ORDER BY p.created_at DESC,p.id LIMIT $3`,
      [c.tenantId,c.factoryId,limit],{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async transitionThresholdPolicy(c: UtilityContext, id: string, dto: TransitionUtilityThresholdPolicyDto) {
    this.scope(c);this.uuid(id,'policyId');const reason=this.text(dto.reason,'reason',2000);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const q=await client.query<Row>('SELECT status,row_version::int AS row_version,created_by_user_id::text AS created_by_user_id FROM utility_threshold_policies WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[id,c.tenantId,c.factoryId]);
      const row=q.rows[0];if(!row)throw new NotFoundException('Threshold policy was not found in this factory');
      if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Threshold policy version is stale');
      const from=String(row.status),next=dto.action==='ACTIVATE'?'ACTIVE':dto.action==='DEACTIVATE'?'INACTIVE':'RETIRED';
      const allowed:Record<string,string[]>={DRAFT:['ACTIVE','RETIRED'],ACTIVE:['INACTIVE','RETIRED'],INACTIVE:['ACTIVE','RETIRED']};
      if(!(allowed[from]??[]).includes(next))throw new ConflictException(`Invalid threshold policy transition ${from} -> ${next}`);
      if(dto.action==='ACTIVATE'&&String(row.created_by_user_id)===c.userId)throw new ConflictException('Threshold policy activation requires an independent approver');
      await client.query(
        `UPDATE utility_threshold_policies SET status=$4,row_version=row_version+1,
          approved_by_user_id=CASE WHEN $4='ACTIVE' THEN $5::uuid ELSE NULL END,
          approved_at=CASE WHEN $4='ACTIVE' THEN clock_timestamp() ELSE NULL END,
          last_change_reason=$6,updated_by_user_id=$5,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$7`,
        [id,c.tenantId,c.factoryId,next,c.userId,reason,dto.expected_version]);
      return this.policyDetail(client,c,id);
    });
  }

  async listThresholdAlerts(c: UtilityContext, limitRaw?:number, status?:string) {
    this.scope(c);const limit=this.limit(limitRaw,100);
    const valid=['OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED'];
    if(status&&!valid.includes(status))throw new BadRequestException('Invalid alert status');
    const r=await this.database.query<Row>(
      `SELECT a.id::text AS alert_id,a.policy_id::text AS policy_id,p.policy_code,p.name AS policy_name,
        a.reading_id::text AS reading_id,a.utility_event_id::text AS utility_event_id,a.metric,
        a.observed_value::text AS observed_value,a.threshold_snapshot::text AS threshold_value,a.unit_code,a.evidence,
        e.event_number,e.severity,e.status,e.title,e.description,e.occurred_at::text AS occurred_at,
        rd.reading_at::text AS reading_at,rd.reading_value::text AS normalized_reading_value,
        rd.consumption_quantity::text AS consumption_quantity,rd.cost_amount::text AS cost_amount,
        rd.source_type,rd.source_event_id
       FROM utility_threshold_alerts a
       JOIN utility_threshold_policies p ON p.id=a.policy_id AND p.tenant_id=a.tenant_id AND p.factory_id=a.factory_id
       JOIN utility_events e ON e.id=a.utility_event_id AND e.tenant_id=a.tenant_id AND e.factory_id=a.factory_id
       JOIN utility_meter_readings rd ON rd.id=a.reading_id AND rd.tenant_id=a.tenant_id AND rd.factory_id=a.factory_id
       WHERE a.tenant_id=$1 AND a.factory_id=$2 AND ($3::text IS NULL OR e.status=$3)
       ORDER BY CASE e.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        e.occurred_at DESC LIMIT $4`,
      [c.tenantId,c.factoryId,status??null,limit],{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async transitionThresholdAlert(c: UtilityContext, alertId: string, dto: import('./utilities.dto').TransitionUtilityEventDto) {
    this.scope(c);this.uuid(alertId,'alertId');
    const q=await this.database.query<Row>(
      'SELECT utility_event_id::text AS utility_event_id FROM utility_threshold_alerts WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [alertId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    if(!q.rows[0])throw new NotFoundException('Threshold alert was not found in this factory');
    return this.utilities.transitionEvent(c,String(q.rows[0].utility_event_id),dto);
  }

  private async insertSourceBinding(client:PoolClient,c:UtilityContext,p:Record<string,unknown>,key:string,hash:string) {
    const r=await client.query<Row>(
      `INSERT INTO utility_meter_source_bindings(tenant_id,factory_id,source_system_code,source_meter_code,vendor_adapter,
        meter_id,source_unit_code,factor_to_meter_unit,polling_interval_seconds,credential_reference,config_metadata,
        idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
       VALUES($1,$2,$3,$4,$5,$6::uuid,$7,$8::numeric,$9,$10,$11::jsonb,$12,$13,$14,$14,$15::uuid)
       RETURNING id::text AS id`,
      [c.tenantId,c.factoryId,p.source_system_code,p.source_meter_code,p.vendor_adapter,p.meter_id,p.source_unit_code,
        p.factor_to_meter_unit,p.polling_interval_seconds,p.credential_reference,JSON.stringify(p.config_metadata),key,hash,c.userId,this.correlation(c)]);
    return String(r.rows[0].id);
  }
  private async insertPolicy(client:PoolClient,c:UtilityContext,p:Record<string,unknown>,key:string,hash:string) {
    const r=await client.query<Row>(
      `INSERT INTO utility_threshold_policies(tenant_id,factory_id,policy_code,name,meter_id,utility_type,metric,comparison,
        threshold_value,threshold_unit_code,severity,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
       VALUES($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9::numeric,$10,$11,$12,$13,$14,$14,$15::uuid) RETURNING id::text AS id`,
      [c.tenantId,c.factoryId,p.policy_code,p.name,p.meter_id,p.utility_type,p.metric,p.comparison,p.threshold_value,
        p.threshold_unit_code,p.severity,key,hash,c.userId,this.correlation(c)]);
    return String(r.rows[0].id);
  }
  private async sourceBindingDetail(client:PoolClient,c:UtilityContext,id:string) {
    const r=await client.query<Row>(
      `SELECT id::text AS id,source_system_code,source_meter_code,vendor_adapter,meter_id::text AS meter_id,
        source_unit_code,factor_to_meter_unit::text AS factor_to_meter_unit,polling_interval_seconds,
        (credential_reference IS NOT NULL) AS credential_configured,config_metadata,status,row_version::int AS row_version,last_change_reason,created_by_user_id::text AS created_by_user_id,
        approved_by_user_id::text AS approved_by_user_id,approved_at::text AS approved_at,created_at::text AS created_at,
        updated_at::text AS updated_at FROM utility_meter_source_bindings
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,[id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Meter source binding was not found in this factory');
    return r.rows[0];
  }
  private async policyDetail(client:PoolClient,c:UtilityContext,id:string) {
    const r=await client.query<Row>(
      `SELECT id::text AS id,policy_code,name,meter_id::text AS meter_id,utility_type,metric,comparison,
        threshold_value::text AS threshold_value,threshold_unit_code,severity,status,row_version::int AS row_version,
        created_by_user_id::text AS created_by_user_id,approved_by_user_id::text AS approved_by_user_id,
        approved_at::text AS approved_at,last_change_reason,created_at::text AS created_at,updated_at::text AS updated_at
       FROM utility_threshold_policies WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,[id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Threshold policy was not found in this factory');
    return r.rows[0];
  }
  private containsSensitiveKey(value:unknown):boolean{
    const forbidden=/(?:secret|password|token|credential|private.?key|api.?key|authorization|cookie|client.?secret|access.?key)/i;
    if(Array.isArray(value))return value.some(item=>this.containsSensitiveKey(item));
    if(value&&typeof value==='object'){
      for(const [key,item] of Object.entries(value as Record<string,unknown>)){
        if(forbidden.test(key)||this.containsSensitiveKey(item))return true;
      }
    }
    return false;
  }
  private scope(c:UtilityContext) { for(const [field,value] of Object.entries({userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId})) this.uuid(value,field); }
  private key(raw:string|null) { const v=raw?.trim()??'';if(!v||v.length>200)throw new BadRequestException('Idempotency-Key is required and must be at most 200 characters');return v; }
  private uuid(value:string,field:string) { if(!isUUID(value))throw new BadRequestException(field+' must be a UUID');return value; }
  private text(value:string|undefined,field:string,max:number) { const v=value?.trim()??'';if(!v||v.length>max)throw new BadRequestException(field+' is required and must contain at most '+max+' characters');return v; }
  private code(value:string|undefined,field:string,max:number) { const v=this.text(value,field,max).toUpperCase();if(!/^[A-Z0-9][A-Z0-9._-]*$/.test(v))throw new BadRequestException(field+' must be an alphanumeric code');return v; }
  private optionalText(value:string|undefined,max:number) { if(value===undefined||!value.trim())return null;const v=value.trim();if(v.length>max)throw new BadRequestException('optional text is too long');return v; }
  private decimal(value:number,field:string,places:number,positive:boolean) { if(!Number.isFinite(value)||(positive?value<=0:value<0)||Math.abs(value*10**places-Math.round(value*10**places))>0.000001)throw new BadRequestException(field+' has invalid numeric precision or range');return value.toFixed(places); }
  private instant(value:string,field:string) { const d=new Date(value);if(!Number.isFinite(d.getTime()))throw new BadRequestException(field+' must be a valid ISO timestamp');return d.toISOString(); }
  private object(value?:Record<string,unknown>) { if(value===undefined||value===null)return{};if(typeof value!=='object'||Array.isArray(value))throw new BadRequestException('config_metadata must be a JSON object');return value; }
  private limit(value:number|undefined,max:number) { const n=value??50;if(!Number.isInteger(n)||n<1||n>max)throw new BadRequestException('limit must be between 1 and '+max);return n; }
  private hash(value:unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private same(oldHash:unknown,newHash:string) { if(String(oldHash).trim()!==newHash)throw new ConflictException('Idempotency-Key was already used for a different request'); }
  private correlation(c:UtilityContext) { return c.traceId&&isUUID(c.traceId)?c.traceId:c.requestId&&isUUID(c.requestId)?c.requestId:randomUUID(); }
}
