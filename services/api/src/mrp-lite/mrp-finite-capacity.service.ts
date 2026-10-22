import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateMrpCapacityCalendarDto } from './dto/create-mrp-capacity-calendar.dto';
import { CreateMrpCapacityPlanDto } from './dto/create-mrp-capacity-plan.dto';
import { UpdateMrpCapacityCalendarDto } from './dto/update-mrp-capacity-calendar.dto';
import {
  diffMrpCapacityPlans,
  scheduleMrpFiniteCapacity,
  type MrpCapacityBaselineOperation,
  type MrpCapacityJob,
  type MrpCapacityOperationResult,
  type MrpCapacityRoutingStep,
  type MrpCapacityScenarioAdjustment,
  type MrpCapacitySkillPool,
  type MrpCapacityCalendarSlot,
} from './mrp-finite-capacity-planning';

interface CapacityCalendarRow extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; work_centre_id: string;
  work_centre_code: string; work_centre_name: string; shift_template_id: string;
  shift_code: string; starts_at_local: string; ends_at_local: string; timezone_name: string;
  unpaid_break_minutes: number; capacity_date: string; line_code: string;
  available_minutes: number; parallel_lines: number; status: 'ACTIVE' | 'INACTIVE';
  row_version: string; idempotency_key: string; request_hash: string;
  created_by_user_id: string; updated_by_user_id: string; correlation_id: string;
  created_at: string; updated_at: string;
}
interface SourcePlanRow extends QueryResultRow {
  id: string; horizon_start: string; horizon_end: string; summary: Record<string, unknown>; exceptions: unknown[];
}
interface DemandRow extends QueryResultRow {
  order_id: string; order_line_id: string; order_number: string; order_line_number: number;
  product_id: string; product_code: string; product_name: string; style_code: string | null; size_code: string | null; product_version_id: string;
  product_version_number: number; need_by_date: string; quantity: string;
  has_unresolved_material_shortage: boolean; material_available_date: string | null;
}
interface RoutingRow extends QueryResultRow {
  id: string; product_id: string; product_version_id: string; step_number: number;
  operation_code: string; operation_name: string; work_centre_id: string;
  work_centre_code: string; setup_minutes: string; run_minutes_per_unit: string;
  required_skill: string | null; capacity_units_per_hour: string | null;
}
interface SlotRow extends QueryResultRow {
  calendar_entry_id: string; capacity_date: string; shift_template_id: string; shift_code: string;
  shift_start_minute: number; shift_minutes: number; work_centre_id: string; work_centre_code: string;
  line_code: string; available_minutes: number; parallel_lines: number; capacity_units_per_hour: string | null;
}
interface SkillRow extends QueryResultRow {
  capacity_date: string; shift_template_id: string; worker_id: string;
  skill_code: string; skill_level: number; available_minutes: number;
}
interface CapacityPlanHeader extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; source_mrp_plan_id: string;
  plan_version: number; scenario_name: string; frozen_horizon_days: number;
  compare_to_capacity_plan_id: string | null; idempotency_key: string; request_hash: string;
  correlation_id: string; created_by_user_id: string; scenario_inputs: Record<string, unknown>;
  summary: Record<string, unknown>; exceptions: unknown[]; frozen_horizon_diff: unknown[];
  created_at: string; horizon_start: string; horizon_end: string;
}
interface BaselineAllocationRow extends QueryResultRow {
  operation_id: string; order_line_id: string; step_number: number;
  calendar_entry_id: string; capacity_date: string; shift_template_id: string;
  work_centre_id: string; line_code: string; allocated_minutes: string;
  worker_allocations: Array<{ worker_id: string; allocated_minutes: string }>;
}

const CALENDAR_COLUMNS = `
  c.id::text AS id, c.tenant_id::text AS tenant_id, c.factory_id::text AS factory_id,
  c.work_centre_id::text AS work_centre_id, wc.code AS work_centre_code, wc.name AS work_centre_name,
  c.shift_template_id::text AS shift_template_id, st.shift_code, st.starts_at_local::text AS starts_at_local,
  st.ends_at_local::text AS ends_at_local, st.timezone_name, st.unpaid_break_minutes,
  c.capacity_date::text AS capacity_date, c.line_code, c.available_minutes, c.parallel_lines,
  c.status, c.row_version::text AS row_version, c.idempotency_key, c.request_hash,
  c.created_by_user_id::text AS created_by_user_id, c.updated_by_user_id::text AS updated_by_user_id,
  c.correlation_id::text AS correlation_id, c.created_at::text AS created_at, c.updated_at::text AS updated_at
`;

