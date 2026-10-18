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
  AssignWorkforceSkillDto,
  CreateWorkforceAssignmentDto,
  CreateWorkforceAttendanceEventDto,
  CreateWorkforceOvertimeDto,
  CreateWorkforceProductivityDto,
  CreateWorkforceShiftDto,
  CreateWorkforceSkillDto,
  CreateWorkforceWorkerDto,
  DecideWorkforceOvertimeDto,
  WorkforceAssignmentTransitionDto,
  WorkforceBiometricConsentDto,
  WorkforceDateQueryDto,
  WorkforceDateRangeQueryDto,
  WorkforceListQueryDto,
  WorkforceWorkerStatusDto,
} from './workforce.dto';

export interface WorkforceContext {
  userId: string;
  tenantId: string;
  factoryId: string;
  requestId?: string | null;
  traceId?: string | null;
}
type Row = QueryResultRow;

@Injectable()
export class WorkforceService {
  constructor(private readonly database: DatabaseService) {}

  async createWorker(c: WorkforceContext, dto: CreateWorkforceWorkerDto, rawKey: string | null) {
    this.validateContext(c);
    const key = this.idempotencyKey(rawKey);
    const payload = {
      employee_code: this.requiredText(dto.employee_code, 'employee_code', 100).toUpperCase(),
      display_name: this.requiredText(dto.display_name, 'display_name', 255),
      linked_user_id: dto.linked_user_id ? this.uuid(dto.linked_user_id, 'linked_user_id') : null,
    };
    const hash = this.hash(payload);
    return this.transaction(c, `workforce:worker:${key}`, async (client) => {
      const existing = await this.findIdempotent(client, 'workforce_workers', c, key, hash);
      if (existing) return { ...(await this.workerDetail(client, c, existing.id)), replayed: true };
      if (payload.linked_user_id) {
        const member = await client.query<Row>(
          `SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
           WHERE u.id=$1 AND u.status='ACTIVE' AND tm.tenant_id=$2 AND tm.status='ACTIVE' LIMIT 1`,
          [payload.linked_user_id, c.tenantId],
        );
        if (!member.rows[0]) throw new BadRequestException('linked_user_id must be an active member of this tenant');
      }
      const result = await client.query<Row>(
        `INSERT INTO workforce_workers
           (tenant_id,factory_id,employee_code,display_name,linked_user_id,idempotency_key,request_hash,
            created_by_user_id,updated_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$8,$9::uuid)
         RETURNING id::text AS id,employee_code,display_name,linked_user_id::text AS linked_user_id,status,row_version::int AS row_version`,
        [c.tenantId,c.factoryId,payload.employee_code,payload.display_name,payload.linked_user_id,key,hash,c.userId,this.correlationId(c)],
      );
      const worker = result.rows[0];
      if (!worker) throw new Error('WORKFORCE_WORKER_CREATE_FAILED');
      return { ...(await this.workerDetail(client, c, String(worker.id))), replayed: false };
    });
  }

  async listWorkers(c: WorkforceContext, query: WorkforceListQueryDto) {
    this.validateContext(c);
    const limit = this.limit(query.limit);
    const result = await this.database.query<Row>(
      `SELECT w.id::text AS id,w.employee_code,w.display_name,w.status,w.linked_user_id::text AS linked_user_id,
              w.biometric_consent_at::text AS biometric_consent_at,
              w.biometric_consent_withdrawn_at::text AS biometric_consent_withdrawn_at,
              w.row_version::int AS row_version,
              (SELECT count(*)::int FROM workforce_worker_skills ws
               JOIN workforce_skills s ON s.id=ws.skill_id AND s.tenant_id=ws.tenant_id AND s.factory_id=ws.factory_id
               WHERE ws.worker_id=w.id AND ws.tenant_id=w.tenant_id AND ws.factory_id=w.factory_id
                 AND ws.status='ACTIVE' AND s.status='ACTIVE'
                 AND (ws.certificate_expires_on IS NULL OR ws.certificate_expires_on>=CURRENT_DATE)) AS valid_skill_count
       FROM workforce_workers w
       WHERE w.tenant_id=$1 AND w.factory_id=$2
       ORDER BY w.employee_code,w.id LIMIT $3`,
      [c.tenantId,c.factoryId,limit], this.dbContext(c),
    );
    return { items: result.rows, limit };
  }

