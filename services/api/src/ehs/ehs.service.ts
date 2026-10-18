import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CreateEhsCorrectiveActionDto, CreateEhsIncidentDto, CreateEhsPermitDto, ListEhsQueryDto,
  TransitionEhsCorrectiveActionDto, TransitionEhsIncidentDto, TransitionEhsPermitDto,
} from './ehs.dto';

export interface EhsContext {
  userId:string; tenantId:string; factoryId:string; requestId?:string|null; traceId?:string|null;
}
type Row=QueryResultRow;

@Injectable()
export class EhsService {
  constructor(private readonly database:DatabaseService){}

  async createPermit(c:EhsContext,dto:CreateEhsPermitDto,rawKey:string|null){
    this.assertContext(c);const key=this.idempotencyKey(rawKey);
    const start=this.instant(dto.valid_from,'valid_from'),expires=this.instant(dto.expires_at,'expires_at');
    if(Date.parse(expires)<=Date.parse(start)||Date.parse(expires)-Date.parse(start)>7*24*60*60*1000)
      throw new BadRequestException('Permit expiry must be after start and no more than 7 days later');
    const points=(dto.isolation_points??[]).map(p=>({code:this.requiredText(p.code,'isolation point code',100),
      description:this.requiredText(p.description,'isolation point description',500)}));
    if(new Set(points.map(p=>p.code.toLowerCase())).size!==points.length)
      throw new BadRequestException('Isolation point codes must be unique');
    const requiresIsolation=dto.requires_isolation??(
      ['ELECTRICAL_LOTO','CONFINED_SPACE'].includes(dto.permit_type)||['HIGH','CRITICAL'].includes(dto.risk_level)
    );
    if((['ELECTRICAL_LOTO','CONFINED_SPACE'].includes(dto.permit_type)||['HIGH','CRITICAL'].includes(dto.risk_level))
       &&!requiresIsolation)throw new BadRequestException('High-risk permits must require isolation verification');
    if(requiresIsolation&&points.length===0)throw new BadRequestException('At least one isolation point is required');
    const payload={
      work_order_id:dto.work_order_id?this.uuid(dto.work_order_id,'work_order_id'):null,
      permit_number:this.requiredText(dto.permit_number,'permit_number',100),
      permit_type:dto.permit_type,risk_level:dto.risk_level,title:this.requiredText(dto.title,'title',255),
      work_scope:this.requiredText(dto.work_scope,'work_scope',4000),location:this.requiredText(dto.location,'location',255),
      valid_from:start,expires_at:expires,requires_isolation:requiresIsolation,isolation_points:points,
    };
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-permit:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const existing=await client.query<Row>(
        'SELECT id::text AS id,request_hash FROM ehs_safety_permits WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key]);
      if(existing.rows[0]){this.assertSameRequest(existing.rows[0].request_hash,hash);return {...(await this.permitDetail(client,c,String(existing.rows[0].id))),replayed:true};}
      if(payload.work_order_id){
        const wo=await client.query<Row>('SELECT id FROM work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
          [payload.work_order_id,c.tenantId,c.factoryId]);
        if(!wo.rows[0])throw new NotFoundException('Linked work order was not found in this factory');
      }
      const id=randomUUID();
      await client.query(
        `INSERT INTO ehs_safety_permits(id,tenant_id,factory_id,work_order_id,permit_number,permit_type,risk_level,title,
          work_scope,location,requires_isolation,isolation_points,valid_from,expires_at,requested_by_user_id,updated_by_user_id,
          idempotency_key,request_hash,correlation_id)
         VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz,$14::timestamptz,$15,$15,$16,$17,$18::uuid)`,
        [id,c.tenantId,c.factoryId,payload.work_order_id,payload.permit_number,payload.permit_type,payload.risk_level,
          payload.title,payload.work_scope,payload.location,requiresIsolation,JSON.stringify(points),start,expires,c.userId,key,hash,this.correlationId(c)]);
      return {...(await this.permitDetail(client,c,id)),replayed:false};
    });
  }

  async listPermits(c:EhsContext,q:ListEhsQueryDto){
    this.assertContext(c);const limit=this.limit(q.limit),values:unknown[]=[c.tenantId,c.factoryId];
    const filters=['tenant_id=$1','factory_id=$2'];
    if(q.status){if(!['DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','ACTIVE','CLOSED','CANCELLED','EXPIRED'].includes(q.status))throw new BadRequestException('Invalid permit status');values.push(q.status);filters.push(`status=$${values.length}`);}
    if(q.severity){values.push(q.severity);filters.push(`risk_level=$${values.length}`);}
    values.push(limit);
    const result=await this.database.query<Row>(
      `SELECT id::text,work_order_id::text,permit_number,permit_type,risk_level,title,work_scope,location,status,
        requires_isolation,isolation_points,isolation_verification,isolation_verified_by_user_id::text,isolation_verified_at::text,
        valid_from::text,expires_at::text,requested_by_user_id::text,approved_by_user_id::text,approved_at::text,
        decision_reason,activated_by_user_id::text,activated_at::text,closed_by_user_id::text,closed_at::text,
        closure_evidence,closure_reason,row_version::int,last_change_reason,created_at::text,updated_at::text
       FROM ehs_safety_permits WHERE ${filters.join(' AND ')}
       ORDER BY CASE risk_level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,expires_at LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId});
    return {items:result.rows};
  }

  async transitionPermit(c:EhsContext,id:string,dto:TransitionEhsPermitDto){
    this.assertContext(c);this.uuid(id,'permitId');const reason=this.requiredText(dto.reason,'reason',2000);
    const action=dto.action;
    if(['APPROVE','REJECT'].includes(action)&&!dto.decision_reason?.trim())
      throw new BadRequestException('decision_reason is required for permit approval or rejection');
    if(action==='CLOSE'&&(!dto.closure_evidence||Object.keys(dto.closure_evidence).length===0||!dto.closure_reason?.trim()))
      throw new BadRequestException('Permit close-out needs structured evidence and closure_reason');
    let verification: {code:string;verified:boolean;evidence:string}[]|null=null;
    if(action==='VERIFY_ISOLATION'){
      verification=(dto.isolation_verification??[]).map(v=>({code:this.requiredText(v.code,'isolation code',100),
        verified:v.verified,evidence:this.requiredText(v.evidence,'isolation evidence',2000)}));
      if(!verification.length||verification.some(v=>!v.verified))
        throw new BadRequestException('Every isolation point must be positively verified with evidence');
      if(new Set(verification.map(v=>v.code.toLowerCase())).size!==verification.length)
        throw new BadRequestException('Isolation verification codes must be unique');
    }
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const current=await client.query<Row>(
        'SELECT status,row_version::int,isolation_points FROM ehs_safety_permits WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [id,c.tenantId,c.factoryId]);
      const row=current.rows[0];if(!row)throw new NotFoundException('Safety permit was not found in this factory');
      if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Safety permit version is stale; reload before retrying');
      if(action==='VERIFY_ISOLATION'){
        if(String(row.status)!=='APPROVED')throw new ConflictException('Isolation can only be verified on an approved permit');
        const requiredCodes=(row.isolation_points as {code:string}[]).map(p=>p.code.toLowerCase());
        const supplied=new Set(verification!.map(v=>v.code.toLowerCase()));
        if(requiredCodes.some(code=>!supplied.has(code)))throw new BadRequestException('Verification must cover every declared isolation point');
      }
      const toStatus:Record<string,string>={SUBMIT:'PENDING_APPROVAL',APPROVE:'APPROVED',REJECT:'REJECTED',
        ACTIVATE:'ACTIVE',CLOSE:'CLOSED',CANCEL:'CANCELLED',EXPIRE:'EXPIRED'};
      const next=action==='VERIFY_ISOLATION'?String(row.status):toStatus[action];
      const allowed:Record<string,string[]>={DRAFT:['PENDING_APPROVAL','CANCELLED'],PENDING_APPROVAL:['APPROVED','REJECTED','CANCELLED'],
        APPROVED:['ACTIVE','CANCELLED'],ACTIVE:['CLOSED','EXPIRED']};
      if(action!=='VERIFY_ISOLATION'&&!(allowed[String(row.status)]??[]).includes(next))
        throw new ConflictException(`Invalid permit transition from ${row.status} to ${next}`);
      await client.query(
        `UPDATE ehs_safety_permits SET status=$4,
          approved_by_user_id=CASE WHEN $5 IN ('APPROVED','REJECTED') THEN $6::uuid ELSE approved_by_user_id END,
          approved_at=CASE WHEN $5 IN ('APPROVED','REJECTED') THEN clock_timestamp() ELSE approved_at END,
          decision_reason=CASE WHEN $5 IN ('APPROVED','REJECTED') THEN $7 ELSE decision_reason END,
          isolation_verification=CASE WHEN $8::jsonb IS NOT NULL THEN $8::jsonb ELSE isolation_verification END,
          isolation_verified_by_user_id=CASE WHEN $8::jsonb IS NOT NULL THEN $6::uuid ELSE isolation_verified_by_user_id END,
          isolation_verified_at=CASE WHEN $8::jsonb IS NOT NULL THEN clock_timestamp() ELSE isolation_verified_at END,
          activated_by_user_id=CASE WHEN $5='ACTIVE' THEN $6::uuid ELSE activated_by_user_id END,
          activated_at=CASE WHEN $5='ACTIVE' THEN clock_timestamp() ELSE activated_at END,
          closed_by_user_id=CASE WHEN $5='CLOSED' THEN $6::uuid ELSE closed_by_user_id END,
          closed_at=CASE WHEN $5='CLOSED' THEN clock_timestamp() ELSE closed_at END,
          closure_evidence=CASE WHEN $5='CLOSED' THEN $9::jsonb ELSE closure_evidence END,
          closure_reason=CASE WHEN $5='CLOSED' THEN $10 ELSE closure_reason END,
          last_change_reason=$11,updated_by_user_id=$6,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [id,c.tenantId,c.factoryId,next,c.userId ? next : next,c.userId,dto.decision_reason?.trim()??null,
          verification?JSON.stringify(verification):null,dto.closure_evidence?JSON.stringify(dto.closure_evidence):null,
          dto.closure_reason?.trim()??null,reason]);
      return this.permitDetail(client,c,id);
    });
  }

  async createIncident(c:EhsContext,dto:CreateEhsIncidentDto,rawKey:string|null){
    this.assertContext(c);const key=this.idempotencyKey(rawKey),occurred=this.instant(dto.occurred_at,'occurred_at');
    const due=dto.due_at?this.instant(dto.due_at,'due_at'):null;
    if(due&&Date.parse(due)<Date.parse(occurred))throw new BadRequestException('due_at cannot be before occurred_at');
    const payload={incident_type:dto.incident_type,severity:dto.severity,title:this.requiredText(dto.title,'title',255),
      description:this.requiredText(dto.description,'description',4000),location:this.requiredText(dto.location,'location',255),
      occurred_at:occurred,immediate_action:this.optionalText(dto.immediate_action,2000),
      assigned_owner_user_id:dto.assigned_owner_user_id?this.uuid(dto.assigned_owner_user_id,'assigned_owner_user_id'):null,due_at:due};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-incident:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const existing=await client.query<Row>('SELECT id::text AS id,request_hash FROM ehs_incidents WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(existing.rows[0]){this.assertSameRequest(existing.rows[0].request_hash,hash);return {...(await this.incidentDetail(client,c,String(existing.rows[0].id))),replayed:true};}
      const id=randomUUID(),number=`INC-${occurred.slice(0,10).replace(/-/g,'')}-${id.slice(0,8).toUpperCase()}`;
      await client.query(
        `INSERT INTO ehs_incidents(id,tenant_id,factory_id,incident_number,incident_type,severity,title,description,location,
          occurred_at,immediate_action,assigned_owner_user_id,due_at,created_by_user_id,updated_by_user_id,
          idempotency_key,request_hash,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12::uuid,$13::timestamptz,$14,$14,$15,$16,$17::uuid)`,
        [id,c.tenantId,c.factoryId,number,payload.incident_type,payload.severity,payload.title,payload.description,payload.location,
          occurred,payload.immediate_action,payload.assigned_owner_user_id,due,c.userId,key,hash,this.correlationId(c)]);
      return {...(await this.incidentDetail(client,c,id)),replayed:false};
    });
  }

  async listIncidents(c:EhsContext,q:ListEhsQueryDto){
    this.assertContext(c);const limit=this.limit(q.limit),values:unknown[]=[c.tenantId,c.factoryId],filters=['tenant_id=$1','factory_id=$2'];
    if(q.status){if(!['OPEN','INVESTIGATING','ACTION_REQUIRED','RESOLVED','CLOSED','CANCELLED'].includes(q.status))throw new BadRequestException('Invalid incident status');values.push(q.status);filters.push(`status=$${values.length}`);}
    if(q.severity){values.push(q.severity);filters.push(`severity=$${values.length}`);}
    values.push(limit);
    const r=await this.database.query<Row>(
      `SELECT id::text,incident_number,incident_type,severity,status,title,description,location,occurred_at::text,
        immediate_action,assigned_owner_user_id::text,due_at::text,investigation_summary,root_cause,closure_evidence,
        closed_by_user_id::text,closed_at::text,row_version::int,last_change_reason,created_by_user_id::text,
        created_at::text,updated_at::text FROM ehs_incidents WHERE ${filters.join(' AND ')}
       ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,occurred_at DESC LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async transitionIncident(c:EhsContext,id:string,dto:TransitionEhsIncidentDto){
    this.assertContext(c);this.uuid(id,'incidentId');const reason=this.requiredText(dto.reason,'reason',2000);
    if(['RESOLVE','CLOSE'].includes(dto.action)&&(!dto.root_cause?.trim()||!dto.closure_evidence||!Object.keys(dto.closure_evidence).length))
      throw new BadRequestException('Resolution/closure requires root cause and structured evidence');
    const toStatus:Record<string,string>={START_INVESTIGATION:'INVESTIGATING',REQUIRE_ACTION:'ACTION_REQUIRED',RESOLVE:'RESOLVED',CLOSE:'CLOSED',REOPEN:'INVESTIGATING',CANCEL:'CANCELLED'};
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const cr=await client.query<Row>('SELECT status,row_version::int FROM ehs_incidents WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[id,c.tenantId,c.factoryId]);
      if(!cr.rows[0])throw new NotFoundException('Safety incident was not found in this factory');
      const row=cr.rows[0];if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Incident version is stale; reload before retrying');
      const next=toStatus[dto.action];const allowed:Record<string,string[]>={OPEN:['INVESTIGATING','CANCELLED'],INVESTIGATING:['ACTION_REQUIRED','RESOLVED','CANCELLED'],
        ACTION_REQUIRED:['INVESTIGATING','RESOLVED','CANCELLED'],RESOLVED:['CLOSED','INVESTIGATING']};
      if(!(allowed[String(row.status)]??[]).includes(next))throw new ConflictException(`Invalid incident transition from ${row.status} to ${next}`);
      await client.query(
        `UPDATE ehs_incidents SET status=$4,investigation_summary=COALESCE($5,investigation_summary),
          root_cause=COALESCE($6,root_cause),closure_evidence=COALESCE($7::jsonb,closure_evidence),
          closed_by_user_id=CASE WHEN $4='CLOSED' THEN $8::uuid ELSE NULL END,
          closed_at=CASE WHEN $4='CLOSED' THEN clock_timestamp() ELSE NULL END,
          last_change_reason=$9,updated_by_user_id=$8,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [id,c.tenantId,c.factoryId,next,dto.investigation_summary?.trim()??null,dto.root_cause?.trim()??null,
          dto.closure_evidence?JSON.stringify(dto.closure_evidence):null,c.userId,reason]);
      return this.incidentDetail(client,c,id);
    });
  }

  async createCorrectiveAction(c:EhsContext,dto:CreateEhsCorrectiveActionDto,rawKey:string|null){
    this.assertContext(c);const key=this.idempotencyKey(rawKey),incidentId=this.uuid(dto.incident_id,'incident_id');
    const payload={incident_id:incidentId,action_number:this.requiredText(dto.action_number,'action_number',100),
      description:this.requiredText(dto.description,'description',4000),
      assigned_owner_user_id:this.uuid(dto.assigned_owner_user_id,'assigned_owner_user_id'),due_at:this.instant(dto.due_at,'due_at')};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-action:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const existing=await client.query<Row>('SELECT id::text AS id,request_hash FROM ehs_corrective_actions WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(existing.rows[0]){this.assertSameRequest(existing.rows[0].request_hash,hash);return {...(await this.actionDetail(client,c,String(existing.rows[0].id))),replayed:true};}
      const incident=await client.query<Row>('SELECT occurred_at::text FROM ehs_incidents WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[incidentId,c.tenantId,c.factoryId]);
      if(!incident.rows[0])throw new NotFoundException('Safety incident was not found in this factory');
      const id=randomUUID();
      await client.query(
        `INSERT INTO ehs_corrective_actions(id,tenant_id,factory_id,incident_id,action_number,description,assigned_owner_user_id,due_at,
          idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$11,$12::uuid)`,
        [id,c.tenantId,c.factoryId,incidentId,payload.action_number,payload.description,payload.assigned_owner_user_id,payload.due_at,
          key,hash,c.userId,this.correlationId(c)]);
      return {...(await this.actionDetail(client,c,id)),replayed:false};
    });
  }

  async listCorrectiveActions(c:EhsContext,incidentId:string,limitRaw?:number){
    this.assertContext(c);this.uuid(incidentId,'incidentId');const limit=this.limit(limitRaw);
    const r=await this.database.query<Row>(
      `SELECT id::text,incident_id::text,action_number,description,assigned_owner_user_id::text,due_at::text,status,
        root_cause,completion_evidence,verification_evidence,submitted_by_user_id::text,submitted_at::text,
        verified_by_user_id::text,verified_at::text,row_version::int,last_change_reason,created_by_user_id::text,created_at::text,updated_at::text
       FROM ehs_corrective_actions WHERE tenant_id=$1 AND factory_id=$2 AND incident_id=$3
       ORDER BY due_at,action_number LIMIT $4`,
      [c.tenantId,c.factoryId,incidentId,limit],{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async transitionCorrectiveAction(c:EhsContext,id:string,dto:TransitionEhsCorrectiveActionDto){
    this.assertContext(c);this.uuid(id,'actionId');const reason=this.requiredText(dto.reason,'reason',2000);
    if(dto.action==='SUBMIT_FOR_VERIFICATION'&&(!dto.root_cause?.trim()||!dto.completion_evidence||!Object.keys(dto.completion_evidence).length))
      throw new BadRequestException('Corrective-action submission requires root cause and completion evidence');
    if(dto.action==='VERIFY'&&(!dto.verification_evidence||!Object.keys(dto.verification_evidence).length))
      throw new BadRequestException('Independent verification requires structured evidence');
    const toStatus:Record<string,string>={START:'IN_PROGRESS',SUBMIT_FOR_VERIFICATION:'READY_FOR_VERIFICATION',VERIFY:'VERIFIED',REOPEN:'IN_PROGRESS',CANCEL:'CANCELLED'};
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const r=await client.query<Row>('SELECT status,row_version::int FROM ehs_corrective_actions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[id,c.tenantId,c.factoryId]);
      if(!r.rows[0])throw new NotFoundException('Corrective action was not found in this factory');
      const row=r.rows[0];if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Corrective-action version is stale; reload before retrying');
      const next=toStatus[dto.action];const allowed:Record<string,string[]>={OPEN:['IN_PROGRESS','CANCELLED'],IN_PROGRESS:['READY_FOR_VERIFICATION','CANCELLED'],READY_FOR_VERIFICATION:['VERIFIED','IN_PROGRESS']};
      if(!(allowed[String(row.status)]??[]).includes(next))throw new ConflictException(`Invalid corrective-action transition from ${row.status} to ${next}`);
      await client.query(
        `UPDATE ehs_corrective_actions SET status=$4,root_cause=COALESCE($5,root_cause),
          completion_evidence=COALESCE($6::jsonb,completion_evidence),
          submitted_by_user_id=CASE WHEN $4='READY_FOR_VERIFICATION' THEN $7::uuid ELSE submitted_by_user_id END,
          submitted_at=CASE WHEN $4='READY_FOR_VERIFICATION' THEN clock_timestamp() ELSE submitted_at END,
          verified_by_user_id=CASE WHEN $4='VERIFIED' THEN $7::uuid ELSE NULL END,
          verified_at=CASE WHEN $4='VERIFIED' THEN clock_timestamp() ELSE NULL END,
          verification_evidence=CASE WHEN $4='VERIFIED' THEN $8::jsonb ELSE verification_evidence END,
          last_change_reason=$9,updated_by_user_id=$7,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [id,c.tenantId,c.factoryId,next,dto.root_cause?.trim()??null,
          dto.completion_evidence?JSON.stringify(dto.completion_evidence):null,c.userId,
          dto.verification_evidence?JSON.stringify(dto.verification_evidence):null,reason]);
      return this.actionDetail(client,c,id);
    });
  }

  private async permitDetail(client:PoolClient,c:EhsContext,id:string){
    const r=await client.query<Row>(
      `SELECT id::text,work_order_id::text,permit_number,permit_type,risk_level,title,work_scope,location,status,
        requires_isolation,isolation_points,isolation_verification,isolation_verified_by_user_id::text,isolation_verified_at::text,
        valid_from::text,expires_at::text,requested_by_user_id::text,updated_by_user_id::text,
        approved_by_user_id::text,approved_at::text,decision_reason,activated_by_user_id::text,activated_at::text,
        closed_by_user_id::text,closed_at::text,closure_evidence,closure_reason,row_version::int,last_change_reason,
        created_at::text,updated_at::text FROM ehs_safety_permits WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Safety permit was not found');return r.rows[0];
  }
  private async incidentDetail(client:PoolClient,c:EhsContext,id:string){
    const r=await client.query<Row>(
      `SELECT id::text,incident_number,incident_type,severity,status,title,description,location,occurred_at::text,
        immediate_action,assigned_owner_user_id::text,due_at::text,investigation_summary,root_cause,closure_evidence,
        closed_by_user_id::text,closed_at::text,row_version::int,last_change_reason,created_by_user_id::text,updated_by_user_id::text,
        created_at::text,updated_at::text FROM ehs_incidents WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Safety incident was not found');return r.rows[0];
  }
  private async actionDetail(client:PoolClient,c:EhsContext,id:string){
    const r=await client.query<Row>(
      `SELECT id::text,incident_id::text,action_number,description,assigned_owner_user_id::text,due_at::text,status,
        root_cause,completion_evidence,verification_evidence,submitted_by_user_id::text,submitted_at::text,
        verified_by_user_id::text,verified_at::text,row_version::int,last_change_reason,created_by_user_id::text,updated_by_user_id::text,
        created_at::text,updated_at::text FROM ehs_corrective_actions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0])throw new NotFoundException('Corrective action was not found');return r.rows[0];
  }
  private assertContext(c:EhsContext){for(const [field,value] of Object.entries({userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId}))if(!isUUID(value))throw new BadRequestException(`${field} must be a valid UUID`);}
  private uuid(v:string,label:string){if(!isUUID(v))throw new BadRequestException(`${label} must be a valid UUID`);return v.toLowerCase();}
  private idempotencyKey(v:string|null){if(!v?.trim()||v.trim().length>255)throw new BadRequestException('A non-empty Idempotency-Key of at most 255 characters is required');return v.trim();}
  private requiredText(v:string,label:string,max:number){const x=v?.trim();if(!x||x.length>max)throw new BadRequestException(`${label} is required and must be at most ${max} characters`);return x;}
  private optionalText(v:string|undefined,max:number){const x=v?.trim();if(!x)return null;if(x.length>max)throw new BadRequestException(`Text cannot exceed ${max} characters`);return x;}
  private instant(v:string,label:string){if(!v||!Number.isFinite(Date.parse(v)))throw new BadRequestException(`${label} must be a valid timestamp`);return new Date(v).toISOString();}
  private hash(v:unknown){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
  private assertSameRequest(a:string,b:string){if(a!==b)throw new ConflictException('Idempotency-Key was already used with a different payload');}
  private limit(v?:number){const n=v??50;if(!Number.isInteger(n)||n<1||n>200)throw new BadRequestException('limit must be an integer between 1 and 200');return n;}
  private correlationId(c:EhsContext){return c.traceId&&isUUID(c.traceId)?c.traceId:c.requestId&&isUUID(c.requestId)?c.requestId:randomUUID();}
}
