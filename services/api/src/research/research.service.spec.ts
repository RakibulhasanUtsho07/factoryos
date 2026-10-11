import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { ResearchService } from './research.service';
import { CreateResearchSourceDto } from './dto/create-research-source.dto';
import { CreateResearchClaimDto } from './dto/create-research-claim.dto';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const SOURCE_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const CLAIM_ID = '5f5a38b6-b2c3-4d8b-8c67-2e9251b6cbaa';

describe('ResearchService', () => {
  let service: ResearchService;
  let client: { query: ReturnType<typeof jest.fn> };
  let database: {
    transaction: ReturnType<typeof jest.fn>;
    query: ReturnType<typeof jest.fn>;
  };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn(async (first: unknown, second?: unknown) => {
        const callback = typeof first === 'function' ? first : second;
        if (typeof callback !== 'function') throw new Error('transaction callback missing');
        return (callback as (clientArg: typeof client) => Promise<unknown>)(client);
      }),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue('audit-id') };
    service = new ResearchService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('fails closed when full-text retention is requested without explicit rights', async () => {
    const dto = {
      source_type: 'CUSTOMER_PROVIDED',
      title: 'Restricted factory report',
      source_url: 'https://example.org/report',
      license_status: 'UNKNOWN',
      full_text_storage_allowed: true,
    } as CreateResearchSourceDto;

    await expect(service.createSource(USER_ID, TENANT_ID, dto, null, null))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires explicit customer authorization before registering a customer file', async () => {
    const dto = {
      source_type: 'CUSTOMER_PROVIDED',
      title: 'Factory report',
      source_url: 'https://example.org/report',
      license_status: 'OPEN_ACCESS',
      rights_basis: 'Public webpage',
    } as CreateResearchSourceDto;

    await expect(service.createSource(USER_ID, TENANT_ID, dto, null, null))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('will not create an evidence excerpt from a source whose rights do not permit storage', async () => {
    database.query.mockResolvedValueOnce({ rows: [{ full_text_storage_allowed: false }] });
    const dto = {
      claim_text: 'A claim derived from a published source.',
      evidence_grade: 'B',
      provenance_ref: { section: 'Results' },
      stored_excerpt: 'Copied source passage',
    } as CreateResearchClaimDto;

    await expect(service.createClaim(USER_ID, TENANT_ID, SOURCE_ID, dto, null, null))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('refuses to draft a knowledge release with claims that are not approved and visible', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.createRelease(
      USER_ID, TENANT_ID,
      {
        release_key: 'sector-textile', version: 1, title: 'Textile research bundle',
        claim_ids: [CLAIM_ID], evidence_grade: 'B',
      },
      null, null,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a source locator to be present before a release can be validated', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        id: CLAIM_ID, tenant_id: TENANT_ID, namespace: 'TENANT', source_id: SOURCE_ID,
        claim_text: 'A reviewable research statement.', methodology: null,
        dataset_description: null, limitations: null, practical_implication: null,
        evidence_grade: 'B', evidence_strength: 'MODERATE', topic_tags: ['quality'],
        provenance_ref: {}, status: 'APPROVED', source_title: 'Research Paper',
        source_url: 'https://example.org/paper', doi: null,
        license_status: 'OPEN_ACCESS', access_status: 'APPROVED',
      }],
    });

    await expect(service.createRelease(
      USER_ID, TENANT_ID,
      {
        release_key: 'quality-bundle', version: 1, title: 'Quality evidence',
        claim_ids: [CLAIM_ID], evidence_grade: 'B',
      },
      null, null,
    )).rejects.toBeInstanceOf(ConflictException);
  });
});
