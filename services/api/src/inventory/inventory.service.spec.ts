import { jest } from '@jest/globals';
import { InventoryService } from './inventory.service';
import { CreateInventoryReservationDto, InventoryMovementType } from './inventory.dto';

describe('InventoryService movement validation', () => {
  const userId = '921382b8-e83f-43ab-a576-e3db6a06b70c';
  const tenantId = '2e45dd6f-12be-4b61-884c-69ea81de37d2';
  const factoryId = 'f5f5a9a9-d4cb-4a3b-b7d9-cc6eb98b7e8f';
  const itemId = '2cdef0a9-8b96-42f9-a2a7-64d91445b6fd';
  const validMovement = {
    item_id: itemId,
    location_code: 'MAIN',
    movement_type: InventoryMovementType.RECEIPT,
    quantity_delta: 10,
    reason: 'Purchase receipt',
  };
  let transaction: ReturnType<typeof jest.fn>;
  let service: InventoryService;

  beforeEach(() => {
    transaction = jest.fn();
    service = new InventoryService({ transaction } as never, { record: jest.fn() } as never);
  });

  it('rejects receipt with negative quantity before opening a transaction', async () => {
    await expect(service.createMovement(userId, tenantId, factoryId,
      { ...validMovement, quantity_delta: -2 }, 'receipt-1', null, null))
      .rejects.toThrow('RECEIPT quantity_delta must be positive');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects issue with positive quantity before opening a transaction', async () => {
    await expect(service.createMovement(userId, tenantId, factoryId,
      { ...validMovement, movement_type: InventoryMovementType.ISSUE, quantity_delta: 2 },
      'issue-1', null, null))
      .rejects.toThrow('ISSUE quantity_delta must be negative');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects zero and over-precision movements before database writes', async () => {
    await expect(service.createMovement(userId, tenantId, factoryId,
      { ...validMovement, quantity_delta: 0 }, 'zero-1', null, null))
      .rejects.toThrow('quantity_delta must be non-zero');
    await expect(service.createMovement(userId, tenantId, factoryId,
      { ...validMovement, quantity_delta: 1.0000001 }, 'precision-1', null, null))
      .rejects.toThrow('quantity_delta must be non-zero');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed idempotency key before database writes', async () => {
    await expect(service.createMovement(userId, tenantId, factoryId, validMovement,
      'invalid key with spaces', null, null))
      .rejects.toThrow('Idempotency-Key must be 1-128 safe ASCII characters');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects zero or over-precision reservation quantities before opening a transaction', async () => {
    const dto: CreateInventoryReservationDto = {
      item_id: itemId, location_code: 'MAIN', quantity: 0, reason: 'Reserve for order',
    };
    await expect(service.createReservation(userId, tenantId, factoryId, dto, 'reserve-1', null, null))
      .rejects.toThrow('quantity must be positive');
    await expect(service.createReservation(userId, tenantId, factoryId,
      { ...dto, quantity: 1.0000001 }, 'reserve-2', null, null))
      .rejects.toThrow('quantity must be positive');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed reservation idempotency key before opening a transaction', async () => {
    await expect(service.createReservation(userId, tenantId, factoryId, {
      item_id: itemId, location_code: 'MAIN', quantity: 1, reason: 'Reserve for order',
    }, 'bad key', null, null)).rejects.toThrow('Idempotency-Key must be 1-128 safe ASCII characters');
    expect(transaction).not.toHaveBeenCalled();
  });

});
