import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { UtilityContext } from './utilities.service';
import type { CreateUtilityWorkOrderCostAllocationDto, ReverseUtilityWorkOrderCostAllocationDto } from './utilities.dto';

type Row=QueryResultRow;

@Injectable()
export class UtilityWorkOrderCostAllocationService {
  constructor(private readonly database:DatabaseService){}

  async list(c:UtilityContext,meterId:string,readingId:string){
    this.assertContext(c);this.uuid(meterId,'meterId');this.uuid(readingId,'readingId');
    const source=await this.database.query<Row>(
      `SELECT r.id::text AS reading_id,r.meter_id::text AS meter_id,r.reading_at::text,
        r.consumption_quantity::text,r.unit_code,r.unit_cost_snapshot::text,
        r.currency_code_snapshot,r.cost_center_code_snapshot,
        COALESCE(SUM(CASE WHEN a.allocation_kind='ALLOCATE' THEN a.allocated_quantity
          WHEN a.allocation_kind='REVERSAL' THEN -a.allocated_quantity ELSE 0 END),0)::text AS net_allocated_quantity,
        GREATEST(r.consumption_quantity-COALESCE(SUM(CASE WHEN a.allocation_kind='ALLOCATE' THEN a.allocated_quantity
          WHEN a.allocation_kind='REVERSAL' THEN -a.allocated_quantity ELSE 0 END),0),0)::text AS remaining_quantity,
        COUNT(a.id)::int AS allocation_count
       FROM utility_meter_readings r
       LEFT JOIN utility_reading_work_order_cost_allocations a
         ON a.reading_id=r.id AND a.tenant_id=r.tenant_id AND a.factory_id=r.factory_id
       WHERE r.id=$1 AND r.meter_id=$2 AND r.tenant_id=$3 AND r.factory_id=$4
       GROUP BY r.id`,
      [readingId,meterId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId},
    );
    if(!source.rows[0])throw new NotFoundException('Utility reading was not found under this meter and factory');
    const items=await this.database.query<Row>(
      `SELECT a.id::text,a.reading_id::text,a.meter_id::text,a.work_order_id::text,wo.work_order_number,
        a.allocation_kind,a.reverses_allocation_id::text,a.allocation_basis,a.allocated_quantity::text,
        a.unit_code,a.unit_cost_snapshot::text,a.allocated_cost::text,a.currency_code,a.cost_center_code,
        a.reason,a.created_by_user_id::text,a.created_at::text
       FROM utility_reading_work_order_cost_allocations a
       JOIN work_orders wo ON wo.id=a.work_order_id AND wo.tenant_id=a.tenant_id AND wo.factory_id=a.factory_id
       WHERE a.reading_id=$1 AND a.meter_id=$2 AND a.tenant_id=$3 AND a.factory_id=$4
       ORDER BY a.created_at,a.id LIMIT 200`,
      [readingId,meterId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId},
    );
    return {source:source.rows[0],items:items.rows,truncated:Number(source.rows[0].allocation_count)>items.rows.length};
  }

