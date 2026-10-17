import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateProductAlternateDto } from './dto/create-product-alternate.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductVersionDto } from './dto/create-product-version.dto';
import { CreateWorkCentreDto } from './dto/create-work-centre.dto';
import { ExpectedVersionDto } from './dto/expected-version.dto';
import { ReplaceProductBomDto } from './dto/replace-product-bom.dto';
import { ReplaceProductRoutingDto } from './dto/replace-product-routing.dto';

interface ProductRow extends QueryResultRow {
  id:string; tenant_id:string; factory_id:string; inventory_item_id:string; product_code:string;
  product_name:string; product_type:string; base_unit:string; status:string; version:string;
  created_by_user_id:string; updated_by_user_id:string; created_at:string; updated_at:string;
}
interface VersionRow extends QueryResultRow {
  id:string; tenant_id:string; factory_id:string; product_id:string; version_number:number;
  state:'DRAFT'|'APPROVED'|'RETIRED'; effective_from:string; effective_to:string|null;
  expected_yield_percent:string; change_summary:string; row_version:string; idempotency_key:string;
  request_hash:string; approval_idempotency_key:string|null; approval_request_hash:string|null;
  retirement_idempotency_key:string|null; retirement_request_hash:string|null; created_by_user_id:string;
  updated_by_user_id:string; approved_by_user_id:string|null; approved_at:string|null;
  created_at:string; updated_at:string;
}
interface WorkCentreRow extends QueryResultRow {
  id:string; tenant_id:string; factory_id:string; code:string; name:string; status:string;
  capacity_units_per_hour:string|null; version:string; idempotency_key:string; request_hash:string;
  created_by_user_id:string; updated_by_user_id:string; created_at:string; updated_at:string;
}
interface AlternateRow extends QueryResultRow {
  id:string; tenant_id:string; factory_id:string; product_id:string; product_version_id:string;
  bom_line_id:string; alternate_item_id:string; conversion_factor:string; unit:string; rationale:string;
  status:string; idempotency_key:string; request_hash:string; approval_idempotency_key:string|null;
  approval_request_hash:string|null; created_by_user_id:string; approved_by_user_id:string|null;
  approved_at:string|null; created_at:string; updated_at:string;
}
const PRODUCT_COLS=`p.id::text AS id,p.tenant_id::text AS tenant_id,p.factory_id::text AS factory_id,
 p.inventory_item_id::text AS inventory_item_id,p.product_code,p.product_name,p.product_type,p.base_unit,p.status,
 p.version::text AS version,p.created_by_user_id::text AS created_by_user_id,p.updated_by_user_id::text AS updated_by_user_id,
 p.created_at::text AS created_at,p.updated_at::text AS updated_at`;
const VERSION_COLS=`id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,product_id::text AS product_id,
 version_number,state,effective_from::text AS effective_from,effective_to::text AS effective_to,
 expected_yield_percent::text AS expected_yield_percent,change_summary,row_version::text AS row_version,
 idempotency_key,request_hash,approval_idempotency_key,approval_request_hash,retirement_idempotency_key,retirement_request_hash,
 created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,
 approved_by_user_id::text AS approved_by_user_id,approved_at::text AS approved_at,created_at::text AS created_at,updated_at::text AS updated_at`;
const WORK_CENTRE_COLS=`id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,code,name,status,
 capacity_units_per_hour::text AS capacity_units_per_hour,version::text AS version,idempotency_key,request_hash,
 created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,
 created_at::text AS created_at,updated_at::text AS updated_at`;
const ALTERNATE_COLS=`id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,product_id::text AS product_id,
 product_version_id::text AS product_version_id,bom_line_id::text AS bom_line_id,alternate_item_id::text AS alternate_item_id,
 conversion_factor::text AS conversion_factor,unit,rationale,status,idempotency_key,request_hash,
 approval_idempotency_key,approval_request_hash,created_by_user_id::text AS created_by_user_id,
 approved_by_user_id::text AS approved_by_user_id,approved_at::text AS approved_at,
 created_at::text AS created_at,updated_at::text AS updated_at`;

@Injectable()
export class ProductDefinitionsService {
  constructor(private readonly database:DatabaseService, private readonly audit:AuditService) {}

  async listProducts(userId:string,tenantId:string,factoryId:string,rawLimit=50):Promise<ProductRow[]> {
    this.scope(userId,tenantId,factoryId);
    const r=await this.database.query<ProductRow>(`SELECT ${PRODUCT_COLS} FROM product_definitions p
      WHERE p.tenant_id=$1 AND p.factory_id=$2 ORDER BY p.product_code,p.id LIMIT $3`,
      [tenantId,factoryId,this.limit(rawLimit)],{tenantId,userId});
    return r.rows;
  }