  async transitionWorker(c: WorkforceContext, workerId: string, dto: WorkforceWorkerStatusDto, rawKey: string | null) {
    this.validateContext(c);
    const id = this.uuid(workerId, 'worker_id');
    const key = this.idempotencyKey(rawKey);
    const reason = this.requiredText(dto.reason, 'reason', 1000);
    const hash = this.hash({ worker_id:id,status:dto.status,expected_version:dto.expected_version,reason });
    return this.transaction(c, `workforce:command:${key}`, async (client) => {
      const replay = await this.findCommandReceipt(client,c,key,hash);
      if (replay) return { ...(replay.response_snapshot as Record<string,unknown>), replayed:true };
      const current = await client.query<Row>(
        'SELECT id::text AS id,status,row_version::int AS row_version FROM workforce_workers WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [id,c.tenantId,c.factoryId],
      );
      const worker = current.rows[0];
      if (!worker) throw new NotFoundException('Worker was not found in this factory');
      if (Number(worker.row_version) !== dto.expected_version) throw new ConflictException('Worker version is stale; reload before changing status');
      if (worker.status === dto.status) throw new ConflictException('Worker already has the requested status');
      if (dto.status === 'INACTIVE') {
        const active = await client.query<Row>(
          `SELECT 1 FROM workforce_shift_assignments
           WHERE worker_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status IN ('PLANNED','CONFIRMED')
           AND planned_end_at>clock_timestamp() LIMIT 1`,
          [id,c.tenantId,c.factoryId],
        );
        if (active.rows[0]) throw new ConflictException('Cancel or complete future staffing assignments before inactivating this worker');
      }
      await client.query(
        `UPDATE workforce_workers SET status=$4,row_version=row_version+1,updated_by_user_id=$5,
          last_change_reason=$6,idempotency_key=idempotency_key,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [id,c.tenantId,c.factoryId,dto.status,c.userId,reason],
      );
      // Worker status transitions use an immutable lifecycle event key, recorded separately
      // without overwriting the original worker-create idempotency key.
      await this.insertSupplementalAudit(client,c,'WORKER',id,Number(worker.row_version)+1,'STATUS_'+dto.status,reason,{status:dto.status,request_key:key});
      const response={ ...(await this.workerDetail(client,c,id)), replayed:false };
      await this.storeCommandReceipt(client,c,key,hash,'WORKER',id,response);
      return response;
    });
  }

  async createSkill(c: WorkforceContext, dto: CreateWorkforceSkillDto, rawKey: string | null) {
    this.validateContext(c);
    const key = this.idempotencyKey(rawKey);
    const payload = {
      skill_code:this.requiredText(dto.skill_code,'skill_code',120).toUpperCase(),
      name:this.requiredText(dto.name,'name',255),
      description:this.optionalText(dto.description,4000),
    };
    const hash = this.hash(payload);
    return this.transaction(c, `workforce:skill:${key}`, async (client) => {
      const existing = await this.findIdempotent(client,'workforce_skills',c,key,hash);
      if (existing) return { ...(await this.skillDetail(client,c,existing.id)), replayed:true };
      const result = await client.query<Row>(
        `INSERT INTO workforce_skills
         (tenant_id,factory_id,skill_code,name,description,idempotency_key,request_hash,
          created_by_user_id,updated_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9::uuid)
         RETURNING id::text AS id,skill_code,name,status,row_version::int AS row_version`,
        [c.tenantId,c.factoryId,payload.skill_code,payload.name,payload.description,key,hash,c.userId,this.correlationId(c)],
      );
      const skill=result.rows[0];
      if (!skill) throw new Error('WORKFORCE_SKILL_CREATE_FAILED');
      return { ...(await this.skillDetail(client,c,String(skill.id))), replayed:false };
    });
  }

  async listSkills(c: WorkforceContext, query: WorkforceListQueryDto) {
    this.validateContext(c);
    const result=await this.database.query<Row>(
      `SELECT s.id::text AS id,s.skill_code,s.name,s.description,s.status,s.row_version::int AS row_version,
              count(ws.id) FILTER (WHERE ws.status='ACTIVE' AND (ws.certificate_expires_on IS NULL OR ws.certificate_expires_on>=CURRENT_DATE))::int AS qualified_worker_count
       FROM workforce_skills s LEFT JOIN workforce_worker_skills ws
         ON ws.skill_id=s.id AND ws.tenant_id=s.tenant_id AND ws.factory_id=s.factory_id
       WHERE s.tenant_id=$1 AND s.factory_id=$2
       GROUP BY s.id ORDER BY s.skill_code LIMIT $3`,
      [c.tenantId,c.factoryId,this.limit(query.limit)],this.dbContext(c),
    );
    return {items:result.rows,limit:this.limit(query.limit)};
  }

  async assignWorkerSkill(c: WorkforceContext, workerId: string, dto: AssignWorkforceSkillDto, rawKey: string | null) {
    this.validateContext(c);
    const worker=this.uuid(workerId,'worker_id');
    const skill=this.uuid(dto.skill_id,'skill_id');
    const key=this.idempotencyKey(rawKey);
    const certified=this.dateOnly(dto.certified_on,'certified_on',true);
    const expires=this.dateOnly(dto.certificate_expires_on,'certificate_expires_on',true);
    if(certified&&expires&&expires<certified) throw new BadRequestException('certificate_expires_on cannot be before certified_on');
    const payload={worker_id:worker,skill_id:skill,skill_level:dto.skill_level,certified_on:certified,certificate_expires_on:expires,certificate_reference:this.optionalText(dto.certificate_reference,255)};
    const hash=this.hash(payload);
    return this.transaction(c,`workforce:worker-skill:${key}`,async(client)=>{
      const existing=await this.findIdempotent(client,'workforce_worker_skills',c,key,hash);
      if(existing) return { ...(await this.workerSkills(client,c,worker)), replayed:true };
      const valid=await client.query<Row>(
        `SELECT w.id,s.id AS skill_id FROM workforce_workers w JOIN workforce_skills s
          ON s.id=$4 AND s.tenant_id=w.tenant_id AND s.factory_id=w.factory_id
         WHERE w.id=$1 AND w.tenant_id=$2 AND w.factory_id=$3 AND w.status='ACTIVE' AND s.status='ACTIVE' FOR UPDATE OF w,s`,
        [worker,c.tenantId,c.factoryId,skill],
      );
      if(!valid.rows[0]) throw new NotFoundException('Active worker or skill was not found in this factory');
      await client.query(
        `UPDATE workforce_worker_skills SET status='INACTIVE',row_version=row_version+1,
          updated_by_user_id=$4,updated_at=clock_timestamp()
         WHERE worker_id=$1 AND skill_id=$2 AND tenant_id=$3 AND factory_id=$5 AND status='ACTIVE'`,
        [worker,skill,c.tenantId,c.userId,c.factoryId],
      );
      const inserted=await client.query<Row>(
        `INSERT INTO workforce_worker_skills
          (tenant_id,factory_id,worker_id,skill_id,skill_level,certified_on,certificate_expires_on,
           certificate_reference,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$11,$12::uuid)
         RETURNING id::text AS id,row_version::int AS row_version,status`,
        [c.tenantId,c.factoryId,worker,skill,dto.skill_level,certified,expires,payload.certificate_reference,key,hash,c.userId,this.correlationId(c)],
      );
      if(!inserted.rows[0]) throw new Error('WORKFORCE_SKILL_ASSIGNMENT_FAILED');
      await this.insertSupplementalAudit(client,c,'WORKER_SKILL',String(inserted.rows[0].id),1,'SKILL_ASSIGNED','Worker skill assignment revised',{skill_id:skill,skill_level:dto.skill_level});
      return { ...(await this.workerSkills(client,c,worker)),replayed:false };
    });
  }

  async recordBiometricConsent(c: WorkforceContext, workerId: string, dto: WorkforceBiometricConsentDto, rawKey: string | null) {
    this.validateContext(c);
    const worker=this.uuid(workerId,'worker_id');
    const key=this.idempotencyKey(rawKey);
    const payload={worker_id:worker,consent_granted:dto.consent_granted,purpose:this.requiredText(dto.purpose,'purpose',255),reason:this.requiredText(dto.reason,'reason',2000)};
    const hash=this.hash(payload);
    return this.transaction(c,`workforce:consent:${key}`,async(client)=>{
      const replay=await this.findIdempotent(client,'workforce_biometric_consent_events',c,key,hash);
      if(replay) return { ...(await this.workerDetail(client,c,worker)),replayed:true };
      const current=await client.query<Row>(
        `SELECT id::text AS id,biometric_consent_at,biometric_consent_withdrawn_at,row_version::int AS row_version
         FROM workforce_workers WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' FOR UPDATE`,
        [worker,c.tenantId,c.factoryId],
      );
      const found=current.rows[0];
      if(!found) throw new NotFoundException('Active worker was not found in this factory');
      if(!dto.consent_granted && !found.biometric_consent_at) throw new ConflictException('Cannot withdraw biometric consent that was never granted');
      if(dto.consent_granted) {
        await client.query(
          `UPDATE workforce_workers SET biometric_consent_at=clock_timestamp(),biometric_consent_withdrawn_at=NULL,
           row_version=row_version+1,updated_by_user_id=$4,last_change_reason=$5,updated_at=clock_timestamp()
           WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
          [worker,c.tenantId,c.factoryId,c.userId,payload.reason],
        );
      } else {
        await client.query(
          `UPDATE workforce_workers SET biometric_consent_withdrawn_at=clock_timestamp(),
           row_version=row_version+1,updated_by_user_id=$4,last_change_reason=$5,updated_at=clock_timestamp()
           WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
          [worker,c.tenantId,c.factoryId,c.userId,payload.reason],
        );
      }
      await client.query(
        `INSERT INTO workforce_biometric_consent_events
          (tenant_id,factory_id,worker_id,consent_granted,purpose,reason,idempotency_key,request_hash,recorded_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid)`,
        [c.tenantId,c.factoryId,worker,dto.consent_granted,payload.purpose,payload.reason,key,hash,c.userId,this.correlationId(c)],
      );
      return { ...(await this.workerDetail(client,c,worker)),replayed:false };
    });
  }

  async createShift(c: WorkforceContext, dto: CreateWorkforceShiftDto, rawKey: string | null) {
    this.validateContext(c);
    const key=this.idempotencyKey(rawKey);
    const payload={
      shift_code:this.requiredText(dto.shift_code,'shift_code',80).toUpperCase(),
      name:this.requiredText(dto.name,'name',255),
      starts_at_local:this.time(dto.starts_at_local,'starts_at_local'),
      ends_at_local:this.time(dto.ends_at_local,'ends_at_local'),
      timezone_name:this.timezone(dto.timezone_name??'Asia/Dhaka'),
      unpaid_break_minutes:dto.unpaid_break_minutes??0,
      late_grace_minutes:dto.late_grace_minutes??0,
      overtime_threshold_minutes:dto.overtime_threshold_minutes??0,
    };
    if(payload.starts_at_local===payload.ends_at_local) throw new BadRequestException('Shift start and end times must differ');
    const hash=this.hash(payload);
    return this.transaction(c,`workforce:shift:${key}`,async(client)=>{
      const existing=await this.findIdempotent(client,'workforce_shift_templates',c,key,hash);
      if(existing) return { ...(await this.shiftDetail(client,c,existing.id)),replayed:true };
      const result=await client.query<Row>(
        `INSERT INTO workforce_shift_templates
          (tenant_id,factory_id,shift_code,name,starts_at_local,ends_at_local,timezone_name,
           unpaid_break_minutes,late_grace_minutes,overtime_threshold_minutes,idempotency_key,request_hash,
           created_by_user_id,updated_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5::time,$6::time,$7,$8,$9,$10,$11,$12,$13,$13,$14::uuid)
         RETURNING id::text AS id,shift_code,name,starts_at_local::text AS starts_at_local,
          ends_at_local::text AS ends_at_local,timezone_name,status,row_version::int AS row_version`,
        [c.tenantId,c.factoryId,payload.shift_code,payload.name,payload.starts_at_local,payload.ends_at_local,payload.timezone_name,
          payload.unpaid_break_minutes,payload.late_grace_minutes,payload.overtime_threshold_minutes,key,hash,c.userId,this.correlationId(c)],
      );
      const shift=result.rows[0];
      if(!shift) throw new Error('WORKFORCE_SHIFT_CREATE_FAILED');
      return { ...(await this.shiftDetail(client,c,String(shift.id))),replayed:false };
    });
  }

