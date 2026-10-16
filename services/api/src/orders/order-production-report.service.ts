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
import { CreateOrderProductionReportDto } from './dto/create-order-production-report.dto';

interface ProductionReportRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  order_id: string;
  order_line_id: string;
  good_quantity: string;
  scrap_quantity: string;
  cumulative_good_quantity: string;
  cumulative_scrap_quantity: string;
  scrap_reason: string | null;
  notes: string | null;
  idempotency_key: string;
  request_hash: string;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
  yield_percent: string;
}

interface ProductionTotalsRow extends QueryResultRow {
  good_quantity: string;
  scrap_quantity: string;
}

const PRODUCTION_REPORT_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  order_id::text AS order_id,
  order_line_id::text AS order_line_id,
  good_quantity::text AS good_quantity,
  scrap_quantity::text AS scrap_quantity,
  cumulative_good_quantity::text AS cumulative_good_quantity,
  cumulative_scrap_quantity::text AS cumulative_scrap_quantity,
  scrap_reason,
  notes,
  idempotency_key,
  request_hash,
  created_by_user_id::text AS created_by_user_id,
  correlation_id::text AS correlation_id,
  created_at::text AS created_at,
  round(
    cumulative_good_quantity * 100
      / NULLIF(cumulative_good_quantity + cumulative_scrap_quantity, 0),
    4
  )::text AS yield_percent
