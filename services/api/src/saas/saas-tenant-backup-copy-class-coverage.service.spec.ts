import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SaasTenantBackupCopyClassCoverageService } from './saas-tenant-backup-copy-class-coverage.service';
const tenant='28000000-0000-4000-8000-000000000001';
const submitter='28010000-0000-4000-8000-000000000001';
const reviewer='28010000-0000-4000-8000-000000000002';
const decisionId='28020000-0000-4000-8000-000000000001';
describe('SaasTenantBackupCopyClassCoverageService',()=>{
 const clientQuery=jest.fn<(...args:unknown[])=>Promise<{rows:unknown[]}>>();
 const database={query:jest.fn<(...args:unknown[])=>Promise<{rows:unknown[]}>>(),transaction:jest.fn<(...args:unknown[])=>Promise<unknown>>()};
 const iam={authorize:jest.fn<(...args:unknown[])=>Promise<void>>()};
 const audit={recordWithClient:jest.fn<(...args:unknown[])=>Promise<string>>()};
 const evidenceReader={verifyArtifact:jest.fn<(...args:unknown[])=>Promise<{reference:string;sha256:string;sizeBytes:number}>>()};
 let service:SaasTenantBackupCopyClassCoverageService;
 beforeEach(()=>{
  jest.resetAllMocks();iam.authorize.mockResolvedValue(undefined);audit.recordWithClient.mockResolvedValue('audit-event');
  evidenceReader.verifyArtifact.mockImplementation(async(reference,sha256)=>({reference:String(reference),sha256:String(sha256),sizeBytes:42}));
  database.transaction.mockImplementation(async(...args:unknown[])=>{
   const callback=args.find(v=>typeof v==='function') as ((client:unknown)=>Promise<unknown>)|undefined;
   if(!callback)throw new Error('transaction callback is required');
   return callback({query:clientQuery} as never);
  });
  service=new SaasTenantBackupCopyClassCoverageService(database as never,iam as never,audit as never,evidenceReader as never);
 });
 it('rejects evidence older than 30 days',async()=>{
  await expect(service.createDecision(tenant,submitter,{
   category_code:'BUSINESS_DATA',copy_class_code:'POSTGRESQL_WAL_PITR',disposition:'UNRESOLVED',
   evidence_reference:'backup.inventory.wal.v1',evidence_sha256:'a'.repeat(64),
   evidence_at:new Date(Date.now()-31*24*60*60*1000).toISOString(),data_owner_reference:'owner.data.v1',
   infrastructure_owner_reference:'owner.infrastructure.v1',policy_reference:'policy.retention.v1',
   reason:'WAL archive class needs investigation',idempotency_key:'wal-pitr-stale-v1',
  })).rejects.toBeInstanceOf(BadRequestException);
  expect(database.transaction).not.toHaveBeenCalled();
 });
 it('rejects self-review before changing the decision',async()=>{
  clientQuery.mockImplementation(async(...args:unknown[])=>{
   const sql=String(args[0]);
   if(sql.includes('FROM public.tenants'))return {rows:[{id:tenant}]};
   if(sql.includes('WHERE tenant_id=$1 AND decision_id=$2 FOR UPDATE'))return {rows:[{
    decision_id:decisionId,tenant_id:tenant,category_code:'BUSINESS_DATA',copy_class_code:'POSTGRESQL_WAL_PITR',
    revision:1,disposition:'UNRESOLVED',evidence_reference:'backup.inventory.wal.v1',evidence_sha256:'a'.repeat(64),
    evidence_at:new Date().toISOString(),data_owner_reference:'owner.data.v1',infrastructure_owner_reference:'owner.infrastructure.v1',
    policy_reference:'policy.retention.v1',reason:'WAL archive class needs investigation',status:'PENDING',
    idempotency_key:'wal-pitr-v1',request_hash:'b'.repeat(64),submitted_by_user_id:reviewer,reviewed_by_user_id:null,
    review_reason:null,submitted_at:new Date().toISOString(),reviewed_at:null,valid_until:null,
   }]};
   throw new Error('unexpected SQL: '+sql);
  });
  await expect(service.reviewDecision(tenant,reviewer,decisionId,{decision:'ACCEPT',reason:'Independent reviewer required'}))
   .rejects.toBeInstanceOf(ConflictException);
  expect(audit.recordWithClient).not.toHaveBeenCalled();
 });
});