  async listShifts(c: WorkforceContext, query: WorkforceListQueryDto) {
    this.validateContext(c);
    const result=await this.database.query<Row>(
      `SELECT id::text AS id,shift_code,name,starts_at_local::text AS starts_at_local,
       ends_at_local::text AS ends_at_local,timezone_name,unpaid_break_minutes,late_grace_minutes,
       overtime_threshold_minutes,status,row_version::int AS row_version
       FROM workforce_shift_templates WHERE tenant_id=$1 AND factory_id=$2
       ORDER BY shift_code LIMIT $3`,
      [c.tenantId,c.factoryId,this.limit(query.limit)],this.dbContext(c),
    );
    return {items:result.rows,limit:this.limit(query.limit)};
  }

  async createAssignment(c: WorkforceContext, dto: CreateWorkforceAssignmentDto, rawKey: string | null) {
    this.validateContext(c);
    const key=this.idempotencyKey(rawKey);
    const worker=this.uuid(dto.worker_id,'worker_id');
    const shift=this.uuid(dto.shift_template_id,'shift_template_id');
    const shiftDate=this.dateOnly(dto.shift_date,'shift_date');
    const hashPayloadBase={worker_id:worker,shift_template_id:shift,shift_date:shiftDate,
      work_order_id:dto.work_order_id??null,work_order_operation_id:dto.work_order_operation_id??null,
      operation_code:dto.operation_code?.trim()||null,required_skill_code:dto.required_skill_code?.trim()||null};
    const hash=this.hash(hashPayloadBase);
    return this.transaction(c,`workforce:assignment:${key}`,async(client)=>{
      const existing=await this.findIdempotent(client,'workforce_shift_assignments',c,key,hash);
      if(existing) return { ...(await this.assignmentDetail(client,c,existing.id)),replayed:true };
      const shiftRow=await client.query<Row>(
        `SELECT id::text AS id,starts_at_local::text AS starts_at_local,ends_at_local::text AS ends_at_local,timezone_name,status
         FROM workforce_shift_templates WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE`,
        [shift,c.tenantId,c.factoryId],
      );
      const tmpl=shiftRow.rows[0];
      if(!tmpl||tmpl.status!=='ACTIVE') throw new NotFoundException('Active shift template was not found in this factory');
      const startAt=this.localToUtc(shiftDate,String(tmpl.starts_at_local),String(tmpl.timezone_name));
      const endDate=String(tmpl.ends_at_local)<=String(tmpl.starts_at_local)?this.addDays(shiftDate,1):shiftDate;
      const endAt=this.localToUtc(endDate,String(tmpl.ends_at_local),String(tmpl.timezone_name));
      if(endAt<=startAt||(endAt.getTime()-startAt.getTime())>24*60*60*1000) {
        throw new BadRequestException('Resolved shift window must be positive and no longer than 24 hours');
      }
      const validWorker=await client.query<Row>(
        `SELECT id FROM workforce_workers WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' FOR SHARE`,
        [worker,c.tenantId,c.factoryId],
      );
      if(!validWorker.rows[0]) throw new NotFoundException('Active worker was not found in this factory');
      let operationCode=this.optionalText(dto.operation_code,120);
      let requiredSkill=this.optionalText(dto.required_skill_code,120);
      const orderId=dto.work_order_id?this.uuid(dto.work_order_id,'work_order_id'):null;
      const operationId=dto.work_order_operation_id?this.uuid(dto.work_order_operation_id,'work_order_operation_id'):null;
      if(operationId&&!orderId) throw new BadRequestException('work_order_id is required when work_order_operation_id is supplied');
      if(operationId) {
        const op=await client.query<Row>(
          `SELECT operation_code,required_skill,status FROM work_order_operations
           WHERE id=$1 AND work_order_id=$2 AND tenant_id=$3 AND factory_id=$4 FOR SHARE`,
          [operationId,orderId,c.tenantId,c.factoryId],
        );
        if(!op.rows[0]) throw new NotFoundException('Work-order operation was not found in this factory');
        if(operationCode&&operationCode!==String(op.rows[0].operation_code)) throw new ConflictException('operation_code must match the work-order operation');
        operationCode=String(op.rows[0].operation_code);
        const required=op.rows[0].required_skill===null?null:String(op.rows[0].required_skill);
        if(requiredSkill&&required&&requiredSkill.toLowerCase()!==required.toLowerCase()) {
          throw new ConflictException('required_skill_code must match the operation bulletin');
        }
        requiredSkill=required??requiredSkill;
      }
      if(requiredSkill) requiredSkill=requiredSkill.toUpperCase();
      const result=await client.query<Row>(
        `INSERT INTO workforce_shift_assignments
          (tenant_id,factory_id,shift_template_id,worker_id,shift_date,planned_start_at,planned_end_at,
           work_order_id,work_order_operation_id,operation_code,required_skill_code,idempotency_key,request_hash,
           created_by_user_id,updated_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5::date,$6::timestamptz,$7::timestamptz,$8::uuid,$9::uuid,$10,$11,$12,$13,$14,$14,$15::uuid)
         RETURNING id::text AS id,status,row_version::int AS row_version,planned_start_at::text AS planned_start_at,
           planned_end_at::text AS planned_end_at`,
        [c.tenantId,c.factoryId,shift,worker,shiftDate,startAt.toISOString(),endAt.toISOString(),orderId,operationId,
          operationCode,requiredSkill,key,hash,c.userId,this.correlationId(c)],
      );
      const assignment=result.rows[0];
      if(!assignment) throw new Error('WORKFORCE_ASSIGNMENT_CREATE_FAILED');
      return { ...(await this.assignmentDetail(client,c,String(assignment.id))),replayed:false };
    });
  }

  async transitionAssignment(c: WorkforceContext, assignmentId: string, dto: WorkforceAssignmentTransitionDto, rawKey: string | null) {
    this.validateContext(c);
    const id=this.uuid(assignmentId,'assignment_id');
    const key=this.idempotencyKey(rawKey);
    const reason=this.requiredText(dto.reason,'reason',1000);
    const hash=this.hash({assignment_id:id,expected_version:dto.expected_version,action:dto.action,reason});
    return this.transaction(c,`workforce:command:${key}`,async(client)=>{
      const replay=await this.findCommandReceipt(client,c,key,hash);
      if(replay) return { ...(replay.response_snapshot as Record<string,unknown>),replayed:true };
      const current=await client.query<Row>(
        `SELECT id::text AS id,status,row_version::int AS row_version
         FROM workforce_shift_assignments WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [id,c.tenantId,c.factoryId],
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException('Staffing assignment was not found in this factory');
      if(Number(row.row_version)!==dto.expected_version) throw new ConflictException('Assignment version is stale; reload before changing it');
      const allowed:Record<string,string[]>={PLANNED:['CONFIRM','CANCEL'],CONFIRMED:['CANCEL','COMPLETE'],CANCELLED:[],COMPLETED:[]};
      const toStatus:Record<string,string>={CONFIRM:'CONFIRMED',CANCEL:'CANCELLED',COMPLETE:'COMPLETED'};
      if(!(allowed[String(row.status)]??[]).includes(dto.action)) throw new ConflictException(`Invalid assignment action ${dto.action} from status ${row.status}`);
      await client.query(
        `UPDATE workforce_shift_assignments SET status=$4,row_version=row_version+1,updated_by_user_id=$5,
          last_change_reason=$6,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [id,c.tenantId,c.factoryId,toStatus[dto.action],c.userId,reason],
      );
      await this.insertSupplementalAudit(client,c,'SHIFT_ASSIGNMENT',id,Number(row.row_version)+1,toStatus[dto.action],reason,{request_key:key});
      const response={ ...(await this.assignmentDetail(client,c,id)),replayed:false };
      await this.storeCommandReceipt(client,c,key,hash,'SHIFT_ASSIGNMENT',id,response);
      return response;
    });
  }

