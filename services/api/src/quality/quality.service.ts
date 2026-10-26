import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CloseQualityNcrDto, CreateQualityDefectDto, CreateQualityDefectLinkDto, CreateQualityInspectionDto,
  CreateQualityInspectionPlanDto, CreateQualityInspectionResultDto, CreateQualityNcrActionDto,
  CreateQualityReworkOrderDto, ListQualityInspectionsQueryDto, ListQualityPlansQueryDto,
  ListQualityReworkOrdersQueryDto, QualityDispositionDto, QualityInspectionDecisionDto,
  QualityInspectionPlanTransitionDto, QualityNcrActionTransitionDto, QualityNcrActionVerificationDto,
  QualityReworkTransitionDto,
} from './quality.dto';
interface QualityContext {
  userId: string; tenantId: string; factoryId: string; requestId?: string | null; traceId?: string | null;
}

const INSPECTION_COLUMNS =
  "id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, " +
  "inspection_type, target_type, target_id::text AS target_id, inventory_item_id::text AS inventory_item_id, " +
  "traceability_unit_id::text AS traceability_unit_id, plan_code, plan_id::text AS plan_id, plan_revision, criteria_snapshot, status, sample_quantity::text AS sample_quantity, " +
  "notes, row_version::int AS row_version, idempotency_key, request_hash, " +
  "created_by_user_id::text AS created_by_user_id, updated_by_user_id::text AS updated_by_user_id, " +
  "correlation_id::text AS correlation_id, created_at::text AS created_at, updated_at::text AS updated_at";

interface TargetBinding { inventory_item_id: string | null; traceability_unit_id: string | null; work_order_id: string | null; }

@Injectable()
export class QualityService {
  constructor(private readonly database: DatabaseService) {}