  async createProduct(userId:string,tenantId:string,factoryId:string,dto:CreateProductDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(dto.inventory_item_id,'inventory_item_id');
    const itemId=dto.inventory_item_id.toLowerCase(), code=this.text(dto.product_code,'product_code',120);
    const name=this.text(dto.product_name,'product_name',255), unit=this.text(dto.base_unit,'base_unit',50);
    const type=dto.product_type??'STANDARD';
    const key=this.key(keyRaw), hash=this.hash({inventory_item_id:itemId,product_code:code.toLowerCase(),product_name:name,product_type:type,base_unit:unit});
    const correlation=this.correlation(requestId,traceId);
    try {
      const result=await this.database.transaction({tenantId,userId},async client=>{
        await this.lockKey(client,tenantId,factoryId,'product',key);
        const old=await client.query<ProductRow & {request_hash:string}>(`SELECT ${PRODUCT_COLS},l.request_hash
          FROM product_definition_idempotency l JOIN product_definitions p ON p.id=l.product_id
            AND p.tenant_id=l.tenant_id AND p.factory_id=l.factory_id
          WHERE l.tenant_id=$1 AND l.factory_id=$2 AND l.idempotency_key=$3`,
          [tenantId,factoryId,key]);
        if(old.rows[0]) {
          if(old.rows[0].request_hash!==hash) throw new ConflictException('Idempotency-Key was reused for a different product definition');
          return {product:old.rows[0],replayed:true};
        }
        const item=await client.query<{id:string;status:string;unit:string}>(`SELECT id::text AS id,status,unit FROM inventory_items
          WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR KEY SHARE`,[itemId,tenantId,factoryId]);
        if(!item.rows[0]||item.rows[0].status!=='ACTIVE') throw new NotFoundException('Active inventory item was not found in this factory');
        if(item.rows[0].unit.trim().toUpperCase()!==unit.toUpperCase()) throw new BadRequestException('base_unit must match the finished-good inventory item base unit');
        const r=await client.query<ProductRow>(`INSERT INTO product_definitions(
          tenant_id,factory_id,inventory_item_id,product_code,product_name,product_type,base_unit,status,version,
          created_by_user_id,updated_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',1,$8,$8)
          RETURNING id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,
           inventory_item_id::text AS inventory_item_id,product_code,product_name,product_type,base_unit,status,
           version::text AS version,created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,
           created_at::text AS created_at,updated_at::text AS updated_at`,
          [tenantId,factoryId,itemId,code,name,type,unit,userId]);
        const product=r.rows[0]; if(!product) throw new Error('PRODUCT_DEFINITION_INSERT_FAILED');
        await client.query(`INSERT INTO product_definition_idempotency(tenant_id,factory_id,idempotency_key,request_hash,product_id,created_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,factoryId,key,hash,product.id,userId]);
        await this.outbox(client,{tenantId,factoryId,type:'PRODUCT',id:product.id,event:'PRODUCT.DEFINITION_CREATED',correlation,requestId,userId,
          payload:{product_id:product.id,product_code:code,inventory_item_id:itemId}});
        return {product,replayed:false};
      });
      if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_DEFINITION_CREATED',resource:'PRODUCT_DEFINITION',id:result.product.id,requestId,traceId,payload:{product_code:code,inventory_item_id:itemId}});
      return result;
    } catch(e) { this.uniqueConflict(e,'Product code, inventory binding or idempotency key already exists in this factory'); throw e; }
  }

  async listVersions(userId:string,tenantId:string,factoryId:string,productId:string):Promise<VersionRow[]> {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId');
    const r=await this.database.query<VersionRow>(`SELECT ${VERSION_COLS} FROM product_versions
      WHERE tenant_id=$1 AND factory_id=$2 AND product_id=$3 ORDER BY version_number DESC,id`,
      [tenantId,factoryId,productId.toLowerCase()],{tenantId,userId});
    return r.rows;
  }

  async createVersion(userId:string,tenantId:string,factoryId:string,productId:string,dto:CreateProductVersionDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId');
    const from=this.date(dto.effective_from,'effective_from'),to=dto.effective_to?this.date(dto.effective_to,'effective_to'):null;
    if(to&&to<from) throw new BadRequestException('effective_to must be on or after effective_from');
    const yieldPct=this.decimal(dto.expected_yield_percent,'expected_yield_percent',4,0.0001,100);
    const summary=this.text(dto.change_summary,'change_summary',2000),key=this.key(keyRaw),pId=productId.toLowerCase();
    const hash=this.hash({product_id:pId,effective_from:from,effective_to:to,expected_yield_percent:yieldPct,change_summary:summary});
    const correlation=this.correlation(requestId,traceId);
    try {
      const result=await this.database.transaction({tenantId,userId},async client=>{
        await this.lockKey(client,tenantId,factoryId,'product-version',key);
        const old=await client.query<VersionRow>(`SELECT ${VERSION_COLS} FROM product_versions
          WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3`,[tenantId,factoryId,key]);
        if(old.rows[0]) { if(old.rows[0].request_hash!==hash) throw new ConflictException('Idempotency-Key was reused for a different product version'); return {version:old.rows[0],replayed:true}; }
        const p=await client.query<{id:string;status:string}>(`SELECT id::text AS id,status FROM product_definitions
          WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,[pId,tenantId,factoryId]);
        if(!p.rows[0]||p.rows[0].status!=='ACTIVE') throw new NotFoundException('Active product was not found in this factory');
        const n=await client.query<{n:number}>(`SELECT COALESCE(MAX(version_number),0)+1 AS n FROM product_versions
          WHERE product_id=$1 AND tenant_id=$2 AND factory_id=$3`,[pId,tenantId,factoryId]);
        const r=await client.query<VersionRow>(`INSERT INTO product_versions(
          tenant_id,factory_id,product_id,version_number,state,effective_from,effective_to,expected_yield_percent,
          change_summary,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id)
          VALUES($1,$2,$3,$4,'DRAFT',$5::date,$6::date,$7::numeric,$8,1,$9,$10,$11,$11) RETURNING ${VERSION_COLS}`,
          [tenantId,factoryId,pId,Number(n.rows[0]?.n??1),from,to,yieldPct,summary,key,hash,userId]);
        const version=r.rows[0]; if(!version) throw new Error('PRODUCT_VERSION_INSERT_FAILED');
        await this.outbox(client,{tenantId,factoryId,type:'PRODUCT_VERSION',id:version.id,event:'PRODUCT.VERSION_DRAFT_CREATED',correlation,requestId,userId,
          payload:{product_id:pId,product_version_id:version.id,version_number:version.version_number,effective_from:from,effective_to:to,expected_yield_percent:yieldPct}});
        return {version,replayed:false};
      });
      if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_VERSION_DRAFT_CREATED',resource:'PRODUCT_VERSION',id:result.version.id,requestId,traceId,payload:{productId:pId,versionNumber:result.version.version_number,effectiveFrom:from,effectiveTo:to}});
      return result;
    } catch(e) { this.uniqueConflict(e,'Product version or idempotency key already exists'); throw e; }
  }

