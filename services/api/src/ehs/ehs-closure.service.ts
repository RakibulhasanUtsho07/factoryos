import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { EhsContext } from './ehs.service';
import type {
  CreateEhsChemicalSdsDto, CreateEhsContractorInductionDto, CreateEhsEmergencyDrillDto,
  RecordEhsDrillAttendanceDto, RecordEhsDrillResponseDto, TransitionEhsChemicalSdsDto,
  TransitionEhsContractorInductionDto, TransitionEhsEmergencyDrillDto,
} from './ehs-closure.dto';

type Row=QueryResultRow;

@Injectable()
export class EhsClosureService {
  constructor(private readonly database:DatabaseService){}

  async createDrill(c:EhsContext,dto:CreateEhsEmergencyDrillDto,rawKey:string|null){
    this.scope(c);const key=this.key(rawKey);
    const payload={
      drill_number:this.text(dto.drill_number,'drill_number',100),drill_type:dto.drill_type,
      title:this.text(dto.title,'title',255),location:this.text(dto.location,'location',255),
      planned_at:this.instant(dto.planned_at,'planned_at'),owner_user_id:this.uuid(dto.owner_user_id,'owner_user_id'),
    };
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-drill:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const prior=await client.query<Row>('SELECT id::text AS id,request_hash FROM ehs_emergency_drills WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(prior.rows[0]){this.same(prior.rows[0].request_hash,hash);return {...(await this.drillDetail(client,c,String(prior.rows[0].id))),replayed:true};}
      const owner=await client.query<Row>(
        `SELECT u.id FROM users u
         JOIN tenant_memberships tm ON tm.user_id=u.id AND tm.tenant_id=$2 AND tm.status='ACTIVE'
         JOIN tenants t ON t.id=tm.tenant_id AND t.status='ACTIVE'
         WHERE u.id=$1 AND u.status='ACTIVE'`,
        [payload.owner_user_id,c.tenantId]);
      if(!owner.rows[0])throw new NotFoundException('Emergency drill owner must be an active member of this tenant');
      const r=await client.query<Row>(
        `INSERT INTO ehs_emergency_drills(tenant_id,factory_id,drill_number,drill_type,title,location,planned_at,
          owner_user_id,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::uuid,$9,$10,$11,$11,$12::uuid) RETURNING id::text AS id`,
        [c.tenantId,c.factoryId,payload.drill_number,payload.drill_type,payload.title,payload.location,payload.planned_at,
          payload.owner_user_id,key,hash,c.userId,this.correlation(c)]);
      return {...(await this.drillDetail(client,c,String(r.rows[0].id))),replayed:false};
    });
  }

  async listDrills(c:EhsContext,limitRaw?:number,status?:string){
    this.scope(c);const limit=this.limit(limitRaw,100),values:unknown[]=[c.tenantId,c.factoryId],filters=['d.tenant_id=$1','d.factory_id=$2'];
    if(status){if(!['PLANNED','IN_PROGRESS','COMPLETED','CANCELLED'].includes(status))throw new BadRequestException('Invalid emergency drill status');values.push(status);filters.push(`d.status=$${values.length}`);}
    values.push(limit);
    const r=await this.database.query<Row>(
      `SELECT d.id::text AS id,d.drill_number,d.drill_type,d.title,d.location,d.planned_at::text AS planned_at,
        d.owner_user_id::text AS owner_user_id,d.status,d.started_at::text AS started_at,d.completed_at::text AS completed_at,
        d.outcome_summary,d.close_evidence,d.row_version::int AS row_version,d.last_change_reason,
        (SELECT count(*)::int FROM ehs_drill_attendance a WHERE a.drill_id=d.id AND a.tenant_id=d.tenant_id AND a.factory_id=d.factory_id) AS attendance_count,
        (SELECT count(*)::int FROM ehs_drill_attendance a WHERE a.drill_id=d.id AND a.tenant_id=d.tenant_id AND a.factory_id=d.factory_id AND a.attendance_status='PRESENT') AS present_count,
        (SELECT count(*)::int FROM ehs_drill_responses r WHERE r.drill_id=d.id AND r.tenant_id=d.tenant_id AND r.factory_id=d.factory_id) AS response_count,
        d.created_at::text AS created_at,d.updated_at::text AS updated_at
       FROM ehs_emergency_drills d WHERE ${filters.join(' AND ')}
       ORDER BY CASE d.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'PLANNED' THEN 1 ELSE 2 END,d.planned_at DESC LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async transitionDrill(c:EhsContext,id:string,dto:TransitionEhsEmergencyDrillDto){
    this.scope(c);this.uuid(id,'drillId');const reason=this.text(dto.reason,'reason',2000);
    const summary=dto.action==='COMPLETE'?this.text(dto.outcome_summary,'outcome_summary',4000):null;
    const evidence=dto.action==='COMPLETE'?this.object(dto.close_evidence,'close_evidence'):null;
    if(dto.action==='COMPLETE'&&Object.keys(evidence??{}).length===0)throw new BadRequestException('Completed drill requires close_evidence');
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const q=await client.query<Row>('SELECT status,row_version::int AS row_version FROM ehs_emergency_drills WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[id,c.tenantId,c.factoryId]);
      const d=q.rows[0];if(!d)throw new NotFoundException('Emergency drill was not found in this factory');
      if(Number(d.row_version)!==dto.expected_version)throw new ConflictException('Emergency drill version is stale');
      const from=String(d.status),to=dto.action==='START'?'IN_PROGRESS':dto.action==='COMPLETE'?'COMPLETED':'CANCELLED';
      const allowed:Record<string,string[]>={PLANNED:['IN_PROGRESS','CANCELLED'],IN_PROGRESS:['COMPLETED','CANCELLED']};
      if(!(allowed[from]??[]).includes(to))throw new ConflictException(`Invalid emergency-drill transition ${from} -> ${to}`);
      if(dto.action==='COMPLETE'){
        const evidenceCounts=await client.query<Row>(
          `SELECT EXISTS(SELECT 1 FROM ehs_drill_attendance WHERE drill_id=$1 AND tenant_id=$2 AND factory_id=$3 AND attendance_status='PRESENT') AS has_present,
            EXISTS(SELECT 1 FROM ehs_drill_responses WHERE drill_id=$1 AND tenant_id=$2 AND factory_id=$3) AS has_response`,
          [id,c.tenantId,c.factoryId]);
        if(!evidenceCounts.rows[0]?.has_present||!evidenceCounts.rows[0]?.has_response)
          throw new ConflictException('Record at least one present attendee and one response/action before drill completion');
      }
      await client.query(
        `UPDATE ehs_emergency_drills SET status=$4,started_at=CASE WHEN $4='IN_PROGRESS' THEN clock_timestamp() ELSE started_at END,
          completed_at=CASE WHEN $4='COMPLETED' THEN clock_timestamp() ELSE NULL END,
          outcome_summary=CASE WHEN $4='COMPLETED' THEN $5 ELSE outcome_summary END,
          close_evidence=CASE WHEN $4='COMPLETED' THEN $6::jsonb ELSE close_evidence END,
          last_change_reason=$7,row_version=row_version+1,updated_by_user_id=$8,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$9`,
        [id,c.tenantId,c.factoryId,to,summary,evidence?JSON.stringify(evidence):null,reason,c.userId,dto.expected_version]);
      return this.drillDetail(client,c,id);
    });
  }

  async recordDrillAttendance(c:EhsContext,drillId:string,dto:RecordEhsDrillAttendanceDto,rawKey:string|null){
    this.scope(c);this.uuid(drillId,'drillId');const key=this.key(rawKey);
    const payload={drill_id:drillId,attendee_ref:this.text(dto.attendee_ref,'attendee_ref',160),
      attendee_name:this.text(dto.attendee_name,'attendee_name',255),user_id:dto.user_id?this.uuid(dto.user_id,'user_id'):null,
      attendance_status:dto.attendance_status,notes:this.optionalText(dto.notes,2000),evidence:this.object(dto.evidence,'evidence')};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-attendance:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const replay=await client.query<Row>('SELECT id::text AS id,request_hash FROM ehs_drill_attendance WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(replay.rows[0]){this.same(replay.rows[0].request_hash,hash);return {...(await this.attendanceDetail(client,c,String(replay.rows[0].id))),replayed:true};}
      const drill=await client.query<Row>('SELECT status FROM ehs_emergency_drills WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[drillId,c.tenantId,c.factoryId]);
      if(!drill.rows[0])throw new NotFoundException('Emergency drill was not found in this factory');
      if(drill.rows[0].status!=='IN_PROGRESS')throw new ConflictException('Attendance can only be recorded during an in-progress drill');
      const ref=await client.query<Row>('SELECT id FROM ehs_drill_attendance WHERE tenant_id=$1 AND factory_id=$2 AND drill_id=$3 AND attendee_ref=$4',[c.tenantId,c.factoryId,drillId,payload.attendee_ref]);
      if(ref.rows[0])throw new ConflictException('This attendee already has a recorded attendance result for the drill');
      if(payload.user_id){
        const user=await client.query<Row>(
          `SELECT u.id FROM users u
           JOIN tenant_memberships tm ON tm.user_id=u.id AND tm.tenant_id=$2 AND tm.status='ACTIVE'
           JOIN tenants t ON t.id=tm.tenant_id AND t.status='ACTIVE'
           WHERE u.id=$1 AND u.status='ACTIVE'`,
          [payload.user_id,c.tenantId]);
        if(!user.rows[0])throw new NotFoundException('Attendee must be an active member of this tenant');
      }
      const inserted=await client.query<Row>(
        `INSERT INTO ehs_drill_attendance(tenant_id,factory_id,drill_id,attendee_ref,attendee_name,user_id,attendance_status,
          notes,evidence,idempotency_key,request_hash,recorded_by_user_id,correlation_id)
         VALUES($1,$2,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::jsonb,$10,$11,$12,$13::uuid) RETURNING id::text AS id`,
        [c.tenantId,c.factoryId,drillId,payload.attendee_ref,payload.attendee_name,payload.user_id,payload.attendance_status,
          payload.notes,JSON.stringify(payload.evidence),key,hash,c.userId,this.correlation(c)]);
      return {...(await this.attendanceDetail(client,c,String(inserted.rows[0].id))),replayed:false};
    });
  }

  async recordDrillResponse(c:EhsContext,drillId:string,dto:RecordEhsDrillResponseDto,rawKey:string|null){
    this.scope(c);this.uuid(drillId,'drillId');const key=this.key(rawKey);
    const occurred=this.instant(dto.occurred_at,'occurred_at'),evidence=this.object(dto.evidence,'evidence');
    if(Object.keys(evidence).length===0)throw new BadRequestException('Response evidence cannot be empty');
    const payload={drill_id:drillId,response_code:this.text(dto.response_code,'response_code',100),
      response_action:this.text(dto.response_action,'response_action',4000),
      responder_user_id:dto.responder_user_id?this.uuid(dto.responder_user_id,'responder_user_id'):null,
      elapsed_seconds:dto.elapsed_seconds??null,occurred_at:occurred,evidence};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-response:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const replay=await client.query<Row>('SELECT id::text AS id,request_hash FROM ehs_drill_responses WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(replay.rows[0]){this.same(replay.rows[0].request_hash,hash);return {...(await this.responseDetail(client,c,String(replay.rows[0].id))),replayed:true};}
      const drill=await client.query<Row>('SELECT status,started_at::text AS started_at FROM ehs_emergency_drills WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[drillId,c.tenantId,c.factoryId]);
      if(!drill.rows[0])throw new NotFoundException('Emergency drill was not found in this factory');
      if(drill.rows[0].status!=='IN_PROGRESS')throw new ConflictException('Response evidence can only be added during an in-progress drill');
      const startedAt=Date.parse(String(drill.rows[0].started_at));
      if(!Number.isFinite(startedAt)||Date.parse(payload.occurred_at)<startedAt||Date.parse(payload.occurred_at)>Date.now())
        throw new BadRequestException('Response timestamp must be between the drill start time and current time');
      if(payload.responder_user_id){
        const user=await client.query<Row>(
          `SELECT u.id FROM users u
           JOIN tenant_memberships tm ON tm.user_id=u.id AND tm.tenant_id=$2 AND tm.status='ACTIVE'
           JOIN tenants t ON t.id=tm.tenant_id AND t.status='ACTIVE'
           WHERE u.id=$1 AND u.status='ACTIVE'`,
          [payload.responder_user_id,c.tenantId]);
        if(!user.rows[0])throw new NotFoundException('Responder must be an active member of this tenant');
      }
      const inserted=await client.query<Row>(
        `INSERT INTO ehs_drill_responses(tenant_id,factory_id,drill_id,response_code,response_action,responder_user_id,
          elapsed_seconds,occurred_at,evidence,idempotency_key,request_hash,recorded_by_user_id,correlation_id)
         VALUES($1,$2,$3::uuid,$4,$5,$6::uuid,$7,$8::timestamptz,$9::jsonb,$10,$11,$12,$13::uuid) RETURNING id::text AS id`,
        [c.tenantId,c.factoryId,drillId,payload.response_code,payload.response_action,payload.responder_user_id,
          payload.elapsed_seconds,payload.occurred_at,JSON.stringify(evidence),key,hash,c.userId,this.correlation(c)]);
      return {...(await this.responseDetail(client,c,String(inserted.rows[0].id))),replayed:false};
    });
  }

  async listDrillAttendance(c:EhsContext,drillId:string,limitRaw?:number){
    this.scope(c);this.uuid(drillId,'drillId');const limit=this.limit(limitRaw,200);
    const q=await this.database.query<Row>(
      `SELECT id::text AS id,drill_id::text AS drill_id,attendee_ref,attendee_name,user_id::text AS user_id,
        attendance_status,recorded_at::text AS recorded_at,notes,evidence,recorded_by_user_id::text AS recorded_by_user_id
       FROM ehs_drill_attendance WHERE tenant_id=$1 AND factory_id=$2 AND drill_id=$3
       ORDER BY recorded_at,id LIMIT $4`,
      [c.tenantId,c.factoryId,drillId,limit],{tenantId:c.tenantId,userId:c.userId});
    return {items:q.rows};
  }

  async listDrillResponses(c:EhsContext,drillId:string,limitRaw?:number){
    this.scope(c);this.uuid(drillId,'drillId');const limit=this.limit(limitRaw,200);
    const q=await this.database.query<Row>(
      `SELECT id::text AS id,drill_id::text AS drill_id,response_code,response_action,
        responder_user_id::text AS responder_user_id,elapsed_seconds,occurred_at::text AS occurred_at,evidence,
        recorded_by_user_id::text AS recorded_by_user_id,created_at::text AS created_at
       FROM ehs_drill_responses WHERE tenant_id=$1 AND factory_id=$2 AND drill_id=$3
       ORDER BY occurred_at,id LIMIT $4`,
      [c.tenantId,c.factoryId,drillId,limit],{tenantId:c.tenantId,userId:c.userId});
    return {items:q.rows};
  }

  async listChemicalSds(c:EhsContext,limitRaw?:number,status?:string){
    this.scope(c);const limit=this.limit(limitRaw,100),values:unknown[]=[c.tenantId,c.factoryId],filters=['tenant_id=$1','factory_id=$2'];
    if(status){if(!['DRAFT','ACTIVE','INACTIVE','RETIRED'].includes(status))throw new BadRequestException('Invalid chemical/SDS status');values.push(status);filters.push(`status=$${values.length}`);}
    values.push(limit);
    const r=await this.database.query<Row>(
      `SELECT id::text AS id,chemical_code,chemical_name,manufacturer,hazard_class,storage_location,sds_revision,sds_document_uri,
        sds_issued_at::text AS sds_issued_at,sds_review_due_at::text AS sds_review_due_at,status,
        approved_by_user_id::text AS approved_by_user_id,approved_at::text AS approved_at,handling_instructions,
        emergency_instructions,row_version::int AS row_version,last_change_reason,created_by_user_id::text AS created_by_user_id,
        updated_by_user_id::text AS updated_by_user_id,created_at::text AS created_at,updated_at::text AS updated_at
       FROM ehs_chemical_sds_registry WHERE ${filters.join(' AND ')}
       ORDER BY CASE WHEN status='ACTIVE' AND sds_review_due_at>=clock_timestamp() THEN 0 ELSE 1 END,chemical_code,sds_revision DESC LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async createChemicalSds(c:EhsContext,dto:CreateEhsChemicalSdsDto,rawKey:string|null){
    this.scope(c);const key=this.key(rawKey);
    const issued=this.instant(dto.sds_issued_at,'sds_issued_at'),review=this.instant(dto.sds_review_due_at,'sds_review_due_at');
    if(Date.parse(review)<Date.parse(issued))throw new BadRequestException('SDS review due date cannot precede its issue date');
    if(Date.parse(issued)>Date.now())throw new BadRequestException('SDS issue date cannot be in the future');
    let sdsUrl:URL;
    try{sdsUrl=new URL(dto.sds_document_uri.trim());}
    catch{throw new BadRequestException('sds_document_uri must be a valid controlled document reference');}
    if(!['https:','s3:','gs:'].includes(sdsUrl.protocol)||sdsUrl.username||sdsUrl.password||
      !sdsUrl.hostname||/\s/.test(dto.sds_document_uri.trim()))
      throw new BadRequestException('sds_document_uri must be a credential-free https://, s3:// or gs:// document reference');
    const payload={chemical_code:this.text(dto.chemical_code,'chemical_code',100).toUpperCase(),
      chemical_name:this.text(dto.chemical_name,'chemical_name',255),manufacturer:this.optionalText(dto.manufacturer,255),
      hazard_class:this.text(dto.hazard_class,'hazard_class',100),storage_location:this.text(dto.storage_location,'storage_location',255),
      sds_revision:this.text(dto.sds_revision,'sds_revision',100),sds_document_uri:dto.sds_document_uri.trim(),
      sds_issued_at:issued,sds_review_due_at:review,handling_instructions:this.text(dto.handling_instructions,'handling_instructions',4000),
      emergency_instructions:this.text(dto.emergency_instructions,'emergency_instructions',4000)};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-chemical-sds:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const prior=await client.query<Row>('SELECT id::text AS id,request_hash FROM ehs_chemical_sds_registry WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(prior.rows[0]){this.same(prior.rows[0].request_hash,hash);return {...(await this.chemicalDetail(client,c,String(prior.rows[0].id))),replayed:true};}
      const inserted=await client.query<Row>(
        `INSERT INTO ehs_chemical_sds_registry(tenant_id,factory_id,chemical_code,chemical_name,manufacturer,hazard_class,
          storage_location,sds_revision,sds_document_uri,sds_issued_at,sds_review_due_at,handling_instructions,
          emergency_instructions,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15,$16,$16,$17::uuid)
         RETURNING id::text AS id`,
        [c.tenantId,c.factoryId,payload.chemical_code,payload.chemical_name,payload.manufacturer,payload.hazard_class,
          payload.storage_location,payload.sds_revision,payload.sds_document_uri,payload.sds_issued_at,payload.sds_review_due_at,
          payload.handling_instructions,payload.emergency_instructions,key,hash,c.userId,this.correlation(c)]);
      return {...(await this.chemicalDetail(client,c,String(inserted.rows[0].id))),replayed:false};
    });
  }

  async transitionChemicalSds(c:EhsContext,id:string,dto:TransitionEhsChemicalSdsDto){
    this.scope(c);this.uuid(id,'chemicalId');const reason=this.text(dto.reason,'reason',2000);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const q=await client.query<Row>('SELECT status,row_version::int AS row_version,created_by_user_id::text AS created_by_user_id FROM ehs_chemical_sds_registry WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[id,c.tenantId,c.factoryId]);
      const row=q.rows[0];if(!row)throw new NotFoundException('Chemical/SDS record was not found in this factory');
      if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Chemical/SDS version is stale');
      const from=String(row.status),next=dto.action==='ACTIVATE'?'ACTIVE':dto.action==='DEACTIVATE'?'INACTIVE':'RETIRED';
      const allowed:Record<string,string[]>={DRAFT:['ACTIVE','RETIRED'],ACTIVE:['INACTIVE','RETIRED'],INACTIVE:['ACTIVE','RETIRED']};
      if(!(allowed[from]??[]).includes(next))throw new ConflictException(`Invalid chemical/SDS transition ${from} -> ${next}`);
      if(dto.action==='ACTIVATE'){
        if(String(row.created_by_user_id)===c.userId)throw new ConflictException('SDS activation requires an independent approver');
        const due=await client.query<Row>('SELECT sds_review_due_at>=clock_timestamp() AS current FROM ehs_chemical_sds_registry WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',[id,c.tenantId,c.factoryId]);
        if(!due.rows[0]?.current)throw new ConflictException('An expired SDS review cannot be activated');
      }
      await client.query(
        `UPDATE ehs_chemical_sds_registry SET status=$4,row_version=row_version+1,last_change_reason=$5,
          approved_by_user_id=CASE WHEN $4='ACTIVE' THEN $6::uuid ELSE NULL END,
          approved_at=CASE WHEN $4='ACTIVE' THEN clock_timestamp() ELSE NULL END,
          updated_by_user_id=$6,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$7`,
        [id,c.tenantId,c.factoryId,next,reason,c.userId,dto.expected_version]);
      return this.chemicalDetail(client,c,id);
    });
  }

  async listContractorInductions(c:EhsContext,limitRaw?:number,status?:string){
    this.scope(c);const limit=this.limit(limitRaw,100),values:unknown[]=[c.tenantId,c.factoryId],filters=['tenant_id=$1','factory_id=$2'];
    if(status){if(!['ACTIVE','EXPIRED','REVOKED'].includes(status))throw new BadRequestException('Invalid contractor induction status');values.push(status);filters.push(`status=$${values.length}`);}
    values.push(limit);
    const r=await this.database.query<Row>(
      `SELECT id::text AS id,contractor_code,company_name,person_name,induction_at::text AS induction_at,
        expires_at::text AS expires_at,topics,evidence,status,row_version::int AS row_version,last_change_reason,
        recorded_by_user_id::text AS recorded_by_user_id,created_at::text AS created_at,updated_at::text AS updated_at
       FROM ehs_contractor_inductions WHERE ${filters.join(' AND ')}
       ORDER BY CASE WHEN status='ACTIVE' AND expires_at>=clock_timestamp() THEN 0 ELSE 1 END,expires_at DESC LIMIT $${values.length}`,
      values,{tenantId:c.tenantId,userId:c.userId});
    return {items:r.rows};
  }

  async createContractorInduction(c:EhsContext,dto:CreateEhsContractorInductionDto,rawKey:string|null){
    this.scope(c);const key=this.key(rawKey),induction=this.instant(dto.induction_at,'induction_at'),expires=this.instant(dto.expires_at,'expires_at');
    if(Date.parse(expires)<=Date.parse(induction))throw new BadRequestException('Induction expiry must be after the induction timestamp');
    if(Date.parse(induction)>Date.now())throw new BadRequestException('A future induction cannot be recorded as completed training');
    if(Date.parse(expires)<=Date.now())throw new BadRequestException('Expired induction cannot be registered as active');
    const topics=[...new Set(dto.topics.map(t=>this.text(t,'topic',160)))];
    if(!topics.length)throw new BadRequestException('At least one induction topic is required');
    const evidence=this.object(dto.evidence,'evidence');if(Object.keys(evidence).length===0)throw new BadRequestException('Contractor induction requires evidence');
    const payload={contractor_code:this.text(dto.contractor_code,'contractor_code',100).toUpperCase(),
      company_name:this.text(dto.company_name,'company_name',255),person_name:this.text(dto.person_name,'person_name',255),
      induction_at:induction,expires_at:expires,topics,evidence};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId,
      advisoryLockKey:`ehs-contractor-induction:${c.tenantId}:${c.factoryId}:${key}`},async client=>{
      const prior=await client.query<Row>('SELECT id::text AS id,request_hash FROM ehs_contractor_inductions WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',[c.tenantId,c.factoryId,key]);
      if(prior.rows[0]){this.same(prior.rows[0].request_hash,hash);return {...(await this.contractorDetail(client,c,String(prior.rows[0].id))),replayed:true};}
      const inserted=await client.query<Row>(
        `INSERT INTO ehs_contractor_inductions(tenant_id,factory_id,contractor_code,company_name,person_name,induction_at,
          expires_at,topics,evidence,idempotency_key,request_hash,recorded_by_user_id,updated_by_user_id,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::jsonb,$9::jsonb,$10,$11,$12,$12,$13::uuid)
         RETURNING id::text AS id`,
        [c.tenantId,c.factoryId,payload.contractor_code,payload.company_name,payload.person_name,payload.induction_at,payload.expires_at,
          JSON.stringify(payload.topics),JSON.stringify(payload.evidence),key,hash,c.userId,this.correlation(c)]);
      return {...(await this.contractorDetail(client,c,String(inserted.rows[0].id))),replayed:false};
    });
  }

  async transitionContractorInduction(c:EhsContext,id:string,dto:TransitionEhsContractorInductionDto){
    this.scope(c);this.uuid(id,'inductionId');const reason=this.text(dto.reason,'reason',2000);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId,requestId:c.requestId,traceId:c.traceId},async client=>{
      const q=await client.query<Row>('SELECT status,row_version::int AS row_version,expires_at<=clock_timestamp() AS expired FROM ehs_contractor_inductions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[id,c.tenantId,c.factoryId]);
      const row=q.rows[0];if(!row)throw new NotFoundException('Contractor induction was not found in this factory');
      if(Number(row.row_version)!==dto.expected_version)throw new ConflictException('Contractor induction version is stale');
      if(row.status!=='ACTIVE')throw new ConflictException('Only active induction evidence can be revoked or expired');
      const next=dto.action==='REVOKE'?'REVOKED':'EXPIRED';
      if(dto.action==='EXPIRE'&&!row.expired)throw new ConflictException('Induction cannot be marked expired before its expiry timestamp');
      await client.query(
        `UPDATE ehs_contractor_inductions SET status=$4,row_version=row_version+1,last_change_reason=$5,
          updated_by_user_id=$6,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$7`,
        [id,c.tenantId,c.factoryId,next,reason,c.userId,dto.expected_version]);
      return this.contractorDetail(client,c,id);
    });
  }

  private async drillDetail(client:PoolClient,c:EhsContext,id:string){
    const q=await client.query<Row>(
      `SELECT d.id::text AS id,d.drill_number,d.drill_type,d.title,d.location,d.planned_at::text AS planned_at,
        d.owner_user_id::text AS owner_user_id,d.status,d.started_at::text AS started_at,d.completed_at::text AS completed_at,
        d.outcome_summary,d.close_evidence,d.row_version::int AS row_version,d.last_change_reason,
        d.created_at::text AS created_at,d.updated_at::text AS updated_at,
        (SELECT count(*)::int FROM ehs_drill_attendance a WHERE a.drill_id=d.id AND a.tenant_id=d.tenant_id AND a.factory_id=d.factory_id) AS attendance_count,
        (SELECT count(*)::int FROM ehs_drill_attendance a WHERE a.drill_id=d.id AND a.tenant_id=d.tenant_id AND a.factory_id=d.factory_id AND a.attendance_status='PRESENT') AS present_count,
        (SELECT count(*)::int FROM ehs_drill_responses r WHERE r.drill_id=d.id AND r.tenant_id=d.tenant_id AND r.factory_id=d.factory_id) AS response_count
       FROM ehs_emergency_drills d WHERE d.id=$1 AND d.tenant_id=$2 AND d.factory_id=$3`,[id,c.tenantId,c.factoryId]);
    if(!q.rows[0])throw new NotFoundException('Emergency drill was not found in this factory');return q.rows[0];
  }
  private async attendanceDetail(client:PoolClient,c:EhsContext,id:string){
    const q=await client.query<Row>('SELECT id::text AS id,drill_id::text AS drill_id,attendee_ref,attendee_name,user_id::text AS user_id,attendance_status,recorded_at::text AS recorded_at,notes,evidence,recorded_by_user_id::text AS recorded_by_user_id FROM ehs_drill_attendance WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',[id,c.tenantId,c.factoryId]);
    if(!q.rows[0])throw new NotFoundException('Drill attendance evidence was not found');return q.rows[0];
  }
  private async responseDetail(client:PoolClient,c:EhsContext,id:string){
    const q=await client.query<Row>('SELECT id::text AS id,drill_id::text AS drill_id,response_code,response_action,responder_user_id::text AS responder_user_id,elapsed_seconds,occurred_at::text AS occurred_at,evidence,created_at::text AS created_at FROM ehs_drill_responses WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',[id,c.tenantId,c.factoryId]);
    if(!q.rows[0])throw new NotFoundException('Drill response evidence was not found');return q.rows[0];
  }
  private async chemicalDetail(client:PoolClient,c:EhsContext,id:string){
    const q=await client.query<Row>(
      `SELECT id::text AS id,chemical_code,chemical_name,manufacturer,hazard_class,storage_location,sds_revision,sds_document_uri,
        sds_issued_at::text AS sds_issued_at,sds_review_due_at::text AS sds_review_due_at,status,
        approved_by_user_id::text AS approved_by_user_id,approved_at::text AS approved_at,handling_instructions,
        emergency_instructions,row_version::int AS row_version,last_change_reason,created_at::text AS created_at,
        updated_at::text AS updated_at FROM ehs_chemical_sds_registry WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!q.rows[0])throw new NotFoundException('Chemical/SDS record was not found');
    return q.rows[0];
  }
  private async contractorDetail(client:PoolClient,c:EhsContext,id:string){
    const q=await client.query<Row>('SELECT id::text AS id,contractor_code,company_name,person_name,induction_at::text AS induction_at,expires_at::text AS expires_at,topics,evidence,status,row_version::int AS row_version,last_change_reason,recorded_by_user_id::text AS recorded_by_user_id,updated_by_user_id::text AS updated_by_user_id,created_at::text AS created_at,updated_at::text AS updated_at FROM ehs_contractor_inductions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',[id,c.tenantId,c.factoryId]);
    if(!q.rows[0])throw new NotFoundException('Contractor induction was not found');return q.rows[0];
  }

  private scope(c:EhsContext){for(const [field,value] of Object.entries({userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId}))this.uuid(value,field);}
  private key(raw:string|null){const v=raw?.trim()??'';if(!v||v.length>200)throw new BadRequestException('Idempotency-Key is required and must be at most 200 characters');return v;}
  private uuid(v:string,field:string){if(!isUUID(v))throw new BadRequestException(field+' must be a UUID');return v;}
  private text(v:string|undefined,field:string,max:number){const n=v?.trim()??'';if(!n||n.length>max)throw new BadRequestException(field+' is required and must contain at most '+max+' characters');return n;}
  private optionalText(v:string|undefined,max:number){if(v===undefined||!v.trim())return null;const n=v.trim();if(n.length>max)throw new BadRequestException('optional text is too long');return n;}
  private instant(v:string,field:string){const d=new Date(v);if(!Number.isFinite(d.getTime()))throw new BadRequestException(field+' must be a valid ISO timestamp');return d.toISOString();}
  private object(v:Record<string,unknown>|undefined,field:string){if(v===undefined||v===null)return{};if(typeof v!=='object'||Array.isArray(v))throw new BadRequestException(field+' must be an object');if(Buffer.byteLength(JSON.stringify(v),'utf8')>16384)throw new BadRequestException(field+' must be at most 16 KiB');return v;}
  private limit(v:number|undefined,max:number){const n=v??50;if(!Number.isInteger(n)||n<1||n>max)throw new BadRequestException('limit must be between 1 and '+max);return n;}
  private hash(v:unknown){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
  private same(old:unknown,next:string){if(String(old).trim()!==next)throw new ConflictException('Idempotency-Key was already used for a different request');}
  private correlation(c:EhsContext){return c.traceId&&isUUID(c.traceId)?c.traceId:c.requestId&&isUUID(c.requestId)?c.requestId:randomUUID();}
}
