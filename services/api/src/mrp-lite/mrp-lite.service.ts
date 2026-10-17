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
import { CreateMrpLiteRunDto } from './dto/create-mrp-lite-run.dto';
import {
  allocateMrpRequirements,
  type MrpAllocationDemand,
  type MrpIncomingSupply,
  type MrpStockPosition,
} from './mrp-lite-allocation';

interface DemandBomRow extends QueryResultRow {
  order_id: string;
  order_number: string;
  order_status: 'CONFIRMED' | 'IN_PROGRESS';
  order_date: string;
  order_line_id: string;
  order_line_number: number;
  need_by_date: string;
  remaining_finished_quantity: string;
  finished_item_id: string | null;
  product_id: string | null;
  product_code: string | null;
  product_name: string | null;
  product_status: string | null;
  product_version_id: string | null;
  product_version_number: number | null;
  product_version_state: string | null;
  expected_yield_percent: string | null;
  bom_line_id: string | null;
  bom_line_number: number | null;
  base_quantity_per: string | null;
  wastage_percent: string | null;
  component_item_id: string | null;
  component_status: string | null;
  component_sku: string | null;
  component_name: string | null;
  component_unit: string | null;
  required_quantity: string | null;
}

interface StockRow extends QueryResultRow {
  id: string;
  sku: string;
  name: string;
  unit: string;
  status: 'ACTIVE' | 'DISABLED';
  quantity_on_hand: string;
  quantity_reserved: string;
}

interface IncomingRow extends QueryResultRow {
  id: string;
  item_id: string;
  purchase_order_number: string;
  expected_delivery_date: string | null;
  remaining_quantity: string;
  eligible_for_allocation: boolean;
}

interface AlternateRow extends QueryResultRow {
  id: string;
  bom_line_id: string;
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  status: 'ACTIVE' | 'DISABLED';
  conversion_factor: string;
  quantity_per_component: string;
  rationale: string;
}

interface CandidateRequirement {
  id: string;
  source: DemandBomRow;
  requiredQuantity: string;
}

interface PlanException {
  code: string;
  order_id: string;
  order_line_id: string;
  order_number: string;
  line_number: number;
  need_by_date: string;
  bom_line_id?: string | null;
  component_item_id?: string | null;
  message: string;
}

const PLAN_COLUMNS = `
  id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
  horizon_start::text AS horizon_start, horizon_end::text AS horizon_end,
  allocation_policy, request_id::text AS request_id,
  trace_id::text AS trace_id, correlation_id::text AS correlation_id,
  created_by_user_id::text AS created_by_user_id, summary, exceptions,
  created_at::text AS created_at
`;

