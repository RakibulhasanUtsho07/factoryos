import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import {
  InventoryCycleCountService,
  type InventoryCycleCountProposal,
} from './inventory.cycle-count.service';
import { InventoryStockReconciliationService } from './inventory.stock-reconciliation.service';

const COUNTER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const REVIEWER_ID = 'b1f89de3-e4aa-41b6-8bc6-d0971f1f8c88';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';

const proposalRow = (blindCountSnapshot: boolean) => ({
  id: '28c3c8e1-c57a-4ea1-9b9d-1a8c4c52c45d',
  tenant_id: TENANT_ID,
  factory_id: FACTORY_ID,
  item_id: ITEM_ID,
  task_id: 'e5d197fe-7a4a-44ce-b3c4-9231289c1897',
  blind_count_snapshot: blindCountSnapshot,
  counted_quantity: '7.0000',
  ledger_quantity_at_count: '12.0000',
  balance_version_at_count: '5',
  location_id: null,
  location_quantity_at_count: null,
  location_version_at_count: null,
  variance_reason_code: null,
  status: 'PENDING_REVIEW' as const,
  idempotency_key: 'count-submit-1',
  request_hash: '0'.repeat(64),
  notes: null,
  created_by_user_id: COUNTER_ID,
  created_at: '2026-10-23T10:00:00.000Z',
  reviewed_by_user_id: null,
  reviewed_at: null,
  review_decision: null,
  review_idempotency_key: null,
  review_request_hash: null,
  review_note: null,
  reconciliation_id: null,
});

describe('InventoryCycleCountService blind-count response protection', () => {
  const query = jest.fn();
  const service = new InventoryCycleCountService(
    { query } as unknown as DatabaseService,
    {} as unknown as AuditService,
    {} as unknown as InventoryStockReconciliationService,
  );

  const mapProposal = (service as unknown as {
    toProposal: (
      row: Record<string, unknown>,
      viewerUserId?: string,
      allowReviewerSnapshotAccess?: boolean,
    ) => InventoryCycleCountProposal;
  }).toProposal;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redacts expected quantities and versions for the counter on blind counts', () => {
    const result = mapProposal.call(service, proposalRow(true), COUNTER_ID, true);

    expect(result.counted_quantity).toBe('7.0000');
    expect(result.ledger_quantity_at_count).toBeNull();
    expect(result.balance_version_at_count).toBeNull();
    expect(result.location_quantity_at_count).toBeNull();
    expect(result.location_version_at_count).toBeNull();
    expect('blind_count_snapshot' in result).toBe(false);
    expect('idempotency_key' in result).toBe(false);
  });

  it('redacts blind snapshots for an ordinary reader who is not the counter', () => {
    const result = mapProposal.call(service, proposalRow(true), REVIEWER_ID);

    expect(result.ledger_quantity_at_count).toBeNull();
    expect(result.balance_version_at_count).toBeNull();
  });

  it('exposes blind snapshots only to an independent reviewer projection', () => {
    const result = mapProposal.call(service, proposalRow(true), REVIEWER_ID, true);

    expect(result.ledger_quantity_at_count).toBe('12.0000');
    expect(result.balance_version_at_count).toBe('5');
  });

  it('redacts the counter even when they hold reviewer access', () => {
    const result = mapProposal.call(service, proposalRow(true), COUNTER_ID, true);

    expect(result.ledger_quantity_at_count).toBeNull();
    expect(result.balance_version_at_count).toBeNull();
  });

  it('keeps public listing redacted and exposes snapshots through the review-only service method', async () => {
    query.mockResolvedValueOnce({ rows: [proposalRow(true)] });

    const ordinaryList = await service.listCycleCounts(
      REVIEWER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
    );

    expect(ordinaryList[0]?.ledger_quantity_at_count).toBeNull();
    expect(ordinaryList[0]?.balance_version_at_count).toBeNull();

    query.mockResolvedValueOnce({ rows: [proposalRow(true)] });

    const reviewList = await service.listCycleCountsForReview(
      REVIEWER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
    );

    expect(reviewList[0]?.ledger_quantity_at_count).toBe('12.0000');
    expect(reviewList[0]?.balance_version_at_count).toBe('5');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves expected snapshots for non-blind counts on the ordinary list', async () => {
    query.mockResolvedValueOnce({ rows: [proposalRow(false)] });

    const result = await service.listCycleCounts(
      COUNTER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
    );

    expect(result[0]?.ledger_quantity_at_count).toBe('12.0000');
    expect(result[0]?.balance_version_at_count).toBe('5');
  });
});
