import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { DatabaseService } from '../database/database.service';
import {
  ChangeTraceabilityUnitStatusDto,
  CreateGenealogyEventDto,
  CreateTraceabilityLabelTemplateDto,
  CreateTraceabilityUnitDto,
  IssueTraceabilityLabelDto,
  UpdateTraceabilitySettingsDto,
} from './dto/traceability.dto';

interface StoredKeyRow extends QueryResultRow {
  id: string;
  request_hash: string;
}
export interface UnitRow extends QueryResultRow {
  id: string;
  unit_code?: string;
  request_hash?: string;
}
const UNIT_SELECT = `
  u.id::text AS id,
  u.tenant_id::text AS tenant_id,
  u.factory_id::text AS factory_id,
  u.unit_type,
  u.product_role,
  u.unit_code,
  u.barcode_value,
  u.rfid_epc,
  u.inventory_item_id::text AS inventory_item_id,
  i.sku AS inventory_sku,
  i.name AS inventory_item_name,
  u.quantity::text AS quantity,
  u.unit,
  u.supplier_id::text AS supplier_id,
  s.code AS supplier_code,
  s.name AS supplier_name,
  u.goods_receipt_id::text AS goods_receipt_id,
  gr.receipt_number,
  gr.supplier_delivery_reference,
  u.goods_receipt_line_id::text AS goods_receipt_line_id,
  u.order_id::text AS order_id,
  o.order_number,
  u.order_line_id::text AS order_line_id,
  ol.product_code,
  ol.product_name,
  u.production_report_id::text AS production_report_id,
  u.label_template_id::text AS label_template_id,
  lt.template_code AS label_template_code,
  lt.symbology AS label_symbology,
  lt.label_layout,
  u.external_reference,
  u.manufactured_at::text AS manufactured_at,
  u.expires_at::text AS expires_at,
  u.status,
  u.attributes,
  u.version,
  u.created_by_user_id::text AS created_by_user_id,
  u.correlation_id::text AS correlation_id,
  u.created_at::text AS created_at,
  u.updated_at::text AS updated_at


  FROM traceability_units u
  LEFT JOIN inventory_items i
    ON i.id = u.inventory_item_id AND i.tenant_id = u.tenant_id AND i.factory_id = u.factory_id
  LEFT JOIN suppliers s ON s.id = u.supplier_id AND s.tenant_id = u.tenant_id
  LEFT JOIN goods_receipts gr
    ON gr.id = u.goods_receipt_id AND gr.tenant_id = u.tenant_id AND gr.factory_id = u.factory_id
  LEFT JOIN orders o
    ON o.id = u.order_id AND o.tenant_id = u.tenant_id AND o.factory_id = u.factory_id
  LEFT JOIN order_lines ol
    ON ol.id = u.order_line_id AND ol.order_id = u.order_id
   AND ol.tenant_id = u.tenant_id AND ol.factory_id = u.factory_id
  LEFT JOIN traceability_label_templates lt
    ON lt.id = u.label_template_id AND lt.tenant_id = u.tenant_id AND lt.factory_id = u.factory_id
`;
const GENEALOGY_SELECT = `
  e.id::text AS id,
  e.tenant_id::text AS tenant_id,
  e.factory_id::text AS factory_id,
  e.source_unit_id::text AS source_unit_id,
  su.unit_code AS source_unit_code,
  su.unit_type AS source_unit_type,
  e.target_unit_id::text AS target_unit_id,
  tu.unit_code AS target_unit_code,
  tu.unit_type AS target_unit_type,
  e.relationship_type,
  e.quantity::text AS quantity,
  e.unit,
  e.evidence,
  e.notes,
  e.created_by_user_id::text AS created_by_user_id,
  e.correlation_id::text AS correlation_id,
  e.created_at::text AS created_at
  FROM product_genealogy_events e
  JOIN traceability_units su
    ON su.id = e.source_unit_id AND su.tenant_id = e.tenant_id AND su.factory_id = e.factory_id
  JOIN traceability_units tu
    ON tu.id = e.target_unit_id AND tu.tenant_id = e.tenant_id AND tu.factory_id = e.factory_id
`;

@Injectable()
export class TraceabilityService {
  constructor(private readonly database: DatabaseService) {}

