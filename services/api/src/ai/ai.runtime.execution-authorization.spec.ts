import { jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { AiRuntimeService } from './ai.runtime.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const actionId = '6f1a6666-6666-4666-8666-666666666666';
const decisionId = '6f1a7777-7777-4777-8777-777777777777';
const approvalId = '6f1a8888-8888-4888-8888-888888888888';
const claimId = '6f1a9999-9999-4999-8999-999999999999';
const actionToken = 'approved-ai-action-token';
const executionKey = 'approval-expiry-test-key';
const payloadHash = createHash('sha256').update('{}', 'utf8').digest('hex');

function canonicalHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

const actionIntent = {
  id: actionId,
  tenant_id: tenantId,
  factory_id: factoryId,
  decision_id: decisionId,
  action_type: 'AI.RUNTIME.NOOP',
  tool_id: 'AI.RUNTIME.NOOP',
  tool_version: '1.0.0',
  target: {},
  resource_type: 'AUTHORIZATION_TEST',
  resource_id: 'resource-1',
  payload: {},
  payload_hash: payloadHash,
  risk_class: 'L0',
  authorization_status: 'AUTHORIZED',
  authorization: { approvalId },
  approval_id: approvalId,
  action_token_hash: canonicalHash(actionToken),
  token_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  idempotency_key: null,
  created_by: userId,
  created_at: new Date().toISOString(),
};

const claim = {
  id: claimId,
  tenant_id: tenantId,
  factory_id: factoryId,
  action_intent_id: actionId,
  execution_key: executionKey,
  tool_version: '1.0.0',
  inputs_hash: payloadHash,
  status: 'CLAIMED',
  failure_code: null,
  claimed_at: new Date().toISOString(),
  completed_at: null,
};

const databaseQueryMock = jest.fn<
  (sql: string, values?: unknown[], context?: unknown) => Promise<{ rows: QueryResultRow[] }>
>();
const transactionQueryMock = jest.fn<
  (sql: string, values?: unknown[]) => Promise<{ rows: QueryResultRow[] }>
>();
const databaseTransactionMock = jest.fn(
  async (
    callback: (client: { query: typeof transactionQueryMock }) => Promise<unknown>,
  ) => callback({ query: transactionQueryMock }),
);
const authorizeMock = jest.fn(async () => undefined);
const auditRecordMock = jest.fn(async () => 'audit-event-id');
const gatewayExecuteMock = jest.fn(async () => ({ status: 'SUCCEEDED' }));

const database = {
  query: databaseQueryMock,
  transaction: databaseTransactionMock,
};

let service: AiRuntimeService;

describe('AiRuntimeService action execution authorization', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    databaseQueryMock.mockResolvedValue({ rows: [] });
    transactionQueryMock.mockResolvedValue({ rows: [] });
    databaseTransactionMock.mockImplementation(
      async (
        callback: (client: { query: typeof transactionQueryMock }) => Promise<unknown>,
      ) => callback({ query: transactionQueryMock }),
    );
    authorizeMock.mockResolvedValue(undefined);
    auditRecordMock.mockResolvedValue('audit-event-id');
    gatewayExecuteMock.mockResolvedValue({ status: 'SUCCEEDED' });

    service = new AiRuntimeService(
      database as never,
      { record: auditRecordMock } as never,
      { authorize: authorizeMock } as never,
      {} as never,
      {} as never,
      {} as never,
      { execute: gatewayExecuteMock } as never,
    );
  });

  function mockActionAndEmptyExecutionLookups() {
    databaseQueryMock
      .mockResolvedValueOnce({ rows: [actionIntent as unknown as QueryResultRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it('rejects an expired or no-longer-approved approval before reserving an execution claim', async () => {
    mockActionAndEmptyExecutionLookups();
    databaseQueryMock.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.executeAction(tenantId, factoryId, userId, {
        action_token: actionToken,
        execution_key: executionKey,
        tool_version: '1.0.0',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const approvalQuery = String(databaseQueryMock.mock.calls[3]?.[0]);
    expect(approvalQuery).toContain("status = 'APPROVED'");
    expect(approvalQuery).toContain('clock_timestamp()');
    expect(databaseQueryMock).toHaveBeenCalledTimes(4);
    expect(
      databaseQueryMock.mock.calls.some(([sql]) => /INSERT\s+INTO\s+ai_execution_claims/i.test(sql)),
    ).toBe(false);
    expect(gatewayExecuteMock).not.toHaveBeenCalled();
  });

  it('terminalizes the claim without invoking the gateway if approval expires after reservation', async () => {
    mockActionAndEmptyExecutionLookups();
    databaseQueryMock
      .mockResolvedValueOnce({ rows: [{ id: approvalId }] })
      .mockResolvedValueOnce({ rows: [{ id: claimId }] });

    transactionQueryMock
      .mockResolvedValueOnce({ rows: [claim as unknown as QueryResultRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: claimId }] });

    await expect(
      service.executeAction(tenantId, factoryId, userId, {
        action_token: actionToken,
        execution_key: executionKey,
        tool_version: '1.0.0',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const txApprovalQuery = String(transactionQueryMock.mock.calls[1]?.[0]);
    const terminalizeQuery = String(transactionQueryMock.mock.calls[2]?.[0]);
    expect(txApprovalQuery).toContain("status = 'APPROVED'");
    expect(txApprovalQuery).toContain('FOR SHARE');
    expect(txApprovalQuery).toContain('clock_timestamp()');
    expect(terminalizeQuery).toContain("status = 'FAILED'");
    expect(terminalizeQuery).toContain("'APPROVAL_NO_LONGER_VALID'");
    expect(gatewayExecuteMock).not.toHaveBeenCalled();
    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    expect(auditRecordMock.mock.calls[0]?.[0]).toMatchObject({
      action: 'EXECUTE_BLOCKED_APPROVAL_INVALID',
      resourceId: claimId,
    });
  });
});
