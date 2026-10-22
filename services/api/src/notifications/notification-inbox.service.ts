import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import type { OutboxEvent } from '../outbox/outbox-event.contract';
import { DatabaseService } from '../database/database.service';
import type { AcknowledgeOperationalNotificationDto } from './notifications.dto';

export interface NotificationContext {
  userId:string;tenantId:string;factoryId:string;requestId?:string|null;traceId?:string|null;
}
type Row=QueryResultRow;

@Injectable()
export class NotificationInboxService {
  constructor(private readonly database:DatabaseService){}

  async enqueueUtilityThreshold(event:OutboxEvent){
    const c=this.eventScope(event);
    const p=event.payload;
    const policyId=this.requiredUuid(p.policy_id,'policy_id');
    const alertId=this.requiredUuid(p.alert_id,'alert_id');
    const observed=this.scalar(p.observed_value,'observed_value');
    const threshold=this.scalar(p.threshold,'threshold');
    const metric=this.requiredText(p.metric,'metric',24);
    const unit=this.requiredText(p.unit_code,'unit_code',24);
    const severity=this.severity(p.severity);
    const title=`Utility ${metric.toLowerCase()} threshold exceeded`;
    const body=`Observed ${observed} ${unit}; configured threshold ${threshold} ${unit}. Source alert ${alertId} requires review.`;
    return this.database.transaction(async client=>{
      const recipients=await client.query<Row>(
        `WITH recipient_ids AS (
           SELECT p.created_by_user_id AS user_id
             FROM utility_threshold_policies p
            WHERE p.id=$3::uuid AND p.tenant_id=$1::uuid AND p.factory_id=$2::uuid
           UNION
           SELECT tm.user_id
             FROM tenant_memberships tm
             JOIN users u ON u.id=tm.user_id AND u.status='ACTIVE'
             JOIN user_roles ur ON ur.membership_id=tm.id AND (ur.factory_id IS NULL OR ur.factory_id=$2::uuid)
             JOIN roles r ON r.id=ur.role_id AND r.tenant_id=tm.tenant_id
            WHERE tm.tenant_id=$1::uuid AND tm.status='ACTIVE'
              AND r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
         )
         SELECT DISTINCT x.user_id::text AS user_id
           FROM recipient_ids x
           JOIN users u ON u.id=x.user_id AND u.status='ACTIVE'
           JOIN tenant_memberships tm ON tm.user_id=u.id AND tm.tenant_id=$1::uuid AND tm.status='ACTIVE'
          ORDER BY x.user_id::text`,
        [c.tenantId,c.factoryId,policyId]);
      if(!recipients.rows.length)throw new Error('No active utility notification recipient is configured for the alert');
      let created=0;
      for(const recipient of recipients.rows){
        const result=await client.query(
          `INSERT INTO operational_notifications(
             tenant_id,factory_id,recipient_user_id,source_event_id,source_event_type,aggregate_type,aggregate_id,
             category,severity,title,body,action_required,row_version,payload,correlation_id)
           VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,'UTILITY_THRESHOLD',$8,$9,$10,TRUE,1,$11::jsonb,$12::uuid)
           ON CONFLICT(tenant_id,factory_id,recipient_user_id,source_event_id) DO NOTHING`,
          [c.tenantId,c.factoryId,String(recipient.user_id),event.id,event.eventType,event.aggregateType,event.aggregateId,
            severity,title,body,JSON.stringify({alert_id:alertId,policy_id:policyId,metric,observed_value:observed,
              threshold_value:threshold,unit_code:unit,source_event_id:event.id}),c.correlationId]);
        created+=result.rowCount??0;
      }
      return {recipients:recipients.rows.length,created,replayed:created===0};
    },{tenantId:c.tenantId,userId:null,requestId:event.id,traceId:c.correlationId});
  }