  async createInspection(c: QualityContext, dto: CreateQualityInspectionDto, rawKey: string | null) {
    this.validateScope(c);
    const key = this.key(rawKey);
    this.uuid(dto.target_id, 'target_id');
    const targetId = dto.target_id.toLowerCase();
    const planCode = dto.plan_code?.trim().toUpperCase() || null;
    if (planCode && !/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(planCode)) throw new BadRequestException('plan_code must be a valid code');
    if (['INCOMING','IN_PROCESS','FINAL'].includes(dto.inspection_type) && !planCode) throw new BadRequestException('plan_code is required for incoming, in-process and final inspections');
    const quantity = dto.sample_quantity === undefined ? null : this.quantity(dto.sample_quantity, 'sample_quantity');
    const notes = dto.notes?.trim() || null;
    const hash = this.hash({ type: dto.inspection_type, target_type: dto.target_type, target_id: targetId, plan_code: planCode, sample_quantity: quantity, notes });
    const correlation = this.correlation(c);
    const result = await this.database.transaction(c, async client => {
      await this.lockKey(client, c, 'inspection', key);
      const old = await client.query("SELECT id::text AS id, request_hash FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",
        [c.tenantId, c.factoryId, key]);
      if (old.rows[0]) {
        if (String(old.rows[0].request_hash).trim() !== hash) throw new ConflictException('Idempotency-Key was already used for another quality inspection');
        return { id: String(old.rows[0].id), replayed: true };
      }
      if (planCode) {
        const activePlan = await client.query(
          "SELECT id FROM quality_inspection_plans WHERE tenant_id=$1 AND factory_id=$2 AND lower(plan_code)=lower($3) AND inspection_type=$4 AND status='ACTIVE' LIMIT 1",
          [c.tenantId, c.factoryId, planCode, dto.inspection_type]);
        if (!activePlan.rows[0]) throw new ConflictException('No ACTIVE inspection plan matches plan_code and inspection_type in this factory');
      }
      const target = await this.resolveTarget(client, c, dto.target_type, targetId);
      const inserted = await client.query(
        "INSERT INTO quality_inspections (tenant_id,factory_id,inspection_type,target_type,target_id,inventory_item_id,traceability_unit_id,plan_code,sample_quantity,notes,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id) " +
        "VALUES ($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8,$9::numeric,$10,$11,$12,$13,$13,$14::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,dto.inspection_type,dto.target_type,targetId,target.inventory_item_id,target.traceability_unit_id,planCode,quantity,notes,key,hash,c.userId,correlation]);
      const id = String(inserted.rows[0]?.id ?? '');
      if (!id) throw new Error('QUALITY_INSPECTION_INSERT_FAILED');
      await this.inspectionEvent(client,c,{id,version:1,from:null,to:'OPEN',action:'CREATED',reason:notes,hash,correlation,key:'quality-inspection-event:'+id+':1'});
      await this.auditOutbox(client,c,{inspectionId:id,action:'INSPECTION_CREATED',correlation,payload:{inspection_type:dto.inspection_type,target_type:dto.target_type,target_id:targetId,plan_code:planCode}});
      return {id,replayed:false};
    });
    return { ...(await this.getInspection(c,result.id)), replayed:result.replayed };
  }


  async createInspectionPlan(c: QualityContext, dto: CreateQualityInspectionPlanDto, rawKey: string | null) {
    this.validateScope(c);
    const key = this.key(rawKey);
    const planCode = this.text(dto.plan_code, 'plan_code', 100).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(planCode)) throw new BadRequestException('plan_code must be a valid code');
    const name = this.text(dto.name, 'name', 255);
    if (!Array.isArray(dto.criteria) || dto.criteria.length < 1 || dto.criteria.length > 100) {
      throw new BadRequestException('an inspection plan requires between 1 and 100 criteria');
    }
    const criteria = dto.criteria.map((criterion, index) => this.normalizePlanCriterion(criterion, index));
    const criterionCodes = criteria.map(item => item.criterion_code);
    const sequences = criteria.map(item => item.sequence_number);
    if (new Set(criterionCodes).size !== criterionCodes.length) throw new BadRequestException('criterion_code values must be unique in a plan');
    if (new Set(sequences).size !== sequences.length) throw new BadRequestException('criterion sequence_number values must be unique in a plan');
    const sampleQuantity = dto.default_sample_quantity === undefined ? null : this.quantity(dto.default_sample_quantity, 'default_sample_quantity');
    const notes = dto.notes?.trim() || null;
    const hash = this.hash({
      plan_code: planCode, name, inspection_type: dto.inspection_type,
      default_sample_quantity: sampleQuantity, notes, criteria,
    });
    const correlation = this.correlation(c);
    const result = await this.database.transaction(c, async client => {
      await this.lockKey(client, c, 'plan-idempotency', key);
      const existing = await client.query(
        "SELECT id::text AS id, request_hash FROM quality_inspection_plans WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",
        [c.tenantId, c.factoryId, key]);
      if (existing.rows[0]) {
        if (String(existing.rows[0].request_hash).trim() !== hash) {
          throw new ConflictException('Idempotency-Key was already used for a different inspection plan');
        }
        return { id: String(existing.rows[0].id), replayed: true };
      }
      await this.lockKey(client, c, 'plan-code', planCode + ':' + dto.inspection_type);
      const revisionResult = await client.query(
        "SELECT COALESCE(MAX(revision),0)::int+1 AS revision FROM quality_inspection_plans WHERE tenant_id=$1 AND factory_id=$2 AND lower(plan_code)=lower($3)",
        [c.tenantId, c.factoryId, planCode]);
      const revision = Number(revisionResult.rows[0]?.revision ?? 1);
      const inserted = await client.query(
        "INSERT INTO quality_inspection_plans (tenant_id,factory_id,plan_code,revision,name,inspection_type,default_sample_quantity,notes,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11,$11,$12::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,planCode,revision,name,dto.inspection_type,sampleQuantity,notes,key,hash,c.userId,correlation]);
      const planId = String(inserted.rows[0]?.id ?? '');
      if (!planId) throw new Error('QUALITY_INSPECTION_PLAN_INSERT_FAILED');
      for (const criterion of criteria) {
        await client.query(
          "INSERT INTO quality_inspection_plan_criteria (tenant_id,factory_id,plan_id,criterion_code,name,description,value_type,comparison_operator,target_value,lower_limit,upper_limit,allowed_values,unit,is_required,is_critical,sequence_number,created_by_user_id) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11::numeric,$12::jsonb,$13,$14,$15,$16,$17)",
          [c.tenantId,c.factoryId,planId,criterion.criterion_code,criterion.name,criterion.description,
           criterion.value_type,criterion.comparison_operator,criterion.target_value,criterion.lower_limit,
           criterion.upper_limit,JSON.stringify(criterion.allowed_values),criterion.unit,criterion.is_required,
           criterion.is_critical,criterion.sequence_number,c.userId]);
      }
      await this.auditOutbox(client,c,{
        action:'INSPECTION_PLAN_CREATED',correlation,
        aggregateType:'QUALITY_PLAN',aggregateId:planId,outboxEvent:'QUALITY.PLAN_CHANGED',
        payload:{plan_id:planId,plan_code:planCode,revision,inspection_type:dto.inspection_type,status:'DRAFT',criteria_count:criteria.length},
      });
      return { id:planId, replayed:false };
    });
    return { ...(await this.getInspectionPlan(c,result.id)), replayed:result.replayed };
  }

  async listInspectionPlans(c: QualityContext, query: ListQualityPlansQueryDto) {
    this.validateScope(c);
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    const result = await this.database.query(
      "SELECT p.id::text AS id,p.plan_code,p.revision,p.name,p.inspection_type,p.status," +
      "p.default_sample_quantity::text AS default_sample_quantity,p.notes,p.row_version::int AS row_version," +
      "p.activated_by_user_id::text AS activated_by_user_id,p.activated_at::text AS activated_at,p.retired_at::text AS retired_at," +
      "p.created_by_user_id::text AS created_by_user_id,p.created_at::text AS created_at," +
      "COALESCE((SELECT jsonb_agg(jsonb_build_object('criterion_code',c.criterion_code,'name',c.name,'description',c.description," +
      "'value_type',c.value_type,'comparison_operator',c.comparison_operator,'target_value',c.target_value," +
      "'lower_limit',c.lower_limit,'upper_limit',c.upper_limit,'allowed_values',c.allowed_values,'unit',c.unit," +
      "'is_required',c.is_required,'is_critical',c.is_critical,'sequence_number',c.sequence_number) ORDER BY c.sequence_number,c.criterion_code) " +
      "FROM quality_inspection_plan_criteria c WHERE c.plan_id=p.id AND c.tenant_id=p.tenant_id AND c.factory_id=p.factory_id),'[]'::jsonb) AS criteria " +
      "FROM quality_inspection_plans p WHERE p.tenant_id=$1 AND p.factory_id=$2 " +
      "AND ($3::text IS NULL OR p.inspection_type=$3) AND ($4::text IS NULL OR p.status=$4) " +
      "ORDER BY lower(p.plan_code),p.revision DESC LIMIT $5",
      [c.tenantId,c.factoryId,query.inspection_type??null,query.status??null,limit],
      {tenantId:c.tenantId,userId:c.userId});
    return result.rows;
  }

  async getInspectionPlan(c: QualityContext, planId: string) {
    this.validateScope(c);
    this.uuid(planId,'planId');
    const result = await this.database.query(
      "SELECT p.id::text AS id,p.plan_code,p.revision,p.name,p.inspection_type,p.status," +
      "p.default_sample_quantity::text AS default_sample_quantity,p.notes,p.row_version::int AS row_version," +
      "p.activated_by_user_id::text AS activated_by_user_id,p.activated_at::text AS activated_at,p.retired_at::text AS retired_at," +
      "p.created_by_user_id::text AS created_by_user_id,p.updated_by_user_id::text AS updated_by_user_id," +
      "p.created_at::text AS created_at,p.updated_at::text AS updated_at," +
      "COALESCE((SELECT jsonb_agg(jsonb_build_object('criterion_code',c.criterion_code,'name',c.name,'description',c.description," +
      "'value_type',c.value_type,'comparison_operator',c.comparison_operator,'target_value',c.target_value," +
      "'lower_limit',c.lower_limit,'upper_limit',c.upper_limit,'allowed_values',c.allowed_values,'unit',c.unit," +
      "'is_required',c.is_required,'is_critical',c.is_critical,'sequence_number',c.sequence_number) ORDER BY c.sequence_number,c.criterion_code) " +
      "FROM quality_inspection_plan_criteria c WHERE c.plan_id=p.id AND c.tenant_id=p.tenant_id AND c.factory_id=p.factory_id),'[]'::jsonb) AS criteria " +
      "FROM quality_inspection_plans p WHERE p.id=$1 AND p.tenant_id=$2 AND p.factory_id=$3",
      [planId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    if (!result.rows[0]) throw new NotFoundException('Quality inspection plan was not found in this factory');
    return result.rows[0];
  }

  async transitionInspectionPlan(c: QualityContext, planId: string, dto: QualityInspectionPlanTransitionDto) {
    this.validateScope(c); this.uuid(planId,'planId');
    const reason = dto.reason?.trim() || null;
    if (dto.action === 'RETIRE' && !reason) throw new BadRequestException('reason is required to retire an inspection plan');
    const correlation = this.correlation(c);
    await this.database.transaction(c, async client => {
      const found = await client.query(
        "SELECT id::text AS id,status,row_version::int AS row_version,plan_code,revision,inspection_type FROM quality_inspection_plans WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",
        [planId,c.tenantId,c.factoryId]);
      const plan = found.rows[0];
      if (!plan) throw new NotFoundException('Quality inspection plan was not found in this factory');
      if (Number(plan.row_version) !== dto.expected_version) throw new ConflictException('Inspection-plan version is stale');
      const status = String(plan.status);
      if (dto.action === 'ACTIVATE') {
        if (status !== 'DRAFT') throw new ConflictException('Only a draft inspection plan can be activated');
        await this.lockKey(client,c,'plan-code',String(plan.plan_code).toUpperCase()+':'+String(plan.inspection_type));
        const activeRevision = await client.query(
          "SELECT id::text AS id FROM quality_inspection_plans WHERE tenant_id=$1 AND factory_id=$2 AND lower(plan_code)=lower($3) AND inspection_type=$4 AND status='ACTIVE' FOR UPDATE",
          [c.tenantId,c.factoryId,plan.plan_code,plan.inspection_type]);
        if (activeRevision.rows[0]) throw new ConflictException('Retire the currently active plan revision before activating its replacement');
        const count = await client.query(
          "SELECT count(*)::int AS count FROM quality_inspection_plan_criteria WHERE plan_id=$1 AND tenant_id=$2 AND factory_id=$3",
          [planId,c.tenantId,c.factoryId]);
        if (Number(count.rows[0]?.count ?? 0) < 1) throw new ConflictException('An inspection plan needs at least one criterion before activation');
      } else if (status !== 'ACTIVE') {
        throw new ConflictException('Only an active inspection plan can be retired');
      }
      const update = dto.action === 'ACTIVATE'
        ? await client.query(
          "UPDATE quality_inspection_plans SET status='ACTIVE',row_version=row_version+1,updated_by_user_id=$1,activated_by_user_id=$1,activated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND row_version=$5",
          [c.userId,planId,c.tenantId,c.factoryId,plan.row_version])
        : await client.query(
          "UPDATE quality_inspection_plans SET status='RETIRED',row_version=row_version+1,updated_by_user_id=$1,retired_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND row_version=$5",
          [c.userId,planId,c.tenantId,c.factoryId,plan.row_version]);
      if (update.rowCount !== 1) throw new ConflictException('Inspection plan changed during transition');
      await this.auditOutbox(client,c,{
        action:'INSPECTION_PLAN_'+dto.action,correlation,aggregateType:'QUALITY_PLAN',aggregateId:planId,
        outboxEvent:'QUALITY.PLAN_CHANGED',
        payload:{plan_id:planId,plan_code:plan.plan_code,revision:plan.revision,inspection_type:plan.inspection_type,
          from_status:status,to_status:dto.action==='ACTIVATE'?'ACTIVE':'RETIRED',reason,expected_version:dto.expected_version},
      });
    });
    return this.getInspectionPlan(c,planId);
  }

  async recordInspectionResult(c: QualityContext, inspectionId: string, dto: CreateQualityInspectionResultDto, rawKey: string | null) {
    this.validateScope(c); this.uuid(inspectionId,'inspectionId');
    const key=this.key(rawKey), code=this.text(dto.criterion_code,'criterion_code',100).toUpperCase();
    if(!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(code)) throw new BadRequestException('criterion_code must be a valid code');
    const observed=this.text(dto.observed_value,'observed_value',1000);
    const notes=dto.notes?.trim()||null, evidence=this.jsonObject(dto.evidence), correlation=this.correlation(c);
    const hash=this.hash({inspection_id:inspectionId,criterion_code:code,observed_value:observed,notes,evidence});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'inspection-result',key);
      const existing=await client.query("SELECT id::text AS id,request_hash FROM quality_inspection_results WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",
        [c.tenantId,c.factoryId,key]);
      if(existing.rows[0]){
        if(String(existing.rows[0].request_hash).trim()!==hash) throw new ConflictException('Idempotency-Key was already used for a different inspection result');
        return {id:String(existing.rows[0].id),replayed:true};
      }
      const found=await client.query("SELECT "+INSPECTION_COLUMNS+" FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",
        [inspectionId,c.tenantId,c.factoryId]);
      const inspection=found.rows[0] as Record<string,unknown>|undefined;
      if(!inspection) throw new NotFoundException('Quality inspection was not found in this factory');
      if(!['OPEN','IN_PROGRESS'].includes(String(inspection.status))) throw new ConflictException('Inspection results can only be recorded while the inspection is open or in progress');
      if(!inspection.plan_id) throw new ConflictException('Select an active versioned inspection plan before recording criterion results');
      const snapshot=this.jsonArray(inspection.criteria_snapshot);
      const criterion=snapshot.find(item=>String(item.criterion_code).toUpperCase()===code);
      if(!criterion) throw new BadRequestException('criterion_code is not included in this inspection plan snapshot');
      const outcome=this.evaluateCriterion(criterion,observed);
      const attemptResult=await client.query("SELECT COALESCE(MAX(attempt),0)::int+1 AS attempt FROM quality_inspection_results WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND criterion_code=$4",
        [inspectionId,c.tenantId,c.factoryId,code]);
      const attempt=Number(attemptResult.rows[0]?.attempt??1);
      const inserted=await client.query("INSERT INTO quality_inspection_results (tenant_id,factory_id,inspection_id,plan_id,plan_revision,criterion_code,criterion_snapshot,attempt,observed_value,outcome,notes,evidence,idempotency_key,request_hash,actor_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,inspectionId,inspection.plan_id,inspection.plan_revision,code,JSON.stringify(criterion),attempt,observed,outcome,notes,JSON.stringify(evidence),key,hash,c.userId,correlation]);
      const id=String(inserted.rows[0]?.id??'');if(!id)throw new Error('QUALITY_INSPECTION_RESULT_INSERT_FAILED');
      await this.auditOutbox(client,c,{
        inspectionId,action:'INSPECTION_RESULT_RECORDED',correlation,
        aggregateType:'QUALITY_INSPECTION',aggregateId:inspectionId,outboxEvent:'QUALITY.INSPECTION_RESULT_RECORDED',
        payload:{result_id:id,criterion_code:code,attempt,observed_value:observed,outcome,notes},
      });
      return {id,replayed:false};
    });
    const resultRow=await this.database.query("SELECT id::text AS id,inspection_id::text AS inspection_id,plan_id::text AS plan_id,plan_revision,criterion_code,criterion_snapshot,attempt,observed_value,outcome,notes,evidence,actor_user_id::text AS actor_user_id,created_at::text AS created_at FROM quality_inspection_results WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {...resultRow.rows[0],replayed:result.replayed};
  }

  async listInspections(c: QualityContext, query: ListQualityInspectionsQueryDto) {
    this.validateScope(c);
    const limit=query.limit ?? 50;
    if (!Number.isInteger(limit)||limit<1||limit>100) throw new BadRequestException('limit must be between 1 and 100');
    const r=await this.database.query(
      "SELECT "+INSPECTION_COLUMNS+", (SELECT count(*)::int FROM quality_defects d WHERE d.inspection_id=quality_inspections.id AND d.tenant_id=quality_inspections.tenant_id AND d.factory_id=quality_inspections.factory_id) AS defect_count, " +
      "EXISTS(SELECT 1 FROM quality_holds h WHERE h.inspection_id=quality_inspections.id AND h.tenant_id=quality_inspections.tenant_id AND h.factory_id=quality_inspections.factory_id AND h.status='ACTIVE') AS on_quality_hold " +
      "FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR inspection_type=$4) AND ($5::text IS NULL OR target_type=$5) " +
      "ORDER BY created_at DESC,id DESC LIMIT $6",
      [c.tenantId,c.factoryId,query.status??null,query.inspection_type??null,query.target_type??null,limit],
      {tenantId:c.tenantId,userId:c.userId});
    return r.rows;
  }

  async getInspection(c: QualityContext, id: string) {
    this.validateScope(c); this.uuid(id,'inspectionId');
    const r=await this.database.query("SELECT "+INSPECTION_COLUMNS+" FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    const inspection=r.rows[0];
    if(!inspection) throw new NotFoundException('Quality inspection was not found in this factory');
    const [defects,holds,dispositions,ncrResult,results]=await Promise.all([
      this.database.query("SELECT id::text AS id,defect_code,severity,affected_quantity::text AS affected_quantity,description,evidence,status,row_version::int AS row_version,reported_by_user_id::text AS reported_by_user_id,created_at::text AS created_at,updated_at::text AS updated_at FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query("SELECT id::text AS id,inventory_item_id::text AS inventory_item_id,traceability_unit_id::text AS traceability_unit_id,work_order_id::text AS work_order_id,status,reason,released_by_user_id::text AS released_by_user_id,released_at::text AS released_at,release_reason,created_at::text AS created_at FROM quality_holds WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query("SELECT id::text AS id,hold_id::text AS hold_id,action,status,quantity::text AS quantity,reason,inventory_item_id::text AS inventory_item_id,inventory_movement_id::text AS inventory_movement_id,created_by_user_id::text AS created_by_user_id,created_at::text AS created_at,completed_at::text AS completed_at FROM quality_dispositions WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query("SELECT id::text AS id,ncr_number,status,severity,title,summary,row_version::int AS row_version,created_at::text AS created_at,closed_at::text AS closed_at,closure_reason FROM quality_ncrs WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 LIMIT 1",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query("SELECT id::text AS id,plan_id::text AS plan_id,plan_revision,criterion_code,criterion_snapshot,attempt,observed_value,outcome,notes,evidence,actor_user_id::text AS actor_user_id,created_at::text AS created_at FROM quality_inspection_results WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY criterion_code,attempt DESC,created_at DESC",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
    ]);
    let ncr: Record<string,unknown>|null=null;
    if(ncrResult.rows[0]){
      const row=ncrResult.rows[0] as Record<string,unknown>;
      const actions=await this.database.query("SELECT id::text AS id,action_type,action_text,responsible_user_id::text AS responsible_user_id,due_date::text AS due_date,action_status,row_version::int AS row_version,started_by_user_id::text AS started_by_user_id,started_at::text AS started_at,completed_by_user_id::text AS completed_by_user_id,completed_at::text AS completed_at,completion_notes,completion_evidence,verified_by_user_id::text AS verified_by_user_id,verified_at::text AS verified_at,verification_notes,verification_evidence,recorded_by_user_id::text AS recorded_by_user_id,created_at::text AS created_at FROM quality_ncr_actions WHERE ncr_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [row.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
      const actionEvents=await this.database.query("SELECT id::text AS id,action_id::text AS action_id,version::int AS version,from_status,to_status,command,reason,evidence,actor_user_id::text AS actor_user_id,created_at::text AS created_at FROM quality_ncr_action_events WHERE ncr_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY action_id,version",
        [row.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
      const eventsByAction=new Map<string,Record<string,unknown>[]>();
      for(const event of actionEvents.rows){const actionKey=String(event.action_id);const group=eventsByAction.get(actionKey)??[];group.push(event);eventsByAction.set(actionKey,group);}
      ncr={...row,actions:actions.rows.map((action:Record<string,unknown>)=>({...action,events:eventsByAction.get(String(action.id))??[]}))};
    }
    return {...inspection,defects:defects.rows,holds:holds.rows,dispositions:dispositions.rows,results:results.rows,ncr};
  }

  async recordDefect(c: QualityContext, inspectionId: string, dto: CreateQualityDefectDto, rawKey: string|null) {
    this.validateScope(c); this.uuid(inspectionId,'inspectionId');
    const key=this.key(rawKey), code=this.text(dto.defect_code,'defect_code',100).toUpperCase();
    if(!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(code)) throw new BadRequestException('defect_code must be a valid code');
    const description=this.text(dto.description,'description',4000), quantity=this.quantity(dto.affected_quantity??1,'affected_quantity');
    const evidence=this.jsonObject(dto.evidence), correlation=this.correlation(c);
    const hash=this.hash({inspection_id:inspectionId,defect_code:code,severity:dto.severity,affected_quantity:quantity,description,evidence});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'defect',key);
      const old=await client.query("SELECT id::text AS id,request_hash FROM quality_defects WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[c.tenantId,c.factoryId,key]);
      if(old.rows[0]){
        if(String(old.rows[0].request_hash).trim()!==hash) throw new ConflictException('Idempotency-Key was already used for another quality defect');
        return {id:String(old.rows[0].id),replayed:true};
      }
      const parent=await client.query("SELECT status FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[inspectionId,c.tenantId,c.factoryId]);
      if(!parent.rows[0]) throw new NotFoundException('Quality inspection was not found in this factory');
      if(!['OPEN','IN_PROGRESS'].includes(String(parent.rows[0].status))) throw new ConflictException('Defects can only be added to open or in-progress inspections');
      const ins=await client.query(
        "INSERT INTO quality_defects (tenant_id,factory_id,inspection_id,defect_code,severity,affected_quantity,description,evidence,idempotency_key,request_hash,reported_by_user_id,updated_by_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8::jsonb,$9,$10,$11,$11,$12::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,inspectionId,code,dto.severity,quantity,description,JSON.stringify(evidence),key,hash,c.userId,correlation]);
      const defectId=String(ins.rows[0]?.id??'');
      if(!defectId) throw new Error('QUALITY_DEFECT_INSERT_FAILED');
      await client.query("INSERT INTO quality_defect_events (tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id) VALUES ($1,$2,$3,NULL,'OPEN','REPORTED',$4,$5,$6,$7,$8::uuid)",
        [c.tenantId,c.factoryId,defectId,description,key+':reported',this.hash({defect_id:defectId,hash,action:'REPORTED'}),c.userId,correlation]);
      await this.linkDefectToInspection(client,c,inspectionId,defectId,quantity,correlation);
      await this.auditOutbox(client,c,{inspectionId,defectId,action:'DEFECT_RECORDED',correlation,payload:{defect_code:code,severity:dto.severity,affected_quantity:quantity}});
      return {id:defectId,replayed:false};
    });
    const defect=await this.database.query("SELECT id::text AS id,inspection_id::text AS inspection_id,defect_code,severity,affected_quantity::text AS affected_quantity,description,evidence,status,row_version::int AS row_version,created_at::text AS created_at FROM quality_defects WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {...defect.rows[0],replayed:result.replayed};
  }


  async createDefectLink(c:QualityContext,defectId:string,dto:CreateQualityDefectLinkDto,rawKey:string|null){
    this.validateScope(c);this.uuid(defectId,'defectId');
    const key=this.key(rawKey),targetId=this.uuidValue(dto.target_id,'target_id');
    const quantity=dto.affected_quantity===undefined?null:this.quantity(dto.affected_quantity,'affected_quantity');
    const notes=dto.notes?.trim()||null,evidence=this.jsonObject(dto.evidence),correlation=this.correlation(c);
    const hash=this.hash({defect_id:defectId,link_type:dto.link_type,target_id:targetId,quantity,notes,evidence});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'defect-link',key);
      const old=await client.query("SELECT id::text AS id,request_hash FROM quality_defect_links WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[c.tenantId,c.factoryId,key]);
      if(old.rows[0]){
        if(String(old.rows[0].request_hash).trim()!==hash)throw new ConflictException('Idempotency-Key was already used for a different defect link');
        return{id:String(old.rows[0].id),replayed:true};
      }
      const defect=await client.query("SELECT id FROM quality_defects WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[defectId,c.tenantId,c.factoryId]);
      if(!defect.rows[0])throw new NotFoundException('Quality defect was not found in this factory');
      const linked=await this.insertDefectLink(client,c,{defectId,linkType:dto.link_type,targetId,source:'OPERATOR',quantity,notes,evidence,key,correlation});
      return{id:linked.id,replayed:false};
    });
    return{...(await this.getDefectLink(c,result.id)),replayed:result.replayed};
  }

  async getDefectLink(c:QualityContext,linkId:string){
    this.validateScope(c);this.uuid(linkId,'linkId');
    const q=await this.database.query("SELECT l.id::text AS id,l.defect_id::text AS defect_id,l.link_type,COALESCE(l.inventory_item_id,l.traceability_unit_id,l.order_id,l.order_line_id,l.work_order_id,l.work_order_operation_id,l.production_report_id,l.goods_receipt_line_id,l.rework_order_id)::text AS target_id,l.inventory_item_id::text AS inventory_item_id,l.traceability_unit_id::text AS traceability_unit_id,l.order_id::text AS order_id,l.order_line_id::text AS order_line_id,l.work_order_id::text AS work_order_id,l.work_order_operation_id::text AS work_order_operation_id,l.production_report_id::text AS production_report_id,l.goods_receipt_id::text AS goods_receipt_id,l.goods_receipt_line_id::text AS goods_receipt_line_id,l.rework_order_id::text AS rework_order_id,l.affected_quantity::text AS affected_quantity,l.link_source,l.notes,l.evidence,l.created_by_user_id::text AS created_by_user_id,l.created_at::text AS created_at,u.unit_code,u.unit_type,u.product_role,u.status AS traceability_status,o.order_number,wo.work_order_number,op.operation_code,r.good_quantity::text AS reported_good_quantity,r.scrap_quantity::text AS reported_scrap_quantity,gl.accepted_quantity::text AS grn_accepted_quantity,i.sku AS inventory_sku,i.name AS inventory_name FROM quality_defect_links l LEFT JOIN traceability_units u ON u.id=l.traceability_unit_id AND u.tenant_id=l.tenant_id AND u.factory_id=l.factory_id LEFT JOIN orders o ON o.id=l.order_id AND o.tenant_id=l.tenant_id AND o.factory_id=l.factory_id LEFT JOIN work_orders wo ON wo.id=l.work_order_id AND wo.tenant_id=l.tenant_id AND wo.factory_id=l.factory_id LEFT JOIN work_order_operations op ON op.id=l.work_order_operation_id AND op.work_order_id=l.work_order_id AND op.tenant_id=l.tenant_id AND op.factory_id=l.factory_id LEFT JOIN order_production_reports r ON r.id=l.production_report_id AND r.tenant_id=l.tenant_id AND r.factory_id=l.factory_id LEFT JOIN goods_receipt_lines gl ON gl.id=l.goods_receipt_line_id AND gl.goods_receipt_id=l.goods_receipt_id AND gl.tenant_id=l.tenant_id AND gl.factory_id=l.factory_id LEFT JOIN inventory_items i ON i.id=l.inventory_item_id AND i.tenant_id=l.tenant_id AND i.factory_id=l.factory_id WHERE l.id=$1 AND l.tenant_id=$2 AND l.factory_id=$3",
      [linkId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    if(!q.rows[0])throw new NotFoundException('Defect traceability link was not found in this factory');
    return q.rows[0];
  }

  async getDefectTraceability(c:QualityContext,defectId:string){
    this.validateScope(c);this.uuid(defectId,'defectId');
    const d=await this.database.query("SELECT d.id::text AS id,d.defect_code,d.severity,d.affected_quantity::text AS affected_quantity,d.description,d.status,d.row_version::int AS row_version,d.created_at::text AS created_at,qi.id::text AS inspection_id,qi.inspection_type,qi.status AS inspection_status,qi.target_type,qi.target_id::text AS target_id,qi.inventory_item_id::text AS inventory_item_id,qi.traceability_unit_id::text AS traceability_unit_id,n.id::text AS ncr_id,n.ncr_number,n.status AS ncr_status FROM quality_defects d JOIN quality_inspections qi ON qi.id=d.inspection_id AND qi.tenant_id=d.tenant_id AND qi.factory_id=d.factory_id LEFT JOIN quality_ncrs n ON n.inspection_id=qi.id AND n.tenant_id=qi.tenant_id AND n.factory_id=qi.factory_id WHERE d.id=$1 AND d.tenant_id=$2 AND d.factory_id=$3",
      [defectId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    if(!d.rows[0])throw new NotFoundException('Quality defect was not found in this factory');
    const links=await this.database.query("SELECT l.id::text AS id,l.link_type,COALESCE(l.inventory_item_id,l.traceability_unit_id,l.order_id,l.order_line_id,l.work_order_id,l.work_order_operation_id,l.production_report_id,l.goods_receipt_line_id,l.rework_order_id)::text AS target_id,l.inventory_item_id::text AS inventory_item_id,l.traceability_unit_id::text AS traceability_unit_id,l.order_id::text AS order_id,l.order_line_id::text AS order_line_id,l.work_order_id::text AS work_order_id,l.work_order_operation_id::text AS work_order_operation_id,l.production_report_id::text AS production_report_id,l.goods_receipt_id::text AS goods_receipt_id,l.goods_receipt_line_id::text AS goods_receipt_line_id,l.rework_order_id::text AS rework_order_id,l.affected_quantity::text AS affected_quantity,l.link_source,l.notes,l.evidence,l.created_at::text AS created_at,u.unit_code,u.unit_type,u.product_role,u.status AS unit_status,o.order_number,wo.work_order_number,op.operation_code,r.good_quantity::text AS reported_good_quantity,r.scrap_quantity::text AS reported_scrap_quantity,i.sku AS inventory_sku,i.name AS inventory_name FROM quality_defect_links l LEFT JOIN traceability_units u ON u.id=l.traceability_unit_id AND u.tenant_id=l.tenant_id AND u.factory_id=l.factory_id LEFT JOIN orders o ON o.id=l.order_id AND o.tenant_id=l.tenant_id AND o.factory_id=l.factory_id LEFT JOIN work_orders wo ON wo.id=l.work_order_id AND wo.tenant_id=l.tenant_id AND wo.factory_id=l.factory_id LEFT JOIN work_order_operations op ON op.id=l.work_order_operation_id AND op.work_order_id=l.work_order_id AND op.tenant_id=l.tenant_id AND op.factory_id=l.factory_id LEFT JOIN order_production_reports r ON r.id=l.production_report_id AND r.tenant_id=l.tenant_id AND r.factory_id=l.factory_id LEFT JOIN inventory_items i ON i.id=l.inventory_item_id AND i.tenant_id=l.tenant_id AND i.factory_id=l.factory_id WHERE l.defect_id=$1 AND l.tenant_id=$2 AND l.factory_id=$3 ORDER BY l.created_at,l.id",
      [defectId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    const rework=await this.database.query("SELECT id::text AS id,rework_number,status,input_quantity::text AS input_quantity,recovered_quantity::text AS recovered_quantity,scrap_quantity::text AS scrap_quantity,source_inventory_item_id::text AS source_inventory_item_id,source_traceability_unit_id::text AS source_traceability_unit_id,source_order_id::text AS source_order_id,source_order_line_id::text AS source_order_line_id,source_work_order_id::text AS source_work_order_id,source_work_order_operation_id::text AS source_work_order_operation_id,source_production_report_id::text AS source_production_report_id,source_goods_receipt_line_id::text AS source_goods_receipt_line_id,output_traceability_unit_id::text AS output_traceability_unit_id,follow_up_inspection_id::text AS follow_up_inspection_id,created_at::text AS created_at FROM quality_rework_orders WHERE defect_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
      [defectId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return{...d.rows[0],links:links.rows,rework_orders:rework.rows};
  }

  async decideInspection(c: QualityContext,id: string,dto: QualityInspectionDecisionDto,rawKey: string|null) {
    this.validateScope(c);this.uuid(id,'inspectionId');
    const key=this.key(rawKey),reason=dto.reason?.trim()||null;
    if(['FAIL','HOLD','CANCEL'].includes(dto.action)&&!reason) throw new BadRequestException('reason is required for FAIL, HOLD and CANCEL');
    const hash=this.hash({inspection_id:id,action:dto.action,expected_version:dto.expected_version,reason}),correlation=this.correlation(c);
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'inspection-decision',key);
      const old=await client.query("SELECT inspection_id::text AS inspection_id,request_hash FROM quality_inspection_events WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[c.tenantId,c.factoryId,key]);
      if(old.rows[0]){
        if(String(old.rows[0].request_hash).trim()!==hash) throw new ConflictException('Idempotency-Key was already used for another quality decision');
        return {id:String(old.rows[0].inspection_id),replayed:true};
      }
      const found=await client.query("SELECT "+INSPECTION_COLUMNS+" FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[id,c.tenantId,c.factoryId]);
      const q=found.rows[0] as Record<string,unknown>|undefined;
      if(!q) throw new NotFoundException('Quality inspection was not found in this factory');
      if(Number(q.row_version)!==dto.expected_version) throw new ConflictException('Quality inspection version is stale');
      let next=String(q.status);
      if(dto.action==='START'){
        if(!['OPEN','ON_HOLD'].includes(next)) throw new ConflictException('Only OPEN or rework-held inspections can start');
        if(next==='ON_HOLD'){
          const rw=await client.query("SELECT id FROM quality_dispositions WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND action='REWORK' AND status='RECORDED' LIMIT 1",[id,c.tenantId,c.factoryId]);
          if(!rw.rows[0]) throw new ConflictException('A held inspection requires a REWORK disposition before restart');
        }
        next='IN_PROGRESS';
      } else if(dto.action==='PASS'){
        if(next!=='IN_PROGRESS') throw new ConflictException('Only an in-progress inspection can pass');
        const open=await client.query("SELECT count(*)::int AS count FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='OPEN'",[id,c.tenantId,c.factoryId]);
        if(Number(open.rows[0]?.count??0)>0) throw new ConflictException('Resolve or disposition every open defect before passing an inspection');
        if(q.plan_id){
          const criteria=this.jsonArray(q.criteria_snapshot);
          const required=criteria.filter(criterion=>criterion.is_required!==false);
          const latest=await client.query("SELECT DISTINCT ON (criterion_code) criterion_code,outcome FROM quality_inspection_results WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY criterion_code,attempt DESC,created_at DESC",
            [id,c.tenantId,c.factoryId]);
          const outcomes=new Map<string,string>(latest.rows.map((row:Record<string,unknown>)=>[String(row.criterion_code),String(row.outcome)] as const));
          for(const criterion of required){
            const code=String(criterion.criterion_code);
            if(!outcomes.has(code)) throw new ConflictException('Record a result for every required inspection criterion before PASS: '+code);
            if(outcomes.get(code)!=='PASS') throw new ConflictException('Required inspection criterion has not passed: '+code);
          }
        }
        const rework=await client.query("SELECT id::text AS id,row_version::int AS row_version FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='REWORK' FOR UPDATE",[id,c.tenantId,c.factoryId]);
        for(const d of rework.rows) await this.updateDefect(client,c,String(d.id),Number(d.row_version),'RESOLVED','Resolved by successful follow-up inspection',correlation);
        next='PASSED';
      } else if(dto.action==='FAIL'){
        if(next!=='IN_PROGRESS') throw new ConflictException('Only an in-progress inspection can fail');
        const defects=await client.query("SELECT count(*)::int AS count, CASE WHEN bool_or(severity='CRITICAL') THEN 'CRITICAL' WHEN bool_or(severity='MAJOR') THEN 'MAJOR' ELSE 'MINOR' END AS severity FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='OPEN'",[id,c.tenantId,c.factoryId]);
        if(Number(defects.rows[0]?.count??0)===0) throw new ConflictException('Record at least one defect before failing an inspection');
        next='FAILED';
      } else if(dto.action==='HOLD'){
        if(!['OPEN','IN_PROGRESS'].includes(next)) throw new ConflictException('Only an open or in-progress inspection can be held');
        next='ON_HOLD';
      } else if(dto.action==='CANCEL'){
        if(next!=='IN_PROGRESS') throw new ConflictException('Only an in-progress inspection can be cancelled');
        const defects=await client.query("SELECT count(*)::int AS count FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status IN ('OPEN','REWORK')",[id,c.tenantId,c.factoryId]);
        if(Number(defects.rows[0]?.count??0)>0) throw new ConflictException('Resolve or disposition defects before cancelling an inspection');
        next='CANCELLED';
      }
      const upd=await client.query("UPDATE quality_inspections SET status=$1,row_version=row_version+1,updated_by_user_id=$2,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6 RETURNING row_version::int AS row_version",
        [next,c.userId,id,c.tenantId,c.factoryId,q.row_version]);
      const version=Number(upd.rows[0]?.row_version??0);
      if(!version) throw new ConflictException('Quality inspection changed during decision');
      await this.inspectionEvent(client,c,{id,version,from:String(q.status),to:next,action:dto.action,reason,hash,correlation,key:'quality-event:'+key});
      if(dto.action==='PASS'){
        const released=await client.query("UPDATE quality_holds SET status='RELEASED',released_by_user_id=$1,released_at=clock_timestamp(),release_reason=$2,updated_at=clock_timestamp() WHERE inspection_id=$3 AND tenant_id=$4 AND factory_id=$5 AND status='ACTIVE' RETURNING id::text AS id",
          [c.userId,'Released after successful inspection acceptance',id,c.tenantId,c.factoryId]);
        for(const hold of released.rows){
          await this.auditOutbox(client,c,{inspectionId:id,holdId:String(hold.id),action:'QUALITY_HOLD_RELEASED_ON_PASS',correlation,
            payload:{status:'RELEASED',reason:'Released after successful inspection acceptance',inspection_status:'PASSED'}});
        }
      }
      if(dto.action==='FAIL'||dto.action==='HOLD'){
        let heldWorkOrderId = q.target_type==='WORK_ORDER' ? String(q.target_id) : null;
        if(q.target_type==='PRODUCTION_REPORT'){
          const sourceReport=await client.query("SELECT work_order_id::text AS work_order_id FROM order_production_reports WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[q.target_id,c.tenantId,c.factoryId]);
          heldWorkOrderId=sourceReport.rows[0]?.work_order_id?String(sourceReport.rows[0].work_order_id):null;
        }
        const existingHold=await client.query("SELECT id::text AS id FROM quality_holds WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' FOR UPDATE",
          [id,c.tenantId,c.factoryId]);
        let holdId=existingHold.rows[0]?.id?String(existingHold.rows[0].id):null;
        if(!holdId){
          const hold=await client.query("INSERT INTO quality_holds (tenant_id,factory_id,inspection_id,inventory_item_id,traceability_unit_id,work_order_id,reason,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::uuid) RETURNING id::text AS id",
            [c.tenantId,c.factoryId,id,q.inventory_item_id,q.traceability_unit_id,heldWorkOrderId,reason,c.userId,correlation]);
          holdId=hold.rows[0]?.id?String(hold.rows[0].id):null;
          if(!holdId) throw new Error('QUALITY_HOLD_INSERT_FAILED');
        }
        if(dto.action==='FAIL'){
          const defects=await client.query("SELECT CASE WHEN bool_or(severity='CRITICAL') THEN 'CRITICAL' WHEN bool_or(severity='MAJOR') THEN 'MAJOR' ELSE 'MINOR' END AS severity FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='OPEN'",[id,c.tenantId,c.factoryId]);
          await this.createNcr(client,c,id,String(defects.rows[0]?.severity??'MAJOR'),'Inspection failed: '+reason,correlation);
        } else await this.createNcr(client,c,id,'MAJOR','Quality hold: '+reason,correlation);
        await this.auditOutbox(client,c,{inspectionId:id,holdId,action:existingHold.rows[0]?'QUALITY_HOLD_REAFFIRMED':'QUALITY_HOLD_CREATED',correlation,payload:{status:'ACTIVE',target_type:q.target_type,target_id:q.target_id,reason}});
      }
      await this.auditOutbox(client,c,{inspectionId:id,action:'INSPECTION_'+dto.action,correlation,payload:{from_status:q.status,to_status:next,reason,row_version:version}});
      return {id,replayed:false};
    });
    return {...(await this.getInspection(c,result.id)),replayed:result.replayed};
  }

  async disposeInspection(c: QualityContext,id: string,dto: QualityDispositionDto,rawKey:string|null) {
    this.validateScope(c);this.uuid(id,'inspectionId');
    const key=this.key(rawKey),reason=this.text(dto.reason,'reason',2000),correlation=this.correlation(c);
    const quantity=dto.quantity===undefined?null:this.quantity(dto.quantity,'quantity');
    const stockAction=['SCRAP','RETURN_TO_SUPPLIER'].includes(dto.action);
    if(stockAction&&quantity===null) throw new BadRequestException('quantity is required for SCRAP and RETURN_TO_SUPPLIER');
    if(!stockAction&&quantity!==null) throw new BadRequestException('quantity is only used for SCRAP and RETURN_TO_SUPPLIER');
    const hash=this.hash({inspection_id:id,action:dto.action,expected_version:dto.expected_version,quantity,reason});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'disposition',key);
      const old=await client.query("SELECT id::text AS id,request_hash,status FROM quality_dispositions WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[c.tenantId,c.factoryId,key]);
      if(old.rows[0]){
        if(String(old.rows[0].request_hash).trim()!==hash) throw new ConflictException('Idempotency-Key was already used for another quality disposition');
        return {id:String(old.rows[0].id),replayed:true,nextInventoryAction:null};
      }
      const found=await client.query("SELECT "+INSPECTION_COLUMNS+" FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[id,c.tenantId,c.factoryId]);
      const q=found.rows[0] as Record<string,unknown>|undefined;
      if(!q) throw new NotFoundException('Quality inspection was not found in this factory');
      if(Number(q.row_version)!==dto.expected_version) throw new ConflictException('Quality inspection version is stale');
      if(!['FAILED','ON_HOLD','PASSED'].includes(String(q.status))) throw new ConflictException('Only failed, held or passed inspections can be dispositioned');
      const active=await client.query("SELECT id::text AS id FROM quality_holds WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[id,c.tenantId,c.factoryId]);
      const holdId=active.rows[0]?String(active.rows[0].id):null;
      if(['RELEASE','USE_AS_IS','REWORK'].includes(dto.action)&&!holdId) throw new ConflictException('No active quality hold exists for this inspection');
      if((dto.action==='SCRAP'||dto.action==='RETURN_TO_SUPPLIER')&&!holdId) throw new ConflictException('No active quality hold exists for this inspection');
      if(dto.action==='REWORK'&&q.status==='PASSED') throw new ConflictException('Passed inspections cannot be dispositioned for rework');
      let dispositionStatus='RECORDED',itemId=q.inventory_item_id as string|null;
      if(stockAction){
        if(!itemId) throw new ConflictException('No inventory item is linked to this target');
        const b=await client.query("SELECT quantity_on_hand::text AS quantity_on_hand,quantity_reserved::text AS quantity_reserved FROM inventory_stock_balances WHERE item_id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[itemId,c.tenantId,c.factoryId]);
        if(!b.rows[0]) throw new ConflictException('Inventory balance was not found');
        if(this.units(b.rows[0].quantity_reserved)!==0n) throw new ConflictException('Release existing reservations before scrapping or returning held stock');
        if(this.units(b.rows[0].quantity_on_hand)!==this.units(quantity!)) throw new ConflictException('Stock disposition must equal full on-hand quantity while item stock is not lot-allocated');
        dispositionStatus='PENDING_INVENTORY';
      }
      const inserted=await client.query("INSERT INTO quality_dispositions (tenant_id,factory_id,inspection_id,hold_id,inventory_item_id,action,status,quantity,reason,idempotency_key,request_hash,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::numeric,$9,$10,$11,$12,$13::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,id,holdId,itemId,dto.action,dispositionStatus,quantity,reason,key,hash,c.userId,correlation]);
      const dispId=String(inserted.rows[0]?.id??'');
      if(!dispId) throw new Error('QUALITY_DISPOSITION_INSERT_FAILED');
      const defectTarget=dto.action==='RELEASE'||dto.action==='USE_AS_IS'?'ACCEPTED':dto.action==='REWORK'?'REWORK':dto.action==='SCRAP'?'SCRAPPED':dto.action==='RETURN_TO_SUPPLIER'?'RETURNED':null;
      if(defectTarget){
        const ds=await client.query("SELECT id::text AS id,row_version::int AS row_version FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='OPEN' FOR UPDATE",[id,c.tenantId,c.factoryId]);
        for(const d of ds.rows) await this.updateDefect(client,c,String(d.id),Number(d.row_version),defectTarget,reason,correlation,dispId);
      }
      let nextStatus=String(q.status);
      if(dto.action==='RELEASE'||dto.action==='USE_AS_IS') nextStatus='DISPOSITIONED';
      else if(dto.action==='REWORK') nextStatus='ON_HOLD';
      else nextStatus='DISPOSITIONED';
      if(nextStatus!==q.status){
        const upd=await client.query("UPDATE quality_inspections SET status=$1,row_version=row_version+1,updated_by_user_id=$2,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6 RETURNING row_version::int AS row_version",
          [nextStatus,c.userId,id,c.tenantId,c.factoryId,q.row_version]);
        const version=Number(upd.rows[0]?.row_version??0);
        if(!version) throw new ConflictException('Quality inspection changed during disposition');
        await this.inspectionEvent(client,c,{id,version,from:String(q.status),to:nextStatus,action:'DISPOSITION',reason,hash,correlation,key:'quality-disposition-event:'+dispId});
      }
      if(dto.action==='RELEASE'||dto.action==='USE_AS_IS'){
        await client.query("UPDATE quality_holds SET status='RELEASED',released_by_user_id=$1,released_at=clock_timestamp(),release_reason=$2,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND status='ACTIVE'",
          [c.userId,reason,holdId,c.tenantId,c.factoryId]);
      }
      const nextInventoryAction=stockAction?{method:'POST',path:'/api/inventory/items/'+itemId+'/movements',movement_type:'ISSUE',reference_type:'QUALITY_DISPOSITION',reference_id:dispId,quantity}:null;
      await this.auditOutbox(client,c,{inspectionId:id,holdId,dispositionId:dispId,action:'QUALITY_DISPOSITION_'+dto.action,correlation,payload:{action:dto.action,status:dispositionStatus,quantity,reason,inventory_item_id:itemId,next_inventory_action:nextInventoryAction}});
      return {id:dispId,replayed:false,nextInventoryAction};
    });
    const disp=await this.database.query("SELECT id::text AS id,inspection_id::text AS inspection_id,hold_id::text AS hold_id,inventory_item_id::text AS inventory_item_id,action,status,quantity::text AS quantity,reason,inventory_movement_id::text AS inventory_movement_id,created_at::text AS created_at,completed_at::text AS completed_at FROM quality_dispositions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {disposition:disp.rows[0],replayed:result.replayed,next_inventory_action:result.nextInventoryAction};
  }


  async createReworkOrder(c:QualityContext,defectId:string,dto:CreateQualityReworkOrderDto,rawKey:string|null){
    this.validateScope(c);this.uuid(defectId,'defectId');
    const key=this.key(rawKey),quantity=this.quantity(dto.input_quantity,'input_quantity'),reason=this.text(dto.reason,'reason',2000);
    const instructions=dto.instructions?.trim()||null,sourceUnit=dto.source_traceability_unit_id?this.uuidValue(dto.source_traceability_unit_id,'source_traceability_unit_id'):null;
    const evidence=this.jsonObject(dto.evidence),correlation=this.correlation(c);
    const hash=this.hash({defect_id:defectId,input_quantity:quantity,reason,instructions,source_traceability_unit_id:sourceUnit,evidence});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'rework-create',key);
      const previous=await client.query("SELECT id::text AS id,request_hash FROM quality_rework_orders WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[c.tenantId,c.factoryId,key]);
      if(previous.rows[0]){
        if(String(previous.rows[0].request_hash).trim()!==hash)throw new ConflictException('Idempotency-Key was already used for a different rework order');
        return{id:String(previous.rows[0].id),replayed:true};
      }
      const defectResult=await client.query("SELECT d.id::text AS id,d.affected_quantity::text AS affected_quantity,d.status AS defect_status,d.row_version::int AS defect_row_version,qi.id::text AS inspection_id,qi.status AS inspection_status,n.id::text AS ncr_id FROM quality_defects d JOIN quality_inspections qi ON qi.id=d.inspection_id AND qi.tenant_id=d.tenant_id AND qi.factory_id=d.factory_id LEFT JOIN quality_ncrs n ON n.inspection_id=qi.id AND n.tenant_id=qi.tenant_id AND n.factory_id=qi.factory_id AND n.status<>'CLOSED' WHERE d.id=$1 AND d.tenant_id=$2 AND d.factory_id=$3 FOR UPDATE OF d,qi",[defectId,c.tenantId,c.factoryId]);
      const d=defectResult.rows[0];if(!d)throw new NotFoundException('Quality defect was not found in this factory');
      if(!['OPEN','REWORK'].includes(String(d.defect_status)))throw new ConflictException('Only open or rework defects can have a rework task');
      if(!['FAILED','ON_HOLD','DISPOSITIONED'].includes(String(d.inspection_status)))throw new ConflictException('Rework requires a failed, held or dispositioned source inspection');
      if(this.units(quantity)>this.units(String(d.affected_quantity)))throw new ConflictException('Rework input cannot exceed defect affected quantity');
      const taken=await client.query("SELECT COALESCE(sum(input_quantity),0)::text AS quantity FROM quality_rework_orders WHERE defect_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status<>'CANCELLED'",[defectId,c.tenantId,c.factoryId]);
      if(this.units(String(taken.rows[0]?.quantity??'0'))+this.units(quantity)>this.units(String(d.affected_quantity)))throw new ConflictException('Total rework input across active tasks cannot exceed defect affected quantity');
      const linkResult=await client.query("SELECT link_type,inventory_item_id::text AS inventory_item_id,traceability_unit_id::text AS traceability_unit_id,order_id::text AS order_id,order_line_id::text AS order_line_id,work_order_id::text AS work_order_id,work_order_operation_id::text AS work_order_operation_id,production_report_id::text AS production_report_id,goods_receipt_id::text AS goods_receipt_id,goods_receipt_line_id::text AS goods_receipt_line_id FROM quality_defect_links WHERE defect_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",[defectId,c.tenantId,c.factoryId]);
      const links=linkResult.rows as Record<string,unknown>[];
      const unitLink=sourceUnit?links.find(x=>x.link_type==='TRACEABILITY_UNIT'&&String(x.traceability_unit_id)===sourceUnit):links.find(x=>x.link_type==='TRACEABILITY_UNIT');
      if(sourceUnit&&!unitLink)throw new BadRequestException('Source lot/serial must already be linked to the defect');
      let itemId=(links.find(x=>x.link_type==='INVENTORY_ITEM')?.inventory_item_id as string|undefined)??null;
      if(unitLink){
        const u=await client.query("SELECT inventory_item_id::text AS inventory_item_id,quantity::text AS quantity,status FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE",[unitLink.traceability_unit_id,c.tenantId,c.factoryId]);
        if(!u.rows[0])throw new NotFoundException('Source lot/serial was not found in this factory');
        if(String(u.rows[0].status)!=='QUARANTINED')throw new ConflictException('Rework source lot/serial must stay quarantined under an active quality hold');
        if(this.units(quantity)>this.units(String(u.rows[0].quantity)))throw new ConflictException('Rework input cannot exceed source lot/serial quantity');
        if(u.rows[0].inventory_item_id)itemId=String(u.rows[0].inventory_item_id);
      }
      const first=(name:string)=>links.find(x=>x[name]!==null&&x[name]!==undefined)?.[name] as string|undefined;
      let orderId=first('order_id')??null,orderLineId=first('order_line_id')??null;
      const reportId=first('production_report_id')??null;
      if(reportId){
        const report=await client.query("SELECT order_id::text AS order_id,order_line_id::text AS order_line_id FROM order_production_reports WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[reportId,c.tenantId,c.factoryId]);
        if(report.rows[0]){orderId=orderId??String(report.rows[0].order_id);orderLineId=orderLineId??String(report.rows[0].order_line_id);}
      }
      const reworkNumber='RWK-'+randomUUID().replace(/-/g,'').slice(0,12).toUpperCase();
      const inserted=await client.query("INSERT INTO quality_rework_orders (tenant_id,factory_id,rework_number,defect_id,inspection_id,ncr_id,source_inventory_item_id,source_traceability_unit_id,source_order_id,source_order_line_id,source_work_order_id,source_work_order_operation_id,source_production_report_id,source_goods_receipt_id,source_goods_receipt_line_id,input_quantity,recovered_quantity,scrap_quantity,reason,instructions,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12::uuid,$13::uuid,$14::uuid,$15::uuid,$16::numeric,0,0,$17,$18,$19,$20,$21,$21,$22::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,reworkNumber,defectId,d.inspection_id,d.ncr_id??null,itemId,unitLink?.traceability_unit_id??null,orderId,orderLineId,first('work_order_id')??null,first('work_order_operation_id')??null,reportId,first('goods_receipt_id')??null,first('goods_receipt_line_id')??null,quantity,reason,instructions,key,hash,c.userId,correlation]);
      const id=String(inserted.rows[0]?.id??'');if(!id)throw new Error('QUALITY_REWORK_INSERT_FAILED');
      await this.insertQualityReworkEvent(client,c,{reworkOrderId:id,defectId,version:1,from:null,to:'DRAFT',command:'CREATED',reason,evidence,
        key:key+':created',hash:this.hash({rework_id:id,source_hash:hash,command:'CREATED'}),correlation});
      return{id,replayed:false};
    });
    return{...(await this.getReworkOrder(c,result.id)),replayed:result.replayed};
  }

  async listReworkOrders(c:QualityContext,query:ListQualityReworkOrdersQueryDto){
    this.validateScope(c);const limit=query.limit??50;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new BadRequestException('limit must be between 1 and 100');
    const r=await this.database.query("SELECT r.id::text AS id,r.rework_number,r.defect_id::text AS defect_id,r.inspection_id::text AS inspection_id,r.ncr_id::text AS ncr_id,r.status,r.input_quantity::text AS input_quantity,r.recovered_quantity::text AS recovered_quantity,r.scrap_quantity::text AS scrap_quantity,r.source_traceability_unit_id::text AS source_traceability_unit_id,r.output_traceability_unit_id::text AS output_traceability_unit_id,r.follow_up_inspection_id::text AS follow_up_inspection_id,r.row_version::int AS row_version,r.created_at::text AS created_at,d.defect_code,d.severity,n.ncr_number FROM quality_rework_orders r JOIN quality_defects d ON d.id=r.defect_id AND d.tenant_id=r.tenant_id AND d.factory_id=r.factory_id LEFT JOIN quality_ncrs n ON n.id=r.ncr_id AND n.tenant_id=r.tenant_id AND n.factory_id=r.factory_id WHERE r.tenant_id=$1 AND r.factory_id=$2 AND ($3::text IS NULL OR r.status=$3) ORDER BY CASE WHEN r.status IN ('IN_PROGRESS','REWORK_REQUIRED') THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC LIMIT $4",
      [c.tenantId,c.factoryId,query.status??null,limit],{tenantId:c.tenantId,userId:c.userId});
    return r.rows;
  }

  async getReworkOrder(c:QualityContext,reworkOrderId:string){
    this.validateScope(c);this.uuid(reworkOrderId,'reworkOrderId');
    const r=await this.database.query("SELECT q.id::text AS id,q.rework_number,q.defect_id::text AS defect_id,q.inspection_id::text AS inspection_id,q.ncr_id::text AS ncr_id,q.source_inventory_item_id::text AS source_inventory_item_id,q.source_traceability_unit_id::text AS source_traceability_unit_id,q.source_order_id::text AS source_order_id,q.source_order_line_id::text AS source_order_line_id,q.source_work_order_id::text AS source_work_order_id,q.source_work_order_operation_id::text AS source_work_order_operation_id,q.source_production_report_id::text AS source_production_report_id,q.source_goods_receipt_id::text AS source_goods_receipt_id,q.source_goods_receipt_line_id::text AS source_goods_receipt_line_id,q.input_quantity::text AS input_quantity,q.recovered_quantity::text AS recovered_quantity,q.scrap_quantity::text AS scrap_quantity,q.output_traceability_unit_id::text AS output_traceability_unit_id,q.follow_up_inspection_id::text AS follow_up_inspection_id,q.status,q.reason,q.instructions,q.completion_reason,q.verification_reason,q.cancellation_reason,q.row_version::int AS row_version,q.created_by_user_id::text AS created_by_user_id,q.approved_by_user_id::text AS approved_by_user_id,q.started_by_user_id::text AS started_by_user_id,q.completed_by_user_id::text AS completed_by_user_id,q.verified_by_user_id::text AS verified_by_user_id,q.cancelled_by_user_id::text AS cancelled_by_user_id,q.approved_at::text AS approved_at,q.started_at::text AS started_at,q.completed_at::text AS completed_at,q.verified_at::text AS verified_at,q.cancelled_at::text AS cancelled_at,q.created_at::text AS created_at,q.updated_at::text AS updated_at,d.defect_code,d.severity,d.affected_quantity::text AS defect_affected_quantity,qi.status AS source_inspection_status,n.ncr_number FROM quality_rework_orders q JOIN quality_defects d ON d.id=q.defect_id AND d.tenant_id=q.tenant_id AND d.factory_id=q.factory_id JOIN quality_inspections qi ON qi.id=q.inspection_id AND qi.tenant_id=q.tenant_id AND qi.factory_id=q.factory_id LEFT JOIN quality_ncrs n ON n.id=q.ncr_id AND n.tenant_id=q.tenant_id AND n.factory_id=q.factory_id WHERE q.id=$1 AND q.tenant_id=$2 AND q.factory_id=$3",
      [reworkOrderId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    if(!r.rows[0])throw new NotFoundException('Quality rework order was not found in this factory');
    const events=await this.database.query("SELECT id::text AS id,version::int AS version,from_status,to_status,command,reason,evidence,payload,actor_user_id::text AS actor_user_id,created_at::text AS created_at FROM quality_rework_events WHERE rework_order_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY version",
      [reworkOrderId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    const inventoryMovements=await this.database.query("SELECT id::text AS id,item_id::text AS item_id,location_id::text AS location_id,movement_type,quantity::text AS quantity,quantity_delta::text AS quantity_delta,quantity_after::text AS quantity_after,reference_type,reference_id::text AS reference_id,idempotency_key,created_by_user_id::text AS created_by_user_id,correlation_id::text AS correlation_id,created_at::text AS created_at FROM inventory_movements WHERE tenant_id=$1 AND factory_id=$2 AND reference_id=$3 AND reference_type IN ('QUALITY_REWORK_INPUT','QUALITY_REWORK_OUTPUT','QUALITY_REWORK_RESTORE') ORDER BY created_at,id",
      [c.tenantId,c.factoryId,reworkOrderId],{tenantId:c.tenantId,userId:c.userId});
    return{...r.rows[0],events:events.rows,inventory_movements:inventoryMovements.rows};
  }

  async transitionReworkOrder(c:QualityContext,reworkOrderId:string,dto:QualityReworkTransitionDto,rawKey:string|null){
    this.validateScope(c);this.uuid(reworkOrderId,'reworkOrderId');
    const key=this.key(rawKey),reason=this.text(dto.reason,'reason',2000),evidence=this.jsonObject(dto.evidence),correlation=this.correlation(c);
    const nonNegative=(value:number|undefined,field:string)=>{
      if(value===undefined||!Number.isFinite(value)||value<0||Math.abs(value*10000-Math.round(value*10000))>0.000001)
        throw new BadRequestException(field+' is required and must be non-negative with at most four decimal places');
      return value.toFixed(4);
    };
    const recovered=dto.action==='COMPLETE'?nonNegative(dto.recovered_quantity,'recovered_quantity'):null;
    const scrap=dto.action==='COMPLETE'?nonNegative(dto.scrap_quantity,'scrap_quantity'):null;
    const outputId=dto.output_traceability_unit_id?this.uuidValue(dto.output_traceability_unit_id,'output_traceability_unit_id'):null;
    const followupId=dto.follow_up_inspection_id?this.uuidValue(dto.follow_up_inspection_id,'follow_up_inspection_id'):null;
    if(dto.action==='COMPLETE'){
      if(this.units(recovered!)+this.units(scrap!)===0n)throw new BadRequestException('Rework completion quantity must be positive');
      if(Number(recovered)>0&&(!outputId||!followupId))throw new BadRequestException('Recovered output requires a traceability unit and follow-up inspection');
      if(Number(recovered)===0&&(outputId||followupId))throw new BadRequestException('Fully scrapped rework cannot declare an output unit or follow-up output inspection');
    }
    const hash=this.hash({rework_order_id:reworkOrderId,action:dto.action,expected_version:dto.expected_version,reason,evidence,recovered,scrap,outputId,followupId});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'rework-transition',key);
      const old=await client.query("SELECT id::text AS id,rework_order_id::text AS rework_order_id,request_hash FROM quality_rework_events WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[c.tenantId,c.factoryId,key]);
      if(old.rows[0]){
        if(String(old.rows[0].request_hash).trim()!==hash)throw new ConflictException('Idempotency-Key was already used for another rework transition');
        return{id:String(old.rows[0].rework_order_id),replayed:true};
      }
      const q=await client.query("SELECT r.id::text AS id,r.defect_id::text AS defect_id,r.inspection_id::text AS inspection_id,r.ncr_id::text AS ncr_id,r.status,r.row_version::int AS row_version,r.input_quantity::text AS input_quantity,r.source_inventory_item_id::text AS source_inventory_item_id,r.source_traceability_unit_id::text AS source_traceability_unit_id,r.completed_by_user_id::text AS completed_by_user_id,r.output_traceability_unit_id::text AS output_traceability_unit_id,r.follow_up_inspection_id::text AS follow_up_inspection_id,r.recovered_quantity::text AS recovered_quantity,d.status AS defect_status,d.row_version::int AS defect_row_version FROM quality_rework_orders r JOIN quality_defects d ON d.id=r.defect_id AND d.tenant_id=r.tenant_id AND d.factory_id=r.factory_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 FOR UPDATE OF r,d",
        [reworkOrderId,c.tenantId,c.factoryId]);
      const r=q.rows[0];if(!r)throw new NotFoundException('Quality rework order was not found in this factory');
      if(Number(r.row_version)!==dto.expected_version)throw new ConflictException('Rework order version is stale');
      const from=String(r.status);let to=from,update;
      if(dto.action==='APPROVE'){
        if(from!=='DRAFT')throw new ConflictException('Only a draft rework task can be approved');to='APPROVED';
        update=await client.query("UPDATE quality_rework_orders SET status='APPROVED',row_version=row_version+1,approved_by_user_id=$1,approved_at=clock_timestamp(),updated_by_user_id=$1,updated_at=clock_timestamp() WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND row_version=$5 RETURNING row_version::int AS row_version",[c.userId,reworkOrderId,c.tenantId,c.factoryId,r.row_version]);
      }else if(dto.action==='START'){
        if(from!=='APPROVED')throw new ConflictException('Only an approved rework task can start');to='IN_PROGRESS';
        update=await client.query("UPDATE quality_rework_orders SET status='IN_PROGRESS',row_version=row_version+1,started_by_user_id=$1,started_at=clock_timestamp(),updated_by_user_id=$1,updated_at=clock_timestamp() WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND row_version=$5 RETURNING row_version::int AS row_version",[c.userId,reworkOrderId,c.tenantId,c.factoryId,r.row_version]);
        if(r.defect_status==='OPEN')await this.updateDefect(client,c,String(r.defect_id),Number(r.defect_row_version),'REWORK',reason,correlation);
        if (r.source_inventory_item_id) {
          await this.postReworkInputInventory(client,c,{
            reworkOrderId, itemId:String(r.source_inventory_item_id),
            sourceTraceabilityUnitId:r.source_traceability_unit_id ? String(r.source_traceability_unit_id) : null,
            inputQuantity:String(r.input_quantity), actorId:c.userId, correlation,
          });
        }
      }else if(dto.action==='RESTART'){
        if(from!=='REWORK_REQUIRED')throw new ConflictException('Only a rework-required task can restart');to='IN_PROGRESS';
        update=await client.query("UPDATE quality_rework_orders SET status='IN_PROGRESS',row_version=row_version+1,started_by_user_id=$1,started_at=clock_timestamp(),completed_by_user_id=NULL,completed_at=NULL,completion_reason=NULL,recovered_quantity=0,scrap_quantity=0,output_traceability_unit_id=NULL,follow_up_inspection_id=NULL,verified_by_user_id=NULL,verified_at=NULL,verification_reason=NULL,updated_by_user_id=$1,updated_at=clock_timestamp() WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND row_version=$5 RETURNING row_version::int AS row_version",[c.userId,reworkOrderId,c.tenantId,c.factoryId,r.row_version]);
      }else if(dto.action==='COMPLETE'){
        if(from!=='IN_PROGRESS')throw new ConflictException('Only an in-progress rework task can complete');
        if(this.units(recovered!)+this.units(scrap!)!==this.units(String(r.input_quantity)))throw new ConflictException('Recovered plus scrap quantity must exactly equal rework input quantity');
        if(Number(recovered)>0){
          const output=await client.query("SELECT id::text AS id,inventory_item_id::text AS inventory_item_id,quantity::text AS quantity,status FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE",[outputId,c.tenantId,c.factoryId]);
          if(!output.rows[0]||output.rows[0].status!=='ACTIVE'||this.units(String(output.rows[0].quantity))!==this.units(recovered!))throw new ConflictException('Output lot/serial must be ACTIVE and exactly match recovered quantity');
          if(r.source_inventory_item_id&&String(output.rows[0].inventory_item_id)!==String(r.source_inventory_item_id))throw new ConflictException('Recovered output must use the same inventory item as the source');
          const inspection=await client.query("SELECT target_type,target_id::text AS target_id,inspection_type,status FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE",[followupId,c.tenantId,c.factoryId]);
          if(!inspection.rows[0]||inspection.rows[0].target_type!=='TRACEABILITY_UNIT'||String(inspection.rows[0].target_id)!==outputId||!['IN_PROCESS','FINAL','INVENTORY'].includes(String(inspection.rows[0].inspection_type))||['CANCELLED','DISPOSITIONED'].includes(String(inspection.rows[0].status)))
            throw new ConflictException('Follow-up inspection must target the exact recovered output lot/serial');
        }
        to='COMPLETED';
        update=await client.query("UPDATE quality_rework_orders SET status='COMPLETED',row_version=row_version+1,recovered_quantity=$1::numeric,scrap_quantity=$2::numeric,output_traceability_unit_id=$3::uuid,follow_up_inspection_id=$4::uuid,completion_reason=$5,completed_by_user_id=$6,completed_at=clock_timestamp(),updated_by_user_id=$6,updated_at=clock_timestamp() WHERE id=$7 AND tenant_id=$8 AND factory_id=$9 AND row_version=$10 RETURNING row_version::int AS row_version",[recovered,scrap,outputId,followupId,reason,c.userId,reworkOrderId,c.tenantId,c.factoryId,r.row_version]);
      }else if(dto.action==='VERIFY'){
        if(from!=='COMPLETED')throw new ConflictException('Only a completed rework task can be verified');
        if(String(r.completed_by_user_id)===c.userId)throw new ConflictException('Rework verification must be performed by a different actor than the completer');
        if(this.units(String(r.recovered_quantity))>0n){
          const inspection=await client.query("SELECT status FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[r.follow_up_inspection_id,c.tenantId,c.factoryId]);
          if(!inspection.rows[0]||!['PASSED','FAILED','ON_HOLD'].includes(String(inspection.rows[0].status)))throw new ConflictException('Follow-up inspection must have a final pass/fail/hold result before rework verification');
          to=inspection.rows[0].status==='PASSED'?'VERIFIED':'REWORK_REQUIRED';
        }else to='VERIFIED';
        update=await client.query("UPDATE quality_rework_orders SET status=$1,row_version=row_version+1,verified_by_user_id=$2,verified_at=clock_timestamp(),verification_reason=$3,updated_by_user_id=$2,updated_at=clock_timestamp() WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND row_version=$7 RETURNING row_version::int AS row_version",[to,c.userId,reason,reworkOrderId,c.tenantId,c.factoryId,r.row_version]);
      }else if(dto.action==='CANCEL'){
        if(!['APPROVED','IN_PROGRESS','REWORK_REQUIRED'].includes(from))throw new ConflictException('Only approved, in-progress or rework-required tasks can be cancelled');to='CANCELLED';
        update=await client.query("UPDATE quality_rework_orders SET status='CANCELLED',row_version=row_version+1,cancelled_by_user_id=$1,cancelled_at=clock_timestamp(),cancellation_reason=$2,completed_by_user_id=NULL,completed_at=NULL,completion_reason=NULL,recovered_quantity=0,scrap_quantity=0,output_traceability_unit_id=NULL,follow_up_inspection_id=NULL,verified_by_user_id=NULL,verified_at=NULL,verification_reason=NULL,updated_by_user_id=$1,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6 RETURNING row_version::int AS row_version",[c.userId,reason,reworkOrderId,c.tenantId,c.factoryId,r.row_version]);
      }else throw new BadRequestException('Unsupported rework transition');
      const version=Number(update.rows[0]?.row_version??0);if(!version)throw new ConflictException('Rework task changed during transition');
      await this.insertQualityReworkEvent(client,c,{reworkOrderId,defectId:String(r.defect_id),version,from,to,command:dto.action==='VERIFY'?(to==='VERIFIED'?'VERIFY_PASS':'VERIFY_FAIL'):dto.action,reason,evidence,
        payload:{input_quantity:r.input_quantity,recovered_quantity:recovered,scrap_quantity:scrap,output_traceability_unit_id:outputId,follow_up_inspection_id:followupId},
        key,hash,correlation});
      if (dto.action==='CANCEL' && ['IN_PROGRESS','REWORK_REQUIRED'].includes(from) && r.source_inventory_item_id) {
        await this.restoreReworkInputInventory(client,c,{
          reworkOrderId,itemId:String(r.source_inventory_item_id),
          sourceTraceabilityUnitId:r.source_traceability_unit_id ? String(r.source_traceability_unit_id) : null,
          actorId:c.userId,correlation,
        });
      }
      if (dto.action==='VERIFY' && to==='VERIFIED' && this.units(String(r.recovered_quantity))>0n && r.source_inventory_item_id) {
        await this.postReworkRecoveredOutputInventory(client,c,{
          reworkOrderId,itemId:String(r.source_inventory_item_id),
          outputTraceabilityUnitId:String(r.output_traceability_unit_id),
          recoveredQuantity:String(r.recovered_quantity),actorId:c.userId,correlation,
        });
      }
      if(dto.action==='COMPLETE'&&Number(recovered)>0){
        await this.insertDefectLink(client,c,{defectId:String(r.defect_id),linkType:'REWORK_OUTPUT',targetId:String(outputId),source:'REWORK_OUTPUT',quantity:recovered,
          notes:'Recovered output from the rework task',evidence:{rework_order_id:reworkOrderId,follow_up_inspection_id:followupId},
          key:'rework-output:'+reworkOrderId+':'+String(version),correlation,reworkOrderId});
      }
      if(dto.action==='VERIFY'&&to==='VERIFIED'){
        const others=await client.query("SELECT count(*)::int AS count FROM quality_rework_orders WHERE defect_id=$1 AND tenant_id=$2 AND factory_id=$3 AND id<>$4 AND status NOT IN ('VERIFIED','CANCELLED')",[r.defect_id,c.tenantId,c.factoryId,reworkOrderId]);
        const current=await client.query("SELECT status,row_version::int AS row_version FROM quality_defects WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[r.defect_id,c.tenantId,c.factoryId]);
        if(Number(others.rows[0]?.count??0)===0&&current.rows[0]?.status==='REWORK')await this.updateDefect(client,c,String(r.defect_id),Number(current.rows[0].row_version),'RESOLVED',reason,correlation);
      }
      return{id:reworkOrderId,replayed:false};
    });
    return{...(await this.getReworkOrder(c,result.id)),replayed:result.replayed};
  }


  private async postReworkInputInventory(client:PoolClient,c:QualityContext,input:{
    reworkOrderId:string;itemId:string;sourceTraceabilityUnitId:string|null;inputQuantity:string;actorId:string;correlation:string;
  }):Promise<void>{
    const existing=await client.query(
      "SELECT COALESCE(sum(quantity),0)::numeric(18,4)::text AS quantity FROM inventory_movements WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='QUALITY_REWORK_INPUT' AND reference_id=$3 AND movement_type='ISSUE'",
      [c.tenantId,c.factoryId,input.reworkOrderId]);
    const already=this.units(String(existing.rows[0]?.quantity??'0'));
    const needed=this.units(input.inputQuantity);
    if(already===needed)return;
    if(already!==0n)throw new ConflictException('Rework source input has a partial prior issue; stock reconciliation must be reviewed before retry');
    const balance=await client.query(
      'SELECT quantity_on_hand::text AS quantity_on_hand,quantity_reserved::text AS quantity_reserved FROM inventory_stock_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 FOR UPDATE',
      [c.tenantId,c.factoryId,input.itemId]);
    if(!balance.rows[0])throw new ConflictException('Rework source inventory balance is unavailable');
    if(this.units(String(balance.rows[0].quantity_reserved))!==0n)throw new ConflictException('Release all item reservations before issuing a held source to rework');
    if(this.units(String(balance.rows[0].quantity_on_hand))<needed)throw new ConflictException('Rework input quantity exceeds available aggregate stock');

    if(!input.sourceTraceabilityUnitId){
      const tracked=await client.query(
        "SELECT EXISTS(SELECT 1 FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2 AND inventory_item_id=$3 AND product_role='MATERIAL' AND unit_type IN ('LOT','SERIAL')) AS tracked",
        [c.tenantId,c.factoryId,input.itemId]);
      if(tracked.rows[0]?.tracked)throw new ConflictException('A source lot/serial is required before rework can consume an item with material traceability enabled');
    }
    const candidates=input.sourceTraceabilityUnitId
      ? await client.query(
        "SELECT tlb.location_id::text AS location_id,(tlb.quantity_on_hand-tlb.quantity_reserved)::numeric(18,4)::text AS available_quantity FROM inventory_traceability_location_balances tlb JOIN inventory_locations l ON l.id=tlb.location_id AND l.tenant_id=tlb.tenant_id AND l.factory_id=tlb.factory_id WHERE tlb.tenant_id=$1 AND tlb.factory_id=$2 AND tlb.item_id=$3 AND tlb.traceability_unit_id=$4 AND l.status='ACTIVE' AND l.picking_enabled=TRUE AND l.putaway_enabled=TRUE AND tlb.quantity_on_hand>tlb.quantity_reserved ORDER BY l.is_default DESC,tlb.location_id FOR UPDATE OF tlb",
        [c.tenantId,c.factoryId,input.itemId,input.sourceTraceabilityUnitId])
      : await client.query(
        "SELECT lb.location_id::text AS location_id,(lb.quantity_on_hand-lb.quantity_reserved)::numeric(18,4)::text AS available_quantity FROM inventory_location_balances lb JOIN inventory_locations l ON l.id=lb.location_id AND l.tenant_id=lb.tenant_id AND l.factory_id=lb.factory_id WHERE lb.tenant_id=$1 AND lb.factory_id=$2 AND lb.item_id=$3 AND l.status='ACTIVE' AND l.picking_enabled=TRUE AND l.putaway_enabled=TRUE AND lb.quantity_on_hand>lb.quantity_reserved ORDER BY l.is_default DESC,lb.location_id FOR UPDATE OF lb",
        [c.tenantId,c.factoryId,input.itemId]);
    const rows=candidates.rows as {location_id:string;available_quantity:string}[];
    const available=rows.reduce((sum,row)=>sum+this.units(row.available_quantity),0n);
    if(available<needed)throw new ConflictException('Eligible unreserved bin/lot quantities do not cover the requested rework input');
    let remaining=needed,sequence=0;
    for(const row of rows){
      if(remaining===0n)break;
      const candidateUnits=this.units(row.available_quantity);
      const take=candidateUnits<remaining?candidateUnits:remaining;
      if(take<=0n)continue;
      const quantity=this.unitsToDecimal(take);
      await client.query('SELECT set_config(\'app.inventory_location_id\',$1,TRUE)',[row.location_id]);
      const stock=await client.query(
        'UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand-$1::numeric,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4 AND quantity_reserved=0 AND quantity_on_hand >= $1::numeric RETURNING quantity_on_hand::text AS quantity_on_hand',
        [quantity,c.tenantId,c.factoryId,input.itemId]);
      if(!stock.rows[0])throw new ConflictException('Aggregate stock changed while issuing rework input');
      if(input.sourceTraceabilityUnitId){
        const tracked=await client.query(
          'UPDATE inventory_traceability_location_balances SET quantity_on_hand=quantity_on_hand-$1::numeric,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4 AND traceability_unit_id=$5 AND location_id=$6 AND quantity_reserved=0 AND quantity_on_hand >= $1::numeric RETURNING id::text AS id',
          [quantity,c.tenantId,c.factoryId,input.itemId,input.sourceTraceabilityUnitId,row.location_id]);
        if(!tracked.rows[0])throw new ConflictException('Source lot/serial bin balance changed while issuing rework input');
      }
      sequence++;
      const key='quality-rework-input:'+input.reworkOrderId+':'+sequence;
      const hash=this.hash({kind:'QUALITY_REWORK_INPUT',rework_order_id:input.reworkOrderId,item_id:input.itemId,
        traceability_unit_id:input.sourceTraceabilityUnitId,location_id:row.location_id,quantity,sequence});
      const movement=await client.query(
        "INSERT INTO inventory_movements (tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,'ISSUE',$5::numeric,-$5::numeric,$6::numeric,$7,$8,'QUALITY_REWORK_INPUT',$9::uuid,$10,$11,$12::uuid) RETURNING id::text AS id,created_at::text AS created_at",
        [c.tenantId,c.factoryId,input.itemId,row.location_id,quantity,stock.rows[0].quantity_on_hand,key,hash,input.reworkOrderId,'Quarantined source consumed by approved rework task',input.actorId,input.correlation]);
      const movementId=String(movement.rows[0]?.id??'');
      if(!movementId)throw new Error('QUALITY_REWORK_INPUT_MOVEMENT_FAILED');
      await this.recordReworkInventoryEvidence(client,c,{
        movementId,itemId:input.itemId,locationId:row.location_id,movementType:'ISSUE',quantity,quantityAfter:String(stock.rows[0].quantity_on_hand),
        reworkOrderId:input.reworkOrderId,traceabilityUnitId:input.sourceTraceabilityUnitId,actorId:input.actorId,correlation:input.correlation,
        key,outboxEvent:'INVENTORY.STOCK_ISSUED',
      });
      remaining-=take;
    }
    if(remaining!==0n)throw new ConflictException('Rework input issue did not consume the requested quantity');
  }

  private async restoreReworkInputInventory(client:PoolClient,c:QualityContext,input:{
    reworkOrderId:string;itemId:string;sourceTraceabilityUnitId:string|null;actorId:string;correlation:string;
  }):Promise<void>{
    const issued=await client.query(
      "SELECT id::text AS id,location_id::text AS location_id,quantity::text AS quantity FROM inventory_movements WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='QUALITY_REWORK_INPUT' AND reference_id=$3 AND movement_type='ISSUE' ORDER BY created_at,id FOR UPDATE",
      [c.tenantId,c.factoryId,input.reworkOrderId]);
    if(!issued.rows.length)return;
    const total=issued.rows.reduce((sum,row)=>sum+this.units(String(row.quantity)),0n);
    const expected=await client.query(
      'SELECT input_quantity::text AS input_quantity FROM quality_rework_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [input.reworkOrderId,c.tenantId,c.factoryId]);
    if(total!==this.units(String(expected.rows[0]?.input_quantity??'0')))throw new ConflictException('Rework cancellation cannot restore an incomplete source issue');
    for(let i=0;i<issued.rows.length;i++){
      const row=issued.rows[i] as {location_id:string;quantity:string};
      const quantity=row.quantity;
      await client.query('SELECT set_config(\'app.inventory_location_id\',$1,TRUE)',[row.location_id]);
      const stock=await client.query(
        'UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand+$1::numeric,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4 RETURNING quantity_on_hand::text AS quantity_on_hand',
        [quantity,c.tenantId,c.factoryId,input.itemId]);
      if(!stock.rows[0])throw new ConflictException('Inventory balance is missing while restoring cancelled rework input');
      if(input.sourceTraceabilityUnitId){
        const tracked=await client.query(
          'UPDATE inventory_traceability_location_balances SET quantity_on_hand=quantity_on_hand+$1::numeric,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4 AND traceability_unit_id=$5 AND location_id=$6 RETURNING id::text AS id',
          [quantity,c.tenantId,c.factoryId,input.itemId,input.sourceTraceabilityUnitId,row.location_id]);
        if(!tracked.rows[0])throw new ConflictException('Source lot/serial balance is missing while restoring cancelled rework input');
      }
      const sequence=i+1,key='quality-rework-restore:'+input.reworkOrderId+':'+sequence;
      const hash=this.hash({kind:'QUALITY_REWORK_RESTORE',rework_order_id:input.reworkOrderId,item_id:input.itemId,
        traceability_unit_id:input.sourceTraceabilityUnitId,location_id:row.location_id,quantity,sequence});
      const movement=await client.query(
        "INSERT INTO inventory_movements (tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,'RECEIPT',$5::numeric,$5::numeric,$6::numeric,$7,$8,'QUALITY_REWORK_RESTORE',$9::uuid,$10,$11,$12::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,input.itemId,row.location_id,quantity,stock.rows[0].quantity_on_hand,key,hash,input.reworkOrderId,'Restore source stock when rework is cancelled',input.actorId,input.correlation]);
      const movementId=String(movement.rows[0]?.id??'');
      if(!movementId)throw new Error('QUALITY_REWORK_RESTORE_MOVEMENT_FAILED');
      await this.recordReworkInventoryEvidence(client,c,{
        movementId,itemId:input.itemId,locationId:row.location_id,movementType:'RECEIPT',quantity,quantityAfter:String(stock.rows[0].quantity_on_hand),
        reworkOrderId:input.reworkOrderId,traceabilityUnitId:input.sourceTraceabilityUnitId,actorId:input.actorId,correlation:input.correlation,
        key,outboxEvent:'INVENTORY.STOCK_RECEIVED',
      });
    }
  }

  private async postReworkRecoveredOutputInventory(client:PoolClient,c:QualityContext,input:{
    reworkOrderId:string;itemId:string;outputTraceabilityUnitId:string;recoveredQuantity:string;actorId:string;correlation:string;
  }):Promise<void>{
    const prior=await client.query(
      "SELECT id FROM inventory_movements WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id=$3 LIMIT 1",
      [c.tenantId,c.factoryId,input.reworkOrderId]);
    if(prior.rows[0])return;
    const output=await client.query(
      'SELECT inventory_item_id::text AS inventory_item_id,quantity::text AS quantity,status FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
      [input.outputTraceabilityUnitId,c.tenantId,c.factoryId]);
    if(!output.rows[0]||output.rows[0].status!=='ACTIVE'||String(output.rows[0].inventory_item_id)!==input.itemId
      ||this.units(String(output.rows[0].quantity))!==this.units(input.recoveredQuantity)){
      throw new ConflictException('Verified recovered output identity does not match its inventory item and quantity');
    }
    const existing=await client.query(
      'SELECT COALESCE(sum(quantity_on_hand),0)::numeric(18,4)::text AS quantity FROM inventory_traceability_location_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4',
      [c.tenantId,c.factoryId,input.itemId,input.outputTraceabilityUnitId]);
    if(this.units(String(existing.rows[0]?.quantity??'0'))!==0n)throw new ConflictException('Recovered output already has on-hand traceability stock');
    const location=await client.query(
      "SELECT id::text AS id FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' AND putaway_enabled=TRUE ORDER BY is_default DESC,id LIMIT 1 FOR SHARE",
      [c.tenantId,c.factoryId]);
    const locationId=String(location.rows[0]?.id??'');
    if(!locationId)throw new ConflictException('No active put-away location is available for recovered output');
    await client.query('SELECT set_config(\'app.inventory_location_id\',$1,TRUE)',[locationId]);
    const stock=await client.query(
      'UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand+$1::numeric,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4 RETURNING quantity_on_hand::text AS quantity_on_hand',
      [input.recoveredQuantity,c.tenantId,c.factoryId,input.itemId]);
    if(!stock.rows[0])throw new ConflictException('Inventory balance is missing for recovered rework output');
    const key='quality-rework-output:'+input.reworkOrderId;
    const hash=this.hash({kind:'QUALITY_REWORK_OUTPUT',rework_order_id:input.reworkOrderId,item_id:input.itemId,
      output_traceability_unit_id:input.outputTraceabilityUnitId,location_id:locationId,quantity:input.recoveredQuantity});
    const movement=await client.query(
      "INSERT INTO inventory_movements (tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,'RECEIPT',$5::numeric,$5::numeric,$6::numeric,$7,$8,'QUALITY_REWORK_OUTPUT',$9::uuid,$10,$11,$12::uuid) RETURNING id::text AS id",
      [c.tenantId,c.factoryId,input.itemId,locationId,input.recoveredQuantity,stock.rows[0].quantity_on_hand,key,hash,input.reworkOrderId,'Recovered rework output after independent verification and passing follow-up inspection',input.actorId,input.correlation]);
    const movementId=String(movement.rows[0]?.id??'');
    if(!movementId)throw new Error('QUALITY_REWORK_OUTPUT_MOVEMENT_FAILED');
    const tracked=await client.query(
      'INSERT INTO inventory_traceability_location_balances (tenant_id,factory_id,item_id,traceability_unit_id,location_id,quantity_on_hand,quantity_reserved) VALUES ($1,$2,$3,$4,$5::uuid,$6::numeric,0) RETURNING id::text AS id',
      [c.tenantId,c.factoryId,input.itemId,input.outputTraceabilityUnitId,locationId,input.recoveredQuantity]);
    if(!tracked.rows[0])throw new Error('QUALITY_REWORK_OUTPUT_TRACEABILITY_BALANCE_FAILED');
    await this.recordReworkInventoryEvidence(client,c,{
      movementId,itemId:input.itemId,locationId,movementType:'RECEIPT',quantity:input.recoveredQuantity,
      quantityAfter:String(stock.rows[0].quantity_on_hand),reworkOrderId:input.reworkOrderId,
      traceabilityUnitId:input.outputTraceabilityUnitId,actorId:input.actorId,correlation:input.correlation,
      key,outboxEvent:'INVENTORY.STOCK_RECEIVED',
    });
  }

  private async recordReworkInventoryEvidence(client:PoolClient,c:QualityContext,input:{
    movementId:string;itemId:string;locationId:string;movementType:'ISSUE'|'RECEIPT';quantity:string;quantityAfter:string;
    reworkOrderId:string;traceabilityUnitId:string|null;actorId:string;correlation:string;key:string;outboxEvent:string;
  }):Promise<void>{
    const delta=input.movementType==='ISSUE'?'-'+input.quantity:input.quantity;
    const payload={
      movement_id:input.movementId,quality_rework_order_id:input.reworkOrderId,item_id:input.itemId,
      location_id:input.locationId,traceability_unit_id:input.traceabilityUnitId,movement_type:input.movementType,
      quantity:input.quantity,quantity_delta:delta,quantity_after:input.quantityAfter,idempotency_key:input.key,
    };
    await client.query(
      "INSERT INTO audit_events (tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,correlation_id,request_id,data_class,payload) VALUES ($1,$2,$3,'INVENTORY',$4,'INVENTORY_MOVEMENT',$5::uuid,$6::uuid,$7::uuid,'INTERNAL',$8::jsonb)",
      [c.tenantId,c.factoryId,input.actorId,input.movementType==='ISSUE'?'ISSUED':'RECEIVED',input.movementId,input.correlation,
        c.requestId&&isUUID(c.requestId)?c.requestId:input.correlation,JSON.stringify(payload)]);
    await client.query(
      'INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [c.tenantId,c.factoryId,'INVENTORY_ITEM',input.itemId,input.outboxEvent,JSON.stringify({...payload,correlation_id:input.correlation})]);
  }

  private async insertQualityReworkEvent(client:PoolClient,c:QualityContext,input:{
    reworkOrderId:string;defectId:string;version:number;from:string|null;to:string;command:string;reason:string;
    evidence:Record<string,unknown>;payload?:Record<string,unknown>;key:string;hash:string;correlation:string;
  }){
    const q=await client.query("INSERT INTO quality_rework_events (tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,idempotency_key,request_hash,actor_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14::uuid) RETURNING id::text AS id",
      [c.tenantId,c.factoryId,input.reworkOrderId,input.version,input.from,input.to,input.command,input.reason,JSON.stringify(input.evidence),JSON.stringify(input.payload??{}),input.key,input.hash,c.userId,input.correlation]);
    const eventId=String(q.rows[0]?.id??'');if(!eventId)throw new Error('QUALITY_REWORK_EVENT_INSERT_FAILED');
    await this.auditOutbox(client,c,{inspectionId:undefined,defectId:input.defectId,action:'QUALITY_REWORK_EVENT',correlation:input.correlation,
      payload:{rework_event_id:eventId,rework_order_id:input.reworkOrderId,version:input.version,from_status:input.from,to_status:input.to,command:input.command,reason:input.reason,...(input.payload??{})},
      aggregateType:'QUALITY_REWORK',aggregateId:input.reworkOrderId,outboxEvent:'QUALITY.REWORK_CHANGED'});
    return{eventId};
  }

  async listHolds(c:QualityContext,rawStatus?:string,rawLimit?:number){
    this.validateScope(c);const status=rawStatus?.trim().toUpperCase()||null;
    if(status&&!['ACTIVE','RELEASED','DISPOSED'].includes(status)) throw new BadRequestException('status must be ACTIVE, RELEASED or DISPOSED');
    const limit=rawLimit??50;if(!Number.isInteger(limit)||limit<1||limit>100) throw new BadRequestException('limit must be between 1 and 100');
    const r=await this.database.query("SELECT h.id::text AS id,h.inspection_id::text AS inspection_id,h.inventory_item_id::text AS inventory_item_id,h.traceability_unit_id::text AS traceability_unit_id,h.work_order_id::text AS work_order_id,h.status,h.reason,h.created_at::text AS created_at,h.released_by_user_id::text AS released_by_user_id,h.released_at::text AS released_at,h.release_reason,qi.inspection_type,qi.target_type,qi.target_id::text AS target_id,qi.status AS inspection_status FROM quality_holds h JOIN quality_inspections qi ON qi.id=h.inspection_id AND qi.tenant_id=h.tenant_id AND qi.factory_id=h.factory_id WHERE h.tenant_id=$1 AND h.factory_id=$2 AND ($3::text IS NULL OR h.status=$3) ORDER BY CASE WHEN h.status='ACTIVE' THEN 0 ELSE 1 END,h.created_at DESC LIMIT $4",
      [c.tenantId,c.factoryId,status,limit],{tenantId:c.tenantId,userId:c.userId});return r.rows;
  }

  async recordNcrAction(c:QualityContext,ncrId:string,dto:CreateQualityNcrActionDto,rawKey:string|null){
    this.validateScope(c);this.uuid(ncrId,'ncrId');const key=this.key(rawKey),text=this.text(dto.action_text,'action_text',4000);
    const responsible=dto.responsible_user_id?this.uuidValue(dto.responsible_user_id,'responsible_user_id'):null,dueDate=dto.due_date??null,correlation=this.correlation(c);
    if(dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new BadRequestException('due_date must use YYYY-MM-DD');
    const hash=this.hash({ncr_id:ncrId,action_type:dto.action_type,action_text:text,responsible_user_id:responsible,due_date:dueDate});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'ncr-action',key);
      const old=await client.query("SELECT id::text AS id,request_hash FROM quality_ncr_actions WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",[c.tenantId,c.factoryId,key]);
      if(old.rows[0]){if(String(old.rows[0].request_hash).trim()!==hash)throw new ConflictException('Idempotency-Key was already used for another NCR action');return{id:String(old.rows[0].id),replayed:true};}
      const found=await client.query("SELECT id::text AS id,status,row_version::int AS row_version FROM quality_ncrs WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[ncrId,c.tenantId,c.factoryId]);
      const n=found.rows[0];if(!n)throw new NotFoundException('NCR was not found in this factory');if(n.status==='CLOSED')throw new ConflictException('Closed NCRs cannot accept new actions');
      const ins=await client.query("INSERT INTO quality_ncr_actions (tenant_id,factory_id,ncr_id,action_type,action_text,responsible_user_id,due_date,idempotency_key,request_hash,recorded_by_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6::uuid,$7::date,$8,$9,$10,$11::uuid) RETURNING id::text AS id",
        [c.tenantId,c.factoryId,ncrId,dto.action_type,text,responsible,dueDate,key,hash,c.userId,correlation]);
      const actionId=String(ins.rows[0]?.id??'');if(!actionId)throw new Error('QUALITY_NCR_ACTION_INSERT_FAILED');
      await this.insertNcrActionEvent(client,c,{
        ncrId,actionId,version:1,from:null,to:'PLANNED',command:'CREATED',
        reason:'CAPA action planned',evidence:{action_type:dto.action_type},
        key:'ncr-action-created:'+actionId,hash:this.hash({ncrId,actionId,action_type:dto.action_type}),correlation,
      });
      if(n.status==='OPEN') await client.query("UPDATE quality_ncrs SET status='IN_PROGRESS',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$4",[ncrId,c.tenantId,c.factoryId,n.row_version]);
      await this.auditOutbox(client,c,{ncrId,action:'NCR_ACTION_PLANNED',correlation,payload:{action_id:actionId,action_type:dto.action_type,action_text:text,responsible_user_id:responsible,due_date:dueDate,action_status:'PLANNED'},aggregateType:'QUALITY_NCR',aggregateId:ncrId,outboxEvent:'QUALITY.NCR_CHANGED'});
      return{id:actionId,replayed:false};
    });
    const r=await this.database.query("SELECT id::text AS id,ncr_id::text AS ncr_id,action_type,action_text,responsible_user_id::text AS responsible_user_id,due_date::text AS due_date,recorded_by_user_id::text AS recorded_by_user_id,created_at::text AS created_at FROM quality_ncr_actions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});return{...r.rows[0],replayed:result.replayed};
  }


  async transitionNcrAction(c: QualityContext, ncrId: string, actionId: string,
    dto: QualityNcrActionTransitionDto, rawKey: string | null) {
    this.validateScope(c); this.uuid(ncrId,'ncrId'); this.uuid(actionId,'actionId');
    const key=this.key(rawKey), reason=this.text(dto.reason,'reason',2000);
    const evidence=this.jsonObject(dto.evidence);
    if(dto.action==='COMPLETE' && Object.keys(evidence).length===0) {
      throw new BadRequestException('completion evidence must be a non-empty JSON object');
    }
    const correlation=this.correlation(c);
    const hash=this.hash({ncr_id:ncrId,action_id:actionId,action:dto.action,expected_version:dto.expected_version,reason,evidence});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'ncr-action-transition',key);
      const previous=await client.query("SELECT id::text AS id,action_id::text AS action_id,request_hash FROM quality_ncr_action_events WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",
        [c.tenantId,c.factoryId,key]);
      if(previous.rows[0]){
        if(String(previous.rows[0].request_hash).trim()!==hash) throw new ConflictException('Idempotency-Key was used for another CAPA transition');
        return {actionId:String(previous.rows[0].action_id),replayed:true};
      }
      const rowResult=await client.query("SELECT a.id::text AS id,a.ncr_id::text AS ncr_id,a.action_type,a.action_status,a.row_version::int AS row_version,a.completed_by_user_id::text AS completed_by_user_id,n.status AS ncr_status FROM quality_ncr_actions a JOIN quality_ncrs n ON n.id=a.ncr_id AND n.tenant_id=a.tenant_id AND n.factory_id=a.factory_id WHERE a.id=$1 AND a.ncr_id=$2 AND a.tenant_id=$3 AND a.factory_id=$4 FOR UPDATE OF a,n",
        [actionId,ncrId,c.tenantId,c.factoryId]);
      const a=rowResult.rows[0];
      if(!a) throw new NotFoundException('CAPA action was not found for this NCR');
      if(a.ncr_status==='CLOSED') throw new ConflictException('Closed NCRs cannot accept further CAPA transitions');
      if(Number(a.row_version)!==dto.expected_version) throw new ConflictException('CAPA action version is stale');
      const from=String(a.action_status);
      if(dto.action==='START' && !['PLANNED','REJECTED'].includes(from)) throw new ConflictException('Only planned or rejected CAPA actions can start');
      if(dto.action==='COMPLETE' && from!=='IN_PROGRESS') throw new ConflictException('CAPA action must be in progress before completion');
      const next=dto.action==='START'?'IN_PROGRESS':'COMPLETED';
      let updated;
      if(dto.action==='START'){
        updated=await client.query("UPDATE quality_ncr_actions SET action_status='IN_PROGRESS',row_version=row_version+1,started_by_user_id=$1,started_at=clock_timestamp(),completed_by_user_id=NULL,completed_at=NULL,completion_notes=NULL,completion_evidence='{}'::jsonb,verified_by_user_id=NULL,verified_at=NULL,verification_notes=NULL,verification_evidence='{}'::jsonb,updated_by_user_id=$1,updated_at=clock_timestamp() WHERE id=$2 AND ncr_id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6 RETURNING row_version::int AS row_version",
          [c.userId,actionId,ncrId,c.tenantId,c.factoryId,a.row_version]);
      } else {
        updated=await client.query("UPDATE quality_ncr_actions SET action_status='COMPLETED',row_version=row_version+1,completed_by_user_id=$1,completed_at=clock_timestamp(),completion_notes=$2,completion_evidence=$3::jsonb,updated_by_user_id=$1,updated_at=clock_timestamp() WHERE id=$4 AND ncr_id=$5 AND tenant_id=$6 AND factory_id=$7 AND row_version=$8 RETURNING row_version::int AS row_version",
          [c.userId,reason,JSON.stringify(evidence),actionId,ncrId,c.tenantId,c.factoryId,a.row_version]);
      }
      const version=Number(updated.rows[0]?.row_version??0);
      if(!version) throw new ConflictException('CAPA action changed while transitioning');
      await this.insertNcrActionEvent(client,c,{
        ncrId,actionId,version,from,to:next,command:dto.action,reason,evidence,
        key,hash,correlation,
      });
      await this.auditOutbox(client,c,{ncrId,action:'NCR_CAPA_'+dto.action,correlation,
        payload:{action_id:actionId,action_type:a.action_type,from_status:from,to_status:next,reason,version},
        aggregateType:'QUALITY_NCR',aggregateId:ncrId,outboxEvent:'QUALITY.NCR_CHANGED'});
      return {actionId,replayed:false};
    });
    const r=await this.database.query("SELECT id::text AS id,ncr_id::text AS ncr_id,action_type,action_text,responsible_user_id::text AS responsible_user_id,due_date::text AS due_date,action_status,row_version::int AS row_version,started_by_user_id::text AS started_by_user_id,started_at::text AS started_at,completed_by_user_id::text AS completed_by_user_id,completed_at::text AS completed_at,completion_notes,completion_evidence,verified_by_user_id::text AS verified_by_user_id,verified_at::text AS verified_at,verification_notes,verification_evidence FROM quality_ncr_actions WHERE id=$1 AND ncr_id=$2 AND tenant_id=$3 AND factory_id=$4",
      [result.actionId,ncrId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    const events=await this.database.query("SELECT version::int AS version,from_status,to_status,command,reason,evidence,actor_user_id::text AS actor_user_id,created_at::text AS created_at FROM quality_ncr_action_events WHERE action_id=$1 AND ncr_id=$2 AND tenant_id=$3 AND factory_id=$4 ORDER BY version",
      [result.actionId,ncrId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {...r.rows[0],events:events.rows,replayed:result.replayed};
  }

  async verifyNcrAction(c: QualityContext, ncrId: string, actionId: string,
    dto: QualityNcrActionVerificationDto, rawKey: string | null) {
    this.validateScope(c);this.uuid(ncrId,'ncrId');this.uuid(actionId,'actionId');
    const key=this.key(rawKey),reason=this.text(dto.reason,'reason',2000),evidence=this.jsonObject(dto.evidence);
    if(Object.keys(evidence).length===0) throw new BadRequestException('verification evidence must be a non-empty JSON object');
    const correlation=this.correlation(c), hash=this.hash({ncr_id:ncrId,action_id:actionId,decision:dto.decision,expected_version:dto.expected_version,reason,evidence});
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,'ncr-action-verification',key);
      const previous=await client.query("SELECT action_id::text AS action_id,request_hash FROM quality_ncr_action_events WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",
        [c.tenantId,c.factoryId,key]);
      if(previous.rows[0]){
        if(String(previous.rows[0].request_hash).trim()!==hash) throw new ConflictException('Idempotency-Key was used for another CAPA verification');
        return {actionId:String(previous.rows[0].action_id),replayed:true};
      }
      const found=await client.query("SELECT a.id::text AS id,a.ncr_id::text AS ncr_id,a.action_type,a.action_status,a.row_version::int AS row_version,a.completed_by_user_id::text AS completed_by_user_id,n.status AS ncr_status FROM quality_ncr_actions a JOIN quality_ncrs n ON n.id=a.ncr_id AND n.tenant_id=a.tenant_id AND n.factory_id=a.factory_id WHERE a.id=$1 AND a.ncr_id=$2 AND a.tenant_id=$3 AND a.factory_id=$4 FOR UPDATE OF a,n",
        [actionId,ncrId,c.tenantId,c.factoryId]);
      const a=found.rows[0];
      if(!a) throw new NotFoundException('CAPA action was not found for this NCR');
      if(a.ncr_status==='CLOSED') throw new ConflictException('Closed NCRs cannot accept further CAPA verification');
      if(Number(a.row_version)!==dto.expected_version) throw new ConflictException('CAPA action version is stale');
      if(a.action_status!=='COMPLETED') throw new ConflictException('Only completed CAPA actions can be verified');
      if(String(a.completed_by_user_id)===c.userId) throw new ConflictException('CAPA verification must be performed by a different actor than the completer');
      const next=dto.decision==='PASS'?'VERIFIED':'REJECTED';
      const update=await client.query("UPDATE quality_ncr_actions SET action_status=$1,row_version=row_version+1,verified_by_user_id=$2,verified_at=clock_timestamp(),verification_notes=$3,verification_evidence=$4::jsonb,updated_by_user_id=$2,updated_at=clock_timestamp() WHERE id=$5 AND ncr_id=$6 AND tenant_id=$7 AND factory_id=$8 AND row_version=$9 RETURNING row_version::int AS row_version",
        [next,c.userId,reason,JSON.stringify(evidence),actionId,ncrId,c.tenantId,c.factoryId,a.row_version]);
      const version=Number(update.rows[0]?.row_version??0);
      if(!version) throw new ConflictException('CAPA action changed while verifying');
      await this.insertNcrActionEvent(client,c,{
        ncrId,actionId,version,from:'COMPLETED',to:next,command:dto.decision==='PASS'?'VERIFY_PASS':'VERIFY_FAIL',
        reason,evidence,key,hash,correlation,
      });
      await this.auditOutbox(client,c,{ncrId,action:'NCR_CAPA_'+(dto.decision==='PASS'?'VERIFIED':'VERIFICATION_REJECTED'),correlation,
        payload:{action_id:actionId,action_type:a.action_type,from_status:'COMPLETED',to_status:next,reason,version},
        aggregateType:'QUALITY_NCR',aggregateId:ncrId,outboxEvent:'QUALITY.NCR_CHANGED'});
      return {actionId,replayed:false};
    });
    const r=await this.database.query("SELECT id::text AS id,ncr_id::text AS ncr_id,action_type,action_text,responsible_user_id::text AS responsible_user_id,due_date::text AS due_date,action_status,row_version::int AS row_version,started_by_user_id::text AS started_by_user_id,started_at::text AS started_at,completed_by_user_id::text AS completed_by_user_id,completed_at::text AS completed_at,completion_notes,completion_evidence,verified_by_user_id::text AS verified_by_user_id,verified_at::text AS verified_at,verification_notes,verification_evidence FROM quality_ncr_actions WHERE id=$1 AND ncr_id=$2 AND tenant_id=$3 AND factory_id=$4",
      [result.actionId,ncrId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    const events=await this.database.query("SELECT version::int AS version,from_status,to_status,command,reason,evidence,actor_user_id::text AS actor_user_id,created_at::text AS created_at FROM quality_ncr_action_events WHERE action_id=$1 AND ncr_id=$2 AND tenant_id=$3 AND factory_id=$4 ORDER BY version",
      [result.actionId,ncrId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {...r.rows[0],events:events.rows,replayed:result.replayed};
  }

  private async insertNcrActionEvent(client:PoolClient,c:QualityContext,input:{
    ncrId:string;actionId:string;version:number;from:string|null;to:string;command:string;reason:string;
    evidence:Record<string,unknown>;key:string;hash:string;correlation:string;
  }) {
    await client.query("INSERT INTO quality_ncr_action_events (tenant_id,factory_id,ncr_id,action_id,version,from_status,to_status,command,reason,evidence,idempotency_key,request_hash,actor_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::uuid)",
      [c.tenantId,c.factoryId,input.ncrId,input.actionId,input.version,input.from,input.to,input.command,input.reason,
       JSON.stringify(input.evidence),input.key,input.hash,c.userId,input.correlation]);
  }

  async closeNcr(c:QualityContext,ncrId:string,dto:CloseQualityNcrDto){
    this.validateScope(c);this.uuid(ncrId,'ncrId');const reason=this.text(dto.reason,'reason',2000),correlation=this.correlation(c);
    const result=await this.database.transaction(c,async client=>{
      const found=await client.query("SELECT n.id::text AS id,n.inspection_id::text AS inspection_id,n.status,n.row_version::int AS row_version,n.closure_reason,qi.status AS inspection_status FROM quality_ncrs n JOIN quality_inspections qi ON qi.id=n.inspection_id AND qi.tenant_id=n.tenant_id AND qi.factory_id=n.factory_id WHERE n.id=$1 AND n.tenant_id=$2 AND n.factory_id=$3 FOR UPDATE OF n",[ncrId,c.tenantId,c.factoryId]);
      const n=found.rows[0];if(!n)throw new NotFoundException('NCR was not found in this factory');
      if(n.status==='CLOSED'){if(n.closure_reason===reason)return{replayed:true};throw new ConflictException('NCR is already closed with a different closure reason');}
      if(Number(n.row_version)!==dto.expected_version)throw new ConflictException('NCR version is stale');
      if(!['PASSED','DISPOSITIONED'].includes(String(n.inspection_status))) {
        throw new ConflictException('Resolve or disposition the inspection before closing its NCR');
      }
      const activeHold=await client.query("SELECT 1 FROM quality_holds WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' LIMIT 1",
        [n.inspection_id,c.tenantId,c.factoryId]);
      if(activeHold.rows[0]) throw new ConflictException('Release or dispose the active quality hold before closing its NCR');
      const actions=await client.query("SELECT action_type,action_status FROM quality_ncr_actions WHERE ncr_id=$1 AND tenant_id=$2 AND factory_id=$3",[ncrId,c.tenantId,c.factoryId]);
      const verifiedTypes=new Set(actions.rows.filter((x:Record<string,unknown>)=>x.action_status==='VERIFIED').map((x:Record<string,unknown>)=>String(x.action_type)));
      if(!['CONTAINMENT','CORRECTIVE','PREVENTIVE'].every(x=>verifiedTypes.has(x)))throw new ConflictException('NCR closure requires containment, corrective and preventive actions to be independently verified');
      const defects=await client.query("SELECT count(*)::int AS count FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status IN ('OPEN','REWORK')",[n.inspection_id,c.tenantId,c.factoryId]);
      if(Number(defects.rows[0]?.count??0)>0)throw new ConflictException('NCR cannot close while defects remain open or in rework');
      const updated=await client.query("UPDATE quality_ncrs SET status='CLOSED',row_version=row_version+1,closed_by_user_id=$1,closed_at=clock_timestamp(),closure_reason=$2,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6",
        [c.userId,reason,ncrId,c.tenantId,c.factoryId,n.row_version]);
      if(updated.rowCount!==1)throw new ConflictException('NCR changed while closing');
      await this.auditOutbox(client,c,{inspectionId:String(n.inspection_id),ncrId,action:'NCR_CLOSED',correlation,payload:{reason,version:Number(n.row_version)+1},aggregateType:'QUALITY_NCR',aggregateId:ncrId,outboxEvent:'QUALITY.NCR_CHANGED'});
      return{replayed:false};
    });return{id:ncrId,status:'CLOSED',...result};
  }


  private normalizePlanCriterion(input: CreateQualityInspectionPlanDto['criteria'][number], index: number) {
    const code = this.text(input.criterion_code,'criterion_code',100).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(code)) throw new BadRequestException('criterion_code must be a valid code');
    const name = this.text(input.name,'criterion name',255);
    const description = input.description?.trim() || null;
    const valueType = input.value_type;
    const operator = input.comparison_operator;
    const targetValue = input.target_value?.trim() || null;
    const lower = input.lower_limit === undefined ? null : Number(input.lower_limit);
    const upper = input.upper_limit === undefined ? null : Number(input.upper_limit);
    const allowed = input.allowed_values ?? [];
    const unit = input.unit?.trim() || null;
    const required = input.is_required ?? true;
    const critical = input.is_critical ?? false;
    const sequence = input.sequence_number ?? index + 1;
    if (!Number.isInteger(sequence) || sequence < 1) throw new BadRequestException('sequence_number must be a positive integer');
    if (allowed.some(value => typeof value !== 'string' || !value.trim()) || allowed.length > 100) throw new BadRequestException('allowed_values must be a list of non-empty strings');
    if (['GT','GTE','LT','LTE','BETWEEN'].includes(operator) && valueType !== 'NUMERIC') throw new BadRequestException('range comparison operators require a NUMERIC criterion');
    if (operator === 'CONTAINS' && valueType !== 'TEXT') throw new BadRequestException('CONTAINS is only supported for TEXT criteria');
    if (valueType === 'BOOLEAN' && !['EQ','NE'].includes(operator)) throw new BadRequestException('BOOLEAN criteria support only EQ or NE');
    if (valueType === 'ENUM' && !['EQ','NE','IN'].includes(operator)) throw new BadRequestException('ENUM criteria support EQ, NE or IN');
    if (operator === 'BETWEEN' && (lower === null || upper === null || lower > upper)) throw new BadRequestException('BETWEEN requires lower_limit <= upper_limit');
    if (operator === 'IN' && allowed.length < 1) throw new BadRequestException('IN requires a non-empty allowed_values list');
    if (operator !== 'BETWEEN' && operator !== 'IN' && !targetValue) throw new BadRequestException('target_value is required for this comparison operator');
    if (valueType === 'BOOLEAN' && !['true','false'].includes((targetValue ?? '').toLowerCase())) throw new BadRequestException('BOOLEAN target_value must be true or false');
    if (valueType === 'NUMERIC' && targetValue !== null && (!Number.isFinite(Number(targetValue)) || Math.abs(Number(targetValue)*1e6-Math.round(Number(targetValue)*1e6)) > 0.000001)) throw new BadRequestException('NUMERIC target_value must be numeric with at most six decimal places');
    if (valueType === 'NUMERIC' && allowed.some(value => !Number.isFinite(Number(value)) || Math.abs(Number(value)*1e6-Math.round(Number(value)*1e6)) > 0.000001)) throw new BadRequestException('NUMERIC allowed_values must contain numbers with at most six decimal places');
    return {
      criterion_code:code,name,description,value_type:valueType,comparison_operator:operator,target_value:targetValue,
      lower_limit:lower,upper_limit:upper,allowed_values:allowed,unit,is_required:required,is_critical:critical,
      sequence_number:sequence,
    };
  }

  private evaluateCriterion(criterion: Record<string,unknown>, observed: string): 'PASS' | 'FAIL' {
    const type=String(criterion.value_type), operator=String(criterion.comparison_operator);
    const target=criterion.target_value === null || criterion.target_value === undefined ? null : String(criterion.target_value);
    const allowed=Array.isArray(criterion.allowed_values)?criterion.allowed_values.map(String):[];
    if(type==='NUMERIC'){
      const value=Number(observed);
      if(!Number.isFinite(value)) throw new BadRequestException('observed_value must be numeric for this inspection criterion');
      const targetNumber=target===null?null:Number(target);
      const lower=criterion.lower_limit===null||criterion.lower_limit===undefined?null:Number(criterion.lower_limit);
      const upper=criterion.upper_limit===null||criterion.upper_limit===undefined?null:Number(criterion.upper_limit);
      let pass=false;
      switch(operator){
        case 'EQ': pass=targetNumber!==null&&value===targetNumber;break;
        case 'NE': pass=targetNumber!==null&&value!==targetNumber;break;
        case 'GT': pass=targetNumber!==null&&value>targetNumber;break;
        case 'GTE': pass=targetNumber!==null&&value>=targetNumber;break;
        case 'LT': pass=targetNumber!==null&&value<targetNumber;break;
        case 'LTE': pass=targetNumber!==null&&value<=targetNumber;break;
        case 'BETWEEN': pass=lower!==null&&upper!==null&&value>=lower&&value<=upper;break;
        case 'IN': pass=allowed.includes(observed);break;
        default: throw new BadRequestException('Unsupported numeric quality criterion operator');
      }
      return pass?'PASS':'FAIL';
    }
    if(type==='BOOLEAN'){
      const value=observed.toLowerCase();
      if(!['true','false'].includes(value)||!target||!['true','false'].includes(target.toLowerCase())) throw new BadRequestException('observed_value must be true or false for this criterion');
      const equal=value===target.toLowerCase();
      return (operator==='EQ'?equal:!equal)?'PASS':'FAIL';
    }
    let pass=false;
    switch(operator){
      case 'EQ': pass=target!==null&&observed===target;break;
      case 'NE': pass=target!==null&&observed!==target;break;
      case 'IN': pass=allowed.includes(observed);break;
      case 'CONTAINS': pass=type==='TEXT'&&target!==null&&observed.includes(target);break;
      default: throw new BadRequestException('Unsupported text/enum quality criterion operator');
    }
    return pass?'PASS':'FAIL';
  }

  private jsonArray(value: unknown): Record<string,unknown>[] {
    if(Array.isArray(value)) return value as Record<string,unknown>[];
    if(typeof value==='string') {
      try { const parsed: unknown=JSON.parse(value); return Array.isArray(parsed)?parsed as Record<string,unknown>[]:[]; }
      catch { return []; }
    }
    return [];
  }


  private async linkDefectToInspection(client:PoolClient,c:QualityContext,inspectionId:string,defectId:string,affectedQuantity:string,correlation:string){
    const q=await client.query("SELECT target_type,target_id::text AS target_id,inventory_item_id::text AS inventory_item_id,traceability_unit_id::text AS traceability_unit_id FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE",
      [inspectionId,c.tenantId,c.factoryId]);
    const qi=q.rows[0];if(!qi)throw new NotFoundException('Quality inspection was not found');
    const refs:{type:string;id:string;quantity:string|null}[]=[],seen=new Set<string>();
    const add=(type:string,id:unknown,quantity:string|null=null)=>{if(typeof id!=='string'||!id)return;const k=type+':'+id;if(!seen.has(k)){seen.add(k);refs.push({type,id,quantity});}};
    add('INVENTORY_ITEM',qi.inventory_item_id);
    add('TRACEABILITY_UNIT',qi.traceability_unit_id,qi.traceability_unit_id?affectedQuantity:null);
    switch(String(qi.target_type)){
      case 'INVENTORY_ITEM': add('INVENTORY_ITEM',String(qi.target_id));break;
      case 'TRACEABILITY_UNIT':{
        const t=await client.query("SELECT inventory_item_id::text AS inventory_item_id,order_id::text AS order_id,order_line_id::text AS order_line_id,production_report_id::text AS production_report_id,goods_receipt_line_id::text AS goods_receipt_line_id FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
          [qi.target_id,c.tenantId,c.factoryId]);
        const u=t.rows[0];if(u){add('INVENTORY_ITEM',u.inventory_item_id);add('ORDER',u.order_id);add('ORDER_LINE',u.order_line_id);add('PRODUCTION_REPORT',u.production_report_id);add('GOODS_RECEIPT_LINE',u.goods_receipt_line_id);}
        break;
      }
      case 'GOODS_RECEIPT_LINE':{
        add('GOODS_RECEIPT_LINE',String(qi.target_id));
        const line=await client.query("SELECT inventory_item_id::text AS inventory_item_id FROM goods_receipt_lines WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[qi.target_id,c.tenantId,c.factoryId]);
        add('INVENTORY_ITEM',line.rows[0]?.inventory_item_id);
        const units=await client.query("SELECT id::text AS id FROM traceability_units WHERE goods_receipt_line_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",[qi.target_id,c.tenantId,c.factoryId]);
        for(const unit of units.rows)add('TRACEABILITY_UNIT',String(unit.id));
        break;
      }
      case 'PRODUCTION_REPORT':{
        const report=await client.query("SELECT r.id::text AS id,r.order_id::text AS order_id,r.order_line_id::text AS order_line_id,r.work_order_id::text AS work_order_id,COALESCE(wo.finished_item_id,l.inventory_item_id)::text AS item_id FROM order_production_reports r JOIN order_lines l ON l.id=r.order_line_id AND l.order_id=r.order_id AND l.tenant_id=r.tenant_id AND l.factory_id=r.factory_id LEFT JOIN work_orders wo ON wo.id=r.work_order_id AND wo.tenant_id=r.tenant_id AND wo.factory_id=r.factory_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3",
          [qi.target_id,c.tenantId,c.factoryId]);
        const r=report.rows[0];if(r){add('PRODUCTION_REPORT',String(r.id));add('ORDER',r.order_id);add('ORDER_LINE',r.order_line_id);add('WORK_ORDER',r.work_order_id);add('INVENTORY_ITEM',r.item_id);}
        const units=await client.query("SELECT id::text AS id FROM traceability_units WHERE production_report_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",[qi.target_id,c.tenantId,c.factoryId]);
        for(const unit of units.rows)add('TRACEABILITY_UNIT',String(unit.id));
        break;
      }
      case 'WORK_ORDER':{
        const work=await client.query("SELECT id::text AS id,source_order_id::text AS order_id,source_order_line_id::text AS order_line_id,finished_item_id::text AS item_id FROM work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
          [qi.target_id,c.tenantId,c.factoryId]);
        const w=work.rows[0];if(w){add('WORK_ORDER',String(w.id));add('ORDER',w.order_id);add('ORDER_LINE',w.order_line_id);add('INVENTORY_ITEM',w.item_id);}
        const ops=await client.query("SELECT id::text AS id FROM work_order_operations WHERE work_order_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY step_number",[qi.target_id,c.tenantId,c.factoryId]);
        for(const op of ops.rows)add('WORK_ORDER_OPERATION',String(op.id));
        const reports=await client.query("SELECT id::text AS id FROM order_production_reports WHERE work_order_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",[qi.target_id,c.tenantId,c.factoryId]);
        for(const report of reports.rows){
          add('PRODUCTION_REPORT',String(report.id));
          const units=await client.query("SELECT id::text AS id FROM traceability_units WHERE production_report_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",[report.id,c.tenantId,c.factoryId]);
          for(const unit of units.rows)add('TRACEABILITY_UNIT',String(unit.id));
        }
        break;
      }
    }
    if(refs.length===0)throw new ConflictException('Quality defect requires at least one scoped source link');
    for(const ref of refs){
      await this.insertDefectLink(client,c,{defectId,linkType:ref.type,targetId:ref.id,source:'INSPECTION_TARGET',quantity:ref.quantity,
        notes:'Derived from inspection target and factory-scoped source records',
        evidence:{inspection_id:inspectionId,target_type:qi.target_type,target_id:qi.target_id},
        key:'defect-context:'+defectId+':'+ref.type+':'+ref.id,correlation});
    }
  }

  private async insertDefectLink(client:PoolClient,c:QualityContext,input:{
    defectId:string;linkType:string;targetId:string;source:'INSPECTION_TARGET'|'OPERATOR'|'REWORK_OUTPUT';
    quantity:string|null;notes:string|null;evidence:Record<string,unknown>;key:string;correlation:string;reworkOrderId?:string;
  }){
    const hash=this.hash({defect_id:input.defectId,link_type:input.linkType,target_id:input.targetId,source:input.source,
      quantity:input.quantity,notes:input.notes,evidence:input.evidence,rework_order_id:input.reworkOrderId??null});
    const old=await client.query("SELECT id::text AS id,request_hash FROM quality_defect_links WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE",
      [c.tenantId,c.factoryId,input.key]);
    if(old.rows[0]){
      if(String(old.rows[0].request_hash).trim()!==hash)throw new ConflictException('Idempotency-Key was already used for another defect link');
      return{id:String(old.rows[0].id),replayed:true};
    }
    const col:Record<string,string>={INVENTORY_ITEM:'inventory_item_id',TRACEABILITY_UNIT:'traceability_unit_id',ORDER:'order_id',
      ORDER_LINE:'order_line_id',WORK_ORDER:'work_order_id',WORK_ORDER_OPERATION:'work_order_operation_id',
      PRODUCTION_REPORT:'production_report_id',GOODS_RECEIPT_LINE:'goods_receipt_line_id',REWORK_OUTPUT:'traceability_unit_id'};
    const targetColumn=col[input.linkType];if(!targetColumn)throw new BadRequestException('Unsupported defect traceability link type');
    const fields:Record<string,string>={[targetColumn]:input.targetId};
    if(input.linkType==='ORDER_LINE'){
      const q=await client.query("SELECT order_id::text AS order_id FROM order_lines WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[input.targetId,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Order line was not found in this factory');fields.order_id=String(q.rows[0].order_id);
    }
    if(input.linkType==='WORK_ORDER_OPERATION'){
      const q=await client.query("SELECT work_order_id::text AS work_order_id FROM work_order_operations WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[input.targetId,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Work-order operation was not found in this factory');fields.work_order_id=String(q.rows[0].work_order_id);
    }
    if(input.linkType==='GOODS_RECEIPT_LINE'){
      const q=await client.query("SELECT goods_receipt_id::text AS goods_receipt_id FROM goods_receipt_lines WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[input.targetId,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Goods-receipt line was not found in this factory');fields.goods_receipt_id=String(q.rows[0].goods_receipt_id);
    }
    if(input.linkType==='REWORK_OUTPUT'){
      if(!input.reworkOrderId)throw new BadRequestException('rework_order_id is required for a rework output link');fields.rework_order_id=input.reworkOrderId;
    }
    const cols=['tenant_id','factory_id','defect_id','link_type',...Object.keys(fields),'affected_quantity','link_source','notes','evidence','idempotency_key','request_hash','created_by_user_id','correlation_id'];
    const vals:unknown[]=[c.tenantId,c.factoryId,input.defectId,input.linkType,...Object.values(fields),input.quantity,input.source,input.notes,JSON.stringify(input.evidence),input.key,hash,c.userId,input.correlation];
    const placeholders=cols.map((name,index)=>name==='evidence'?'$'+(index+1)+'::jsonb':'$'+(index+1)).join(',');
    const ins=await client.query("INSERT INTO quality_defect_links ("+cols.join(',')+") VALUES ("+placeholders+") RETURNING id::text AS id",vals);
    const linkId=String(ins.rows[0]?.id??'');
    if(!linkId)throw new Error('QUALITY_DEFECT_LINK_INSERT_FAILED');
    const defect=await client.query("SELECT inspection_id::text AS inspection_id FROM quality_defects WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [input.defectId,c.tenantId,c.factoryId]);
    await this.auditOutbox(client,c,{
      inspectionId:defect.rows[0]?.inspection_id?String(defect.rows[0].inspection_id):undefined,
      defectId:input.defectId,action:'DEFECT_TRACEABILITY_LINKED',correlation:input.correlation,
      payload:{link_id:linkId,link_type:input.linkType,target_id:input.targetId,link_source:input.source,
        affected_quantity:input.quantity,notes:input.notes},
      aggregateType:'QUALITY_DEFECT',aggregateId:input.defectId,outboxEvent:'QUALITY.DEFECT_TRACEABILITY_LINKED',
    });
    return{id:linkId,replayed:false};
  }

  private async resolveTarget(client:PoolClient,c:QualityContext,type:string,id:string):Promise<TargetBinding>{
    let q;
    if(type==='INVENTORY_ITEM'){
      q=await client.query("SELECT id::text AS id FROM inventory_items WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[id,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Inventory item was not found in this factory');
      return{inventory_item_id:String(q.rows[0].id),traceability_unit_id:null,work_order_id:null};
    }
    if(type==='TRACEABILITY_UNIT'){
      q=await client.query("SELECT id::text AS id,inventory_item_id::text AS inventory_item_id FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[id,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Traceability unit was not found in this factory');
      return{inventory_item_id:q.rows[0].inventory_item_id?String(q.rows[0].inventory_item_id):null,traceability_unit_id:String(q.rows[0].id),work_order_id:null};
    }
    if(type==='GOODS_RECEIPT_LINE'){
      q=await client.query("SELECT l.id::text AS id,l.inventory_item_id::text AS inventory_item_id FROM goods_receipt_lines l JOIN goods_receipts g ON g.id=l.goods_receipt_id AND g.tenant_id=l.tenant_id AND g.factory_id=l.factory_id WHERE l.id=$1 AND l.tenant_id=$2 AND l.factory_id=$3 AND g.status='POSTED'",[id,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Posted GRN line was not found in this factory');
      return{inventory_item_id:q.rows[0].inventory_item_id?String(q.rows[0].inventory_item_id):null,traceability_unit_id:null,work_order_id:null};
    }
    if(type==='PRODUCTION_REPORT'){
      q=await client.query("SELECT r.id::text AS id,COALESCE(wo.finished_item_id,ol.inventory_item_id)::text AS inventory_item_id FROM order_production_reports r JOIN order_lines ol ON ol.id=r.order_line_id AND ol.order_id=r.order_id AND ol.tenant_id=r.tenant_id AND ol.factory_id=r.factory_id LEFT JOIN work_orders wo ON wo.id=r.work_order_id AND wo.tenant_id=r.tenant_id AND wo.factory_id=r.factory_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3",[id,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Production report was not found in this factory');
      return{inventory_item_id:q.rows[0].inventory_item_id?String(q.rows[0].inventory_item_id):null,traceability_unit_id:null,work_order_id:null};
    }
    if(type==='WORK_ORDER'){
      q=await client.query("SELECT id::text AS id FROM work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",[id,c.tenantId,c.factoryId]);
      if(!q.rows[0])throw new NotFoundException('Work order was not found in this factory');
      return{inventory_item_id:null,traceability_unit_id:null,work_order_id:String(q.rows[0].id)};
    }
    throw new BadRequestException('Unsupported quality target type');
  }

  private async createNcr(client:PoolClient,c:QualityContext,inspectionId:string,severity:string,summary:string,correlation:string){
    const existing=await client.query("SELECT id::text AS id,status,ncr_number FROM quality_ncrs WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",
      [inspectionId,c.tenantId,c.factoryId]);
    if(existing.rows[0]){
      const existingId=String(existing.rows[0].id);
      await this.auditOutbox(client,c,{inspectionId,ncrId:existingId,action:'NCR_REASSESSMENT_RECORDED',correlation,
        aggregateType:'QUALITY_NCR',aggregateId:existingId,outboxEvent:'QUALITY.NCR_CHANGED',
        payload:{ncr_number:existing.rows[0].ncr_number,status:existing.rows[0].status,severity,summary}});
      return existingId;
    }
    const ncrNumber='NCR-'+randomUUID().replace(/-/g,'').slice(0,12).toUpperCase();
    const q=await client.query("INSERT INTO quality_ncrs (tenant_id,factory_id,inspection_id,ncr_number,severity,title,summary,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid) RETURNING id::text AS id",
      [c.tenantId,c.factoryId,inspectionId,ncrNumber,severity,'Quality non-conformance',summary,c.userId,correlation]);
    const id=String(q.rows[0]?.id??'');if(!id)throw new Error('QUALITY_NCR_INSERT_FAILED');
    await this.auditOutbox(client,c,{inspectionId,ncrId:id,action:'NCR_CREATED',correlation,payload:{ncr_number:ncrNumber,severity,summary},aggregateType:'QUALITY_NCR',aggregateId:id,outboxEvent:'QUALITY.NCR_CHANGED'});
  }

  private async inspectionEvent(client:PoolClient,c:QualityContext,i:{id:string;version:number;from:string|null;to:string;action:string;reason:string|null;hash:string;correlation:string;key:string}){
    await client.query("INSERT INTO quality_inspection_events (tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid)",
      [c.tenantId,c.factoryId,i.id,i.version,i.from,i.to,i.action,i.reason,i.key,i.hash,c.userId,i.correlation]);
  }

  private async updateDefect(client:PoolClient,c:QualityContext,id:string,expected:number,status:string,reason:string,correlation:string,dispositionId?:string){
    const found=await client.query("SELECT status,row_version::int AS row_version FROM quality_defects WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[id,c.tenantId,c.factoryId]);
    const row=found.rows[0];if(!row)throw new NotFoundException('Quality defect was not found');
    if(Number(row.row_version)!==expected)throw new ConflictException('Quality defect version is stale');
    if(row.status!=='OPEN' && !(row.status==='REWORK' && status==='RESOLVED'))throw new ConflictException('Only open defects or rework defects being resolved can be updated');
    const upd=await client.query("UPDATE quality_defects SET status=$1,row_version=row_version+1,updated_by_user_id=$2,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6 RETURNING row_version::int AS row_version",
      [status,c.userId,id,c.tenantId,c.factoryId,expected]);
    const version=Number(upd.rows[0]?.row_version??0);if(!version)throw new ConflictException('Quality defect changed during disposition');
    const hash=this.hash({defect_id:id,from_status:row.status,to_status:status,reason,disposition_id:dispositionId??null});
    await client.query("INSERT INTO quality_defect_events (tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid)",
      [c.tenantId,c.factoryId,id,row.status,status,status==='RESOLVED'?'RESOLVED':'DISPOSITIONED',reason,'quality-defect-transition:'+id+':'+version,hash,c.userId,correlation]);
    await this.auditOutbox(client,c,{defectId:id,dispositionId,action:'DEFECT_'+status,correlation,payload:{from_status:row.status,to_status:status,reason}});
  }

  private async auditOutbox(client:PoolClient,c:QualityContext,i:{inspectionId?:string;defectId?:string;holdId?:string|null;dispositionId?:string|null;ncrId?:string;action:string;correlation:string;payload:Record<string,unknown>;aggregateType?:string;aggregateId?:string;outboxEvent?:string}){
    await client.query("INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,hold_id,disposition_id,ncr_id,action_type,payload,actor_user_id,correlation_id) VALUES ($1,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9::jsonb,$10,$11::uuid)",
      [c.tenantId,c.factoryId,i.inspectionId??null,i.defectId??null,i.holdId??null,i.dispositionId??null,i.ncrId??null,i.action,JSON.stringify(i.payload),c.userId,i.correlation]);
    const aggregateType = i.aggregateType ?? (i.inspectionId ? 'QUALITY_INSPECTION' : i.defectId ? 'QUALITY_DEFECT' : i.ncrId ? 'QUALITY_NCR' : i.holdId ? 'QUALITY_HOLD' : 'QUALITY_DISPOSITION');
    const aggregateId = i.aggregateId ?? i.inspectionId ?? i.defectId ?? i.ncrId ?? i.holdId ?? i.dispositionId;
    if (!aggregateId) throw new Error('QUALITY_OUTBOX_AGGREGATE_REQUIRED');
    const outboxEvent = i.outboxEvent ?? (i.inspectionId ? 'QUALITY.INSPECTION_CHANGED' : i.defectId ? 'QUALITY.DEFECT_CHANGED' : i.ncrId ? 'QUALITY.NCR_CHANGED' : i.holdId ? 'QUALITY.HOLD_CHANGED' : 'QUALITY.DISPOSITION_CHANGED');
    await client.query("INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [c.tenantId,c.factoryId,aggregateType,aggregateId,outboxEvent,JSON.stringify({...i.payload,action:i.action,correlation_id:i.correlation})]);
  }

  private async lockKey(client:PoolClient,c:QualityContext,namespace:string,key:string){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['quality:'+c.tenantId+':'+c.factoryId+':'+namespace+':'+key]);
  }
  private key(raw:string|null){const k=raw?.trim()??'';if(!k||k.length>200)throw new BadRequestException('Idempotency-Key is required and must be at most 200 characters');return k;}
  private text(value:string|undefined,field:string,max:number){const v=value?.trim()??'';if(!v||v.length>max)throw new BadRequestException(field+' is required and must contain at most '+max+' characters');return v;}
  private quantity(value:number,field:string){if(!Number.isFinite(value)||value<=0||Math.abs(value*10000-Math.round(value*10000))>0.000001)throw new BadRequestException(field+' must be positive with at most four decimal places');return value.toFixed(4);}
  private units(value:string|number){const n=Number(value);if(!Number.isFinite(n)||n<0)throw new BadRequestException('Inventory quantity is invalid');return BigInt(Math.round(n*10000));}
  private unitsToDecimal(value:bigint){
    const negative=value<0n,absolute=negative?-value:value;
    const whole=(absolute/10000n).toString();
    const fraction=(absolute%10000n).toString().padStart(4,'0');
    return (negative?'-':'')+whole+'.'+fraction;
  }
  private jsonObject(value?:Record<string,unknown>){if(value==null)return{};if(typeof value!=='object'||Array.isArray(value))throw new BadRequestException('evidence must be a JSON object');return value;}
  private uuid(value:string,field:string){if(!isUUID(value))throw new BadRequestException(field+' must be a UUID');}
  private uuidValue(value:string,field:string){this.uuid(value,field);return value.toLowerCase();}
  private validateScope(c:QualityContext){this.uuid(c.userId,'userId');this.uuid(c.tenantId,'tenantId');this.uuid(c.factoryId,'factoryId');}
  private hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
  private correlation(c:QualityContext){if(c.traceId&&isUUID(c.traceId))return c.traceId;if(c.requestId&&isUUID(c.requestId))return c.requestId;return randomUUID();}
}