  async createUnit(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateTraceabilityUnitDto,
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const unitCode = this.requiredText(dto.unit_code, 'unit_code', 160).toUpperCase();
    const barcodeValue = dto.barcode_value?.trim() || unitCode;
    if (barcodeValue.length > 255) throw new BadRequestException('barcode_value must contain at most 255 characters');
    const rfidEpc = dto.rfid_epc?.trim().toUpperCase() || null;
    if (rfidEpc && !/^[A-Z0-9._:-]{1,128}$/.test(rfidEpc)) {
      throw new BadRequestException('rfid_epc must contain 1-128 letters, digits, dot, underscore, colon or hyphen');
    }
    const quantity = this.quantity(dto.quantity, 'quantity');
    if (dto.unit_type === 'SERIAL' && quantity !== '1.0000') {
      throw new BadRequestException('SERIAL identities must have quantity exactly 1');
    }
    const unit = this.requiredText(dto.unit, 'unit', 50).toUpperCase();
    const productRole = dto.product_role;
    if (!['MATERIAL', 'FINISHED_GOOD', 'PACKAGING', 'SHIPMENT', 'OTHER'].includes(productRole)) {
      throw new BadRequestException('product_role is not supported');
    }
    if ((dto.unit_type === 'SHIPMENT') !== (productRole === 'SHIPMENT')) {
      throw new BadRequestException('SHIPMENT unit type and product role must be selected together');
    }
    const inventoryItemId = this.optionalUuid(dto.inventory_item_id, 'inventory_item_id');
    const goodsReceiptLineId = this.optionalUuid(dto.goods_receipt_line_id, 'goods_receipt_line_id');
    let orderId = this.optionalUuid(dto.order_id, 'order_id');
    let orderLineId = this.optionalUuid(dto.order_line_id, 'order_line_id');
    const productionReportId = this.optionalUuid(dto.production_report_id, 'production_report_id');
    const labelTemplateId = this.optionalUuid(dto.label_template_id, 'label_template_id');
    if ((orderId && !orderLineId) || (!orderId && orderLineId)) {
      throw new BadRequestException('order_id and order_line_id must be provided together');
    }

    const manufacturedAt = dto.manufactured_at ? new Date(dto.manufactured_at) : null;
    if (manufacturedAt && !Number.isFinite(manufacturedAt.getTime())) {
      throw new BadRequestException('manufactured_at must be a valid ISO date/time');
    }
    const expiresAt = dto.expires_at ?? null;
    if (expiresAt && manufacturedAt && new Date(expiresAt).getTime() < manufacturedAt.getTime()) {
      throw new BadRequestException('expires_at must not be earlier than manufactured_at');
    }
    const attributes = this.objectValue(dto.attributes);
    const externalReference = dto.external_reference?.trim() || null;
    if (externalReference && externalReference.length > 255) {
      throw new BadRequestException('external_reference must contain at most 255 characters');
    }
    if (
      ['MATERIAL', 'FINISHED_GOOD'].includes(productRole)
      && !inventoryItemId && !goodsReceiptLineId && !productionReportId && !orderLineId && !externalReference
    ) {
      throw new BadRequestException('Material/finished-good identity requires an inventory item, GRN line, production report, order line, or external reference');
    }

    const requestHashPayload: Record<string, unknown> = {
      unit_type: dto.unit_type,
      product_role: productRole,
      unit_code: unitCode,
      barcode_value: barcodeValue,
      inventory_item_id: inventoryItemId,
      goods_receipt_line_id: goodsReceiptLineId,
      order_id: orderId,
      order_line_id: orderLineId,
      production_report_id: productionReportId,
      label_template_id: labelTemplateId,
      quantity,
      unit,
      external_reference: externalReference,
      manufactured_at: manufacturedAt?.toISOString() ?? null,
      expires_at: expiresAt,
      attributes,
    };
    // Preserve idempotency hashes for pre-RFID clients that omitted this field.
    if (rfidEpc !== null) requestHashPayload.rfid_epc = rfidEpc;
    const requestHash = this.hash(requestHashPayload);
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    let identityId: string;
    let replayed: boolean;
    try {
      const result = await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':traceability-unit:' + idempotencyKey],
          );
          const existing = await client.query<StoredKeyRow>(`
            SELECT id::text AS id, request_hash
            FROM traceability_units
            WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different traceability-unit request');
            }
            return { id: existing.rows[0].id, replayed: true };
          }

          if (productionReportId) {
            const report = await client.query<{ order_id: string; order_line_id: string }>(`
              SELECT order_id::text AS order_id, order_line_id::text AS order_line_id
              FROM order_production_reports
              WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
              LIMIT 1
            `, [productionReportId, tenantId, factoryId]);
            if (!report.rows[0]) throw new NotFoundException('Production report not found in this factory');
            if (orderId && orderId !== report.rows[0].order_id) {
              throw new BadRequestException('order_id does not match the production report');
            }
            if (orderLineId && orderLineId !== report.rows[0].order_line_id) {
              throw new BadRequestException('order_line_id does not match the production report');
            }
            orderId = report.rows[0].order_id;
            orderLineId = report.rows[0].order_line_id;
          }
          if (goodsReceiptLineId) {
            const receiptLine = await client.query<{ inventory_item_id: string | null }>(`
              SELECT gl.inventory_item_id::text AS inventory_item_id
              FROM goods_receipt_lines gl
              JOIN goods_receipts gr
                ON gr.id = gl.goods_receipt_id AND gr.tenant_id = gl.tenant_id AND gr.factory_id = gl.factory_id
              WHERE gl.id = $1 AND gl.tenant_id = $2 AND gl.factory_id = $3
                AND gr.status = 'POSTED' AND gl.accepted_quantity > 0
              LIMIT 1
            `, [goodsReceiptLineId, tenantId, factoryId]);
            if (!receiptLine.rows[0]) throw new NotFoundException('Accepted goods-receipt line not found in this factory');
            if (inventoryItemId && inventoryItemId !== receiptLine.rows[0].inventory_item_id) {
              throw new BadRequestException('inventory_item_id does not match the GRN line');
            }
          }
          const inserted = await client.query<StoredKeyRow>(`
            INSERT INTO traceability_units (
              tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value, rfid_epc,
              inventory_item_id, quantity, unit, goods_receipt_line_id, order_id, order_line_id,
              production_report_id, label_template_id, external_reference, manufactured_at, expires_at,
              attributes, idempotency_key, request_hash, created_by_user_id, correlation_id
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13,
              $14, $15, $16, $17::timestamptz, $18::date, $19::jsonb, $20, $21, $22, $23
            )
            RETURNING id::text AS id, request_hash
          `, [
            tenantId, factoryId, dto.unit_type, productRole, unitCode, barcodeValue, rfidEpc,
            inventoryItemId, quantity, unit, goodsReceiptLineId, orderId, orderLineId,
            productionReportId, labelTemplateId, externalReference, manufacturedAt?.toISOString() ?? null,
            expiresAt, JSON.stringify(attributes), idempotencyKey, requestHash, userId, correlationId,
          ]);
          const created = inserted.rows[0];
          if (!created) throw new Error('TRACEABILITY_UNIT_INSERT_FAILED');

          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1, $2, 'TRACEABILITY_UNIT', $3, 'TRACEABILITY.UNIT_REGISTERED', $4::jsonb)
          `, [tenantId, factoryId, created.id, JSON.stringify({
            unit_id: created.id,
            unit_type: dto.unit_type,
            product_role: productRole,
            unit_code: unitCode,
            barcode_value: barcodeValue,
            quantity,
            unit,
            goods_receipt_line_id: goodsReceiptLineId,
            production_report_id: productionReportId,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'TRACEABILITY_UNIT', resourceId: created.id,
            action: 'REGISTERED', correlationId, requestId: requestUuid,
            payload: { unit_type: dto.unit_type, product_role: productRole, unit_code: unitCode, barcode_value: barcodeValue },
          });
          return { id: created.id, replayed: false };
        },
      );
      identityId = result.id;
      replayed = result.replayed;
    } catch (error) {
      throw this.mapDatabaseError(error, 'Traceability unit conflicts with an existing identity, source reference, or idempotency key');
    }

    const identity = await this.getUnit(userId, tenantId, factoryId, identityId);
    return { ...identity, replayed };
  }

  async listUnits(
    userId: string, tenantId: string, factoryId: string,
    options: { search?: string; unitType?: string; productRole?: string; status?: string; limit?: number },
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const unitType = options.unitType?.trim().toUpperCase() || null;
    const productRole = options.productRole?.trim().toUpperCase() || null;
    const status = options.status?.trim().toUpperCase() || null;
    for (const [field, value] of [['unit_type', unitType], ['product_role', productRole], ['status', status]] as const) {
      if (value && !this.allowedFilter(field, value)) throw new BadRequestException(field + ' is not supported');
    }
    const search = options.search?.trim() || null;
    const result = await this.database.query(`
      SELECT ${UNIT_SELECT}
      WHERE u.tenant_id = $1 AND u.factory_id = $2
        AND ($3::text IS NULL OR u.unit_code ILIKE '%' || $3 || '%' OR u.barcode_value ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR u.unit_type = $4)
        AND ($5::text IS NULL OR u.product_role = $5)
        AND ($6::text IS NULL OR u.status = $6)
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT $7
    `, [tenantId, factoryId, search, unitType, productRole, status, limit], { tenantId, userId });
    return { units: result.rows, limit };
  }

  async getUnit(userId: string, tenantId: string, factoryId: string, unitId: string) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(unitId, 'unitId');
    const result = await this.database.query(`
      SELECT ${UNIT_SELECT}
      WHERE u.id = $1 AND u.tenant_id = $2 AND u.factory_id = $3
      LIMIT 1
    `, [unitId, tenantId, factoryId], { tenantId, userId });
    if (!result.rows[0]) throw new NotFoundException('Traceability unit not found in this factory');
    return result.rows[0];
  }

  async recordGenealogyEvent(
    userId: string, tenantId: string, factoryId: string,
    dto: CreateGenealogyEventDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const sourceUnitId = this.requiredUuid(dto.source_unit_id, 'source_unit_id');
    const targetUnitId = this.requiredUuid(dto.target_unit_id, 'target_unit_id');
    if (sourceUnitId === targetUnitId) throw new BadRequestException('source_unit_id and target_unit_id must be different');
    const relationshipType = dto.relationship_type.trim().toUpperCase();
    if (!this.allowedFilter('relationship_type', relationshipType)) {
      throw new BadRequestException('relationship_type is not supported');
    }
    const quantity = this.quantity(dto.quantity, 'quantity');
    const notes = dto.notes?.trim() || null;
    const evidence = this.objectValue(dto.evidence);
    const requestHash = this.hash({
      source_unit_id: sourceUnitId,
      target_unit_id: targetUnitId,
      relationship_type: relationshipType,
      quantity,
      notes,
      evidence,
    });
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    let eventId: string;
    let replayed: boolean;
    try {
      const result = await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':genealogy-idempotency:' + idempotencyKey],
          );
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':product-genealogy-graph'],
          );
          const existing = await client.query<StoredKeyRow>(`
            SELECT id::text AS id, request_hash
            FROM product_genealogy_events
            WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different genealogy request');
            }
            return { id: existing.rows[0].id, replayed: true };
          }

          const source = await client.query<{ id: string; unit: string }>(`
            SELECT id::text AS id, unit
            FROM traceability_units
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
          `, [sourceUnitId, tenantId, factoryId]);
          const target = await client.query<{ id: string }>(`
            SELECT id::text AS id
            FROM traceability_units
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
          `, [targetUnitId, tenantId, factoryId]);
          if (!source.rows[0] || !target.rows[0]) {
            throw new NotFoundException('Both genealogy units must exist in this factory');
          }
          const inserted = await client.query<StoredKeyRow>(`
            INSERT INTO product_genealogy_events (
              tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
              quantity, unit, evidence, notes, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES (
              $1, $2, $3, $4, $5, $6::numeric, $7, $8::jsonb, $9, $10, $11, $12, $13
            )
            RETURNING id::text AS id, request_hash
          `, [
            tenantId, factoryId, sourceUnitId, targetUnitId, relationshipType, quantity,
            source.rows[0].unit, JSON.stringify(evidence), notes, idempotencyKey, requestHash,
            userId, correlationId,
          ]);
          const event = inserted.rows[0];
          if (!event) throw new Error('PRODUCT_GENEALOGY_EVENT_INSERT_FAILED');
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1, $2, 'PRODUCT_GENEALOGY_EVENT', $3, 'TRACEABILITY.GENEALOGY_RECORDED', $4::jsonb)
          `, [tenantId, factoryId, event.id, JSON.stringify({
            genealogy_event_id: event.id,
            source_unit_id: sourceUnitId,
            target_unit_id: targetUnitId,
            relationship_type: relationshipType,
            quantity,
            unit: source.rows[0].unit,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'PRODUCT_GENEALOGY_EVENT', resourceId: event.id,
            action: 'RECORDED', correlationId, requestId: requestUuid,
            payload: { sourceUnitId, targetUnitId, relationshipType, quantity, unit: source.rows[0].unit },
          });
          return { id: event.id, replayed: false };
        },
      );
      eventId = result.id;
      replayed = result.replayed;
    } catch (error) {
      throw this.mapDatabaseError(error, 'Genealogy event conflicts with an existing edge or idempotency key');
    }
    const eventResult = await this.database.query(`
      SELECT ${GENEALOGY_SELECT}
      WHERE e.id = $1 AND e.tenant_id = $2 AND e.factory_id = $3
      LIMIT 1
    `, [eventId, tenantId, factoryId], { tenantId, userId });
    if (!eventResult.rows[0]) throw new NotFoundException('Genealogy event not found in this factory');
    return { ...eventResult.rows[0], replayed };
  }

  async trace(
    userId: string, tenantId: string, factoryId: string,
    unitId: string, direction: 'FORWARD' | 'REVERSE',
    rawDepth?: number, rawLimit?: number,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(unitId, 'unitId');
    const depth = rawDepth ?? 5;
    const limit = rawLimit ?? 200;
    if (!Number.isInteger(depth) || depth < 1 || depth > 12) {
      throw new BadRequestException('depth must be an integer between 1 and 12');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new BadRequestException('limit must be an integer between 1 and 500');
    }
    const context = { tenantId, userId };
    const root = await this.database.query(`
      SELECT ${UNIT_SELECT}
      WHERE u.id = $1 AND u.tenant_id = $2 AND u.factory_id = $3
      LIMIT 1
    `, [unitId, tenantId, factoryId], context);
    if (!root.rows[0]) throw new NotFoundException('Traceability unit not found in this factory');
    const nextJoin = direction === 'FORWARD' ? 'e.source_unit_id = w.unit_id' : 'e.target_unit_id = w.unit_id';
    const nextId = direction === 'FORWARD' ? 'e.target_unit_id' : 'e.source_unit_id';
    const walk = await this.database.query(`
      WITH RECURSIVE walk(unit_id, depth, visited) AS (
        SELECT $1::uuid, 0, ARRAY[$1::uuid]::uuid[]
        UNION ALL
        SELECT ${nextId}, w.depth + 1, w.visited || ${nextId}
        FROM walk w
        JOIN product_genealogy_events e
          ON ${nextJoin} AND e.tenant_id = $2 AND e.factory_id = $3
        WHERE w.depth < $4 AND NOT (${nextId} = ANY(w.visited))
      )
      SELECT unit_id::text AS unit_id, min(depth)::int AS depth
      FROM walk
      GROUP BY unit_id
      ORDER BY min(depth), unit_id
      LIMIT $5
    `, [unitId, tenantId, factoryId, depth, limit], context);
    const unitIds: string[] = walk.rows.map(row => String(row.unit_id));
    const depthById = new Map(walk.rows.map(row => [String(row.unit_id), Number(row.depth)]));
    const nodesResult = await this.database.query(`
      SELECT ${UNIT_SELECT}
      WHERE u.id = ANY($1::uuid[]) AND u.tenant_id = $2 AND u.factory_id = $3
      ORDER BY u.created_at, u.id
    `, [unitIds, tenantId, factoryId], context);
    const units = nodesResult.rows.map(row => ({ ...row, depth: depthById.get(String(row.id)) ?? 0 }));
    const edgesResult = await this.database.query(`
      SELECT ${GENEALOGY_SELECT}
      WHERE e.source_unit_id = ANY($1::uuid[]) AND e.target_unit_id = ANY($1::uuid[])
        AND e.tenant_id = $2 AND e.factory_id = $3
      ORDER BY e.created_at, e.id
      LIMIT 1000
    `, [unitIds, tenantId, factoryId], context);
    const settings = await this.getSettings(userId, tenantId, factoryId);
    return {
      root: root.rows[0],
      direction,
      max_depth: depth,
      limit,
      retention_years: settings.retention_years,
      truncated: units.length >= limit,
      units,
      relationships: edgesResult.rows,
    };
  }

  async changeUnitStatus(
    userId: string, tenantId: string, factoryId: string, unitId: string,
    dto: ChangeTraceabilityUnitStatusDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(unitId, 'unitId');
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const targetStatus = dto.target_status.trim().toUpperCase();
    if (!['ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED'].includes(targetStatus)) {
      throw new BadRequestException('target_status is not supported');
    }
    const reason = this.requiredText(dto.reason, 'reason', 2000);
    const requestHash = this.hash({ unit_id: unitId.toLowerCase(), target_status: targetStatus, reason });
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    try {
      const result = await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':traceability-status:' + idempotencyKey],
          );
          const existing = await client.query<StoredKeyRow & { unit_id: string; from_status: string; to_status: string; version: string }>(`
            SELECT id::text AS id, request_hash, unit_id::text AS unit_id, from_status, to_status, version::text AS version
            FROM traceability_unit_status_events
            WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different traceability status request');
            }
            return { event: existing.rows[0], replayed: true };
          }
          const current = await client.query<{ status: string; version: string }>(`
            SELECT status, version::text AS version
            FROM traceability_units
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
          `, [unitId, tenantId, factoryId]);
          if (!current.rows[0]) throw new NotFoundException('Traceability unit not found in this factory');
          const fromStatus = current.rows[0].status;
          if (fromStatus === targetStatus) throw new ConflictException('Traceability unit already has the requested status');
          const nextVersion = Number(current.rows[0].version) + 1;
          const updated = await client.query<{ id: string }>(`
            UPDATE traceability_units
            SET status = $1, version = version + 1, updated_at = clock_timestamp()
            WHERE id = $2 AND tenant_id = $3 AND factory_id = $4 AND status = $5
            RETURNING id::text AS id
          `, [targetStatus, unitId, tenantId, factoryId, fromStatus]);
          if (!updated.rows[0]) throw new ConflictException('Traceability unit status changed concurrently; reload and retry');
          const history = await client.query<StoredKeyRow & { unit_id: string; from_status: string; to_status: string; version: string }>(`
            INSERT INTO traceability_unit_status_events (
              tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
              idempotency_key, request_hash, changed_by_user_id, correlation_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id::text AS id, request_hash, unit_id::text AS unit_id,
              from_status, to_status, version::text AS version
          `, [tenantId, factoryId, unitId, nextVersion, fromStatus, targetStatus,
            reason, idempotencyKey, requestHash, userId, correlationId]);
          const event = history.rows[0];
          if (!event) throw new Error('TRACEABILITY_STATUS_EVENT_INSERT_FAILED');
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1, $2, 'TRACEABILITY_UNIT', $3, 'TRACEABILITY.UNIT_STATUS_CHANGED', $4::jsonb)
          `, [tenantId, factoryId, unitId, JSON.stringify({
            unit_id: unitId, from_status: fromStatus, to_status: targetStatus,
            reason, version: nextVersion,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'TRACEABILITY_UNIT', resourceId: unitId,
            action: 'STATUS_CHANGED', correlationId, requestId: requestUuid,
            payload: { fromStatus, toStatus: targetStatus, reason, version: nextVersion },
          });
          return { event, replayed: false };
        },
      );
      return { ...result.event, replayed: result.replayed };
    } catch (error) {
      throw this.mapDatabaseError(error, 'Traceability status transition violates lifecycle or idempotency rules');
    }
  }

  async createLabelTemplate(
    userId: string, tenantId: string, factoryId: string,
    dto: CreateTraceabilityLabelTemplateDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const templateCode = this.requiredText(dto.template_code, 'template_code', 100).toUpperCase();
    const name = this.requiredText(dto.name, 'name', 255);
    const symbology = dto.symbology.trim().toUpperCase();
    if (!['QR', 'CODE128', 'DATAMATRIX', 'GS1_128'].includes(symbology)) {
      throw new BadRequestException('symbology must be QR, CODE128, DATAMATRIX or GS1_128');
    }
    if (!Array.isArray(dto.supported_unit_types) || dto.supported_unit_types.length === 0) {
      throw new BadRequestException('supported_unit_types must contain at least one traceability unit type');
    }
    const supportedUnitTypes = [...new Set(dto.supported_unit_types.map(x => String(x).toUpperCase()))];
    if (supportedUnitTypes.some(x => !['LOT', 'SERIAL', 'PALLET', 'CARTON', 'BUNDLE', 'FINISHED_GOOD', 'SHIPMENT'].includes(x))) {
      throw new BadRequestException('supported_unit_types contains an unsupported unit type');
    }
    const labelLayout = this.objectValue(dto.label_layout);
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();
    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          const result = await client.query<UnitRow>(`
            INSERT INTO traceability_label_templates (
              tenant_id, factory_id, template_code, name, symbology, supported_unit_types,
              label_layout, created_by_user_id
            ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8)
            RETURNING id::text AS id, template_code, name, symbology, supported_unit_types,
              label_layout, is_active, created_at::text AS created_at
          `, [tenantId, factoryId, templateCode, name, symbology, supportedUnitTypes, JSON.stringify(labelLayout), userId]);
          const template = result.rows[0];
          if (!template) throw new Error('TRACEABILITY_LABEL_TEMPLATE_INSERT_FAILED');
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1, $2, 'TRACEABILITY_LABEL_TEMPLATE', $3, 'TRACEABILITY.LABEL_TEMPLATE_CREATED', $4::jsonb)
          `, [tenantId, factoryId, template.id, JSON.stringify({
            template_id: template.id, template_code: templateCode, symbology, supported_unit_types: supportedUnitTypes,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'TRACEABILITY_LABEL_TEMPLATE', resourceId: template.id,
            action: 'CREATED', correlationId, requestId: requestUuid,
            payload: { templateCode, symbology, supportedUnitTypes },
          });
          return template;
        },
      );
    } catch (error) {
      throw this.mapDatabaseError(error, 'Label template conflicts with an existing code or invalid scope');
    }
  }

  async listLabelTemplates(userId: string, tenantId: string, factoryId: string, activeOnly = true) {
    this.validateScope(userId, tenantId, factoryId);
    const result = await this.database.query(`
      SELECT id::text AS id, template_code, name, symbology, supported_unit_types,
        label_layout, is_active, created_by_user_id::text AS created_by_user_id,
        created_at::text AS created_at
      FROM traceability_label_templates
      WHERE tenant_id = $1 AND factory_id = $2 AND ($3::boolean = FALSE OR is_active = TRUE)
      ORDER BY template_code, id
    `, [tenantId, factoryId, activeOnly], { tenantId, userId });
    return { templates: result.rows };
  }

  async getSettings(userId: string, tenantId: string, factoryId: string) {
    this.validateScope(userId, tenantId, factoryId);
    const result = await this.database.query(`
      SELECT tenant_id::text AS tenant_id, factory_id::text AS factory_id,
        retention_years, allocation_policy, version,
        updated_by_user_id::text AS updated_by_user_id,
        created_at::text AS created_at, updated_at::text AS updated_at
      FROM traceability_settings
      WHERE tenant_id = $1 AND factory_id = $2
      LIMIT 1
    `, [tenantId, factoryId], { tenantId, userId });
    if (!result.rows[0]) throw new NotFoundException('Traceability settings not found for this factory');
    return result.rows[0];
  }

  async updateSettings(
    userId: string, tenantId: string, factoryId: string,
    dto: UpdateTraceabilitySettingsDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }
    if (dto.retention_years === undefined && dto.allocation_policy === undefined) {
      throw new BadRequestException('At least one traceability setting must be provided');
    }
    if (dto.retention_years !== undefined && (!Number.isInteger(dto.retention_years) || dto.retention_years < 1 || dto.retention_years > 100)) {
      throw new BadRequestException('retention_years must be an integer between 1 and 100');
    }
    const allocationPolicy = dto.allocation_policy?.trim().toUpperCase();
    if (allocationPolicy && !['FIFO', 'FEFO', 'LOT', 'SERIAL'].includes(allocationPolicy)) {
      throw new BadRequestException('allocation_policy must be FIFO, FEFO, LOT or SERIAL');
    }
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();
    try {
      await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          const updated = await client.query<{ retention_years: number; allocation_policy: string; version: number }>(`
            UPDATE traceability_settings
            SET retention_years = COALESCE($1, retention_years),
                allocation_policy = COALESCE($2, allocation_policy),
                updated_by_user_id = $3, version = version + 1, updated_at = clock_timestamp()
            WHERE tenant_id = $4 AND factory_id = $5 AND version = $6
            RETURNING retention_years, allocation_policy, version
          `, [dto.retention_years ?? null, allocationPolicy ?? null, userId, tenantId, factoryId, dto.expected_version]);
          const settings = updated.rows[0];
          if (!settings) throw new ConflictException('Traceability settings version changed; reload and retry');
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1, $2, 'TRACEABILITY_SETTINGS', $3, 'TRACEABILITY.SETTINGS_UPDATED', $4::jsonb)
          `, [tenantId, factoryId, factoryId, JSON.stringify({
            retention_years: settings.retention_years,
            allocation_policy: settings.allocation_policy,
            version: settings.version,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'TRACEABILITY_SETTINGS', resourceId: factoryId,
            action: 'UPDATED', correlationId, requestId: requestUuid,
            payload: { retentionYears: settings.retention_years, allocationPolicy: settings.allocation_policy, version: settings.version },
          });
        },
      );
    } catch (error) {
      throw this.mapDatabaseError(error, 'Traceability settings update failed');
    }
    return this.getSettings(userId, tenantId, factoryId);
  }

  async listUnitStatusHistory(userId: string, tenantId: string, factoryId: string, unitId: string) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(unitId, 'unitId');
    const result = await this.database.query(`
      SELECT id::text AS id, unit_id::text AS unit_id, version, from_status, to_status,
        reason, changed_by_user_id::text AS changed_by_user_id,
        correlation_id::text AS correlation_id, created_at::text AS created_at
      FROM traceability_unit_status_events
      WHERE unit_id = $1 AND tenant_id = $2 AND factory_id = $3
      ORDER BY version DESC, id DESC LIMIT 100
    `, [unitId, tenantId, factoryId], { tenantId, userId });
    return { events: result.rows };
  }

  private async insertAudit(client: PoolClient, input: {
    tenantId: string; factoryId: string; userId: string; resourceType: string; resourceId: string;
    action: string; correlationId: string; requestId: string | null; payload: Record<string, unknown>;
  }) {
    await client.query(`
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type,
        resource_id, correlation_id, request_id, data_class, payload
      ) VALUES ($1, $2, $3, 'TRACEABILITY', $4, $5, $6, $7, $8, 'INTERNAL', $9::jsonb)
    `, [
      input.tenantId, input.factoryId, input.userId, input.action, input.resourceType,
      input.resourceId, input.correlationId, input.requestId, JSON.stringify(input.payload),
    ]);
  }

  private validateScope(userId: string, tenantId: string, factoryId: string) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }
  private validateUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
  }
  private requiredUuid(value: string, field: string) {
    if (!value) throw new BadRequestException(field + ' is required');
    this.validateUuid(value, field);
    return value.toLowerCase();
  }
  private optionalUuid(value: string | undefined, field: string) {
    if (value === undefined || value === null || value === '') return null;
    return this.requiredUuid(value, field);
  }
  private requiredKey(rawKey: string | null) {
    const key = rawKey?.trim() ?? '';
    if (!key || key.length > 255) throw new BadRequestException('Idempotency-Key is required and must contain at most 255 characters');
    return key;
  }
  private requiredText(value: string | undefined, field: string, max: number) {
    const text = value?.trim() ?? '';
    if (!text || text.length > max) throw new BadRequestException(field + ' is required and must contain at most ' + max + ' characters');
    return text;
  }
  private quantity(value: number, field: string) {
    if (!Number.isFinite(value) || value <= 0 || Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001) {
      throw new BadRequestException(field + ' must be positive with at most four decimal places');
    }
    return value.toFixed(4);
  }
  private objectValue(value?: Record<string, unknown>) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('JSON metadata must be an object');
    }
    return value;
  }
  private uuidOrNull(value: string | null | undefined) {
    return value && isUUID(value) ? value : null;
  }
  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private allowedFilter(field: string, value: string) {
    const allowed: Record<string, string[]> = {
      unit_type: ['LOT', 'SERIAL', 'PALLET', 'CARTON', 'BUNDLE', 'FINISHED_GOOD', 'SHIPMENT'],
      product_role: ['MATERIAL', 'FINISHED_GOOD', 'PACKAGING', 'SHIPMENT', 'OTHER'],
      status: ['ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED'],
      relationship_type: ['CONSUMED_INTO', 'PROCESSED_INTO', 'SPLIT_INTO', 'MERGED_INTO', 'PACKED_INTO', 'SHIPPED_AS', 'REWORKED_INTO'],
    };
    return allowed[field]?.includes(value) ?? false;
  }
  private mapDatabaseError(error: unknown, duplicateMessage: string) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    if (code === '23505') return new ConflictException(duplicateMessage);
    if (code === '23503') return new BadRequestException('Traceability references must exist in the same tenant/factory and source aggregate');
    if (code === '23514') return new ConflictException(error instanceof Error ? error.message : duplicateMessage);
    if (code === '55000') return new ConflictException(error instanceof Error ? error.message : duplicateMessage);
    return error;
  }
}
