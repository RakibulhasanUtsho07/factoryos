import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { REQUIRED_BACKUP_COPY_CLASSES } from './backup-copy-class-coverage.constants';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { CreateSaasBackupCopyClassCoverageDto } from './dto/create-saas-backup-copy-class-coverage.dto';
import { ReviewSaasBackupCopyClassCoverageDto } from './dto/review-saas-backup-copy-class-coverage.dto';

type CoverageStatus='PENDING'|'ACCEPTED'|'REJECTED';
type CoverageDisposition='SUPPORTED'|'NOT_APPLICABLE'|'UNRESOLVED';
interface CoverageRow extends QueryResultRow {
 decision_id:string; tenant_id:string; category_code:SaasTransferDatasetCategory;
 copy_class_code:(typeof REQUIRED_BACKUP_COPY_CLASSES)[number]; revision:string|number;
 disposition:CoverageDisposition; evidence_reference:string; evidence_sha256:string;
 evidence_at:string|Date; data_owner_reference:string; infrastructure_owner_reference:string;
 policy_reference:string; reason:string; status:CoverageStatus; idempotency_key:string;
 request_hash:string; submitted_by_user_id:string; reviewed_by_user_id:string|null;
 review_reason:string|null; submitted_at:string|Date; reviewed_at:string|Date|null; valid_until:string|Date|null;
}
const SAFE_REFERENCE=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const EVIDENCE_MAX_AGE_MS=30*24*60*60*1000;
const MAX_CLOCK_SKEW_MS=5*60*1000;

