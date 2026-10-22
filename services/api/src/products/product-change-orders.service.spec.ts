import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import {
  areProductAffectedOrderSnapshotsEqual,
  ProductChangeOrdersService,
  diffProductRevisionRows,
} from './product-change-orders.service';

const USER = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const PRODUCT = 'a4f159c0-4a80-4b27-b3ac-e5c311fe6cf8';
const REVISION = 'f6530381-74ad-4f2b-b1bd-3126c2c3a4bc';
const ECO = '7ffb7604-2066-4e94-8b9f-7bfb1cbef115';

describe('ProductChangeOrdersService request contracts', () => {
  let service: ProductChangeOrdersService;
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    database = { transaction: jest.fn(), query: jest.fn() };
    audit = { record: jest.fn() };
    service = new ProductChangeOrdersService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('rejects invalid authenticated scope before querying engineering records', async () => {
    await expect(service.list('not-a-user', TENANT, FACTORY, PRODUCT)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key before starting ECO creation', async () => {
    await expect(service.create(
      USER, TENANT, FACTORY, PRODUCT,
      {
        proposed_version_id: REVISION,
        title: 'Change routing step',
        rationale: 'Adjust the operation sequence for revision 3.',
        effective_date: '2027-01-15',
      },
      null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects impossible effective dates before opening a transaction', async () => {
    await expect(service.create(
      USER, TENANT, FACTORY, PRODUCT,
      {
        proposed_version_id: REVISION,
        title: 'Change routing step',
        rationale: 'Adjust the operation sequence for revision 3.',
        effective_date: '2027-02-30',
      },
      'eco-create-1', null, null,
    )).rejects.toThrow('effective_date must be a valid calendar date');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a positive optimistic version for ECO submission', async () => {
    await expect(service.submit(
      USER, TENANT, FACTORY, PRODUCT, ECO,
      { expected_version: 0 }, 'eco-submit-1', null, null,
    )).rejects.toThrow('expected_version must be a positive integer');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a positive optimistic version for ECO review', async () => {
    await expect(service.approve(
      USER, TENANT, FACTORY, PRODUCT, ECO,
      { expected_version: -1 }, 'eco-approve-1', null, null,
    )).rejects.toThrow('expected_version must be a positive integer');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an explicit reason when rejecting a submitted ECO', async () => {
    await expect(service.reject(
      USER, TENANT, FACTORY, PRODUCT, ECO,
      { expected_version: 1, comment: '   ' }, 'eco-reject-1', null, null,
    )).rejects.toThrow('A rejection comment is required');
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe('diffProductRevisionRows', () => {
  it('reports additions, removals and in-place engineering changes separately', () => {
    const before = [
      { line_number: 1, component_item_id: 'raw-a', quantity_per: '2.0000' },
      { line_number: 2, component_item_id: 'raw-b', quantity_per: '1.0000' },
    ];
    const after = [
      { line_number: 1, component_item_id: 'raw-a', quantity_per: '3.0000' },
      { line_number: 3, component_item_id: 'raw-c', quantity_per: '1.0000' },
    ];

    const diff = diffProductRevisionRows(before, after, 'line_number');

    expect(diff.added).toEqual([{ key: '3', after: after[1] }]);
    expect(diff.removed).toEqual([{ key: '2', before: before[1] }]);
    expect(diff.changed).toEqual([{ key: '1', before: before[0], after: after[0] }]);
  });

  it('uses the parent BOM line when comparing authorized alternates with the same item identity', () => {
    const before = [
      { line_number: 1, alternate_item_id: 'alt-a', conversion_factor: '1.000000' },
      { line_number: 2, alternate_item_id: 'alt-a', conversion_factor: '2.000000' },
    ];
    const after = [
      { line_number: 1, alternate_item_id: 'alt-a', conversion_factor: '1.250000' },
      { line_number: 2, alternate_item_id: 'alt-a', conversion_factor: '2.000000' },
    ];

    const diff = diffProductRevisionRows(before, after, 'alternate_item_id', (row) => String(row.line_number));

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({
      key: '1:alt-a',
      before: before[0],
      after: after[0],
    });
  });
});

describe('areProductAffectedOrderSnapshotsEqual', () => {
  const original = {
    id: '4c3bb447-25e3-48bd-b0fd-66f5a9fa9ca3',
    work_order_number: 'WO-1001',
    product_version_id: 'f6530381-74ad-4f2b-b1bd-3126c2c3a4bc',
    status: 'RELEASED',
    planned_start_date: '2027-02-01',
    due_date: '2027-02-15',
    impact_type: 'REVISION_REVIEW_BEFORE_START',
  };

  it('accepts a stable submitted order snapshot', () => {
    expect(areProductAffectedOrderSnapshotsEqual([original], [{ ...original }])).toBe(true);
  });

  it.each([
    ['membership', { ...original, id: 'e49ecb3b-f2cd-48f9-bbb6-1c4b6714c9da' }],
    ['pinned revision', { ...original, product_version_id: 'a8b3cbb9-966a-4f03-8f33-3dcb7e1184d0' }],
    ['work-order status', { ...original, status: 'IN_PROGRESS' }],
    ['planned date', { ...original, planned_start_date: '2027-02-02' }],
    ['due date', { ...original, due_date: '2027-02-16' }],
    ['impact classification', { ...original, impact_type: 'SNAPSHOT_CROSSES_EFFECTIVE_DATE' }],
  ])('rejects a snapshot changed in %s', (_dimension, changed) => {
    expect(areProductAffectedOrderSnapshotsEqual([original], [changed])).toBe(false);
  });

  it('detects orders added or removed after submission', () => {
    const laterOrder = { ...original, id: 'e49ecb3b-f2cd-48f9-bbb6-1c4b6714c9da', work_order_number: 'WO-1002' };
    expect(areProductAffectedOrderSnapshotsEqual([original], [original, laterOrder])).toBe(false);
    expect(areProductAffectedOrderSnapshotsEqual([original], [])).toBe(false);
  });
});