`;

type ProductionReportResult = {
  id: string;
  tenant_id: string;
  factory_id: string;
  order_id: string;
  order_line_id: string;
  good_quantity: string;
  scrap_quantity: string;
  cumulative_good_quantity: string;
  cumulative_scrap_quantity: string;
  scrap_reason: string | null;
  notes: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
  yield_percent: string;
  replayed: boolean;
};

@Injectable()
export class OrderProductionReportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createReport(
    userId: string,
    tenantId: string,
    factoryId: string,
    orderId: string,
    dto: CreateOrderProductionReportDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<ProductionReportResult> {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(orderId, 'orderId');
    this.validateUuid(dto.order_line_id, 'order_line_id');

    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const lineId = dto.order_line_id.toLowerCase();
    const goodQuantity = this.normalizeQuantity(dto.good_quantity, 'good_quantity');
    const scrapQuantity = this.normalizeQuantity(dto.scrap_quantity, 'scrap_quantity');
    if (this.toUnits(goodQuantity) + this.toUnits(scrapQuantity) <= 0n) {
      throw new BadRequestException('good_quantity and scrap_quantity cannot both be zero');
    }

    const scrapReason = dto.scrap_reason?.trim() || null;
    if (this.toUnits(scrapQuantity) > 0n && !scrapReason) {
      throw new BadRequestException('scrap_reason is required when scrap_quantity is greater than zero');
    }
    const notes = dto.notes?.trim() || null;
    const normalizedOrderId = orderId.toLowerCase();
    const requestHash = this.hash({
      orderId: normalizedOrderId,
      orderLineId: lineId,
      goodQuantity,
      scrapQuantity,
      scrapReason,
      notes,
    });

    const result = await this.database.transaction(
      { tenantId, userId },
      async (client) => {
        // Serialize use of an idempotency key even when retries target different orders.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`order-production-report:${tenantId}:${factoryId}:${idempotencyKey}`],
        );

        const existing = await this.findByIdempotencyKey(
          client, tenantId, factoryId, idempotencyKey,
        );
        if (existing) return this.replayOrConflict(existing, requestHash);

        const orderResult = await client.query<{
          id: string;
          order_number: string;
          status: string;
        }>(
          `
          SELECT id::text AS id, order_number, status
          FROM orders
          WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
          FOR UPDATE
          `,
          [normalizedOrderId, tenantId, factoryId],
        );
        const order = orderResult.rows[0];
        if (!order) throw new NotFoundException('Order not found in this factory');
        if (order.status !== 'IN_PROGRESS') {
          throw new ConflictException('Production reports are only allowed for an in-progress order');
        }

        const lineResult = await client.query<{ id: string; quantity: string; product_code: string }>(
          `
          SELECT id::text AS id, quantity::text AS quantity, product_code
          FROM order_lines
          WHERE id = $1 AND order_id = $2 AND tenant_id = $3 AND factory_id = $4
          FOR UPDATE
          `,
          [lineId, normalizedOrderId, tenantId, factoryId],
        );
        const line = lineResult.rows[0];
        if (!line) throw new NotFoundException('Order line not found in this factory order');

        const totalsResult = await client.query<ProductionTotalsRow>(
          `
          SELECT
            COALESCE(SUM(good_quantity), 0)::text AS good_quantity,
            COALESCE(SUM(scrap_quantity), 0)::text AS scrap_quantity
          FROM order_production_reports
          WHERE tenant_id = $1 AND factory_id = $2 AND order_line_id = $3
          `,
          [tenantId, factoryId, lineId],
        );
        const totals = totalsResult.rows[0];
        const priorGood = this.toUnits(totals?.good_quantity ?? '0');
        const priorScrap = this.toUnits(totals?.scrap_quantity ?? '0');
        const nextGood = priorGood + this.toUnits(goodQuantity);
        const nextScrap = priorScrap + this.toUnits(scrapQuantity);
        if (nextGood > this.toUnits(line.quantity)) {
          throw new ConflictException(
            'Cumulative good output cannot exceed the order-line target quantity',
          );
        }

        const correlationId = traceId ?? requestId ?? randomUUID();
        const inserted = await client.query<ProductionReportRow>(
          `
          INSERT INTO order_production_reports (
            tenant_id, factory_id, order_id, order_line_id,
            good_quantity, scrap_quantity,
            cumulative_good_quantity, cumulative_scrap_quantity,
            scrap_reason, notes, idempotency_key, request_hash,
            created_by_user_id, correlation_id
          )
          VALUES (
            $1, $2, $3, $4, $5::numeric, $6::numeric,
            $7::numeric, $8::numeric, $9, $10, $11, $12, $13, $14::uuid
          )
          RETURNING ${PRODUCTION_REPORT_COLUMNS}
          `,
          [
            tenantId, factoryId, normalizedOrderId, lineId,
            goodQuantity, scrapQuantity,
            this.fromUnits(nextGood), this.fromUnits(nextScrap),
            scrapReason, notes, idempotencyKey, requestHash, userId, correlationId,
          ],
        );
        const report = inserted.rows[0];
        if (!report) throw new Error('ORDER_PRODUCTION_REPORT_INSERT_FAILED');

        await client.query(
          `
          INSERT INTO outbox_events (
            tenant_id, factory_id, aggregate_type, aggregate_id,
            event_type, event_version, occurred_at, correlation_id,
            causation_id, actor, source, payload
          )
          VALUES (
            $1, $2, 'ORDER', $3, 'ORDER.PRODUCTION_REPORTED', 1,
            clock_timestamp(), $4::uuid, $5::uuid, $6::jsonb, $7::jsonb, $8::jsonb
          )
          `,
          [
            tenantId,
            factoryId,
            normalizedOrderId,
            correlationId,
            requestId,
            JSON.stringify({ type: 'user', id: userId }),
            JSON.stringify({
              system: 'FactoryOS',
              connector: 'orders-production-report-service',
              version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
            }),
            JSON.stringify({
              order: { id: normalizedOrderId, order_number: order.order_number },
              line: { id: lineId, product_code: line.product_code, target_quantity: line.quantity },
              report: {
                id: report.id,
                good_quantity: report.good_quantity,
                scrap_quantity: report.scrap_quantity,
                cumulative_good_quantity: report.cumulative_good_quantity,
                cumulative_scrap_quantity: report.cumulative_scrap_quantity,
                scrap_reason: report.scrap_reason,
                yield_percent: report.yield_percent,
              },
              actor: { user_id: userId },
            }),
          ],
        );

        return this.toPublicResult(report, false);
      },
    );

    if (!result.replayed) {
      try {
        await this.auditService.record({
          tenantId,
          factoryId,
          actorUserId: userId,
          eventType: 'ORDER',
          action: 'PRODUCTION_REPORT_CREATED',
          resourceType: 'ORDER_PRODUCTION_REPORT',
          resourceId: result.id,
          correlationId: result.correlation_id,
          requestId,
          dataClass: 'INTERNAL',
          payload: {
            orderId: result.order_id,
            orderLineId: result.order_line_id,
            goodQuantity: result.good_quantity,
            scrapQuantity: result.scrap_quantity,
            cumulativeGoodQuantity: result.cumulative_good_quantity,
            cumulativeScrapQuantity: result.cumulative_scrap_quantity,
            yieldPercent: result.yield_percent,
          },
        });
      } catch {
        // The transactional outbox is durable; an audit sink failure cannot undo committed production.
      }
    }

    return result;
  }

  async listReports(
    userId: string,
    tenantId: string,
    factoryId: string,
    orderId: string,
    rawLimit?: number,
  ): Promise<ProductionReportResult[]> {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(orderId, 'orderId');
    const limit = rawLimit === undefined ? 50 : rawLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }

    const order = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id
      FROM orders
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
      `,
      [orderId, tenantId, factoryId],
      { tenantId, userId },
    );
    if (!order.rows[0]) throw new NotFoundException('Order not found in this factory');

    const reports = await this.database.query<ProductionReportRow>(
      `
      SELECT ${PRODUCTION_REPORT_COLUMNS}
      FROM order_production_reports
      WHERE tenant_id = $1 AND factory_id = $2 AND order_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $4
      `,
      [tenantId, factoryId, orderId, limit],
      { tenantId, userId },
    );
    return reports.rows.map((row) => this.toPublicResult(row, false));
  }

  private async findByIdempotencyKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
  ): Promise<ProductionReportRow | null> {
    const result = await client.query<ProductionReportRow>(
      `
      SELECT ${PRODUCTION_REPORT_COLUMNS}
      FROM order_production_reports
      WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  private replayOrConflict(
    existing: ProductionReportRow,
    requestHash: string,
  ): ProductionReportResult {
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for a different production report');
    }
    return this.toPublicResult(existing, true);
  }

  private toPublicResult(
    row: ProductionReportRow,
    replayed: boolean,
  ): ProductionReportResult {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      factory_id: row.factory_id,
      order_id: row.order_id,
      order_line_id: row.order_line_id,
      good_quantity: row.good_quantity,
      scrap_quantity: row.scrap_quantity,
      cumulative_good_quantity: row.cumulative_good_quantity,
      cumulative_scrap_quantity: row.cumulative_scrap_quantity,
      scrap_reason: row.scrap_reason,
      notes: row.notes,
      created_by_user_id: row.created_by_user_id,
      correlation_id: row.correlation_id,
      created_at: row.created_at,
      yield_percent: row.yield_percent,
      replayed,
    };
  }

  private requiredIdempotencyKey(value: string | null): string {
    const key = value?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key header is required');
    if (key.length > 255) throw new BadRequestException('Idempotency-Key must not exceed 255 characters');
    return key;
  }

  private normalizeQuantity(value: number, field: string): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative number`);
    }
    const text = value.toString();
    if (!/^\d+(?:\.\d{1,4})?$/.test(text)) {
      throw new BadRequestException(`${field} must have at most four decimal places`);
    }
    return value.toFixed(4);
  }

  private toUnits(value: string): bigint {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 10000n + BigInt((fraction + '0000').slice(0, 4));
  }

  private fromUnits(value: bigint): string {
    const whole = value / 10000n;
    const fraction = String(value % 10000n).padStart(4, '0');
    return `${whole}.${fraction}`;
  }

  private hash(value: Record<string, string | null>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) throw new BadRequestException(`${field} must be a valid UUID`);
  }
}