@Injectable()
export class SaasTenantBackupCopyClassCoverageService {
 constructor(private readonly database:DatabaseService,private readonly iamService:IamService,private readonly auditService:AuditService){}
 async createDecision(tenantValue:string,actorValue:string,input:CreateSaasBackupCopyClassCoverageDto){
  const tenantId=this.uuid(tenantValue,'tenantId'),actorUserId=this.uuid(actorValue,'actorUserId');
  await this.iamService.authorize(actorUserId,tenantId,'saas.data_retention.write');
  const category=this.category(input?.category_code),copyClass=input?.copy_class_code,disposition=input?.disposition;
  if(!REQUIRED_BACKUP_COPY_CLASSES.includes(copyClass))throw new BadRequestException('copy_class_code is invalid');
  if(!['SUPPORTED','NOT_APPLICABLE','UNRESOLVED'].includes(disposition))throw new BadRequestException('disposition is invalid');
  const evidenceReference=this.reference(input?.evidence_reference,'evidence_reference');
  const evidenceSha256=this.digest(input?.evidence_sha256,'evidence_sha256');
  const evidenceAt=new Date(input?.evidence_at??'');
  if(!Number.isFinite(evidenceAt.getTime()))throw new BadRequestException('evidence_at must be a valid timestamp');
  const age=Date.now()-evidenceAt.getTime();
  if(age < -MAX_CLOCK_SKEW_MS||age>EVIDENCE_MAX_AGE_MS)throw new BadRequestException('backup copy-class evidence must be no more than 30 days old and cannot be from the future');
  const dataOwnerReference=this.reference(input?.data_owner_reference,'data_owner_reference');
  const infrastructureOwnerReference=this.reference(input?.infrastructure_owner_reference,'infrastructure_owner_reference');
  const policyReference=this.reference(input?.policy_reference,'policy_reference');
  const reason=this.requiredString(input?.reason,'reason',1000,3),idempotencyKey=this.idempotencyKey(input?.idempotency_key);
  const requestHash=this.hash({operation:'BACKUP_COPY_CLASS_COVERAGE',category,copyClass,disposition,evidenceReference,
    evidenceSha256,evidenceAt:evidenceAt.toISOString(),dataOwnerReference,infrastructureOwnerReference,policyReference,reason});
  const result=await this.database.transaction(async(client)=>{
   await this.lockTenant(client,tenantId);
   const replay=await client.query<CoverageRow>(
    'SELECT * FROM public.saas_tenant_backup_copy_class_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 AND copy_class_code=$3 AND idempotency_key=$4 FOR UPDATE',
    [tenantId,category,copyClass,idempotencyKey]);
   if(replay.rows[0]){
    if(replay.rows[0].request_hash!==requestHash)throw new ConflictException('Idempotency-Key was reused for a different backup copy-class decision');
    return {row:replay.rows[0],replayed:true};
   }
   const latestResult=await client.query<CoverageRow>(
    'SELECT * FROM public.saas_tenant_backup_copy_class_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 AND copy_class_code=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
    [tenantId,category,copyClass]);
   const latest=latestResult.rows[0];
   if(latest?.status==='PENDING')throw new ConflictException('The latest backup copy-class decision is awaiting independent review');
   const revision=Number(latest?.revision??0)+1;
   if(!Number.isSafeInteger(revision)||revision<1)throw new ConflictException('Backup copy-class revision is outside supported bounds');
   const decisionId=randomUUID();
   const inserted=await client.query<CoverageRow>(
    "INSERT INTO public.saas_tenant_backup_copy_class_coverage_decisions (decision_id,tenant_id,category_code,copy_class_code,revision,disposition,evidence_reference,evidence_sha256,evidence_at,data_owner_reference,infrastructure_owner_reference,policy_reference,reason,status,idempotency_key,request_hash,submitted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',$14,$15,$16) RETURNING *",
    [decisionId,tenantId,category,copyClass,revision,disposition,evidenceReference,evidenceSha256,evidenceAt.toISOString(),
     dataOwnerReference,infrastructureOwnerReference,policyReference,reason,idempotencyKey,requestHash,actorUserId]);
   await this.auditService.recordWithClient(client,{tenantId,factoryId:null,actorUserId,eventType:'SAAS_DATA_GOVERNANCE',
    action:'BACKUP_COPY_CLASS_COVERAGE_SUBMITTED',resourceType:'SAAS_BACKUP_COPY_CLASS_COVERAGE',resourceId:decisionId,
    correlationId:null,requestId:null,dataClass:'RESTRICTED',
    payload:{category,copyClass,disposition,revision,evidenceReference,evidenceSha256,evidenceAt:evidenceAt.toISOString(),
      dataOwnerReference,infrastructureOwnerReference,policyReference}});
   return {row:inserted.rows[0]!,replayed:false};
  },{tenantId,userId:actorUserId,advisoryLockKey:'saas-backup-copy-class-coverage:'+tenantId+':'+category+':'+copyClass});
  return {decision:this.map(result.row),replayed:result.replayed};
 }
 async reviewDecision(tenantValue:string,actorValue:string,decisionValue:string,input:ReviewSaasBackupCopyClassCoverageDto){
  const tenantId=this.uuid(tenantValue,'tenantId'),actorUserId=this.uuid(actorValue,'actorUserId'),decisionId=this.uuid(decisionValue,'decisionId');
  await this.iamService.authorize(actorUserId,tenantId,'saas.data_retention.approve');
  if(input?.decision!=='ACCEPT'&&input?.decision!=='REJECT')throw new BadRequestException('decision must be ACCEPT or REJECT');
  const reviewReason=this.requiredString(input?.reason,'reason',1000,3);
  const result=await this.database.transaction(async(client)=>{
   await this.lockTenant(client,tenantId);
   const found=await client.query<CoverageRow>('SELECT * FROM public.saas_tenant_backup_copy_class_coverage_decisions WHERE tenant_id=$1 AND decision_id=$2 FOR UPDATE',[tenantId,decisionId]);
   const current=found.rows[0];
   if(!current)throw new NotFoundException('Backup copy-class decision not found');
   if(current.status!=='PENDING')throw new ConflictException('Only pending backup copy-class decisions can be reviewed');
   if(current.submitted_by_user_id===actorUserId)throw new ConflictException('Backup copy-class submission and review require different actors');
   const latest=await client.query<{decision_id:string}>(
    'SELECT decision_id FROM public.saas_tenant_backup_copy_class_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 AND copy_class_code=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
    [tenantId,current.category_code,current.copy_class_code]);
   if(latest.rows[0]?.decision_id!==current.decision_id)throw new ConflictException('A newer backup copy-class revision exists; reload before review');
   const age=Date.now()-new Date(current.evidence_at).getTime();
   if(age < -MAX_CLOCK_SKEW_MS||age>EVIDENCE_MAX_AGE_MS)throw new ConflictException('Backup copy-class evidence expired before review');
   const status:CoverageStatus=input.decision==='ACCEPT'?'ACCEPTED':'REJECTED';
   const validUntil=status==='ACCEPTED'?new Date(Date.now()+89*24*60*60*1000).toISOString():null;
   const updated=await client.query<CoverageRow>(
    "UPDATE public.saas_tenant_backup_copy_class_coverage_decisions SET status=$3,reviewed_by_user_id=$4,review_reason=$5,reviewed_at=clock_timestamp(),valid_until=$6 WHERE tenant_id=$1 AND decision_id=$2 AND status='PENDING' RETURNING *",
    [tenantId,decisionId,status,actorUserId,reviewReason,validUntil]);
   if(!updated.rows[0])throw new ConflictException('Backup copy-class decision changed during review');
   await this.auditService.recordWithClient(client,{tenantId,factoryId:null,actorUserId,eventType:'SAAS_DATA_GOVERNANCE',
    action:'BACKUP_COPY_CLASS_COVERAGE_'+status,resourceType:'SAAS_BACKUP_COPY_CLASS_COVERAGE',resourceId:decisionId,
    correlationId:null,requestId:null,dataClass:'RESTRICTED',
    payload:{category:current.category_code,copyClass:current.copy_class_code,disposition:current.disposition,
      revision:Number(current.revision),status,validUntil,evidenceSha256:current.evidence_sha256}});
   return updated.rows[0]!;
  },{tenantId,userId:actorUserId,advisoryLockKey:'saas-backup-copy-class-review:'+tenantId+':'+decisionId});
  return {decision:this.map(result)};
 }
 async listCurrent(tenantValue:string,actorValue:string,categoryValue:string){
  const tenantId=this.uuid(tenantValue,'tenantId'),actorUserId=this.uuid(actorValue,'actorUserId');
  await this.iamService.authorize(actorUserId,tenantId,'saas.data_retention.read');
  const category=this.category(categoryValue);
  const result=await this.database.query<CoverageRow>(
   'SELECT DISTINCT ON (category_code,copy_class_code) * FROM public.saas_tenant_backup_copy_class_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 ORDER BY category_code,copy_class_code,revision DESC',
   [tenantId,category],{tenantId,userId:actorUserId});
  const items=result.rows.map(row=>this.map(row));
  return {items,count:items.length,expectedCopyClasses:REQUIRED_BACKUP_COPY_CLASSES};
 }
 private map(row:CoverageRow){
  return {decisionId:row.decision_id,categoryCode:row.category_code,copyClassCode:row.copy_class_code,
   revision:Number(row.revision),disposition:row.disposition,status:row.status,evidenceReference:row.evidence_reference,
   evidenceSha256:row.evidence_sha256,evidenceAt:new Date(row.evidence_at).toISOString(),
   dataOwnerReference:row.data_owner_reference,infrastructureOwnerReference:row.infrastructure_owner_reference,
   policyReference:row.policy_reference,reason:row.reason,submittedByUserId:row.submitted_by_user_id,
   reviewedByUserId:row.reviewed_by_user_id,reviewReason:row.review_reason,
   submittedAt:new Date(row.submitted_at).toISOString(),reviewedAt:row.reviewed_at?new Date(row.reviewed_at).toISOString():null,
   validUntil:row.valid_until?new Date(row.valid_until).toISOString():null};
 }
 private category(value:unknown):SaasTransferDatasetCategory{
  if(typeof value!=='string'||!Object.values(SaasTransferDatasetCategory).includes(value as SaasTransferDatasetCategory))throw new BadRequestException('category_code is invalid');
  return value as SaasTransferDatasetCategory;
 }
 private reference(value:unknown,name:string):string{
  if(typeof value!=='string'||!SAFE_REFERENCE.test(value)||value.includes('://')||/(secret|password|credential|access[-_]?key|token)/i.test(value))throw new BadRequestException(name+' must be a non-secret opaque reference');
  return value;
 }
 private digest(value:unknown,name:string):string{
  if(typeof value!=='string'||!DIGEST.test(value))throw new BadRequestException(name+' must be a lowercase SHA-256 digest');return value;
 }
 private requiredString(value:unknown,name:string,maximum:number,minimum:number):string{
  if(typeof value!=='string'||value.trim().length<minimum||value.trim().length>maximum)throw new BadRequestException(name+' has an invalid length');return value.trim();
 }
 private idempotencyKey(value:unknown):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))throw new BadRequestException('idempotency_key is invalid');return value;
 }
 private uuid(value:unknown,name:string):string{
  if(typeof value!=='string'||!isUUID(value))throw new BadRequestException(name+' must be a UUID');return value.toLowerCase();
 }
 private hash(value:unknown):string{return createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');}
 private async lockTenant(client:PoolClient,tenantId:string){
  const result=await client.query<{id:string}>('SELECT id::text AS id FROM public.tenants WHERE id=$1::uuid FOR UPDATE',[tenantId]);
  if(!result.rows[0])throw new NotFoundException('Tenant not found');
 }
}