  async captureAttendance(c: WorkforceContext, dto: CreateWorkforceAttendanceEventDto, rawKey: string | null) {
    this.validateContext(c);
    const key=this.idempotencyKey(rawKey);
    const assignment=this.uuid(dto.shift_assignment_id,'shift_assignment_id');
    const occurredAt=this.timestamp(dto.occurred_at,'occurred_at');
    const payload={shift_assignment_id:assignment,event_type:dto.event_type,source_type:dto.source_type,
      source_event_id:this.optionalText(dto.source_event_id,255),occurred_at:occurredAt,
      capture_metadata:this.jsonObject(dto.capture_metadata??{})};
    const hash=this.hash(payload);
    return this.transaction(c,`workforce:attendance:${c.tenantId}:${c.factoryId}:${key}`,async(client)=>{
      const existing=await this.findIdempotent(client,'workforce_attendance_events',c,key,hash);
      if(existing) return { ...(await this.attendanceDetail(client,c,existing.id)),replayed:true };
      const owner=await client.query<Row>(
        `SELECT worker_id::text AS worker_id FROM workforce_shift_assignments
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [assignment,c.tenantId,c.factoryId],
      );
      if(!owner.rows[0]) throw new NotFoundException('Shift assignment was not found in this factory');
      const workerId=String(owner.rows[0].worker_id);
      if(payload.source_event_id) {
        const source=await client.query<Row>(
          `SELECT id::text AS id,request_hash FROM workforce_attendance_events
           WHERE tenant_id=$1 AND factory_id=$2 AND source_type=$3 AND source_event_id=$4 FOR SHARE`,
          [c.tenantId,c.factoryId,dto.source_type,payload.source_event_id],
        );
        if(source.rows[0]) {
          if(String(source.rows[0].request_hash)!==hash) throw new ConflictException('Device source_event_id was already used with different attendance data');
          return { ...(await this.attendanceDetail(client,c,String(source.rows[0].id))),replayed:true };
        }
      }
      const result=await client.query<Row>(
        `INSERT INTO workforce_attendance_events
         (tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,source_event_id,
          occurred_at,idempotency_key,request_hash,capture_metadata,recorded_by_user_id,correlation_id,request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11::jsonb,$12,$13::uuid,$14)
         RETURNING id::text AS id,event_type,source_type,occurred_at::text AS occurred_at`,
        [c.tenantId,c.factoryId,assignment,workerId,dto.event_type,dto.source_type,payload.source_event_id,
          occurredAt,key,hash,JSON.stringify(payload.capture_metadata),c.userId,this.correlationId(c),c.requestId??null],
      );
      const event=result.rows[0];
      if(!event) throw new Error('WORKFORCE_ATTENDANCE_CAPTURE_FAILED');
      return { ...(await this.attendanceDetail(client,c,String(event.id))),replayed:false };
    });
  }

  async listAttendance(c: WorkforceContext, query: WorkforceDateQueryDto, rawLimit?: number) {
    this.validateContext(c);
    const day=this.dateOnly(query.shift_date,'shift_date');
    const limit=this.limit(rawLimit);
    const result=await this.database.query<Row>(
      `SELECT e.id::text AS id,e.event_type,e.source_type,e.source_event_id,e.occurred_at::text AS occurred_at,
              e.shift_assignment_id::text AS shift_assignment_id,e.worker_id::text AS worker_id,
              w.employee_code,w.display_name,a.shift_date::text AS shift_date,a.status AS assignment_status,
              e.capture_metadata,e.created_at::text AS captured_at
       FROM workforce_attendance_events e
       JOIN workforce_workers w ON w.id=e.worker_id AND w.tenant_id=e.tenant_id AND w.factory_id=e.factory_id
       JOIN workforce_shift_assignments a ON a.id=e.shift_assignment_id AND a.tenant_id=e.tenant_id AND a.factory_id=e.factory_id
       WHERE e.tenant_id=$1 AND e.factory_id=$2 AND a.shift_date=$3::date
         AND ($4::uuid IS NULL OR a.shift_template_id=$4::uuid)
       ORDER BY e.occurred_at,e.id LIMIT $5`,
      [c.tenantId,c.factoryId,day,query.shift_template_id??null,limit],this.dbContext(c),
    );
    return {items:result.rows,shift_date:day,limit};
  }

  async createOvertime(c: WorkforceContext, dto: CreateWorkforceOvertimeDto, rawKey: string | null) {
    this.validateContext(c);
    const key=this.idempotencyKey(rawKey);
    const assignment=this.uuid(dto.shift_assignment_id,'shift_assignment_id');
    const reason=this.requiredText(dto.reason,'reason',2000);
    const payload={shift_assignment_id:assignment,requested_minutes:dto.requested_minutes,reason};
    const hash=this.hash(payload);
    return this.transaction(c,`workforce:overtime:${key}`,async(client)=>{
      const replay=await this.findIdempotent(client,'workforce_overtime_requests',c,key,hash);
      if(replay) return { ...(await this.overtimeDetail(client,c,replay.id)),replayed:true };
      const assignmentRow=await client.query<Row>(
        `SELECT worker_id::text AS worker_id,status FROM workforce_shift_assignments
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE`,
        [assignment,c.tenantId,c.factoryId],
      );
      if(!assignmentRow.rows[0]) throw new NotFoundException('Shift assignment was not found in this factory');
      if(assignmentRow.rows[0].status==='CANCELLED') throw new ConflictException('Overtime cannot be requested for a cancelled shift');
      const result=await client.query<Row>(
        `INSERT INTO workforce_overtime_requests
         (tenant_id,factory_id,shift_assignment_id,worker_id,requested_minutes,reason,idempotency_key,request_hash,
          created_by_user_id,updated_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10::uuid)
         RETURNING id::text AS id,status,requested_minutes,approved_minutes,row_version::int AS row_version`,
        [c.tenantId,c.factoryId,assignment,String(assignmentRow.rows[0].worker_id),dto.requested_minutes,reason,key,hash,c.userId,this.correlationId(c)],
      );
      const item=result.rows[0];
      if(!item) throw new Error('WORKFORCE_OVERTIME_CREATE_FAILED');
      return { ...(await this.overtimeDetail(client,c,String(item.id))),replayed:false };
    });
  }

  async decideOvertime(c: WorkforceContext, overtimeId: string, dto: DecideWorkforceOvertimeDto, rawKey: string | null) {
    this.validateContext(c);
    const id=this.uuid(overtimeId,'overtime_id');
    const key=this.idempotencyKey(rawKey);
    const reason=this.requiredText(dto.reason,'reason',2000);
    const approvedMinutes=dto.action==='APPROVE'?(dto.approved_minutes??0):0;
    if(dto.action==='APPROVE'&&(approvedMinutes<1||approvedMinutes>1440)) throw new BadRequestException('approved_minutes must be between 1 and 1440 for approval');
    if(dto.action==='REJECT'&&(dto.approved_minutes??0)!==0) throw new BadRequestException('approved_minutes must be zero when rejecting overtime');
    const hash=this.hash({overtime_id:id,expected_version:dto.expected_version,action:dto.action,approved_minutes:approvedMinutes,reason});
    return this.transaction(c,`workforce:command:${key}`,async(client)=>{
      const replay=await this.findCommandReceipt(client,c,key,hash);
      if(replay) return { ...(replay.response_snapshot as Record<string,unknown>),replayed:true };
      const current=await client.query<Row>(
        `SELECT id::text AS id,status,requested_minutes,created_by_user_id::text AS created_by_user_id,row_version::int AS row_version
         FROM workforce_overtime_requests WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [id,c.tenantId,c.factoryId],
      );
      const item=current.rows[0];
      if(!item) throw new NotFoundException('Overtime request was not found in this factory');
      if(Number(item.row_version)!==dto.expected_version) throw new ConflictException('Overtime request version is stale; reload before deciding');
      if(item.status!=='PENDING') throw new ConflictException('Only pending overtime requests can be decided');
      if(String(item.created_by_user_id)===c.userId) throw new ConflictException('The overtime requester cannot approve or reject their own request');
      if(approvedMinutes>Number(item.requested_minutes)) throw new BadRequestException('approved_minutes cannot exceed requested_minutes');
      const next=dto.action==='APPROVE'?'APPROVED':'REJECTED';
      await client.query(
        `UPDATE workforce_overtime_requests SET status=$4,approved_minutes=$5,updated_by_user_id=$6,
          decided_by_user_id=$6,decided_at=clock_timestamp(),decision_reason=$7,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [id,c.tenantId,c.factoryId,next,approvedMinutes,c.userId,reason],
      );
      const response={ ...(await this.overtimeDetail(client,c,id)),replayed:false };
      await this.storeCommandReceipt(client,c,key,hash,'OVERTIME_REQUEST',id,response);
      return response;
    });
  }

  async listOvertime(c: WorkforceContext, query: WorkforceDateRangeQueryDto) {
    this.validateContext(c);
    const from=this.dateOnly(query.from_date,'from_date'),to=this.dateOnly(query.to_date,'to_date');
    if(from>to) throw new BadRequestException('from_date cannot be after to_date');
    const limit=this.limit(query.limit);
    const result=await this.database.query<Row>(
      `SELECT o.id::text AS id,o.worker_id::text AS worker_id,w.employee_code,w.display_name,
       o.shift_assignment_id::text AS shift_assignment_id,a.shift_date::text AS shift_date,
       o.requested_minutes,o.approved_minutes,o.status,o.reason,o.decision_reason,
       o.created_by_user_id::text AS requested_by_user_id,o.decided_by_user_id::text AS decided_by_user_id,
       o.decided_at::text AS decided_at,o.row_version::int AS row_version,o.created_at::text AS created_at
       FROM workforce_overtime_requests o
       JOIN workforce_workers w ON w.id=o.worker_id AND w.tenant_id=o.tenant_id AND w.factory_id=o.factory_id
       JOIN workforce_shift_assignments a ON a.id=o.shift_assignment_id AND a.tenant_id=o.tenant_id AND a.factory_id=o.factory_id
       WHERE o.tenant_id=$1 AND o.factory_id=$2 AND a.shift_date BETWEEN $3::date AND $4::date
        AND ($5::uuid IS NULL OR o.worker_id=$5::uuid)
       ORDER BY a.shift_date DESC,o.created_at DESC,o.id LIMIT $6`,
      [c.tenantId,c.factoryId,from,to,query.worker_id??null,limit],this.dbContext(c),
    );
    return {items:result.rows,from_date:from,to_date:to,limit};
  }

  async captureProductivity(c: WorkforceContext, dto: CreateWorkforceProductivityDto, rawKey: string | null) {
    this.validateContext(c);
    const key=this.idempotencyKey(rawKey);
    const assignment=this.uuid(dto.shift_assignment_id,'shift_assignment_id');
    const order=this.uuid(dto.work_order_id,'work_order_id');
    const operation=this.uuid(dto.work_order_operation_id,'work_order_operation_id');
    const started=this.timestamp(dto.production_started_at,'production_started_at');
    const ended=this.timestamp(dto.production_ended_at,'production_ended_at');
    if(ended<=started) throw new BadRequestException('production_ended_at must be after production_started_at');
    const duration=(new Date(ended).getTime()-new Date(started).getTime())/60000;
    if(duration>1440) throw new BadRequestException('A productivity interval cannot exceed 24 hours');
    const good=this.quantity(dto.good_quantity,'good_quantity');
    const scrap=this.quantity(dto.scrap_quantity??0,'scrap_quantity');
    const standard=this.positiveMinutes(dto.standard_minutes_per_unit,'standard_minutes_per_unit');
    const actual=this.positiveMinutes(dto.actual_minutes,'actual_minutes');
    if(good+scrap<=0) throw new BadRequestException('good_quantity + scrap_quantity must be greater than zero');
    if(actual>duration) throw new BadRequestException('actual_minutes cannot exceed the production interval duration');
    const scrapReason=this.optionalText(dto.scrap_reason,2000);
    if(scrap>0&&!scrapReason) throw new BadRequestException('scrap_reason is required when scrap_quantity is positive');
    const payload={shift_assignment_id:assignment,work_order_id:order,work_order_operation_id:operation,
      production_started_at:started,production_ended_at:ended,good_quantity:good,scrap_quantity:scrap,
      standard_minutes_per_unit:standard,actual_minutes:actual,scrap_reason:scrapReason,notes:this.optionalText(dto.notes,4000)};
    const hash=this.hash(payload);
    return this.transaction(c,`workforce:productivity:${key}`,async(client)=>{
      const replay=await this.findIdempotent(client,'workforce_productivity_reports',c,key,hash);
      if(replay) return { ...(await this.productivityDetail(client,c,replay.id)),replayed:true };
      const assignmentRow=await client.query<Row>(
        `SELECT worker_id::text AS worker_id FROM workforce_shift_assignments
          WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [assignment,c.tenantId,c.factoryId],
      );
      if(!assignmentRow.rows[0]) throw new NotFoundException('Shift assignment was not found in this factory');
      const op=await client.query<Row>(
        `SELECT operation_code,run_minutes_per_unit::text AS run_minutes_per_unit FROM work_order_operations
         WHERE id=$1 AND work_order_id=$2 AND tenant_id=$3 AND factory_id=$4`,
        [operation,order,c.tenantId,c.factoryId],
      );
      if(!op.rows[0]) throw new NotFoundException('Work-order operation was not found in this factory');
      if(Number(op.rows[0].run_minutes_per_unit)!==standard) throw new ConflictException('standard_minutes_per_unit must match the released routing snapshot');
      const result=await client.query<Row>(
        `INSERT INTO workforce_productivity_reports
         (tenant_id,factory_id,shift_assignment_id,worker_id,work_order_id,work_order_operation_id,operation_code,
          production_started_at,production_ended_at,good_quantity,scrap_quantity,standard_minutes_per_unit,actual_minutes,
          scrap_reason,notes,idempotency_key,request_hash,created_by_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::uuid)
         RETURNING id::text AS id,good_quantity::text AS good_quantity,scrap_quantity::text AS scrap_quantity,
           earned_minutes::text AS earned_minutes,efficiency_percent::text AS efficiency_percent`,
        [c.tenantId,c.factoryId,assignment,String(assignmentRow.rows[0].worker_id),order,operation,String(op.rows[0].operation_code),
          started,ended,good,scrap,standard,actual,scrapReason,payload.notes,key,hash,c.userId,this.correlationId(c)],
      );
      const report=result.rows[0];
      if(!report) throw new Error('WORKFORCE_PRODUCTIVITY_CAPTURE_FAILED');
      return { ...(await this.productivityDetail(client,c,String(report.id))),replayed:false };
    });
  }

