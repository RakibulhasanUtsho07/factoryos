import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  ChangeTraceabilityUnitStatusDto,
  CreateGenealogyEventDto,
  CreateTraceabilityUnitDto,
  CreateTraceabilityLabelTemplateDto,
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

  it('accepts GS1_DATAMATRIX as a persisted label template symbology', async () => {
    const template = {
      id: 'b4fbbe44-d33b-4df4-a5ca-fbcb9eb8e9fd',
      template_code: 'TRACE-GS1-DM-V1',
      name: 'GS1 Data Matrix v1',
      symbology: 'GS1_DATAMATRIX',
      supported_unit_types: ['LOT'],
      label_layout: { fields: ['unit_code', 'barcode_value', 'status'] },
      is_active: true,
      created_at: '2026-10-27T00:00:00.000Z',
    };
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO traceability_label_templates')) return { rows: [template] };
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

    const dto: CreateTraceabilityLabelTemplateDto = {
      template_code: 'TRACE-GS1-DM-V1',
      name: 'GS1 Data Matrix v1',
      symbology: 'GS1_DATAMATRIX',
      supported_unit_types: ['LOT'],
      label_layout: { fields: ['unit_code', 'barcode_value', 'status'] },
    };
    const result = await service.createLabelTemplate(
      USER_ID, TENANT_ID, FACTORY_ID, dto, null, null,
    );
    expect(result).toMatchObject({ symbology: 'GS1_DATAMATRIX', template_code: 'TRACE-GS1-DM-V1' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO traceability_label_templates'),
      expect.any(Array),
    );
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
  it('rejects unsafe recall notification recipients and missing idempotency before transactions', async () => {
    await expect(service.createRecallNotificationIntent(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID,
      { recipient_type: 'CUSTOMER', recipient_reference: 'https://evil.test', channel: 'EMAIL' },
      'notification-unsafe-ref', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createRecallNotificationIntent(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID,
      { recipient_type: 'CUSTOMER', recipient_reference: 'CUSTOMER-001', channel: 'EMAIL' },
      null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects unsupported recall acknowledgement outcomes and URL evidence references before transactions', async () => {
    await expect(service.recordRecallNotificationAcknowledgement(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID, UNIT_ID,
      { outcome: 'DELIVERED_BY_EMAIL' as never }, 'ack-invalid-outcome', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.recordRecallNotificationAcknowledgement(
      USER_ID, TENANT_ID, FACTORY_ID, UNIT_ID, UNIT_ID,
      { outcome: 'RECEIVED', evidence_reference: 'https://example.test/evidence' }, 'ack-invalid-evidence', null, null,
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

  it('includes inventory-material lifecycle status in the issued label payload', async () => {
    const templateId = 'd8fbbe44-d33b-4df4-a5ca-fbcb9eb8e9fd';
    const labelIssueId = 'f41b14ab-7794-4a35-bcad-6b8f51ba4f1b';
    const item = {
      id: UNIT_ID,
      sku: 'MAT-ACTIVE-001',
      name: 'Active material',
      unit: 'PCS',
      sector_code: 'FABRIC',
      status: 'ACTIVE',
    };
    const labelLayout = { fields: ['sku', 'name', 'status'] };
    const template = {
      id: templateId,
      template_code: 'MAT-QR-V1',
      symbology: 'QR',
      supported_unit_types: ['MATERIAL'],
      label_layout: labelLayout,
      is_active: true,
    };
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM inventory_items')) return { rows: [item] };
        if (sql.includes('FROM traceability_label_templates')) return { rows: [template] };
        if (sql.includes('INSERT INTO traceability_label_issues')) {
          const encodedPayload = JSON.parse(String(params?.[9])) as Record<string, unknown>;
          return {
            rows: [{
              id: labelIssueId,
              tenant_id: TENANT_ID,
              factory_id: FACTORY_ID,
              unit_id: null,
              inventory_item_id: item.id,
              template_id: templateId,
              template_code: template.template_code,
              unit_code: item.sku,
              barcode_value: item.sku,
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
      { item_id: UNIT_ID, template_id: templateId, copy_count: 1 },
      'label-material-status-001', null, null,
    );

    expect(result).toMatchObject({
      replayed: false,
      print_contract: {
        symbology: 'QR',
        identity_payload: {
          identity_type: 'MATERIAL',
          inventory_item_id: UNIT_ID,
          sku: 'MAT-ACTIVE-001',
          status: 'ACTIVE',
        },
      },
    });
  });

  it('rejects label issuance for an inactive material before creating a label issue', async () => {
    const inactiveItem = {
      id: UNIT_ID,
      sku: 'MAT-INACTIVE-001',
      name: 'Inactive material',
      unit: 'PCS',
      sector_code: 'FABRIC',
      status: 'INACTIVE',
    };
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM inventory_items')) return { rows: [inactiveItem] };
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

    await expect(service.issueLabel(
      USER_ID, TENANT_ID, FACTORY_ID,
      { item_id: UNIT_ID, template_id: 'd8fbbe44-d33b-4df4-a5ca-fbcb9eb8e9fd' },
      'label-material-inactive-001', null, null,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO traceability_label_issues'))).toBe(false);
  });
});
