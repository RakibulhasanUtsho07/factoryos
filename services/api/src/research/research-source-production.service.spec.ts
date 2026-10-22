import { ConflictException, ForbiddenException } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { PoolClient } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { ResearchSourceAdapterService } from './research-source-adapters';
import { ResearchSourceProductionService } from './research-source-production.service';
import { parseResearchDocument } from './research-source-document-parser';

type Row = Record<string, any>;
type QueryResult = { rows: Row[] };
type Query = (sql: string, values?: unknown[]) => Promise<QueryResult>;

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const SOURCE_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const DOCUMENT_ID = 'd9b271a1-1674-4a2f-b8cd-9b6c9f700001';
const DUPLICATE_ID = 'e2c4c7ea-e4ce-40a5-a930-05bcce700001';

describe('ResearchSourceProductionService', () => {
  let service: ResearchSourceProductionService;
  let client: { query: jest.MockedFunction<Query> };
  let database: {
    transaction: ReturnType<typeof jest.fn>;
    query: jest.MockedFunction<Query>;
  };
  let audit: { recordWithClient: ReturnType<typeof jest.fn> };
  let responses: QueryResult[];

  const approvedCustomerSource = (overrides: Row = {}): Row => ({
    id: SOURCE_ID,
    source_type: 'CUSTOMER_PROVIDED',
    source_revision: 1,
    rights_version: 1,
    license_status: 'USER_PROVIDED_AUTHORIZED',
    access_status: 'APPROVED',
    rights_basis: 'Customer authorization allows storage and processing of the submitted evidence.',
    full_text_storage_allowed: true,
    ...overrides,
  });

  const documentRow = (id = DOCUMENT_ID, overrides: Row = {}): Row => ({
    id,
    source_id: SOURCE_ID,
    source_revision: 1,
    rights_version: 1,
    original_filename: 'evidence.txt',
    media_type: 'text/plain',
    byte_size: 36,
    content_sha256: 'a'.repeat(64),
    extracted_text_sha256: 'b'.repeat(64),
    normalized_text_sha256: 'c'.repeat(64),
    parser_version: 'factoryos-text-parser.v1',
    duplicate_of_document_id: null,
    similarity_score: 0,
    storage_status: 'STORED',
    created_by: USER_ID,
    created_at: '2026-10-22T10:00:00.000Z',
    purged_at: null,
    purge_reason: null,
    ...overrides,
  });

  const setResponses = (...items: QueryResult[]) => {
    responses = [...items];
    client.query.mockImplementation(async () => responses.shift() ?? { rows: [] });
  };

  const sourceLookup = (source = approvedCustomerSource()): QueryResult => ({ rows: [source] });
  const noIdempotentReplay = (): QueryResult => ({ rows: [] });
  const noDuplicates = (): QueryResult => ({ rows: [] });
  const emptyResult = (): QueryResult => ({ rows: [] });

  beforeEach(() => {
    responses = [];
    client = { query: jest.fn<Query>() };
    database = {
      transaction: jest.fn(async (context: unknown, callback: unknown) => {
        if (typeof callback !== 'function') throw new Error('transaction callback missing');
        return (callback as (clientArg: PoolClient) => Promise<unknown>)(client as unknown as PoolClient);
      }),
      query: jest.fn<Query>(),
    };
    audit = { recordWithClient: jest.fn() };
    service = new ResearchSourceProductionService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
      new ResearchSourceAdapterService(),
    );
  });

  it('persists original bytes and extracted text only for a rights-approved customer source', async () => {
    const fileBytes = Buffer.from('Textile quality evidence, inspected on line 4.', 'utf8');
    const file = {
      buffer: fileBytes,
      originalname: '../../evidence.txt',
      mimetype: 'text/plain',
      size: fileBytes.length,
    };
    setResponses(
      sourceLookup(),
      noIdempotentReplay(),
      noDuplicates(),
      { rows: [documentRow(DOCUMENT_ID, {
        byte_size: fileBytes.length,
        content_sha256: parseResearchDocument(fileBytes, 'text/plain').contentSha256,
        extracted_text_sha256: parseResearchDocument(fileBytes, 'text/plain').extractedTextSha256,
      })] },
      emptyResult(),
    );
    audit.recordWithClient.mockResolvedValue(undefined);

    const result = await service.uploadDocument(
      USER_ID,TENANT_ID,SOURCE_ID,'customer-file-001',file,null,null,
    );

    expect(result).toMatchObject({
      idempotentReplay: false,
      document: {
        id: DOCUMENT_ID,
        source_id: SOURCE_ID,
        original_filename: 'evidence.txt',
        media_type: 'text/plain',
        storage_status: 'STORED',
      },
    });
    expect(String(client.query.mock.calls[3][0])).toContain('INSERT INTO research_source_documents');
    expect(String(client.query.mock.calls[4][0])).toContain('INSERT INTO research_source_document_content');
    expect(client.query.mock.calls[4][1]?.[2]).toEqual(fileBytes);
    expect(client.query.mock.calls[4][1]?.[3]).toBe('Textile quality evidence, inspected on line 4.');
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.objectContaining({
      action: 'RESEARCH_SOURCE_DOCUMENT_UPLOADED',
      resourceType: 'RESEARCH_SOURCE_DOCUMENT',
    }));
  });

  it('rejects a customer-file upload when full-text rights are missing', async () => {
    const fileBytes = Buffer.from('Restricted document text', 'utf8');
    setResponses(sourceLookup(approvedCustomerSource({ full_text_storage_allowed: false })));

    await expect(service.uploadDocument(
      USER_ID,TENANT_ID,SOURCE_ID,'customer-file-002',{
        buffer:fileBytes,originalname:'restricted.txt',mimetype:'text/plain',size:fileBytes.length,
      },null,null,
    )).rejects.toBeInstanceOf(ForbiddenException);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('returns the original upload for an identical idempotency-key replay without writing content twice', async () => {
    const fileBytes = Buffer.from('Stable customer evidence for idempotent ingestion.', 'utf8');
    const file = { buffer:fileBytes,originalname:'evidence.txt',mimetype:'text/plain',size:fileBytes.length };
    const parsed = parseResearchDocument(fileBytes,'text/plain');
    setResponses(
      sourceLookup(),noIdempotentReplay(),noDuplicates(),
      { rows:[documentRow(DOCUMENT_ID,{
        byte_size:fileBytes.length,
        content_sha256:parsed.contentSha256,
        extracted_text_sha256:parsed.extractedTextSha256,
        normalized_text_sha256:parsed.normalizedTextSha256,
      })] },
      emptyResult(),
    );
    audit.recordWithClient.mockResolvedValue(undefined);

    await service.uploadDocument(USER_ID,TENANT_ID,SOURCE_ID,'same-key',file,null,null);
    const requestHash = String(client.query.mock.calls[3][1]?.[5]);
    client.query.mockClear();
    setResponses(
      sourceLookup(),
      { rows:[{
        id:DOCUMENT_ID,
        request_hash:requestHash,
        storage_status:'STORED',
        content_sha256:parsed.contentSha256,
        normalized_text_sha256:parsed.normalizedTextSha256,
        duplicate_of_document_id:null,
        similarity_score:0,
        source_revision:1,
        rights_version:1,
      }] },
    );

    const replay = await service.uploadDocument(USER_ID,TENANT_ID,SOURCE_ID,'same-key',file,null,null);

    expect(replay).toMatchObject({ idempotentReplay:true, document:{id:DOCUMENT_ID} });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });

  it('rejects an idempotency key reused for different file bytes', async () => {
    const fileA = Buffer.from('First authorized source evidence.', 'utf8');
    const parsedA = parseResearchDocument(fileA,'text/plain');
    const fileB = Buffer.from('Different authorized source evidence.', 'utf8');
    setResponses(
      sourceLookup(),
      { rows:[{
        id:DOCUMENT_ID,
        request_hash:'f'.repeat(64),
        storage_status:'STORED',
        content_sha256:parsedA.contentSha256,
        normalized_text_sha256:parsedA.normalizedTextSha256,
        source_revision:1,
        rights_version:1,
      }] },
    );

    await expect(service.uploadDocument(
      USER_ID,TENANT_ID,SOURCE_ID,'reused-key',{
        buffer:fileB,originalname:'evidence.txt',mimetype:'text/plain',size:fileB.length,
      },null,null,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('links a high-similarity upload as a duplicate candidate without auto-merging the records', async () => {
    const fileBytes = Buffer.from('Same source document text for duplicate candidate review.', 'utf8');
    const parsed = parseResearchDocument(fileBytes,'text/plain');
    setResponses(
      sourceLookup(),
      noIdempotentReplay(),
      { rows:[{
        id:DOCUMENT_ID,
        content_sha256:parsed.contentSha256,
        normalized_text_sha256:parsed.normalizedTextSha256,
        text_signature:parsed.textSignature,
      }] },
      { rows:[documentRow(DUPLICATE_ID,{
        byte_size:fileBytes.length,
        content_sha256:parsed.contentSha256,
        extracted_text_sha256:parsed.extractedTextSha256,
        normalized_text_sha256:parsed.normalizedTextSha256,
        duplicate_of_document_id:DOCUMENT_ID,
        similarity_score:1,
      })] },
      emptyResult(),
    );
    audit.recordWithClient.mockResolvedValue(undefined);

    const result = await service.uploadDocument(USER_ID,TENANT_ID,SOURCE_ID,'duplicate-key',{
      buffer:fileBytes,originalname:'another-name.txt',mimetype:'text/plain',size:fileBytes.length,
    },null,null);

    expect(result).toMatchObject({
      idempotentReplay:false,
      duplicateCandidate:{id:DOCUMENT_ID,similarity:1},
      document:{id:DUPLICATE_ID,duplicate_of_document_id:DOCUMENT_ID,similarity_score:1},
    });
    expect(result.duplicatePolicy).toContain('not automatically merged');
    expect(String(client.query.mock.calls[3][0])).toContain('INSERT INTO research_source_documents');
    expect(String(client.query.mock.calls[4][0])).toContain('INSERT INTO research_source_document_content');
  });
});