  async listProductivity(c: WorkforceContext, query: WorkforceDateRangeQueryDto) {
    this.validateContext(c);
    const from=this.dateOnly(query.from_date,'from_date'),to=this.dateOnly(query.to_date,'to_date');
    if(from>to) throw new BadRequestException('from_date cannot be after to_date');
    const result=await this.database.query<Row>(
      `SELECT p.id::text AS id,p.worker_id::text AS worker_id,w.employee_code,w.display_name,
       p.shift_assignment_id::text AS shift_assignment_id,a.shift_date::text AS shift_date,
       p.work_order_id::text AS work_order_id,p.work_order_operation_id::text AS work_order_operation_id,
       p.operation_code,p.production_started_at::text AS production_started_at,p.production_ended_at::text AS production_ended_at,
       p.good_quantity::text AS good_quantity,p.scrap_quantity::text AS scrap_quantity,
       p.standard_minutes_per_unit::text AS standard_minutes_per_unit,p.actual_minutes::text AS actual_minutes,
       p.earned_minutes::text AS earned_minutes,p.efficiency_percent::text AS efficiency_percent,
       p.scrap_reason,p.notes,p.created_at::text AS captured_at
       FROM workforce_productivity_reports p
       JOIN workforce_workers w ON w.id=p.worker_id AND w.tenant_id=p.tenant_id AND w.factory_id=p.factory_id
       JOIN workforce_shift_assignments a ON a.id=p.shift_assignment_id AND a.tenant_id=p.tenant_id AND a.factory_id=p.factory_id
       WHERE p.tenant_id=$1 AND p.factory_id=$2 AND a.shift_date BETWEEN $3::date AND $4::date
        AND ($5::uuid IS NULL OR p.worker_id=$5::uuid)
       ORDER BY a.shift_date DESC,p.created_at DESC,p.id LIMIT $6`,
      [c.tenantId,c.factoryId,from,to,query.worker_id??null,this.limit(query.limit)],this.dbContext(c),
    );
    const items=result.rows;
    const totals=items.reduce((acc,row)=>{
      acc.good_quantity+=Number(row.good_quantity);
      acc.scrap_quantity+=Number(row.scrap_quantity);
      acc.earned_minutes+=Number(row.earned_minutes);
      acc.actual_minutes+=Number(row.actual_minutes);
      return acc;
    },{good_quantity:0,scrap_quantity:0,earned_minutes:0,actual_minutes:0});
    return {items,totals,weighted_efficiency_percent:totals.actual_minutes>0?Math.round(totals.earned_minutes*10000/totals.actual_minutes)/100:0,from_date:from,to_date:to};
  }