@Injectable()
export class MrpFiniteCapacityService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async listCapacityCalendar(userId: string, tenantId: string, factoryId: string, fromRaw: string, toRaw: string, rawLimit = 500) {
    this.assertScope(userId, tenantId, factoryId);
    const fromDate = this.calendarDate(fromRaw, 'from_date');
    const toDate = this.calendarDate(toRaw, 'to_date');
    if (toDate < fromDate) throw new BadRequestException('to_date must not precede from_date');
    if (this.daysBetween(fromDate, toDate) > 365) throw new BadRequestException('Capacity calendar queries cannot exceed 366 days');
    const limit = this.limit(rawLimit, 1000);
    const result = await this.database.query<CapacityCalendarRow>(
      'SELECT ' + CALENDAR_COLUMNS + `
       FROM mrp_capacity_calendar c
       JOIN manufacturing_work_centres wc ON wc.id = c.work_centre_id AND wc.tenant_id = c.tenant_id AND wc.factory_id = c.factory_id
       JOIN workforce_shift_templates st ON st.id = c.shift_template_id AND st.tenant_id = c.tenant_id AND st.factory_id = c.factory_id
       WHERE c.tenant_id = $1 AND c.factory_id = $2 AND c.capacity_date BETWEEN $3::date AND $4::date
       ORDER BY c.capacity_date, st.starts_at_local, st.shift_code, wc.code, c.line_code, c.id LIMIT $5`,
      [tenantId, factoryId, fromDate, toDate, limit], { tenantId, userId },
    );
    return result.rows;
  }

  async createCapacityCalendarEntry(
    userId: string, tenantId: string, factoryId: string, dto: CreateMrpCapacityCalendarDto,
    rawKey: string | null, requestId: string | null, traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const key = this.idempotencyKey(rawKey);
    const workCentreId = this.uuid(dto.work_centre_id, 'work_centre_id');
    const shiftTemplateId = this.uuid(dto.shift_template_id, 'shift_template_id');
    const capacityDate = this.calendarDate(dto.capacity_date, 'capacity_date');
    const lineCode = dto.line_code.trim().toUpperCase();
    if (!lineCode || lineCode.length > 100) throw new BadRequestException('line_code must contain 1 to 100 characters');
    this.validateCapacityNumbers(dto.available_minutes, dto.parallel_lines);
    const requestHash = this.hash({
      work_centre_id: workCentreId, shift_template_id: shiftTemplateId, capacity_date: capacityDate,
      line_code: lineCode, available_minutes: dto.available_minutes, parallel_lines: dto.parallel_lines,
    });
    const correlationId = this.correlationId(traceId, requestId);
    const outcome = await this.database.transaction({
      tenantId, userId, requestId, traceId,
      advisoryLockKey: 'mrp-capacity-calendar:' + tenantId + ':' + factoryId + ':' + key,
    }, async (client) => {
      const replay = await client.query<{ id: string; request_hash: string }>(
        'SELECT id::text AS id, request_hash FROM mrp_capacity_calendar WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [tenantId, factoryId, key],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for a different capacity calendar entry');
        return { id: replay.rows[0].id, replayed: true };
      }
      const wc = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM manufacturing_work_centres
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' FOR KEY SHARE`,
        [workCentreId, tenantId, factoryId],
      );
      if (!wc.rows[0]) throw new NotFoundException('Active work centre was not found in this factory');
      const shift = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM workforce_shift_templates
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' FOR KEY SHARE`,
        [shiftTemplateId, tenantId, factoryId],
      );
      if (!shift.rows[0]) throw new NotFoundException('Active shift template was not found in this factory');
      const duplicate = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM mrp_capacity_calendar
         WHERE tenant_id=$1 AND factory_id=$2 AND work_centre_id=$3 AND shift_template_id=$4
           AND capacity_date=$5::date AND line_code=$6 FOR UPDATE`,
        [tenantId, factoryId, workCentreId, shiftTemplateId, capacityDate, lineCode],
      );
      if (duplicate.rows[0]) throw new ConflictException('Capacity entry already exists for this line, shift and date');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO mrp_capacity_calendar (
          tenant_id,factory_id,work_centre_id,shift_template_id,capacity_date,line_code,
          available_minutes,parallel_lines,status,row_version,idempotency_key,request_hash,
          created_by_user_id,updated_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,'ACTIVE',1,$9,$10,$11,$11,$12::uuid)
        RETURNING id::text AS id`,
        [tenantId, factoryId, workCentreId, shiftTemplateId, capacityDate, lineCode,
          dto.available_minutes, dto.parallel_lines, key, requestHash, userId, correlationId],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('MRP_CAPACITY_CALENDAR_INSERT_FAILED');
      await this.insertOutbox(client, {
        tenantId, factoryId, aggregateType: 'MRP_CAPACITY_CALENDAR', aggregateId: id,
        eventType: 'MRP_CAPACITY.CALENDAR_CREATED', correlationId, requestId, userId,
        payload: { work_centre_id: workCentreId, shift_template_id: shiftTemplateId, capacity_date: capacityDate, line_code: lineCode, available_minutes: dto.available_minutes, parallel_lines: dto.parallel_lines },
      });
      return { id, replayed: false };
    });
    if (!outcome.replayed) await this.auditSafe({
      tenantId, factoryId, userId, action: 'MRP_CAPACITY_CALENDAR_CREATED',
      resourceType: 'MRP_CAPACITY_CALENDAR', id: outcome.id, requestId, traceId,
      payload: { workCentreId, shiftTemplateId, capacityDate, lineCode, availableMinutes: dto.available_minutes, parallelLines: dto.parallel_lines },
    });
    return { ...(await this.getCalendarEntry(userId, tenantId, factoryId, outcome.id)), replayed: outcome.replayed };
  }

  async updateCapacityCalendarEntry(
    userId: string, tenantId: string, factoryId: string, calendarId: string,
    dto: UpdateMrpCapacityCalendarDto, requestId: string | null, traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const id = this.uuid(calendarId, 'calendarId');
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) throw new BadRequestException('expected_version must be positive');
    if (dto.available_minutes === undefined && dto.parallel_lines === undefined && dto.status === undefined) {
      throw new BadRequestException('Provide at least one capacity field to update');
    }
    if (dto.available_minutes !== undefined && (!Number.isInteger(dto.available_minutes) || dto.available_minutes < 0 || dto.available_minutes > 1440)) {
      throw new BadRequestException('available_minutes must be between 0 and 1440');
    }
    if (dto.parallel_lines !== undefined && (!Number.isInteger(dto.parallel_lines) || dto.parallel_lines < 1 || dto.parallel_lines > 100)) {
      throw new BadRequestException('parallel_lines must be between 1 and 100');
    }
    const correlationId = this.correlationId(traceId, requestId);
    await this.database.transaction({
      tenantId, userId, requestId, traceId,
      advisoryLockKey: 'mrp-capacity-calendar-update:' + tenantId + ':' + factoryId + ':' + id,
    }, async (client) => {
      const current = await client.query<{ row_version: string; available_minutes: number; parallel_lines: number; status: string }>(
        `SELECT row_version::text AS row_version, available_minutes, parallel_lines, status
         FROM mrp_capacity_calendar WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [id, tenantId, factoryId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Capacity calendar entry was not found in this factory');
      if (Number(row.row_version) !== dto.expected_version) throw new ConflictException('Capacity calendar version is stale');
      const updated = await client.query<{ row_version: string }>(
        `UPDATE mrp_capacity_calendar SET available_minutes=COALESCE($1,available_minutes),
          parallel_lines=COALESCE($2,parallel_lines), status=COALESCE($3,status),
          row_version=row_version+1, updated_by_user_id=$4, updated_at=clock_timestamp()
         WHERE id=$5 AND tenant_id=$6 AND factory_id=$7 AND row_version=$8
         RETURNING row_version::text AS row_version`,
        [dto.available_minutes ?? null, dto.parallel_lines ?? null, dto.status ?? null, userId, id, tenantId, factoryId, dto.expected_version],
      );
      if (!updated.rows[0]) throw new ConflictException('Capacity calendar changed concurrently');
      await this.insertOutbox(client, {
        tenantId, factoryId, aggregateType: 'MRP_CAPACITY_CALENDAR', aggregateId: id,
        eventType: 'MRP_CAPACITY.CALENDAR_UPDATED', correlationId, requestId, userId,
        payload: { row_version: updated.rows[0].row_version, available_minutes: dto.available_minutes ?? row.available_minutes, parallel_lines: dto.parallel_lines ?? row.parallel_lines, status: dto.status ?? row.status },
      });
    });
    await this.auditSafe({
      tenantId, factoryId, userId, action: 'MRP_CAPACITY_CALENDAR_UPDATED',
      resourceType: 'MRP_CAPACITY_CALENDAR', id, requestId, traceId,
      payload: { expectedVersion: dto.expected_version, availableMinutes: dto.available_minutes, parallelLines: dto.parallel_lines, status: dto.status },
    });
    return this.getCalendarEntry(userId, tenantId, factoryId, id);
  }

  async createCapacityPlan(
    userId: string, tenantId: string, factoryId: string, sourceMrpPlanId: string,
    dto: CreateMrpCapacityPlanDto, rawKey: string | null, requestId: string | null, traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const sourceId = this.uuid(sourceMrpPlanId, 'sourceMrpPlanId');
    const key = this.idempotencyKey(rawKey);
    const scenarioName = dto.scenario_name.trim();
    if (scenarioName.length < 3 || scenarioName.length > 120) throw new BadRequestException('scenario_name must contain 3 to 120 characters');
    if (!Number.isInteger(dto.frozen_horizon_days) || dto.frozen_horizon_days < 0 || dto.frozen_horizon_days > 365) {
      throw new BadRequestException('frozen_horizon_days must be between 0 and 365');
    }
    const requestedCompare = dto.compare_to_capacity_plan_id ? this.uuid(dto.compare_to_capacity_plan_id, 'compare_to_capacity_plan_id') : null;
    const adjustments = this.normalizeAdjustments(dto.capacity_adjustments ?? []);
    const requestHash = this.hash({
      source_mrp_plan_id: sourceId, scenario_name: scenarioName,
      frozen_horizon_days: dto.frozen_horizon_days, compare_to_capacity_plan_id: requestedCompare,
      capacity_adjustments: adjustments,
    });
    const correlationId = this.correlationId(traceId, requestId);
    const outcome = await this.database.transaction({
      tenantId, userId, requestId, traceId, isolationLevel: 'REPEATABLE READ',
      advisoryLockKey: 'mrp-capacity-plan:' + tenantId + ':' + factoryId + ':' + sourceId + ':' + key,
    }, async (client) => {
      const replay = await client.query<{ id: string; request_hash: string }>(
        `SELECT id::text AS id, request_hash FROM mrp_capacity_plans
         WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [tenantId, factoryId, key],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for a different capacity scenario');
        return { id: replay.rows[0].id, replayed: true };
      }
      const sourceResult = await client.query<SourcePlanRow>(
        `SELECT id::text AS id,horizon_start::text AS horizon_start,horizon_end::text AS horizon_end,summary,exceptions
         FROM mrp_plans WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [sourceId, tenantId, factoryId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new NotFoundException('Source MRP material plan was not found in this factory');

      let compareId = requestedCompare;
      if (!compareId) {
        const latest = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM mrp_capacity_plans WHERE source_mrp_plan_id=$1
           AND tenant_id=$2 AND factory_id=$3 ORDER BY plan_version DESC LIMIT 1`,
          [sourceId, tenantId, factoryId],
        );
        compareId = latest.rows[0]?.id ?? null;
      }
      if (dto.frozen_horizon_days > 0 && !compareId) {
        throw new ConflictException('A frozen horizon requires a previous capacity scenario for comparison');
      }
      const comparePlan = compareId ? await this.getComparisonHeader(client, compareId, sourceId, tenantId, factoryId) : null;
      const version = await client.query<{ next_version: number }>(
        `SELECT (COALESCE(MAX(plan_version),0)+1)::int AS next_version FROM mrp_capacity_plans
         WHERE source_mrp_plan_id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [sourceId, tenantId, factoryId],
      );
      const planVersion = version.rows[0]?.next_version ?? 1;

      const demandResult = await client.query<DemandRow>(
        `SELECT r.order_id::text AS order_id,r.order_line_id::text AS order_line_id,r.order_number,
          r.order_line_number,r.product_id::text AS product_id,r.product_code,r.product_name,r.style_code,r.size_code,
          r.product_version_id::text AS product_version_id,r.product_version_number,
          r.need_by_date::text AS need_by_date,r.remaining_finished_quantity::text AS quantity,
          BOOL_OR(r.shortage_quantity>0 AND r.projected_available_date IS NULL) AS has_unresolved_material_shortage,
          (MAX(r.projected_available_date) FILTER (WHERE r.shortage_quantity>0 AND r.projected_available_date IS NOT NULL))::text AS material_available_date
         FROM mrp_plan_requirements r WHERE r.plan_id=$1 AND r.tenant_id=$2 AND r.factory_id=$3
         GROUP BY r.order_id,r.order_line_id,r.order_number,r.order_line_number,r.product_id,r.product_code,
          r.product_name,r.style_code,r.size_code,r.product_version_id,r.product_version_number,r.need_by_date,r.remaining_finished_quantity
         ORDER BY r.need_by_date,r.order_number,r.order_line_number,r.order_line_id`,
        [sourceId, tenantId, factoryId],
      );
      const demandRows = demandResult.rows;
      const versionIds = [...new Set(demandRows.map((row) => row.product_version_id))];
      const routeRows = versionIds.length ? (await client.query<RoutingRow>(
        `SELECT rs.id::text AS id,rs.product_id::text AS product_id,rs.product_version_id::text AS product_version_id,
          rs.step_number,rs.operation_code,rs.operation_name,rs.work_centre_id::text AS work_centre_id,
          wc.code AS work_centre_code,rs.setup_minutes::text AS setup_minutes,
          rs.run_minutes_per_unit::text AS run_minutes_per_unit,rs.required_skill,
          wc.capacity_units_per_hour::text AS capacity_units_per_hour
         FROM product_routing_steps rs JOIN manufacturing_work_centres wc
          ON wc.id=rs.work_centre_id AND wc.tenant_id=rs.tenant_id AND wc.factory_id=rs.factory_id
         WHERE rs.tenant_id=$1 AND rs.factory_id=$2 AND rs.product_version_id=ANY($3::uuid[])
         ORDER BY rs.product_version_id,rs.step_number,rs.id`,
        [tenantId, factoryId, versionIds],
      )).rows : [];
      const routesByVersion = new Map<string, MrpCapacityRoutingStep[]>();
      for (const row of routeRows) {
        const route = routesByVersion.get(row.product_version_id) ?? [];
        route.push({
          id: row.id, stepNumber: row.step_number, operationCode: row.operation_code, operationName: row.operation_name,
          workCentreId: row.work_centre_id, workCentreCode: row.work_centre_code,
          setupMinutes: row.setup_minutes, runMinutesPerUnit: row.run_minutes_per_unit,
          requiredSkill: row.required_skill, capacityUnitsPerHour: row.capacity_units_per_hour,
        });
        routesByVersion.set(row.product_version_id, route);
      }
      const jobs: MrpCapacityJob[] = demandRows.map((row) => ({
        orderId: row.order_id, orderLineId: row.order_line_id, orderNumber: row.order_number,
        orderLineNumber: row.order_line_number, productCode: row.product_code, productName: row.product_name,
        styleCode: row.style_code, sizeCode: row.size_code, productId: row.product_id, productVersionId: row.product_version_id,
        productVersionNumber: row.product_version_number, needByDate: row.need_by_date,
        quantity: row.quantity, materialAvailableDate: row.material_available_date,
        hasUnresolvedMaterialShortage: row.has_unresolved_material_shortage,
        operations: routesByVersion.get(row.product_version_id) ?? [],
      }));

      const slotRows = await client.query<SlotRow>(
        `SELECT c.id::text AS calendar_entry_id,c.capacity_date::text AS capacity_date,
          c.shift_template_id::text AS shift_template_id,st.shift_code,
          (EXTRACT(HOUR FROM st.starts_at_local)*60+EXTRACT(MINUTE FROM st.starts_at_local))::int AS shift_start_minute,
          GREATEST((CASE WHEN st.ends_at_local>st.starts_at_local
            THEN EXTRACT(EPOCH FROM ((DATE '2000-01-01'+st.ends_at_local)-(DATE '2000-01-01'+st.starts_at_local)))
            ELSE EXTRACT(EPOCH FROM ((DATE '2000-01-02'+st.ends_at_local)-(DATE '2000-01-01'+st.starts_at_local)))
          END/60)::int-st.unpaid_break_minutes,0)::int AS shift_minutes,
          c.work_centre_id::text AS work_centre_id,wc.code AS work_centre_code,c.line_code,c.available_minutes,c.parallel_lines,
          wc.capacity_units_per_hour::text AS capacity_units_per_hour
         FROM mrp_capacity_calendar c
         JOIN manufacturing_work_centres wc ON wc.id=c.work_centre_id AND wc.tenant_id=c.tenant_id AND wc.factory_id=c.factory_id
         JOIN workforce_shift_templates st ON st.id=c.shift_template_id AND st.tenant_id=c.tenant_id AND st.factory_id=c.factory_id
         WHERE c.tenant_id=$1 AND c.factory_id=$2 AND c.capacity_date BETWEEN $3::date AND $4::date
           AND c.status='ACTIVE' AND wc.status='ACTIVE' AND st.status='ACTIVE'
         ORDER BY c.capacity_date,st.starts_at_local,st.shift_code,wc.code,c.line_code,c.id`,
        [tenantId, factoryId, source.horizon_start, source.horizon_end],
      );
      const slots: MrpCapacityCalendarSlot[] = slotRows.rows.map((row) => ({
        calendarEntryId: row.calendar_entry_id, capacityDate: row.capacity_date,
        shiftTemplateId: row.shift_template_id, shiftCode: row.shift_code, shiftStartMinute: row.shift_start_minute,
        shiftMinutes: row.shift_minutes, workCentreId: row.work_centre_id, workCentreCode: row.work_centre_code,
        lineCode: row.line_code, availableMinutes: Math.min(row.available_minutes, row.shift_minutes), parallelLines: row.parallel_lines,
        capacityUnitsPerHour: row.capacity_units_per_hour,
      }));
      const shiftIds = [...new Set(slots.map((slot) => slot.shiftTemplateId))];
      const skillPools: MrpCapacitySkillPool[] = shiftIds.length ? (await client.query<SkillRow>(
        `SELECT DISTINCT wsa.shift_date::text AS capacity_date,wsa.shift_template_id::text AS shift_template_id,
          ww.id::text AS worker_id,ws.skill_code,wws.skill_level,
          GREATEST((CASE WHEN st.ends_at_local>st.starts_at_local
            THEN EXTRACT(EPOCH FROM ((DATE '2000-01-01'+st.ends_at_local)-(DATE '2000-01-01'+st.starts_at_local)))
            ELSE EXTRACT(EPOCH FROM ((DATE '2000-01-02'+st.ends_at_local)-(DATE '2000-01-01'+st.starts_at_local)))
          END/60)::int-st.unpaid_break_minutes,0)::int AS available_minutes
         FROM workforce_shift_assignments wsa
         JOIN workforce_shift_templates st ON st.id=wsa.shift_template_id AND st.tenant_id=wsa.tenant_id AND st.factory_id=wsa.factory_id
         JOIN workforce_workers ww ON ww.id=wsa.worker_id AND ww.tenant_id=wsa.tenant_id AND ww.factory_id=wsa.factory_id
         JOIN workforce_worker_skills wws ON wws.worker_id=ww.id AND wws.tenant_id=ww.tenant_id AND wws.factory_id=ww.factory_id
         JOIN workforce_skills ws ON ws.id=wws.skill_id AND ws.tenant_id=wws.tenant_id AND ws.factory_id=wws.factory_id
         WHERE wsa.tenant_id=$1 AND wsa.factory_id=$2 AND wsa.shift_date BETWEEN $3::date AND $4::date
           AND wsa.shift_template_id=ANY($5::uuid[]) AND wsa.status IN ('PLANNED','CONFIRMED')
           AND wsa.work_order_id IS NULL AND wsa.work_order_operation_id IS NULL
           AND ww.status='ACTIVE' AND wws.status='ACTIVE' AND ws.status='ACTIVE'
           AND (wws.certified_on IS NULL OR wws.certified_on<=wsa.shift_date)
           AND (wws.certificate_expires_on IS NULL OR wws.certificate_expires_on>=wsa.shift_date)
           AND (wsa.required_skill_code IS NULL OR upper(wsa.required_skill_code)=upper(ws.skill_code))
           AND NOT EXISTS (SELECT 1 FROM workforce_attendance_events wae
             WHERE wae.shift_assignment_id=wsa.id AND wae.event_type='ABSENCE_RECORDED')
         ORDER BY wsa.shift_date,wsa.shift_template_id,ws.skill_code,ww.id`,
        [tenantId, factoryId, source.horizon_start, source.horizon_end, shiftIds],
      )).rows.map((row) => ({
        capacityDate: row.capacity_date, shiftTemplateId: row.shift_template_id, workerId: row.worker_id,
        skillCode: row.skill_code, skillLevel: row.skill_level, availableMinutes: row.available_minutes,
      })) : [];

      const baseline = comparePlan ? await this.readBaselineOperations(client, comparePlan.id, tenantId, factoryId) : [];
      let scheduled: MrpCapacityOperationResult[];
      try {
        scheduled = scheduleMrpFiniteCapacity({
          horizonStart: source.horizon_start, horizonEnd: source.horizon_end, frozenHorizonDays: dto.frozen_horizon_days,
          jobs, slots, skillPools, adjustments, baselineOperations: baseline,
        });
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : 'Invalid finite-capacity scenario');
      }
      const frozenDiff = comparePlan ? diffMrpCapacityPlans({
        horizonStart: source.horizon_start, frozenHorizonDays: dto.frozen_horizon_days, baseline, current: scheduled,
      }) : [];
      const lateLines = new Set(scheduled.filter((operation) => operation.conflictCodes.includes('FINISH_AFTER_NEED_BY_DATE')).map((operation) => operation.orderLineId));
      const summary: Record<string, unknown> = {
        order_line_count: jobs.length, operation_count: scheduled.length,
        scheduled_operation_count: scheduled.filter((item) => item.status === 'SCHEDULED').length,
        capacity_conflict_count: scheduled.filter((item) => item.status === 'CAPACITY_CONFLICT' || item.status === 'FROZEN_HORIZON_CONFLICT').length,
        material_blocked_operation_count: scheduled.filter((item) => item.status === 'BLOCKED_MATERIAL').length,
        routing_blocked_operation_count: scheduled.filter((item) => item.status === 'BLOCKED_ROUTING').length,
        predecessor_blocked_operation_count: scheduled.filter((item) => item.status === 'BLOCKED_PREDECESSOR').length,
        late_order_line_count: lateLines.size, compare_to_capacity_plan_id: comparePlan?.id ?? null,
        frozen_horizon_change_count: frozenDiff.filter((entry) => entry.frozen_horizon_violation === true).length,
      };
      const sourceExceptions = Array.isArray(source.exceptions) ? source.exceptions : [];
      const exceptionSnapshot = sourceExceptions.map((entry) => ({ code: 'SOURCE_MRP_EXCEPTION', detail: entry }));
      const planId = randomUUID();
      const insertHeader = await client.query<{ id: string }>(
        `INSERT INTO mrp_capacity_plans (
          id,tenant_id,factory_id,source_mrp_plan_id,plan_version,scenario_name,frozen_horizon_days,
          compare_to_capacity_plan_id,idempotency_key,request_hash,request_id,trace_id,correlation_id,
          created_by_user_id,scenario_inputs,summary,exceptions,frozen_horizon_diff
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12::uuid,$13::uuid,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb)
        RETURNING id::text AS id`,
        [planId, tenantId, factoryId, sourceId, planVersion, scenarioName, dto.frozen_horizon_days,
          comparePlan?.id ?? null, key, requestHash, this.validUuid(requestId), this.validUuid(traceId),
          correlationId, userId,
          JSON.stringify({ capacity_adjustments: adjustments, frozen_horizon_days: dto.frozen_horizon_days, compare_to_capacity_plan_id: comparePlan?.id ?? null }),
          JSON.stringify(summary), JSON.stringify(exceptionSnapshot), JSON.stringify(frozenDiff)],
      );
      if (!insertHeader.rows[0]) throw new Error('MRP_CAPACITY_PLAN_INSERT_FAILED');

      for (const operation of scheduled) {
        const job = jobs.find((item) => item.orderLineId === operation.orderLineId);
        if (!job) throw new Error('MRP_CAPACITY_JOB_SNAPSHOT_MISSING');
        const step = job.operations.find((item) => item.stepNumber === operation.stepNumber) ?? null;
        const operationId = randomUUID();
        await client.query(
          `INSERT INTO mrp_capacity_plan_operations (
            id,tenant_id,factory_id,capacity_plan_id,order_id,order_line_id,product_id,product_version_id,
            routing_step_id,step_number,order_number,order_line_number,product_code,product_name,product_version_number,
            need_by_date,planned_quantity,operation_code,operation_name,work_centre_id,work_centre_code,required_skill,
            setup_minutes,run_minutes_per_unit,capacity_units_per_hour,required_minutes,scheduled_minutes,
            planned_start_date,planned_finish_date,status,conflict_codes,style_code,size_code
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,$17::numeric,
            $18,$19,$20,$21,$22,$23::numeric,$24::numeric,$25::numeric,$26::numeric,$27::numeric,
            $28::date,$29::date,$30,$31::jsonb,$32,$33)`,
          [operationId, tenantId, factoryId, planId, operation.orderId, operation.orderLineId, operation.productId,
            operation.productVersionId, operation.routingStepId, operation.stepNumber, operation.orderNumber,
            operation.orderLineNumber, operation.productCode, operation.productName, operation.productVersionNumber,
            operation.needByDate, operation.quantity, operation.operationCode, operation.operationName, operation.workCentreId,
            operation.workCentreCode, operation.requiredSkill, step?.setupMinutes ?? '0.0000', step?.runMinutesPerUnit ?? '0.0000',
            step?.capacityUnitsPerHour ?? null, operation.requiredMinutes, operation.scheduledMinutes,
            operation.plannedStartDate, operation.plannedFinishDate, operation.status, JSON.stringify(operation.conflictCodes), operation.styleCode, operation.sizeCode],
        );
        for (const allocation of operation.allocations) {
          await client.query(
            `INSERT INTO mrp_capacity_plan_allocations (
              tenant_id,factory_id,capacity_plan_id,operation_id,calendar_entry_id,capacity_date,shift_template_id,
              shift_code,work_centre_id,line_code,allocated_minutes,required_skill,worker_allocations
            ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11::numeric,$12,$13::jsonb)`,
            [tenantId, factoryId, planId, operationId, allocation.calendarEntryId, allocation.capacityDate,
              allocation.shiftTemplateId, allocation.shiftCode, allocation.workCentreId, allocation.lineCode,
              allocation.allocatedMinutes, allocation.requiredSkill, JSON.stringify(allocation.workerAllocations.map((worker) => ({
                worker_id: worker.workerId, allocated_minutes: worker.allocatedMinutes,
              })))],
          );
        }
      }
      await this.insertOutbox(client, {
        tenantId, factoryId, aggregateType: 'MRP_CAPACITY_PLAN', aggregateId: planId,
        eventType: 'MRP_CAPACITY.PLAN_CREATED', correlationId, requestId, userId,
        payload: { capacity_plan_id: planId, source_mrp_plan_id: sourceId, plan_version: planVersion, scenario_name: scenarioName, summary },
      });
      return { id: planId, replayed: false };
    });

    if (!outcome.replayed) await this.auditSafe({
      tenantId, factoryId, userId, action: 'MRP_CAPACITY_PLAN_CREATED',
      resourceType: 'MRP_CAPACITY_PLAN', id: outcome.id, requestId, traceId,
      payload: { sourceMrpPlanId: sourceId, scenarioName, replayed: false },
    });
    return { ...(await this.getCapacityPlan(userId, tenantId, factoryId, outcome.id)), replayed: outcome.replayed };
  }

  async listCapacityPlans(userId: string, tenantId: string, factoryId: string, sourceMrpPlanId: string, rawLimit = 50) {
    this.assertScope(userId, tenantId, factoryId);
    const sourceId = this.uuid(sourceMrpPlanId, 'sourceMrpPlanId');
    const limit = this.limit(rawLimit, 100);
    const result = await this.database.query(
      `SELECT cp.id::text AS id,cp.source_mrp_plan_id::text AS source_mrp_plan_id,cp.plan_version,
        cp.scenario_name,cp.frozen_horizon_days,cp.compare_to_capacity_plan_id::text AS compare_to_capacity_plan_id,
        cp.summary,cp.created_by_user_id::text AS created_by_user_id,cp.created_at::text AS created_at
       FROM mrp_capacity_plans cp WHERE cp.source_mrp_plan_id=$1 AND cp.tenant_id=$2 AND cp.factory_id=$3
       ORDER BY cp.plan_version DESC LIMIT $4`,
      [sourceId, tenantId, factoryId, limit], { tenantId, userId },
    );
    return result.rows;
  }

  async getCapacityPlan(userId: string, tenantId: string, factoryId: string, capacityPlanId: string) {
    this.assertScope(userId, tenantId, factoryId);
    const id = this.uuid(capacityPlanId, 'capacityPlanId');
    const header = await this.database.query<CapacityPlanHeader>(
      `SELECT cp.id::text AS id,cp.tenant_id::text AS tenant_id,cp.factory_id::text AS factory_id,
        cp.source_mrp_plan_id::text AS source_mrp_plan_id,cp.plan_version,cp.scenario_name,cp.frozen_horizon_days,
        cp.compare_to_capacity_plan_id::text AS compare_to_capacity_plan_id,cp.idempotency_key,cp.request_hash,
        cp.correlation_id::text AS correlation_id,cp.created_by_user_id::text AS created_by_user_id,
        cp.scenario_inputs,cp.summary,cp.exceptions,cp.frozen_horizon_diff,cp.created_at::text AS created_at,
        mp.horizon_start::text AS horizon_start,mp.horizon_end::text AS horizon_end
       FROM mrp_capacity_plans cp JOIN mrp_plans mp ON mp.id=cp.source_mrp_plan_id
        AND mp.tenant_id=cp.tenant_id AND mp.factory_id=cp.factory_id
       WHERE cp.id=$1 AND cp.tenant_id=$2 AND cp.factory_id=$3`,
      [id, tenantId, factoryId], { tenantId, userId },
    );
    const plan = header.rows[0];
    if (!plan) throw new NotFoundException('Finite-capacity plan was not found in this factory');
    const ops = await this.database.query(
      `SELECT id::text AS id,order_id::text AS order_id,order_line_id::text AS order_line_id,
        order_number,order_line_number,product_id::text AS product_id,product_code,product_name,style_code,size_code,
        product_version_id::text AS product_version_id,product_version_number,routing_step_id::text AS routing_step_id,
        step_number,need_by_date::text AS need_by_date,planned_quantity::text AS planned_quantity,
        operation_code,operation_name,work_centre_id::text AS work_centre_id,work_centre_code,required_skill,
        setup_minutes::text AS setup_minutes,run_minutes_per_unit::text AS run_minutes_per_unit,
        capacity_units_per_hour::text AS capacity_units_per_hour,required_minutes::text AS required_minutes,
        scheduled_minutes::text AS scheduled_minutes,planned_start_date::text AS planned_start_date,
        planned_finish_date::text AS planned_finish_date,status,conflict_codes
       FROM mrp_capacity_plan_operations WHERE capacity_plan_id=$1 AND tenant_id=$2 AND factory_id=$3
       ORDER BY need_by_date,order_number,order_line_number,step_number,id`,
      [id, tenantId, factoryId], { tenantId, userId },
    );
    const allocations = await this.database.query(
      `SELECT a.operation_id::text AS operation_id,a.calendar_entry_id::text AS calendar_entry_id,
        a.capacity_date::text AS capacity_date,a.shift_template_id::text AS shift_template_id,
        a.shift_code,a.work_centre_id::text AS work_centre_id,a.line_code,
        a.allocated_minutes::text AS allocated_minutes,a.required_skill,a.worker_allocations
       FROM mrp_capacity_plan_allocations a WHERE a.capacity_plan_id=$1 AND a.tenant_id=$2 AND a.factory_id=$3
       ORDER BY a.capacity_date,a.shift_code,a.work_centre_id,a.line_code,a.operation_id`,
      [id, tenantId, factoryId], { tenantId, userId },
    );
    const byOperation = new Map<string, Record<string, unknown>[]>();
    for (const allocation of allocations.rows) {
      const operationId = String(allocation.operation_id);
      const list = byOperation.get(operationId) ?? [];
      list.push(allocation as Record<string, unknown>);
      byOperation.set(operationId, list);
    }
    return { ...plan, operations: ops.rows.map((operation) => ({ ...operation, allocations: byOperation.get(String(operation.id)) ?? [] })) };
  }

  private async getCalendarEntry(userId: string, tenantId: string, factoryId: string, id: string) {
    const result = await this.database.query<CapacityCalendarRow>(
      'SELECT ' + CALENDAR_COLUMNS + `
       FROM mrp_capacity_calendar c
       JOIN manufacturing_work_centres wc ON wc.id=c.work_centre_id AND wc.tenant_id=c.tenant_id AND wc.factory_id=c.factory_id
       JOIN workforce_shift_templates st ON st.id=c.shift_template_id AND st.tenant_id=c.tenant_id AND st.factory_id=c.factory_id
       WHERE c.id=$1 AND c.tenant_id=$2 AND c.factory_id=$3`,
      [id, tenantId, factoryId], { tenantId, userId },
    );
    if (!result.rows[0]) throw new NotFoundException('Capacity calendar entry was not found in this factory');
    return result.rows[0];
  }

  private async getComparisonHeader(
    client: PoolClient, id: string, sourceId: string, tenantId: string, factoryId: string,
  ): Promise<CapacityPlanHeader> {
    const result = await client.query<CapacityPlanHeader>(
      `SELECT cp.id::text AS id,cp.tenant_id::text AS tenant_id,cp.factory_id::text AS factory_id,
        cp.source_mrp_plan_id::text AS source_mrp_plan_id,cp.plan_version,cp.scenario_name,cp.frozen_horizon_days,
        cp.compare_to_capacity_plan_id::text AS compare_to_capacity_plan_id,cp.idempotency_key,cp.request_hash,
        cp.correlation_id::text AS correlation_id,cp.created_by_user_id::text AS created_by_user_id,
        cp.scenario_inputs,cp.summary,cp.exceptions,cp.frozen_horizon_diff,cp.created_at::text AS created_at,
        mp.horizon_start::text AS horizon_start,mp.horizon_end::text AS horizon_end
       FROM mrp_capacity_plans cp JOIN mrp_plans mp ON mp.id=cp.source_mrp_plan_id
        AND mp.tenant_id=cp.tenant_id AND mp.factory_id=cp.factory_id
       WHERE cp.id=$1 AND cp.source_mrp_plan_id=$2 AND cp.tenant_id=$3 AND cp.factory_id=$4`,
      [id, sourceId, tenantId, factoryId],
    );
    if (!result.rows[0]) throw new NotFoundException('Comparison scenario was not found for this source MRP plan');
    return result.rows[0];
  }

  private async readBaselineOperations(
    client: PoolClient, planId: string, tenantId: string, factoryId: string,
  ): Promise<MrpCapacityBaselineOperation[]> {
    const [ops, allocations] = await Promise.all([
      client.query<{ order_line_id: string; step_number: number; status: string; planned_start_date: string | null; planned_finish_date: string | null; required_minutes: string }>(
        `SELECT order_line_id::text AS order_line_id,step_number,status,
          planned_start_date::text AS planned_start_date,planned_finish_date::text AS planned_finish_date,
          required_minutes::text AS required_minutes
         FROM mrp_capacity_plan_operations WHERE capacity_plan_id=$1 AND tenant_id=$2 AND factory_id=$3
         ORDER BY order_line_id,step_number`,
        [planId, tenantId, factoryId],
      ),
      client.query<BaselineAllocationRow>(
        `SELECT a.operation_id::text AS operation_id,op.order_line_id::text AS order_line_id,op.step_number,
          a.calendar_entry_id::text AS calendar_entry_id,a.capacity_date::text AS capacity_date,
          a.shift_template_id::text AS shift_template_id,a.work_centre_id::text AS work_centre_id,
          a.line_code,a.allocated_minutes::text AS allocated_minutes,a.worker_allocations
         FROM mrp_capacity_plan_allocations a JOIN mrp_capacity_plan_operations op
          ON op.id=a.operation_id AND op.tenant_id=a.tenant_id AND op.factory_id=a.factory_id
         WHERE a.capacity_plan_id=$1 AND a.tenant_id=$2 AND a.factory_id=$3
         ORDER BY op.order_line_id,op.step_number,a.capacity_date,a.shift_template_id,a.calendar_entry_id`,
        [planId, tenantId, factoryId],
      ),
    ]);
    const grouped = new Map<string, BaselineAllocationRow[]>();
    for (const allocation of allocations.rows) {
      const key = allocation.order_line_id + '|' + allocation.step_number;
      const list = grouped.get(key) ?? [];
      list.push(allocation);
      grouped.set(key, list);
    }
    return ops.rows.map((op) => ({
      orderLineId: op.order_line_id, stepNumber: op.step_number, status: op.status,
      plannedStartDate: op.planned_start_date, plannedFinishDate: op.planned_finish_date,
      requiredMinutes: op.required_minutes,
      allocations: (grouped.get(op.order_line_id + '|' + op.step_number) ?? []).map((allocation) => ({
        calendarEntryId: allocation.calendar_entry_id, capacityDate: allocation.capacity_date,
        shiftTemplateId: allocation.shift_template_id, workCentreId: allocation.work_centre_id,
        lineCode: allocation.line_code, allocatedMinutes: allocation.allocated_minutes,
        workerAllocations: Array.isArray(allocation.worker_allocations) ? allocation.worker_allocations.map((worker) => ({
          workerId: worker.worker_id, allocatedMinutes: worker.allocated_minutes,
        })) : [],
      })),
    }));
  }

  private async insertOutbox(client: PoolClient, input: {
    tenantId: string; factoryId: string; aggregateType: string; aggregateId: string;
    eventType: string; correlationId: string; requestId: string | null; userId: string;
    payload: Record<string, unknown>;
  }) {
    await client.query(
      `INSERT INTO outbox_events (
        tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,
        correlation_id,causation_id,actor,source,payload
      ) VALUES ($1,$2,$3,$4,$5,1,clock_timestamp(),$6::uuid,$7::uuid,$8::jsonb,$9::jsonb,$10::jsonb)`,
      [input.tenantId, input.factoryId, input.aggregateType, input.aggregateId, input.eventType,
        input.correlationId, this.validUuid(input.requestId),
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'mrp-finite-capacity-service', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
        JSON.stringify(input.payload)],
    );
  }

  private async auditSafe(input: {
    tenantId: string; factoryId: string; userId: string; action: string; resourceType: string;
    id: string; requestId: string | null; traceId: string | null; payload: Record<string, unknown>;
  }) {
    try {
      await this.audit.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.userId,
        eventType: 'MRP_CAPACITY', action: input.action, resourceType: input.resourceType, resourceId: input.id,
        requestId: this.validUuid(input.requestId),
        correlationId: this.validUuid(input.traceId) ?? this.validUuid(input.requestId),
        dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // Transactional outbox preserves state-change evidence if the audit sink is unavailable.
    }
  }

  private normalizeAdjustments(values: CreateMrpCapacityPlanDto['capacity_adjustments']): MrpCapacityScenarioAdjustment[] {
    const adjusted = (values ?? []).map((value) => ({
      workCentreId: this.uuid(value.work_centre_id, 'capacity_adjustments.work_centre_id'),
      shiftTemplateId: this.uuid(value.shift_template_id, 'capacity_adjustments.shift_template_id'),
      capacityDate: this.calendarDate(value.capacity_date, 'capacity_adjustments.capacity_date'),
      lineCode: value.line_code.trim().toUpperCase(),
      deltaAvailableMinutes: value.delta_available_minutes,
      deltaParallelLines: value.delta_parallel_lines,
    }));
    for (const value of adjusted) {
      if (!value.lineCode || value.lineCode.length > 100) throw new BadRequestException('Capacity adjustment line_code must contain 1 to 100 characters');
      if (!Number.isInteger(value.deltaAvailableMinutes) || value.deltaAvailableMinutes < -1440 || value.deltaAvailableMinutes > 1440
        || !Number.isInteger(value.deltaParallelLines) || value.deltaParallelLines < -99 || value.deltaParallelLines > 99) {
        throw new BadRequestException('Scenario capacity deltas are outside the supported range');
      }
    }
    adjusted.sort((left, right) => left.capacityDate.localeCompare(right.capacityDate)
      || left.shiftTemplateId.localeCompare(right.shiftTemplateId)
      || left.workCentreId.localeCompare(right.workCentreId)
      || left.lineCode.localeCompare(right.lineCode));
    return adjusted;
  }

  private validateCapacityNumbers(minutes: number, lines: number) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new BadRequestException('available_minutes must be between 0 and 1440');
    if (!Number.isInteger(lines) || lines < 1 || lines > 100) throw new BadRequestException('parallel_lines must be between 1 and 100');
  }
  private assertScope(userId: string, tenantId: string, factoryId: string) {
    this.uuid(userId, 'userId'); this.uuid(tenantId, 'tenantId'); this.uuid(factoryId, 'factoryId');
  }
  private uuid(value: string, name: string): string {
    if (!isUUID(value)) throw new BadRequestException(name + ' must be a valid UUID');
    return value.toLowerCase();
  }
  private validUuid(value: string | null): string | null { return value && isUUID(value) ? value : null; }
  private idempotencyKey(value: string | null): string {
    const key = value?.trim() ?? '';
    if (!key || key.length > 255) throw new BadRequestException('Idempotency-Key is required and must not exceed 255 characters');
    return key;
  }
  private calendarDate(value: string, field: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(field + ' must be a valid YYYY-MM-DD date');
    const parsed = new Date(value + 'T00:00:00.000Z');
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new BadRequestException(field + ' must be a valid calendar date');
    return value;
  }
  private daysBetween(start: string, end: string): number {
    return (Date.parse(end + 'T00:00:00.000Z') - Date.parse(start + 'T00:00:00.000Z')) / 86_400_000;
  }
  private correlationId(traceId: string | null, requestId: string | null) {
    return (traceId && isUUID(traceId) ? traceId : null) ?? (requestId && isUUID(requestId) ? requestId : null) ?? randomUUID();
  }
  private hash(value: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private limit(value: number, maximum: number): number {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new BadRequestException('limit must be an integer between 1 and ' + maximum);
    return value;
  }
}
