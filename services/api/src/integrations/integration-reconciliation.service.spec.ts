import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IntegrationReconciliationService } from './integration-reconciliation.service';

const scope = {
  userId: '921382b8-e83f-43ab-a576-e3db6a06b70c',
  tenantId: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
  factoryId: '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
};
const caseId = 'fcf4b5b0-2f5e-45ea-a586-efef4f7b2486';

describe('IntegrationReconciliationService', () => {
  function harness(currentVersion = 1, currentStatus = 'OPEN') {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const clientQuery = jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT id::text AS id,status,row_version,domain,case_type')) {
        return {
          rows: [{ id: caseId, status: currentStatus, row_version: currentVersion, domain: 'PRODUCTION', case_type: 'MISSING_SEQUENCE_RANGE' }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE integration_reconciliation_cases')) {
        return {
          rows: [{
            id: caseId,
            domain: 'PRODUCTION',
            case_type: 'MISSING_SEQUENCE_RANGE',
            status: 'RESOLVED',
            severity: 'ERROR',
            row_version: currentVersion + 1,
            resolved_by_user_id: scope.userId,
            resolved_at: '2026-10-18T10:00:00.000Z',
            resolution_reason: 'Verified and replayed missing event',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery } as unknown as PoolClient;
    const database = {
      query: jest.fn(),
      transaction: jest.fn(async (callback: (client: PoolClient) => Promise<unknown>) => callback(client)),
    };
    return {
      service: new IntegrationReconciliationService(database as never),
      database,
      calls,
      clientQuery,
    };
  }

  it('requires an ordered, valid reporting window and canonical domain filter', async () => {
    const h = harness();
    await expect(h.service.report(scope, {
      since: '2026-10-18T10:00:00Z',
      until: '2026-10-18T09:00:00Z',
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.report(scope, { domain: 'FINANCE' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.database.transaction).not.toHaveBeenCalled();
  });

  it('uses optimistic row-version checks before a manual case resolution', async () => {
    const h = harness(3);
    await expect(h.service.decideCase(scope, caseId, {
      action: 'RESOLVE',
      expected_version: 2,
      reason: 'Reviewed against the source system and accepted',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(h.calls.some((call) => call.sql.includes('UPDATE integration_reconciliation_cases'))).toBe(false);
  });

  it('records a reasoned decision only when status and expected version still match', async () => {
    const h = harness(2);
    const result = await h.service.decideCase(scope, caseId, {
      action: 'RESOLVE',
      expected_version: 2,
      reason: 'Verified the missing event and replayed it',
    });
    expect(result).toEqual(expect.objectContaining({
      id: caseId,
      domain: 'PRODUCTION',
      case_type: 'MISSING_SEQUENCE_RANGE',
      status: 'RESOLVED',
      row_version: 3,
    }));
    const update = h.calls.find((call) => call.sql.includes('UPDATE integration_reconciliation_cases'));
    expect(update?.values).toEqual([
      'RESOLVED',
      scope.userId,
      'Verified the missing event and replayed it',
      caseId,
      scope.tenantId,
      scope.factoryId,
      2,
    ]);
  });

  it('does not let a manually decided case transition a second time', async () => {
    const h = harness(2, 'RESOLVED');
    await expect(h.service.decideCase(scope, caseId, {
      action: 'WAIVE',
      expected_version: 2,
      reason: 'Source owner confirmed a known historical discrepancy',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(h.calls.some((call) => call.sql.includes('UPDATE integration_reconciliation_cases'))).toBe(false);
  });
});
