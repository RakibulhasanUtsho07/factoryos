import { jest } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { QueryResultRow } from 'pg';

import { AiRuntimeService } from './ai.runtime.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const claimId = '6f1aeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const reconciliationId = '6f1affff-ffff-4fff-8fff-ffffffffffff';

const databaseQueryMock = jest.fn<
  (text: string, values?: unknown[]) => Promise<{ rows: QueryResultRow[] }>
>();
const authorizeMock = jest.fn(async () => undefined);

const database = { query: databaseQueryMock };
const auditService = { record: jest.fn(async () => 'audit-event-id') };
const iamService = { authorize: authorizeMock };
const gatewayExecuteMock = jest.fn(async () => ({ status: 'SUCCEEDED' }));
const aiToolGateway = { execute: gatewayExecuteMock };

let service: AiRuntimeService;

const staleClaim = (overrides: Record<string, unknown> = {}) => ({
  id: claimId,
  action_intent_id: '6f1a6666-6666-4666-8666-666666666666',
  execution_key: 'execution-key-1',
  tool_version: '1.0.0',
  inputs_hash: 'a'.repeat(64),
  status: 'CLAIMED',
  claimed_at: '2026-10-01T00:00:00.000Z',
  is_stale: true,
  execution_record_status: null,
  record_execution_key: null,
  record_tool_version: null,
  record_inputs_hash: null,
  ...overrides,
});

const reconciliationInput = {
  decision: 'CONFIRMED_FAILED' as const,
  reason: 'Incident investigation confirmed no successful completion.',
  evidence_ref: 'INC-1042',
};

describe('AiRuntimeService execution-claim recovery', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    authorizeMock.mockResolvedValue(undefined);
    service = new AiRuntimeService(
      database as never,
      auditService as never,
      iamService as never,
      {} as never,
      {} as never,
      {} as never,
      aiToolGateway as never,
    );
  });

  it('lists only stale claims and explicitly says automatic retry is disabled', async () => {
    databaseQueryMock.mockResolvedValueOnce({
      rows: [
        {
          ...staleClaim(),
          age_minutes: 72.5,
          has_execution_record: false,
          execution_record_status: null,
        },
      ],
    });

    const result = await service.listStaleExecutionClaims(
      tenantId,
      factoryId,
      userId,
      20,
    );

    expect(authorizeMock).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.execution.claims.read',
      factoryId,
    );
    expect(databaseQueryMock.mock.calls[0]?.[0]).toContain("c.status = 'CLAIMED'");
    expect(databaseQueryMock.mock.calls[0]?.[0]).toContain("INTERVAL '5 minutes'");
    expect(databaseQueryMock.mock.calls[0]?.[1]).toEqual([tenantId, factoryId, 20]);
    expect(result).toMatchObject({
      staleAfterMinutes: 5,
      automaticRetryAllowed: false,
      items: [
        {
          id: claimId,
          ageMinutes: 72.5,
          hasExecutionRecord: false,
          automaticRetryAllowed: false,
        },
      ],
    });
  });

  it('rejects reconciliation before a claim is five minutes old', async () => {
    databaseQueryMock.mockResolvedValueOnce({
      rows: [staleClaim({ is_stale: false })],
    });

    await expect(
      service.reconcileExecutionClaim(
        tenantId,
        factoryId,
        userId,
        claimId,
        reconciliationInput,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(databaseQueryMock).toHaveBeenCalledTimes(1);
    expect(gatewayExecuteMock).not.toHaveBeenCalled();
  });

  it('rejects a decision that conflicts with an existing execution record', async () => {
    databaseQueryMock.mockResolvedValueOnce({
      rows: [
        staleClaim({
          execution_record_status: 'SUCCEEDED',
          record_execution_key: 'execution-key-1',
          record_tool_version: '1.0.0',
          record_inputs_hash: 'a'.repeat(64),
        }),
      ],
    });

    await expect(
      service.reconcileExecutionClaim(
        tenantId,
        factoryId,
        userId,
        claimId,
        reconciliationInput,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(databaseQueryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an execution record whose immutable binding differs from the claim', async () => {
    databaseQueryMock.mockResolvedValueOnce({
      rows: [
        staleClaim({
          execution_record_status: 'FAILED',
          record_execution_key: 'different-key',
          record_tool_version: '1.0.0',
          record_inputs_hash: 'a'.repeat(64),
        }),
      ],
    });

    await expect(
      service.reconcileExecutionClaim(
        tenantId,
        factoryId,
        userId,
        claimId,
        reconciliationInput,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(databaseQueryMock).toHaveBeenCalledTimes(1);
  });

  it('atomically terminalizes a stale claim and writes reconciliation plus audit records', async () => {
    databaseQueryMock.mockResolvedValueOnce({ rows: [staleClaim()] });
    databaseQueryMock.mockResolvedValueOnce({
      rows: [
        {
          reconciliation_id: reconciliationId,
          claim_id: claimId,
          decision: 'CONFIRMED_FAILED',
          resulting_status: 'FAILED',
          reconciled_at: '2026-10-08T12:00:00.000Z',
          evidence_ref: 'INC-1042',
        },
      ],
    });

    const result = await service.reconcileExecutionClaim(
      tenantId,
      factoryId,
      userId,
      claimId,
      reconciliationInput,
    );

    expect(authorizeMock).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.execution.claims.reconcile',
      factoryId,
    );
    const writeSql = String(databaseQueryMock.mock.calls[1]?.[0]);
    expect(writeSql).toContain('FOR UPDATE');
    expect(writeSql).toContain('UPDATE ai_execution_claims');
    expect(writeSql).toContain('INSERT INTO ai_execution_claim_reconciliations');
    expect(writeSql).toContain('INSERT INTO audit_events');
    expect(databaseQueryMock.mock.calls[1]?.[1]).toEqual([
      claimId,
      tenantId,
      factoryId,
      userId,
      'CONFIRMED_FAILED',
      reconciliationInput.reason,
      reconciliationInput.evidence_ref,
    ]);
    expect(result).toEqual({
      reconciliationId,
      claimId,
      decision: 'CONFIRMED_FAILED',
      resultingStatus: 'FAILED',
      reconciledAt: '2026-10-08T12:00:00.000Z',
      evidenceRef: 'INC-1042',
      existingExecutionRecordStatus: null,
      automaticRetryAllowed: false,
    });
  });

  it('fails closed if another reconciler wins the atomic update', async () => {
    databaseQueryMock.mockResolvedValueOnce({ rows: [staleClaim()] });
    databaseQueryMock.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.reconcileExecutionClaim(
        tenantId,
        factoryId,
        userId,
        claimId,
        reconciliationInput,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(databaseQueryMock).toHaveBeenCalledTimes(2);
  });

  it('does not disclose or operate on claims outside the caller factory scope', async () => {
    databaseQueryMock.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.reconcileExecutionClaim(
        tenantId,
        factoryId,
        userId,
        claimId,
        reconciliationInput,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(databaseQueryMock.mock.calls[0]?.[1]).toEqual([claimId, tenantId, factoryId]);
  });
});