  async staffingCoverage(c: WorkforceContext, query: WorkforceDateQueryDto) {
    this.validateContext(c);
    const day=this.dateOnly(query.shift_date,'shift_date');
    const assigned=await this.database.query<Row>(
      `SELECT a.id::text AS assignment_id,a.worker_id::text AS worker_id,a.shift_template_id::text AS shift_template_id,
       a.required_skill_code,a.planned_start_at::text AS planned_start_at,a.planned_end_at::text AS planned_end_at,
       a.status AS assignment_status,w.employee_code,w.display_name,s.name AS shift_name,s.late_grace_minutes,
       EXISTS(SELECT 1 FROM workforce_attendance_events e WHERE e.shift_assignment_id=a.id AND e.event_type='CLOCK_IN') AS clocked_in,
       EXISTS(SELECT 1 FROM workforce_attendance_events e WHERE e.shift_assignment_id=a.id AND e.event_type='ABSENCE_RECORDED') AS absence_recorded
       FROM workforce_shift_assignments a JOIN workforce_workers w
        ON w.id=a.worker_id AND w.tenant_id=a.tenant_id AND w.factory_id=a.factory_id
       JOIN workforce_shift_templates s ON s.id=a.shift_template_id AND s.tenant_id=a.tenant_id AND s.factory_id=a.factory_id
       WHERE a.tenant_id=$1 AND a.factory_id=$2 AND a.shift_date=$3::date
         AND ($4::uuid IS NULL OR a.shift_template_id=$4::uuid) AND a.status IN ('PLANNED','CONFIRMED')
       ORDER BY a.planned_start_at,w.employee_code`,
      [c.tenantId,c.factoryId,day,query.shift_template_id??null],this.dbContext(c),
    );
    const now=Date.now();
    const uncovered=assigned.rows.filter((row)=>
      row.absence_recorded===true || (row.clocked_in!==true&&now>=new Date(String(row.planned_start_at)).getTime()+Number(row.late_grace_minutes)*60000)
    );
    const gaps=await Promise.all(uncovered.map(async(row)=>{
      const candidates=await this.database.query<Row>(
        `SELECT w.id::text AS worker_id,w.employee_code,w.display_name,
          count(DISTINCT sk.id)::int AS active_skill_count
         FROM workforce_workers w
         LEFT JOIN workforce_worker_skills ws ON ws.worker_id=w.id AND ws.tenant_id=w.tenant_id AND ws.factory_id=w.factory_id
          AND ws.status='ACTIVE' AND (ws.certificate_expires_on IS NULL OR ws.certificate_expires_on >= $4::date)
         LEFT JOIN workforce_skills sk ON sk.id=ws.skill_id AND sk.tenant_id=ws.tenant_id AND sk.factory_id=ws.factory_id AND sk.status='ACTIVE'
         WHERE w.tenant_id=$1 AND w.factory_id=$2 AND w.status='ACTIVE' AND w.id<>$3::uuid
           AND ($5::text IS NULL OR EXISTS(
             SELECT 1 FROM workforce_worker_skills rws JOIN workforce_skills rs
              ON rs.id=rws.skill_id AND rs.tenant_id=rws.tenant_id AND rs.factory_id=rws.factory_id
             WHERE rws.worker_id=w.id AND rws.tenant_id=w.tenant_id AND rws.factory_id=w.factory_id
              AND rws.status='ACTIVE' AND rs.status='ACTIVE' AND lower(rs.skill_code)=lower($5::text)
              AND (rws.certificate_expires_on IS NULL OR rws.certificate_expires_on >= $4::date)
           ))
           AND NOT EXISTS(SELECT 1 FROM workforce_shift_assignments other
             WHERE other.worker_id=w.id AND other.tenant_id=w.tenant_id AND other.factory_id=w.factory_id
              AND other.id<>$6::uuid AND other.status IN ('PLANNED','CONFIRMED')
              AND tstzrange(other.planned_start_at,other.planned_end_at,'[)')
                && tstzrange($7::timestamptz,$8::timestamptz,'[)'))
         GROUP BY w.id,w.employee_code,w.display_name
         ORDER BY count(DISTINCT sk.id) DESC,w.employee_code LIMIT 5`,
        [c.tenantId,c.factoryId,String(row.worker_id),day,row.required_skill_code??null,String(row.assignment_id),
          String(row.planned_start_at),String(row.planned_end_at)],this.dbContext(c),
      );
      return {
        assignment_id:row.assignment_id,shift_template_id:row.shift_template_id,shift_name:row.shift_name,
        missing_worker:{worker_id:row.worker_id,employee_code:row.employee_code,display_name:row.display_name},
        reason:row.absence_recorded===true?'ABSENCE_RECORDED':(row.assignment_status==='PLANNED'?'UNCONFIRMED_ASSIGNMENT':'NO_CLOCK_IN_AFTER_GRACE'),
        required_skill_code:row.required_skill_code??null,backfill_candidates:candidates.rows,
      };
    }));
    return {shift_date:day,planned_assignments:assigned.rows.length,confirmed_assignments:assigned.rows.filter(r=>r.assignment_status==='CONFIRMED').length,uncovered_count:gaps.length,gaps};
  }

  async selfService(c: WorkforceContext, query: WorkforceDateRangeQueryDto) {
    this.validateContext(c);
    const from=this.dateOnly(query.from_date,'from_date'),to=this.dateOnly(query.to_date,'to_date');
    if(from>to) throw new BadRequestException('from_date cannot be after to_date');
    return this.transaction(c, null, async(client)=>{
      const workerResult=await client.query<Row>(
        `SELECT id::text AS id,employee_code,display_name FROM workforce_workers
         WHERE linked_user_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' LIMIT 1`,
        [c.userId,c.tenantId,c.factoryId],
      );
      const worker=workerResult.rows[0];
      if(!worker) return {worker:null,attendance:[],overtime:[]};
      const attendance=await client.query<Row>(
        `SELECT e.id::text AS id,e.event_type,e.source_type,e.occurred_at::text AS occurred_at,a.shift_date::text AS shift_date
         FROM workforce_attendance_events e JOIN workforce_shift_assignments a
          ON a.id=e.shift_assignment_id AND a.tenant_id=e.tenant_id AND a.factory_id=e.factory_id
         WHERE e.worker_id=$1 AND e.tenant_id=$2 AND e.factory_id=$3 AND a.shift_date BETWEEN $4::date AND $5::date
         ORDER BY e.occurred_at`,
        [String(worker.id),c.tenantId,c.factoryId,from,to],
      );
      const overtime=await client.query<Row>(
        `SELECT o.id::text AS id,a.shift_date::text AS shift_date,o.requested_minutes,o.approved_minutes,o.status,
         o.reason,o.decision_reason,o.created_at::text AS created_at
         FROM workforce_overtime_requests o JOIN workforce_shift_assignments a
          ON a.id=o.shift_assignment_id AND a.tenant_id=o.tenant_id AND a.factory_id=o.factory_id
         WHERE o.worker_id=$1 AND o.tenant_id=$2 AND o.factory_id=$3 AND a.shift_date BETWEEN $4::date AND $5::date
         ORDER BY a.shift_date DESC`,
        [String(worker.id),c.tenantId,c.factoryId,from,to],
      );
      return {worker,attendance:attendance.rows,overtime:overtime.rows,from_date:from,to_date:to};
    });
  }

