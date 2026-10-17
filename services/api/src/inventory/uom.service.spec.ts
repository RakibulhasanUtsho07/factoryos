import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ConvertUomQuantityDto } from './dto/uom.dto';
import { UnitOfMeasureService } from './uom.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const KG_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const G_ID = 'b42f8e90-99d9-492d-a3b0-8cecb64ecfd3';

describe('UnitOfMeasureService', () => {
  let service: UnitOfMeasureService;
  let client: { query: ReturnType<typeof jest.fn> };
  const database = { transaction: jest.fn(), query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    client = { query: jest.fn() };
    database.transaction.mockImplementation(async (first: unknown, second?: unknown) => {
      const callback = typeof first === 'function' ? first : second;
      if (typeof callback !== 'function') throw new Error('test transaction callback missing');
      return (callback as (clientArg: typeof client) => Promise<unknown>)(client);
    });
    service = new UnitOfMeasureService(database as unknown as DatabaseService);
  });

  const units = (sourcePrecision = 3, targetPrecision = 3, targetDimension = 'MASS') => ({
    rows: [
      { id: KG_ID, unit_code: 'KG', dimension_code: 'MASS', decimal_precision: sourcePrecision },
      { id: G_ID, unit_code: 'G', dimension_code: targetDimension, decimal_precision: targetPrecision },
    ],
  });
  const rule = (rounding_mode: 'REJECT' | 'HALF_UP' = 'REJECT') => ({
    rows: [{
      id: '0de7e17c-9e96-4e35-aa8e-cc5b1d6e77a5',
      from_unit_id: KG_ID, factor_numerator: '1000', factor_denominator: '1', rounding_mode,
    }],
  });

  it('converts with the exact approved factor and target unit precision', async () => {
    client.query
      .mockResolvedValueOnce(units())
      .mockResolvedValueOnce(rule())
      .mockResolvedValueOnce({ rows: [{ exact_quantity: '1234', rounded_quantity: '1234.00000000', exact_at_precision: true }] });
    const result = await service.convert(USER_ID, TENANT_ID, FACTORY_ID, {
      quantity: '1.234', from_unit_code: 'KG', to_unit_code: 'G',
    } as ConvertUomQuantityDto);
    expect(result.converted_quantity).toBe('1234.000');
    expect(result.conversion_rule_id).toBe('0de7e17c-9e96-4e35-aa8e-cc5b1d6e77a5');
    expect(result.factor_numerator).toBe('1000');
    expect(result.factor_denominator).toBe('1');
  });

  it('rejects source quantities beyond the configured precision', async () => {
    client.query.mockResolvedValueOnce(units(2));
    await expect(service.convert(USER_ID, TENANT_ID, FACTORY_ID, {
      quantity: '1.234', from_unit_code: 'KG', to_unit_code: 'G',
    } as ConvertUomQuantityDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('rejects dimension mismatch before rule lookup', async () => {
    client.query.mockResolvedValueOnce(units(3, 3, 'COUNT'));
    await expect(service.convert(USER_ID, TENANT_ID, FACTORY_ID, {
      quantity: '1', from_unit_code: 'KG', to_unit_code: 'G',
    } as ConvertUomQuantityDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('does not invent an unapproved conversion', async () => {
    client.query.mockResolvedValueOnce(units()).mockResolvedValueOnce({ rows: [] });
    await expect(service.convert(USER_ID, TENANT_ID, FACTORY_ID, {
      quantity: '1', from_unit_code: 'KG', to_unit_code: 'G',
    } as ConvertUomQuantityDto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects non-representable results under REJECT rounding', async () => {
    client.query
      .mockResolvedValueOnce(units(6, 2))
      .mockResolvedValueOnce(rule('REJECT'))
      .mockResolvedValueOnce({ rows: [{ exact_quantity: '12.345', rounded_quantity: '12.35000000', exact_at_precision: false }] });
    await expect(service.convert(USER_ID, TENANT_ID, FACTORY_ID, {
      quantity: '0.012345', from_unit_code: 'KG', to_unit_code: 'G',
    } as ConvertUomQuantityDto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses explicit HALF_UP rounding only when the rule permits it', async () => {
    client.query
      .mockResolvedValueOnce(units(6, 2))
      .mockResolvedValueOnce(rule('HALF_UP'))
      .mockResolvedValueOnce({ rows: [{ exact_quantity: '12.345', rounded_quantity: '12.35000000', exact_at_precision: false }] });
    const result = await service.convert(USER_ID, TENANT_ID, FACTORY_ID, {
      quantity: '0.012345', from_unit_code: 'KG', to_unit_code: 'G',
    } as ConvertUomQuantityDto);
    expect(result.converted_quantity).toBe('12.35');
    expect(result.rounding_mode).toBe('HALF_UP');
  });

  it('rejects exponent notation, zero and negative quantities before database access', async () => {
    for (const quantity of ['1e-4', '0.000000001', '-1', '0']) {
      await expect(service.convert(USER_ID, TENANT_ID, FACTORY_ID, {
        quantity, from_unit_code: 'KG', to_unit_code: 'G',
      } as ConvertUomQuantityDto)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
