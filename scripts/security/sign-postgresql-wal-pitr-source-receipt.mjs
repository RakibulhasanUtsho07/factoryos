#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
const SOURCE_KINDS = new Set(['POSTGRESQL_CLUSTER_CATALOG','WAL_ARCHIVE_DESTINATION_CATALOG','WAL_SEGMENT_CATALOG','WAL_WRITER_PRINCIPAL_CATALOG','WAL_REPLICATION_PATH_CATALOG','PITR_RESTORE_PATH_CATALOG']);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000, MAX_CLOCK_SKEW_MS = 5 * 60 * 1000, MAX_INPUT_BYTES = 1024 * 1024;
function usage(){throw new Error('Usage: node scripts/security/sign-postgresql-wal-pitr-source-receipt.mjs --receipt <source-receipt.json> --private-key-file <collector-ed25519-private.pem>');}
function argumentsMap(argv){
 const result=new Map();
 for(let i=0;i<argv.length;i+=2){const name=argv[i],value=argv[i+1];if(!name?.startsWith('--')||!value||result.has(name))usage();result.set(name,value);}
 if(result.size!==2||!result.has('--receipt')||!result.has('--private-key-file'))usage();return result;
}
function readRegularFile(path,label){const m=lstatSync(path);if(!m.isFile()||m.isSymbolicLink()||m.size<1||m.size>MAX_INPUT_BYTES)throw new Error(label+' must be a regular, non-empty file no larger than 1 MiB');return readFileSync(path);}
function requiredReference(value,field){if(typeof value!=='string'||!SAFE_REFERENCE.test(value)||value.includes('://')||/(secret|password|credential|access[-_]?key|token)/i.test(value))throw new Error(field+' must be a non-secret opaque reference');return value;}
function timestamp(value,field,now){if(typeof value!=='string'||!value.trim())throw new Error(field+' must be a canonical ISO-8601 UTC timestamp');const p=Date.parse(value);if(!Number.isFinite(p)||new Date(p).toISOString()!==value||p>now+MAX_CLOCK_SKEW_MS||p<now-MAX_AGE_MS)throw new Error(field+' must be current and no more than 30 days old');return p;}
function canonicalClaims(r){return JSON.stringify({schema:'factoryos.postgresql-wal-pitr-source-receipt/v1',attestationKeyId:r.attestation_key_id,attestationOwnerReference:r.attestation_owner_reference,tenantId:r.tenant_id.toLowerCase(),categoryCode:r.category_code,copyClassCode:'POSTGRESQL_WAL_PITR',inventoryId:r.inventory_id.toLowerCase(),sourceKind:r.source_kind,sourceReference:r.source_reference,collectionRunReference:r.collection_run_reference,status:r.status,paginationExhausted:r.pagination_exhausted,pagesFetched:r.pages_fetched,itemCount:r.item_count,resultSha256:r.result_sha256,scopeSha256:r.scope_sha256,startedAt:r.started_at,completedAt:r.completed_at});}
function validateReceipt(r){
 if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('Source receipt must be a JSON object');
 if(typeof r.tenant_id!=='string'||!UUID.test(r.tenant_id)||typeof r.inventory_id!=='string'||!UUID.test(r.inventory_id))throw new Error('tenant_id and inventory_id must be UUIDs');
 if(typeof r.category_code!=='string'||! /^[A-Z][A-Z0-9_]{1,63}$/.test(r.category_code))throw new Error('category_code is invalid');
 if(typeof r.source_kind!=='string'||!SOURCE_KINDS.has(r.source_kind))throw new Error('source_kind is not in the PostgreSQL WAL/PITR source catalog');
 requiredReference(r.source_reference,'source_reference');requiredReference(r.collection_run_reference,'collection_run_reference');
 if(r.status!=='COMPLETE'||r.pagination_exhausted!==true)throw new Error('Only COMPLETE receipts with pagination_exhausted=true may be signed');
 if(!Number.isSafeInteger(r.pages_fetched)||r.pages_fetched<1||r.pages_fetched>100000||!Number.isSafeInteger(r.item_count)||r.item_count<0)throw new Error('pages_fetched and item_count are outside supported bounds');
 if(!SHA256.test(r.result_sha256)||!SHA256.test(r.scope_sha256))throw new Error('result_sha256 and scope_sha256 must be lowercase SHA-256 digests');
 if(typeof r.attestation_key_id!=='string'||!KEY_ID.test(r.attestation_key_id))throw new Error('attestation_key_id is invalid');
 requiredReference(r.attestation_owner_reference,'attestation_owner_reference');
 const now=Date.now(),start=timestamp(r.started_at,'started_at',now),end=timestamp(r.completed_at,'completed_at',now);
 if(end<start)throw new Error('completed_at cannot precede started_at');
 if('attestation_signature' in r)throw new Error('Remove attestation_signature before signing a new source receipt');
}
function main(){
 const args=argumentsMap(process.argv.slice(2)),bytes=readRegularFile(args.get('--receipt'),'--receipt');let receipt;
 try{receipt=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('--receipt must contain valid JSON');}
 validateReceipt(receipt);const key=createPrivateKey(readRegularFile(args.get('--private-key-file'),'--private-key-file').toString('utf8'));
 if(key.asymmetricKeyType!=='ed25519')throw new Error('Source receipt signing key must be Ed25519');
 const signature=sign(null,Buffer.from(canonicalClaims(receipt),'utf8'),key).toString('base64url');
 process.stdout.write(JSON.stringify({...receipt,attestation_signature:signature},null,2)+'\n');
}
try{main();}catch(error){process.stderr.write('PostgreSQL WAL/PITR source receipt refused: '+(error instanceof Error?error.message:'unknown error')+'\n');process.exitCode=1;}
