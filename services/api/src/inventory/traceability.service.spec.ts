import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  ChangeTraceabilityUnitStatusDto, CreateGenealogyEventDto, CreateTraceabilityUnitDto, UpdateTraceabilitySettingsDto,
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

  it('preserves traceability lifecycle status in the issued label payload', async () => {
    const templateId = 'b4fbbe44-d33b-4df4-a5ca-fbcb9eb8e9fd';
    const labelIssueId = '6d03efc0-5671-41b3-a37e-00dc181fd1a9';
    const labelLayout = { fields: ['unit_code', 'barcode_value', 'status'] };
    const unit = {
      id: UNIT_ID,
      unit_code: 'FG-RECALL-001',
      barcode_value: 'FG-RECALL-001',
      rfid_epc: null,
      unit_type: 'LOT',
      product_role: 'FINISHED_GOOD',
      inventory_item_id: UNIT_ID,
      quantity: '5.0000',
      unit: 'PCS',
      expires_at: null,
      status: 'RECALLED',
      attributes: {},
    };
    const template = {
      id: templateId,
      template_code: 'TRACE-QR-V1',
      symbology: 'QR',
      supported_unit_types: ['LOT'],
      label_layout: labelLayout,
      is_active: true,
    };
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM traceability_units')) return { rows: [unit] };
        if (sql.includes('FROM traceability_label_templates')) return { rows: [template] };
        if (sql.includes('INSERT INTO traceability_label_issues')) {
          const encodedPayload = JSON.parse(String(params?.[9])) as Record<string, unknown>;
          return {
            rows: [{
              id: labelIssueId,
              tenant_id: TENANT_ID,
              factory_id: FACTORY_ID,
              unit_id: UNIT_ID,
              inventory_item_id: UNIT_ID,
              template_id: templateId,
              template_code: template.template_code,
              unit_code: unit.unit_code,
              barcode_value: unit.barcode_value,
              symbology: template.symbology,
              encoded_payload: encodedPayload,
              label_layout: labelLayout,
              copy_count: 1,
              created_by_user_id: USER_ID,
              correlation_id: String(params?.[15]),
              created_at: '2026-10-25T00:00:00.000Z',
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const transaction = database.transaction as unknown as {
      mockImplementation: (fn: (
        scope: unknown,
        callback: (client: unknown) => Promise<unknown>,
      ) => Promise<unknown>) => void;
    };
    transaction.mockImplementation(async (_scope, callback) => callback(client));

    const result = await service.issueLabel(
      USER_ID, TENANT_ID, FACTORY_ID,
      { unit_id: UNIT_ID, template_id: templateId, copy_count: 1 },
      'label-recalled-status-001', null, null,
    );

    expect(result).toMatchObject({
      replayed: false,
      print_contract: {
        symbology: 'QR',
        identity_payload: {
          unit_id: UNIT_ID,
          unit_code: 'FG-RECALL-001',
          status: 'RECALLED',
        },
      },
    });
  });
});