  async enqueueEhsLifecycle(event:OutboxEvent){
    const c=this.eventScope(event);
    const p=event.payload;
    const entityType=this.requiredText(p.entity_type,'entity_type',32);
    const entityId=this.requiredUuid(p.entity_id,'entity_id');
    const action=this.requiredText(p.action,'action',64);
    const version=this.positiveInt(p.version,'version');
    const allowed=['EMERGENCY_DRILL','DRILL_ATTENDANCE','DRILL_RESPONSE','CHEMICAL_SDS','CONTRACTOR_INDUCTION'];
    if(!allowed.includes(entityType))throw new BadRequestException('Unsupported EHS notification entity type');
    const title=`EHS ${entityType.toLowerCase().replace(/_/g,' ')}: ${action.toLowerCase().replace(/_/g,' ')}`;
    const body=`EHS record ${entityId} changed to ${action} at version ${version}. Review the factory-scoped source record and take the next required action.`;
    const severity=entityType==='EMERGENCY_DRILL'?'HIGH':'MEDIUM';
    return this.database.transaction(async client=>{
      const recipients=await client.query<Row>(
        `WITH responsible_ids AS (
           SELECT owner_user_id AS user_id FROM ehs_emergency_drills
            WHERE $3='EMERGENCY_DRILL' AND id=$4::uuid AND tenant_id=$1::uuid AND factory_id=$2::uuid
           UNION
           SELECT d.owner_user_id FROM ehs_drill_attendance a
             JOIN ehs_emergency_drills d ON d.id=a.drill_id AND d.tenant_id=a.tenant_id AND d.factory_id=a.factory_id
            WHERE $3='DRILL_ATTENDANCE' AND a.id=$4::uuid AND a.tenant_id=$1::uuid AND a.factory_id=$2::uuid
           UNION
           SELECT d.owner_user_id FROM ehs_drill_responses r
             JOIN ehs_emergency_drills d ON d.id=r.drill_id AND d.tenant_id=r.tenant_id AND d.factory_id=r.factory_id
            WHERE $3='DRILL_RESPONSE' AND r.id=$4::uuid AND r.tenant_id=$1::uuid AND r.factory_id=$2::uuid
           UNION
           SELECT created_by_user_id FROM ehs_chemical_sds_registry
            WHERE $3='CHEMICAL_SDS' AND id=$4::uuid AND tenant_id=$1::uuid AND factory_id=$2::uuid
           UNION
           SELECT recorded_by_user_id FROM ehs_contractor_inductions
            WHERE $3='CONTRACTOR_INDUCTION' AND id=$4::uuid AND tenant_id=$1::uuid AND factory_id=$2::uuid
         ), manager_ids AS (
           SELECT tm.user_id
             FROM tenant_memberships tm
             JOIN users u ON u.id=tm.user_id AND u.status='ACTIVE'
             JOIN user_roles ur ON ur.membership_id=tm.id AND (ur.factory_id IS NULL OR ur.factory_id=$2::uuid)
             JOIN roles r ON r.id=ur.role_id AND r.tenant_id=tm.tenant_id
            WHERE tm.tenant_id=$1::uuid AND tm.status='ACTIVE'
              AND r.code IN ('ORG_ADMIN','FACTORY_MANAGER','EHS_MANAGER')
         ), recipient_ids AS (
           SELECT user_id FROM responsible_ids
           UNION SELECT user_id FROM manager_ids
         )
         SELECT DISTINCT x.user_id::text AS user_id
           FROM recipient_ids x
           JOIN users u ON u.id=x.user_id AND u.status='ACTIVE'
           JOIN tenant_memberships tm ON tm.user_id=u.id AND tm.tenant_id=$1::uuid AND tm.status='ACTIVE'
          ORDER BY x.user_id::text`,
        [c.tenantId,c.factoryId,entityType,entityId]);
      if(!recipients.rows.length)throw new Error('No active EHS notification recipient is configured for the lifecycle event');
      let created=0;
      for(const recipient of recipients.rows){
        const result=await client.query(
          `INSERT INTO operational_notifications(
             tenant_id,factory_id,recipient_user_id,source_event_id,source_event_type,aggregate_type,aggregate_id,
             category,severity,title,body,action_required,row_version,payload,correlation_id)
           VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,'EHS_LIFECYCLE',$8,$9,$10,TRUE,1,$11::jsonb,$12::uuid)
           ON CONFLICT(tenant_id,factory_id,recipient_user_id,source_event_id) DO NOTHING`,
          [c.tenantId,c.factoryId,String(recipient.user_id),event.id,event.eventType,event.aggregateType,event.aggregateId,
            severity,title,body,JSON.stringify({entity_type:entityType,entity_id:entityId,action,version,source_event_id:event.id}),
            c.correlationId]);
        created+=result.rowCount??0;
      }
      return {recipients:recipients.rows.length,created,replayed:created===0};
    },{tenantId:c.tenantId,userId:null,requestId:event.id,traceId:c.correlationId});
  }

