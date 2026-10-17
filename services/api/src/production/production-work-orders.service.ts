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
import { InventoryReservationService } from '../inventory/inventory.reservation.service';
import { CreateWorkOrderDto } from './dto/create-work-order.dto';
import { OperationEventDto } from './dto/operation-event.dto';
import { WorkOrderOutputReportDto } from './dto/work-order-output-report.dto';
import { WorkOrderTransitionDto } from './dto/work-order-transition.dto';
import {
  assertPrecedingOperationsComplete,
  assertTargetQuantityNotExceeded,
  assertWorkOrderTransition,
  assertDowntimeCanStart,
  assertDowntimeCanEnd,
  assertWipSnapshotQuantity,
  assertWipTransfer,
  assertReworkQuantity,
  nextOperationStatus,
  type OperationCommand,
  type OperationStatus,
  type WorkOrderStatus,
} from './work-order-lifecycle';

interface WorkOrderRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  work_order_number: string;
  source_order_id: string;
  source_order_line_id: string;
  product_id: string;
  product_version_id: string;
  finished_item_id: string;
  target_quantity: string;
  planned_start_date: string;
  due_date: string;
  priority: number;
  status: WorkOrderStatus;
  row_version: number;
  notes: string | null;
  hold_reason: string | null;
  released_by_user_id: string | null;
  released_at: string | null;
  completed_at: string | null;
  cancelled_by_user_id: string | null;
  cancelled_at: string | null;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
}

interface OperationRow extends QueryResultRow {
  id: string;
  work_order_id: string;
  product_id: string;
  product_version_id: string;
  product_routing_step_id: string;
  step_number: number;
  operation_code: string;
  operation_name: string;
  work_centre_id: string;
  work_centre_code: string;
  work_centre_name: string;
  setup_minutes: string;
  run_minutes_per_unit: string;
  queue_minutes: string;
  transfer_minutes: string;
  required_skill: string | null;
  instructions: string | null;
  is_quality_gate: boolean;
  status: OperationStatus;
  started_at: string | null;
  active_started_at: string | null;
  completed_at: string | null;
  downtime_started_at: string | null;
  actual_run_minutes: string;
  downtime_minutes: string;
  wip_quantity: string;
  row_version: number;
  updated_at: string;
}

interface SourceOrderLine extends QueryResultRow {
  order_id: string;
  order_number: string;
  order_status: string;
  order_date: string;
  order_requested_delivery_date: string | null;
  order_line_id: string;
  order_line_number: number;
  line_quantity: string;
  line_requested_delivery_date: string | null;
  finished_item_id: string | null;
  finished_item_unit: string | null;
  product_id: string | null;
  product_code: string | null;
  product_name: string | null;
  product_status: string | null;
  product_version_id: string | null;
  product_version_number: number | null;
  product_version_state: string | null;
  expected_yield_percent: string | null;
}

interface RoutingRow extends QueryResultRow {
  id: string;
  product_id: string;
  product_version_id: string;
  step_number: number;
  operation_code: string;
  operation_name: string;
  work_centre_id: string;
  work_centre_code: string;
  work_centre_name: string;
  setup_minutes: string;
  run_minutes_per_unit: string;
  queue_minutes: string;
  transfer_minutes: string;
  required_skill: string | null;
  instructions: string | null;
  is_quality_gate: boolean;
}

interface BomMaterialRow extends QueryResultRow {
  bom_line_id: string;
  line_number: number;
  component_item_id: string;
  component_sku: string;
  component_name: string;
  component_unit: string;
  base_quantity_per: string;
  expected_yield_percent: string;
  wastage_percent: string;
  required_quantity: string;
}

interface WorkOrderMaterialRow extends QueryResultRow {
  id: string;
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  component_name: string;
  component_unit: string;
  required_quantity: string;
  reservation_id: string | null;
  location_id: string | null;
  reserved_quantity: string | null;
  reservation_status: string | null;
}

interface IdempotencyRow extends QueryResultRow {
  id: string;
  work_order_id: string;
  request_hash: string;
}

interface ProductionTotals extends QueryResultRow {
  good_quantity: string;
  scrap_quantity: string;
}

interface EventInput {
  tenantId: string;
  factoryId: string;
  workOrderId: string;
  operationId?: string | null;
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  source?: string;
  deviceId?: string | null;
  occurredAt?: string | null;
  idempotencyKey: string;
  requestHash: string;
  actorUserId: string;
  payload: Record<string, unknown>;
  correlationId: string;
  requestId: string | null;
}

const WORK_ORDER_COLUMNS = `
  id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
  work_order_number, source_order_id::text AS source_order_id,
  source_order_line_id::text AS source_order_line_id, product_id::text AS product_id,
  product_version_id::text AS product_version_id, finished_item_id::text AS finished_item_id,
  target_quantity::text AS target_quantity, planned_start_date::text AS planned_start_date,
  due_date::text AS due_date, priority, status, row_version::int AS row_version, notes, hold_reason,
  released_by_user_id::text AS released_by_user_id, released_at::text AS released_at,
  completed_at::text AS completed_at, cancelled_by_user_id::text AS cancelled_by_user_id,
  cancelled_at::text AS cancelled_at, created_by_user_id::text AS created_by_user_id,
  updated_by_user_id::text AS updated_by_user_id, created_at::text AS created_at,
  updated_at::text AS updated_at
`;

const OPERATION_COLUMNS = `
  op.id::text AS id, op.work_order_id::text AS work_order_id,
  op.product_id::text AS product_id, op.product_version_id::text AS product_version_id,
  op.product_routing_step_id::text AS product_routing_step_id,
  op.step_number, op.operation_code, op.operation_name, op.work_centre_id::text AS work_centre_id,
  wc.code AS work_centre_code, wc.name AS work_centre_name,
  op.setup_minutes::text AS setup_minutes, op.run_minutes_per_unit::text AS run_minutes_per_unit,
  op.queue_minutes::text AS queue_minutes, op.transfer_minutes::text AS transfer_minutes,
  op.required_skill, op.instructions, op.is_quality_gate, op.status,
  op.started_at::text AS started_at, op.active_started_at::text AS active_started_at,
  op.completed_at::text AS completed_at, op.downtime_started_at::text AS downtime_started_at,
  op.actual_run_minutes::text AS actual_run_minutes, op.downtime_minutes::text AS downtime_minutes,
  op.wip_quantity::text AS wip_quantity, op.row_version::int AS row_version, op.updated_at::text AS updated_at
`;

