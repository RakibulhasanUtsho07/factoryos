import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CloseQualityNcrDto, CreateQualityDefectDto, CreateQualityInspectionDto, CreateQualityNcrActionDto,
  ListQualityInspectionsQueryDto, QualityDispositionDto, QualityInspectionDecisionDto,
} from './quality.dto';
interface QualityContext {
  userId: string; tenantId: string; factoryId: string; requestId?: string | null; traceId?: string | null;
}

const INSPECTION_COLUMNS =
  "id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id, " +
  "inspection_type, target_type, target_id::text AS target_id, inventory_item_id::text AS inventory_item_id, " +
  "traceability_unit_id::text AS traceability_unit_id, plan_code, status, sample_quantity::text AS sample_quantity, " +
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
    const [defects,holds,dispositions,ncrResult]=await Promise.all([
      this.database.query("SELECT id::text AS id,defect_code,severity,affected_quantity::text AS affected_quantity,description,evidence,status,row_version::int AS row_version,reported_by_user_id::text AS reported_by_user_id,created_at::text AS created_at,updated_at::text AS updated_at FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query("SELECT id::text AS id,inventory_item_id::text AS inventory_item_id,traceability_unit_id::text AS traceability_unit_id,work_order_id::text AS work_order_id,status,reason,released_by_user_id::text AS released_by_user_id,released_at::text AS released_at,release_reason,created_at::text AS created_at FROM quality_holds WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query("SELECT id::text AS id,hold_id::text AS hold_id,action,status,quantity::text AS quantity,reason,inventory_item_id::text AS inventory_item_id,inventory_movement_id::text AS inventory_movement_id,created_by_user_id::text AS created_by_user_id,created_at::text AS created_at,completed_at::text AS completed_at FROM quality_dispositions WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query("SELECT id::text AS id,ncr_number,status,severity,title,summary,row_version::int AS row_version,created_at::text AS created_at,closed_at::text AS closed_at,closure_reason FROM quality_ncrs WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 LIMIT 1",
        [id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
    ]);
    let ncr: Record<string,unknown>|null=null;
    if(ncrResult.rows[0]){
      const row=ncrResult.rows[0] as Record<string,unknown>;
      const actions=await this.database.query("SELECT id::text AS id,action_type,action_text,responsible_user_id::text AS responsible_user_id,due_date::text AS due_date,recorded_by_user_id::text AS recorded_by_user_id,created_at::text AS created_at FROM quality_ncr_actions WHERE ncr_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id",
        [row.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
      ncr={...row,actions:actions.rows};
    }
    return {...inspection,defects:defects.rows,holds:holds.rows,dispositions:dispositions.rows,ncr};
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
      await this.auditOutbox(client,c,{inspectionId,defectId,action:'DEFECT_RECORDED',correlation,payload:{defect_code:code,severity:dto.severity,affected_quantity:quantity}});
      return {id:defectId,replayed:false};
    });
    const defect=await this.database.query("SELECT id::text AS id,inspection_id::text AS inspection_id,defect_code,severity,affected_quantity::text AS affected_quantity,description,evidence,status,row_version::int AS row_version,created_at::text AS created_at FROM quality_defects WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {...defect.rows[0],replayed:result.replayed};
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
      if(dto.action==='FAIL'||dto.action==='HOLD'){
        const hold=await client.query("INSERT INTO quality_holds (tenant_id,factory_id,inspection_id,inventory_item_id,traceability_unit_id,work_order_id,reason,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::uuid) RETURNING id::text AS id",
          [c.tenantId,c.factoryId,id,q.inventory_item_id,q.traceability_unit_id,q.target_type==='WORK_ORDER'?q.target_id:null,reason,c.userId,correlation]);
        const holdId=String(hold.rows[0]?.id??'');
        if(!holdId) throw new Error('QUALITY_HOLD_INSERT_FAILED');
        if(dto.action==='FAIL'){
          const defects=await client.query("SELECT CASE WHEN bool_or(severity='CRITICAL') THEN 'CRITICAL' WHEN bool_or(severity='MAJOR') THEN 'MAJOR' ELSE 'MINOR' END AS severity FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='OPEN'",[id,c.tenantId,c.factoryId]);
          await this.createNcr(client,c,id,String(defects.rows[0]?.severity??'MAJOR'),'Inspection failed: '+reason,correlation);
        } else await this.createNcr(client,c,id,'MAJOR','Quality hold: '+reason,correlation);
        await this.auditOutbox(client,c,{inspectionId:id,holdId,action:'QUALITY_HOLD_CREATED',correlation,payload:{status:'ACTIVE',target_type:q.target_type,target_id:q.target_id,reason}});
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
      if(n.status==='OPEN') await client.query("UPDATE quality_ncrs SET status='IN_PROGRESS',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND row_version=$4",[ncrId,c.tenantId,c.factoryId,n.row_version]);
      await this.auditOutbox(client,c,{ncrId,action:'NCR_ACTION_'+dto.action_type,correlation,payload:{action_type:dto.action_type,action_text:text,responsible_user_id:responsible,due_date:dueDate},aggregateType:'QUALITY_NCR',aggregateId:ncrId,outboxEvent:'QUALITY.NCR_CHANGED'});
      return{id:actionId,replayed:false};
    });
    const r=await this.database.query("SELECT id::text AS id,ncr_id::text AS ncr_id,action_type,action_text,responsible_user_id::text AS responsible_user_id,due_date::text AS due_date,recorded_by_user_id::text AS recorded_by_user_id,created_at::text AS created_at FROM quality_ncr_actions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3",
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});return{...r.rows[0],replayed:result.replayed};
  }

  async closeNcr(c:QualityContext,ncrId:string,dto:CloseQualityNcrDto){
    this.validateScope(c);this.uuid(ncrId,'ncrId');const reason=this.text(dto.reason,'reason',2000),correlation=this.correlation(c);
    const result=await this.database.transaction(c,async client=>{
      const found=await client.query("SELECT id::text AS id,inspection_id::text AS inspection_id,status,row_version::int AS row_version,closure_reason FROM quality_ncrs WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE",[ncrId,c.tenantId,c.factoryId]);
      const n=found.rows[0];if(!n)throw new NotFoundException('NCR was not found in this factory');
      if(n.status==='CLOSED'){if(n.closure_reason===reason)return{replayed:true};throw new ConflictException('NCR is already closed with a different closure reason');}
      if(Number(n.row_version)!==dto.expected_version)throw new ConflictException('NCR version is stale');
      const actions=await client.query("SELECT action_type FROM quality_ncr_actions WHERE ncr_id=$1 AND tenant_id=$2 AND factory_id=$3",[ncrId,c.tenantId,c.factoryId]);
      const types=new Set(actions.rows.map((x:Record<string,unknown>)=>String(x.action_type)));
      if(!['CONTAINMENT','CORRECTIVE','PREVENTIVE'].every(x=>types.has(x)))throw new ConflictException('NCR closure requires containment, corrective and preventive action evidence');
      const defects=await client.query("SELECT count(*)::int AS count FROM quality_defects WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status IN ('OPEN','REWORK')",[n.inspection_id,c.tenantId,c.factoryId]);
      if(Number(defects.rows[0]?.count??0)>0)throw new ConflictException('NCR cannot close while defects remain open or in rework');
      const updated=await client.query("UPDATE quality_ncrs SET status='CLOSED',row_version=row_version+1,closed_by_user_id=$1,closed_at=clock_timestamp(),closure_reason=$2,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6",
        [c.userId,reason,ncrId,c.tenantId,c.factoryId,n.row_version]);
      if(updated.rowCount!==1)throw new ConflictException('NCR changed while closing');
      await this.auditOutbox(client,c,{inspectionId:String(n.inspection_id),ncrId,action:'NCR_CLOSED',correlation,payload:{reason,version:Number(n.row_version)+1},aggregateType:'QUALITY_NCR',aggregateId:ncrId,outboxEvent:'QUALITY.NCR_CHANGED'});
      return{replayed:false};
    });return{id:ncrId,status:'CLOSED',...result};
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
    const aggregateType=i.aggregateType??'QUALITY_INSPECTION',aggregateId=i.aggregateId??i.inspectionId;
    if(!aggregateId)throw new Error('QUALITY_OUTBOX_AGGREGATE_REQUIRED');
    await client.query("INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [c.tenantId,c.factoryId,aggregateType,aggregateId,i.outboxEvent??'QUALITY.INSPECTION_CHANGED',JSON.stringify({...i.payload,action:i.action,correlation_id:i.correlation})]);
  }

  private async lockKey(client:PoolClient,c:QualityContext,namespace:string,key:string){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['quality:'+c.tenantId+':'+c.factoryId+':'+namespace+':'+key]);
  }
  private key(raw:string|null){const k=raw?.trim()??'';if(!k||k.length>200)throw new BadRequestException('Idempotency-Key is required and must be at most 200 characters');return k;}
  private text(value:string|undefined,field:string,max:number){const v=value?.trim()??'';if(!v||v.length>max)throw new BadRequestException(field+' is required and must contain at most '+max+' characters');return v;}
  private quantity(value:number,field:string){if(!Number.isFinite(value)||value<=0||Math.abs(value*10000-Math.round(value*10000))>0.000001)throw new BadRequestException(field+' must be positive with at most four decimal places');return value.toFixed(4);}
  private units(value:string|number){const n=Number(value);if(!Number.isFinite(n)||n<0)throw new BadRequestException('Inventory quantity is invalid');return BigInt(Math.round(n*10000));}
  private jsonObject(value?:Record<string,unknown>){if(value==null)return{};if(typeof value!=='object'||Array.isArray(value))throw new BadRequestException('evidence must be a JSON object');return value;}
  private uuid(value:string,field:string){if(!isUUID(value))throw new BadRequestException(field+' must be a UUID');}
  private uuidValue(value:string,field:string){this.uuid(value,field);return value.toLowerCase();}
  private validateScope(c:QualityContext){this.uuid(c.userId,'userId');this.uuid(c.tenantId,'tenantId');this.uuid(c.factoryId,'factoryId');}
  private hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
  private correlation(c:QualityContext){if(c.traceId&&isUUID(c.traceId))return c.traceId;if(c.requestId&&isUUID(c.requestId))return c.requestId;return randomUUID();}
}
