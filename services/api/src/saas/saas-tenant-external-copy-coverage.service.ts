import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { EXTERNAL_COPY_COVERAGE_STORE_KINDS, UNCLASSIFIED_EXTERNAL_STORE_KIND } from './saas-tenant-propagation.adapters';
import { BackupCopyClassEvidenceArtifactReader } from './backup-copy-class-evidence-artifact-reader';
import { validateExternalStoreInventoryManifest } from './external-store-inventory-manifest';
import { verifyExternalCopyCoverageEvidenceAttestation, type ExternalCopyCoverageEvidenceAttestationPayload } from './backup-copy-class-evidence-attestation';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { CreateSaasExternalCopyCoverageDto } from './dto/create-saas-external-copy-coverage.dto';
import { ReviewSaasExternalCopyCoverageDto } from './dto/review-saas-external-copy-coverage.dto';
type CoverageStatus='PENDING'|'ACCEPTED'|'REJECTED';
type CoverageDisposition='SUPPORTED'|'NOT_APPLICABLE'|'UNRESOLVED';
interface CoverageRow extends QueryResultRow {
 decision_id:string; tenant_id:string; category_code:SaasTransferDatasetCategory;
 store_kind:(typeof EXTERNAL_COPY_COVERAGE_STORE_KINDS)[number]; revision:string|number; disposition:CoverageDisposition;
 evidence_reference:string; evidence_sha256:string; evidence_at:string; attestation_key_id:string|null;
 attestation_owner_reference:string|null; attestation_signature:string|null; data_owner_reference:string;
 infrastructure_owner_reference:string; policy_reference:string; reason:string; status:CoverageStatus;
 idempotency_key:string; request_hash:string; submitted_by_user_id:string; reviewed_by_user_id:string|null;
 review_reason:string|null; submitted_at:string; reviewed_at:string|null; valid_until:string|null;
}
const SAFE_REFERENCE=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const EVIDENCE_MAX_AGE_MS=30*24*60*60*1000;
const MAX_CLOCK_SKEW_MS=5*60*1000;
@Injectable()
export class SaasTenantExternalCopyCoverageService {
 constructor(private readonly database:DatabaseService,private readonly iamService:IamService,private readonly auditService:AuditService,
  private readonly evidenceArtifactReader:BackupCopyClassEvidenceArtifactReader){}
 async createDecision(tenantValue:string,actorValue:string,input:CreateSaasExternalCopyCoverageDto){
  const tenantId=this.uuid(tenantValue,'tenantId'),actorUserId=this.uuid(actorValue,'actorUserId');
  await this.iamService.authorize(actorUserId,tenantId,'saas.data_retention.write');
  const category=this.category(input?.category_code),storeKind=input?.store_kind,disposition=input?.disposition;
  if(!EXTERNAL_COPY_COVERAGE_STORE_KINDS.includes(storeKind))throw new BadRequestException('store_kind is invalid');
  if(!['SUPPORTED','NOT_APPLICABLE','UNRESOLVED'].includes(disposition))throw new BadRequestException('disposition is invalid');
  if(storeKind===UNCLASSIFIED_EXTERNAL_STORE_KIND&&disposition==='SUPPORTED')
   throw new BadRequestException('Unclassified external store coverage cannot be marked SUPPORTED; classify the discovered store and register its dedicated provider adapter');
  const evidenceReference=this.artifactReference(input?.evidence_reference);
  const evidenceSha256=this.digest(input?.evidence_sha256,'evidence_sha256');
  const evidenceAt=new Date(input?.evidence_at??'');
  if(!Number.isFinite(evidenceAt.getTime()))throw new BadRequestException('evidence_at must be a valid timestamp');
  const age=Date.now()-evidenceAt.getTime();
  if(age < -MAX_CLOCK_SKEW_MS||age>EVIDENCE_MAX_AGE_MS)throw new BadRequestException('copy-class evidence must be no more than 30 days old and cannot be from the future');
  const dataOwnerReference=this.reference(input?.data_owner_reference,'data_owner_reference');
  const infrastructureOwnerReference=this.reference(input?.infrastructure_owner_reference,'infrastructure_owner_reference');
  const attestationKeyId=this.keyId(input?.attestation_key_id);
  const attestationOwnerReference=this.reference(input?.attestation_owner_reference,'attestation_owner_reference');
  const attestationSignature=this.signature(input?.attestation_signature);
  const policyReference=this.reference(input?.policy_reference,'policy_reference');
  const reason=this.requiredString(input?.reason,'reason',1000,3),idempotencyKey=this.idempotencyKey(input?.idempotency_key);
  const attestation:ExternalCopyCoverageEvidenceAttestationPayload={
   attestationKeyId,attestationOwnerReference,tenantId,categoryCode:category,storeKind,disposition,
   evidenceReference,evidenceSha256,evidenceAt:evidenceAt.toISOString(),dataOwnerReference,
   infrastructureOwnerReference,policyReference,reason,
  };
  verifyExternalCopyCoverageEvidenceAttestation(attestation,attestationSignature);
  if (storeKind === UNCLASSIFIED_EXTERNAL_STORE_KIND && disposition === 'NOT_APPLICABLE') {
   const artifact = await this.evidenceArtifactReader.readVerifiedArtifact(evidenceReference,evidenceSha256);
   try {
    validateExternalStoreInventoryManifest(artifact.bytes,tenantId,category);
   } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    throw new BadRequestException('UNCLASSIFIED_EXTERNAL_STORE NOT_APPLICABLE requires a complete, current, scope-bound external inventory manifest');
   }
  } else {
   await this.evidenceArtifactReader.verifyArtifact(evidenceReference,evidenceSha256);
  }
  const requestHash=this.hash({operation:'EXTERNAL_COPY_COVERAGE',...attestation,attestationSignature});
  const result=await this.database.transaction(async(client)=>{
   await this.lockTenant(client,tenantId);
   const replay=await client.query<CoverageRow>(
    'SELECT * FROM public.saas_tenant_external_copy_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 AND store_kind=$3 AND idempotency_key=$4 FOR UPDATE',
    [tenantId,category,storeKind,idempotencyKey]);
   if(replay.rows[0]){
    if(replay.rows[0].request_hash!==requestHash)throw new ConflictException('Idempotency-Key was reused for a different copy-class coverage decision');
    return {row:replay.rows[0],replayed:true};
   }
   const latestResult=await client.query<CoverageRow>(
    'SELECT * FROM public.saas_tenant_external_copy_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 AND store_kind=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
    [tenantId,category,storeKind]);
   const latest=latestResult.rows[0];
   if(latest?.status==='PENDING')throw new ConflictException('The latest copy-class coverage decision is awaiting independent review');
   const revision=Number(latest?.revision??0)+1;
   if(!Number.isSafeInteger(revision)||revision<1)throw new ConflictException('Copy-class coverage revision is outside supported bounds');
   const decisionId=randomUUID();
   const inserted=await client.query<CoverageRow>(
    "INSERT INTO public.saas_tenant_external_copy_coverage_decisions (decision_id,tenant_id,category_code,store_kind,revision,disposition,evidence_reference,evidence_sha256,evidence_at,attestation_key_id,attestation_owner_reference,attestation_signature,data_owner_reference,infrastructure_owner_reference,policy_reference,reason,status,idempotency_key,request_hash,submitted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'PENDING',$17,$18,$19) RETURNING *",
    [decisionId,tenantId,category,storeKind,revision,disposition,evidenceReference,evidenceSha256,evidenceAt.toISOString(),
     attestationKeyId,attestationOwnerReference,attestationSignature,dataOwnerReference,infrastructureOwnerReference,policyReference,reason,idempotencyKey,requestHash,actorUserId]);
   await this.auditService.recordWithClient(client,{tenantId,factoryId:null,actorUserId,eventType:'SAAS_DATA_GOVERNANCE',
    action:'EXTERNAL_COPY_COVERAGE_SUBMITTED',resourceType:'SAAS_EXTERNAL_COPY_COVERAGE',resourceId:decisionId,correlationId:null,requestId:null,dataClass:'RESTRICTED',
    payload:{category,storeKind,disposition,revision,evidenceReference,evidenceSha256,evidenceAt:evidenceAt.toISOString(),
     attestationKeyId,attestationOwnerReference,attestationSignatureSha256:createHash('sha256').update(attestationSignature).digest('hex'),
     dataOwnerReference,infrastructureOwnerReference,policyReference}});
   return {row:inserted.rows[0]!,replayed:false};
  },{tenantId,userId:actorUserId,advisoryLockKey:'saas-external-copy-coverage:'+tenantId+':'+category+':'+storeKind});
  return {decision:this.map(result.row),replayed:result.replayed};
 }
 async reviewDecision(tenantValue:string,actorValue:string,decisionValue:string,input:ReviewSaasExternalCopyCoverageDto){
  const tenantId=this.uuid(tenantValue,'tenantId'),actorUserId=this.uuid(actorValue,'actorUserId'),decisionId=this.uuid(decisionValue,'decisionId');
  await this.iamService.authorize(actorUserId,tenantId,'saas.data_retention.approve');
  if(input?.decision!=='ACCEPT'&&input?.decision!=='REJECT')throw new BadRequestException('decision must be ACCEPT or REJECT');
  const reviewReason=this.requiredString(input?.reason,'reason',1000,3);
  const result=await this.database.transaction(async(client)=>{
   await this.lockTenant(client,tenantId);
   const found=await client.query<CoverageRow>('SELECT * FROM public.saas_tenant_external_copy_coverage_decisions WHERE tenant_id=$1 AND decision_id=$2 FOR UPDATE',[tenantId,decisionId]);
   const current=found.rows[0];
   if(!current)throw new NotFoundException('External copy-class coverage decision not found');
   if(current.status!=='PENDING')throw new ConflictException('Only pending copy-class coverage decisions can be reviewed');
   if(current.submitted_by_user_id===actorUserId)throw new ConflictException('Copy-class coverage submission and review require different actors');
   const latest=await client.query<{decision_id:string}>(
    'SELECT decision_id FROM public.saas_tenant_external_copy_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 AND store_kind=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
    [tenantId,current.category_code,current.store_kind]);
   if(latest.rows[0]?.decision_id!==current.decision_id)throw new ConflictException('A newer copy-class coverage revision exists; reload before review');
   const age=Date.now()-new Date(current.evidence_at).getTime();
   if(age < -MAX_CLOCK_SKEW_MS||age>EVIDENCE_MAX_AGE_MS)throw new ConflictException('Copy-class evidence expired before review');
   if(input.decision==='ACCEPT'){
    if(!current.attestation_key_id||!current.attestation_owner_reference||!current.attestation_signature)
     throw new ConflictException('Unsigned legacy external copy-coverage evidence cannot be accepted');
    verifyExternalCopyCoverageEvidenceAttestation({
     attestationKeyId:current.attestation_key_id,attestationOwnerReference:current.attestation_owner_reference,
     tenantId:current.tenant_id,categoryCode:current.category_code,storeKind:current.store_kind,disposition:current.disposition,
     evidenceReference:current.evidence_reference,evidenceSha256:current.evidence_sha256,
     evidenceAt:new Date(current.evidence_at).toISOString(),dataOwnerReference:current.data_owner_reference,
     infrastructureOwnerReference:current.infrastructure_owner_reference,policyReference:current.policy_reference,reason:current.reason,
    },current.attestation_signature);
    if (current.store_kind === UNCLASSIFIED_EXTERNAL_STORE_KIND && current.disposition === 'NOT_APPLICABLE') {
     const artifact = await this.evidenceArtifactReader.readVerifiedArtifact(current.evidence_reference,current.evidence_sha256);
     try {
      validateExternalStoreInventoryManifest(artifact.bytes,current.tenant_id,current.category_code);
     } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ConflictException('UNCLASSIFIED_EXTERNAL_STORE cannot be accepted without a complete, current, scope-bound external inventory manifest');
     }
    } else {
     await this.evidenceArtifactReader.verifyArtifact(current.evidence_reference,current.evidence_sha256);
    }
   }
   const status:CoverageStatus=input.decision==='ACCEPT'?'ACCEPTED':'REJECTED';
   const validUntil=status==='ACCEPTED'?new Date(Date.now()+89*24*60*60*1000).toISOString():null;
   const updated=await client.query<CoverageRow>(
    "UPDATE public.saas_tenant_external_copy_coverage_decisions SET status=$3,reviewed_by_user_id=$4,review_reason=$5,reviewed_at=clock_timestamp(),valid_until=$6 WHERE tenant_id=$1 AND decision_id=$2 AND status='PENDING' RETURNING *",
    [tenantId,decisionId,status,actorUserId,reviewReason,validUntil]);
   if(!updated.rows[0])throw new ConflictException('Copy-class coverage changed during review');
   await this.auditService.recordWithClient(client,{tenantId,factoryId:null,actorUserId,eventType:'SAAS_DATA_GOVERNANCE',
    action:'EXTERNAL_COPY_COVERAGE_'+status,resourceType:'SAAS_EXTERNAL_COPY_COVERAGE',resourceId:decisionId,correlationId:null,requestId:null,dataClass:'RESTRICTED',
    payload:{category:current.category_code,storeKind:current.store_kind,disposition:current.disposition,revision:Number(current.revision),status,validUntil,evidenceSha256:current.evidence_sha256}});
   return updated.rows[0]!;
  },{tenantId,userId:actorUserId,advisoryLockKey:'saas-external-copy-coverage-review:'+tenantId+':'+decisionId});
  return {decision:this.map(result)};
 }
 async listCurrent(tenantValue:string,actorValue:string,categoryValue:string){
  const tenantId=this.uuid(tenantValue,'tenantId'),actorUserId=this.uuid(actorValue,'actorUserId');
  await this.iamService.authorize(actorUserId,tenantId,'saas.data_retention.read');
  const category=this.category(categoryValue);
  const result=await this.database.query<CoverageRow>(
   'SELECT DISTINCT ON (category_code,store_kind) * FROM public.saas_tenant_external_copy_coverage_decisions WHERE tenant_id=$1 AND category_code=$2 ORDER BY category_code,store_kind,revision DESC',
   [tenantId,category],{tenantId,userId:actorUserId});
  const items=result.rows.map(row=>this.map(row));
  return {items,count:items.length,expectedStoreKinds:EXTERNAL_COPY_COVERAGE_STORE_KINDS};
 }
 private map(row:CoverageRow){
  return {decisionId:row.decision_id,categoryCode:row.category_code,storeKind:row.store_kind,revision:Number(row.revision),
   disposition:row.disposition,status:row.status,evidenceReference:row.evidence_reference,evidenceSha256:row.evidence_sha256,
   evidenceAt:new Date(row.evidence_at).toISOString(),dataOwnerReference:row.data_owner_reference,infrastructureOwnerReference:row.infrastructure_owner_reference,
   attestationKeyId:row.attestation_key_id,attestationOwnerReference:row.attestation_owner_reference,
   policyReference:row.policy_reference,reason:row.reason,submittedByUserId:row.submitted_by_user_id,reviewedByUserId:row.reviewed_by_user_id,
   reviewReason:row.review_reason,submittedAt:new Date(row.submitted_at).toISOString(),reviewedAt:row.reviewed_at?new Date(row.reviewed_at).toISOString():null,
   validUntil:row.valid_until?new Date(row.valid_until).toISOString():null};
 }
 private category(value:unknown):SaasTransferDatasetCategory{
  if(typeof value!=='string'||!Object.values(SaasTransferDatasetCategory).includes(value as SaasTransferDatasetCategory))throw new BadRequestException('category_code is invalid');
  return value as SaasTransferDatasetCategory;
 }
 private artifactReference(value:unknown):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value))throw new BadRequestException('evidence_reference must be a single opaque artifact identifier, not a path or URL');return value;
 }
 private keyId(value:unknown):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))throw new BadRequestException('attestation_key_id is invalid');return value;
 }
 private signature(value:unknown):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(value))throw new BadRequestException('attestation_signature must be a canonical Ed25519 base64url signature');return value;
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