@Injectable()
export class ProductionWorkOrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
    private readonly inventoryReservationService: InventoryReservationService,
  ) {}

  async createWorkOrder(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateWorkOrderDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const key = this.requiredIdempotencyKey(rawIdempotencyKey);
    const targetQuantity = this.normalizeQuantity(dto.target_quantity, 'target_quantity');
    const plannedStart = this.calendarDate(
      dto.planned_start_date ?? new Date().toISOString().slice(0, 10),
      'planned_start_date',
    );
    const dueDate = dto.due_date
      ? this.calendarDate(dto.due_date, 'due_date')
      : null;
    const priority = dto.priority ?? 3;
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      throw new BadRequestException('priority must be an integer between 1 and 5');
    }
    this.uuid(dto.order_line_id, 'order_line_id');
    const notes = dto.notes?.trim() || null;
    const requestHash = this.hash({
      order_line_id: dto.order_line_id.toLowerCase(),
      target_quantity: targetQuantity,
      planned_start_date: plannedStart,
      due_date: dueDate,
      priority,
      notes,
    });
    const correlationId = this.correlationId(traceId, requestId);

    const result = await this.database.transaction({
      tenantId, userId, requestId, traceId,
      advisoryLockKey: `production-work-order:create:${tenantId}:${factoryId}:${key}`,
    }, async (client) => {
      const existing = await client.query<IdempotencyRow>(`
        SELECT id::text AS id, id::text AS work_order_id, request_hash
        FROM work_orders
        WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
        FOR UPDATE
      `, [tenantId, factoryId, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was already used for a different work-order request');
        }
        return { workOrderId: existing.rows[0].id, replayed: true as const };
      }

      const sourceResult = await client.query<SourceOrderLine>(`
        SELECT
          o.id::text AS order_id, o.order_number, o.status AS order_status,
          o.order_date::text AS order_date,
          o.requested_delivery_date::text AS order_requested_delivery_date,
          ol.id::text AS order_line_id, ol.line_number AS order_line_number,
          ol.quantity::text AS line_quantity,
          ol.requested_delivery_date::text AS line_requested_delivery_date,
          i.id::text AS finished_item_id, i.unit AS finished_item_unit,
          p.id::text AS product_id, p.product_code, p.product_name, p.status AS product_status,
          pv.id::text AS product_version_id, pv.version_number AS product_version_number,
          pv.state AS product_version_state, pv.expected_yield_percent::text AS expected_yield_percent
        FROM order_lines ol
        JOIN orders o
          ON o.id = ol.order_id AND o.tenant_id = ol.tenant_id AND o.factory_id = ol.factory_id
        LEFT JOIN inventory_items i
          ON i.id = ol.inventory_item_id AND i.tenant_id = ol.tenant_id AND i.factory_id = ol.factory_id
        LEFT JOIN product_definitions p
          ON p.inventory_item_id = i.id AND p.tenant_id = $1 AND p.factory_id = $2
        LEFT JOIN LATERAL (
          SELECT v.id, v.version_number, v.state, v.expected_yield_percent
          FROM product_versions v
          WHERE v.product_id = p.id
            AND v.tenant_id = $1 AND v.factory_id = $2
            AND v.state IN ('APPROVED', 'RETIRED')
            AND v.effective_from <= $4::date
            AND COALESCE(v.effective_to_override, v.effective_to, 'infinity'::date) >= $4::date
          ORDER BY v.effective_from DESC, v.version_number DESC
          LIMIT 1
        ) pv ON TRUE
        WHERE ol.id = $3 AND ol.tenant_id = $1 AND ol.factory_id = $2
        FOR UPDATE OF o, ol
      `, [tenantId, factoryId, dto.order_line_id, plannedStart]);
      const source = sourceResult.rows[0];
      if (!source) throw new NotFoundException('Sales order line was not found in this factory');
      if (!['CONFIRMED', 'IN_PROGRESS'].includes(source.order_status)) {
        throw new ConflictException('A work order can only be planned for a confirmed or in-progress sales order');
      }
      if (!source.finished_item_id) {
        throw new ConflictException('Bind the sales order line to an inventory finished-good item before creating production work');
      }
      if (!source.product_id || source.product_status !== 'ACTIVE' || !source.product_version_id) {
        throw new ConflictException('The finished good has no active product definition with an approved revision effective on the planned start date');
      }

      const dueDateFinal = dueDate
        ?? source.line_requested_delivery_date
        ?? source.order_requested_delivery_date
        ?? source.order_date;

      const readiness = await client.query<{ bom_count: number; inactive_bom_count: number; route_count: number; inactive_route_count: number }>(`
        SELECT
          (SELECT count(*)::int FROM product_bom_lines b
            WHERE b.tenant_id = $1 AND b.factory_id = $2
              AND b.product_id = $3 AND b.product_version_id = $4) AS bom_count,
          (SELECT count(*)::int FROM product_bom_lines b
            JOIN inventory_items i
              ON i.id = b.component_item_id AND i.tenant_id = b.tenant_id AND i.factory_id = b.factory_id
            WHERE b.tenant_id = $1 AND b.factory_id = $2
              AND b.product_id = $3 AND b.product_version_id = $4 AND i.status <> 'ACTIVE') AS inactive_bom_count,
          (SELECT count(*)::int FROM product_routing_steps r
            WHERE r.tenant_id = $1 AND r.factory_id = $2
              AND r.product_id = $3 AND r.product_version_id = $4) AS route_count,
          (SELECT count(*)::int FROM product_routing_steps r
            JOIN manufacturing_work_centres wc
              ON wc.id = r.work_centre_id AND wc.tenant_id = r.tenant_id AND wc.factory_id = r.factory_id
            WHERE r.tenant_id = $1 AND r.factory_id = $2
              AND r.product_id = $3 AND r.product_version_id = $4 AND wc.status <> 'ACTIVE') AS inactive_route_count
      `, [tenantId, factoryId, source.product_id, source.product_version_id]);
      const ready = readiness.rows[0];
      if (!ready || ready.bom_count < 1 || ready.route_count < 1) {
        throw new ConflictException('The effective product revision must contain at least one BOM line and one routing operation');
      }
      if (ready.inactive_bom_count > 0 || ready.inactive_route_count > 0) {
        throw new ConflictException('The product revision contains an inactive BOM component or work centre');
      }

      const reportTotals = await client.query<ProductionTotals>(`
        SELECT
          COALESCE(SUM(good_quantity), 0)::text AS good_quantity,
          COALESCE(SUM(scrap_quantity), 0)::text AS scrap_quantity
        FROM order_production_reports
        WHERE tenant_id = $1 AND factory_id = $2 AND order_line_id = $3
      `, [tenantId, factoryId, source.order_line_id]);
      const activeWork = await client.query<{ remaining_quantity: string }>(`
        SELECT COALESCE(SUM(GREATEST(wo.target_quantity - COALESCE(output.processed_quantity, 0), 0)), 0)::text
          AS remaining_quantity
        FROM work_orders wo
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(r.good_quantity + r.scrap_quantity), 0)::numeric(18,4) AS processed_quantity
          FROM order_production_reports r
          WHERE r.work_order_id = wo.id AND r.tenant_id = wo.tenant_id AND r.factory_id = wo.factory_id
        ) output ON TRUE
        WHERE wo.tenant_id = $1 AND wo.factory_id = $2
          AND wo.source_order_line_id = $3
          AND wo.status IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD')
      `, [tenantId, factoryId, source.order_line_id]);
      const goodReported = this.toUnits(reportTotals.rows[0]?.good_quantity ?? '0.0000');
      const orderTarget = this.toUnits(source.line_quantity);
      const remainingActiveWork = this.toUnits(activeWork.rows[0]?.remaining_quantity ?? '0.0000');
      const remainingOrderQuantity = orderTarget - goodReported - remainingActiveWork;
      if (this.toUnits(targetQuantity) > remainingOrderQuantity) {
        throw new ConflictException(
          `Work-order target exceeds the unallocated sales-order quantity (remaining ${this.fromUnits(remainingOrderQuantity)}).`,
        );
      }

      const routes = await client.query<RoutingRow>(`
        SELECT
          r.id::text AS id, r.product_id::text AS product_id,
          r.product_version_id::text AS product_version_id, r.step_number,
          r.operation_code, r.operation_name, r.work_centre_id::text AS work_centre_id,
          wc.code AS work_centre_code, wc.name AS work_centre_name,
          r.setup_minutes::text AS setup_minutes, r.run_minutes_per_unit::text AS run_minutes_per_unit,
          r.queue_minutes::text AS queue_minutes, r.transfer_minutes::text AS transfer_minutes,
          r.required_skill, r.instructions, r.is_quality_gate
        FROM product_routing_steps r
        JOIN manufacturing_work_centres wc
          ON wc.id = r.work_centre_id AND wc.tenant_id = r.tenant_id AND wc.factory_id = r.factory_id
        WHERE r.tenant_id = $1 AND r.factory_id = $2
          AND r.product_id = $3 AND r.product_version_id = $4 AND wc.status = 'ACTIVE'
        ORDER BY r.step_number
        FOR SHARE OF r, wc
      `, [tenantId, factoryId, source.product_id, source.product_version_id]);
      if (routes.rows.length !== ready.route_count) {
        throw new ConflictException('A routing work centre became inactive during work-order creation');
      }

      const workOrderId = randomUUID();
      const workOrderNumber = `WO-${source.order_number.slice(0, 60)}-${workOrderId.slice(0, 8).toUpperCase()}`;
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO work_orders (
          id, tenant_id, factory_id, work_order_number, source_order_id, source_order_line_id,
          product_id, product_version_id, finished_item_id, target_quantity, planned_start_date,
          due_date, priority, status, row_version, idempotency_key, request_hash, notes,
          created_by_user_id, updated_by_user_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::date, $12::date,
          $13, 'DRAFT', 1, $14, $15, $16, $17, $17
        )
        RETURNING id::text AS id
      `, [
        workOrderId, tenantId, factoryId, workOrderNumber, source.order_id, source.order_line_id,
        source.product_id, source.product_version_id, source.finished_item_id, targetQuantity,
        plannedStart, dueDateFinal, priority, key, requestHash, notes, userId,
      ]);
      if (!inserted.rows[0]) throw new Error('WORK_ORDER_CREATE_FAILED');

      const materialRows = await client.query<BomMaterialRow>(`
        SELECT b.id::text AS bom_line_id, b.line_number,
          b.component_item_id::text AS component_item_id,
          i.sku AS component_sku, i.name AS component_name, b.inventory_base_unit AS component_unit,
          b.base_quantity_per::text AS base_quantity_per,
          pv.expected_yield_percent::text AS expected_yield_percent,
          b.wastage_percent::text AS wastage_percent,
          (CEIL((
            $5::numeric * 100::numeric / pv.expected_yield_percent
            * b.base_quantity_per
            * (1 + b.wastage_percent / 100::numeric)
          ) * 10000) / 10000)::numeric(18,4)::text AS required_quantity
        FROM product_bom_lines b
        JOIN product_versions pv
          ON pv.id = b.product_version_id AND pv.tenant_id = b.tenant_id
         AND pv.factory_id = b.factory_id AND pv.product_id = b.product_id
        JOIN inventory_items i
          ON i.id = b.component_item_id AND i.tenant_id = b.tenant_id AND i.factory_id = b.factory_id
        WHERE b.tenant_id = $1 AND b.factory_id = $2
          AND b.product_id = $3 AND b.product_version_id = $4
        ORDER BY b.line_number
        FOR SHARE OF b, pv, i
      `, [tenantId, factoryId, source.product_id, source.product_version_id, targetQuantity]);
      if (materialRows.rows.length !== ready.bom_count) {
        throw new ConflictException('Material requirements changed while the work order was being created');
      }
      for (const material of materialRows.rows) {
        await client.query(`
          INSERT INTO work_order_material_requirements (
            tenant_id, factory_id, work_order_id, product_id, product_version_id,
            bom_line_id, component_item_id, line_number, component_sku, component_name,
            component_unit, base_quantity_per, expected_yield_percent, wastage_percent, required_quantity
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12::numeric, $13::numeric, $14::numeric, $15::numeric
          )
        `, [
          tenantId, factoryId, workOrderId, source.product_id, source.product_version_id,
          material.bom_line_id, material.component_item_id, material.line_number,
          material.component_sku, material.component_name, material.component_unit,
          material.base_quantity_per, material.expected_yield_percent, material.wastage_percent,
          material.required_quantity,
        ]);
      }

      for (const route of routes.rows) {
        await client.query(`
          INSERT INTO work_order_operations (
            tenant_id, factory_id, work_order_id, product_id, product_version_id,
            product_routing_step_id, step_number, operation_code, operation_name,
            work_centre_id, setup_minutes, run_minutes_per_unit, queue_minutes, transfer_minutes,
            required_skill, instructions, is_quality_gate
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15, $16, $17
          )
        `, [
          tenantId, factoryId, workOrderId, source.product_id, source.product_version_id,
          route.id, route.step_number, route.operation_code, route.operation_name,
          route.work_centre_id, route.setup_minutes, route.run_minutes_per_unit,
          route.queue_minutes, route.transfer_minutes, route.required_skill, route.instructions,
          route.is_quality_gate,
        ]);
      }

      await this.appendEvent(client, {
        tenantId, factoryId, workOrderId,
        eventType: 'WORK_ORDER_CREATED',
        fromStatus: null, toStatus: 'DRAFT',
        source: 'API', occurredAt: null, deviceId: null,
        idempotencyKey: this.scopedEventKey(workOrderId, 'CREATE', key),
        requestHash, actorUserId: userId,
        correlationId, requestId,
        payload: {
          work_order_number: workOrderNumber,
          source_order_id: source.order_id,
          source_order_number: source.order_number,
          source_order_line_id: source.order_line_id,
          product_id: source.product_id,
          product_version_id: source.product_version_id,
          product_version_number: source.product_version_number,
          target_quantity: targetQuantity,
          operation_count: routes.rows.length,
          material_requirement_count: materialRows.rows.length,
          required_materials: materialRows.rows.map((item) => ({
            bom_line_id: item.bom_line_id, component_item_id: item.component_item_id,
            line_number: item.line_number, required_quantity: item.required_quantity,
            component_unit: item.component_unit,
          })),
        },
      });
      return { workOrderId, replayed: false as const };
    });

    const workOrder = await this.getWorkOrder(userId, tenantId, factoryId, result.workOrderId);
    if (!result.replayed) {
      await this.auditSafe({
        tenantId, factoryId, userId, action: 'WORK_ORDER_CREATED',
        id: result.workOrderId, requestId, traceId,
        payload: {
          work_order_number: workOrder.work_order_number,
          target_quantity: workOrder.target_quantity,
          operation_count: (workOrder.operations as unknown[]).length,
        },
      });
    }
    return { ...workOrder, replayed: result.replayed };
  }

  async listWorkOrders(
    userId: string,
    tenantId: string,
    factoryId: string,
    rawLimit = 50,
    status?: string,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const limit = this.limit(rawLimit);
    const allowed: WorkOrderStatus[] = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
    if (status && !allowed.includes(status as WorkOrderStatus)) {
      throw new BadRequestException('status is not a valid work-order lifecycle state');
    }
    const result = await this.database.query(`
      SELECT ${WORK_ORDER_COLUMNS},
        (SELECT count(*)::int FROM work_order_operations op
          WHERE op.work_order_id = wo.id AND op.tenant_id = wo.tenant_id AND op.factory_id = wo.factory_id) AS operation_count,
        (SELECT COALESCE(SUM(r.good_quantity), 0)::text FROM order_production_reports r
          WHERE r.work_order_id = wo.id AND r.tenant_id = wo.tenant_id AND r.factory_id = wo.factory_id) AS good_quantity,
        (SELECT COALESCE(SUM(r.scrap_quantity), 0)::text FROM order_production_reports r
          WHERE r.work_order_id = wo.id AND r.tenant_id = wo.tenant_id AND r.factory_id = wo.factory_id) AS scrap_quantity
      FROM work_orders wo
      WHERE wo.tenant_id = $1 AND wo.factory_id = $2
        AND ($3::text IS NULL OR wo.status = $3)
      ORDER BY CASE WHEN wo.status IN ('IN_PROGRESS', 'ON_HOLD') THEN 0 ELSE 1 END,
        wo.due_date, wo.priority, wo.created_at DESC, wo.id
      LIMIT $4
    `, [tenantId, factoryId, status ?? null, limit], { tenantId, userId });
    return result.rows;
  }

  async getWorkOrder(userId: string, tenantId: string, factoryId: string, workOrderId: string) {
    this.assertScope(userId, tenantId, factoryId);
    this.uuid(workOrderId, 'workOrderId');
    const result = await this.database.query<WorkOrderRow>(`
      SELECT ${WORK_ORDER_COLUMNS},
        (SELECT COALESCE(SUM(r.good_quantity), 0)::text FROM order_production_reports r
          WHERE r.work_order_id = wo.id AND r.tenant_id = wo.tenant_id AND r.factory_id = wo.factory_id) AS good_quantity,
        (SELECT COALESCE(SUM(r.scrap_quantity), 0)::text FROM order_production_reports r
          WHERE r.work_order_id = wo.id AND r.tenant_id = wo.tenant_id AND r.factory_id = wo.factory_id) AS scrap_quantity,
        (SELECT COALESCE(SUM(r.good_quantity + r.scrap_quantity), 0)::text FROM order_production_reports r
          WHERE r.work_order_id = wo.id AND r.tenant_id = wo.tenant_id AND r.factory_id = wo.factory_id) AS processed_quantity
      FROM work_orders wo
      WHERE wo.id = $1 AND wo.tenant_id = $2 AND wo.factory_id = $3
    `, [workOrderId, tenantId, factoryId], { tenantId, userId });
    const workOrder = result.rows[0] as (WorkOrderRow & Record<string, unknown>) | undefined;
    if (!workOrder) throw new NotFoundException('Work order was not found in this factory');

    const materialsResult = await this.database.query(`
      SELECT r.id::text AS requirement_id, r.bom_line_id::text AS bom_line_id,
        r.component_item_id::text AS component_item_id, r.line_number,
        r.component_sku, r.component_name, r.component_unit,
        r.base_quantity_per::text AS base_quantity_per,
        r.expected_yield_percent::text AS expected_yield_percent,
        r.wastage_percent::text AS wastage_percent,
        r.required_quantity::text AS required_quantity,
        COALESCE(
          jsonb_agg(jsonb_build_object(
            'reservation_id', mr.reservation_id,
            'location_id', ir.location_id,
            'item_id', mr.item_id,
            'quantity', mr.quantity::text,
            'status', ir.status,
            'consumed_movement_id', ir.consumed_movement_id::text
          ) ORDER BY ir.location_id, mr.reservation_id)
          FILTER (WHERE mr.id IS NOT NULL),
          '[]'::jsonb
        ) AS reservations
      FROM work_order_material_requirements r
      LEFT JOIN work_order_material_reservations mr
        ON mr.requirement_id = r.id AND mr.work_order_id = r.work_order_id
       AND mr.tenant_id = r.tenant_id AND mr.factory_id = r.factory_id
      LEFT JOIN inventory_reservations ir
        ON ir.id = mr.reservation_id AND ir.tenant_id = mr.tenant_id AND ir.factory_id = mr.factory_id
      WHERE r.work_order_id = $1 AND r.tenant_id = $2 AND r.factory_id = $3
      GROUP BY r.id
      ORDER BY r.line_number
    `, [workOrderId, tenantId, factoryId], { tenantId, userId });

    const operationsResult = await this.database.query(`
      SELECT ${OPERATION_COLUMNS},
        (SELECT COALESCE(SUM(r.good_quantity), 0)::text FROM order_production_reports r
          WHERE r.work_order_id = op.work_order_id AND r.work_order_operation_id = op.id
            AND r.tenant_id = op.tenant_id AND r.factory_id = op.factory_id) AS reported_good_quantity,
        (SELECT COALESCE(SUM(r.scrap_quantity), 0)::text FROM order_production_reports r
          WHERE r.work_order_id = op.work_order_id AND r.work_order_operation_id = op.id
            AND r.tenant_id = op.tenant_id AND r.factory_id = op.factory_id) AS reported_scrap_quantity,
        op.wip_quantity::text AS reported_wip_quantity,
        (SELECT COALESCE(SUM((e.payload->>'quantity')::numeric), 0)::text FROM work_order_events e
          WHERE e.work_order_id = op.work_order_id AND e.operation_id = op.id
            AND e.tenant_id = op.tenant_id AND e.factory_id = op.factory_id
            AND e.event_type = 'REWORK_REPORTED') AS reported_rework_quantity
      FROM work_order_operations op
      JOIN manufacturing_work_centres wc
        ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
      WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3
      ORDER BY op.step_number
    `, [workOrderId, tenantId, factoryId], { tenantId, userId });

    const eventsResult = await this.database.query(`
      SELECT id::text AS id, operation_id::text AS operation_id, event_type, from_status, to_status,
        event_source, device_id, occurred_at::text AS occurred_at, recorded_at::text AS recorded_at,
        actor_user_id::text AS actor_user_id, payload
      FROM work_order_events
      WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
      ORDER BY recorded_at DESC, id DESC
      LIMIT 100
    `, [workOrderId, tenantId, factoryId], { tenantId, userId });

    return {
      ...workOrder,
      materials: materialsResult.rows,
      operations: operationsResult.rows,
      events: eventsResult.rows,
    };
  }

  async transitionWorkOrder(
    userId: string,
    tenantId: string,
    factoryId: string,
    workOrderId: string,
    command: 'RELEASE' | 'HOLD' | 'RESUME' | 'COMPLETE' | 'CANCEL',
    dto: WorkOrderTransitionDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    this.uuid(workOrderId, 'workOrderId');
    const key = this.requiredIdempotencyKey(rawIdempotencyKey);
    const reason = dto.reason?.trim() || null;
    if (command === 'HOLD' && !reason) throw new BadRequestException('reason is required to place a work order on hold');
    if (command === 'CANCEL' && !reason) throw new BadRequestException('reason is required to cancel a work order');
    const requestHash = this.hash({
      work_order_id: workOrderId.toLowerCase(), command, expected_version: dto.expected_version, reason,
    });
    const eventType = {
      RELEASE: 'WORK_ORDER_RELEASED',
      HOLD: 'WORK_ORDER_HELD',
      RESUME: 'WORK_ORDER_RESUMED',
      COMPLETE: 'WORK_ORDER_COMPLETED',
      CANCEL: 'WORK_ORDER_CANCELLED',
    }[command];
    const correlationId = this.correlationId(traceId, requestId);
    const result = await this.database.transaction({
      tenantId, userId, requestId, traceId,
      advisoryLockKey: `production-work-order:${command}:${tenantId}:${factoryId}:${workOrderId}:${key}`,
    }, async (client) => {
      const eventKey = this.scopedEventKey(workOrderId, command, key);
      const replay = await this.findEventReplay(client, tenantId, factoryId, eventKey, requestHash);
      if (replay) return { workOrderId, replayed: true as const };

      const orderResult = await client.query<WorkOrderRow>(`
        SELECT ${WORK_ORDER_COLUMNS}
        FROM work_orders
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        FOR UPDATE
      `, [workOrderId, tenantId, factoryId]);
      const workOrder = orderResult.rows[0];
      if (!workOrder) throw new NotFoundException('Work order was not found in this factory');
      if (workOrder.row_version !== dto.expected_version) {
        throw new ConflictException('Work order version is stale; refresh it before retrying the transition');
      }

      const targetByCommand: Record<typeof command, WorkOrderStatus> = {
        RELEASE: 'RELEASED', HOLD: 'ON_HOLD', RESUME: 'IN_PROGRESS',
        COMPLETE: 'COMPLETED', CANCEL: 'CANCELLED',
      };
      const targetStatus = targetByCommand[command];
      assertWorkOrderTransition(workOrder.status, targetStatus);

      let operationId: string | null = null;
      let operationStateChange: {
        operationId: string;
        fromStatus: OperationStatus;
        toStatus: OperationStatus;
        eventType: 'OPERATION_READY' | 'OPERATION_HELD' | 'OPERATION_PAUSED' | 'OPERATION_RESUMED';
        payload: Record<string, unknown>;
      } | null = null;
      const payload: Record<string, unknown> = { command, reason, expected_version: dto.expected_version };
      if (command === 'RELEASE') {
        const order = await this.lockSourceOrder(client, tenantId, factoryId, workOrder.source_order_id, workOrder.source_order_line_id);
        if (order.status !== 'IN_PROGRESS') {
          throw new ConflictException('The source sales order must be IN_PROGRESS before a work order can be released');
        }
        const currentRevision = await client.query<{ id: string }>(`
          SELECT id::text AS id FROM product_versions
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND product_id = $4
            AND state IN ('APPROVED', 'RETIRED') AND effective_from <= $5::date
            AND COALESCE(effective_to_override, effective_to, 'infinity'::date) >= $5::date
          FOR SHARE
        `, [workOrder.product_version_id, tenantId, factoryId, workOrder.product_id, workOrder.planned_start_date]);
        if (!currentRevision.rows[0]) {
          throw new ConflictException('The pinned product revision is no longer approved/effective on the planned start date; create a new work order from the current revision');
        }
        const route = await client.query<{ operation_count: number; inactive_centre_count: number; bom_count: number; inactive_component_count: number }>(`
          SELECT
            (SELECT count(*)::int FROM work_order_operations op
              WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3) AS operation_count,
            (SELECT count(*)::int FROM work_order_operations op
              JOIN manufacturing_work_centres wc ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
              WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3 AND wc.status <> 'ACTIVE') AS inactive_centre_count,
            (SELECT count(*)::int FROM product_bom_lines b
              WHERE b.product_version_id = $4 AND b.product_id = $5 AND b.tenant_id = $2 AND b.factory_id = $3) AS bom_count,
            (SELECT count(*)::int FROM product_bom_lines b
              JOIN inventory_items i ON i.id = b.component_item_id AND i.tenant_id = b.tenant_id AND i.factory_id = b.factory_id
              WHERE b.product_version_id = $4 AND b.product_id = $5 AND b.tenant_id = $2 AND b.factory_id = $3 AND i.status <> 'ACTIVE') AS inactive_component_count
        `, [workOrder.id, tenantId, factoryId, workOrder.product_version_id, workOrder.product_id]);
        const readiness = route.rows[0];
        if (!readiness || readiness.operation_count < 1 || readiness.bom_count < 1
          || readiness.inactive_centre_count > 0 || readiness.inactive_component_count > 0) {
          throw new ConflictException('Work order release is blocked because a BOM, routing operation, active work centre or active component is missing');
        }
        const materials = await client.query<{
          id: string;
          bom_line_id: string;
          component_item_id: string;
          component_unit: string;
          line_number: number;
          required_quantity: string;
        }>(`
          SELECT id::text AS id, bom_line_id::text AS bom_line_id,
            component_item_id::text AS component_item_id, component_unit, line_number,
            required_quantity::text AS required_quantity
          FROM work_order_material_requirements
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
          ORDER BY component_item_id, line_number
          FOR UPDATE
        `, [workOrder.id, tenantId, factoryId]);
        if (materials.rows.length !== readiness.bom_count) {
          throw new ConflictException('Work order material requirements do not match the pinned BOM; recreate the draft before release');
        }
        let reservationCount = 0;
        for (const material of materials.rows) {
          const allocations = await this.inventoryReservationService.reserveWorkOrderMaterialRequirement(client, {
            userId,
            tenantId,
            factoryId,
            workOrderId: workOrder.id,
            workOrderNumber: workOrder.work_order_number,
            requirementId: material.id,
            bomLineId: material.bom_line_id,
            itemId: material.component_item_id,
            itemUnit: material.component_unit,
            lineNumber: material.line_number,
            quantity: material.required_quantity,
            correlationId,
          });
          for (const allocation of allocations) {
            await client.query(`
              INSERT INTO work_order_material_reservations (
                tenant_id, factory_id, work_order_id, requirement_id,
                reservation_id, item_id, quantity
              ) VALUES ($1, $2, $3, $4, $5, $6, $7::numeric)
            `, [
              tenantId, factoryId, workOrder.id, material.id,
              allocation.reservationId, material.component_item_id, allocation.quantity,
            ]);
          }
          reservationCount += allocations.length;
        }
        if (reservationCount < materials.rows.length) {
          throw new ConflictException('Every BOM requirement must have an inventory reservation before release');
        }
        payload.material_requirement_count = materials.rows.length;
        payload.material_reservation_count = reservationCount;
        payload.material_requirements = materials.rows.map((material) => ({
          bom_line_id: material.bom_line_id,
          component_item_id: material.component_item_id,
          required_quantity: material.required_quantity,
          unit: material.component_unit,
        }));

        const firstOperation = await client.query<{ id: string; status: OperationStatus; row_version: number }>(`
          SELECT id::text AS id, status, row_version::int AS row_version
          FROM work_order_operations
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
          ORDER BY step_number LIMIT 1
          FOR UPDATE
        `, [workOrder.id, tenantId, factoryId]);
        if (!firstOperation.rows[0] || firstOperation.rows[0].status !== 'PLANNED') {
          throw new ConflictException('The first routing operation is not in its planned release state');
        }
        const readyUpdate = await client.query(`
          UPDATE work_order_operations
          SET status = 'READY', row_version = row_version + 1, updated_at = clock_timestamp()
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND row_version = $4
        `, [firstOperation.rows[0].id, tenantId, factoryId, firstOperation.rows[0].row_version]);
        if (readyUpdate.rowCount !== 1) throw new ConflictException('The first operation changed during work-order release');
        operationStateChange = {
          operationId: firstOperation.rows[0].id,
          fromStatus: 'PLANNED',
          toStatus: 'READY',
          eventType: 'OPERATION_READY',
          payload: { command, step_number: 1, reason: 'WORK_ORDER_RELEASED' },
        };
        payload.operation_count = readiness.operation_count;
        payload.product_version_id = workOrder.product_version_id;
      }

      if (command === 'HOLD') {
        if (!['RELEASED', 'IN_PROGRESS'].includes(workOrder.status)) {
          throw new ConflictException('Only a released or in-progress work order can be held');
        }
        const active = await client.query<OperationRow>(`
          SELECT ${OPERATION_COLUMNS}
          FROM work_order_operations op
          JOIN manufacturing_work_centres wc
            ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
          WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3
            AND op.status = 'IN_PROGRESS'
          FOR UPDATE OF op
        `, [workOrder.id, tenantId, factoryId]);
        if (active.rows.some((op) => op.downtime_started_at !== null)) {
          throw new ConflictException('End the active downtime interval before placing the work order on hold');
        }
        if (active.rows.length > 1) throw new ConflictException('More than one operation is running; reconcile the work order before continuing');
        const running = active.rows[0];
        if (running) {
          operationId = running.id;
          const heldUpdate = await client.query(`
            UPDATE work_order_operations
            SET status = 'ON_HOLD',
                actual_run_minutes = actual_run_minutes + GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - active_started_at)) / 60, 0),
                active_started_at = NULL,
                row_version = row_version + 1,
                updated_at = clock_timestamp()
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND row_version = $4
          `, [running.id, tenantId, factoryId, running.row_version]);
          if (heldUpdate.rowCount !== 1) throw new ConflictException('Running operation changed while the work order was held');
          operationStateChange = {
            operationId: running.id,
            fromStatus: 'IN_PROGRESS',
            toStatus: 'ON_HOLD',
            eventType: 'OPERATION_HELD',
            payload: { command, reason: reason ?? 'WORK_ORDER_HELD' },
          };
        }
      }

      if (command === 'RESUME') {
        if (workOrder.status !== 'ON_HOLD') throw new ConflictException('Only an on-hold work order can be resumed');
        const held = await client.query<OperationRow>(`
          SELECT ${OPERATION_COLUMNS}
          FROM work_order_operations op
          JOIN manufacturing_work_centres wc
            ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
          WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3 AND op.status = 'ON_HOLD'
          FOR UPDATE OF op
        `, [workOrder.id, tenantId, factoryId]);
        if (held.rows.length > 1) throw new ConflictException('More than one operation is on hold; reconcile the work order before resuming');
        const operation = held.rows[0];
        if (operation) {
          operationId = operation.id;
          const nextStatus: OperationStatus = operation.started_at ? 'PAUSED' : 'READY';
          const resumeOperation = await client.query(`
            UPDATE work_order_operations
            SET status = $1, row_version = row_version + 1, updated_at = clock_timestamp()
            WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND row_version = $5
          `, [nextStatus, operation.id, tenantId, factoryId, operation.row_version]);
          if (resumeOperation.rowCount !== 1) throw new ConflictException('Held operation changed while the work order was resumed');
          operationStateChange = {
            operationId: operation.id,
            fromStatus: 'ON_HOLD',
            toStatus: nextStatus,
            eventType: nextStatus === 'READY' ? 'OPERATION_READY' : 'OPERATION_RESUMED',
            payload: { command, reason: reason ?? 'WORK_ORDER_RESUMED' },
          };
        }
      }

      if (command === 'CANCEL') {
        if (!reason) throw new BadRequestException('reason is required to cancel a work order');
        const progress = await client.query<{ started_count: number; output_count: number }>(`
          SELECT
            (SELECT count(*)::int FROM work_order_operations op
              WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3
                AND (op.started_at IS NOT NULL OR op.status IN ('IN_PROGRESS', 'PAUSED', 'COMPLETED'))) AS started_count,
            (SELECT count(*)::int FROM order_production_reports r
              WHERE r.work_order_id = $1 AND r.tenant_id = $2 AND r.factory_id = $3) AS output_count
        `, [workOrder.id, tenantId, factoryId]);
        if ((progress.rows[0]?.started_count ?? 0) > 0 || (progress.rows[0]?.output_count ?? 0) > 0) {
          throw new ConflictException('A work order that has started or reported output cannot be cancelled; record an explicit operational disposition');
        }
        const releasedMaterials = await this.inventoryReservationService.transitionWorkOrderMaterialReservations(
          client,
          {
            userId, tenantId, factoryId, workOrderId: workOrder.id,
            workOrderNumber: workOrder.work_order_number, correlationId,
          },
          'RELEASED',
        );
        payload.material_reservation_count = releasedMaterials.reservationCount;
        payload.released_material_quantities = releasedMaterials.quantityByItem;
      }

      if (command === 'COMPLETE') {
        if (workOrder.status !== 'IN_PROGRESS') throw new ConflictException('Only an in-progress work order can be completed');
        const operationStates = await client.query<{ status: OperationStatus; step_number: number; is_quality_gate: boolean; wip_quantity: string }>(`
          SELECT status, step_number, is_quality_gate, wip_quantity::text AS wip_quantity FROM work_order_operations
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
          ORDER BY step_number
          FOR UPDATE
        `, [workOrder.id, tenantId, factoryId]);
        if (operationStates.rows.length === 0
          || operationStates.rows.some((op) => op.status !== 'COMPLETED' && op.status !== 'SKIPPED')
          || operationStates.rows.some((op) => op.is_quality_gate && op.status === 'SKIPPED')
          || operationStates.rows.some((op) => this.toUnits(op.wip_quantity) > 0n)) {
          throw new ConflictException('All routing operations must be completed, WIP must be zero on every operation, and quality-gate operations cannot be skipped, before work-order completion');
        }
        const processed = await client.query<{ processed_quantity: string }>(`
          SELECT COALESCE(SUM(good_quantity + scrap_quantity), 0)::text AS processed_quantity
          FROM order_production_reports
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
        `, [workOrder.id, tenantId, factoryId]);
        if (this.toUnits(processed.rows[0]?.processed_quantity ?? '0.0000') !== this.toUnits(workOrder.target_quantity)) {
          throw new ConflictException('Reported good plus scrap output must equal the work-order target before completion');
        }
        const requirements = await client.query<{ requirement_count: number; reservation_count: number }>(`
          SELECT
            (SELECT count(*)::int FROM work_order_material_requirements r
              WHERE r.work_order_id = $1 AND r.tenant_id = $2 AND r.factory_id = $3) AS requirement_count,
            (SELECT count(*)::int FROM work_order_material_reservations mr
              JOIN inventory_reservations ir
                ON ir.id = mr.reservation_id AND ir.tenant_id = mr.tenant_id AND ir.factory_id = mr.factory_id
              WHERE mr.work_order_id = $1 AND mr.tenant_id = $2 AND mr.factory_id = $3
                AND ir.reference_type = 'WORK_ORDER_MATERIAL' AND ir.reference_id = $1
                AND ir.status = 'RESERVED') AS reservation_count
        `, [workOrder.id, tenantId, factoryId]);
        const materialReadiness = requirements.rows[0];
        if (!materialReadiness
          || materialReadiness.requirement_count < 1
          || materialReadiness.reservation_count < materialReadiness.requirement_count) {
          throw new ConflictException('Work-order material reservations are incomplete; production cannot be completed');
        }
        const consumedMaterials = await this.inventoryReservationService.transitionWorkOrderMaterialReservations(
          client,
          {
            userId, tenantId, factoryId, workOrderId: workOrder.id,
            workOrderNumber: workOrder.work_order_number, correlationId,
          },
          'CONSUMED',
        );
        if (consumedMaterials.reservationCount < materialReadiness.requirement_count) {
          throw new ConflictException('Work-order material reservations could not all be consumed');
        }
        payload.material_reservation_count = consumedMaterials.reservationCount;
        payload.consumed_material_quantities = consumedMaterials.quantityByItem;
      }

      if (command !== 'CANCEL' && command !== 'COMPLETE' && command !== 'RELEASE' && command !== 'HOLD' && command !== 'RESUME') {
        throw new BadRequestException('Unsupported work-order lifecycle command');
      }
      const update = await client.query<{ id: string; row_version: number }>(`
        UPDATE work_orders
        SET status = $1,
            row_version = row_version + 1,
            updated_by_user_id = $2,
            updated_at = clock_timestamp(),
            hold_reason = CASE WHEN $1 = 'ON_HOLD' THEN $3 ELSE NULL END,
            released_by_user_id = CASE WHEN $4 THEN $2 ELSE released_by_user_id END,
            released_at = CASE WHEN $4 THEN clock_timestamp() ELSE released_at END,
            completed_at = CASE WHEN $5 THEN clock_timestamp() ELSE completed_at END,
            cancelled_by_user_id = CASE WHEN $6 THEN $2 ELSE cancelled_by_user_id END,
            cancelled_at = CASE WHEN $6 THEN clock_timestamp() ELSE cancelled_at END
        WHERE id = $7 AND tenant_id = $8 AND factory_id = $9 AND row_version = $10
        RETURNING id::text AS id, row_version::int AS row_version
      `, [
        targetStatus, userId, reason, command === 'RELEASE', command === 'COMPLETE', command === 'CANCEL',
        workOrder.id, tenantId, factoryId, workOrder.row_version,
      ]);
      if (!update.rows[0]) throw new ConflictException('Work order changed during its transition');

      await this.appendEvent(client, {
        tenantId, factoryId, workOrderId: workOrder.id, operationId,
        eventType, fromStatus: workOrder.status, toStatus: targetStatus,
        source: 'API', occurredAt: null, deviceId: null,
        idempotencyKey: eventKey, requestHash, actorUserId: userId,
        correlationId, requestId,
        payload: { ...payload, row_version: update.rows[0].row_version },
      });
      if (operationStateChange) {
        await this.appendOperationStateEvent(client, {
          tenantId, factoryId, workOrderId: workOrder.id,
          operationId: operationStateChange.operationId,
          eventType: operationStateChange.eventType,
          fromStatus: operationStateChange.fromStatus,
          toStatus: operationStateChange.toStatus,
          sourceEventKey: eventKey,
          sourceRequestHash: requestHash,
          actorUserId: userId, correlationId, requestId,
          payload: operationStateChange.payload,
        });
      }
      return { workOrderId, replayed: false as const };
    });

    const workOrder = await this.getWorkOrder(userId, tenantId, factoryId, result.workOrderId);
    if (!result.replayed) {
      await this.auditSafe({
        tenantId, factoryId, userId, action: eventType,
        id: result.workOrderId, requestId, traceId,
        payload: { command, replayed: false, status: workOrder.status },
      });
    }
    return { ...workOrder, replayed: result.replayed };
  }

  async reportOperationEvent(
    userId: string,
    tenantId: string,
    factoryId: string,
    workOrderId: string,
    operationId: string,
    dto: OperationEventDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    this.uuid(workOrderId, 'workOrderId');
    this.uuid(operationId, 'operationId');
    const key = this.requiredIdempotencyKey(rawIdempotencyKey);
    const command = dto.command as OperationCommand;
    const quantity = dto.quantity === undefined ? null : this.normalizeQuantity(dto.quantity, 'quantity');
    if (['WIP_REPORTED', 'WIP_TRANSFERRED', 'REWORK_REPORTED'].includes(command) && quantity === null) {
      throw new BadRequestException('quantity is required for WIP, WIP transfer and rework events');
    }
    if (['WIP_TRANSFERRED', 'REWORK_REPORTED'].includes(command) && quantity !== null) {
      try {
        assertReworkQuantity(this.toUnits(quantity));
      } catch {
        throw new BadRequestException(command === 'WIP_TRANSFERRED'
          ? 'WIP transfer quantity must be greater than zero'
          : 'rework quantity must be greater than zero');
      }
    }
    const targetOperationId = dto.target_operation_id?.toLowerCase() ?? null;
    if (command === 'WIP_TRANSFERRED') {
      if (!targetOperationId) throw new BadRequestException('target_operation_id is required for WIP transfer');
      this.uuid(targetOperationId, 'target_operation_id');
      if (targetOperationId === operationId.toLowerCase()) {
        throw new BadRequestException('WIP cannot be transferred to the same operation');
      }
    }
    const reason = dto.reason?.trim() || null;
    if (['SKIP', 'HOLD', 'REWORK_REPORTED', 'DOWNTIME_START'].includes(command) && !reason) {
      throw new BadRequestException('reason is required for skip, hold, downtime start and rework events');
    }
    const occurredAt = this.eventTimestamp(dto.occurred_at);
    const source = dto.source ?? 'API';
    const deviceId = dto.device_id?.trim() || null;
    this.assertDeviceSource(source, deviceId);
    const requestHash = this.hash({
      work_order_id: workOrderId.toLowerCase(), operation_id: operationId.toLowerCase(),
      command, target_operation_id: targetOperationId,
      expected_work_order_version: dto.expected_work_order_version,
      expected_operation_version: dto.expected_operation_version,
      quantity, reason, source, device_id: deviceId, occurred_at: occurredAt,
    });
    const correlationId = this.correlationId(traceId, requestId);

    const result = await this.database.transaction({
      tenantId, userId, requestId, traceId,
      advisoryLockKey: `production-operation:${tenantId}:${factoryId}:${workOrderId}:${key}`,
    }, async (client) => {
      const eventKey = this.scopedEventKey(workOrderId, 'OPERATION_EVENT', key);
      const replay = await this.findEventReplay(client, tenantId, factoryId, eventKey, requestHash);
      if (replay) return { workOrderId, replayed: true as const };

      const parentResult = await client.query<WorkOrderRow>(`
        SELECT ${WORK_ORDER_COLUMNS}
        FROM work_orders WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        FOR UPDATE
      `, [workOrderId, tenantId, factoryId]);
      const workOrder = parentResult.rows[0];
      if (!workOrder) throw new NotFoundException('Work order was not found in this factory');
      if (workOrder.row_version !== dto.expected_work_order_version) {
        throw new ConflictException('Work-order version is stale; refresh before recording a shop-floor event');
      }

      const operationResult = await client.query<OperationRow>(`
        SELECT ${OPERATION_COLUMNS}
        FROM work_order_operations op
        JOIN manufacturing_work_centres wc
          ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
        WHERE op.id = $1 AND op.work_order_id = $2 AND op.tenant_id = $3 AND op.factory_id = $4
        FOR UPDATE OF op
      `, [operationId, workOrderId, tenantId, factoryId]);
      const operation = operationResult.rows[0];
      if (!operation) throw new NotFoundException('Operation was not found in this work order');
      if (operation.row_version !== dto.expected_operation_version) {
        throw new ConflictException('Operation version is stale; refresh before recording a shop-floor event');
      }

      let nextStatus = nextOperationStatus(operation.status, command, operation.is_quality_gate);
      let nextWorkOrderStatus: WorkOrderStatus = workOrder.status;
      let workOrderStateEventType: 'WORK_ORDER_STARTED' | 'WORK_ORDER_HELD' | 'WORK_ORDER_RESUMED' | null = null;
      const eventType = this.operationEventType(command);
      let payload: Record<string, unknown> = {
        command, quantity, reason, source, device_id: deviceId, occurred_at: occurredAt,
        expected_work_order_version: dto.expected_work_order_version,
        expected_operation_version: dto.expected_operation_version,
      };
      let startedAt = operation.started_at;
      let activeStartedAt = operation.active_started_at;
      let completedAt = operation.completed_at;
      let downtimeStartedAt = operation.downtime_started_at;
      let actualRunExpression = 'actual_run_minutes';
      let downtimeExpression = 'downtime_minutes';
      let wipSnapshotToSet: string | null = null;
      let wipTransferTarget: OperationRow | null = null;
      let wipTransferTargetQuantity: string | null = null;
      let wipTransferTargetRowVersion: number | null = null;
      let operationsToReady: OperationRow | null = null;
      let nextOperationBecameReady = false;

      if (command === 'START') {
        if (!['RELEASED', 'IN_PROGRESS'].includes(workOrder.status)) {
          throw new ConflictException('Operations can only start on a released or in-progress work order');
        }
        if (operation.work_centre_code.length === 0) throw new ConflictException('Operation has no active work centre');
        const preceding = await client.query<{ status: OperationStatus; step_number: number }>(`
          SELECT status, step_number FROM work_order_operations
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3 AND step_number < $4
          ORDER BY step_number
        `, [workOrderId, tenantId, factoryId, operation.step_number]);
        try {
          assertPrecedingOperationsComplete(preceding.rows);
        } catch (error) {
          throw new ConflictException(error instanceof Error ? error.message : 'A preceding operation is incomplete');
        }
        const centre = await client.query<{ status: string }>(`
          SELECT status FROM manufacturing_work_centres
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR SHARE
        `, [operation.work_centre_id, tenantId, factoryId]);
        if (centre.rows[0]?.status !== 'ACTIVE') throw new ConflictException('The operation work centre is not active');
        const alreadyRunning = await client.query<{ id: string }>(`
          SELECT id::text AS id FROM work_order_operations
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
            AND status = 'IN_PROGRESS' AND id <> $4
          LIMIT 1
          FOR UPDATE
        `, [workOrderId, tenantId, factoryId, operation.id]);
        if (alreadyRunning.rows[0]) {
          throw new ConflictException('Another operation is already running for this work order');
        }
        nextWorkOrderStatus = workOrder.status === 'RELEASED' ? 'IN_PROGRESS' : workOrder.status;
        startedAt = operation.started_at;
        activeStartedAt = null;
        actualRunExpression = 'actual_run_minutes';
      } else if (command === 'PAUSE') {
        if (!operation.active_started_at || operation.downtime_started_at) throw new ConflictException('Only an actively running operation outside downtime can be paused');
        actualRunExpression = 'actual_run_minutes + GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - active_started_at)) / 60, 0)';
        activeStartedAt = null;
      } else if (command === 'RESUME') {
        if (operation.status === 'ON_HOLD') {
          if (workOrder.status !== 'ON_HOLD') throw new ConflictException('An on-hold operation requires its work order to be resumed at the same time');
          nextStatus = operation.started_at ? 'PAUSED' : 'READY';
          nextWorkOrderStatus = 'IN_PROGRESS';
        } else {
          if (workOrder.status !== 'IN_PROGRESS') throw new ConflictException('Resume the work order before resuming the paused operation');
          nextStatus = 'IN_PROGRESS';
        }
        activeStartedAt = nextStatus === 'IN_PROGRESS' ? null : null;
      } else if (command === 'HOLD') {
        if (!['RELEASED', 'IN_PROGRESS'].includes(workOrder.status)) throw new ConflictException('Only a released or in-progress operation may be held');
        if (operation.downtime_started_at) throw new ConflictException('End the active downtime interval before placing the operation on hold');
        nextWorkOrderStatus = 'ON_HOLD';
        if (operation.status === 'IN_PROGRESS') {
          actualRunExpression = 'actual_run_minutes + GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - active_started_at)) / 60, 0)';
        }
        activeStartedAt = null;
      } else if (command === 'COMPLETE') {
        if (operation.downtime_started_at) throw new ConflictException('End the active downtime interval before completing the operation');
        if (this.toUnits(operation.wip_quantity) > 0n) {
          throw new ConflictException('Report WIP as zero after transferring or dispositioning it before finishing this operation');
        }
        if (operation.step_number === await this.lastOperationStep(client, workOrderId, tenantId, factoryId)) {
          const totals = await client.query<{ processed_quantity: string }>(`
            SELECT COALESCE(SUM(good_quantity + scrap_quantity), 0)::text AS processed_quantity
            FROM order_production_reports
            WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
          `, [workOrderId, tenantId, factoryId]);
          if (this.toUnits(totals.rows[0]?.processed_quantity ?? '0.0000') !== this.toUnits(workOrder.target_quantity)) {
            throw new ConflictException('Report the full good-plus-scrap output against the final operation before completing it');
          }
        }
        if (operation.active_started_at) {
          actualRunExpression = 'actual_run_minutes + GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - active_started_at)) / 60, 0)';
        }
        activeStartedAt = null;
        completedAt = null;
        const next = await client.query<OperationRow>(`
          SELECT ${OPERATION_COLUMNS}
          FROM work_order_operations op
          JOIN manufacturing_work_centres wc
            ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
          WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3
            AND op.step_number > $4
          ORDER BY op.step_number LIMIT 1
          FOR UPDATE OF op
        `, [workOrderId, tenantId, factoryId, operation.step_number]);
        operationsToReady = next.rows[0] ?? null;
        if (operationsToReady && operationsToReady.status === 'PLANNED') {
          const readyUpdate = await client.query(`
            UPDATE work_order_operations
            SET status = 'READY', row_version = row_version + 1, updated_at = clock_timestamp()
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND row_version = $4
          `, [operationsToReady.id, tenantId, factoryId, operationsToReady.row_version]);
          if (readyUpdate.rowCount !== 1) throw new ConflictException('Next routing operation changed before it became ready');
          nextOperationBecameReady = true;
        }
      } else if (command === 'SKIP') {
        if (this.toUnits(operation.wip_quantity) > 0n) {
          throw new ConflictException('Clear WIP by transferring or dispositioning it before skipping this operation');
        }
        const preceding = await client.query<{ status: OperationStatus; step_number: number }>(`
          SELECT status, step_number FROM work_order_operations
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3 AND step_number < $4
          ORDER BY step_number
        `, [workOrderId, tenantId, factoryId, operation.step_number]);
        try {
          assertPrecedingOperationsComplete(preceding.rows);
        } catch (error) {
          throw new ConflictException(error instanceof Error ? error.message : 'A preceding operation is incomplete');
        }
        const next = await client.query<OperationRow>(`
          SELECT ${OPERATION_COLUMNS}
          FROM work_order_operations op
          JOIN manufacturing_work_centres wc
            ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
          WHERE op.work_order_id = $1 AND op.tenant_id = $2 AND op.factory_id = $3
            AND op.step_number > $4
          ORDER BY op.step_number LIMIT 1
          FOR UPDATE OF op
        `, [workOrderId, tenantId, factoryId, operation.step_number]);
        operationsToReady = next.rows[0] ?? null;
        if (operationsToReady && operationsToReady.status === 'PLANNED') {
          const readyUpdate = await client.query(`
            UPDATE work_order_operations
            SET status = 'READY', row_version = row_version + 1, updated_at = clock_timestamp()
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND row_version = $4
          `, [operationsToReady.id, tenantId, factoryId, operationsToReady.row_version]);
          if (readyUpdate.rowCount !== 1) throw new ConflictException('Next routing operation changed before it became ready');
          nextOperationBecameReady = true;
        }
      } else if (command === 'DOWNTIME_START') {
        try {
          assertDowntimeCanStart({
            workOrderStatus: workOrder.status,
            operationStatus: operation.status,
            activeTimerOpen: operation.active_started_at !== null,
            downtimeAlreadyOpen: operation.downtime_started_at !== null,
          });
        } catch {
          throw new ConflictException('Downtime can start only during an active operation run with no open downtime interval');
        }
        actualRunExpression = 'actual_run_minutes + GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - active_started_at)) / 60, 0)';
        activeStartedAt = null;
        downtimeStartedAt = null;
      } else if (command === 'DOWNTIME_END') {
        try {
          assertDowntimeCanEnd({
            workOrderStatus: workOrder.status,
            operationStatus: operation.status,
            downtimeAlreadyOpen: operation.downtime_started_at !== null,
          });
        } catch {
          throw new ConflictException('An active downtime interval on an in-progress work order is required');
        }
        downtimeExpression = 'downtime_minutes + GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - downtime_started_at)) / 60, 0)';
        downtimeStartedAt = null;
        activeStartedAt = null;
      } else if (command === 'WIP_REPORTED' || command === 'REWORK_REPORTED') {
        if (workOrder.status !== 'IN_PROGRESS') {
          throw new ConflictException('WIP and rework can only be reported for an in-progress work order');
        }
        if (command === 'WIP_REPORTED' && quantity !== null) {
          const otherWipResult = await client.query<{ quantity: string }>(`
            SELECT COALESCE(SUM(wip_quantity), 0)::text AS quantity
            FROM work_order_operations
            WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3 AND id <> $4
          `, [workOrderId, tenantId, factoryId, operation.id]);
          try {
            assertWipSnapshotQuantity(
              this.toUnits(quantity),
              this.toUnits(workOrder.target_quantity),
              this.toUnits(otherWipResult.rows[0]?.quantity ?? '0.0000'),
            );
          } catch {
            throw new ConflictException('Reported WIP plus WIP on other operations cannot exceed the work-order target quantity');
          }
          wipSnapshotToSet = quantity;
        }
      } else if (command === 'WIP_TRANSFERRED') {
        if (workOrder.status !== 'IN_PROGRESS' || !['IN_PROGRESS', 'PAUSED'].includes(operation.status)) {
          throw new ConflictException('WIP can only be transferred from an active or paused operation on an in-progress work order');
        }
        if (operation.downtime_started_at) throw new ConflictException('End the active downtime interval before transferring WIP');
        if (!targetOperationId || quantity === null) throw new BadRequestException('target_operation_id and quantity are required for WIP transfer');

        const targetResult = await client.query<OperationRow>(`
          SELECT ${OPERATION_COLUMNS}
          FROM work_order_operations op
          JOIN manufacturing_work_centres wc
            ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
          WHERE op.id = $1 AND op.work_order_id = $2 AND op.tenant_id = $3 AND op.factory_id = $4
          FOR UPDATE OF op
        `, [targetOperationId, workOrderId, tenantId, factoryId]);
        wipTransferTarget = targetResult.rows[0] ?? null;
        if (!wipTransferTarget) throw new NotFoundException('WIP transfer target must be an operation in this work order');
        const nextStep = await client.query<{ step_number: number }>(`
          SELECT min(step_number)::int AS step_number
          FROM work_order_operations
          WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3 AND step_number > $4
        `, [workOrderId, tenantId, factoryId, operation.step_number]);
        if (wipTransferTarget.step_number !== nextStep.rows[0]?.step_number) {
          throw new ConflictException('WIP must be transferred to the immediate next routing operation');
        }
        if (!['PLANNED', 'READY'].includes(wipTransferTarget.status)) {
          throw new ConflictException('WIP transfer target must be planned or ready and not already running');
        }
        try {
          const sourceBefore = this.toUnits(operation.wip_quantity);
          const targetBefore = this.toUnits(wipTransferTarget.wip_quantity);
          const transferUnits = this.toUnits(quantity);
          assertWipTransfer(sourceBefore, targetBefore, transferUnits, this.toUnits(workOrder.target_quantity));
          wipSnapshotToSet = this.fromUnits(sourceBefore - transferUnits);
          wipTransferTargetQuantity = this.fromUnits(targetBefore + transferUnits);
          wipTransferTargetRowVersion = wipTransferTarget.row_version;
        } catch (error) {
          throw new ConflictException(error instanceof Error ? error.message : 'WIP transfer quantity is invalid');
        }
      }

      if (command === 'START') {
        nextStatus = 'IN_PROGRESS';
        startedAt = operation.started_at ?? null;
        activeStartedAt = null;
      }
      const startedAtExpression = command === 'START' ? 'COALESCE(started_at, clock_timestamp())' : '$6::timestamptz';
      const activeAtExpression = nextStatus === 'IN_PROGRESS'
        && (command === 'START' || command === 'RESUME' || command === 'DOWNTIME_END')
        ? 'clock_timestamp()'
        : '$7::timestamptz';
      const completedAtExpression = command === 'COMPLETE' ? 'clock_timestamp()' : '$8::timestamptz';
      const downtimeAtExpression = command === 'DOWNTIME_START' ? 'clock_timestamp()' : '$9::timestamptz';
      const operationUpdate = await client.query<{
        row_version: number;
        started_at: string | null;
        active_started_at: string | null;
        completed_at: string | null;
        downtime_started_at: string | null;
        actual_run_minutes: string;
        downtime_minutes: string;
        wip_quantity: string;
      }>(`
        UPDATE work_order_operations
        SET status = $1,
            started_at = ${startedAtExpression},
            active_started_at = ${activeAtExpression},
            completed_at = ${completedAtExpression},
            downtime_started_at = ${downtimeAtExpression},
            actual_run_minutes = ${actualRunExpression},
            downtime_minutes = ${downtimeExpression},
            wip_quantity = CASE WHEN $11::boolean THEN $12::numeric ELSE wip_quantity END,
            row_version = row_version + 1,
            updated_at = clock_timestamp()
        WHERE id = $2 AND work_order_id = $3 AND tenant_id = $4 AND factory_id = $5
          AND row_version = $10
        RETURNING row_version::int AS row_version, started_at::text AS started_at,
          active_started_at::text AS active_started_at,
          completed_at::text AS completed_at, downtime_started_at::text AS downtime_started_at,
          actual_run_minutes::text AS actual_run_minutes, downtime_minutes::text AS downtime_minutes,
          wip_quantity::text AS wip_quantity
      `, [
        nextStatus, operation.id, workOrder.id, tenantId, factoryId,
        startedAt, activeStartedAt, completedAt, downtimeStartedAt, operation.row_version,
        ['WIP_REPORTED', 'WIP_TRANSFERRED'].includes(command) && wipSnapshotToSet !== null,
        wipSnapshotToSet,
      ]);
      if (!operationUpdate.rows[0]) throw new ConflictException('Operation changed while the shop-floor event was being recorded');
      payload.started_at = operationUpdate.rows[0].started_at;
      payload.active_started_at = operationUpdate.rows[0].active_started_at;
      payload.completed_at = operationUpdate.rows[0].completed_at;
      payload.downtime_started_at = operationUpdate.rows[0].downtime_started_at;
      payload.actual_run_minutes = operationUpdate.rows[0].actual_run_minutes;
      payload.downtime_minutes = operationUpdate.rows[0].downtime_minutes;
      payload.wip_quantity = operationUpdate.rows[0].wip_quantity;
      if (command === 'WIP_REPORTED' || command === 'WIP_TRANSFERRED') payload.previous_wip_quantity = operation.wip_quantity;
      if (command === 'DOWNTIME_END') payload.previous_downtime_started_at = operation.downtime_started_at;

      if (wipTransferTarget && wipTransferTargetQuantity !== null && wipTransferTargetRowVersion !== null) {
        const targetWipUpdate = await client.query<{ row_version: number; wip_quantity: string }>(`
          UPDATE work_order_operations
          SET wip_quantity = $1::numeric, row_version = row_version + 1, updated_at = clock_timestamp()
          WHERE id = $2 AND work_order_id = $3 AND tenant_id = $4 AND factory_id = $5
            AND row_version = $6
          RETURNING row_version::int AS row_version, wip_quantity::text AS wip_quantity
        `, [
          wipTransferTargetQuantity, wipTransferTarget.id, workOrder.id,
          tenantId, factoryId, wipTransferTargetRowVersion,
        ]);
        if (!targetWipUpdate.rows[0]) throw new ConflictException('WIP transfer target changed during the transfer');
        payload.wip_transfer = {
          quantity,
          source_operation_id: operation.id,
          source_wip_before: operation.wip_quantity,
          source_wip_after: operationUpdate.rows[0].wip_quantity,
          source_operation_row_version: operationUpdate.rows[0].row_version,
          target_operation_id: wipTransferTarget.id,
          target_step_number: wipTransferTarget.step_number,
          target_wip_before: wipTransferTarget.wip_quantity,
          target_wip_after: targetWipUpdate.rows[0].wip_quantity,
          target_operation_row_version: targetWipUpdate.rows[0].row_version,
        };
      }

      if (nextWorkOrderStatus !== workOrder.status) {
        const woUpdate = await client.query<{ row_version: number }>(`
          UPDATE work_orders
          SET status = $1, row_version = row_version + 1,
              updated_by_user_id = $2, updated_at = clock_timestamp(),
              hold_reason = CASE WHEN $1 = 'ON_HOLD' THEN $3 ELSE NULL END
          WHERE id = $4 AND tenant_id = $5 AND factory_id = $6 AND row_version = $7
          RETURNING row_version::int AS row_version
        `, [nextWorkOrderStatus, userId, reason, workOrder.id, tenantId, factoryId, workOrder.row_version]);
        if (!woUpdate.rows[0]) throw new ConflictException('Work order changed while recording the operation event');
        payload.work_order_row_version = woUpdate.rows[0].row_version;
        if (workOrder.status === 'RELEASED' && nextWorkOrderStatus === 'IN_PROGRESS') {
          workOrderStateEventType = 'WORK_ORDER_STARTED';
        } else if (workOrder.status !== 'ON_HOLD' && nextWorkOrderStatus === 'ON_HOLD') {
          workOrderStateEventType = 'WORK_ORDER_HELD';
        } else if (workOrder.status === 'ON_HOLD' && nextWorkOrderStatus === 'IN_PROGRESS') {
          workOrderStateEventType = 'WORK_ORDER_RESUMED';
        }
      } else if (command === 'WIP_REPORTED' || command === 'REWORK_REPORTED') {
        // These events do not move the work-order state, but stale work-order clients should refresh.
        const woUpdate = await client.query(`
          UPDATE work_orders
          SET row_version = row_version + 1, updated_by_user_id = $1, updated_at = clock_timestamp()
          WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND row_version = $5
        `, [userId, workOrder.id, tenantId, factoryId, workOrder.row_version]);
        if (woUpdate.rowCount !== 1) throw new ConflictException('Work order changed while reporting WIP/rework');
        payload.work_order_row_version = workOrder.row_version + 1;
      }

      payload.operation_row_version = operationUpdate.rows[0].row_version;
      if (operationsToReady) payload.next_operation_id = operationsToReady.id;
      if (nextOperationBecameReady && operationsToReady) {
        payload.next_operation_id = operationsToReady.id;
        payload.next_operation_status = 'READY';
      }
      if (workOrderStateEventType) payload.work_order_state_event_type = workOrderStateEventType;

      const event = await this.appendEvent(client, {
        tenantId, factoryId, workOrderId: workOrder.id, operationId: operation.id,
        eventType, fromStatus: operation.status, toStatus: nextStatus,
        source, occurredAt, deviceId, idempotencyKey: eventKey, requestHash,
        actorUserId: userId, correlationId, requestId, payload,
      });

      if (command === 'WIP_TRANSFERRED' && wipTransferTarget
        && wipTransferTargetQuantity !== null && wipTransferTargetRowVersion !== null) {
        await this.appendEvent(client, {
          tenantId, factoryId, workOrderId: workOrder.id, operationId: operation.id,
          eventType: 'WIP_REPORTED', fromStatus: operation.status, toStatus: operation.status,
          source, occurredAt, deviceId,
          idempotencyKey: this.scopedEventKey(workOrder.id, 'WIP_TRANSFER_SOURCE', eventKey),
          requestHash: this.hash({ eventKey, operationId: operation.id, wipQuantity: operationUpdate.rows[0].wip_quantity }),
          actorUserId: userId, correlationId, requestId,
          payload: {
            command: 'WIP_TRANSFERRED', quantity: operationUpdate.rows[0].wip_quantity,
            wip_quantity: operationUpdate.rows[0].wip_quantity,
            previous_wip_quantity: operation.wip_quantity,
            operation_row_version: operationUpdate.rows[0].row_version,
            transfer_event_id: event.id, target_operation_id: wipTransferTarget.id,
          },
        });
        await this.appendEvent(client, {
          tenantId, factoryId, workOrderId: workOrder.id, operationId: wipTransferTarget.id,
          eventType: 'WIP_REPORTED', fromStatus: wipTransferTarget.status, toStatus: wipTransferTarget.status,
          source, occurredAt, deviceId,
          idempotencyKey: this.scopedEventKey(workOrder.id, 'WIP_TRANSFER_TARGET', eventKey),
          requestHash: this.hash({ eventKey, operationId: wipTransferTarget.id, wipQuantity: wipTransferTargetQuantity }),
          actorUserId: userId, correlationId, requestId,
          payload: {
            command: 'WIP_TRANSFERRED', quantity: wipTransferTargetQuantity,
            wip_quantity: wipTransferTargetQuantity,
            previous_wip_quantity: wipTransferTarget.wip_quantity,
            operation_row_version: wipTransferTargetRowVersion + 1,
            transfer_event_id: event.id, source_operation_id: operation.id,
          },
        });
      }

      if (workOrderStateEventType) {
        await this.appendEvent(client, {
          tenantId, factoryId, workOrderId: workOrder.id, operationId: operation.id,
          eventType: workOrderStateEventType, fromStatus: workOrder.status, toStatus: nextWorkOrderStatus,
          source, occurredAt, deviceId,
          idempotencyKey: this.scopedEventKey(workOrder.id, workOrderStateEventType, eventKey),
          requestHash: this.hash({
            work_order_id: workOrder.id,
            from_status: workOrder.status,
            to_status: nextWorkOrderStatus,
            source_request_hash: requestHash,
          }),
          actorUserId: userId, correlationId, requestId,
          payload: {
            command, reason, operation_event_id: event.id, operation_id: operation.id,
            operation_event_type: eventType, row_version: payload.work_order_row_version,
          },
        });
      }

      if (nextOperationBecameReady && operationsToReady) {
        await this.appendOperationStateEvent(client, {
          tenantId, factoryId, workOrderId: workOrder.id,
          operationId: operationsToReady.id,
          eventType: 'OPERATION_READY',
          fromStatus: 'PLANNED',
          toStatus: 'READY',
          sourceEventKey: eventKey,
          sourceRequestHash: requestHash,
          actorUserId: userId, correlationId, requestId, source, occurredAt, deviceId,
          payload: {
            command, caused_by_operation_id: operation.id,
            caused_by_event_type: eventType,
            step_number: operationsToReady.step_number,
          },
        });
      }
      return { workOrderId, eventId: event.id, replayed: false as const, workOrderStateEventType };
    });

    const workOrder = await this.getWorkOrder(userId, tenantId, factoryId, result.workOrderId);
    if (!result.replayed) {
      await this.auditSafe({
        tenantId, factoryId, userId, action: eventTypeForCommand(command),
        id: result.workOrderId, requestId, traceId,
        payload: { command, operationId, replayed: false, quantity },
      });
      if ('workOrderStateEventType' in result && result.workOrderStateEventType) {
        await this.auditSafe({
          tenantId, factoryId, userId, action: result.workOrderStateEventType,
          id: result.workOrderId, requestId, traceId,
          payload: { command, operationId, replayed: false, status: workOrder.status },
        });
      }
    }
    return { ...workOrder, replayed: result.replayed };
  }

  async reportOutput(
    userId: string,
    tenantId: string,
    factoryId: string,
    workOrderId: string,
    dto: WorkOrderOutputReportDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    this.uuid(workOrderId, 'workOrderId');
    this.uuid(dto.operation_id, 'operation_id');
    const key = this.requiredIdempotencyKey(rawIdempotencyKey);
    const goodQuantity = this.normalizeQuantity(dto.good_quantity, 'good_quantity');
    const scrapQuantity = this.normalizeQuantity(dto.scrap_quantity, 'scrap_quantity');
    const goodUnits = this.toUnits(goodQuantity);
    const scrapUnits = this.toUnits(scrapQuantity);
    if (goodUnits + scrapUnits <= 0n) throw new BadRequestException('good_quantity and scrap_quantity cannot both be zero');
    const scrapReason = dto.scrap_reason?.trim() || null;
    if (scrapUnits > 0n && !scrapReason) throw new BadRequestException('scrap_reason is required when scrap_quantity is greater than zero');
    const notes = dto.notes?.trim() || null;
    const source = dto.source ?? 'API';
    const deviceId = dto.device_id?.trim() || null;
    this.assertDeviceSource(source, deviceId);
    const occurredAt = this.eventTimestamp(dto.occurred_at);
    const requestHash = this.hash({
      work_order_id: workOrderId.toLowerCase(), operation_id: dto.operation_id.toLowerCase(),
      expected_work_order_version: dto.expected_work_order_version,
      expected_operation_version: dto.expected_operation_version,
      good_quantity: goodQuantity, scrap_quantity: scrapQuantity, scrap_reason: scrapReason,
      notes, source, device_id: deviceId, occurred_at: occurredAt,
    });
    const correlationId = this.correlationId(traceId, requestId);
    const result = await this.database.transaction({
      tenantId, userId, requestId, traceId,
      advisoryLockKey: `production-output:${tenantId}:${factoryId}:${workOrderId}:${key}`,
    }, async (client) => {
      const eventKey = this.scopedEventKey(workOrderId, 'OUTPUT', key);
      const replay = await this.findEventReplay(client, tenantId, factoryId, eventKey, requestHash);
      if (replay) return { workOrderId, replayed: true as const };

      const woResult = await client.query<WorkOrderRow>(`
        SELECT ${WORK_ORDER_COLUMNS} FROM work_orders
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE
      `, [workOrderId, tenantId, factoryId]);
      const workOrder = woResult.rows[0];
      if (!workOrder) throw new NotFoundException('Work order was not found in this factory');
      if (workOrder.row_version !== dto.expected_work_order_version) throw new ConflictException('Work-order version is stale');
      if (workOrder.status !== 'IN_PROGRESS') throw new ConflictException('Output can only be reported for an in-progress work order');

      const operationResult = await client.query<OperationRow>(`
        SELECT ${OPERATION_COLUMNS}
        FROM work_order_operations op
        JOIN manufacturing_work_centres wc
          ON wc.id = op.work_centre_id AND wc.tenant_id = op.tenant_id AND wc.factory_id = op.factory_id
        WHERE op.id = $1 AND op.work_order_id = $2 AND op.tenant_id = $3 AND op.factory_id = $4
        FOR UPDATE OF op
      `, [dto.operation_id, workOrderId, tenantId, factoryId]);
      const operation = operationResult.rows[0];
      if (!operation) throw new NotFoundException('Output operation was not found in this work order');
      if (operation.row_version !== dto.expected_operation_version) throw new ConflictException('Operation version is stale');
      if (operation.status !== 'IN_PROGRESS' || !operation.active_started_at || operation.downtime_started_at) {
        throw new ConflictException('Output must be reported while the final operation is actively running outside downtime');
      }
      const lastStep = await this.lastOperationStep(client, workOrderId, tenantId, factoryId);
      if (operation.step_number !== lastStep) throw new ConflictException('Good output and scrap must be reported on the final routing operation');

      const processedResult = await client.query<{ processed_quantity: string }>(`
        SELECT COALESCE(SUM(good_quantity + scrap_quantity), 0)::text AS processed_quantity
        FROM order_production_reports
        WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
      `, [workOrderId, tenantId, factoryId]);
      try {
        assertTargetQuantityNotExceeded(
          this.toUnits(workOrder.target_quantity),
          this.toUnits(processedResult.rows[0]?.processed_quantity ?? '0.0000'),
          goodUnits + scrapUnits,
        );
      } catch (error) {
        throw new ConflictException(error instanceof Error ? error.message : 'Work-order target would be exceeded');
      }

      const sourceOrder = await this.lockSourceOrder(client, tenantId, factoryId, workOrder.source_order_id, workOrder.source_order_line_id);
      if (sourceOrder.status !== 'IN_PROGRESS') throw new ConflictException('The source sales order must remain in progress for production output');
      const totals = await client.query<ProductionTotals>(`
        SELECT COALESCE(SUM(good_quantity), 0)::text AS good_quantity,
          COALESCE(SUM(scrap_quantity), 0)::text AS scrap_quantity
        FROM order_production_reports
        WHERE order_id = $1 AND order_line_id = $2 AND tenant_id = $3 AND factory_id = $4
      `, [workOrder.source_order_id, workOrder.source_order_line_id, tenantId, factoryId]);
      const priorGood = this.toUnits(totals.rows[0]?.good_quantity ?? '0.0000');
      const priorScrap = this.toUnits(totals.rows[0]?.scrap_quantity ?? '0.0000');
      if (priorGood + goodUnits > this.toUnits(sourceOrder.line_quantity)) {
        throw new ConflictException('Reported good output would exceed the sales-order line target');
      }
      const createdReport = await client.query<{ id: string }>(`
        INSERT INTO order_production_reports (
          tenant_id, factory_id, order_id, order_line_id, good_quantity, scrap_quantity,
          cumulative_good_quantity, cumulative_scrap_quantity, scrap_reason, notes,
          idempotency_key, request_hash, created_by_user_id, correlation_id,
          work_order_id, work_order_operation_id
        ) VALUES (
          $1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric,
          $9, $10, $11, $12, $13, $14::uuid, $15, $16
        )
        RETURNING id::text AS id
      `, [
        tenantId, factoryId, workOrder.source_order_id, workOrder.source_order_line_id,
        goodQuantity, scrapQuantity, this.fromUnits(priorGood + goodUnits), this.fromUnits(priorScrap + scrapUnits),
        scrapReason, notes, `work-order-output:${eventKey}`, requestHash, userId, correlationId,
        workOrder.id, operation.id,
      ]);
      const productionReportId = createdReport.rows[0]?.id;
      if (!productionReportId) throw new Error('WORK_ORDER_OUTPUT_REPORT_INSERT_FAILED');

      const newWorkOrderVersion = workOrder.row_version + 1;
      const woUpdate = await client.query(`
        UPDATE work_orders
        SET row_version = row_version + 1, updated_by_user_id = $1, updated_at = clock_timestamp()
        WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND row_version = $5
      `, [userId, workOrder.id, tenantId, factoryId, workOrder.row_version]);
      if (woUpdate.rowCount !== 1) throw new ConflictException('Work order changed while output was reported');
      const opUpdate = await client.query(`
        UPDATE work_order_operations
        SET row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3 AND factory_id = $4 AND row_version = $5
      `, [operation.id, workOrder.id, tenantId, factoryId, operation.row_version]);
      if (opUpdate.rowCount !== 1) throw new ConflictException('Operation changed while output was reported');

      await this.appendEvent(client, {
        tenantId, factoryId, workOrderId: workOrder.id, operationId: operation.id,
        eventType: 'OUTPUT_REPORTED', fromStatus: operation.status, toStatus: operation.status,
        source, occurredAt, deviceId, idempotencyKey: eventKey, requestHash, actorUserId: userId,
        correlationId, requestId,
        payload: {
          production_report_id: productionReportId, good_quantity: goodQuantity,
          scrap_quantity: scrapQuantity, scrap_reason: scrapReason, notes,
          cumulative_good_quantity: this.fromUnits(priorGood + goodUnits),
          cumulative_scrap_quantity: this.fromUnits(priorScrap + scrapUnits),
          work_order_row_version: newWorkOrderVersion,
          operation_row_version: operation.row_version + 1,
        },
      });
      return { workOrderId, productionReportId, replayed: false as const };
    });

    const workOrder = await this.getWorkOrder(userId, tenantId, factoryId, result.workOrderId);
    if (!result.replayed) {
      await this.auditSafe({
        tenantId, factoryId, userId, action: 'WORK_ORDER_OUTPUT_REPORTED',
        id: result.workOrderId, requestId, traceId,
        payload: {
          productionReportId: result.productionReportId,
          goodQuantity, scrapQuantity, replayed: false,
        },
      });
    }
    return { ...workOrder, production_report_id: 'productionReportId' in result ? result.productionReportId : null, replayed: result.replayed };
  }

  private async lockSourceOrder(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    orderId: string,
    orderLineId: string,
  ) {
    const result = await client.query<{ id: string; status: string; order_number: string; line_quantity: string }>(`
      SELECT o.id::text AS id, o.status, o.order_number, ol.quantity::text AS line_quantity
      FROM orders o
      JOIN order_lines ol ON ol.order_id = o.id AND ol.tenant_id = o.tenant_id AND ol.factory_id = o.factory_id
      WHERE o.id = $1 AND ol.id = $2 AND o.tenant_id = $3 AND o.factory_id = $4
      FOR UPDATE OF o, ol
    `, [orderId, orderLineId, tenantId, factoryId]);
    if (!result.rows[0]) throw new NotFoundException('Source sales order or line was not found in this factory');
    return result.rows[0];
  }

  private async lastOperationStep(client: PoolClient, workOrderId: string, tenantId: string, factoryId: string) {
    const result = await client.query<{ step_number: number }>(`
      SELECT max(step_number)::int AS step_number
      FROM work_order_operations WHERE work_order_id = $1 AND tenant_id = $2 AND factory_id = $3
    `, [workOrderId, tenantId, factoryId]);
    const step = result.rows[0]?.step_number;
    if (!step) throw new ConflictException('Work order has no routing operations');
    return step;
  }

  private operationEventType(command: OperationCommand) {
    const eventTypes: Record<OperationCommand, string> = {
      START: 'OPERATION_STARTED',
      PAUSE: 'OPERATION_PAUSED',
      RESUME: 'OPERATION_RESUMED',
      HOLD: 'OPERATION_HELD',
      COMPLETE: 'OPERATION_COMPLETED',
      SKIP: 'OPERATION_SKIPPED',
      DOWNTIME_START: 'DOWNTIME_STARTED',
      DOWNTIME_END: 'DOWNTIME_ENDED',
      WIP_REPORTED: 'WIP_REPORTED',
      WIP_TRANSFERRED: 'WIP_TRANSFERRED',
      REWORK_REPORTED: 'REWORK_REPORTED',
    };
    return eventTypes[command];
  }

  private async findEventReplay(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
    requestHash: string,
  ) {
    const existing = await client.query<{ request_hash: string }>(`
      SELECT request_hash FROM work_order_events
      WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
      FOR UPDATE
    `, [tenantId, factoryId, idempotencyKey]);
    if (!existing.rows[0]) return false;
    if (existing.rows[0].request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for a different shop-floor event');
    }
    return true;
  }

  private async appendEvent(client: PoolClient, event: EventInput) {
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO work_order_events (
        tenant_id, factory_id, work_order_id, operation_id, event_type,
        from_status, to_status, event_source, device_id, occurred_at,
        idempotency_key, request_hash, actor_user_id, payload
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        COALESCE($10::timestamptz, clock_timestamp()), $11, $12, $13, $14::jsonb
      )
      RETURNING id::text AS id
    `, [
      event.tenantId, event.factoryId, event.workOrderId, event.operationId ?? null,
      event.eventType, event.fromStatus ?? null, event.toStatus ?? null,
      event.source ?? 'API', event.deviceId ?? null, event.occurredAt ?? null,
      event.idempotencyKey, event.requestHash, event.actorUserId, JSON.stringify(event.payload),
    ]);
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('WORK_ORDER_EVENT_INSERT_FAILED');
    await client.query(`
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version,
        occurred_at, correlation_id, causation_id, actor, source, payload
      ) VALUES (
        $1, $2, 'WORK_ORDER', $3, $4, 1, clock_timestamp(), $5::uuid, $6::uuid,
        $7::jsonb, $8::jsonb, $9::jsonb
      )
    `, [
      event.tenantId, event.factoryId, event.workOrderId, `PRODUCTION.${event.eventType}`,
      event.correlationId, this.validUuid(event.requestId),
      JSON.stringify({ type: 'user', id: event.actorUserId }),
      JSON.stringify({
        system: 'FactoryOS', connector: 'production-work-orders-service',
        version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
      }),
      JSON.stringify({
        event_id: id, work_order_id: event.workOrderId, operation_id: event.operationId ?? null,
        event_type: event.eventType, from_status: event.fromStatus ?? null, to_status: event.toStatus ?? null,
        source: event.source ?? 'API', device_id: event.deviceId ?? null,
        occurred_at: event.occurredAt ?? null, payload: event.payload,
      }),
    ]);
    return { id };
  }

  private async appendOperationStateEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      workOrderId: string;
      operationId: string;
      eventType: 'OPERATION_READY' | 'OPERATION_HELD' | 'OPERATION_PAUSED' | 'OPERATION_RESUMED';
      fromStatus: OperationStatus;
      toStatus: OperationStatus;
      sourceEventKey: string;
      sourceRequestHash: string;
      actorUserId: string;
      correlationId: string;
      requestId: string | null;
      source?: string;
      occurredAt?: string | null;
      deviceId?: string | null;
      payload: Record<string, unknown>;
    },
  ) {
    const requestHash = this.hash({
      work_order_id: input.workOrderId,
      operation_id: input.operationId,
      event_type: input.eventType,
      from_status: input.fromStatus,
      to_status: input.toStatus,
      source_event_key: input.sourceEventKey,
      source_request_hash: input.sourceRequestHash,
    });
    return this.appendEvent(client, {
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      workOrderId: input.workOrderId,
      operationId: input.operationId,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      source: input.source ?? 'API',
      occurredAt: input.occurredAt ?? null,
      deviceId: input.deviceId ?? null,
      idempotencyKey: this.scopedEventKey(input.workOrderId, input.eventType, input.sourceEventKey),
      requestHash,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      payload: { ...input.payload, source_event_key: input.sourceEventKey },
    });
  }

  private async auditSafe(input: {
    tenantId: string;
    factoryId: string;
    userId: string;
    action: string;
    id: string;
    requestId: string | null;
    traceId: string | null;
    payload: Record<string, unknown>;
  }) {
    try {
      await this.auditService.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.userId,
        eventType: 'PRODUCTION', action: input.action,
        resourceType: 'WORK_ORDER', resourceId: input.id,
        requestId: this.validUuid(input.requestId), correlationId: this.validUuid(input.traceId),
        dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // The append-only shop-floor event and transactional outbox preserve durable evidence.
    }
  }

  private assertScope(userId: string, tenantId: string, factoryId: string) {
    this.uuid(userId, 'userId');
    this.uuid(tenantId, 'tenantId');
    this.uuid(factoryId, 'factoryId');
  }

  private uuid(value: string, name: string) {
    if (!isUUID(value)) throw new BadRequestException(`${name} must be a valid UUID`);
  }

  private validUuid(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }

  private correlationId(traceId: string | null, requestId: string | null) {
    return this.validUuid(traceId) ?? this.validUuid(requestId) ?? randomUUID();
  }

  private assertDeviceSource(
    source: 'API' | 'HMI' | 'MES' | 'PLC' | 'MOBILE' | 'IMPORT',
    deviceId: string | null,
  ) {
    if (['HMI', 'MES', 'PLC', 'MOBILE'].includes(source) && !deviceId) {
      throw new BadRequestException(`device_id is required when event source is ${source}`);
    }
  }

  private requiredIdempotencyKey(value: string | null) {
    const key = value?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key header is required');
    if (key.length > 255) throw new BadRequestException('Idempotency-Key must not exceed 255 characters');
    return key;
  }

  private scopedEventKey(workOrderId: string, command: string, rawKey: string) {
    return `${command}:${workOrderId}:${this.hash({ key: rawKey }).slice(0, 32)}`;
  }

  private hash(value: Record<string, unknown>) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private calendarDate(value: string, field: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${field} must use YYYY-MM-DD format`);
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(`${field} must be a valid calendar date`);
    }
    return value;
  }

  private eventTimestamp(value?: string) {
    if (!value) return null;
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) throw new BadRequestException('occurred_at must be a valid timestamp');
    if (instant.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException('occurred_at cannot be more than five minutes in the future');
    }
    return instant.toISOString();
  }

  private normalizeQuantity(value: number | string, field: string) {
    const raw = String(value);
    const parts = raw.split('.');
    const whole = parts[0] ?? '';
    const fraction = parts[1] ?? '';
    const digits = (input: string) => input.length > 0 && [...input].every((char) => char >= '0' && char <= '9');
    if (parts.length > 2 || !digits(whole) || (parts.length === 2 && !digits(fraction)) || fraction.length > 4) {
      throw new BadRequestException(`${field} must be a non-negative decimal with at most four decimal places`);
    }
    const valueUnits = BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
    return this.fromUnits(valueUnits);
  }

  private toUnits(value: string) {
    const parts = value.split('.');
    const whole = parts[0] ?? '';
    const fraction = parts[1] ?? '';
    const digits = (input: string) => input.length > 0 && [...input].every((char) => char >= '0' && char <= '9');
    if (parts.length > 2 || !digits(whole) || (parts.length === 2 && !digits(fraction)) || fraction.length > 4) {
      throw new BadRequestException('Quantity is not a valid four-decimal non-negative decimal');
    }
    return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
  }

  private fromUnits(units: bigint) {
    if (units < 0n) throw new BadRequestException('Quantity cannot be negative');
    return `${(units / 10_000n).toString()}.${(units % 10_000n).toString().padStart(4, '0')}`;
  }

  private limit(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return value;
  }
}

function eventTypeForCommand(command: OperationCommand) {
  const mapping: Record<OperationCommand, string> = {
    START: 'OPERATION_STARTED',
    PAUSE: 'OPERATION_PAUSED',
    RESUME: 'OPERATION_RESUMED',
    HOLD: 'OPERATION_HELD',
    COMPLETE: 'OPERATION_COMPLETED',
    SKIP: 'OPERATION_SKIPPED',
    DOWNTIME_START: 'DOWNTIME_STARTED',
    DOWNTIME_END: 'DOWNTIME_ENDED',
    WIP_REPORTED: 'WIP_REPORTED',
    WIP_TRANSFERRED: 'WIP_TRANSFERRED',
    REWORK_REPORTED: 'REWORK_REPORTED',
  };
  return mapping[command];
}
