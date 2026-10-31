import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SaasTenantExternalCopyCoverageService } from './saas-tenant-external-copy-coverage.service';
const tenant='26000000-0000-4000-8000-000000000001';
const submitter='26010000-0000-4000-8000-000000000001';
const reviewer='26010000-0000-4000-8000-000000000002';
const decisionId='26020000-0000-4000-8000-000000000001';
describe('SaasTenantExternalCopyCoverageService',()=>{
 const clientQuery=jest.fn<(...args:unknown[])=>Promise<{rows:unknown[]}>>();
 const database={query:jest.fn<(...args:unknown[])=>Promise<{rows:unknown[]}>>(),transaction:jest.fn<(...args:unknown[])=>Promise<unknown>>()};
 const iam={authorize:jest.fn<(...args:unknown[])=>Promise<void>>()};
 const audit={recordWithClient:jest.fn<(...args:unknown[])=>Promise<string>>()};
 const evidenceReader={verifyArtifact:jest.fn<(...args:unknown[])=>Promise<{reference:string;sha256:string;sizeBytes:number}>>()};
 let service:SaasTenantExternalCopyCoverageService;
 beforeEach(()=>{
  jest.resetAllMocks();iam.authorize.mockResolvedValue(undefined);audit.recordWithClient.mockResolvedValue('audit-event');
  evidenceReader.verifyArtifact.mockImplementation(async(reference,sha256)=>({reference:String(reference),sha256:String(sha256),sizeBytes:42}));
  database.transaction.mockImplementation(async(...args:unknown[])=>{
   const callback=args[0] as ((client:unknown)=>Promise<unknown>)|undefined;
   if(!callback)throw new Error('transaction callback is required');
   return callback({query:clientQuery} as never);
  });
  service=new SaasTenantExternalCopyCoverageService(database as never,iam as never,audit as never,evidenceReader as never);
 });
 it('rejects stale evidence before opening a transaction',async()=>{
  await expect(service.createDecision(tenant,submitter,{
   category_code:'BUSINESS_DATA',store_kind:'BACKUP',disposition:'NOT_APPLICABLE',
   evidence_reference:'evidence.copy-inventory.v1',evidence_sha256:'a'.repeat(64),
   evidence_at:new Date(Date.now()-31*24*60*60*1000).toISOString(),data_owner_reference:'owner.data.v1',
   infrastructure_owner_reference:'owner.infra.v1',policy_reference:'policy.retention.v1',
   reason:'Scope not applicable for this tenant',idempotency_key:'coverage-stale-v1',
  })).rejects.toBeInstanceOf(BadRequestException);
  expect(database.transaction).not.toHaveBeenCalled();
 });
 it('requires a reviewer separate from the submitter',async()=>{
  const evidenceAt=new Date().toISOString();
  clientQuery.mockImplementation(async(...args:unknown[])=>{
   const sql=String(args[0]);
   if(sql.includes('FROM public.tenants'))return {rows:[{id:tenant}]};
   if(sql.includes('WHERE tenant_id=$1 AND decision_id=$2 FOR UPDATE'))return {rows:[{
    decision_id:decisionId,tenant_id:tenant,category_code:'BUSINESS_DATA',store_kind:'BACKUP',revision:1,
    disposition:'NOT_APPLICABLE',evidence_reference:'evidence.copy-inventory.v1',evidence_sha256:'a'.repeat(64),
    evidence_at:evidenceAt,data_owner_reference:'owner.data.v1',infrastructure_owner_reference:'owner.infra.v1',
    policy_reference:'policy.retention.v1',reason:'Scoped not applicable',status:'PENDING',idempotency_key:'coverage-v1',
    request_hash:'b'.repeat(64),submitted_by_user_id:reviewer,reviewed_by_user_id:null,review_reason:null,
    submitted_at:new Date().toISOString(),reviewed_at:null,valid_until:null,
   }]};
   throw new Error('unexpected SQL: '+sql);
  });
  await expect(service.reviewDecision(tenant,reviewer,decisionId,{decision:'ACCEPT',reason:'Independent review completed'}))
   .rejects.toBeInstanceOf(ConflictException);
  expect(audit.recordWithClient).not.toHaveBeenCalled();
 });

 it('rejects unsigned external copy-coverage evidence before persistence',async()=>{
  await expect(service.createDecision(tenant,submitter,{
   category_code:'BUSINESS_DATA',store_kind:'BACKUP',disposition:'NOT_APPLICABLE',
   evidence_reference:'evidence.copy-inventory.v1',evidence_sha256:'a'.repeat(64),
   evidence_at:new Date().toISOString(),data_owner_reference:'owner.data.v1',
   infrastructure_owner_reference:'owner.infra.v1',policy_reference:'policy.retention.v1',
   reason:'No matching copies were found',idempotency_key:'coverage-unsigned-v1',
  } as never)).rejects.toBeInstanceOf(BadRequestException);
  expect(database.transaction).not.toHaveBeenCalled();
  expect(evidenceReader.verifyArtifact).not.toHaveBeenCalled();
 });

 it('rejects path-like evidence identifiers before reading an artifact',async()=>{
  await expect(service.createDecision(tenant,submitter,{
   category_code:'BUSINESS_DATA',store_kind:'BACKUP',disposition:'UNRESOLVED',
   evidence_reference:'../outside',evidence_sha256:'a'.repeat(64),
   evidence_at:new Date().toISOString(),data_owner_reference:'owner.data.v1',
   infrastructure_owner_reference:'owner.infra.v1',policy_reference:'policy.retention.v1',
   reason:'The provider inventory is incomplete',idempotency_key:'coverage-path-v1',
   attestation_key_id:'external-copy-key-v1',attestation_owner_reference:'owner.infra.v1',
   attestation_signature:'A'.repeat(86),
  } as never)).rejects.toBeInstanceOf(BadRequestException);
  expect(evidenceReader.verifyArtifact).not.toHaveBeenCalled();
 });
});
