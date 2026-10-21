import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateEngineeringChangeDto } from './dto/create-engineering-change.dto';
import { EngineeringChangeReviewDto } from './dto/engineering-change-review.dto';
import { compareEngineeringSnapshots, type EngineeringSnapshot } from './engineering-change-policy';

interface EcoRow extends QueryResultRow {
  id:string; tenant_id:string; factory_id:string; product_id:string; eco_number:string; title:string; rationale:string;
  source_version_id:string; target_version_id:string; effective_on:string; status:'DRAFT'|'SUBMITTED'|'APPROVED'|'REJECTED';
  row_version:string; source_snapshot:EngineeringSnapshot; target_snapshot:EngineeringSnapshot; revision_diff:Record<string,unknown>;
  affected_order_count:number; request_hash:string; created_by_user_id:string; decision_note:string|null;
  submit_idempotency_key:string|null; submit_request_hash:string|null; decision_idempotency_key:string|null; decision_request_hash:string|null;
}
const ECO_COLUMNS = 'id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,product_id::text AS product_id,'+
 'eco_number,title,rationale,source_version_id::text AS source_version_id,target_version_id::text AS target_version_id,'+
 'effective_on::text AS effective_on,status,row_version::text AS row_version,source_snapshot,target_snapshot,revision_diff,'+
 'affected_order_count,request_hash,created_by_user_id::text AS created_by_user_id,decision_note,'+
 'submit_idempotency_key,submit_request_hash,decision_idempotency_key,decision_request_hash';

@Injectable()
export class EngineeringChangeService {
  constructor(private readonly database:DatabaseService, private readonly audit:AuditService) {}