  private async workerDetail(client:PoolClient,c:WorkforceContext,id:string) {
    const result=await client.query<Row>(
      `SELECT id::text AS id,employee_code,display_name,linked_user_id::text AS linked_user_id,status,
       biometric_consent_at::text AS biometric_consent_at,biometric_consent_withdrawn_at::text AS biometric_consent_withdrawn_at,
       row_version::int AS row_version,created_at::text AS created_at,updated_at::text AS updated_at
       FROM workforce_workers WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id,c.tenantId,c.factoryId],
    );
    if(!result.rows[0]) throw new NotFoundException('Worker was not found in this factory');
    return result.rows[0];
  }
  private async skillDetail(client:PoolClient,c:WorkforceContext,id:string) {
    const r=await client.query<Row>(`SELECT id::text AS id,skill_code,name,description,status,row_version::int AS row_version
      FROM workforce_skills WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,[id,c.tenantId,c.factoryId]);
    if(!r.rows[0]) throw new NotFoundException('Skill was not found in this factory');
    return r.rows[0];
  }
  private async workerSkills(client:PoolClient,c:WorkforceContext,worker:string) {
    const r=await client.query<Row>(
      `SELECT ws.id::text AS id,ws.skill_id::text AS skill_id,s.skill_code,s.name,ws.skill_level,
       ws.certified_on::text AS certified_on,ws.certificate_expires_on::text AS certificate_expires_on,
       ws.certificate_reference,ws.status,ws.row_version::int AS row_version
       FROM workforce_worker_skills ws JOIN workforce_skills s ON s.id=ws.skill_id AND s.tenant_id=ws.tenant_id AND s.factory_id=ws.factory_id
       WHERE ws.worker_id=$1 AND ws.tenant_id=$2 AND ws.factory_id=$3 ORDER BY s.skill_code,ws.created_at DESC`,
      [worker,c.tenantId,c.factoryId]);
    return {worker_id:worker,skills:r.rows};
  }
  private async shiftDetail(client:PoolClient,c:WorkforceContext,id:string) {
    const r=await client.query<Row>(`SELECT id::text AS id,shift_code,name,starts_at_local::text AS starts_at_local,
      ends_at_local::text AS ends_at_local,timezone_name,unpaid_break_minutes,late_grace_minutes,
      overtime_threshold_minutes,status,row_version::int AS row_version
      FROM workforce_shift_templates WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,[id,c.tenantId,c.factoryId]);
    if(!r.rows[0]) throw new NotFoundException('Shift template was not found in this factory');
    return r.rows[0];
  }
  private async assignmentDetail(client:PoolClient,c:WorkforceContext,id:string) {
    const r=await client.query<Row>(
      `SELECT a.id::text AS id,a.shift_template_id::text AS shift_template_id,a.worker_id::text AS worker_id,
       w.employee_code,w.display_name,s.shift_code,s.name AS shift_name,a.shift_date::text AS shift_date,
       a.planned_start_at::text AS planned_start_at,a.planned_end_at::text AS planned_end_at,
       a.work_order_id::text AS work_order_id,a.work_order_operation_id::text AS work_order_operation_id,
       a.operation_code,a.required_skill_code,a.status,a.row_version::int AS row_version,a.last_change_reason,
       a.created_at::text AS created_at,a.updated_at::text AS updated_at
       FROM workforce_shift_assignments a
       JOIN workforce_workers w ON w.id=a.worker_id AND w.tenant_id=a.tenant_id AND w.factory_id=a.factory_id
       JOIN workforce_shift_templates s ON s.id=a.shift_template_id AND s.tenant_id=a.tenant_id AND s.factory_id=a.factory_id
       WHERE a.id=$1 AND a.tenant_id=$2 AND a.factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0]) throw new NotFoundException('Staffing assignment was not found in this factory');
    return r.rows[0];
  }
  private async attendanceDetail(client:PoolClient,c:WorkforceContext,id:string) {
    const r=await client.query<Row>(
      `SELECT e.id::text AS id,e.event_type,e.source_type,e.source_event_id,e.occurred_at::text AS occurred_at,
       e.shift_assignment_id::text AS shift_assignment_id,e.worker_id::text AS worker_id,w.employee_code,w.display_name,
       e.capture_metadata,e.created_at::text AS captured_at
       FROM workforce_attendance_events e JOIN workforce_workers w
        ON w.id=e.worker_id AND w.tenant_id=e.tenant_id AND w.factory_id=e.factory_id
       WHERE e.id=$1 AND e.tenant_id=$2 AND e.factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0]) throw new NotFoundException('Attendance event was not found in this factory');
    return r.rows[0];
  }
  private async overtimeDetail(client:PoolClient,c:WorkforceContext,id:string) {
    const r=await client.query<Row>(
      `SELECT o.id::text AS id,o.worker_id::text AS worker_id,w.employee_code,w.display_name,
       o.shift_assignment_id::text AS shift_assignment_id,a.shift_date::text AS shift_date,
       o.requested_minutes,o.approved_minutes,o.status,o.reason,o.decision_reason,
       o.created_by_user_id::text AS requested_by_user_id,o.decided_by_user_id::text AS decided_by_user_id,
       o.decided_at::text AS decided_at,o.row_version::int AS row_version,o.created_at::text AS created_at
       FROM workforce_overtime_requests o JOIN workforce_workers w
        ON w.id=o.worker_id AND w.tenant_id=o.tenant_id AND w.factory_id=o.factory_id
       JOIN workforce_shift_assignments a ON a.id=o.shift_assignment_id AND a.tenant_id=o.tenant_id AND a.factory_id=o.factory_id
       WHERE o.id=$1 AND o.tenant_id=$2 AND o.factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0]) throw new NotFoundException('Overtime request was not found in this factory');
    return r.rows[0];
  }
  private async productivityDetail(client:PoolClient,c:WorkforceContext,id:string) {
    const r=await client.query<Row>(
      `SELECT p.id::text AS id,p.worker_id::text AS worker_id,w.employee_code,w.display_name,
       p.shift_assignment_id::text AS shift_assignment_id,p.work_order_id::text AS work_order_id,
       p.work_order_operation_id::text AS work_order_operation_id,p.operation_code,
       p.production_started_at::text AS production_started_at,p.production_ended_at::text AS production_ended_at,
       p.good_quantity::text AS good_quantity,p.scrap_quantity::text AS scrap_quantity,
       p.standard_minutes_per_unit::text AS standard_minutes_per_unit,p.actual_minutes::text AS actual_minutes,
       p.earned_minutes::text AS earned_minutes,p.efficiency_percent::text AS efficiency_percent,
       p.scrap_reason,p.notes,p.created_at::text AS captured_at
       FROM workforce_productivity_reports p JOIN workforce_workers w
        ON w.id=p.worker_id AND w.tenant_id=p.tenant_id AND w.factory_id=p.factory_id
       WHERE p.id=$1 AND p.tenant_id=$2 AND p.factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!r.rows[0]) throw new NotFoundException('Productivity report was not found in this factory');
    return r.rows[0];
  }

  private async findCommandReceipt(client:PoolClient,c:WorkforceContext,key:string,hash:string) {
    const result=await client.query<Row>(
      `SELECT request_hash,response_snapshot FROM workforce_command_receipts
       WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [c.tenantId,c.factoryId,key],
    );
    const row=result.rows[0];
    if(!row) return null;
    if(String(row.request_hash).trim()!==hash) throw new ConflictException('Idempotency key was already used with a different workforce command');
    return {response_snapshot:row.response_snapshot};
  }
  private async storeCommandReceipt(client:PoolClient,c:WorkforceContext,key:string,hash:string,entityType:string,entityId:string,response:Record<string,unknown>) {
    await client.query(
      `INSERT INTO workforce_command_receipts
       (tenant_id,factory_id,idempotency_key,request_hash,entity_type,entity_id,response_snapshot,recorded_by_user_id,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::uuid)`,
      [c.tenantId,c.factoryId,key,hash,entityType,entityId,JSON.stringify(response),c.userId,this.correlationId(c)],
    );
  }

  private async findIdempotent(client:PoolClient,table:string,c:WorkforceContext,key:string,hash:string) {
    // Table names are compile-time constants supplied only by this service's methods.
    const result=await client.query<Row>(
      `SELECT id::text AS id,request_hash FROM ${table}
       WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [c.tenantId,c.factoryId,key],
    );
    const row=result.rows[0];
    if(!row) return null;
    if(String(row.request_hash).trim()!==hash) throw new ConflictException('Idempotency key was already used with a different workforce request');
    return {id:String(row.id)};
  }
  private async insertSupplementalAudit(client:PoolClient,c:WorkforceContext,entityType:string,entityId:string,version:number,action:string,reason:string,data:Record<string,unknown>) {
    await client.query(
      `INSERT INTO workforce_audit_events
       (tenant_id,factory_id,entity_type,entity_id,entity_version,action,actor_user_id,reason,event_data,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid)`,
      [c.tenantId,c.factoryId,entityType,entityId,version,action, c.userId,reason,JSON.stringify(data),this.correlationId(c)],
    );
  }
  private async transaction<T>(c:WorkforceContext,lock:string|null,run:(client:PoolClient)=>Promise<T>) {
    return this.database.transaction(run,{
      tenantId:c.tenantId,userId:c.userId,requestId:c.requestId??null,traceId:c.traceId??null,
      advisoryLockKey:lock? `${c.tenantId}:${c.factoryId}:${lock}`:null,
    });
  }
  private dbContext(c:WorkforceContext) {
    return {tenantId:c.tenantId,userId:c.userId,requestId:c.requestId??null,traceId:c.traceId??null};
  }
  private validateContext(c:WorkforceContext) {
    if(!isUUID(c.userId)||!isUUID(c.tenantId)||!isUUID(c.factoryId)) {
      throw new BadRequestException('Authenticated user, tenant and factory UUID context is required');
    }
  }
  private uuid(value:string,field:string) {
    const v=value?.trim();
    if(!v||!isUUID(v)) throw new BadRequestException(`${field} must be a valid UUID`);
    return v.toLowerCase();
  }
  private idempotencyKey(value:string|null) {
    const key=value?.trim();
    if(!key||key.length>255) throw new BadRequestException('A non-empty Idempotency-Key of at most 255 characters is required');
    return key;
  }
  private hash(value:unknown) {
    return createHash('sha256').update(this.canonical(value)).digest('hex');
  }
  private canonical(value:unknown):string {
    if(Array.isArray(value)) return `[${value.map(v=>this.canonical(v)).join(',')}]`;
    if(value&&typeof value==='object') {
      const entries=Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b));
      return `{${entries.map(([k,v])=>`${JSON.stringify(k)}:${this.canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value)??'null';
  }
  private requiredText(value:string,field:string,max:number) {
    const v=value?.trim();
    if(!v||v.length>max) throw new BadRequestException(`${field} must contain 1-${max} characters`);
    return v;
  }
  private optionalText(value:string|undefined|null,max:number) {
    const v=value?.trim()??'';
    if(v.length>max) throw new BadRequestException(`Text value exceeds ${max} characters`);
    return v||null;
  }
  private dateOnly(value:string|undefined,field:string):string;
  private dateOnly(value:string|undefined,field:string,optional:true):string|null;
  private dateOnly(value:string|undefined,field:string,optional=false):string|null {
    if(!value&&optional) return null;
    if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
    const d=new Date(`${value}T00:00:00.000Z`);
    if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value) throw new BadRequestException(`${field} is not a valid calendar date`);
    return value;
  }
  private timestamp(value:string,field:string) {
    const d=new Date(value);
    if(Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be a valid ISO-8601 timestamp`);
    return d.toISOString();
  }
  private time(value:string,field:string) {
    if(!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) throw new BadRequestException(`${field} must use HH:mm or HH:mm:ss`);
    return value.length===5?`${value}:00`:value;
  }
  private timezone(value:string) {
    const v=this.requiredText(value,'timezone_name',80);
    try { new Intl.DateTimeFormat('en-US',{timeZone:v}).format(new Date(0)); }
    catch { throw new BadRequestException('timezone_name must be a valid IANA time zone'); }
    return v;
  }
  private localToUtc(date:string,time:string,zone:string):Date {
    const [year,month,day]=date.split('-').map(Number);
    const [hour,minute,second]=time.split(':').map(Number);
    const expected=Date.UTC(year,month-1,day,hour,minute,second??0);
    let candidate=expected;
    const formatter=new Intl.DateTimeFormat('en-GB',{
      timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
    });
    for(let i=0;i<6;i++) {
      const parts=Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(p=>[p.type,p.value]));
      const rendered=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
      const difference=expected-rendered;
      if(difference===0) {
        const actual=Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(p=>[p.type,p.value]));
        if(Number(actual.year)!==year||Number(actual.month)!==month||Number(actual.day)!==day||
          Number(actual.hour)!==hour||Number(actual.minute)!==minute||Number(actual.second)!==(second??0)) break;
        for(const delta of [-60*60*1000,60*60*1000]) {
          const alternative=new Date(candidate+delta);
          const alternate=Object.fromEntries(formatter.formatToParts(alternative).map(p=>[p.type,p.value]));
          if(Number(alternate.year)===year&&Number(alternate.month)===month&&Number(alternate.day)===day&&
             Number(alternate.hour)===hour&&Number(alternate.minute)===minute&&Number(alternate.second)===(second??0)) {
            throw new BadRequestException(`Local shift time ${date} ${time} is ambiguous in ${zone}; the shift must not cross a daylight-saving overlap`);
          }
        }
        return new Date(candidate);
      }
      candidate+=difference;
    }
    throw new BadRequestException(`Local shift time ${date} ${time} does not exist or is ambiguous in ${zone}`);
  }
  private addDays(date:string,amount:number) {
    const d=new Date(`${date}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate()+amount);
    return d.toISOString().slice(0,10);
  }
  private quantity(value:number,field:string) {
    if(!Number.isFinite(value)||value<0) throw new BadRequestException(`${field} must be a non-negative finite number`);
    const rounded=Math.round(value*10000)/10000;
    if(Math.abs(value-rounded)>1e-8) throw new BadRequestException(`${field} supports at most four decimal places`);
    return rounded;
  }
  private positiveMinutes(value:number,field:string) {
    if(!Number.isFinite(value)||value<=0||value>1440) throw new BadRequestException(`${field} must be greater than zero and at most 1440 minutes`);
    const rounded=Math.round(value*10000)/10000;
    if(Math.abs(value-rounded)>1e-8) throw new BadRequestException(`${field} supports at most four decimal places`);
    return rounded;
  }
  private limit(value:number|undefined) {
    if(value===undefined) return 50;
    if(!Number.isInteger(value)||value<1||value>200) throw new BadRequestException('limit must be an integer between 1 and 200');
    return value;
  }
  private jsonObject(value:Record<string,unknown>) {
    if(value===null||Array.isArray(value)||typeof value!=='object') throw new BadRequestException('capture_metadata must be a JSON object');
    const encoded=JSON.stringify(value);
    if(encoded.length>16000) throw new BadRequestException('capture_metadata exceeds the 16 KB limit');
    return JSON.parse(encoded) as Record<string,unknown>;
  }
  private correlationId(c:WorkforceContext) {
    return c.traceId&&isUUID(c.traceId)?c.traceId:randomUUID();
  }
}