  async allocate(c:UtilityContext,meterId:string,readingId:string,dto:CreateUtilityWorkOrderCostAllocationDto,rawKey:string|null){
    this.assertContext(c);this.uuid(meterId,'meterId');this.uuid(readingId,'readingId');
    const key=this.idempotencyKey(rawKey);
    const workOrderId=this.uuid(dto.work_order_id,'work_order_id');
    const quantity=this.positiveDecimal(dto.allocated_quantity,'allocated_quantity');
    const reason=this.requiredText(dto.reason,'reason',2000);
    const payload={meter_id:meterId.toLowerCase(),reading_id:readingId.toLowerCase(),work_order_id:workOrderId,allocated_quantity:quantity,reason};
    const requestHash=this.hash(payload);
    return this.database.transaction({
      tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:'utility-work-order-allocation:'+c.tenantId+':'+c.factoryId+':'+readingId,
    },async client=>{
      const existing=await client.query<Row>(
        'SELECT id::text,request_hash FROM utility_reading_work_order_cost_allocations WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key],
      );
      if(existing.rows[0]){
        this.assertSameRequest(String(existing.rows[0].request_hash),requestHash);
        return {...(await this.detail(client,c,String(existing.rows[0].id))),replayed:true};
      }
      const sourceResult=await client.query<Row>(
        `SELECT id::text AS reading_id,meter_id::text,reading_at::text,consumption_quantity::text,
          unit_code,unit_cost_snapshot::text,currency_code_snapshot,cost_center_code_snapshot
         FROM utility_meter_readings
         WHERE id=$1 AND meter_id=$2 AND tenant_id=$3 AND factory_id=$4 FOR UPDATE`,
        [readingId,meterId,c.tenantId,c.factoryId],
      );
      const source=sourceResult.rows[0];
      if(!source)throw new NotFoundException('Utility reading was not found under this meter and factory');
      if(!source.currency_code_snapshot)throw new ConflictException('Historical utility reading has no frozen currency snapshot; only readings captured after the snapshot migration can be allocated');
      if(!this.isPositiveDecimal(String(source.consumption_quantity)))throw new ConflictException('A zero-consumption meter baseline cannot be allocated');

      const woResult=await client.query<Row>(
        'SELECT work_order_number,status,released_at::text,completed_at::text FROM work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
        [workOrderId,c.tenantId,c.factoryId],
      );
      const wo=woResult.rows[0];
      if(!wo)throw new NotFoundException('Work order was not found in this factory');
      const readingAt=Date.parse(String(source.reading_at));
      const releasedAt=wo.released_at?Date.parse(String(wo.released_at)):Number.NaN;
      const completedAt=wo.completed_at?Date.parse(String(wo.completed_at)):null;
      if(!['IN_PROGRESS','COMPLETED'].includes(String(wo.status))||!Number.isFinite(releasedAt)||readingAt<releasedAt
        ||(completedAt!==null&&(!Number.isFinite(completedAt)||readingAt>completedAt))){
        throw new ConflictException('The meter reading timestamp must fall inside a released IN_PROGRESS or COMPLETED work-order window');
      }

      const netResult=await client.query<Row>(
        `SELECT COALESCE(SUM(CASE WHEN allocation_kind='ALLOCATE' THEN allocated_quantity
          WHEN allocation_kind='REVERSAL' THEN -allocated_quantity ELSE 0 END),0)::text AS net_quantity
         FROM utility_reading_work_order_cost_allocations WHERE reading_id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [readingId,c.tenantId,c.factoryId],
      );
      const capacity=await client.query<Row>(
        'SELECT ($1::numeric+$2::numeric<=$3::numeric) AS within_capacity',
        [String(netResult.rows[0]?.net_quantity??'0'),quantity,String(source.consumption_quantity)],
      );
      if(capacity.rows[0]?.within_capacity!==true)throw new ConflictException('Net work-order allocations would exceed immutable utility reading consumption');

      const costResult=await client.query<Row>(
        'SELECT ROUND($1::numeric*$2::numeric,8)::numeric(24,8)::text AS allocated_cost',
        [quantity,String(source.unit_cost_snapshot)],
      );
      const inserted=await client.query<Row>(
        `INSERT INTO utility_reading_work_order_cost_allocations(
          tenant_id,factory_id,reading_id,meter_id,work_order_id,allocation_kind,allocated_quantity,
          unit_code,unit_cost_snapshot,allocated_cost,currency_code,cost_center_code,reason,
          idempotency_key,request_hash,created_by_user_id,correlation_id,request_id
        ) VALUES($1,$2,$3::uuid,$4::uuid,$5::uuid,'ALLOCATE',$6::numeric,$7,$8::numeric,$9::numeric,
          $10,$11,$12,$13,$14,$15,$16::uuid,$17) RETURNING id::text`,
        [c.tenantId,c.factoryId,readingId,meterId,workOrderId,quantity,source.unit_code,
          String(source.unit_cost_snapshot),String(costResult.rows[0].allocated_cost),String(source.currency_code_snapshot).trim(),
          source.cost_center_code_snapshot,reason,key,requestHash,c.userId,this.correlationId(c),c.requestId??null],
      );
      return {...(await this.detail(client,c,String(inserted.rows[0].id))),replayed:false};
    });
  }

  async reverse(c:UtilityContext,meterId:string,readingId:string,allocationId:string,dto:ReverseUtilityWorkOrderCostAllocationDto,rawKey:string|null){
    this.assertContext(c);this.uuid(meterId,'meterId');this.uuid(readingId,'readingId');this.uuid(allocationId,'allocationId');
    const key=this.idempotencyKey(rawKey);const reason=this.requiredText(dto.reason,'reason',2000);
    const payload={meter_id:meterId.toLowerCase(),reading_id:readingId.toLowerCase(),allocation_id:allocationId.toLowerCase(),reason};
    const requestHash=this.hash(payload);
    return this.database.transaction({
      tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:'utility-work-order-allocation-reversal:'+c.tenantId+':'+c.factoryId+':'+allocationId,
    },async client=>{
      const existing=await client.query<Row>(
        'SELECT id::text,request_hash FROM utility_reading_work_order_cost_allocations WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key],
      );
      if(existing.rows[0]){
        this.assertSameRequest(String(existing.rows[0].request_hash),requestHash);
        return {...(await this.detail(client,c,String(existing.rows[0].id))),replayed:true};
      }
      const originalResult=await client.query<Row>(
        `SELECT * FROM utility_reading_work_order_cost_allocations
         WHERE id=$1 AND reading_id=$2 AND meter_id=$3 AND tenant_id=$4 AND factory_id=$5
           AND allocation_kind='ALLOCATE' FOR UPDATE`,
        [allocationId,readingId,meterId,c.tenantId,c.factoryId],
      );
      const original=originalResult.rows[0];
      if(!original)throw new NotFoundException('Original allocation was not found under this meter reading');
      await client.query('SELECT id FROM utility_meter_readings WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [readingId,c.tenantId,c.factoryId]);
      const reversed=await client.query<Row>(
        'SELECT id::text FROM utility_reading_work_order_cost_allocations WHERE reverses_allocation_id=$1 AND tenant_id=$2 AND factory_id=$3',
        [allocationId,c.tenantId,c.factoryId],
      );
      if(reversed.rows.length)throw new ConflictException('This allocation has already been fully reversed');
      const inserted=await client.query<Row>(
        `INSERT INTO utility_reading_work_order_cost_allocations(
          tenant_id,factory_id,reading_id,meter_id,work_order_id,allocation_kind,reverses_allocation_id,
          allocation_basis,allocated_quantity,unit_code,unit_cost_snapshot,allocated_cost,
          currency_code,cost_center_code,reason,idempotency_key,request_hash,created_by_user_id,correlation_id,request_id
        ) VALUES($1,$2,$3::uuid,$4::uuid,$5::uuid,'REVERSAL',$6::uuid,$7,$8::numeric,$9,$10::numeric,
          $11::numeric,$12,$13,$14,$15,$16,$17,$18::uuid,$19) RETURNING id::text`,
        [c.tenantId,c.factoryId,readingId,meterId,String(original.work_order_id),allocationId,String(original.allocation_basis),
          String(original.allocated_quantity),String(original.unit_code),String(original.unit_cost_snapshot),
          String(original.allocated_cost),String(original.currency_code).trim(),original.cost_center_code,
          reason,key,requestHash,c.userId,this.correlationId(c),c.requestId??null],
      );
      return {...(await this.detail(client,c,String(inserted.rows[0].id))),replayed:false};
    });
  }

  private async detail(client:PoolClient,c:UtilityContext,id:string){
    const result=await client.query<Row>(
      `SELECT a.id::text,a.reading_id::text,a.meter_id::text,a.work_order_id::text,wo.work_order_number,
        a.allocation_kind,a.reverses_allocation_id::text,a.allocation_basis,a.allocated_quantity::text,
        a.unit_code,a.unit_cost_snapshot::text,a.allocated_cost::text,a.currency_code,a.cost_center_code,
        a.reason,a.created_by_user_id::text,a.created_at::text
       FROM utility_reading_work_order_cost_allocations a
       JOIN work_orders wo ON wo.id=a.work_order_id AND wo.tenant_id=a.tenant_id AND wo.factory_id=a.factory_id
       WHERE a.id=$1 AND a.tenant_id=$2 AND a.factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!result.rows[0])throw new NotFoundException('Utility work-order cost allocation was not found');
    return result.rows[0];
  }
  private assertContext(c:UtilityContext){
    for(const [field,value] of Object.entries({userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId}))
      if(!isUUID(value))throw new BadRequestException(field+' must be a valid UUID');
  }
  private uuid(value:string,label:string){
    if(!isUUID(value))throw new BadRequestException(label+' must be a valid UUID');
    return value.toLowerCase();
  }
  private idempotencyKey(value:string|null){
    if(!value?.trim()||value.trim().length>255)throw new BadRequestException('A non-empty Idempotency-Key of at most 255 characters is required');
    return value.trim();
  }
  private requiredText(value:string,label:string,max:number){
    const result=value?.trim();
    if(!result||result.length>max)throw new BadRequestException(label+' is required and must be at most '+max+' characters');
    return result;
  }
  private positiveDecimal(value:string,label:string){
    const text=value?.trim();const match=text?.match(/^(0|[1-9]\d{0,15})(?:\.(\d{1,8}))?$/);
    if(!match)throw new BadRequestException(label+' must be a plain positive decimal with up to 8 fractional digits');
    const fraction=match[2]??'';const scaled=BigInt(match[1])*100000000n+BigInt((fraction+'00000000').slice(0,8));
    if(scaled<=0n)throw new BadRequestException(label+' must be greater than zero');
    const normalized=fraction.replace(/0+$/,'');return normalized?match[1]+'.'+normalized:match[1];
  }
  private isPositiveDecimal(value:string){
    const match=value.match(/^(0|[1-9]\d{0,15})(?:\.(\d{1,8}))?$/);if(!match)return false;
    return BigInt(match[1])*100000000n+BigInt(((match[2]??'')+'00000000').slice(0,8))>0n;
  }
  private hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
  private assertSameRequest(oldHash:string,newHash:string){
    if(oldHash!==newHash)throw new ConflictException('Idempotency-Key was already used with a different request payload');
  }
  private correlationId(c:UtilityContext){
    return c.traceId&&isUUID(c.traceId)?c.traceId:c.requestId&&isUUID(c.requestId)?c.requestId:randomUUID();
  }
}