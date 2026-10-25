import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  ChangeTraceabilityUnitStatusDto,
  CreateGenealogyEventDto,
  CreateTraceabilityUnitDto,
  DeclareTraceabilityRecallDto,
  UpdateTraceabilitySettingsDto,
} from './dto/traceability.dto';
import { TraceabilityService } from './traceability.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const UNIT_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';

describe('TraceabilityService input contracts', () => {
  let service: TraceabilityService;
  const database = { transaction: jest.fn(), query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TraceabilityService(database as unknown as DatabaseService);
  });

  const validUnit = (): CreateTraceabilityUnitDto => ({
    unit_type: 'LOT', product_role: 'MATERIAL', unit_code: 'MAT-LOT-0001',
    barcode_value: 'QR-MAT-LOT-0001', inventory_item_id: UNIT_ID, quantity: 10, unit: 'PCS',
  });

  it('requires idempotency before opening a transaction', async () => {
    await expect(service.createUnit(
      USER_ID, TENANT_ID, FACTORY_ID, validUnit(), null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires serialized identities to represent exactly one unit', async () => {
    await expect(service.createUnit(
      USER_ID, TENANT_ID, FACTORY_ID, { ...validUnit(), unit_type: 'SERIAL', quantity: 2 },
      'trace-serial-invalid', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects quantity precision beyond four decimals before opening a transaction', async () => {
    await expect(service.createUnit(
      USER_ID, TENANT_ID, FACTORY_ID, { ...validUnit(), quantity: 1.00001 },
      'trace-precision-invalid', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects self-edges and unsupported relationships before opening a transaction', async () => {
    const selfEdge: CreateGenealogyEventDto = {
      source_unit_id: UNIT_ID, target_unit_id: UNIT_ID, relationship_type: 'CONSUMED_INTO', quantity: 1,
    };
    await expect(service.recordGenealogyEvent(
      USER_ID, TENANT_ID, FACTORY_ID, selfEdge, 'trace-self-edge', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.recordGenealogyEvent(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...selfEdge, target_unit_id: 'b42f8e90-99d9-492d-a3b0-8cecb64ecfd3', relationship_type: 'UNKNOWN' as never },
      'trace-invalid-edge', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid recall bounds before opening a transaction', async () => {
    const invalidDepth: DeclareTraceabilityRecallDto = {
      reason: 'Valid recall rationale', depth: 13, limit: 200,
    };
    await expect(service.declareRecall(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID,
      invalidDepth, 'trace-recall-depth-invalid', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    const invalidLimit: DeclareTraceabilityRecallDto = {
      reason: 'Valid recall rationale', depth: 5, limit: 501,
    };
    await expect(service.declareRecall(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID,
      invalidLimit, 'trace-recall-limit-invalid', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    const blankReason: DeclareTraceabilityRecallDto = {
      reason: '   ', depth: 5, limit: 200,
    };
    await expect(service.declareRecall(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID,
      blankReason, 'trace-recall-reason-invalid', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires reasoned status changes and a valid optimistic settings version', async () => {
    const status: ChangeTraceabilityUnitStatusDto = { target_status: 'RECALLED', reason: '   ' };
    await expect(service.changeUnitStatus(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID, status, 'trace-no-reason', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    const settings: UpdateTraceabilitySettingsDto = { expected_version: 0, retention_years: 10 };
    await expect(service.updateSettings(
      USER_ID, TENANT_ID, FACTORY_ID, settings, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