@Injectable()
export class MrpLiteService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async createRun(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateMrpLiteRunDto,
    rawKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.assertScope(userId, tenantId, factoryId);
    const horizonStart = this.calendarDate(dto.horizon_start, 'horizon_start');
    const horizonEnd = this.calendarDate(dto.horizon_end, 'horizon_end');
    if (horizonEnd < horizonStart) {
      throw new BadRequestException('horizon_end must be on or after horizon_start');
    }
    if (this.daysBetween(horizonStart, horizonEnd) > 365) {
      throw new BadRequestException('The MRP-lite planning horizon cannot exceed 366 calendar days');
    }
    const key = this.idempotencyKey(rawKey);
    const requestHash = this.hash({ horizon_start: horizonStart, horizon_end: horizonEnd, allocation_policy: 'DUE_DATE_FIFO' });
    const correlationId = this.validUuid(traceId) ?? this.validUuid(requestId) ?? randomUUID();

    const transactionResult = await this.database.transaction({
      tenantId,
      userId,
      requestId,
      traceId,
      isolationLevel: 'REPEATABLE READ',
      advisoryLockKey: `mrp-lite:${tenantId}:${factoryId}:${key}`,
    }, async (client) => {
      const existing = await client.query<{ id: string; request_hash: string }>(
        `SELECT id::text AS id, request_hash
         FROM mrp_plans
         WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [tenantId, factoryId, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was already used for a different MRP-lite horizon');
        }
        return { planId: existing.rows[0].id, replayed: true as const };
      }

      const factory = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM factories
         WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
         FOR KEY SHARE`,
        [factoryId, tenantId],
      );
      if (!factory.rows[0]) throw new NotFoundException('Active factory was not found in this tenant');

      const source = await client.query<DemandBomRow>(`
        WITH open_lines AS (
          SELECT
            o.id AS order_id,
            o.order_number,
            o.status AS order_status,
            o.order_date::date AS order_date,
            ol.id AS order_line_id,
            ol.line_number AS order_line_number,
            COALESCE(ol.requested_delivery_date, o.requested_delivery_date, o.order_date)::date AS need_by_date,
            ol.inventory_item_id AS finished_item_id,
            GREATEST(ol.quantity - COALESCE(production.good_quantity, 0), 0)::numeric(18,4)
              AS remaining_finished_quantity
          FROM orders o
          JOIN order_lines ol
            ON ol.order_id = o.id
           AND ol.tenant_id = o.tenant_id
           AND ol.factory_id = o.factory_id
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(r.good_quantity), 0)::numeric(18,4) AS good_quantity
            FROM order_production_reports r
            WHERE r.order_id = o.id
              AND r.order_line_id = ol.id
              AND r.tenant_id = o.tenant_id
              AND r.factory_id = o.factory_id
          ) production ON TRUE
          WHERE o.tenant_id = $1
            AND o.factory_id = $2
            AND o.status IN ('CONFIRMED', 'IN_PROGRESS')
            AND COALESCE(ol.requested_delivery_date, o.requested_delivery_date, o.order_date)::date <= $3::date
            AND ol.quantity > COALESCE(production.good_quantity, 0)
        )
        SELECT
          ol.order_id::text AS order_id,
          ol.order_number,
          ol.order_status,
          ol.order_date::text AS order_date,
          ol.order_line_id::text AS order_line_id,
          ol.order_line_number,
          ol.need_by_date::text AS need_by_date,
          ol.remaining_finished_quantity::text AS remaining_finished_quantity,
          ol.finished_item_id::text AS finished_item_id,
          p.id::text AS product_id,
          p.product_code,
          p.product_name,
          p.status AS product_status,
          pv.id::text AS product_version_id,
          pv.version_number AS product_version_number,
          pv.state AS product_version_state,
          pv.expected_yield_percent::text AS expected_yield_percent,
          b.id::text AS bom_line_id,
          b.line_number AS bom_line_number,
          b.base_quantity_per::text AS base_quantity_per,
          b.wastage_percent::text AS wastage_percent,
          ci.id::text AS component_item_id,
          ci.status AS component_status,
          ci.sku AS component_sku,
          ci.name AS component_name,
          ci.unit AS component_unit,
          CASE
            WHEN pv.expected_yield_percent > 0 AND b.base_quantity_per > 0 THEN
              (CEIL((
                ol.remaining_finished_quantity * 100::numeric
                / pv.expected_yield_percent
                * b.base_quantity_per
                * (1 + b.wastage_percent / 100::numeric)
              ) * 10000) / 10000)::numeric(18,4)::text
            ELSE NULL
          END AS required_quantity
        FROM open_lines ol
        LEFT JOIN product_definitions p
          ON p.inventory_item_id = ol.finished_item_id
         AND p.tenant_id = $1
         AND p.factory_id = $2
        LEFT JOIN LATERAL (
          SELECT v.id, v.version_number, v.state, v.expected_yield_percent
          FROM product_versions v
          WHERE v.product_id = p.id
            AND v.tenant_id = $1
            AND v.factory_id = $2
            AND v.state IN ('APPROVED', 'RETIRED')
            AND v.effective_from <= ol.need_by_date
            AND COALESCE(v.effective_to_override, v.effective_to, 'infinity'::date) >= ol.need_by_date
          ORDER BY v.effective_from DESC, v.version_number DESC
          LIMIT 1
        ) pv ON TRUE
        LEFT JOIN product_bom_lines b
          ON b.product_version_id = pv.id
         AND b.product_id = p.id
         AND b.tenant_id = $1
         AND b.factory_id = $2
        LEFT JOIN inventory_items ci
          ON ci.id = b.component_item_id
         AND ci.tenant_id = $1
         AND ci.factory_id = $2
        ORDER BY ol.need_by_date, ol.order_date, ol.order_number, ol.order_line_number, b.line_number
      `, [tenantId, factoryId, horizonEnd]);

      const exceptions: PlanException[] = [];
      const seenExceptions = new Set<string>();
      const candidates: CandidateRequirement[] = [];
      const openOrderLines = new Set<string>();
      for (const row of source.rows) {
        openOrderLines.add(row.order_line_id);
        let issue: Omit<PlanException, 'order_id' | 'order_line_id' | 'order_number' | 'line_number' | 'need_by_date'> | null = null;
        if (!row.product_id) issue = { code: 'MISSING_PRODUCT_MAPPING', message: 'The order line is not mapped to a product definition through its finished-good inventory item.' };
        else if (row.product_status !== 'ACTIVE') issue = { code: 'INACTIVE_PRODUCT', message: 'The mapped product definition is inactive; material requirements were not inferred.' };
        else if (!row.product_version_id) issue = { code: 'NO_EFFECTIVE_RELEASED_VERSION', message: 'No approved product version covers the order line required date.' };
        else if (!row.bom_line_id) issue = { code: 'EMPTY_BOM', message: 'The effective product version has no BOM material lines.' };
        else if (!row.component_item_id || row.component_status !== 'ACTIVE') {
          issue = { code: 'INACTIVE_COMPONENT', message: 'A BOM component is missing or inactive in this factory; its requirement was not allocated.' };
        }

        if (issue) {
          const identity = `${row.order_line_id}:${issue.code}${issue.code === 'INACTIVE_COMPONENT' ? `:${row.bom_line_id ?? 'missing'}` : ''}`;
          if (!seenExceptions.has(identity)) {
            seenExceptions.add(identity);
            exceptions.push({
              ...issue,
              order_id: row.order_id,
              order_line_id: row.order_line_id,
              order_number: row.order_number,
              line_number: row.order_line_number,
              need_by_date: row.need_by_date,
              bom_line_id: row.bom_line_id,
              component_item_id: row.component_item_id,
            });
          }
          continue;
        }
        if (!row.bom_line_id || !row.component_item_id || !row.required_quantity) continue;
        candidates.push({ id: randomUUID(), source: row, requiredQuantity: row.required_quantity });
      }

      const componentIds = [...new Set(candidates.map((c) => c.source.component_item_id as string))];
      const bomLineIds = [...new Set(candidates.map((c) => c.source.bom_line_id as string))];
      const alternateRows: AlternateRow[] = componentIds.length && bomLineIds.length
        ? (await client.query<AlternateRow>(`
            SELECT
              a.id::text AS id,
              a.bom_line_id::text AS bom_line_id,
              a.alternate_item_id::text AS item_id,
              i.sku,
              i.name,
              i.unit,
              i.status,
              a.conversion_factor::text AS conversion_factor,
              a.inventory_quantity_per_component::text AS quantity_per_component,
              a.rationale
            FROM product_bom_alternates a
            JOIN inventory_items i
              ON i.id = a.alternate_item_id
             AND i.tenant_id = a.tenant_id
             AND i.factory_id = a.factory_id
            WHERE a.tenant_id = $1
              AND a.factory_id = $2
              AND a.bom_line_id = ANY($3::uuid[])
              AND a.status = 'APPROVED'
              AND i.status = 'ACTIVE'
            ORDER BY a.bom_line_id, i.sku, a.id
          `, [tenantId, factoryId, bomLineIds])).rows
        : [];

      const itemIds = [...new Set([
        ...componentIds,
        ...alternateRows.filter((a) => a.status === 'ACTIVE').map((a) => a.item_id),
      ])];
      const stockRows: StockRow[] = itemIds.length
        ? (await client.query<StockRow>(`
            SELECT i.id::text AS id, i.sku, i.name, i.unit, i.status,
              COALESCE(sb.quantity_on_hand, 0)::text AS quantity_on_hand,
              COALESCE(sb.quantity_reserved, 0)::text AS quantity_reserved
            FROM inventory_items i
            LEFT JOIN inventory_stock_balances sb
              ON sb.item_id = i.id
             AND sb.tenant_id = i.tenant_id
             AND sb.factory_id = i.factory_id
            WHERE i.tenant_id = $1 AND i.factory_id = $2 AND i.id = ANY($3::uuid[])
          `, [tenantId, factoryId, itemIds])).rows
        : [];
      const stockByItem = new Map<string, MrpStockPosition>(
        stockRows.map((row) => [row.id, {
          onHandQuantity: row.quantity_on_hand,
          reservedQuantity: row.quantity_reserved,
        }] as const),
      );

      const incomingRows: IncomingRow[] = itemIds.length
        ? (await client.query<IncomingRow>(`
            SELECT
              po.id::text || ':' || pol.id::text AS id,
              pol.inventory_item_id::text AS item_id,
              po.po_number AS purchase_order_number,
              po.expected_delivery_date::text AS expected_delivery_date,
              (pol.quantity - COALESCE(received.accepted_quantity, 0))::numeric(18,4)::text AS remaining_quantity,
              (po.expected_delivery_date IS NOT NULL
                AND po.expected_delivery_date >= CURRENT_DATE) AS eligible_for_allocation
            FROM purchase_order_lines pol
            JOIN purchase_orders po
              ON po.id = pol.purchase_order_id
             AND po.tenant_id = pol.tenant_id
             AND po.factory_id = pol.factory_id
            JOIN inventory_items i
              ON i.id = pol.inventory_item_id
             AND i.tenant_id = pol.tenant_id
             AND i.factory_id = pol.factory_id
             AND i.status = 'ACTIVE'
             AND upper(btrim(i.unit)) = upper(btrim(pol.unit))
            LEFT JOIN LATERAL (
              SELECT COALESCE(SUM(gl.accepted_quantity), 0)::numeric(18,4) AS accepted_quantity
              FROM goods_receipt_lines gl
              JOIN goods_receipts gr
                ON gr.id = gl.goods_receipt_id
               AND gr.tenant_id = gl.tenant_id
               AND gr.factory_id = gl.factory_id
              WHERE gl.purchase_order_line_id = pol.id
                AND gl.tenant_id = pol.tenant_id
                AND gl.factory_id = pol.factory_id
                AND gr.status = 'POSTED'
            ) received ON TRUE
            WHERE po.tenant_id = $1
              AND po.factory_id = $2
              AND po.status = 'APPROVED'
              AND pol.inventory_item_id = ANY($3::uuid[])
              AND pol.quantity > COALESCE(received.accepted_quantity, 0)
            ORDER BY po.expected_delivery_date NULLS LAST, po.po_number, pol.id
          `, [tenantId, factoryId, itemIds])).rows
        : [];
      const incomingSupply: MrpIncomingSupply[] = incomingRows.map((row) => ({
        id: row.id,
        itemId: row.item_id,
        purchaseOrderNumber: row.purchase_order_number,
        expectedDeliveryDate: row.expected_delivery_date,
        remainingQuantity: row.remaining_quantity,
        eligibleForAllocation: row.eligible_for_allocation,
      }));

      const allocationDemands: MrpAllocationDemand[] = candidates.map((candidate) => ({
        requirementId: candidate.id,
        orderId: candidate.source.order_id,
        orderLineId: candidate.source.order_line_id,
        orderNumber: candidate.source.order_number,
        orderDate: candidate.source.order_date,
        lineNumber: candidate.source.order_line_number,
        bomLineNumber: candidate.source.bom_line_number as number,
        componentItemId: candidate.source.component_item_id as string,
        needByDate: candidate.source.need_by_date,
        requiredQuantity: candidate.requiredQuantity,
      }));
      const allocations = allocateMrpRequirements(allocationDemands, stockByItem, incomingSupply);
      const byRequirementId = new Map(allocations.map((a) => [a.requirementId, a] as const));
      const stockMetadata = new Map(stockRows.map((r) => [r.id, r] as const));
      const incomingByItem = new Map<string, string>();
      for (const incoming of incomingRows) {
        incomingByItem.set(incoming.item_id, this.add4(incomingByItem.get(incoming.item_id) ?? '0.0000', incoming.remaining_quantity));
      }
      const alternatesByBomLine = new Map<string, AlternateRow[]>();
      for (const alternate of alternateRows) {
        const group = alternatesByBomLine.get(alternate.bom_line_id) ?? [];
        group.push(alternate);
        alternatesByBomLine.set(alternate.bom_line_id, group);
      }

      const materialTotals = new Map<string, { item_id: string; sku: string; name: string; unit: string; required: string; shortage: string }>();
      let coveredCount = 0;
      let lateCount = 0;
      let unsuppliedCount = 0;
      for (const candidate of candidates) {
        const row = candidate.source;
        const allocation = byRequirementId.get(candidate.id);
        if (!allocation) throw new Error('MRP_LITE_ALLOCATION_MISSING');
        const itemId = row.component_item_id as string;
        if (allocation.allocationStatus === 'COVERED') coveredCount += 1;
        else if (allocation.allocationStatus === 'LATE_SUPPLY') lateCount += 1;
        else unsuppliedCount += 1;

        const total = materialTotals.get(itemId) ?? {
          item_id: itemId,
          sku: row.component_sku as string,
          name: row.component_name as string,
          unit: row.component_unit as string,
          required: '0.0000',
          shortage: '0.0000',
        };
        total.required = this.add4(total.required, candidate.requiredQuantity);
        total.shortage = this.add4(total.shortage, allocation.shortageQuantity);
        materialTotals.set(itemId, total);
      }

      const planId = randomUUID();
      await client.query(`
        INSERT INTO mrp_plans (
          id, tenant_id, factory_id, horizon_start, horizon_end, allocation_policy,
          idempotency_key, request_hash, request_id, trace_id, correlation_id,
          created_by_user_id, summary, exceptions
        ) VALUES ($1,$2,$3,$4::date,$5::date,'DUE_DATE_FIFO',$6,$7,$8::uuid,$9::uuid,$10::uuid,$11,$12::jsonb,$13::jsonb)
      `, [
        planId, tenantId, factoryId, horizonStart, horizonEnd, key, requestHash,
        this.validUuid(requestId), this.validUuid(traceId), correlationId, userId,
        JSON.stringify({
          order_line_count: openOrderLines.size,
          requirement_count: candidates.length,
          covered_count: coveredCount,
          late_supply_count: lateCount,
          unsupplied_count: unsuppliedCount,
          exception_count: exceptions.length,
          required_material_totals: [...materialTotals.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
        }),
        JSON.stringify(exceptions),
      ]);

      // Requirement rows are only persisted after the immutable plan header exists.
      // Insert the computed rows through a dedicated helper to keep the header FK intact.
      for (const candidate of candidates) {
        const allocation = byRequirementId.get(candidate.id);
        const row = candidate.source;
        const itemId = row.component_item_id as string;
        const scenarios = allocation && allocation.shortageQuantity !== '0.0000'
          ? (alternatesByBomLine.get(row.bom_line_id as string) ?? []).map((alternate) => {
              const alternateStock = stockMetadata.get(alternate.item_id);
              return {
                alternate_id: alternate.id, item_id: alternate.item_id, sku: alternate.sku,
                name: alternate.name, unit: alternate.unit, conversion_factor: alternate.conversion_factor,
                inventory_quantity_per_component: alternate.quantity_per_component, rationale: alternate.rationale,
                on_hand_quantity: alternateStock?.quantity_on_hand ?? '0.0000',
                allocated_quantity: alternateStock?.quantity_reserved ?? '0.0000',
                available_on_hand_quantity: this.subtractFloor4(
                  alternateStock?.quantity_on_hand ?? '0.0000', alternateStock?.quantity_reserved ?? '0.0000',
                ),
                incoming_quantity: incomingByItem.get(alternate.item_id) ?? '0.0000',
                primary_material_shortage_quantity: allocation.shortageQuantity,
                required_alternate_quantity: this.multiplyCeil4(
                  allocation.shortageQuantity, alternate.quantity_per_component,
                ),
                scenario_type: 'WHAT_IF_ONLY',
              };
            })
          : [];
        if (!allocation) throw new Error('MRP_LITE_ALLOCATION_MISSING');
        await client.query(`
          INSERT INTO mrp_plan_requirements (
            id, tenant_id, factory_id, plan_id, order_id, order_line_id, product_id,
            product_version_id, bom_line_id, component_item_id, order_number, order_status,
            order_line_number, need_by_date, product_code, product_name, product_version_number,
            bom_line_number, component_sku, component_name, component_unit, remaining_finished_quantity,
            expected_yield_percent, base_quantity_per, wastage_percent, required_quantity,
            on_hand_quantity, allocated_quantity, available_on_hand_quantity, incoming_quantity,
            planned_on_hand_allocation_quantity, planned_incoming_allocation_quantity,
            available_by_need_date_quantity, shortage_quantity, shortage_date, projected_available_date,
            allocation_status, substitute_scenarios
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
            $22::numeric,$23::numeric,$24::numeric,$25::numeric,$26::numeric,$27::numeric,$28::numeric,
            $29::numeric,$30::numeric,$31::numeric,$32::numeric,$33::numeric,$34::numeric,$35::date,
            $36::date,$37,$38::jsonb
          )
        `, [
          candidate.id, tenantId, factoryId, planId, row.order_id, row.order_line_id, row.product_id,
          row.product_version_id, row.bom_line_id, itemId, row.order_number, row.order_status,
          row.order_line_number, row.need_by_date, row.product_code, row.product_name,
          row.product_version_number, row.bom_line_number, row.component_sku, row.component_name,
          row.component_unit, row.remaining_finished_quantity, row.expected_yield_percent,
          row.base_quantity_per, row.wastage_percent, candidate.requiredQuantity,
          allocation.onHandQuantity, allocation.allocatedQuantity, allocation.availableOnHandQuantity,
          allocation.incomingQuantity, allocation.plannedOnHandAllocationQuantity,
          allocation.plannedIncomingAllocationQuantity, allocation.availableByNeedDateQuantity,
          allocation.shortageQuantity, allocation.shortageDate, allocation.projectedAvailableDate,
          allocation.allocationStatus, JSON.stringify(scenarios),
        ]);
      }

      await this.insertOutbox(client, {
        tenantId, factoryId, id: planId, correlationId, requestId, userId,
        payload: {
          plan_id: planId, horizon_start: horizonStart, horizon_end: horizonEnd,
          requirement_count: candidates.length, exception_count: exceptions.length,
          covered_count: coveredCount, late_supply_count: lateCount, unsupplied_count: unsuppliedCount,
        },
      });
      return { planId, replayed: false as const, requirementCount: candidates.length, exceptionCount: exceptions.length };
    });

    const plan = await this.getRun(userId, tenantId, factoryId, transactionResult.planId);
    if (!transactionResult.replayed) {
      await this.auditSafe({
        tenantId, factoryId, userId, action: 'MRP_LITE_PLAN_CREATED',
        resource: 'MRP_LITE_PLAN', id: transactionResult.planId, requestId, traceId,
        payload: {
          horizonStart, horizonEnd, replayed: false,
          requirementCount: transactionResult.requirementCount,
          exceptionCount: transactionResult.exceptionCount,
        },
      });
    }
    return { ...plan, replayed: transactionResult.replayed };
  }

  async listRuns(userId: string, tenantId: string, factoryId: string, rawLimit = 50) {
    this.assertScope(userId, tenantId, factoryId);
    const limit = this.limit(rawLimit);
    const result = await this.database.query(`
      SELECT ${PLAN_COLUMNS},
        (SELECT count(*)::int FROM mrp_plan_requirements r
         WHERE r.plan_id = p.id AND r.tenant_id = p.tenant_id AND r.factory_id = p.factory_id) AS requirement_count
      FROM mrp_plans p
      WHERE p.tenant_id = $1 AND p.factory_id = $2
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $3
    `, [tenantId, factoryId, limit], { tenantId, userId });
    return result.rows;
  }

  async getRun(userId: string, tenantId: string, factoryId: string, runId: string): Promise<Record<string, unknown> & { requirements: QueryResultRow[] }> {
    this.assertScope(userId, tenantId, factoryId);
    this.uuid(runId, 'runId');
    const planResult = await this.database.query(`
      SELECT ${PLAN_COLUMNS}
      FROM mrp_plans
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
    `, [runId, tenantId, factoryId], { tenantId, userId });
    const plan = planResult.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!plan) throw new NotFoundException('MRP-lite plan was not found in this factory');

    const requirementResult = await this.database.query(`
      SELECT id::text AS id, order_id::text AS order_id, order_line_id::text AS order_line_id,
        order_number, order_status, order_line_number, need_by_date::text AS need_by_date,
        product_id::text AS product_id, product_version_id::text AS product_version_id,
        product_code, product_name, product_version_number, bom_line_id::text AS bom_line_id,
        bom_line_number, component_item_id::text AS component_item_id, component_sku,
        component_name, component_unit, remaining_finished_quantity::text AS remaining_finished_quantity,
        expected_yield_percent::text AS expected_yield_percent, base_quantity_per::text AS base_quantity_per,
        wastage_percent::text AS wastage_percent, required_quantity::text AS required_quantity,
        on_hand_quantity::text AS on_hand_quantity, allocated_quantity::text AS allocated_quantity,
        available_on_hand_quantity::text AS available_on_hand_quantity,
        incoming_quantity::text AS incoming_quantity,
        planned_on_hand_allocation_quantity::text AS planned_on_hand_allocation_quantity,
        planned_incoming_allocation_quantity::text AS planned_incoming_allocation_quantity,
        available_by_need_date_quantity::text AS available_by_need_date_quantity,
        shortage_quantity::text AS shortage_quantity, shortage_date::text AS shortage_date,
        projected_available_date::text AS projected_available_date, allocation_status, substitute_scenarios,
        created_at::text AS created_at
      FROM mrp_plan_requirements
      WHERE plan_id = $1 AND tenant_id = $2 AND factory_id = $3
      ORDER BY need_by_date, order_number, order_line_number, bom_line_number, component_sku, id
    `, [runId, tenantId, factoryId], { tenantId, userId });
    return { ...plan, requirements: requirementResult.rows };
  }

  private async insertOutbox(
    client: PoolClient,
    input: { tenantId: string; factoryId: string; id: string; correlationId: string; requestId: string | null; userId: string; payload: Record<string, unknown> },
  ) {
    await client.query(`
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version,
        occurred_at, correlation_id, causation_id, actor, source, payload
      ) VALUES ($1,$2,'MRP_LITE_PLAN',$3,'MRP_LITE.PLAN_CREATED',1,clock_timestamp(),$4::uuid,$5::uuid,$6::jsonb,$7::jsonb,$8::jsonb)
    `, [
      input.tenantId, input.factoryId, input.id, input.correlationId, this.validUuid(input.requestId),
      JSON.stringify({ type: 'user', id: input.userId }),
      JSON.stringify({ system: 'FactoryOS', connector: 'mrp-lite-service', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
      JSON.stringify(input.payload),
    ]);
  }

  private async auditSafe(input: {
    tenantId: string; factoryId: string; userId: string; action: string; resource: string; id: string;
    requestId: string | null; traceId: string | null; payload: Record<string, unknown>;
  }) {
    try {
      await this.audit.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.userId,
        eventType: 'MRP_LITE', action: input.action, resourceType: input.resource, resourceId: input.id,
        requestId: this.validUuid(input.requestId), correlationId: this.validUuid(input.traceId),
        dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // Transactional outbox provides durable state-change evidence if the audit sink is unavailable.
    }
  }

  private assertScope(userId: string, tenantId: string, factoryId: string) {
    this.uuid(userId, 'userId'); this.uuid(tenantId, 'tenantId'); this.uuid(factoryId, 'factoryId');
  }
  private uuid(value: string, name: string) {
    if (!isUUID(value)) throw new BadRequestException(`${name} must be a valid UUID`);
  }
  private validUuid(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }
  private idempotencyKey(value: string | null): string {
    const key = value?.trim() ?? '';
    if (!key || key.length > 255) throw new BadRequestException('Idempotency-Key is required and must not exceed 255 characters');
    return key;
  }
  private calendarDate(value: string, field: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(`${field} must be a valid calendar date`);
    }
    return value;
  }
  private daysBetween(start: string, end: string): number {
    return (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000;
  }
  private limit(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return value;
  }
  private hash(value: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private add4(left: string, right: string): string {
    const toInt = (value: string) => {
      if (!/^\d+(?:\.\d{1,4})?$/.test(value)) throw new Error('MRP quantity is not a non-negative decimal');
      const [whole = '0', fraction = ''] = value.split('.');
      return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
    };
    const sum = toInt(left) + toInt(right);
    return `${(sum / 10_000n).toString()}.${(sum % 10_000n).toString().padStart(4, '0')}`;
  }
  private subtractFloor4(quantity: string, reserved: string): string {
    const toInt = (value: string) => {
      const [whole = '0', fraction = ''] = value.split('.');
      return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
    };
    const available = toInt(quantity) - toInt(reserved);
    const result = available > 0n ? available : 0n;
    return `${(result / 10_000n).toString()}.${(result % 10_000n).toString().padStart(4, '0')}`;
  }
  private multiplyCeil4(quantity: string, factor: string): string {
    const parseScaled = (value: string, scale: bigint, places: number): bigint => {
      const parts = value.split('.');
      const whole = parts[0] ?? '';
      const fraction = parts[1] ?? '';
      const isDigits = (input: string) => input.length > 0 && [...input].every((char) => char >= '0' && char <= '9');
      if (parts.length > 2 || !isDigits(whole) || (parts.length === 2 && !isDigits(fraction)) || fraction.length > places) {
        throw new Error('MRP alternate factor must be a non-negative decimal within supported precision');
      }
      return BigInt(whole) * scale + BigInt((fraction + '0'.repeat(places)).slice(0, places));
    };
    // Shortage is stored at 4 decimals; approved alternate UoM snapshots retain 6.
    const product = parseScaled(quantity, 10_000n, 4) * parseScaled(factor, 1_000_000n, 6);
    const rounded = (product + 999_999n) / 1_000_000n;
    return `${(rounded / 10_000n).toString()}.${(rounded % 10_000n).toString().padStart(4, '0')}`;
  }
}