  async getEffectiveVersion(userId:string,tenantId:string,factoryId:string,productId:string,atRaw:string) {
    this.scope(userId,tenantId,factoryId);
    this.uuid(productId,'productId');
    const at=this.date(atRaw,'at');
    const found=await this.database.query<VersionRow>(`SELECT ${VERSION_COLS} FROM product_versions
      WHERE tenant_id=$1 AND factory_id=$2 AND product_id=$3 AND state='APPROVED'
        AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date)
      ORDER BY version_number DESC LIMIT 2`,
      [tenantId,factoryId,productId.toLowerCase(),at],{tenantId,userId});
    if(found.rows.length===0) throw new NotFoundException('No approved product version is effective on the requested date');
    if(found.rows.length>1) throw new ConflictException('Multiple approved product versions overlap the requested date; release integrity needs repair');
    return this.getVersionDetail(userId,tenantId,factoryId,productId,found.rows[0].id);
  }

  async getVersionDetail(userId:string,tenantId:string,factoryId:string,productId:string,versionId:string) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(versionId,'versionId');
    return this.database.transaction({tenantId,userId},async client=>{
      const h=await client.query<VersionRow>(`SELECT ${VERSION_COLS} FROM product_versions
        WHERE id=$1 AND product_id=$2 AND tenant_id=$3 AND factory_id=$4`,[versionId.toLowerCase(),productId.toLowerCase(),tenantId,factoryId]);
      const version=h.rows[0]; if(!version) throw new NotFoundException('Product version was not found in this factory');
      const bom=await client.query(`SELECT b.id::text AS id,b.line_number,b.component_item_id::text AS component_item_id,
        i.sku AS component_sku,i.item_name AS component_name,b.quantity_per::text AS quantity_per,b.unit,
        b.wastage_percent::text AS wastage_percent,b.alternate_group_code,b.notes
        FROM product_bom_lines b JOIN inventory_items i ON i.id=b.component_item_id AND i.tenant_id=b.tenant_id AND i.factory_id=b.factory_id
        WHERE b.product_version_id=$1 AND b.tenant_id=$2 AND b.factory_id=$3 ORDER BY b.line_number`,
        [version.id,tenantId,factoryId]);
      const alts=await client.query(`SELECT a.id::text AS id,a.bom_line_id::text AS bom_line_id,
        a.alternate_item_id::text AS alternate_item_id,i.sku AS alternate_sku,i.item_name AS alternate_name,
        a.conversion_factor::text AS conversion_factor,a.unit,a.rationale,a.status,
        a.approved_by_user_id::text AS approved_by_user_id,a.approved_at::text AS approved_at
        FROM product_bom_alternates a JOIN inventory_items i ON i.id=a.alternate_item_id AND i.tenant_id=a.tenant_id AND i.factory_id=a.factory_id
        WHERE a.product_version_id=$1 AND a.tenant_id=$2 AND a.factory_id=$3 ORDER BY a.bom_line_id,a.created_at,a.id`,
        [version.id,tenantId,factoryId]);
      const routing=await client.query(`SELECT r.id::text AS id,r.step_number,r.operation_code,r.operation_name,
        r.work_centre_id::text AS work_centre_id,w.code AS work_centre_code,w.name AS work_centre_name,
        r.setup_minutes::text AS setup_minutes,r.run_minutes_per_unit::text AS run_minutes_per_unit,
        r.queue_minutes::text AS queue_minutes,r.transfer_minutes::text AS transfer_minutes,r.required_skill,r.instructions,r.is_quality_gate
        FROM product_routing_steps r JOIN manufacturing_work_centres w ON w.id=r.work_centre_id AND w.tenant_id=r.tenant_id AND w.factory_id=r.factory_id
        WHERE r.product_version_id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 ORDER BY r.step_number`,
        [version.id,tenantId,factoryId]);
      return {version,bom_lines:bom.rows,alternates:alts.rows,routing_steps:routing.rows};
    });
  }

  async replaceBom(userId:string,tenantId:string,factoryId:string,productId:string,versionId:string,dto:ReplaceProductBomDto,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(versionId,'versionId');
    if(!Number.isInteger(dto.expected_version)||dto.expected_version<1) throw new BadRequestException('expected_version must be a positive integer');
    if(!Array.isArray(dto.lines)||dto.lines.length<1||dto.lines.length>200) throw new BadRequestException('BOM must contain between 1 and 200 lines');
    const lines=dto.lines.map((x,i)=>({line:x.line_number,item:this.normUuid(x.component_item_id,`lines[${i}].component_item_id`),
      qty:this.decimal(x.quantity_per,`lines[${i}].quantity_per`,4,0.0001,99999999999999),unit:this.text(x.unit,`lines[${i}].unit`,50),
      wastage:this.decimal(x.wastage_percent??0,`lines[${i}].wastage_percent`,4,0,100),
      group:x.alternate_group_code?.trim()||null,notes:x.notes?.trim()||null}));
    this.uniqueNumbers(lines.map(x=>x.line),'BOM line_number values must be unique');
    const p=productId.toLowerCase(),v=versionId.toLowerCase(),correlation=this.correlation(requestId,traceId);
    const result=await this.database.transaction({tenantId,userId},async client=>{
      await this.lockDraft(client,tenantId,factoryId,p,v,dto.expected_version);
      const ids=[...new Set(lines.map(x=>x.item))];
      const valid=await client.query<{id:string;unit:string}>(`SELECT id::text AS id,unit FROM inventory_items
        WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' AND id=ANY($3::uuid[])`,[tenantId,factoryId,ids]);
      if(valid.rows.length!==ids.length) throw new BadRequestException('BOM components must be active inventory items in the same factory');
      for(const line of lines) {
        const item=valid.rows.find(x=>x.id===line.item);
        if(item) await this.assertUnitCompatible(client,tenantId,factoryId,line.unit,item.unit,`BOM line ${line.line} unit`);
      }
      const rowVersion=await this.bumpDraft(client,userId,tenantId,factoryId,p,v,dto.expected_version);
      await client.query('DELETE FROM product_bom_lines WHERE tenant_id=$1 AND factory_id=$2 AND product_id=$3 AND product_version_id=$4',[tenantId,factoryId,p,v]);
      const saved:QueryResultRow[]=[];
      for(const x of lines) {
        const r=await client.query(`INSERT INTO product_bom_lines(tenant_id,factory_id,product_id,product_version_id,
          line_number,component_item_id,quantity_per,unit,wastage_percent,alternate_group_code,notes,created_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9::numeric,$10,$11,$12)
          RETURNING id::text AS id,line_number,component_item_id::text AS component_item_id,quantity_per::text AS quantity_per,
            unit,wastage_percent::text AS wastage_percent,alternate_group_code,notes`,
          [tenantId,factoryId,p,v,x.line,x.item,x.qty,x.unit,x.wastage,x.group,x.notes,userId]);
        if(r.rows[0]) saved.push(r.rows[0]);
      }
      await this.outbox(client,{tenantId,factoryId,type:'PRODUCT_VERSION',id:v,event:'PRODUCT.BOM_REPLACED',correlation,requestId,userId,payload:{product_id:p,product_version_id:v,row_version:rowVersion,line_count:saved.length}});
      return {row_version:rowVersion,lines:saved};
    });
    await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_BOM_REPLACED',resource:'PRODUCT_VERSION',id:v,requestId,traceId,payload:{productId:p,lineCount:result.lines.length,rowVersion:result.row_version}});
    return result;
  }

  async replaceRouting(userId:string,tenantId:string,factoryId:string,productId:string,versionId:string,dto:ReplaceProductRoutingDto,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(versionId,'versionId');
    if(!Number.isInteger(dto.expected_version)||dto.expected_version<1) throw new BadRequestException('expected_version must be a positive integer');
    if(!Array.isArray(dto.steps)||dto.steps.length<1||dto.steps.length>200) throw new BadRequestException('Routing must contain between 1 and 200 steps');
    const steps=dto.steps.map((x,i)=>{
      const setup=this.decimal(x.setup_minutes??0,`steps[${i}].setup_minutes`,4,0,99999999),
        run=this.decimal(x.run_minutes_per_unit??0,`steps[${i}].run_minutes_per_unit`,4,0,99999999),
        queue=this.decimal(x.queue_minutes??0,`steps[${i}].queue_minutes`,4,0,99999999),
        transfer=this.decimal(x.transfer_minutes??0,`steps[${i}].transfer_minutes`,4,0,99999999);
      if(Number(setup)+Number(run)+Number(queue)+Number(transfer)<=0) throw new BadRequestException(`steps[${i}] must define a positive operation duration`);
      return {step:x.step_number,code:this.text(x.operation_code,`steps[${i}].operation_code`,100),name:this.text(x.operation_name,`steps[${i}].operation_name`,255),
        wc:this.normUuid(x.work_centre_id,`steps[${i}].work_centre_id`),setup,run,queue,transfer,skill:x.required_skill?.trim()||null,
        instructions:x.instructions?.trim()||null,quality:x.is_quality_gate??false};
    });
    this.uniqueNumbers(steps.map(x=>x.step),'Routing step_number values must be unique');
    const p=productId.toLowerCase(),v=versionId.toLowerCase(),correlation=this.correlation(requestId,traceId);
    const result=await this.database.transaction({tenantId,userId},async client=>{
      await this.lockDraft(client,tenantId,factoryId,p,v,dto.expected_version);
      const ids=[...new Set(steps.map(x=>x.wc))];
      const valid=await client.query<{id:string}>(`SELECT id::text AS id FROM manufacturing_work_centres
        WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' AND id=ANY($3::uuid[])`,[tenantId,factoryId,ids]);
      if(valid.rows.length!==ids.length) throw new BadRequestException('Routing steps must reference active work centres in the same factory');
      const rowVersion=await this.bumpDraft(client,userId,tenantId,factoryId,p,v,dto.expected_version);
      await client.query('DELETE FROM product_routing_steps WHERE tenant_id=$1 AND factory_id=$2 AND product_id=$3 AND product_version_id=$4',[tenantId,factoryId,p,v]);
      const saved:QueryResultRow[]=[];
      for(const x of steps) {
        const r=await client.query(`INSERT INTO product_routing_steps(tenant_id,factory_id,product_id,product_version_id,step_number,
          operation_code,operation_name,work_centre_id,setup_minutes,run_minutes_per_unit,queue_minutes,transfer_minutes,
          required_skill,instructions,is_quality_gate,created_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11::numeric,$12::numeric,$13,$14,$15,$16)
          RETURNING id::text AS id,step_number,operation_code,operation_name,work_centre_id::text AS work_centre_id,
          setup_minutes::text AS setup_minutes,run_minutes_per_unit::text AS run_minutes_per_unit,
          queue_minutes::text AS queue_minutes,transfer_minutes::text AS transfer_minutes,required_skill,instructions,is_quality_gate`,
          [tenantId,factoryId,p,v,x.step,x.code,x.name,x.wc,x.setup,x.run,x.queue,x.transfer,x.skill,x.instructions,x.quality,userId]);
        if(r.rows[0]) saved.push(r.rows[0]);
      }
      await this.outbox(client,{tenantId,factoryId,type:'PRODUCT_VERSION',id:v,event:'PRODUCT.ROUTING_REPLACED',correlation,requestId,userId,payload:{product_id:p,product_version_id:v,row_version:rowVersion,step_count:saved.length}});
      return {row_version:rowVersion,steps:saved};
    });
    await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_ROUTING_REPLACED',resource:'PRODUCT_VERSION',id:v,requestId,traceId,payload:{productId:p,stepCount:result.steps.length,rowVersion:result.row_version}});
    return result;
  }

  async createAlternate(userId:string,tenantId:string,factoryId:string,productId:string,versionId:string,lineId:string,dto:CreateProductAlternateDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(versionId,'versionId'); this.uuid(lineId,'lineId');
    if(!Number.isInteger(dto.expected_version)||dto.expected_version<1) throw new BadRequestException('expected_version must be a positive integer');
    const altItem=this.normUuid(dto.alternate_item_id,'alternate_item_id'),factor=this.decimal(dto.conversion_factor,'conversion_factor',6,0.000001,999999999999),
      unit=this.text(dto.unit,'unit',50),rationale=this.text(dto.rationale,'rationale',2000),key=this.key(keyRaw);
    const p=productId.toLowerCase(),v=versionId.toLowerCase(),l=lineId.toLowerCase(),
      hash=this.hash({product_id:p,product_version_id:v,bom_line_id:l,alternate_item_id:altItem,conversion_factor:factor,unit,rationale}),
      correlation=this.correlation(requestId,traceId);
    try {
      const result=await this.database.transaction({tenantId,userId},async client=>{
        await this.lockKey(client,tenantId,factoryId,'alternate',key);
        const old=await client.query<AlternateRow>(`SELECT ${ALTERNATE_COLS} FROM product_bom_alternates
          WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3`,[tenantId,factoryId,key]);
        if(old.rows[0]) {
          if(old.rows[0].request_hash!==hash) throw new ConflictException('Idempotency-Key was reused for a different alternate material');
          const parent=await client.query<{row_version:string}>('SELECT row_version::text AS row_version FROM product_versions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',[v,tenantId,factoryId]);
          return {alternate:old.rows[0],row_version:parent.rows[0]?.row_version??'0',replayed:true};
        }
        await this.lockDraft(client,tenantId,factoryId,p,v,dto.expected_version);
        const item=await client.query<{unit:string;status:string}>(`SELECT unit,status FROM inventory_items
          WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR KEY SHARE`,[altItem,tenantId,factoryId]);
        if(!item.rows[0]||item.rows[0].status!=='ACTIVE') throw new NotFoundException('Active alternate inventory item was not found in this factory');
        await this.assertUnitCompatible(client,tenantId,factoryId,unit,item.rows[0].unit,'Alternate material unit');
        const r=await client.query<AlternateRow>(`INSERT INTO product_bom_alternates(
          tenant_id,factory_id,product_id,product_version_id,bom_line_id,alternate_item_id,conversion_factor,unit,rationale,
          status,idempotency_key,request_hash,created_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,'DRAFT',$10,$11,$12) RETURNING ${ALTERNATE_COLS}`,
          [tenantId,factoryId,p,v,l,altItem,factor,unit,rationale,key,hash,userId]);
        const alternate=r.rows[0]; if(!alternate) throw new Error('PRODUCT_ALTERNATE_INSERT_FAILED');
        const rowVersion=await this.bumpDraft(client,userId,tenantId,factoryId,p,v,dto.expected_version);
        await this.outbox(client,{tenantId,factoryId,type:'PRODUCT_VERSION',id:v,event:'PRODUCT.BOM_ALTERNATE_DRAFT_CREATED',correlation,requestId,userId,
          payload:{product_id:p,product_version_id:v,bom_line_id:l,alternate_id:alternate.id,alternate_item_id:altItem}});
        return {alternate,row_version:rowVersion,replayed:false};
      });
      if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_BOM_ALTERNATE_DRAFT_CREATED',resource:'PRODUCT_BOM_ALTERNATE',id:result.alternate.id,requestId,traceId,payload:{productId:p,productVersionId:v,bomLineId:l,alternateItemId:altItem}});
      return result;
    } catch(e) { this.uniqueConflict(e,'Alternate item or idempotency key already exists'); throw e; }
  }

  async approveAlternate(userId:string,tenantId:string,factoryId:string,productId:string,versionId:string,alternateId:string,dto:ExpectedVersionDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(versionId,'versionId'); this.uuid(alternateId,'alternateId');
    if(!Number.isInteger(dto.expected_version)||dto.expected_version<1) throw new BadRequestException('expected_version must be a positive integer');
    const key=this.key(keyRaw),p=productId.toLowerCase(),v=versionId.toLowerCase(),a=alternateId.toLowerCase(),
      hash=this.hash({product_id:p,product_version_id:v,alternate_id:a,expected_version:dto.expected_version}),correlation=this.correlation(requestId,traceId);
    const result=await this.database.transaction({tenantId,userId},async client=>{
      const q=await client.query<AlternateRow>(`SELECT ${ALTERNATE_COLS} FROM product_bom_alternates
        WHERE id=$1 AND product_id=$2 AND product_version_id=$3 AND tenant_id=$4 AND factory_id=$5 FOR UPDATE`,[a,p,v,tenantId,factoryId]);
      const alt=q.rows[0]; if(!alt) throw new NotFoundException('Alternate contract was not found in this product version');
      if(alt.status==='APPROVED'&&alt.approval_idempotency_key===key&&alt.approval_request_hash===hash) {
        const pv=await client.query<{row_version:string}>('SELECT row_version::text AS row_version FROM product_versions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',[v,tenantId,factoryId]);
        return {alternate:alt,row_version:pv.rows[0]?.row_version??'0',replayed:true};
      }
      if(alt.status!=='DRAFT') throw new ConflictException('Only draft alternate contracts may be approved');
      if(alt.created_by_user_id===userId) throw new ConflictException('Alternate material contract must be approved by a different user than its creator');
      await this.lockDraft(client,tenantId,factoryId,p,v,dto.expected_version);
      const u=await client.query<AlternateRow>(`UPDATE product_bom_alternates SET status='APPROVED',approved_by_user_id=$1,approved_at=clock_timestamp(),
        updated_at=clock_timestamp(),approval_idempotency_key=$2,approval_request_hash=$3
        WHERE id=$4 AND product_id=$5 AND product_version_id=$6 AND tenant_id=$7 AND factory_id=$8 AND status='DRAFT'
        RETURNING ${ALTERNATE_COLS}`,[userId,key,hash,a,p,v,tenantId,factoryId]);
      const saved=u.rows[0]; if(!saved) throw new ConflictException('Alternate material contract changed concurrently');
      const rowVersion=await this.bumpDraft(client,userId,tenantId,factoryId,p,v,dto.expected_version);
      await this.outbox(client,{tenantId,factoryId,type:'PRODUCT_VERSION',id:v,event:'PRODUCT.BOM_ALTERNATE_APPROVED',correlation,requestId,userId,payload:{product_id:p,product_version_id:v,alternate_id:a,row_version:rowVersion}});
      return {alternate:saved,row_version:rowVersion,replayed:false};
    });
    if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_BOM_ALTERNATE_APPROVED',resource:'PRODUCT_BOM_ALTERNATE',id:a,requestId,traceId,payload:{productId:p,productVersionId:v,rowVersion:result.row_version}});
    return result;
  }

  async approveVersion(userId:string,tenantId:string,factoryId:string,productId:string,versionId:string,dto:ExpectedVersionDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(versionId,'versionId');
    if(!Number.isInteger(dto.expected_version)||dto.expected_version<1) throw new BadRequestException('expected_version must be a positive integer');
    const key=this.key(keyRaw),p=productId.toLowerCase(),v=versionId.toLowerCase(),
      hash=this.hash({product_id:p,product_version_id:v,expected_version:dto.expected_version}),correlation=this.correlation(requestId,traceId);
    try {
      const result=await this.database.transaction({tenantId,userId},async client=>{
        const q=await client.query<VersionRow>(`SELECT ${VERSION_COLS} FROM product_versions WHERE id=$1 AND product_id=$2
          AND tenant_id=$3 AND factory_id=$4 FOR UPDATE`,[v,p,tenantId,factoryId]);
        const row=q.rows[0]; if(!row) throw new NotFoundException('Product version was not found in this factory');
        if(row.state==='APPROVED'&&row.approval_idempotency_key===key&&row.approval_request_hash===hash) return {version:row,replayed:true};
        if(row.state!=='DRAFT') throw new ConflictException('Only a draft product version can be approved');
        if(row.created_by_user_id===userId) throw new ConflictException('Product version must be approved by a different user than its creator');
        this.expected(row.row_version,dto.expected_version);
        const u=await client.query<VersionRow>(`UPDATE product_versions SET state='APPROVED',row_version=row_version+1,
          updated_by_user_id=$1,updated_at=clock_timestamp(),approved_by_user_id=$1,approved_at=clock_timestamp(),
          approval_idempotency_key=$2,approval_request_hash=$3
          WHERE id=$4 AND product_id=$5 AND tenant_id=$6 AND factory_id=$7 AND state='DRAFT' AND row_version=$8
          RETURNING ${VERSION_COLS}`,[userId,key,hash,v,p,tenantId,factoryId,dto.expected_version]);
        const approved=u.rows[0]; if(!approved) throw new ConflictException('Product version changed concurrently; reload before approving');
        await this.outbox(client,{tenantId,factoryId,type:'PRODUCT_VERSION',id:v,event:'PRODUCT.VERSION_APPROVED',correlation,requestId,userId,
          payload:{product_id:p,product_version_id:v,version_number:approved.version_number,effective_from:approved.effective_from,effective_to:approved.effective_to,row_version:approved.row_version}});
        return {version:approved,replayed:false};
      });
      if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_VERSION_APPROVED',resource:'PRODUCT_VERSION',id:v,requestId,traceId,payload:{productId:p,versionNumber:result.version.version_number,effectiveFrom:result.version.effective_from,effectiveTo:result.version.effective_to}});
      return result;
    } catch(e) {
      if(this.code(e)==='23514') throw new ConflictException(e instanceof Error?e.message:'Product version release controls failed');
      this.uniqueConflict(e,'An approved version already overlaps this effective period'); throw e;
    }
  }

  async retireVersion(userId:string,tenantId:string,factoryId:string,productId:string,versionId:string,dto:ExpectedVersionDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId); this.uuid(productId,'productId'); this.uuid(versionId,'versionId');
    if(!Number.isInteger(dto.expected_version)||dto.expected_version<1) throw new BadRequestException('expected_version must be a positive integer');
    const key=this.key(keyRaw),p=productId.toLowerCase(),v=versionId.toLowerCase(),
      hash=this.hash({product_id:p,product_version_id:v,expected_version:dto.expected_version}),correlation=this.correlation(requestId,traceId);
    const result=await this.database.transaction({tenantId,userId},async client=>{
      const q=await client.query<VersionRow>(`SELECT ${VERSION_COLS} FROM product_versions WHERE id=$1 AND product_id=$2
        AND tenant_id=$3 AND factory_id=$4 FOR UPDATE`,[v,p,tenantId,factoryId]);
      const row=q.rows[0]; if(!row) throw new NotFoundException('Product version was not found in this factory');
      if(row.state==='RETIRED'&&row.retirement_idempotency_key===key&&row.retirement_request_hash===hash) return {version:row,replayed:true};
      if(row.state!=='APPROVED') throw new ConflictException('Only approved product versions may be retired');
      this.expected(row.row_version,dto.expected_version);
      const u=await client.query<VersionRow>(`UPDATE product_versions SET state='RETIRED',row_version=row_version+1,
        updated_by_user_id=$1,updated_at=clock_timestamp(),retirement_idempotency_key=$2,retirement_request_hash=$3
        WHERE id=$4 AND product_id=$5 AND tenant_id=$6 AND factory_id=$7 AND state='APPROVED' AND row_version=$8
        RETURNING ${VERSION_COLS}`,[userId,key,hash,v,p,tenantId,factoryId,dto.expected_version]);
      const retired=u.rows[0]; if(!retired) throw new ConflictException('Product version changed concurrently; reload before retiring');
      await this.outbox(client,{tenantId,factoryId,type:'PRODUCT_VERSION',id:v,event:'PRODUCT.VERSION_RETIRED',correlation,requestId,userId,payload:{product_id:p,product_version_id:v,version_number:retired.version_number,row_version:retired.row_version}});
      return {version:retired,replayed:false};
    });
    if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_VERSION_RETIRED',resource:'PRODUCT_VERSION',id:v,requestId,traceId,payload:{productId:p,versionNumber:result.version.version_number}});
    return result;
  }

  async listWorkCentres(userId:string,tenantId:string,factoryId:string,rawLimit=50):Promise<WorkCentreRow[]> {
    this.scope(userId,tenantId,factoryId);
    const r=await this.database.query<WorkCentreRow>(`SELECT ${WORK_CENTRE_COLS} FROM manufacturing_work_centres
      WHERE tenant_id=$1 AND factory_id=$2 ORDER BY code,id LIMIT $3`,[tenantId,factoryId,this.limit(rawLimit)],{tenantId,userId});
    return r.rows;
  }

  async createWorkCentre(userId:string,tenantId:string,factoryId:string,dto:CreateWorkCentreDto,keyRaw:string|null,requestId:string|null,traceId:string|null) {
    this.scope(userId,tenantId,factoryId);
    const code=this.text(dto.code,'code',100),name=this.text(dto.name,'name',255);
    const capacity=dto.capacity_units_per_hour==null?null:this.decimal(dto.capacity_units_per_hour,'capacity_units_per_hour',4,0.0001,99999999999999);
    const key=this.key(keyRaw),hash=this.hash({code:code.toLowerCase(),name,capacity_units_per_hour:capacity}),correlation=this.correlation(requestId,traceId);
    try {
      const result=await this.database.transaction({tenantId,userId},async client=>{
        await this.lockKey(client,tenantId,factoryId,'work-centre',key);
        const old=await client.query<WorkCentreRow>(`SELECT ${WORK_CENTRE_COLS} FROM manufacturing_work_centres
          WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3`,[tenantId,factoryId,key]);
        if(old.rows[0]) { if(old.rows[0].request_hash!==hash) throw new ConflictException('Idempotency-Key was reused for a different work centre'); return {work_centre:old.rows[0],replayed:true}; }
        const r=await client.query<WorkCentreRow>(`INSERT INTO manufacturing_work_centres(tenant_id,factory_id,code,name,status,capacity_units_per_hour,
          version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id)
          VALUES($1,$2,$3,$4,'ACTIVE',$5::numeric,1,$6,$7,$8,$8) RETURNING ${WORK_CENTRE_COLS}`,
          [tenantId,factoryId,code,name,capacity,key,hash,userId]);
        const wc=r.rows[0]; if(!wc) throw new Error('WORK_CENTRE_INSERT_FAILED');
        await this.outbox(client,{tenantId,factoryId,type:'WORK_CENTRE',id:wc.id,event:'PRODUCT.WORK_CENTRE_CREATED',correlation,requestId,userId,payload:{work_centre_id:wc.id,code,name,capacity_units_per_hour:capacity}});
        return {work_centre:wc,replayed:false};
      });
      if(!result.replayed) await this.auditSafe({tenantId,factoryId,userId,action:'PRODUCT_WORK_CENTRE_CREATED',resource:'MANUFACTURING_WORK_CENTRE',id:result.work_centre.id,requestId,traceId,payload:{code,name,capacityUnitsPerHour:capacity}});
      return result;
    } catch(e) { this.uniqueConflict(e,'Work-centre code or idempotency key already exists in this factory'); throw e; }
  }

  private async assertUnitCompatible(client:PoolClient,tenantId:string,factoryId:string,sourceUnit:string,targetUnit:string,label:string):Promise<void> {
    if(sourceUnit.trim().toUpperCase()===targetUnit.trim().toUpperCase()) return;
    const r=await client.query<{exists:boolean}>(`SELECT EXISTS (
      SELECT 1 FROM uom_conversion_rules r
      JOIN uom_units u_from ON u_from.id=r.from_unit_id AND u_from.tenant_id=r.tenant_id AND u_from.factory_id=r.factory_id
      JOIN uom_units u_to ON u_to.id=r.to_unit_id AND u_to.tenant_id=r.tenant_id AND u_to.factory_id=r.factory_id
      WHERE r.tenant_id=$1 AND r.factory_id=$2 AND r.status='APPROVED'
        AND upper(u_from.unit_code)=upper($3) AND upper(u_to.unit_code)=upper($4)
    ) AS exists`,[tenantId,factoryId,sourceUnit.trim(),targetUnit.trim()]);
    if(!r.rows[0]?.exists) throw new BadRequestException(`${label} must match inventory base unit or have an approved conversion to ${targetUnit}`);
  }

  private async lockDraft(client:PoolClient,tenantId:string,factoryId:string,p:string,v:string,expected:number) {
    const r=await client.query<VersionRow>(`SELECT ${VERSION_COLS} FROM product_versions
      WHERE id=$1 AND product_id=$2 AND tenant_id=$3 AND factory_id=$4 FOR UPDATE`,[v,p,tenantId,factoryId]);
    const row=r.rows[0]; if(!row) throw new NotFoundException('Product version was not found in this factory');
    if(row.state!=='DRAFT') throw new ConflictException('Approved and retired product versions are immutable');
    this.expected(row.row_version,expected); return row;
  }
  private async bumpDraft(client:PoolClient,userId:string,tenantId:string,factoryId:string,p:string,v:string,expected:number):Promise<string> {
    const r=await client.query<{row_version:string}>(`UPDATE product_versions SET row_version=row_version+1,updated_by_user_id=$1,updated_at=clock_timestamp()
      WHERE id=$2 AND product_id=$3 AND tenant_id=$4 AND factory_id=$5 AND state='DRAFT' AND row_version=$6
      RETURNING row_version::text AS row_version`,[userId,v,p,tenantId,factoryId,expected]);
    if(!r.rows[0]) throw new ConflictException('Product version changed concurrently; reload and retry');
    return r.rows[0].row_version;
  }
  private async lockKey(client:PoolClient,tenant:string,factory:string,op:string,key:string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ `product-definitions:${tenant}:${factory}:${op}:${key}` ]);
  }
  private async outbox(client:PoolClient,i:{tenantId:string;factoryId:string;type:string;id:string;event:string;correlation:string;requestId:string|null;userId:string;payload:Record<string,unknown>}) {
    await client.query(`INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,
      occurred_at,correlation_id,causation_id,actor,source,payload)
      VALUES($1,$2,$3,$4,$5,1,clock_timestamp(),$6::uuid,$7::uuid,$8::jsonb,$9::jsonb,$10::jsonb)`,
      [i.tenantId,i.factoryId,i.type,i.id,i.event,i.correlation,i.requestId&&isUUID(i.requestId)?i.requestId:null,
       JSON.stringify({type:'user',id:i.userId}),JSON.stringify({system:'FactoryOS',connector:'product-definitions-service',version:process.env.APP_VERSION??process.env.npm_package_version??'0.1.0'}),JSON.stringify(i.payload)]);
  }
  private async auditSafe(i:{tenantId:string;factoryId:string;userId:string;action:string;resource:string;id:string;requestId:string|null;traceId:string|null;payload:Record<string,unknown>}) {
    try { await this.audit.record({tenantId:i.tenantId,factoryId:i.factoryId,actorUserId:i.userId,eventType:'PRODUCT',action:i.action,
      resourceType:i.resource,resourceId:i.id,requestId:i.requestId&&isUUID(i.requestId)?i.requestId:null,
      correlationId:i.traceId&&isUUID(i.traceId)?i.traceId:null,dataClass:'INTERNAL',payload:i.payload}); } catch { /* transactional outbox retains durable evidence */ }
  }
  private expected(actual:string|number,expected:number) {
    if(Number(actual)!==expected) throw new ConflictException(`Stale product version: expected row version ${expected}, current ${actual}`);
  }
  private key(value:string|null) { const k=value?.trim()??''; if(!k) throw new BadRequestException('Idempotency-Key header is required'); if(k.length>255) throw new BadRequestException('Idempotency-Key must not exceed 255 characters'); return k; }
  private decimal(value:number,field:string,scale:number,min:number,max:number):string {
    if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max) throw new BadRequestException(`${field} must be between ${min} and ${max}`);
    if(Math.abs(value*10**scale-Math.round(value*10**scale))>0.000001) throw new BadRequestException(`${field} must have at most ${scale} decimal places`);
    return value.toFixed(scale);
  }
  private date(value:string,field:string):string {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${field} must use YYYY-MM-DD format`);
    const d=new Date(`${value}T00:00:00.000Z`); if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value) throw new BadRequestException(`${field} must be a valid calendar date`); return value;
  }
  private text(value:string,field:string,max:number):string { if(typeof value!=='string') throw new BadRequestException(`${field} is required`); const s=value.trim(); if(!s||s.length>max) throw new BadRequestException(`${field} must contain 1 to ${max} characters`); return s; }
  private scope(u:string,t:string,f:string) { this.uuid(u,'userId'); this.uuid(t,'tenantId'); this.uuid(f,'factoryId'); }
  private uuid(v:string,f:string) { if(!isUUID(v)) throw new BadRequestException(`${f} must be a valid UUID`); }
  private normUuid(v:string,f:string) { this.uuid(v,f); return v.toLowerCase(); }
  private limit(n:number) { if(!Number.isInteger(n)||n<1||n>100) throw new BadRequestException('limit must be an integer between 1 and 100'); return n; }
  private uniqueNumbers(v:number[],message:string) { if(v.some(n=>!Number.isInteger(n)||n<1)||new Set(v).size!==v.length) throw new BadRequestException(message); }
  private correlation(req:string|null,trace:string|null) { if(trace&&isUUID(trace)) return trace; if(req&&isUUID(req)) return req; return randomUUID(); }
  private hash(v:Record<string,unknown>) { return createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
  private code(e:unknown) { return typeof e==='object'&&e!==null&&'code' in e?String((e as {code:unknown}).code):undefined; }
  private uniqueConflict(e:unknown,message:string) { if(this.code(e)==='23505') throw new ConflictException(message); }
}
