import { ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { ResearchService } from './research.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const CURRENT_RELEASE_ID = '5f5a38b6-b2c3-4d8b-8c67-2e9251b6cbaa';
const TARGET_RELEASE_ID = '99d2cfe7-cd5e-4488-b495-1e6ea3305e82';
const EVALUATION_ID = 'abf5d790-8e67-4b28-b532-caae46e61927';

const passingReport = {
  sources: [],
  contentFingerprint: 'c'.repeat(64),
  validation: {
    consistencyPassed: true,
    citationCoveragePassed: true,
    rightsPassed: true,
    safetyPassed: true,
  },
};

describe('Research release lifecycle', () => {
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

  it('returns all tenant-scoped versions and append-only lifecycle events for a release key', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ release_key: 'quality-research' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: CURRENT_RELEASE_ID,
          release_key: 'quality-research',
          version: 3,
          active_release_id: CURRENT_RELEASE_ID,
          active_version: 3,
          channel_revision: 4,
          is_active: true,
          currently_eligible: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'da0e4f6a-9f43-4a1f-95bb-bcb93aa7be30',
          release_id: CURRENT_RELEASE_ID,
          release_key: 'quality-research',
          version: 3,
          event_type: 'PROMOTED',
          related_release_id: TARGET_RELEASE_ID,
          related_version: 2,
          reason: 'Reviewed the latest quality evidence bundle.',
          actor_user_id: USER_ID,
          created_at: '2026-10-19T10:00:00.000Z',
        }],
      });

    const history = await service.listReleaseHistory(TENANT_ID, CURRENT_RELEASE_ID);

    expect(history).toMatchObject({
      release_key: 'quality-research',
      active_release_id: CURRENT_RELEASE_ID,
      active_version: 3,
      channel_revision: 4,
    });
    expect(history.versions).toHaveLength(1);
    expect(history.lifecycle_events).toHaveLength(1);
    expect(history.lifecycle_events[0]).toMatchObject({ event_type: 'PROMOTED', version: 3 });
    expect(String(database.query.mock.calls[1][0])).toContain('research_release_channels');
    expect(String(database.query.mock.calls[2][0])).toContain('research_release_lifecycle_events');
    expect(database.query.mock.calls.every(call => call[1][0] === TENANT_ID)).toBe(true);
  });

  it('rejects rollback to a newer version of the same release key before touching the activation channel', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [{
          id: CURRENT_RELEASE_ID,
          release_key: 'quality-research',
          version: 2,
          status: 'PROMOTED',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: TARGET_RELEASE_ID,
          release_key: 'quality-research',
          version: 3,
          status: 'PROMOTED',
          claim_ids: [],
          evaluation_id: EVALUATION_ID,
        }],
      });

    await expect(service.rollbackRelease(
      USER_ID,
      TENANT_ID,
      CURRENT_RELEASE_ID,
      {
        target_release_id: TARGET_RELEASE_ID,
        reason: 'Rollback was requested because the newer bundle failed review.',
      },
      'request-rollback-test',
      'trace-rollback-test',
    )).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('switches the active pointer transactionally and records both sides of a rollback', async () => {
    const validator = service as unknown as {
      validateReleaseClaims: (tenantId: string, claimIds: string[]) => Promise<unknown>;
    };
    jest.spyOn(validator, 'validateReleaseClaims').mockResolvedValue(passingReport);

    database.query
      .mockResolvedValueOnce({
        rows: [{
          id: CURRENT_RELEASE_ID,
          release_key: 'quality-research',
          version: 3,
          status: 'PROMOTED',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: TARGET_RELEASE_ID,
          release_key: 'quality-research',
          version: 2,
          status: 'PROMOTED',
          claim_ids: ['aa2f63c4-dd22-4f10-bf4d-67f091700001'],
          evaluation_id: EVALUATION_ID,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: EVALUATION_ID,
          status: 'PASSED',
          content_fingerprint: 'c'.repeat(64),
        }],
      });

    client.query
      .mockResolvedValueOnce({
        rows: [{ active_release_id: CURRENT_RELEASE_ID, active_version: 3, revision: 7 }],
      })
      .mockResolvedValueOnce({ rows: [{ id: TARGET_RELEASE_ID }] })
      .mockResolvedValueOnce({ rows: [{ revision: 8 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.rollbackRelease(
      USER_ID,
      TENANT_ID,
      CURRENT_RELEASE_ID,
      {
        target_release_id: TARGET_RELEASE_ID,
        reason: 'Rollback restores the previous version after the current release regression.',
      },
      'request-rollback-success',
      'trace-rollback-success',
    );

    expect(result).toMatchObject({
      from_release_id: CURRENT_RELEASE_ID,
      from_version: 3,
      active_release_id: TARGET_RELEASE_ID,
      active_version: 2,
      channel_revision: 8,
    });
    expect(String(client.query.mock.calls[2][0])).toContain('UPDATE research_release_channels');
    expect(String(client.query.mock.calls[3][0])).toContain('ROLLBACK_FROM');
    expect(String(client.query.mock.calls[4][0])).toContain('ROLLBACK_TO');
    expect(client.query.mock.calls[5][1][4]).toBe('RESEARCH.RELEASE_ROLLED_BACK');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'RELEASE_ROLLBACK',
      resourceId: CURRENT_RELEASE_ID,
    }));
  });
});
