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
  AddMaintenanceSparePartDto,
  CompleteMaintenanceTaskDto,
  CreateMaintenanceAssetDto,
  CreateMaintenanceBreakdownWorkOrderDto,
  CreateMaintenancePmPlanDto,
  GenerateDueMaintenanceWorkOrderDto,
  IssueMaintenanceSparePartDto,
  ListMaintenanceAssetsQueryDto,
  ListMaintenancePmPlansQueryDto,
  ListMaintenanceWorkOrdersQueryDto,
  MaintenanceChecklistEntryDto,
  MaintenancePmPlanTransitionDto,
  MaintenanceWorkOrderTransitionDto,
  UpdateMaintenanceAssetDto,
} from './maintenance.dto';

export interface MaintenanceContext {
  userId: string;
  tenantId: string;
  factoryId: string;
  requestId?: string | null;
  traceId?: string | null;
}
type Row = QueryResultRow;

@Injectable()
export class MaintenanceService {
  constructor(private readonly database: DatabaseService) {}

  async createAsset(c: MaintenanceContext, dto: CreateMaintenanceAssetDto, rawKey: string | null) {
    this.validateContext(c);
    const key = this.idempotencyKey(rawKey);
    const assetCode = this.requiredText(dto.asset_code, 'asset_code', 100).toUpperCase();
    const name = this.requiredText(dto.name, 'name', 255);
    const assetType = this.requiredText(dto.asset_type, 'asset_type', 80).toUpperCase();
    const parentId = this.optionalUuid(dto.parent_asset_id, 'parent_asset_id');
    const criticality = dto.criticality ?? 'MEDIUM';
    const payload = {
      asset_code: assetCode, name, asset_type: assetType, parent_asset_id: parentId,
      manufacturer: this.optionalText(dto.manufacturer, 160),
      model: this.optionalText(dto.model, 160),
      serial_number: this.optionalText(dto.serial_number, 160), criticality,
      location: this.optionalText(dto.location, 255), commissioned_on: dto.commissioned_on ?? null,
      warranty_expires_on: dto.warranty_expires_on ?? null,
      notes: this.optionalText(dto.notes, 4000),
    };
    const hash = this.hash(payload);
    return this.database.transaction({ tenantId: c.tenantId, userId: c.userId }, async (client) => {
      const existing = await this.lockAndFindEvent(client, c, key, hash);
      if (existing) return { ...(await this.assetDetail(client, c, String(existing.entity_id))), replayed: true };
      if (parentId) {
        const parent = await client.query<Row>(
          `SELECT id::text AS id, status FROM maintenance_assets
           WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
          [parentId, c.tenantId, c.factoryId],
        );
        if (!parent.rows[0]) throw new NotFoundException('Parent asset was not found in this factory');
        if (parent.rows[0].status !== 'ACTIVE') {
          throw new ConflictException('A child asset must be assigned under an active parent asset');
        }
      }
      const inserted = await client.query<Row>(
        `INSERT INTO maintenance_assets (
          tenant_id,factory_id,parent_asset_id,asset_code,name,asset_type,manufacturer,model,serial_number,
          criticality,location,commissioned_on,warranty_expires_on,notes,idempotency_key,request_hash,
          created_by_user_id,updated_by_user_id,correlation_id
        ) VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13::date,$14,$15,$16,$17,$17,$18::uuid)
        RETURNING id::text AS id,row_version::int AS row_version,status,asset_code,name`,
        [c.tenantId,c.factoryId,parentId,assetCode,name,assetType,payload.manufacturer,payload.model,payload.serial_number,
          criticality,payload.location,payload.commissioned_on,payload.warranty_expires_on,payload.notes,key,hash,c.userId,this.correlationId(c)),
      );
      const asset = inserted.rows[0];
      if (!asset) throw new Error('MAINTENANCE_ASSET_INSERT_FAILED');
      await this.insertEvent(client,c,{
        entityType:'ASSET',entityId:String(asset.id),version:1,action:'CREATED',toStatus:'ACTIVE',
        reason:'Asset registered',data:payload,key,hash,
      });
      return { ...(await this.assetDetail(client,c,String(asset.id))), replayed:false };
    });
  }

  async listAssets(c: MaintenanceContext, query: ListMaintenanceAssetsQueryDto) {
    this.validateContext(c);
    const limit = this.limit(query.limit);
    const result = await this.database.query<Row>(
      `SELECT a.id::text AS id,a.parent_asset_id::text AS parent_asset_id,a.asset_code,a.name,a.asset_type,
              a.manufacturer,a.model,a.serial_number,a.criticality,a.status,a.location,a.commissioned_on::text,
              a.warranty_expires_on::text,a.row_version::int AS row_version,a.created_at::text,a.updated_at::text
       FROM maintenance_assets a
       WHERE a.tenant_id=$1 AND a.factory_id=$2
         AND ($3::text IS NULL OR a.status=$3)
         AND ($4::uuid IS NULL OR a.parent_asset_id=$4::uuid)
       ORDER BY a.asset_code,a.id LIMIT $5`,
      [c.tenantId,c.factoryId,query.status ?? null,query.parent_asset_id ?? null,limit],
      {tenantId:c.tenantId,userId:c.userId},
    );
    return { assets: result.rows, count: result.rows.length };
  }

  async getAsset(c: MaintenanceContext, assetId: string) {
    this.validateContext(c);
    this.validateUuid(assetId,'assetId');
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},client=>this.assetDetail(client,c,assetId));
  }

  async updateAsset(c: MaintenanceContext, assetId: string, dto: UpdateMaintenanceAssetDto, rawKey: string | null) {
    this.validateContext(c);
    this.validateUuid(assetId,'assetId');
    const key=this.idempotencyKey(rawKey);
    const reason=this.requiredText(dto.reason,'reason',1000);
    const fields: Array<[string, unknown]> = [];
    const add=(column:string,value:unknown,validator?:(v:unknown)=>unknown)=> {
      if (Object.prototype.hasOwnProperty.call(dto,column) && value !== undefined) {
        fields.push([column,validator ? validator(value) : value]);
      }
    };
    add('name',dto.name,v=>this.requiredText(String(v),'name',255));
    add('asset_type',dto.asset_type,v=>this.requiredText(String(v),'asset_type',80).toUpperCase());
    add('parent_asset_id',dto.parent_asset_id,v=>v===null?null:this.uuidValue(v,'parent_asset_id'));
    add('manufacturer',dto.manufacturer,v=>this.optionalText(v as string|null,160));
    add('model',dto.model,v=>this.optionalText(v as string|null,160));
    add('serial_number',dto.serial_number,v=>this.optionalText(v as string|null,160));
    add('criticality',dto.criticality);
    add('status',dto.status);
    add('location',dto.location,v=>this.optionalText(v as string|null,255));
    add('commissioned_on',dto.commissioned_on);
    add('warranty_expires_on',dto.warranty_expires_on);
    add('notes',dto.notes,v=>this.optionalText(v as string|null,4000));
    if (!fields.length) throw new BadRequestException('At least one asset field must be changed');
    const payload={assetId:assetId.toLowerCase(),expected_version:dto.expected_version,reason,changes:fields};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.assetDetail(client,c,String(existing.entity_id))),replayed:true};
      const current=await client.query<Row>(
        'SELECT * FROM maintenance_assets WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [assetId,c.tenantId,c.factoryId],
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException('Asset was not found in this factory');
      if(Number(row.row_version)!==dto.expected_version) throw new ConflictException('Asset changed; reload before updating');
      const changesStatus=fields.find(([column])=>column==='status')?.[1];
      const proposedStatus=changesStatus ?? row.status;
      if(proposedStatus!=='ACTIVE' && row.status==='ACTIVE') {
        const open=await client.query<Row>(
          `SELECT 1 FROM maintenance_work_orders WHERE asset_id=$1 AND tenant_id=$2 AND factory_id=$3
           AND status NOT IN ('COMPLETED','CANCELLED') LIMIT 1`,
          [assetId,c.tenantId,c.factoryId],
        );
        if(open.rows[0]) throw new ConflictException('An asset with open maintenance work orders cannot be inactivated or retired');
      }
      const parent=fields.find(([column])=>column==='parent_asset_id')?.[1];
      if(parent && parent!==null) {
        const parentRow=await client.query<Row>(
          'SELECT status FROM maintenance_assets WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
          [parent,c.tenantId,c.factoryId],
        );
        if(!parentRow.rows[0] || parentRow.rows[0].status!=='ACTIVE') {
          throw new ConflictException('Parent asset must be active and belong to this factory');
        }
      }
      const setFields=fields.map(([column],i)=>`${column}=$${i+1}`);
      const params=fields.map(([,value])=>value);
      params.push(c.userId,assetId,c.tenantId,c.factoryId,dto.expected_version);
      const n=params.length;
      const updated=await client.query<Row>(
        `UPDATE maintenance_assets SET ${setFields.join(',')},updated_by_user_id=$${n-4},
           row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$${n-3} AND tenant_id=$${n-2} AND factory_id=$${n-1} AND row_version=$${n}
         RETURNING id::text AS id,row_version::int AS row_version,status`,
        params,
      );
      const next=updated.rows[0];
      if(!next) throw new ConflictException('Asset changed during update');
      await this.insertEvent(client,c,{
        entityType:'ASSET',entityId:assetId,version:Number(next.row_version),action:'UPDATED',
        fromStatus:String(row.status),toStatus:String(next.status),reason,data:{changes:fields.map(([k,v])=>[k,v])},
        key,hash,
      });
      return {...(await this.assetDetail(client,c,assetId)),replayed:false};
    });
  }

  async createPmPlan(c: MaintenanceContext, dto: CreateMaintenancePmPlanDto, rawKey: string | null) {
    this.validateContext(c);
    const key=this.idempotencyKey(rawKey);
    const assetId=this.uuidValue(dto.asset_id,'asset_id');
    const planCode=this.requiredText(dto.plan_code,'plan_code',100).toUpperCase();
    const name=this.requiredText(dto.name,'name',255);
    const intervalValue=Number(dto.interval_value);
    if(!Number.isInteger(intervalValue)||intervalValue<1||intervalValue>3650) throw new BadRequestException('interval_value must be an integer from 1 through 3650');
    const intervalUnit=dto.interval_unit;
    if(!['DAY','WEEK','MONTH'].includes(intervalUnit)) throw new BadRequestException('Unsupported preventive-maintenance interval unit');
    const dueOn=this.dateOnly(dto.next_due_on,'next_due_on');
    const checklist=this.normalizeChecklist(dto.checklist ?? []);
    const payload={
      asset_id:assetId,plan_code:planCode,name,description:this.optionalText(dto.description,4000),
      interval_value:intervalValue,interval_unit:intervalUnit,next_due_on:dueOn,
      estimated_duration_minutes:dto.estimated_duration_minutes??60,
      requires_shutdown:dto.requires_shutdown??false,checklist,
    };
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.pmPlanDetail(client,c,String(existing.entity_id))),replayed:true};
      const asset=await client.query<Row>(
        'SELECT status FROM maintenance_assets WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [assetId,c.tenantId,c.factoryId],
      );
      if(!asset.rows[0]) throw new NotFoundException('Asset was not found in this factory');
      if(asset.rows[0].status!=='ACTIVE') throw new ConflictException('Preventive maintenance can only be planned for an active asset');
      const revision=await client.query<Row>(
        `SELECT COALESCE(MAX(revision),0)+1 AS revision FROM maintenance_pm_plans
         WHERE tenant_id=$1 AND factory_id=$2 AND asset_id=$3 AND lower(plan_code)=lower($4)`,
        [c.tenantId,c.factoryId,assetId,planCode],
      );
      const plan=await client.query<Row>(
        `INSERT INTO maintenance_pm_plans (
          tenant_id,factory_id,asset_id,plan_code,revision,name,description,interval_value,interval_unit,
          next_due_on,estimated_duration_minutes,requires_shutdown,checklist,status,idempotency_key,
          request_hash,created_by_user_id,updated_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13::jsonb,'DRAFT',$14,$15,$16,$16,$17::uuid)
        RETURNING id::text AS id,row_version::int AS row_version,status,revision`,
        [c.tenantId,c.factoryId,assetId,planCode,Number(revision.rows[0]?.revision??1),name,payload.description,
          intervalValue,intervalUnit,dueOn,payload.estimated_duration_minutes,payload.requires_shutdown,
          JSON.stringify(checklist),key,hash,c.userId,this.correlationId(c)),
      );
      const inserted=plan.rows[0];
      if(!inserted) throw new Error('MAINTENANCE_PM_PLAN_INSERT_FAILED');
      await this.insertEvent(client,c,{entityType:'PM_PLAN',entityId:String(inserted.id),version:1,action:'CREATED',
        toStatus:'DRAFT',reason:'Preventive-maintenance plan drafted',data:payload,key,hash});
      return {...(await this.pmPlanDetail(client,c,String(inserted.id))),replayed:false};
    });
  }

  async listPmPlans(c: MaintenanceContext, query: ListMaintenancePmPlansQueryDto) {
    this.validateContext(c);
    const result=await this.database.query<Row>(
      `SELECT p.id::text AS id,p.asset_id::text AS asset_id,a.asset_code,a.name AS asset_name,
        p.plan_code,p.revision,p.name,p.interval_value,p.interval_unit,p.next_due_on::text AS next_due_on,
        p.estimated_duration_minutes,p.requires_shutdown,p.status,p.row_version::int AS row_version,
        p.approved_by_user_id::text AS approved_by_user_id,p.created_at::text AS created_at
       FROM maintenance_pm_plans p
       JOIN maintenance_assets a ON a.id=p.asset_id AND a.tenant_id=p.tenant_id AND a.factory_id=p.factory_id
       WHERE p.tenant_id=$1 AND p.factory_id=$2
         AND ($3::text IS NULL OR p.status=$3) AND ($4::uuid IS NULL OR p.asset_id=$4::uuid)
       ORDER BY p.next_due_on,p.plan_code,p.revision DESC LIMIT $5`,
      [c.tenantId,c.factoryId,query.status??null,query.asset_id??null,this.limit(query.limit)],
      {tenantId:c.tenantId,userId:c.userId},
    );
    return {plans:result.rows,count:result.rows.length};
  }

  async getPmPlan(c: MaintenanceContext, planId: string) {
    this.validateContext(c);
    this.validateUuid(planId, 'planId');
    return this.database.transaction({ tenantId: c.tenantId, userId: c.userId }, client => this.pmPlanDetail(client, c, planId));
  }

  async transitionPmPlan(c: MaintenanceContext, planId: string, dto: MaintenancePmPlanTransitionDto, rawKey: string | null) {
    this.validateContext(c);this.validateUuid(planId,'planId');
    const key=this.idempotencyKey(rawKey);
    const reason=this.requiredText(dto.reason,'reason',2000);
    const hash=this.hash({planId:planId.toLowerCase(),expected_version:dto.expected_version,action:dto.action,reason});
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.pmPlanDetail(client,c,String(existing.entity_id))),replayed:true};
      const found=await client.query<Row>(
        'SELECT * FROM maintenance_pm_plans WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [planId,c.tenantId,c.factoryId],
      );
      const p=found.rows[0];if(!p) throw new NotFoundException('Preventive-maintenance plan not found');
      if(Number(p.row_version)!==dto.expected_version) throw new ConflictException('PM plan changed; reload before transitioning');
      const from=String(p.status);
      const map:Record<string,string>={ACTIVATE:'ACTIVE',PAUSE:'PAUSED',RESUME:'ACTIVE',RETIRE:'RETIRED'};
      const to=map[dto.action];
      const allowed=(dto.action==='ACTIVATE'&&from==='DRAFT')||
        (dto.action==='PAUSE'&&from==='ACTIVE')||
        (dto.action==='RESUME'&&from==='PAUSED')||
        (dto.action==='RETIRE'&&(from==='ACTIVE'||from==='PAUSED'||from==='DRAFT'));
      if(!allowed) throw new ConflictException(`PM plan cannot transition from ${from} using ${dto.action}`);
      let approvedBy: string|null = p.approved_by_user_id===null?null:String(p.approved_by_user_id);
      if(to==='ACTIVE') {
        if(String(p.created_by_user_id).toLowerCase()===c.userId.toLowerCase()) {
          throw new ConflictException('PM plan activation requires an approver different from the plan creator');
        }
        approvedBy=c.userId;
        const asset=await client.query<Row>(
          'SELECT status FROM maintenance_assets WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
          [p.asset_id,c.tenantId,c.factoryId],
        );
        if(!asset.rows[0]||asset.rows[0].status!=='ACTIVE') throw new ConflictException('PM plan asset must remain active');
      }
      const updated=await client.query<Row>(
        `UPDATE maintenance_pm_plans SET status=$1,approved_by_user_id=$2,
         approved_at=CASE WHEN $1='ACTIVE' THEN clock_timestamp() ELSE approved_at END,
         updated_by_user_id=$3,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND row_version=$7
         RETURNING row_version::int AS row_version,status`,
        [to,approvedBy,c.userId,planId,c.tenantId,c.factoryId,dto.expected_version],
      );
      const next=updated.rows[0];if(!next) throw new ConflictException('PM plan changed during transition');
      await this.insertEvent(client,c,{entityType:'PM_PLAN',entityId:planId,version:Number(next.row_version),action:dto.action,
        fromStatus:from,toStatus:String(next.status),reason,data:{approved_by_user_id:approvedBy},key,hash});
      return {...(await this.pmPlanDetail(client,c,planId)),replayed:false};
    });
  }

  async generateDueWorkOrder(c: MaintenanceContext, planId: string, dto: GenerateDueMaintenanceWorkOrderDto, rawKey: string | null) {
    this.validateContext(c);this.validateUuid(planId,'planId');
    const key=this.idempotencyKey(rawKey);
    const reason=this.optionalText(dto.reason,1000)??'Scheduled preventive maintenance occurrence';
    const hash=this.hash({planId:planId.toLowerCase(),expected_version:dto.expected_version,reason});
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.workOrderDetail(client,c,String(existing.entity_id))),replayed:true};
      const selected=await client.query<Row>(
        `SELECT p.*,a.status AS asset_status,a.asset_code FROM maintenance_pm_plans p
         JOIN maintenance_assets a ON a.id=p.asset_id AND a.tenant_id=p.tenant_id AND a.factory_id=p.factory_id
         WHERE p.id=$1 AND p.tenant_id=$2 AND p.factory_id=$3 FOR UPDATE OF p,a`,
        [planId,c.tenantId,c.factoryId],
      );
      const p=selected.rows[0];if(!p) throw new NotFoundException('Preventive-maintenance plan not found');
      if(Number(p.row_version)!==dto.expected_version) throw new ConflictException('PM plan changed; reload before generating work');
      if(p.status!=='ACTIVE') throw new ConflictException('Only an active PM plan can generate work orders');
      if(p.asset_status!=='ACTIVE') throw new ConflictException('PM plan asset is inactive');
      const due=await client.query<Row>('SELECT ($1::date <= CURRENT_DATE) AS is_due',[p.next_due_on]);
      if(!due.rows[0]?.is_due) throw new ConflictException('Preventive-maintenance plan is not due yet');
      const workOrderId=randomUUID();
      const woNumber=`MWO-${randomUUID().slice(0,8).toUpperCase()}`;
      const wo=await client.query<Row>(
        `INSERT INTO maintenance_work_orders (
          id,tenant_id,factory_id,work_order_number,work_order_type,asset_id,pm_plan_id,plan_due_on,
          priority,status,title,description,scheduled_start_at,idempotency_key,request_hash,
          created_by_user_id,updated_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,$4,'PM',$5,$6,$7::date,'MEDIUM','PLANNED',$8,$9,$7::date::timestamptz,
          $10,$11,$12,$12,$13::uuid)
        RETURNING id::text AS id,row_version::int AS row_version,status`,
        [workOrderId,c.tenantId,c.factoryId,woNumber,p.asset_id,p.id,p.next_due_on,
          `PM: ${p.name}`,reason,key,hash,c.userId,this.correlationId(c)),
      );
      const inserted=wo.rows[0];if(!inserted) throw new Error('MAINTENANCE_PM_WORK_ORDER_INSERT_FAILED');
      const checklist=this.normalizeChecklist(Array.isArray(p.checklist)?p.checklist:[]);
      await this.insertTasks(client,c,workOrderId,checklist,`${key}:tasks`,reason);
      await this.insertEvent(client,c,{entityType:'WORK_ORDER',entityId:workOrderId,version:1,action:'GENERATED_FROM_PM',
        toStatus:'PLANNED',reason,data:{pm_plan_id:p.id,plan_due_on:p.next_due_on,asset_id:p.asset_id,requires_shutdown:p.requires_shutdown},
        key,hash});
      const planUpdate=await client.query<Row>(
        `UPDATE maintenance_pm_plans SET
           next_due_on=CASE interval_unit
             WHEN 'DAY' THEN next_due_on + interval_value
             WHEN 'WEEK' THEN next_due_on + (interval_value * 7)
             WHEN 'MONTH' THEN (next_due_on + make_interval(months => interval_value))::date
           END,
           row_version=row_version+1,updated_by_user_id=$1,updated_at=clock_timestamp()
         WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND row_version=$5
         RETURNING row_version::int AS row_version,status,next_due_on::text AS next_due_on`,
        [c.userId,planId,c.tenantId,c.factoryId,dto.expected_version],
      );
      const revised=planUpdate.rows[0];if(!revised) throw new ConflictException('PM plan schedule changed while generating the work order');
      await this.insertEvent(client,c,{entityType:'PM_PLAN',entityId:planId,version:Number(revised.row_version),
        action:'DUE_WORK_ORDER_GENERATED',fromStatus:'ACTIVE',toStatus:'ACTIVE',reason,
        data:{work_order_id:workOrderId,generated_for:p.next_due_on,next_due_on:revised.next_due_on},
        key:`${key}:plan`,hash});
      return {...(await this.workOrderDetail(client,c,workOrderId)),replayed:false};
    });
  }

  async createBreakdownWorkOrder(c: MaintenanceContext, dto: CreateMaintenanceBreakdownWorkOrderDto, rawKey: string | null) {
    this.validateContext(c);
    const key=this.idempotencyKey(rawKey);
    const assetId=this.uuidValue(dto.asset_id,'asset_id');
    const title=this.requiredText(dto.title,'title',255);
    const description=this.requiredText(dto.description,'description',4000);
    const priority=dto.priority;
    const scheduled=dto.scheduled_start_at?new Date(dto.scheduled_start_at).toISOString():null;
    const due=dto.due_at?new Date(dto.due_at).toISOString():null;
    if(scheduled&&due&&new Date(due).getTime()<new Date(scheduled).getTime()) throw new BadRequestException('due_at cannot be before scheduled_start_at');
    const checklist=this.normalizeChecklist(dto.checklist??[]);
    const payload={asset_id:assetId,work_order_type:'BREAKDOWN',priority,title,description,
      failure_code:this.optionalText(dto.failure_code,100),scheduled_start_at:scheduled,due_at:due,
      assigned_to_user_id:dto.assigned_to_user_id??null,checklist};
    const hash=this.hash(payload);
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.workOrderDetail(client,c,String(existing.entity_id))),replayed:true};
      const asset=await client.query<Row>(
        'SELECT status FROM maintenance_assets WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [assetId,c.tenantId,c.factoryId],
      );
      if(!asset.rows[0]) throw new NotFoundException('Asset was not found in this factory');
      if(asset.rows[0].status!=='ACTIVE') throw new ConflictException('Breakdown work orders require an active asset');
      if(dto.assigned_to_user_id) {
        const membership=await client.query<Row>(
          `SELECT 1 FROM tenant_memberships WHERE user_id=$1 AND tenant_id=$2 AND status='ACTIVE' LIMIT 1`,
          [dto.assigned_to_user_id,c.tenantId],
        );
        if(!membership.rows[0]) throw new BadRequestException('assigned_to_user_id must belong to an active membership in this tenant');
      }
      const workOrderId=randomUUID();const woNumber=`MWO-${randomUUID().slice(0,8).toUpperCase()}`;
      const wo=await client.query<Row>(
        `INSERT INTO maintenance_work_orders (
          id,tenant_id,factory_id,work_order_number,work_order_type,asset_id,priority,status,title,description,
          failure_code,scheduled_start_at,due_at,assigned_to_user_id,idempotency_key,request_hash,
          created_by_user_id,updated_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,$4,'BREAKDOWN',$5,$6,'PLANNED',$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::uuid,
          $13,$14,$15,$15,$16::uuid)
        RETURNING id::text AS id,row_version::int AS row_version,status`,
        [workOrderId,c.tenantId,c.factoryId,woNumber,assetId,priority,title,description,payload.failure_code,
          scheduled,due,dto.assigned_to_user_id??null,key,hash,c.userId,this.correlationId(c)),
      );
      if(!wo.rows[0]) throw new Error('MAINTENANCE_BREAKDOWN_WORK_ORDER_INSERT_FAILED');
      await this.insertTasks(client,c,workOrderId,checklist,`${key}:tasks`,'Checklist item');
      await this.insertEvent(client,c,{entityType:'WORK_ORDER',entityId:workOrderId,version:1,action:'BREAKDOWN_REPORTED',
        toStatus:'PLANNED',reason:description,data:payload,key,hash});
      return {...(await this.workOrderDetail(client,c,workOrderId)),replayed:false};
    });
  }

  async listWorkOrders(c: MaintenanceContext, query: ListMaintenanceWorkOrdersQueryDto) {
    this.validateContext(c);
    const result=await this.database.query<Row>(
      `SELECT wo.id::text AS id,wo.work_order_number,wo.work_order_type,wo.asset_id::text AS asset_id,
        a.asset_code,a.name AS asset_name,wo.pm_plan_id::text AS pm_plan_id,wo.plan_due_on::text AS plan_due_on,
        wo.priority,wo.status,wo.title,wo.scheduled_start_at::text AS scheduled_start_at,
        wo.due_at::text AS due_at,wo.assigned_to_user_id::text AS assigned_to_user_id,
        wo.row_version::int AS row_version,wo.created_at::text AS created_at,wo.updated_at::text AS updated_at
       FROM maintenance_work_orders wo
       JOIN maintenance_assets a ON a.id=wo.asset_id AND a.tenant_id=wo.tenant_id AND a.factory_id=wo.factory_id
       WHERE wo.tenant_id=$1 AND wo.factory_id=$2 AND ($3::text IS NULL OR wo.status=$3)
         AND ($4::text IS NULL OR wo.work_order_type=$4) AND ($5::text IS NULL OR wo.priority=$5)
         AND ($6::uuid IS NULL OR wo.asset_id=$6::uuid)
       ORDER BY CASE wo.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
         wo.due_at NULLS LAST,wo.created_at DESC LIMIT $7`,
      [c.tenantId,c.factoryId,query.status??null,query.work_order_type??null,query.priority??null,
        query.asset_id??null,this.limit(query.limit)],
      {tenantId:c.tenantId,userId:c.userId},
    );
    return {work_orders:result.rows,count:result.rows.length};
  }

  async getWorkOrder(c: MaintenanceContext, workOrderId: string) {
    this.validateContext(c);this.validateUuid(workOrderId,'workOrderId');
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},client=>this.workOrderDetail(client,c,workOrderId));
  }

  async transitionWorkOrder(c: MaintenanceContext, workOrderId: string, dto: MaintenanceWorkOrderTransitionDto, rawKey: string | null) {
    this.validateContext(c);this.validateUuid(workOrderId,'workOrderId');
    const key=this.idempotencyKey(rawKey);
    const reason=this.requiredText(dto.reason,'reason',2000);
    const hash=this.hash({workOrderId:workOrderId.toLowerCase(),expected_version:dto.expected_version,action:dto.action,reason});
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.workOrderDetail(client,c,String(existing.entity_id))),replayed:true};
      const found=await client.query<Row>(
        'SELECT * FROM maintenance_work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [workOrderId,c.tenantId,c.factoryId],
      );
      const wo=found.rows[0];if(!wo) throw new NotFoundException('Maintenance work order not found');
      if(Number(wo.row_version)!==dto.expected_version) throw new ConflictException('Work order changed; reload before transitioning');
      const from=String(wo.status);
      const map:Record<string,string>={APPROVE:'APPROVED',START:'IN_PROGRESS',HOLD:'ON_HOLD',RESUME:'IN_PROGRESS',COMPLETE:'COMPLETED',CANCEL:'CANCELLED'};
      const to=map[dto.action];
      const allowed=(dto.action==='APPROVE'&&from==='PLANNED')||
        (dto.action==='START'&&from==='APPROVED')||
        (dto.action==='HOLD'&&from==='IN_PROGRESS')||
        (dto.action==='RESUME'&&from==='ON_HOLD')||
        (dto.action==='COMPLETE'&&from==='IN_PROGRESS')||
        (dto.action==='CANCEL'&&['PLANNED','APPROVED','ON_HOLD'].includes(from));
      if(!allowed) throw new ConflictException(`Work order cannot transition from ${from} using ${dto.action}`);
      const updated=await client.query<Row>(
        `UPDATE maintenance_work_orders SET status=$1,updated_by_user_id=$2,row_version=row_version+1,
           started_by_user_id=CASE WHEN $1='IN_PROGRESS' AND status IN ('APPROVED','ON_HOLD') THEN $2 ELSE started_by_user_id END,
           started_at=CASE WHEN $1='IN_PROGRESS' AND started_at IS NULL THEN clock_timestamp() ELSE started_at END,
           completed_by_user_id=CASE WHEN $1='COMPLETED' THEN $2 ELSE completed_by_user_id END,
           completed_at=CASE WHEN $1='COMPLETED' THEN clock_timestamp() ELSE completed_at END,
           cancelled_by_user_id=CASE WHEN $1='CANCELLED' THEN $2 ELSE cancelled_by_user_id END,
           cancelled_at=CASE WHEN $1='CANCELLED' THEN clock_timestamp() ELSE cancelled_at END,
           cancellation_reason=CASE WHEN $1='CANCELLED' THEN $3 ELSE cancellation_reason END,
           updated_at=clock_timestamp()
         WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND row_version=$7
         RETURNING row_version::int AS row_version,status`,
        [to,c.userId,reason,workOrderId,c.tenantId,c.factoryId,dto.expected_version],
      );
      const next=updated.rows[0];if(!next) throw new ConflictException('Work order changed during transition');
      await this.insertEvent(client,c,{entityType:'WORK_ORDER',entityId:workOrderId,version:Number(next.row_version),
        action:dto.action,fromStatus:from,toStatus:String(next.status),reason,data:{asset_id:wo.asset_id,work_order_number:wo.work_order_number},
        key,hash});
      return {...(await this.workOrderDetail(client,c,workOrderId)),replayed:false};
    });
  }

  async completeTask(c: MaintenanceContext, workOrderId: string, taskId: string, dto: CompleteMaintenanceTaskDto, rawKey: string | null) {
    this.validateContext(c);this.validateUuid(workOrderId,'workOrderId');this.validateUuid(taskId,'taskId');
    const key=this.idempotencyKey(rawKey);
    const reason=this.requiredText(dto.reason,'reason',2000);
    const evidence=dto.evidence??{};
    const hash=this.hash({workOrderId:workOrderId.toLowerCase(),taskId:taskId.toLowerCase(),
      expected_version:dto.expected_version,reason,evidence});
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.taskDetail(client,c,String(existing.entity_id))),replayed:true};
      const wo=await client.query<Row>(
        'SELECT status FROM maintenance_work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [workOrderId,c.tenantId,c.factoryId],
      );
      if(!wo.rows[0]) throw new NotFoundException('Maintenance work order not found');
      if(wo.rows[0].status!=='IN_PROGRESS') throw new ConflictException('Checklist tasks can only be completed while work is in progress');
      const found=await client.query<Row>(
        'SELECT * FROM maintenance_work_order_tasks WHERE id=$1 AND work_order_id=$2 AND tenant_id=$3 AND factory_id=$4 FOR UPDATE',
        [taskId,workOrderId,c.tenantId,c.factoryId],
      );
      const task=found.rows[0];if(!task) throw new NotFoundException('Checklist task not found in this work order');
      if(Number(task.row_version)!==dto.expected_version) throw new ConflictException('Checklist task changed; reload before completing');
      if(task.status!=='PENDING') throw new ConflictException('Only pending checklist tasks can be completed');
      const updated=await client.query<Row>(
        `UPDATE maintenance_work_order_tasks SET status='COMPLETED',completion_reason=$1,evidence=$2::jsonb,
          completed_by_user_id=$3,completed_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND row_version=$7
         RETURNING id::text AS id,row_version::int AS row_version,status`,
        [reason,JSON.stringify(evidence),c.userId,taskId,c.tenantId,c.factoryId,dto.expected_version],
      );
      const next=updated.rows[0];if(!next) throw new ConflictException('Checklist task changed during completion');
      await this.insertEvent(client,c,{entityType:'WORK_ORDER_TASK',entityId:taskId,version:Number(next.row_version),
        action:'COMPLETED',fromStatus:'PENDING',toStatus:'COMPLETED',reason,data:{evidence},key,hash,parentWorkOrderId:workOrderId});
      return {...(await this.taskDetail(client,c,taskId)),replayed:false};
    });
  }

  async addSparePart(c: MaintenanceContext, workOrderId: string, dto: AddMaintenanceSparePartDto, rawKey: string | null) {
    this.validateContext(c);this.validateUuid(workOrderId,'workOrderId');
    const key=this.idempotencyKey(rawKey);
    const itemId=this.uuidValue(dto.inventory_item_id,'inventory_item_id');
    const quantity=this.quantity(dto.required_quantity,'required_quantity');
    const notes=this.optionalText(dto.notes,1000);
    const hash=this.hash({workOrderId:workOrderId.toLowerCase(),inventory_item_id:itemId,required_quantity:quantity,notes});
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.partDetail(client,c,String(existing.entity_id))),replayed:true};
      const wo=await client.query<Row>(
        'SELECT status FROM maintenance_work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [workOrderId,c.tenantId,c.factoryId],
      );
      if(!wo.rows[0]) throw new NotFoundException('Maintenance work order not found');
      if(!['PLANNED','APPROVED'].includes(String(wo.rows[0].status))) {
        throw new ConflictException('Spare-part requirements must be planned before work starts');
      }
      const item=await client.query<Row>(
        'SELECT id::text AS id,sku,name,unit,status FROM inventory_items WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [itemId,c.tenantId,c.factoryId],
      );
      if(!item.rows[0]) throw new NotFoundException('Spare-part inventory item not found in this factory');
      if(item.rows[0].status!=='ACTIVE') throw new ConflictException('Disabled inventory items cannot be planned as spare parts');
      const inserted=await client.query<Row>(
        `INSERT INTO maintenance_work_order_parts (
          tenant_id,factory_id,work_order_id,inventory_item_id,required_quantity,notes,idempotency_key,
          request_hash,created_by_user_id,updated_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8,$9,$9,$10::uuid)
        RETURNING id::text AS id,row_version::int AS row_version,issued_quantity::text AS issued_quantity`,
        [c.tenantId,c.factoryId,workOrderId,itemId,quantity,notes,key,hash,c.userId,this.correlationId(c)),
      );
      const part=inserted.rows[0];if(!part) throw new Error('MAINTENANCE_PART_REQUIREMENT_INSERT_FAILED');
      await this.insertEvent(client,c,{entityType:'WORK_ORDER_PART',entityId:String(part.id),version:1,action:'REQUIREMENT_ADDED',
        reason:notes??'Spare part requirement added',data:{inventory_item_id:itemId,required_quantity:quantity},
        key,hash,parentWorkOrderId:workOrderId});
      return {...(await this.partDetail(client,c,String(part.id))),replayed:false};
    });
  }

  async issueSparePart(c: MaintenanceContext, workOrderId: string, partId: string, dto: IssueMaintenanceSparePartDto, rawKey: string | null) {
    this.validateContext(c);this.validateUuid(workOrderId,'workOrderId');this.validateUuid(partId,'partId');
    const key=this.idempotencyKey(rawKey);
    const quantity=this.quantity(dto.quantity,'quantity');
    const reason=this.requiredText(dto.reason,'reason',1000);
    const hash=this.hash({workOrderId:workOrderId.toLowerCase(),partId:partId.toLowerCase(),
      expected_version:dto.expected_version,quantity,reason});
    return this.database.transaction({tenantId:c.tenantId,userId:c.userId},async(client)=>{
      const existing=await this.lockAndFindEvent(client,c,key,hash);
      if(existing) return {...(await this.partDetail(client,c,String(existing.entity_id))),replayed:true};
      const woResult=await client.query<Row>(
        'SELECT status,work_order_number FROM maintenance_work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [workOrderId,c.tenantId,c.factoryId],
      );
      const wo=woResult.rows[0];if(!wo) throw new NotFoundException('Maintenance work order not found');
      if(wo.status!=='IN_PROGRESS') throw new ConflictException('Spare parts may only be issued while the work order is in progress');
      const partResult=await client.query<Row>(
        'SELECT * FROM maintenance_work_order_parts WHERE id=$1 AND work_order_id=$2 AND tenant_id=$3 AND factory_id=$4 FOR UPDATE',
        [partId,workOrderId,c.tenantId,c.factoryId],
      );
      const part=partResult.rows[0];if(!part) throw new NotFoundException('Spare-part requirement not found in this work order');
      if(Number(part.row_version)!==dto.expected_version) throw new ConflictException('Spare-part requirement changed; reload before issue');
      const itemResult=await client.query<Row>(
        'SELECT status,sku,name FROM inventory_items WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [part.inventory_item_id,c.tenantId,c.factoryId],
      );
      const item=itemResult.rows[0];if(!item) throw new NotFoundException('Spare part is not scoped to this factory');
      if(item.status!=='ACTIVE') throw new ConflictException('Disabled inventory items cannot be issued');
      const quantityUnits=this.quantityUnits(quantity);
      const remainingUnits=this.quantityUnits(String(part.required_quantity))-this.quantityUnits(String(part.issued_quantity));
      if(quantityUnits>remainingUnits) throw new ConflictException('Issue quantity exceeds the outstanding spare-part requirement');
      const balance=await client.query<Row>(
        `UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand-$1::numeric,
            version=version+1,updated_at=clock_timestamp()
         WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4
           AND quantity_on_hand-quantity_reserved >= $1::numeric
         RETURNING quantity_on_hand::text AS quantity_after,quantity_reserved::text AS quantity_reserved`,
        [quantity,c.tenantId,c.factoryId,part.inventory_item_id],
      );
      const stock=balance.rows[0];
      if(!stock) throw new ConflictException('Insufficient unreserved stock for this spare-part issue');
      const movementKey=`maintenance-issue:${key}`;
      const movementHash=this.hash({workOrderId:workOrderId.toLowerCase(),partId:partId.toLowerCase(),
        itemId:String(part.inventory_item_id),quantity,reason});
      const movement=await client.query<Row>(
        `INSERT INTO inventory_movements (
          tenant_id,factory_id,item_id,movement_type,quantity,quantity_delta,quantity_after,
          idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,'ISSUE',$4::numeric,-$4::numeric,$5::numeric,$6,$7,
          'MAINTENANCE_WORK_ORDER_PART',$8::uuid,$9,$10,$11::uuid)
        RETURNING id::text AS id,quantity_after::text AS quantity_after`,
        [c.tenantId,c.factoryId,part.inventory_item_id,quantity,stock.quantity_after,movementKey,movementHash,
          partId,reason,c.userId,this.correlationId(c)),
      );
      const movementRow=movement.rows[0];if(!movementRow) throw new Error('MAINTENANCE_SPARE_PART_MOVEMENT_FAILED');
      const updated=await client.query<Row>(
        `UPDATE maintenance_work_order_parts SET issued_quantity=issued_quantity+$1::numeric,
           row_version=row_version+1,updated_by_user_id=$2,updated_at=clock_timestamp()
         WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6
         RETURNING id::text AS id,row_version::int AS row_version,issued_quantity::text AS issued_quantity`,
        [quantity,c.userId,partId,c.tenantId,c.factoryId,dto.expected_version],
      );
      const next=updated.rows[0];if(!next) throw new ConflictException('Spare-part requirement changed while issuing stock');
      await this.insertEvent(client,c,{entityType:'WORK_ORDER_PART',entityId:partId,version:Number(next.row_version),
        action:'STOCK_ISSUED',reason,data:{inventory_item_id:part.inventory_item_id,quantity,
          inventory_movement_id:movementRow.id,work_order_number:wo.work_order_number,
          quantity_after:stock.quantity_after,quantity_reserved:stock.quantity_reserved},
        key,hash,parentWorkOrderId:workOrderId});
      return {...(await this.partDetail(client,c,partId)),last_movement_id:movementRow.id,replayed:false};
    });
  }

  async getSparePartAvailability(c: MaintenanceContext, itemId: string) {
    this.validateContext(c);this.validateUuid(itemId,'itemId');
    const result=await this.database.query<Row>(
      `SELECT i.id::text AS inventory_item_id,i.sku,i.name,i.unit,i.status,
         COALESCE(b.quantity_on_hand,0)::text AS quantity_on_hand,
         COALESCE(b.quantity_reserved,0)::text AS quantity_reserved,
         (COALESCE(b.quantity_on_hand,0)-COALESCE(b.quantity_reserved,0))::text AS quantity_available
       FROM inventory_items i
       LEFT JOIN inventory_stock_balances b ON b.item_id=i.id AND b.tenant_id=i.tenant_id AND b.factory_id=i.factory_id
       WHERE i.id=$1 AND i.tenant_id=$2 AND i.factory_id=$3`,
      [itemId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId},
    );
    if(!result.rows[0]) throw new NotFoundException('Inventory item not found in this factory');
    return result.rows[0];
  }

  private async assetDetail(client: PoolClient,c:MaintenanceContext,id:string) {
    const found=await client.query<Row>(
      `SELECT a.*,a.id::text AS id,a.parent_asset_id::text AS parent_asset_id,
        a.created_by_user_id::text AS created_by_user_id,a.updated_by_user_id::text AS updated_by_user_id,
        a.row_version::int AS row_version,a.created_at::text AS created_at,a.updated_at::text AS updated_at
       FROM maintenance_assets a WHERE a.id=$1 AND a.tenant_id=$2 AND a.factory_id=$3`,
      [id,c.tenantId,c.factoryId],
    );
    const asset=found.rows[0];if(!asset) throw new NotFoundException('Asset was not found in this factory');
    const [children,plans,orders]=await Promise.all([
      client.query<Row>(`SELECT id::text AS id,asset_code,name,status,criticality FROM maintenance_assets
        WHERE parent_asset_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY asset_code`,[id,c.tenantId,c.factoryId]),
      client.query<Row>(`SELECT id::text AS id,plan_code,revision,name,status,next_due_on::text AS next_due_on
        FROM maintenance_pm_plans WHERE asset_id=$1 AND tenant_id=$2 AND factory_id=$3
        ORDER BY next_due_on,plan_code,revision DESC`,[id,c.tenantId,c.factoryId]),
      client.query<Row>(`SELECT id::text AS id,work_order_number,work_order_type,status,priority,title,due_at::text AS due_at
        FROM maintenance_work_orders WHERE asset_id=$1 AND tenant_id=$2 AND factory_id=$3
        ORDER BY created_at DESC LIMIT 10`,[id,c.tenantId,c.factoryId]),
    ]);
    return {asset,children:children.rows,pm_plans:plans.rows,recent_work_orders:orders.rows};
  }

  private async pmPlanDetail(client: PoolClient,c:MaintenanceContext,id:string) {
    const found=await client.query<Row>(
      `SELECT p.*,p.id::text AS id,p.asset_id::text AS asset_id,p.row_version::int AS row_version,
        p.created_by_user_id::text AS created_by_user_id,p.approved_by_user_id::text AS approved_by_user_id,
        p.next_due_on::text AS next_due_on,p.created_at::text AS created_at,p.updated_at::text AS updated_at,
        a.asset_code,a.name AS asset_name,a.status AS asset_status
       FROM maintenance_pm_plans p JOIN maintenance_assets a
         ON a.id=p.asset_id AND a.tenant_id=p.tenant_id AND a.factory_id=p.factory_id
       WHERE p.id=$1 AND p.tenant_id=$2 AND p.factory_id=$3`,
      [id,c.tenantId,c.factoryId],
    );
    if(!found.rows[0]) throw new NotFoundException('Preventive-maintenance plan not found');
    const events=await client.query<Row>(
      `SELECT action,from_status,to_status,reason,event_data,actor_user_id::text AS actor_user_id,created_at::text AS created_at
       FROM maintenance_events WHERE entity_type='PM_PLAN' AND entity_id=$1 AND tenant_id=$2 AND factory_id=$3
       ORDER BY entity_version DESC LIMIT 20`,[id,c.tenantId,c.factoryId]);
    return {plan:found.rows[0],events:events.rows};
  }

  private async workOrderDetail(client:PoolClient,c:MaintenanceContext,id:string) {
    const found=await client.query<Row>(
      `SELECT wo.*,wo.id::text AS id,wo.asset_id::text AS asset_id,wo.pm_plan_id::text AS pm_plan_id,
        wo.assigned_to_user_id::text AS assigned_to_user_id,wo.row_version::int AS row_version,
        wo.created_by_user_id::text AS created_by_user_id,wo.updated_by_user_id::text AS updated_by_user_id,
        wo.plan_due_on::text AS plan_due_on,wo.created_at::text AS created_at,wo.updated_at::text AS updated_at,
        a.asset_code,a.name AS asset_name,a.criticality AS asset_criticality,
        p.plan_code,p.revision AS pm_plan_revision,p.requires_shutdown
       FROM maintenance_work_orders wo
       JOIN maintenance_assets a ON a.id=wo.asset_id AND a.tenant_id=wo.tenant_id AND a.factory_id=wo.factory_id
       LEFT JOIN maintenance_pm_plans p ON p.id=wo.pm_plan_id AND p.tenant_id=wo.tenant_id AND p.factory_id=wo.factory_id
       WHERE wo.id=$1 AND wo.tenant_id=$2 AND wo.factory_id=$3`,[id,c.tenantId,c.factoryId]);
    if(!found.rows[0]) throw new NotFoundException('Maintenance work order not found');
    const [tasks,parts,events]=await Promise.all([
      client.query<Row>(`SELECT t.*,t.id::text AS id,t.row_version::int AS row_version,
        t.completed_by_user_id::text AS completed_by_user_id,t.created_at::text AS created_at
        FROM maintenance_work_order_tasks t WHERE t.work_order_id=$1 AND t.tenant_id=$2 AND t.factory_id=$3
        ORDER BY t.sequence_no,t.id`,[id,c.tenantId,c.factoryId]),
      client.query<Row>(`SELECT p.*,p.id::text AS id,p.inventory_item_id::text AS inventory_item_id,
        p.row_version::int AS row_version,i.sku,i.name AS item_name,i.unit,
        COALESCE(b.quantity_on_hand,0)::text AS quantity_on_hand,
        COALESCE(b.quantity_reserved,0)::text AS quantity_reserved,
        (COALESCE(b.quantity_on_hand,0)-COALESCE(b.quantity_reserved,0))::text AS quantity_available
        FROM maintenance_work_order_parts p JOIN inventory_items i
          ON i.id=p.inventory_item_id AND i.tenant_id=p.tenant_id AND i.factory_id=p.factory_id
        LEFT JOIN inventory_stock_balances b ON b.item_id=i.id AND b.tenant_id=i.tenant_id AND b.factory_id=i.factory_id
        WHERE p.work_order_id=$1 AND p.tenant_id=$2 AND p.factory_id=$3 ORDER BY i.sku,p.id`,[id,c.tenantId,c.factoryId]),
      client.query<Row>(`SELECT entity_type,entity_id::text AS entity_id,entity_version,action,from_status,to_status,
        reason,event_data,actor_user_id::text AS actor_user_id,created_at::text AS created_at
        FROM maintenance_events WHERE tenant_id=$1 AND factory_id=$2
          AND (entity_id=$3 OR parent_work_order_id=$3)
        ORDER BY created_at DESC LIMIT 100`,[c.tenantId,c.factoryId,id]),
    ]);
    return {work_order:found.rows[0],checklist:tasks.rows,spare_parts:parts.rows,events:events.rows};
  }

  private async taskDetail(client:PoolClient,c:MaintenanceContext,id:string) {
    const result=await client.query<Row>(
      `SELECT t.*,t.id::text AS id,t.work_order_id::text AS work_order_id,t.row_version::int AS row_version
       FROM maintenance_work_order_tasks t WHERE t.id=$1 AND t.tenant_id=$2 AND t.factory_id=$3`,
      [id,c.tenantId,c.factoryId]);
    if(!result.rows[0]) throw new NotFoundException('Maintenance checklist task not found');
    return {task:result.rows[0]};
  }

  private async partDetail(client:PoolClient,c:MaintenanceContext,id:string) {
    const result=await client.query<Row>(
      `SELECT p.*,p.id::text AS id,p.work_order_id::text AS work_order_id,p.inventory_item_id::text AS inventory_item_id,
        p.row_version::int AS row_version,i.sku,i.name AS item_name,i.unit,
        COALESCE(b.quantity_on_hand,0)::text AS quantity_on_hand,COALESCE(b.quantity_reserved,0)::text AS quantity_reserved,
        (COALESCE(b.quantity_on_hand,0)-COALESCE(b.quantity_reserved,0))::text AS quantity_available
       FROM maintenance_work_order_parts p JOIN inventory_items i
        ON i.id=p.inventory_item_id AND i.tenant_id=p.tenant_id AND i.factory_id=p.factory_id
       LEFT JOIN inventory_stock_balances b ON b.item_id=i.id AND b.tenant_id=i.tenant_id AND b.factory_id=i.factory_id
       WHERE p.id=$1 AND p.tenant_id=$2 AND p.factory_id=$3`,[id,c.tenantId,c.factoryId]);
    if(!result.rows[0]) throw new NotFoundException('Maintenance spare-part requirement not found');
    return {spare_part:result.rows[0]};
  }

  private async insertTasks(client:PoolClient,c:MaintenanceContext,workOrderId:string,checklist:MaintenanceChecklistEntryDto[],keyPrefix:string,defaultPrefix:string) {
    for(let i=0;i<checklist.length;i++){
      const item=checklist[i]!;
      const taskFingerprint=this.hash({keyPrefix,sequence:i+1}).slice(0,48);\n      const taskKey=`maint-task:${taskFingerprint}`;
      const taskHash=this.hash({workOrderId,task:item,sequence:i+1});
      const created=await client.query<Row>(
        `INSERT INTO maintenance_work_order_tasks (
          tenant_id,factory_id,work_order_id,task_code,description,sequence_no,is_required,status,
          evidence,idempotency_key,request_hash,created_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING','{}'::jsonb,$8,$9,$10,$11::uuid)
        RETURNING id::text AS id,row_version::int AS row_version`,
        [c.tenantId,c.factoryId,workOrderId,item.code,item.description,i+1,item.required??true,taskKey,taskHash,c.userId,this.correlationId(c)),
      );
      const row=created.rows[0];if(!row) throw new Error('MAINTENANCE_TASK_INSERT_FAILED');
      await this.insertEvent(client,c,{entityType:'WORK_ORDER_TASK',entityId:String(row.id),version:1,
        action:'CREATED',toStatus:'PENDING',reason:defaultPrefix,data:{task_code:item.code,description:item.description,required:item.required??true},
        key:`maint-task-event:${taskFingerprint}`,hash:taskHash,parentWorkOrderId:workOrderId});
    }
  }

  private async insertEvent(client:PoolClient,c:MaintenanceContext,input:{
    entityType:'ASSET'|'PM_PLAN'|'WORK_ORDER'|'WORK_ORDER_TASK'|'WORK_ORDER_PART';
    entityId:string;version:number;action:string;fromStatus?:string|null;toStatus?:string|null;
    reason?:string|null;data?:Record<string,unknown>;key:string;hash:string;parentWorkOrderId?:string|null;
  }) {
    await client.query(
      `INSERT INTO maintenance_events (
        tenant_id,factory_id,entity_type,entity_id,parent_work_order_id,entity_version,action,from_status,to_status,
        reason,event_data,idempotency_key,request_hash,actor_user_id,correlation_id
      ) VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::uuid)`,
      [c.tenantId,c.factoryId,input.entityType,input.entityId,input.parentWorkOrderId??null,input.version,input.action,
        input.fromStatus??null,input.toStatus??null,input.reason??null,JSON.stringify(input.data??{}),input.key,input.hash,c.userId,this.correlationId(c)),
    );
  }

  private async lockAndFindEvent(client:PoolClient,c:MaintenanceContext,key:string,hash:string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[`${c.tenantId}:${c.factoryId}:${key}`]);
    const result=await client.query<Row>(
      `SELECT entity_type,entity_id::text AS entity_id,request_hash,event_data
       FROM maintenance_events WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 LIMIT 1`,
      [c.tenantId,c.factoryId,key]);
    const event=result.rows[0];
    if(event&&event.request_hash!==hash) throw new ConflictException('Idempotency-Key was already used for a different maintenance request');
    return event??null;
  }

  private correlationId(c: MaintenanceContext) {
    if (c.traceId && isUUID(c.traceId)) return c.traceId.toLowerCase();
    if (c.requestId && isUUID(c.requestId)) return c.requestId.toLowerCase();
    return randomUUID();
  }

  private validateContext(c:MaintenanceContext) {
    this.validateUuid(c.userId,'userId');this.validateUuid(c.tenantId,'tenantId');this.validateUuid(c.factoryId,'factoryId');
  }
  private validateUuid(value:string,name:string) {
    if(!isUUID(value)) throw new BadRequestException(`${name} must be a valid UUID`);
  }
  private uuidValue(value:unknown,name:string) {
    if(typeof value!=='string'||!isUUID(value)) throw new BadRequestException(`${name} must be a valid UUID`);
    return value.toLowerCase();
  }
  private optionalUuid(value:unknown,name:string) {
    if(value===undefined||value===null||value==='') return null;
    return this.uuidValue(value,name);
  }
  private idempotencyKey(raw:string|null) {
    const key=raw?.trim()??'';
    if(!key||key.length>220) throw new BadRequestException('Idempotency-Key is required and must be 1-220 characters');
    return key;
  }
  private requiredText(value:unknown,name:string,max:number) {
    if(typeof value!=='string'||!value.trim()||value.trim().length>max) throw new BadRequestException(`${name} is required and must be at most ${max} characters`);
    return value.trim();
  }
  private optionalText(value:string|null|undefined,max:number) {
    if(value===undefined||value===null) return null;
    const trimmed=value.trim();
    if(trimmed.length>max) throw new BadRequestException(`Text value must be at most ${max} characters`);
    return trimmed||null;
  }
  private dateOnly(value:string,name:string) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value) {
      throw new BadRequestException(`${name} must be a valid YYYY-MM-DD date`);
    }
    return value;
  }
  private limit(value?:number) {
    const limit=value===undefined?50:Number(value);
    if(!Number.isInteger(limit)||limit<1||limit>100) throw new BadRequestException('limit must be an integer between 1 and 100');
    return limit;
  }
  private quantity(value:number,name:string) {
    const n=Number(value);
    if(!Number.isFinite(n)||n<=0||Math.abs(n*10000-Math.round(n*10000))>1e-7) {
      throw new BadRequestException(`${name} must be greater than zero with at most four decimal places`);
    }
    return (Math.round(n*10000)/10000).toFixed(4);
  }
  private quantityUnits(value:string) {
    const match=/^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value).trim());
    if(!match) throw new ConflictException('Stored inventory quantity is not a valid four-decimal value');
    return BigInt(match[1]!)*10000n+BigInt((match[2]??'').padEnd(4,'0'));
  }
  private normalizeChecklist(items:MaintenanceChecklistEntryDto[]) {
    if(!Array.isArray(items)||items.length>100) throw new BadRequestException('checklist must contain no more than 100 items');
    const seen=new Set<string>();
    return items.map((raw,index)=>{
      const code=this.requiredText(raw.code, `checklist[${index}].code`,100).toUpperCase();
      const description=this.requiredText(raw.description,`checklist[${index}].description`,1000);
      if(seen.has(code)) throw new BadRequestException('Checklist task codes must be unique within the plan or work order');
      seen.add(code);
      return {code,description,required:raw.required!==false};
    });
  }
  private canonical(value:unknown):unknown {
    if(Array.isArray(value)) return value.map(v=>this.canonical(v));
    if(value&&typeof value==='object') {
      const obj=value as Record<string,unknown>;
      return Object.fromEntries(Object.keys(obj).sort().map(k=>[k,this.canonical(obj[k])]));
    }
    return value;
  }
  private hash(value:unknown) {
    return createHash('sha256').update(JSON.stringify(this.canonical(value))).digest('hex');
  }
}