  async create(userId:string,tenantId:string,factoryId:string,productId:string,dto:CreateEngineeringChangeDto,
    rawKey:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId');
    const key=this.key(rawKey), effectiveOn=this.date(dto.effective_on);
    const sourceId=this.uuid(dto.source_version_id,'source_version_id');
    const targetId=this.uuid(dto.target_version_id,'target_version_id');
    if(sourceId===targetId) throw new BadRequestException('source_version_id and target_version_id must be different');
    const ecoNumber=this.text(dto.eco_number,'eco_number',100), title=this.text(dto.title,'title',255);
    const rationale=this.text(dto.rationale,'rationale',4000);
    const requestHash=this.hash({product_id:productId.toLowerCase(),eco_number:ecoNumber,title,rationale,
      source_version_id:sourceId,target_version_id:targetId,effective_on:effectiveOn});
    const correlation=this.correlation(requestId,traceId);
    const created=await this.database.transaction({tenantId,userId,requestId,traceId,isolationLevel:'SERIALIZABLE',
      advisoryLockKey:'product-eco:'+tenantId+':'+factoryId+':'+key},async client=>{
      const seen=await client.query<EcoRow>('SELECT '+ECO_COLUMNS+' FROM product_engineering_changes WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [tenantId,factoryId,key]);
      if(seen.rows[0]) {
        if(seen.rows[0].request_hash!==requestHash) throw new ConflictException('Idempotency-Key was already used for another ECO request');
        return {id:seen.rows[0].id,replayed:true};
      }
      const versions=await client.query<{id:string;state:string;version_number:number;effective_from:string;effective_to:string|null;
        effective_to_override:string|null;expected_yield_percent:string;change_summary:string;created_by_user_id:string}>(`SELECT id::text AS id,state,version_number,effective_from::text AS effective_from,
        effective_to::text AS effective_to,effective_to_override::text AS effective_to_override,
        expected_yield_percent::text AS expected_yield_percent,change_summary,created_by_user_id::text AS created_by_user_id
        FROM product_versions WHERE product_id=$1 AND tenant_id=$2 AND factory_id=$3 AND id IN($4::uuid,$5::uuid)
        ORDER BY id FOR UPDATE`,[productId,tenantId,factoryId,sourceId,targetId]);
      if(versions.rows.length!==2) throw new NotFoundException('Both revisions must belong to this product and factory');
      const source=versions.rows.find(v=>v.id===sourceId)!;
      const target=versions.rows.find(v=>v.id===targetId)!;
      if(source.state!=='APPROVED') throw new ConflictException('ECO source revision must be approved');
      if(target.state!=='DRAFT') throw new ConflictException('ECO target revision must be a draft until ECO approval');
      if(target.effective_from!==effectiveOn) throw new ConflictException('effective_on must exactly match target revision effective_from');
      const sourceEnd=source.effective_to_override??source.effective_to;
      const priorDay=this.previousDay(effectiveOn);
      if(source.effective_from>=effectiveOn || (sourceEnd!==null && sourceEnd<priorDay))
        throw new ConflictException('Source revision does not cover the day before this effective-date transition');
      const sourceSnapshot=await this.snapshot(client,sourceId,productId,tenantId,factoryId);
      const targetSnapshot=await this.snapshot(client,targetId,productId,tenantId,factoryId);
      const diff=compareEngineeringSnapshots(sourceSnapshot,targetSnapshot);
      if(!diff.any_change) throw new BadRequestException('ECO must capture a BOM, alternate, routing or specification change');
      const affectedCount=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM work_orders w
        WHERE w.tenant_id=$1 AND w.factory_id=$2 AND w.product_id=$3 AND w.product_version_id=$4
          AND w.status IN('DRAFT','RELEASED','IN_PROGRESS','ON_HOLD')
          AND (w.due_date >= $5::date OR w.planned_start_date >= $5::date)`,
        [tenantId,factoryId,productId,sourceId,effectiveOn]);
      const affectedOrderCount=Number(affectedCount.rows[0]?.count??0);
      const row=await client.query<{id:string}>(`INSERT INTO product_engineering_changes(
        tenant_id,factory_id,product_id,eco_number,title,rationale,source_version_id,target_version_id,effective_on,status,
        source_snapshot,target_snapshot,revision_diff,affected_order_count,idempotency_key,request_hash,created_by_user_id,
        updated_by_user_id,correlation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,'DRAFT',$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$16,$17::uuid)
        RETURNING id::text AS id`,[tenantId,factoryId,productId,ecoNumber,title,rationale,sourceId,targetId,effectiveOn,
          JSON.stringify(sourceSnapshot),JSON.stringify(targetSnapshot),JSON.stringify(diff),affectedOrderCount,key,requestHash,userId,correlation]);
      const ecoId=row.rows[0]?.id; if(!ecoId) throw new Error('PRODUCT_ECO_INSERT_FAILED');
      const impacts=await client.query(`INSERT INTO product_eco_order_impacts(
        tenant_id,factory_id,product_id,eco_id,work_order_id,order_line_id,work_order_number,status_at_assessment,
        work_order_row_version,pinned_product_version_id,planned_start_date,due_date,target_quantity,impact_type,order_snapshot)
        SELECT w.tenant_id,w.factory_id,w.product_id,$1::uuid,w.id,w.source_order_line_id,w.work_order_number,w.status,
          w.row_version,w.product_version_id,w.planned_start_date,w.due_date,w.target_quantity,
          CASE WHEN w.status='DRAFT' THEN 'REPLAN_BEFORE_RELEASE' ELSE 'PRESERVE_RELEASED_SNAPSHOT_REVIEW' END,
          jsonb_build_object('work_order_id',w.id,'work_order_number',w.work_order_number,'status',w.status,
            'row_version',w.row_version,'product_version_id',w.product_version_id,'target_quantity',w.target_quantity,
            'planned_start_date',w.planned_start_date,'due_date',w.due_date,'operation_snapshot_digest',COALESCE(ops.digest,''))
        FROM work_orders w
        LEFT JOIN LATERAL (SELECT md5(COALESCE(string_agg(concat_ws('|',op.step_number,op.operation_code,op.work_centre_id,
          op.setup_minutes,op.run_minutes_per_unit,op.queue_minutes,op.transfer_minutes),';' ORDER BY op.step_number),'')) AS digest
          FROM work_order_operations op WHERE op.work_order_id=w.id AND op.tenant_id=w.tenant_id AND op.factory_id=w.factory_id) ops ON TRUE
        WHERE w.tenant_id=$2 AND w.factory_id=$3 AND w.product_id=$4 AND w.product_version_id=$5
          AND w.status IN('DRAFT','RELEASED','IN_PROGRESS','ON_HOLD') AND (w.due_date >= $6::date OR w.planned_start_date >= $6::date)
        RETURNING id`,[ecoId,tenantId,factoryId,productId,sourceId,effectiveOn]);
      if((impacts.rowCount??0)!==affectedOrderCount) throw new ConflictException('Affected order set changed during ECO assessment; retry the ECO creation');
      await this.event(client,{tenantId,factoryId,productId,ecoId,event:'CREATED',actor:userId,key:key+':created',correlation,
        payload:{effective_on:effectiveOn,source_version_id:sourceId,target_version_id:targetId,
          affected_order_count:affectedOrderCount,revision_diff:diff}});
      await this.outbox(client,{tenantId,factoryId,id:ecoId,event:'PRODUCT.ECO_CREATED',correlation,requestId,userId,
        payload:{product_id:productId,source_version_id:sourceId,target_version_id:targetId,effective_on:effectiveOn,affected_order_count:affectedOrderCount}});
      return {id:ecoId,replayed:false};
    });
    if(!created.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_ECO_CREATED',id:created.id,requestId,traceId,
      payload:{productId,sourceVersionId:sourceId,targetVersionId:targetId,effectiveOn}});
    return this.detail(userId,tenantId,factoryId,productId,created.id);
  }

  async list(userId:string,tenantId:string,factoryId:string,productId:string,limit=50) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId');
    if(!Number.isInteger(limit)||limit<1||limit>100) throw new BadRequestException('limit must be between 1 and 100');
    const q=await this.database.query<EcoRow>('SELECT '+ECO_COLUMNS+' FROM product_engineering_changes WHERE tenant_id=$1 AND factory_id=$2 AND product_id=$3 ORDER BY created_at DESC,id DESC LIMIT $4',
      [tenantId,factoryId,productId,limit],{tenantId,userId});
    return q.rows;
  }

  async detail(userId:string,tenantId:string,factoryId:string,productId:string,ecoId:string) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(ecoId,'ecoId');
    const q=await this.database.query<EcoRow>('SELECT '+ECO_COLUMNS+' FROM product_engineering_changes WHERE id=$1 AND product_id=$2 AND tenant_id=$3 AND factory_id=$4',
      [ecoId,productId,tenantId,factoryId],{tenantId,userId});
    if(!q.rows[0]) throw new NotFoundException('Engineering change order was not found in this factory');
    const events=await this.database.query(`SELECT id::text AS id,event_type,actor_user_id::text AS actor_user_id,idempotency_key,
      correlation_id::text AS correlation_id,payload,created_at::text AS created_at
      FROM product_eco_events WHERE eco_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id`,[ecoId,tenantId,factoryId],{tenantId,userId});
    return {...q.rows[0],events:events.rows};
  }

  async affectedOrders(userId:string,tenantId:string,factoryId:string,productId:string,ecoId:string) {
    await this.detail(userId,tenantId,factoryId,productId,ecoId);
    const q=await this.database.query(`SELECT id::text AS id,work_order_id::text AS work_order_id,order_line_id::text AS order_line_id,
      work_order_number,status_at_assessment,work_order_row_version::text AS work_order_row_version,
      pinned_product_version_id::text AS pinned_product_version_id,planned_start_date::text AS planned_start_date,
      due_date::text AS due_date,target_quantity::text AS target_quantity,impact_type,order_snapshot,created_at::text AS created_at
      FROM product_eco_order_impacts WHERE eco_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY due_date,work_order_number,id`,[ecoId,tenantId,factoryId],{tenantId,userId});
    return q.rows;
  }

  async submit(userId:string,tenantId:string,factoryId:string,productId:string,ecoId:string,dto:EngineeringChangeReviewDto,
    rawKey:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); const key=this.key(rawKey);
    const hash=this.hash({eco_id:ecoId,expected_version:dto.expected_version,transition:'SUBMITTED'}), correlation=this.correlation(requestId,traceId);
    const result=await this.database.transaction({tenantId,userId,requestId,traceId},async client=>{
      const row=await this.lockEco(client,tenantId,factoryId,productId,ecoId);
      if(row.status==='SUBMITTED'&&row.submit_idempotency_key===key&&row.submit_request_hash===hash) return {replayed:true};
      if(row.status!=='DRAFT') throw new ConflictException('Only a DRAFT ECO may be submitted');
      this.expected(row.row_version,dto.expected_version);
      const u=await client.query('UPDATE product_engineering_changes SET status=\\'SUBMITTED\\',row_version=row_version+1,updated_by_user_id=$1,updated_at=clock_timestamp(),submitted_by_user_id=$1,submitted_at=clock_timestamp(),submit_idempotency_key=$2,submit_request_hash=$3 WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND status=\\'DRAFT\\' AND row_version=$7',
        [userId,key,hash,ecoId,tenantId,factoryId,dto.expected_version]);
      if(u.rowCount!==1) throw new ConflictException('ECO changed concurrently; reload before submitting');
      await this.event(client,{tenantId,factoryId,productId,ecoId,event:'SUBMITTED',actor:userId,key:key+':submitted',correlation,payload:{expected_version:dto.expected_version}});
      await this.outbox(client,{tenantId,factoryId,id:ecoId,event:'PRODUCT.ECO_SUBMITTED',correlation,requestId,userId,
        payload:{product_id:productId,effective_on:row.effective_on,source_version_id:row.source_version_id,target_version_id:row.target_version_id}});
      return {replayed:false};
    });
    if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_ECO_SUBMITTED',id:ecoId,requestId,traceId,payload:{productId}});
    return this.detail(userId,tenantId,factoryId,productId,ecoId);
  }

  async decide(userId:string,tenantId:string,factoryId:string,productId:string,ecoId:string,decision:'APPROVED'|'REJECTED',
    dto:EngineeringChangeReviewDto,rawKey:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); const key=this.key(rawKey);
    const note=decision==='REJECTED'?this.text(dto.decision_note??'','decision_note',2000):null;
    const hash=this.hash({eco_id:ecoId,expected_version:dto.expected_version,decision,decision_note:note});
    const correlation=this.correlation(requestId,traceId);
    const result=await this.database.transaction({tenantId,userId,requestId,traceId,isolationLevel:'SERIALIZABLE'},async client=>{
      const row=await this.lockEco(client,tenantId,factoryId,productId,ecoId);
      if(row.status===decision&&row.decision_idempotency_key===key&&row.decision_request_hash===hash) return {replayed:true};
      if(row.status!=='SUBMITTED') throw new ConflictException('Only a SUBMITTED ECO may be approved or rejected');
      this.expected(row.row_version,dto.expected_version);
      if(row.created_by_user_id===userId) throw new ConflictException('ECO decision requires a different user than its creator');
      if(decision==='APPROVED') {
        const versions=await client.query<{id:string;state:string;row_version:string;effective_from:string;effective_to:string|null;
          effective_to_override:string|null;created_by_user_id:string}>(`SELECT id::text AS id,state,row_version::text AS row_version,
          effective_from::text AS effective_from,effective_to::text AS effective_to,effective_to_override::text AS effective_to_override,
          created_by_user_id::text AS created_by_user_id FROM product_versions
          WHERE id IN($1::uuid,$2::uuid) AND product_id=$3 AND tenant_id=$4 AND factory_id=$5 ORDER BY id FOR UPDATE`,
          [row.source_version_id,row.target_version_id,productId,tenantId,factoryId]);
        if(versions.rows.length!==2) throw new NotFoundException('ECO revision pair is no longer available');
        const source=versions.rows.find(v=>v.id===row.source_version_id)!;
        const target=versions.rows.find(v=>v.id===row.target_version_id)!;
        if(source.state!=='APPROVED'||target.state!=='DRAFT') throw new ConflictException('ECO requires approved source and draft target revisions');
        if(target.created_by_user_id===userId) throw new ConflictException('Product revision approval requires a different user than its creator');
        if(target.effective_from!==row.effective_on) throw new ConflictException('Target revision effective date no longer matches ECO');
        const sourceEnd=source.effective_to_override??source.effective_to;
        if(source.effective_from>=row.effective_on || (sourceEnd!==null && sourceEnd<this.previousDay(row.effective_on)))
          throw new ConflictException('Source revision no longer covers the day before the transition');
        const overlap=await client.query<{id:string}>(`SELECT id::text AS id FROM product_versions
          WHERE product_id=$1 AND tenant_id=$2 AND factory_id=$3 AND state='APPROVED'
            AND id NOT IN($4::uuid,$5::uuid)
            AND effective_from<=COALESCE($6::date,'infinity'::date)
            AND COALESCE(effective_to_override,effective_to,'infinity'::date)>=$7::date
          ORDER BY effective_from LIMIT 1 FOR UPDATE`,[productId,tenantId,factoryId,row.source_version_id,row.target_version_id,target.effective_to,row.effective_on]);
        if(overlap.rows.length) throw new ConflictException('Another approved revision overlaps the ECO effective window');
        const pending=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM product_bom_alternates WHERE product_version_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='DRAFT'`,
          [row.target_version_id,tenantId,factoryId]);
        if(Number(pending.rows[0]?.count??0)>0) throw new ConflictException('Target revision has unresolved alternate-material authorization');
        const retired=await client.query(`UPDATE product_versions SET state='RETIRED',row_version=row_version+1,updated_by_user_id=$1,updated_at=clock_timestamp(),
          retirement_idempotency_key=$2,retirement_request_hash=$3,effective_to_override=($4::date-1),superseded_by_version_id=$5
          WHERE id=$6 AND product_id=$7 AND tenant_id=$8 AND factory_id=$9 AND state='APPROVED' AND row_version=$10`,
          [userId,'system:superseded:'+row.target_version_id,this.hash({eco_id:ecoId,source_version_id:row.source_version_id,target_version_id:row.target_version_id,effective_to_override:this.previousDay(row.effective_on)}),
            row.effective_on,row.target_version_id,row.source_version_id,productId,tenantId,factoryId,source.row_version]);
        if(retired.rowCount!==1) throw new ConflictException('Source revision changed concurrently');
        const approved=await client.query(`UPDATE product_versions SET state='APPROVED',row_version=row_version+1,updated_by_user_id=$1,updated_at=clock_timestamp(),
          approved_by_user_id=$1,approved_at=clock_timestamp(),approval_idempotency_key=$2,approval_request_hash=$3
          WHERE id=$4 AND product_id=$5 AND tenant_id=$6 AND factory_id=$7 AND state='DRAFT' AND row_version=$8`,
          [userId,('eco:'+ecoId+':'+key).slice(0,255),this.hash({eco_id:ecoId,target_version_id:row.target_version_id,effective_on:row.effective_on}),
            row.target_version_id,productId,tenantId,factoryId,target.row_version]);
        if(approved.rowCount!==1) throw new ConflictException('Target revision changed concurrently');
        await this.outbox(client,{tenantId,factoryId,id:row.source_version_id,event:'PRODUCT.VERSION_SUPERSEDED',aggregateType:'PRODUCT_VERSION',correlation,requestId,userId,
          payload:{product_id:productId,product_version_id:row.source_version_id,superseded_by_version_id:row.target_version_id,effective_to_override:this.previousDay(row.effective_on)}});
        await this.outbox(client,{tenantId,factoryId,id:row.target_version_id,event:'PRODUCT.VERSION_APPROVED',aggregateType:'PRODUCT_VERSION',correlation,requestId,userId,
          payload:{product_id:productId,product_version_id:row.target_version_id,effective_from:row.effective_on,superseded_version_ids:[row.source_version_id],eco_id:ecoId}});
      }
      const update=await client.query(`UPDATE product_engineering_changes SET status=$1,row_version=row_version+1,updated_by_user_id=$2,updated_at=clock_timestamp(),
        decision_by_user_id=$2,decision_at=clock_timestamp(),decision_idempotency_key=$3,decision_request_hash=$4,decision_note=$5,
        approved_by_user_id=CASE WHEN $1='APPROVED' THEN $2 ELSE NULL END,approved_at=CASE WHEN $1='APPROVED' THEN clock_timestamp() ELSE NULL END
        WHERE id=$6 AND tenant_id=$7 AND factory_id=$8 AND status='SUBMITTED' AND row_version=$9`,
        [decision,userId,key,hash,note,ecoId,tenantId,factoryId,dto.expected_version]);
      if(update.rowCount!==1) throw new ConflictException('ECO changed concurrently while deciding');
      await this.event(client,{tenantId,factoryId,productId,ecoId,event:decision,actor:userId,key:key+':'+decision.toLowerCase(),correlation,
        payload:{effective_on:row.effective_on,source_version_id:row.source_version_id,target_version_id:row.target_version_id,revision_diff:row.revision_diff}});
      await this.outbox(client,{tenantId,factoryId,id:ecoId,event:'PRODUCT.ECO_'+decision,correlation,requestId,userId,
        payload:{product_id:productId,effective_on:row.effective_on,source_version_id:row.source_version_id,target_version_id:row.target_version_id,affected_order_count:row.affected_order_count}});
      return {replayed:false};
    });
    if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_ECO_'+decision,id:ecoId,requestId,traceId,payload:{productId}});
    return this.detail(userId,tenantId,factoryId,productId,ecoId);
  }

  private async snapshot(client:PoolClient,versionId:string,productId:string,tenantId:string,factoryId:string):Promise<EngineeringSnapshot> {
    const version=await client.query<{id:string;number:number;expected_yield_percent:string;change_summary:string}>(`SELECT id::text AS id,version_number AS number,
      expected_yield_percent::text AS expected_yield_percent,change_summary FROM product_versions
      WHERE id=$1 AND product_id=$2 AND tenant_id=$3 AND factory_id=$4`,[versionId,productId,tenantId,factoryId]);
    if(!version.rows[0]) throw new NotFoundException('Product version was not found');
    const bom=await client.query(`SELECT b.line_number,b.component_item_id::text AS component_item_id,i.sku AS component_sku,i.name AS component_name,
      b.quantity_per::text AS quantity_per,b.base_quantity_per::text AS base_quantity_per,b.unit,b.wastage_percent::text AS wastage_percent,
      b.alternate_group_code,b.notes FROM product_bom_lines b JOIN inventory_items i
      ON i.id=b.component_item_id AND i.tenant_id=b.tenant_id AND i.factory_id=b.factory_id
      WHERE b.product_version_id=$1 AND b.tenant_id=$2 AND b.factory_id=$3 ORDER BY b.line_number`,[versionId,tenantId,factoryId]);
    const alternates=await client.query(`SELECT a.bom_line_id::text AS bom_line_id,a.alternate_item_id::text AS alternate_item_id,i.sku AS alternate_sku,
      a.conversion_factor::text AS conversion_factor,a.unit,a.rationale,a.status,a.inventory_quantity_per_component::text AS inventory_quantity_per_component
      FROM product_bom_alternates a JOIN inventory_items i ON i.id=a.alternate_item_id AND i.tenant_id=a.tenant_id AND i.factory_id=a.factory_id
      WHERE a.product_version_id=$1 AND a.tenant_id=$2 AND a.factory_id=$3 ORDER BY a.bom_line_id,a.alternate_item_id`,[versionId,tenantId,factoryId]);
    const routing=await client.query(`SELECT r.step_number,r.operation_code,r.operation_name,r.work_centre_id::text AS work_centre_id,w.code AS work_centre_code,
      r.setup_minutes::text AS setup_minutes,r.run_minutes_per_unit::text AS run_minutes_per_unit,r.queue_minutes::text AS queue_minutes,
      r.transfer_minutes::text AS transfer_minutes,r.required_skill,r.instructions,r.is_quality_gate FROM product_routing_steps r
      JOIN manufacturing_work_centres w ON w.id=r.work_centre_id AND w.tenant_id=r.tenant_id AND w.factory_id=r.factory_id
      WHERE r.product_version_id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 ORDER BY r.step_number`,[versionId,tenantId,factoryId]);
    return {version:version.rows[0],bom:bom.rows,alternates:alternates.rows,routing:routing.rows};
  }

  private async lockEco(client:PoolClient,tenantId:string,factoryId:string,productId:string,ecoId:string) {
    const q=await client.query<EcoRow>('SELECT '+ECO_COLUMNS+' FROM product_engineering_changes WHERE id=$1 AND product_id=$2 AND tenant_id=$3 AND factory_id=$4 FOR UPDATE',
      [ecoId,productId,tenantId,factoryId]);
    if(!q.rows[0]) throw new NotFoundException('Engineering change order was not found in this factory');
    return q.rows[0];
  }
  private async event(client:PoolClient,i:{tenantId:string;factoryId:string;productId:string;ecoId:string;event:string;actor:string;key:string;correlation:string;payload:Record<string,unknown>}) {
    await client.query('INSERT INTO product_eco_events(tenant_id,factory_id,product_id,eco_id,event_type,actor_user_id,idempotency_key,correlation_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid,$9::jsonb) ON CONFLICT(tenant_id,factory_id,eco_id,idempotency_key) DO NOTHING',
      [i.tenantId,i.factoryId,i.productId,i.ecoId,i.event,i.actor,i.key,i.correlation,JSON.stringify(i.payload)]);
  }
  private async outbox(client:PoolClient,i:{tenantId:string;factoryId:string;id:string;event:string;correlation:string;requestId:string|null;userId:string;aggregateType?:string;payload:Record<string,unknown>}) {
    await client.query('INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,correlation_id,causation_id,actor,source,payload) VALUES($1,$2,$3,$4,$5,1,clock_timestamp(),$6::uuid,$7::uuid,$8::jsonb,$9::jsonb,$10::jsonb)',
      [i.tenantId,i.factoryId,i.aggregateType??'PRODUCT_ECO',i.id,i.event,i.correlation,i.requestId&&isUUID(i.requestId)?i.requestId:null,
       JSON.stringify({type:'user',id:i.userId}),JSON.stringify({system:'FactoryOS',connector:'engineering-change-service',version:process.env.APP_VERSION??'0.1.0'}),JSON.stringify(i.payload)]);
  }
  private async auditSafe(i:{tenantId:string;factoryId:string;userId:string;action:string;id:string;requestId:string|null;traceId:string|null;payload:Record<string,unknown>}) {
    try { await this.audit.record({tenantId:i.tenantId,factoryId:i.factoryId,actorUserId:i.userId,eventType:'PRODUCT_ECO',action:i.action,resourceType:'PRODUCT_ENGINEERING_CHANGE',resourceId:i.id,
      requestId:i.requestId&&isUUID(i.requestId)?i.requestId:null,correlationId:i.traceId&&isUUID(i.traceId)?i.traceId:null,dataClass:'INTERNAL',payload:i.payload}); } catch { /* outbox retains durable evidence */ }
  }
  private key(value:string|null) { const key=value?.trim()??''; if(!key) throw new BadRequestException('Idempotency-Key header is required'); if(key.length>190) throw new BadRequestException('Idempotency-Key must not exceed 190 characters'); return key; }
  private uuid(value:string,field:string) { if(!isUUID(value)) throw new BadRequestException(field+' must be a UUID'); return value.toLowerCase(); }
  private scope(user:string,tenant:string,factory:string) { this.uuid(user,'userId'); this.uuid(tenant,'tenantId'); this.uuid(factory,'factoryId'); }
  private text(value:string,field:string,max:number) { if(typeof value!=='string'||!value.trim()||value.trim().length>max) throw new BadRequestException(field+' must contain 1 to '+max+' characters'); return value.trim(); }
  private date(value:string) { if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('effective_on must use YYYY-MM-DD'); const d=new Date(value+'T00:00:00.000Z'); if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value) throw new BadRequestException('effective_on must be a real calendar date'); return value; }
  private expected(actual:string|number,expected:number) { if(!Number.isInteger(expected)||Number(actual)!==expected) throw new ConflictException('Stale ECO version: expected '+expected+', current '+actual); }
  private previousDay(value:string) { const d=new Date(value+'T00:00:00.000Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); }
  private correlation(requestId:string|null,traceId:string|null) { return traceId&&isUUID(traceId)?traceId:requestId&&isUUID(requestId)?requestId:randomUUID(); }
  private hash(value:Record<string,unknown>) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