  async listInbox(c:NotificationContext,limitRaw?:number,status?:string){
    this.scope(c);
    const limit=limitRaw??50;
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new BadRequestException('limit must be between 1 and 200');
    if(status&&!['UNREAD','ACKNOWLEDGED'].includes(status))throw new BadRequestException('Invalid notification status');
    const values:unknown[]=[c.tenantId,c.factoryId,c.userId];
    const where=['tenant_id=$1::uuid','factory_id=$2::uuid','recipient_user_id=$3::uuid'];
    if(status){values.push(status);where.push(`status=$${values.length}`);}
    values.push(limit);
    const result=await this.database.query<Row>(
      `SELECT id::text AS id,source_event_id::text AS source_event_id,source_event_type,aggregate_type,
        aggregate_id::text AS aggregate_id,category,severity,title,body,action_required,status,
        row_version::int AS row_version,payload,acknowledged_by_user_id::text AS acknowledged_by_user_id,
        acknowledged_at::text AS acknowledged_at,last_change_reason,created_at::text AS created_at,
        updated_at::text AS updated_at
       FROM operational_notifications WHERE ${where.join(' AND ')}
       ORDER BY CASE status WHEN 'UNREAD' THEN 0 ELSE 1 END,created_at DESC,id LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId});
    return {items:result.rows};
  }

  async acknowledge(c:NotificationContext,id:string,dto:AcknowledgeOperationalNotificationDto){
    this.scope(c);this.uuid(id,'notificationId');
    const reason=this.requiredText(dto.reason,'reason',2000);
    return this.database.transaction(async client=>{
      const query=await client.query<Row>(
        `SELECT id::text AS id,status,row_version::int AS row_version
         FROM operational_notifications WHERE id=$1::uuid AND tenant_id=$2::uuid AND factory_id=$3::uuid
           AND recipient_user_id=$4::uuid FOR UPDATE`,
        [id,c.tenantId,c.factoryId,c.userId]);
      const row=query.rows[0];
      if(!row)throw new NotFoundException('Operational notification was not found in this factory inbox');
      if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Notification version is stale');
      if(row.status!=='UNREAD')throw new ConflictException('Only an unread notification can be acknowledged');
      await client.query(
        `UPDATE operational_notifications SET status='ACKNOWLEDGED',row_version=row_version+1,
          acknowledged_by_user_id=$5::uuid,acknowledged_at=clock_timestamp(),updated_by_user_id=$5::uuid,
          last_change_reason=$6,updated_at=clock_timestamp()
         WHERE id=$1::uuid AND tenant_id=$2::uuid AND factory_id=$3::uuid AND recipient_user_id=$4::uuid AND row_version=$7`,
        [id,c.tenantId,c.factoryId,c.userId,c.userId,reason,dto.expected_version]);
      const final=await client.query<Row>(
        `SELECT id::text AS id,status,row_version::int AS row_version,acknowledged_by_user_id::text AS acknowledged_by_user_id,
          acknowledged_at::text AS acknowledged_at,last_change_reason,updated_at::text AS updated_at
         FROM operational_notifications WHERE id=$1::uuid AND tenant_id=$2::uuid AND factory_id=$3::uuid`,
        [id,c.tenantId,c.factoryId]);
      return final.rows[0];
    },{tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId});
  }

  private eventScope(event:OutboxEvent){
    if(!isUUID(event.tenantId)||!event.factoryId||!isUUID(event.factoryId)||!isUUID(event.id))
      throw new Error('Notification source event requires valid tenant, factory and source event identifiers');
    return {tenantId:event.tenantId,factoryId:event.factoryId,correlationId:event.correlationId&&isUUID(event.correlationId)?event.correlationId:null};
  }
  private scope(c:NotificationContext){
    for(const [field,value] of Object.entries({userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId}))this.uuid(value,field);
  }
  private uuid(v:string,field:string){if(!isUUID(v))throw new BadRequestException(field+' must be a UUID');return v;}
  private requiredUuid(v:unknown,field:string){if(typeof v!=='string'||!isUUID(v))throw new Error('Invalid notification event field '+field);return v;}
  private requiredText(v:unknown,field:string,max:number){if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('Invalid notification event field '+field);return v.trim();}
  private scalar(v:unknown,field:string){if((typeof v!=='string'&&typeof v!=='number')||!String(v).trim()||String(v).length>80)throw new Error('Invalid notification event field '+field);return String(v);}
  private positiveInt(v:unknown,field:string){const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid notification event field '+field);return n;}
  private severity(v:unknown):'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'{
    if(v!=='LOW'&&v!=='MEDIUM'&&v!=='HIGH'&&v!=='CRITICAL')throw new Error('Invalid utility alert severity');
    return v;
  }
}
