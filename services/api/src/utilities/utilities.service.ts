import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CreateUtilityEventDto, CreateUtilityMeterDto, ListUtilityMetersQueryDto,
  ListUtilityReadingsQueryDto, RecordUtilityReadingDto, TransitionUtilityEventDto,
} from './utilities.dto';

export interface UtilityContext {
  userId: string;
  tenantId: string;
  factoryId: string;
  requestId?: string | null;
  traceId?: string | null;
}
type Row = QueryResultRow;

@Injectable()
export class UtilitiesService {
  constructor(private readonly database: DatabaseService) {}

  async createMeter(c: UtilityContext, dto: CreateUtilityMeterDto, rawKey: string | null) {
    this.assertContext(c);
    const key = this.idempotencyKey(rawKey);
    const payload = {
      meter_code: this.requiredText(dto.meter_code, 'meter_code', 100).toUpperCase(),
      name: this.requiredText(dto.name, 'name', 255),
      utility_type: dto.utility_type,
      reading_mode: dto.reading_mode,
      unit_code: this.requiredText(dto.unit_code, 'unit_code', 24),
      multiplier_factor: this.decimal(dto.multiplier_factor ?? 1, 'multiplier_factor', true),
      unit_cost: this.decimal(dto.unit_cost ?? 0, 'unit_cost'),
      currency_code: (dto.currency_code ?? 'BDT').trim().toUpperCase(),
      cost_center_code: this.optionalText(dto.cost_center_code, 100),
      source_system_code: this.optionalText(dto.source_system_code, 100),
      location: this.optionalText(dto.location, 255),
      parent_meter_id: dto.parent_meter_id ? this.uuid(dto.parent_meter_id, 'parent_meter_id') : null,
    };
    if (!/^[A-Z]{3}$/.test(payload.currency_code)) throw new BadRequestException('currency_code must be a 3-letter ISO currency code');
    const hash = this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`utility-meter:${c.tenantId}:${c.factoryId}:${key}`}, async client => {
      const existing = await client.query<Row>(
        'SELECT id::text AS id,request_hash FROM utility_meters WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key],
      );
      if (existing.rows[0]) {
        this.assertSameRequest(existing.rows[0].request_hash,hash);
        return {...(await this.meterDetail(client,c,String(existing.rows[0].id))),replayed:true};
      }
      if (payload.parent_meter_id) {
        const parent = await client.query<Row>(
          'SELECT id,status FROM utility_meters WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
          [payload.parent_meter_id,c.tenantId,c.factoryId],
        );
        if (!parent.rows[0]) throw new NotFoundException('Parent meter was not found in this factory');
        if (parent.rows[0].status!=='ACTIVE') throw new ConflictException('Parent meter must be active');
      }
      const id=randomUUID();
      await client.query(
        `INSERT INTO utility_meters(
          id,tenant_id,factory_id,parent_meter_id,meter_code,name,utility_type,reading_mode,unit_code,
          multiplier_factor,unit_cost,currency_code,cost_center_code,source_system_code,location,
          idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
        ) VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::numeric,$11::numeric,$12,$13,$14,$15,$16,$17,$18,$18,$19::uuid)`,
        [id,c.tenantId,c.factoryId,payload.parent_meter_id,payload.meter_code,payload.name,payload.utility_type,
          payload.reading_mode,payload.unit_code,payload.multiplier_factor,payload.unit_cost,payload.currency_code,
          payload.cost_center_code,payload.source_system_code,payload.location,key,hash,c.userId,this.correlationId(c)],
      );
      return {...(await this.meterDetail(client,c,id)),replayed:false};
    });
  }

  async listMeters(c: UtilityContext, query: ListUtilityMetersQueryDto) {
    this.assertContext(c);
    const limit=this.limit(query.limit);
    const values: unknown[]=[c.tenantId,c.factoryId];
    const filters:string[]=['tenant_id=$1','factory_id=$2'];
    if (query.utility_type) {values.push(query.utility_type);filters.push(`utility_type=$${values.length}`);}
    if (query.status) {values.push(query.status);filters.push(`status=$${values.length}`);}
    values.push(limit);
    const result=await this.database.query<Row>(
      `SELECT m.id::text,m.parent_meter_id::text,m.meter_code,m.name,m.utility_type,m.reading_mode,m.unit_code,
        m.multiplier_factor::text,m.unit_cost::text,m.currency_code,m.cost_center_code,m.source_system_code,m.location,
        m.status,m.row_version::int,m.created_at::text,m.updated_at::text,
        (SELECT count(*)::int FROM utility_meters ch WHERE ch.parent_meter_id=m.id AND ch.tenant_id=m.tenant_id AND ch.factory_id=m.factory_id) AS child_count
       FROM utility_meters m WHERE ${filters.join(' AND ')} ORDER BY m.meter_code LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId},
    );
    return {items:result.rows};
  }

  async recordReading(c: UtilityContext, meterId: string, dto: RecordUtilityReadingDto, rawKey: string|null) {
    this.assertContext(c); this.uuid(meterId,'meterId');
    const key=this.idempotencyKey(rawKey);
    const readingAt=this.instant(dto.reading_at,'reading_at');
    const readingValue=this.decimal(dto.reading_value,'reading_value');
    const productionQuantity=dto.production_quantity===undefined?null:this.decimal(dto.production_quantity,'production_quantity',true);
    const sourceType=dto.source_type;
    const sourceEventId=this.optionalText(dto.source_event_id,255);
    const notes=this.optionalText(dto.notes,2000);
    const payload={meter_id:meterId.toLowerCase(),reading_at:readingAt,reading_value:readingValue,
      production_quantity:productionQuantity,source_type:sourceType,source_event_id:sourceEventId,notes};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`utility-reading:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const existing=await client.query<Row>(
        'SELECT id::text AS id,request_hash FROM utility_meter_readings WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key],
      );
      if(existing.rows[0]){
        this.assertSameRequest(existing.rows[0].request_hash,hash);
        return {...(await this.readingDetail(client,c,String(existing.rows[0].id))),replayed:true};
      }
      const meterResult=await client.query<Row>(
        `SELECT id::text,reading_mode,unit_code,multiplier_factor::text,unit_cost::text,status
         FROM utility_meters WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [meterId,c.tenantId,c.factoryId],
      );
      const meter=meterResult.rows[0];
      if(!meter) throw new NotFoundException('Utility meter was not found in this factory');
      if(meter.status!=='ACTIVE') throw new ConflictException('Readings can only be captured for active meters');
      const previous=await client.query<Row>(
        `SELECT reading_at::text,reading_value::text FROM utility_meter_readings
         WHERE meter_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY reading_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [meterId,c.tenantId,c.factoryId],
      );
      const previousValue=previous.rows[0]?.reading_value??null;
      if(previous.rows[0] && readingAt<=new Date(String(previous.rows[0].reading_at)).toISOString()){
        throw new ConflictException('Utility readings must be time-ordered; append a governed correction instead of inserting late data');
      }
      if(meter.reading_mode==='CUMULATIVE' && previousValue!==null && Number(readingValue)<Number(previousValue)){
        throw new ConflictException('Cumulative meter values cannot decrease without a rollover/correction procedure');
      }
      const calculation=await client.query<Row>(
        `SELECT
          CASE WHEN $1='CUMULATIVE'
            THEN CASE WHEN $2::numeric IS NULL THEN 0::numeric ELSE ROUND(($3::numeric-$2::numeric)*$4::numeric,8) END
            ELSE ROUND($3::numeric*$4::numeric,8) END::numeric(24,8)::text AS consumption_quantity,
          ROUND((CASE WHEN $1='CUMULATIVE'
            THEN CASE WHEN $2::numeric IS NULL THEN 0::numeric ELSE ROUND(($3::numeric-$2::numeric)*$4::numeric,8) END
            ELSE ROUND($3::numeric*$4::numeric,8) END)*$5::numeric,8)::numeric(24,8)::text AS cost_amount`,
        [meter.reading_mode,previousValue,readingValue,meter.multiplier_factor,meter.unit_cost],
      );
      const consumption=String(calculation.rows[0].consumption_quantity);
      const cost=String(calculation.rows[0].cost_amount);
      const id=randomUUID();
      await client.query(
        `INSERT INTO utility_meter_readings(
          id,tenant_id,factory_id,meter_id,reading_at,reading_value,previous_reading_value,
          consumption_quantity,unit_code,unit_cost_snapshot,cost_amount,production_quantity,
          source_type,source_event_id,notes,idempotency_key,request_hash,recorded_by_user_id,
          correlation_id,request_id
        ) VALUES($1,$2,$3,$4::uuid,$5::timestamptz,$6::numeric,$7::numeric,$8::numeric,$9,$10::numeric,
          $11::numeric,$12::numeric,$13,$14,$15,$16,$17,$18,$19::uuid,$20)`,
        [id,c.tenantId,c.factoryId,meterId,readingAt,readingValue,previousValue,consumption,meter.unit_code,
          meter.unit_cost,cost,productionQuantity,sourceType,sourceEventId,notes,key,hash,c.userId,
          this.correlationId(c),c.requestId??null],
      );
      return {...(await this.readingDetail(client,c,id)),replayed:false};
    });
  }

  async listReadings(c: UtilityContext, meterId: string, query: ListUtilityReadingsQueryDto) {
    this.assertContext(c);this.uuid(meterId,'meterId');
    const limit=this.limit(query.limit);
    if(query.from && query.to && new Date(query.from).getTime()>new Date(query.to).getTime()){
      throw new BadRequestException('from must be less than or equal to to');
    }
    const values:unknown[]=[c.tenantId,c.factoryId,meterId];
    const filters=['r.tenant_id=$1','r.factory_id=$2','r.meter_id=$3'];
    if(query.from){values.push(query.from);filters.push(`r.reading_at >= $${values.length}::timestamptz`);}
    if(query.to){values.push(query.to);filters.push(`r.reading_at <= $${values.length}::timestamptz`);}
    values.push(limit);
    const result=await this.database.query<Row>(
      `SELECT r.id::text,r.meter_id::text,r.reading_at::text,r.reading_value::text,r.previous_reading_value::text,
        r.consumption_quantity::text,r.unit_code,r.unit_cost_snapshot::text,r.cost_amount::text,
        r.production_quantity::text,r.intensity_per_unit::text,r.source_type,r.source_event_id,r.notes,r.created_at::text
       FROM utility_meter_readings r JOIN utility_meters m
         ON m.id=r.meter_id AND m.tenant_id=r.tenant_id AND m.factory_id=r.factory_id
       WHERE ${filters.join(' AND ')} ORDER BY r.reading_at DESC,r.id DESC LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId},
    );
    return {items:result.rows};
  }

  async createEvent(c: UtilityContext,dto:CreateUtilityEventDto,rawKey:string|null) {
    this.assertContext(c);const key=this.idempotencyKey(rawKey);
    const payload={
      meter_id:dto.meter_id?this.uuid(dto.meter_id,'meter_id'):null,event_type:dto.event_type,severity:dto.severity,
      title:this.requiredText(dto.title,'title',255),description:this.requiredText(dto.description,'description',4000),
      occurred_at:this.instant(dto.occurred_at,'occurred_at'),impact_minutes:dto.impact_minutes??0,
      impact_quantity:dto.impact_quantity===undefined?null:this.decimal(dto.impact_quantity,'impact_quantity'),
      cause:this.optionalText(dto.cause,2000),
    };
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`utility-event:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const existing=await client.query<Row>(
        'SELECT id::text AS id,request_hash FROM utility_events WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key],
      );
      if(existing.rows[0]){
        this.assertSameRequest(existing.rows[0].request_hash,hash);
        return {...(await this.eventDetail(client,c,String(existing.rows[0].id))),replayed:true};
      }
      if(payload.meter_id){
        const meter=await client.query<Row>('SELECT status FROM utility_meters WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
          [payload.meter_id,c.tenantId,c.factoryId]);
        if(!meter.rows[0])throw new NotFoundException('Utility meter was not found in this factory');
      }
      const id=randomUUID();
      const number=`UE-${payload.occurred_at.slice(0,10).replace(/-/g,'')}-${id.slice(0,8).toUpperCase()}`;
      await client.query(
        `INSERT INTO utility_events(id,tenant_id,factory_id,meter_id,event_number,event_type,severity,title,description,
          occurred_at,impact_minutes,impact_quantity,cause,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
         VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12::numeric,$13,$14,$15,$16,$16,$17::uuid)`,
        [id,c.tenantId,c.factoryId,payload.meter_id,number,payload.event_type,payload.severity,payload.title,payload.description,
          payload.occurred_at,payload.impact_minutes,payload.impact_quantity,payload.cause,key,hash,c.userId,this.correlationId(c)],
      );
      return {...(await this.eventDetail(client,c,id)),replayed:false};
    });
  }

  async listEvents(c:UtilityContext,limitRaw?:number,status?:string) {
    this.assertContext(c);const limit=this.limit(limitRaw);
    const values:unknown[]=[c.tenantId,c.factoryId];const filters=['tenant_id=$1','factory_id=$2'];
    if(status){if(!['OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED'].includes(status))throw new BadRequestException('Invalid utility event status');values.push(status);filters.push(`status=$${values.length}`);}
    values.push(limit);
    const result=await this.database.query<Row>(
      `SELECT id::text,meter_id::text,event_number,event_type,severity,status,title,description,occurred_at::text,
        resolved_at::text,impact_minutes,impact_quantity::text,cause,resolution,row_version::int,last_change_reason,
        created_at::text,updated_at::text FROM utility_events WHERE ${filters.join(' AND ')}
       ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        occurred_at DESC LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId},
    );
    return {items:result.rows};
  }

  async transitionEvent(c:UtilityContext,eventId:string,dto:TransitionUtilityEventDto) {
    this.assertContext(c);this.uuid(eventId,'eventId');
    const reason=this.requiredText(dto.reason,'reason',2000);
    if(dto.action==='RESOLVE' && !dto.resolution?.trim())throw new BadRequestException('resolution is required to resolve a utility event');
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const current=await client.query<Row>(
        'SELECT status,row_version::int FROM utility_events WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [eventId,c.tenantId,c.factoryId],
      );
      if(!current.rows[0])throw new NotFoundException('Utility event was not found in this factory');
      if(Number(current.rows[0].row_version)!==dto.expected_version){
        throw new ConflictException('Utility event version is stale; reload before retrying');
      }
      const next=dto.action==='ACKNOWLEDGE'?'ACKNOWLEDGED':dto.action==='RESOLVE'?'RESOLVED':'CANCELLED';
      const allowed:Record<string,string[]>={OPEN:['ACKNOWLEDGED','CANCELLED'],ACKNOWLEDGED:['RESOLVED','CANCELLED']};
      if(!(allowed[String(current.rows[0].status)]??[]).includes(next))throw new ConflictException(`Invalid utility event transition to ${next}`);
      await client.query(
        `UPDATE utility_events SET status=$4,resolved_at=CASE WHEN $4='RESOLVED' THEN clock_timestamp() ELSE NULL END,
          resolution=CASE WHEN $4='RESOLVED' THEN $5 ELSE resolution END,
          impact_minutes=COALESCE($6,impact_minutes),impact_quantity=COALESCE($7::numeric,impact_quantity),
          last_change_reason=$8,updated_by_user_id=$9,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [eventId,c.tenantId,c.factoryId,next,dto.resolution?.trim()||null,dto.impact_minutes??null,
          dto.impact_quantity===undefined?null:this.decimal(dto.impact_quantity,'impact_quantity'),reason,c.userId],
      );
      return this.eventDetail(client,c,eventId);
    });
  }

  private async meterDetail(client:PoolClient,c:UtilityContext,id:string) {
    const r=await client.query<Row>(
      `SELECT m.id::text,m.parent_meter_id::text,m.meter_code,m.name,m.utility_type,m.reading_mode,m.unit_code,
        m.multiplier_factor::text,m.unit_cost::text,m.currency_code,m.cost_center_code,m.source_system_code,m.location,
        m.status,m.row_version::int,m.created_by_user_id::text,m.updated_by_user_id::text,m.created_at::text,m.updated_at::text,
        (SELECT count(*)::int FROM utility_meters ch WHERE ch.parent_meter_id=m.id AND ch.tenant_id=m.tenant_id AND ch.factory_id=m.factory_id) AS child_count,
        (SELECT consumption_quantity::text FROM utility_meter_readings rd WHERE rd.meter_id=m.id AND rd.tenant_id=m.tenant_id
          AND rd.factory_id=m.factory_id ORDER BY rd.reading_at DESC,rd.id DESC LIMIT 1) AS latest_consumption_quantity
       FROM utility_meters m WHERE m.id=$1 AND m.tenant_id=$2 AND m.factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Utility meter was not found in this factory');
    return r.rows[0];
  }

  private async readingDetail(client:PoolClient,c:UtilityContext,id:string) {
    const r=await client.query<Row>(
      `SELECT id::text,meter_id::text,reading_at::text,reading_value::text,previous_reading_value::text,
        consumption_quantity::text,unit_code,unit_cost_snapshot::text,cost_amount::text,production_quantity::text,
        intensity_per_unit::text,source_type,source_event_id,notes,recorded_by_user_id::text,created_at::text
       FROM utility_meter_readings WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Utility reading was not found');
    return r.rows[0];
  }

  private async eventDetail(client:PoolClient,c:UtilityContext,id:string) {
    const r=await client.query<Row>(
      `SELECT id::text,meter_id::text,event_number,event_type,severity,status,title,description,occurred_at::text,
        resolved_at::text,impact_minutes,impact_quantity::text,cause,resolution,row_version::int,last_change_reason,
        created_by_user_id::text,updated_by_user_id::text,created_at::text,updated_at::text
       FROM utility_events WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Utility event was not found');
    return r.rows[0];
  }

  private assertContext(c:UtilityContext){
    for(const [field,value] of Object.entries({userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId})){
      if(!isUUID(value))throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }
  private uuid(v:string,label:string){if(!isUUID(v))throw new BadRequestException(`${label} must be a valid UUID`);return v.toLowerCase();}
  private idempotencyKey(v:string|null){if(!v?.trim()||v.trim().length>255)throw new BadRequestException('A non-empty Idempotency-Key of at most 255 characters is required');return v.trim();}
  private requiredText(v:string,label:string,max:number){const value=v?.trim();if(!value||value.length>max)throw new BadRequestException(`${label} is required and must be at most ${max} characters`);return value;}
  private optionalText(v:string|undefined,max:number){const value=v?.trim();if(!value)return null;if(value.length>max)throw new BadRequestException(`Text cannot exceed ${max} characters`);return value;}
  private decimal(v:number|string,label:string,positive=false){
    const n=Number(v);if(!Number.isFinite(n)||n<0||(positive&&n<=0))throw new BadRequestException(`${label} must be ${positive?'greater than zero':'non-negative'}`);
    if(!/^-?\d+(?:\.\d{1,8})?$/.test(String(v)))throw new BadRequestException(`${label} supports at most 8 decimal places`);
    return n.toFixed(8);
  }
  private instant(v:string,label:string){if(!v||!Number.isFinite(Date.parse(v)))throw new BadRequestException(`${label} must be a valid timestamp`);return new Date(v).toISOString();}
  private hash(v:unknown){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
  private assertSameRequest(oldHash:string,newHash:string){if(oldHash!==newHash)throw new ConflictException('Idempotency-Key was already used with a different request payload');}
  private limit(value?:number){const n=value??50;if(!Number.isInteger(n)||n<1||n>200)throw new BadRequestException('limit must be an integer between 1 and 200');return n;}
  private correlationId(c:UtilityContext){return c.traceId&&isUUID(c.traceId)?c.traceId:c.requestId&&isUUID(c.requestId)?c.requestId:randomUUID();}
}
