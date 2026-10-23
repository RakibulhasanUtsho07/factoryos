import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { MrpFiniteCapacityService } from './mrp-finite-capacity.service';

const USER = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const SOURCE_PLAN = 'd37a568f-b44a-4fa7-9fe8-6f59451ea8c1';
const WORK_CENTRE = '2f9f0b52-0fc7-4f9c-b3e5-0e0a2b9b3344';
const SHIFT = '6fcd7d12-0f87-4571-b642-4d8c84ecbb11';

describe('MrpFiniteCapacityService request contracts', () => {
  let service: MrpFiniteCapacityService;
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    database = { transaction: jest.fn(), query: jest.fn() };
    audit = { record: jest.fn() };
    service = new MrpFiniteCapacityService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('rejects malformed factory scope before querying calendars or creating scenarios', async () => {
    await expect(service.listCapacityCalendar(
      'not-a-user', TENANT, FACTORY, '2027-01-01', '2027-01-02',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid calendar dates before any read or write', async () => {
    await expect(service.listCapacityCalendar(
      USER, TENANT, FACTORY, '2027-02-30', '2027-03-02',
    )).rejects.toThrow('from_date must be a valid calendar date');
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key before creating a capacity calendar entry', async () => {
    await expect(service.createCapacityCalendarEntry(USER, TENANT, FACTORY, {
      work_centre_id: WORK_CENTRE, shift_template_id: SHIFT, capacity_date: '2027-01-04',
      line_code: 'LINE-1', available_minutes: 420, parallel_lines: 1,
    }, null, null, null)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid scenario adjustments before loading MRP or writing any plan', async () => {
    await expect(service.createCapacityPlan(USER, TENANT, FACTORY, SOURCE_PLAN, {
      scenario_name: 'Base scenario',
      frozen_horizon_days: 0,
      capacity_adjustments: [{
        work_centre_id: WORK_CENTRE,
        shift_template_id: SHIFT,
        capacity_date: '2027-01-04',
        line_code: 'LINE-1',
        delta_available_minutes: 1500,
        delta_parallel_lines: 0,
      }],
    }, 'capacity-scenario-key', null, null)).rejects.toThrow('Scenario capacity deltas are outside the supported range');
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects frozen horizons outside the supported bound before reading an MRP plan', async () => {
    await expect(service.createCapacityPlan(USER, TENANT, FACTORY, SOURCE_PLAN, {
      scenario_name: 'Frozen baseline test',
      frozen_horizon_days: 366,
    }, 'capacity-scenario-key', null, null)).rejects.toThrow(
      'frozen_horizon_days must be between 0 and 365',
    );
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });
});
