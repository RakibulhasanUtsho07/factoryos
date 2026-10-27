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
  DeclareTraceabilityRecallDto,
  CreateRecallNotificationIntentDto,
  RecordRecallNotificationAcknowledgementDto,
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
    const boundaryIds = units
      .filter(row => Number((row as QueryResultRow & { depth?: number }).depth) === depth)
      .map(row => String((row as unknown as QueryResultRow & { id: string }).id));
    let depthTruncated = false;
    if (boundaryIds.length > 0) {
      const outwardEdge = direction === 'FORWARD'
        ? 'e.source_unit_id = ANY($1::uuid[]) AND NOT (e.target_unit_id = ANY($1::uuid[]))'
        : 'e.target_unit_id = ANY($1::uuid[]) AND NOT (e.source_unit_id = ANY($1::uuid[]))';
      const boundaryResult = await this.database.query<{ truncated: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM product_genealogy_events e
          WHERE ${outwardEdge} AND e.tenant_id = $2 AND e.factory_id = $3
        ) AS truncated
      `, [boundaryIds, tenantId, factoryId], context);
      depthTruncated = boundaryResult.rows[0]?.truncated === true;
    }
    const nodeLimitReached = units.length >= limit;
    const settings = await this.getSettings(userId, tenantId, factoryId);
    return {
      root: root.rows[0],
      direction,
      max_depth: depth,
      limit,
      retention_years: settings.retention_years,
      truncated: nodeLimitReached || depthTruncated,
      node_limit_reached: nodeLimitReached,
      depth_truncated: depthTruncated,
      units,
      relationships: edgesResult.rows,
    };
  }

  /**
   * Builds a bounded, read-only recall impact assessment from the unit's genealogy.
   * It reports downstream identities and customer shipments without changing stock,
   * marking identities recalled, or creating a recall decision.
   */
  async recallImpact(
    userId: string, tenantId: string, factoryId: string, unitId: string,
    rawDepth?: number, rawLimit?: number,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const downstream = await this.trace(userId, tenantId, factoryId, unitId, 'FORWARD', rawDepth, rawLimit);
    const upstream = await this.trace(userId, tenantId, factoryId, unitId, 'REVERSE', rawDepth, rawLimit);
    const rootId = String(downstream.root.id).toLowerCase();
    // trace() deliberately returns database projection rows with a depth annotation;
    // make the known projection fields explicit here for safe TypeScript narrowing.
    const downstreamUnits = downstream.units as unknown as Array<
      QueryResultRow & { id: string; unit_type?: string; product_role?: string; depth: number }
    >;
    const impactedUnits = downstreamUnits.filter((unit) => String(unit.id).toLowerCase() !== rootId);
    const shipmentIds = impactedUnits
      .filter((unit) => String(unit.unit_type ?? '').toUpperCase() === 'SHIPMENT'
        || String(unit.product_role ?? '').toUpperCase() === 'SHIPMENT')
      .map((unit) => String(unit.id));

    const shipmentResult = await this.database.query<{
      shipment_unit_id: string;
      shipment_code: string;
      container_unit_id: string;
      customer_name: string;
      customer_order_reference: string;
      order_id: string | null;
      order_line_id: string | null;
      carrier_name: string | null;
      tracking_reference: string | null;
      quantity: string;
      unit: string;
      dispatched_at: string;
      latest_delivery_event_type: string | null;
      latest_delivery_event_at: string | null;
      pod_reference: string | null;
      pod_sha256: string | null;
    }>(`
      SELECT s.shipment_unit_id::text AS shipment_unit_id,
        s.shipment_code, s.container_unit_id::text AS container_unit_id,
        s.customer_name, s.customer_order_reference,
        s.order_id::text AS order_id, s.order_line_id::text AS order_line_id,
        s.carrier_name, s.tracking_reference,
        s.quantity::text AS quantity, s.unit,
        s.dispatched_at::text AS dispatched_at,
        latest.event_type AS latest_delivery_event_type,
        latest.event_at::text AS latest_delivery_event_at,
        latest.proof_reference AS pod_reference,
        latest.proof_sha256 AS pod_sha256
      FROM wms_shipments s
      LEFT JOIN LATERAL (
        SELECT e.event_type, e.event_at, e.proof_reference, e.proof_sha256
        FROM wms_shipment_delivery_events e
        WHERE e.tenant_id=s.tenant_id AND e.factory_id=s.factory_id
          AND e.shipment_unit_id=s.shipment_unit_id
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
      ) latest ON true
      WHERE s.tenant_id=$1 AND s.factory_id=$2
        AND s.shipment_unit_id=ANY($3::uuid[])
      ORDER BY s.dispatched_at DESC, s.shipment_code, s.shipment_unit_id
    `, [tenantId, factoryId, shipmentIds], { tenantId, userId });

    return {
      requested_unit: downstream.root,
      direction: 'FORWARD',
      max_depth: downstream.max_depth,
      node_limit: downstream.limit,
      impact_truncated: downstream.truncated,
      impact_node_limit_reached: downstream.node_limit_reached,
      impact_depth_truncated: downstream.depth_truncated,
      provenance_truncated: upstream.truncated,
      provenance_node_limit_reached: upstream.node_limit_reached,
      provenance_depth_truncated: upstream.depth_truncated,
      impacted_unit_count: impactedUnits.length,
      impacted_units: impactedUnits,
      downstream_relationships: downstream.relationships,
      upstream_provenance: (upstream.units as unknown as Array<QueryResultRow & { id: string }>)
        .filter((unit) => String(unit.id).toLowerCase() !== rootId),
      upstream_relationships: upstream.relationships,
      affected_shipment_count: shipmentResult.rows.length,
      affected_shipments: shipmentResult.rows,
      side_effects: {
        stock_changed: false,
        statuses_changed: false,
        records_created: false,
      },
    };
  }

  /**
   * Records a durable notification dispatch intent; it is not proof that an
   * email, portal message, or EDI payload was sent or delivered.
   */
  async createRecallNotificationIntent(
    userId: string, tenantId: string, factoryId: string, recallCaseId: string,
    dto: CreateRecallNotificationIntentDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(recallCaseId, 'recallCaseId');
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const recipientType = String(dto.recipient_type ?? '').trim().toUpperCase();
    if (!['CUSTOMER', 'SITE'].includes(recipientType)) {
      throw new BadRequestException('recipient_type must be CUSTOMER or SITE');
    }
    const recipientReference = this.requiredText(dto.recipient_reference, 'recipient_reference', 255);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(recipientReference) || /^https?:/i.test(recipientReference)) {
      throw new BadRequestException('recipient_reference must be a non-URL customer/site reference, not contact data');
    }
    const channel = String(dto.channel ?? '').trim().toUpperCase();
    if (!['EMAIL', 'PORTAL', 'EDI', 'MANUAL'].includes(channel)) {
      throw new BadRequestException('channel must be EMAIL, PORTAL, EDI or MANUAL');
    }
    const reason = dto.reason === undefined ? null : this.requiredText(dto.reason, 'reason', 1800);
    const requestHash = this.hash({
      recall_case_id: recallCaseId.toLowerCase(), recipient_type: recipientType,
      recipient_reference: recipientReference, channel, reason,
    });
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':wms-recall-notification:' + idempotencyKey],
          );
          const existing = await client.query<StoredKeyRow>(`
            SELECT id::text AS id, request_hash
            FROM wms_traceability_recall_notification_intents
            WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different recall notification request');
            }
            const replay = await client.query<QueryResultRow>(`
              SELECT id::text AS id, recall_case_id::text AS recall_case_id,
                recipient_type, recipient_reference, channel, reason,
                requested_by_user_id::text AS requested_by_user_id,
                correlation_id::text AS correlation_id, created_at::text AS created_at
              FROM wms_traceability_recall_notification_intents
              WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
            `, [existing.rows[0].id, tenantId, factoryId]);
            if (!replay.rows[0]) throw new Error('WMS_RECALL_NOTIFICATION_REPLAY_ROW_MISSING');
            return { ...replay.rows[0], dispatch_status: 'INTENT_RECORDED_NOT_DELIVERY_CONFIRMED', replayed: true };
          }

          const recallCase = await client.query(`
            SELECT id FROM wms_traceability_recall_cases
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
            FOR UPDATE
          `, [recallCaseId.toLowerCase(), tenantId, factoryId]);
          if (!recallCase.rows[0]) throw new NotFoundException('Recall case not found in this factory');

          const inserted = await client.query<QueryResultRow>(`
            INSERT INTO wms_traceability_recall_notification_intents (
              tenant_id, factory_id, recall_case_id, recipient_type,
              recipient_reference, channel, reason, idempotency_key, request_hash,
              requested_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING id::text AS id, recall_case_id::text AS recall_case_id,
              recipient_type, recipient_reference, channel, reason,
              requested_by_user_id::text AS requested_by_user_id,
              correlation_id::text AS correlation_id, created_at::text AS created_at
          `, [
            tenantId, factoryId, recallCaseId.toLowerCase(), recipientType, recipientReference,
            channel, reason, idempotencyKey, requestHash, userId, correlationId,
          ]);
          const intent = inserted.rows[0];
          if (!intent) throw new Error('WMS_RECALL_NOTIFICATION_INTENT_INSERT_FAILED');

          await client.query(`
            INSERT INTO audit_events (
              tenant_id,factory_id,actor_user_id,event_type,action,resource_type,
              resource_id,correlation_id,request_id,data_class,payload
            ) VALUES ($1,$2,$3,'WMS_FULFILLMENT','NOTIFICATION_INTENT_RECORDED',
              'WMS_RECALL_NOTIFICATION_INTENT',$4,$5,$6,'INTERNAL',$7::jsonb)
          `, [tenantId, factoryId, userId, intent.id, correlationId, requestUuid, JSON.stringify({
            recall_case_id: recallCaseId.toLowerCase(), recipient_type: recipientType,
            recipient_reference: recipientReference, channel,
            dispatch_status: 'INTENT_RECORDED_NOT_DELIVERY_CONFIRMED',
          })]);
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload
            ) VALUES ($1,$2,'WMS_RECALL_NOTIFICATION_INTENT',$3,'WMS.RECALL_NOTIFICATION_REQUESTED',$4::jsonb)
          `, [tenantId, factoryId, intent.id, JSON.stringify({
            notification_intent_id: intent.id, recall_case_id: recallCaseId.toLowerCase(),
            recipient_type: recipientType, recipient_reference: recipientReference, channel,
          })]);
          return { ...intent, dispatch_status: 'INTENT_RECORDED_NOT_DELIVERY_CONFIRMED', replayed: false };
        },
      );
    } catch (error) {
      throw this.mapDatabaseError(error, 'Recall notification request conflicts with existing scope or idempotency evidence');
    }
  }

  async listRecallNotificationIntents(
    userId: string, tenantId: string, factoryId: string, recallCaseId: string,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(recallCaseId, 'recallCaseId');
    return this.database.transaction(
      { tenantId, userId },
      async (client) => {
        const recallCase = await client.query(`
          SELECT id FROM wms_traceability_recall_cases
          WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
        `, [recallCaseId.toLowerCase(), tenantId, factoryId]);
        if (!recallCase.rows[0]) throw new NotFoundException('Recall case not found in this factory');
        const result = await client.query<QueryResultRow>(`
          SELECT n.id::text AS id, n.recall_case_id::text AS recall_case_id,
            n.recipient_type, n.recipient_reference, n.channel, n.reason,
            n.requested_by_user_id::text AS requested_by_user_id,
            n.correlation_id::text AS correlation_id, n.created_at::text AS created_at,
            a.id::text AS acknowledgement_id, a.outcome AS acknowledgement_outcome,
            a.notes AS acknowledgement_notes, a.evidence_reference AS acknowledgement_evidence_reference,
            a.recorded_by_user_id::text AS acknowledgement_recorded_by_user_id,
            a.acknowledgement_source, a.created_at::text AS acknowledgement_created_at
          FROM wms_traceability_recall_notification_intents n
          LEFT JOIN wms_traceability_recall_notification_acknowledgements a
            ON a.notification_intent_id=n.id AND a.tenant_id=n.tenant_id AND a.factory_id=n.factory_id
          WHERE n.recall_case_id=$1 AND n.tenant_id=$2 AND n.factory_id=$3
          ORDER BY n.created_at, n.id
          LIMIT 500
        `, [recallCaseId.toLowerCase(), tenantId, factoryId]);
        return {
          recall_case_id: recallCaseId.toLowerCase(),
          items: result.rows.map((row) => ({
            ...row,
            dispatch_status: 'INTENT_RECORDED_NOT_DELIVERY_CONFIRMED',
            acknowledgement_externally_authenticated: false,
          })),
          limit: 500,
        };
      },
    );
  }

  async recordRecallNotificationAcknowledgement(
    userId: string, tenantId: string, factoryId: string, recallCaseId: string,
    notificationIntentId: string, dto: RecordRecallNotificationAcknowledgementDto,
    rawIdempotencyKey: string | null, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(recallCaseId, 'recallCaseId');
    this.validateUuid(notificationIntentId, 'notificationIntentId');
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const outcome = String(dto.outcome ?? '').trim().toUpperCase();
    if (!['RECEIVED', 'NO_ACTION_REQUIRED', 'ACTION_IN_PROGRESS', 'ACTION_COMPLETED', 'UNABLE_TO_CONFIRM'].includes(outcome)) {
      throw new BadRequestException('Unsupported recall acknowledgement outcome');
    }
    const notes = dto.notes === undefined ? null : this.requiredText(dto.notes, 'notes', 1800);
    const evidenceReference = dto.evidence_reference === undefined
      ? null
      : this.requiredText(dto.evidence_reference, 'evidence_reference', 500);
    if (evidenceReference && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/.test(evidenceReference) || /^https?:\/\//i.test(evidenceReference))) {
      throw new BadRequestException('evidence_reference must be a reference token, not a URL');
    }
    const requestHash = this.hash({
      recall_case_id: recallCaseId.toLowerCase(), notification_intent_id: notificationIntentId.toLowerCase(),
      outcome, notes, evidence_reference: evidenceReference,
    });
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':wms-recall-ack:' + idempotencyKey],
          );
          const existing = await client.query<StoredKeyRow>(`
            SELECT id::text AS id, request_hash
            FROM wms_traceability_recall_notification_acknowledgements
            WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different recall acknowledgement');
            }
            const replay = await client.query<QueryResultRow>(`
              SELECT id::text AS id, recall_case_id::text AS recall_case_id,
                notification_intent_id::text AS notification_intent_id, recipient_type,
                recipient_reference, outcome, notes, evidence_reference, acknowledgement_source,
                recorded_by_user_id::text AS recorded_by_user_id,
                correlation_id::text AS correlation_id, created_at::text AS created_at
              FROM wms_traceability_recall_notification_acknowledgements
              WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
            `, [existing.rows[0].id, tenantId, factoryId]);
            if (!replay.rows[0]) throw new Error('WMS_RECALL_ACK_REPLAY_ROW_MISSING');
            return { ...replay.rows[0], externally_authenticated: false, replayed: true };
          }

          const intent = await client.query<QueryResultRow>(`
            SELECT id::text AS id
            FROM wms_traceability_recall_notification_intents
            WHERE id=$1 AND recall_case_id=$2 AND tenant_id=$3 AND factory_id=$4
            FOR UPDATE
          `, [notificationIntentId.toLowerCase(), recallCaseId.toLowerCase(), tenantId, factoryId]);
          if (!intent.rows[0]) throw new NotFoundException('Recall notification intent not found in this factory');
          const priorAcknowledgement = await client.query(`
            SELECT id FROM wms_traceability_recall_notification_acknowledgements
            WHERE notification_intent_id=$1 AND tenant_id=$2 AND factory_id=$3
            FOR UPDATE
          `, [notificationIntentId.toLowerCase(), tenantId, factoryId]);
          if (priorAcknowledgement.rows[0]) {
            throw new ConflictException('This notification intent already has an acknowledgement; use its original idempotency key to replay');
          }

          const inserted = await client.query<QueryResultRow>(`
            INSERT INTO wms_traceability_recall_notification_acknowledgements (
              tenant_id, factory_id, recall_case_id, notification_intent_id,
              recipient_type, recipient_reference, outcome, notes, evidence_reference,
              idempotency_key, request_hash, recorded_by_user_id, correlation_id,
              acknowledgement_source
            )
            SELECT n.tenant_id, n.factory_id, n.recall_case_id, n.id,
              n.recipient_type, n.recipient_reference, $5, $6, $7,
              $8, $9, $10, $11, 'OPERATOR_REPORTED'
            FROM wms_traceability_recall_notification_intents n
            WHERE n.id=$1 AND n.recall_case_id=$2 AND n.tenant_id=$3 AND n.factory_id=$4
            RETURNING id::text AS id, recall_case_id::text AS recall_case_id,
              notification_intent_id::text AS notification_intent_id, recipient_type,
              recipient_reference, outcome, notes, evidence_reference, acknowledgement_source,
              recorded_by_user_id::text AS recorded_by_user_id,
              correlation_id::text AS correlation_id, created_at::text AS created_at
          `, [
            notificationIntentId.toLowerCase(), recallCaseId.toLowerCase(), tenantId, factoryId,
            outcome, notes, evidenceReference, idempotencyKey, requestHash, userId, correlationId,
          ]);
          const acknowledgement = inserted.rows[0];
          if (!acknowledgement) throw new NotFoundException('Recall notification intent not found in this factory');

          await client.query(`
            INSERT INTO audit_events (
              tenant_id,factory_id,actor_user_id,event_type,action,resource_type,
              resource_id,correlation_id,request_id,data_class,payload
            ) VALUES ($1,$2,$3,'WMS_FULFILLMENT','ACKNOWLEDGEMENT_RECORDED',
              'WMS_RECALL_NOTIFICATION_ACKNOWLEDGEMENT',$4,$5,$6,'INTERNAL',$7::jsonb)
          `, [tenantId, factoryId, userId, acknowledgement.id, correlationId, requestUuid, JSON.stringify({
            recall_case_id: recallCaseId.toLowerCase(), notification_intent_id: notificationIntentId.toLowerCase(),
            outcome, acknowledgement_source: 'OPERATOR_REPORTED',
            notes_sha256: notes ? this.hash(notes) : null,
            evidence_reference: evidenceReference,
          })]);
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload
            ) VALUES ($1,$2,'WMS_RECALL_NOTIFICATION_ACKNOWLEDGEMENT',$3,'WMS.RECALL_NOTIFICATION_ACKNOWLEDGED',$4::jsonb)
          `, [tenantId, factoryId, acknowledgement.id, JSON.stringify({
            acknowledgement_id: acknowledgement.id, recall_case_id: recallCaseId.toLowerCase(),
            notification_intent_id: notificationIntentId.toLowerCase(), outcome,
            acknowledgement_source: 'OPERATOR_REPORTED',
          })]);
          return { ...acknowledgement, externally_authenticated: false, replayed: false };
        },
      );
    } catch (error) {
      throw this.mapDatabaseError(error, 'Recall acknowledgement conflicts with existing scope, intent or idempotency evidence');
    }
  }

  /**
   * Declares a recall against a complete, bounded downstream genealogy. A partial
   * traversal is rejected before any case or unit status is written.
   */
  async declareRecall(
    userId: string, tenantId: string, factoryId: string, unitId: string,
    dto: DeclareTraceabilityRecallDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(unitId, 'unitId');
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const reason = this.requiredText(dto.reason, 'reason', 1800);
    const depth = dto.depth ?? 5;
    const limit = dto.limit ?? 200;
    if (!Number.isInteger(depth) || depth < 1 || depth > 12) {
      throw new BadRequestException('depth must be an integer between 1 and 12');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new BadRequestException('limit must be an integer between 1 and 500');
    }

    const requestHash = this.hash({
      source_unit_id: unitId.toLowerCase(), reason, depth, limit,
    });
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          // Match the global graph lock used by genealogy inserts. This freezes the
          // edge set while the affected unit set is computed and status-locked.
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':product-genealogy-graph'],
          );
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':wms-recall-case:' + idempotencyKey],
          );

          const existing = await client.query<QueryResultRow & {
            id: string; request_hash: string;
          }>(`
            SELECT id::text AS id, request_hash
            FROM wms_traceability_recall_cases
            WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different recall declaration');
            }
            const priorCase = await client.query<QueryResultRow>(`
              SELECT id::text AS id, source_unit_id::text AS source_unit_id, reason,
                max_depth, node_limit, impacted_unit_count, impact_fingerprint,
                declared_by_user_id::text AS declared_by_user_id,
                correlation_id::text AS correlation_id, created_at::text AS created_at
              FROM wms_traceability_recall_cases
              WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
            `, [existing.rows[0].id, tenantId, factoryId]);
            const priorUnits = await client.query<QueryResultRow>(`
              SELECT unit_id::text AS unit_id, unit_code_snapshot, unit_type_snapshot,
                depth, status_before, unit_action, status_event_id::text AS status_event_id
              FROM wms_traceability_recall_case_units
              WHERE recall_case_id=$1 AND tenant_id=$2 AND factory_id=$3
              ORDER BY depth, unit_id
            `, [existing.rows[0].id, tenantId, factoryId]);
            if (!priorCase.rows[0]) throw new Error('WMS_RECALL_CASE_REPLAY_ROW_MISSING');
            return {
              recall_case: priorCase.rows[0],
              units: priorUnits.rows,
              follow_up_required: priorUnits.rows.filter(
                (row) => row.unit_action === 'SHIPPED_REVIEW_REQUIRED',
              ).length,
              replayed: true,
            };
          }

          const rootResult = await client.query<QueryResultRow & {
            id: string; unit_code: string; unit_type: string; product_role: string;
          }>(`
            SELECT id::text AS id, unit_code, unit_type, product_role
            FROM traceability_units
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
          `, [unitId, tenantId, factoryId]);
          const root = rootResult.rows[0];
          if (!root) throw new NotFoundException('Traceability unit not found in this factory');

          // Breadth-first traversal with a hard cap at every layer. The query may
          // read only limit+1 edges per layer; excessive fan-out fails closed too.
          const nodes = new Map<string, { id: string; depth: number }>([
            [String(root.id).toLowerCase(), { id: String(root.id).toLowerCase(), depth: 0 }],
          ]);
          const graphEdges: Array<{
            id: string; source_unit_id: string; target_unit_id: string;
            relationship_type: string; quantity: string;
          }> = [];
          let frontier = [String(root.id).toLowerCase()];
          for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth += 1) {
            const edgeResult = await client.query<QueryResultRow & {
              id: string; source_unit_id: string; target_unit_id: string;
              relationship_type: string; quantity: string;
            }>(`
              SELECT id::text AS id, source_unit_id::text AS source_unit_id,
                target_unit_id::text AS target_unit_id, relationship_type, quantity::text AS quantity
              FROM product_genealogy_events
              WHERE tenant_id=$1 AND factory_id=$2 AND source_unit_id=ANY($3::uuid[])
              ORDER BY source_unit_id, target_unit_id, id
              LIMIT $4
            `, [tenantId, factoryId, frontier, limit + 1]);
            if (edgeResult.rows.length > limit) {
              throw new ConflictException(
                'Recall declaration refused: genealogy fan-out exceeds the configured node bound; no statuses changed',
              );
            }

            const nextFrontier: string[] = [];
            for (const edge of edgeResult.rows) {
              graphEdges.push({
                id: String(edge.id).toLowerCase(),
                source_unit_id: String(edge.source_unit_id).toLowerCase(),
                target_unit_id: String(edge.target_unit_id).toLowerCase(),
                relationship_type: String(edge.relationship_type),
                quantity: String(edge.quantity),
              });
              const targetId = String(edge.target_unit_id).toLowerCase();
              if (nodes.has(targetId)) continue;
              if (nodes.size >= limit) {
                throw new ConflictException(
                  'Recall declaration refused: downstream genealogy exceeds the configured node bound; no statuses changed',
                );
              }
              nodes.set(targetId, { id: targetId, depth: currentDepth + 1 });
              nextFrontier.push(targetId);
            }
            frontier = nextFrontier;
          }

          if (frontier.length > 0) {
            const beyondBoundary = await client.query<{ truncated: boolean }>(`
              SELECT EXISTS (
                SELECT 1 FROM product_genealogy_events e
                WHERE e.tenant_id=$1 AND e.factory_id=$2
                  AND e.source_unit_id=ANY($3::uuid[])
                  AND NOT (e.target_unit_id=ANY($4::uuid[]))
              ) AS truncated
            `, [tenantId, factoryId, frontier, Array.from(nodes.keys())]);
            if (beyondBoundary.rows[0]?.truncated === true) {
              throw new ConflictException(
                'Recall declaration refused: downstream genealogy is truncated at the requested depth; no statuses changed',
              );
            }
          }

          const orderedNodeIds = Array.from(nodes.keys()).sort();
          const lockedResult = await client.query<QueryResultRow & {
            id: string; unit_code: string; unit_type: string; product_role: string;
            status: string; version: string;
          }>(`
            SELECT id::text AS id, unit_code, unit_type, product_role, status, version::text AS version
            FROM traceability_units
            WHERE tenant_id=$1 AND factory_id=$2 AND id=ANY($3::uuid[])
            ORDER BY id
            FOR UPDATE
          `, [tenantId, factoryId, orderedNodeIds]);
          if (lockedResult.rows.length !== nodes.size) {
            throw new ConflictException('Recall declaration refused because genealogy identities changed during assessment');
          }
          const lockedById = new Map(lockedResult.rows.map((row) => [String(row.id).toLowerCase(), row]));
          const graphFingerprint = this.hash({
            units: Array.from(nodes.values())
              .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
              .map((node) => ({
                unit_id: node.id,
                depth: node.depth,
                unit_code: lockedById.get(node.id)?.unit_code ?? null,
                status: lockedById.get(node.id)?.status ?? null,
              })),
            relationships: graphEdges.sort((a, b) => a.id.localeCompare(b.id)),
          });
          const caseResult = await client.query<QueryResultRow & {
            id: string; source_unit_id: string; reason: string; max_depth: number;
            node_limit: number; impacted_unit_count: number; impact_fingerprint: string;
            declared_by_user_id: string; correlation_id: string; created_at: string;
          }>(`
            INSERT INTO wms_traceability_recall_cases (
              tenant_id, factory_id, source_unit_id, reason, max_depth, node_limit,
              impacted_unit_count, impact_fingerprint, idempotency_key, request_hash,
              declared_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid)
            RETURNING id::text AS id, source_unit_id::text AS source_unit_id, reason,
              max_depth, node_limit, impacted_unit_count, impact_fingerprint,
              declared_by_user_id::text AS declared_by_user_id,
              correlation_id::text AS correlation_id, created_at::text AS created_at
          `, [
            tenantId, factoryId, root.id, reason, depth, limit, nodes.size,
            graphFingerprint, idempotencyKey, requestHash, userId, correlationId,
          ]);
          const recallCase = caseResult.rows[0];
          if (!recallCase) throw new Error('WMS_RECALL_CASE_INSERT_FAILED');

          const caseUnits: Array<Record<string, unknown> & { unit_id: string; unit_action: string }> = [];
          for (const node of Array.from(nodes.values()).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))) {
            const unit = lockedById.get(node.id);
            if (!unit) throw new Error('WMS_RECALL_CASE_UNIT_LOCK_MISSING');
            let unitAction: 'RECALLED' | 'ALREADY_RECALLED' | 'SHIPPED_REVIEW_REQUIRED' | 'ALREADY_DISPOSED';
            let statusEventId: string | null = null;
            const statusBefore = String(unit.status);

            if (unit.status === 'ACTIVE' || unit.status === 'QUARANTINED') {
              const update = await client.query<QueryResultRow & { version: string; status: string }>(`
                UPDATE traceability_units
                SET status='RECALLED', version=version+1, updated_at=clock_timestamp()
                WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status=$4
                RETURNING version::text AS version, status
              `, [unit.id, tenantId, factoryId, unit.status]);
              if (!update.rows[0]) {
                throw new ConflictException('Recall declaration refused because a unit status changed concurrently');
              }
              unitAction = 'RECALLED';
              const statusRequestHash = this.hash({
                recall_case_id: recallCase.id, unit_id: unit.id,
                from_status: statusBefore, to_status: 'RECALLED', reason,
              });
              const statusEvent = await client.query<QueryResultRow & { id: string }>(`
                INSERT INTO traceability_unit_status_events (
                  tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
                  idempotency_key, request_hash, changed_by_user_id, correlation_id
                ) VALUES ($1,$2,$3,$4::bigint,$5,'RECALLED',$6,$7,$8,$9,$10::uuid)
                RETURNING id::text AS id
              `, [
                tenantId, factoryId, unit.id, update.rows[0].version,
                statusBefore, 'Recall case ' + recallCase.id + ': ' + reason,
                'wms-recall-' + recallCase.id.replace(/-/g, '') + '-' + unit.id.replace(/-/g, ''),
                statusRequestHash, userId, correlationId,
              ]);
              statusEventId = statusEvent.rows[0]?.id ?? null;
              if (!statusEventId) throw new Error('WMS_RECALL_STATUS_EVENT_INSERT_FAILED');
              await this.insertAudit(client, {
                tenantId, factoryId, userId, resourceType: 'TRACEABILITY_UNIT', resourceId: unit.id,
                action: 'STATUS_CHANGED', correlationId, requestId: requestUuid,
                payload: {
                  fromStatus: statusBefore, toStatus: 'RECALLED',
                  reason: 'Recall case ' + recallCase.id + ': ' + reason,
                  version: update.rows[0].version, recall_case_id: recallCase.id,
                },
              });
              await client.query(`
                INSERT INTO outbox_events (
                  tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
                ) VALUES ($1,$2,'TRACEABILITY_UNIT',$3,'TRACEABILITY.UNIT_STATUS_CHANGED',$4::jsonb)
              `, [tenantId, factoryId, unit.id, JSON.stringify({
                unit_id: unit.id, from_status: statusBefore, to_status: 'RECALLED',
                reason, version: update.rows[0].version, recall_case_id: recallCase.id,
              })]);
            } else if (unit.status === 'RECALLED') {
              unitAction = 'ALREADY_RECALLED';
            } else if (unit.status === 'SHIPPED') {
              // The domain status machine forbids SHIPPED -> RECALLED. Keep that
              // immutable logistics fact and require a separate customer/site action.
              unitAction = 'SHIPPED_REVIEW_REQUIRED';
            } else if (unit.status === 'DISPOSED') {
              unitAction = 'ALREADY_DISPOSED';
            } else {
              throw new ConflictException('Recall declaration encountered an unsupported traceability status');
            }

            await client.query(`
              INSERT INTO wms_traceability_recall_case_units (
                tenant_id, factory_id, recall_case_id, unit_id, unit_code_snapshot,
                unit_type_snapshot, depth, status_before, unit_action, status_event_id
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid)
            `, [
              tenantId, factoryId, recallCase.id, unit.id, unit.unit_code,
              unit.unit_type, node.depth, statusBefore, unitAction, statusEventId,
            ]);
            caseUnits.push({
              unit_id: unit.id, unit_code_snapshot: unit.unit_code,
              unit_type_snapshot: unit.unit_type, depth: node.depth,
              status_before: statusBefore, unit_action: unitAction, status_event_id: statusEventId,
            });
          }

          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'WMS_RECALL_CASE', resourceId: recallCase.id,
            action: 'DECLARED', correlationId, requestId: requestUuid,
            payload: {
              source_unit_id: root.id, reason, max_depth: depth, node_limit: limit,
              impacted_unit_count: nodes.size, impact_fingerprint: graphFingerprint,
              recalled_count: caseUnits.filter((row) => row.unit_action === 'RECALLED').length,
              already_recalled_count: caseUnits.filter((row) => row.unit_action === 'ALREADY_RECALLED').length,
              shipped_review_required_count: caseUnits.filter((row) => row.unit_action === 'SHIPPED_REVIEW_REQUIRED').length,
              already_disposed_count: caseUnits.filter((row) => row.unit_action === 'ALREADY_DISPOSED').length,
            },
          });
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1,$2,'WMS_RECALL_CASE',$3,'WMS.RECALL_DECLARED',$4::jsonb)
          `, [tenantId, factoryId, recallCase.id, JSON.stringify({
            recall_case_id: recallCase.id, source_unit_id: root.id, reason,
            impacted_unit_count: nodes.size,
            recalled_count: caseUnits.filter((row) => row.unit_action === 'RECALLED').length,
            already_recalled_count: caseUnits.filter((row) => row.unit_action === 'ALREADY_RECALLED').length,
            shipped_review_required_count: caseUnits.filter((row) => row.unit_action === 'SHIPPED_REVIEW_REQUIRED').length,
            already_disposed_count: caseUnits.filter((row) => row.unit_action === 'ALREADY_DISPOSED').length,
            customer_notification_sent: false,
            stock_changed: false,
          })]);

          return {
            recall_case: recallCase,
            units: caseUnits,
            follow_up_required: caseUnits.filter((row) => row.unit_action === 'SHIPPED_REVIEW_REQUIRED').length,
            replayed: false,
          };
        },
      );
    } catch (error) {
      throw this.mapDatabaseError(error, 'Recall declaration conflicts with existing identity, status or idempotency evidence');
    }
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
    if (!['QR', 'CODE128', 'DATAMATRIX', 'GS1_128', 'GS1_DATAMATRIX'].includes(symbology)) {
      throw new BadRequestException('symbology must be QR, CODE128, DATAMATRIX, GS1_128 or GS1_DATAMATRIX');
    }
    if (!Array.isArray(dto.supported_unit_types) || dto.supported_unit_types.length === 0) {
      throw new BadRequestException('supported_unit_types must contain at least one traceability unit type');
    }
    const supportedUnitTypes = [...new Set(dto.supported_unit_types.map(x => String(x).toUpperCase()))];
    if (supportedUnitTypes.some(x => !['MATERIAL', 'LOT', 'SERIAL', 'PALLET', 'CARTON', 'BUNDLE', 'FINISHED_GOOD', 'SHIPMENT'].includes(x))) {
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

  async issueLabel(
    userId: string, tenantId: string, factoryId: string,
    dto: IssueTraceabilityLabelDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const rawUnitId = dto.unit_id?.trim() || null;
    const rawItemId = dto.item_id?.trim() || null;
    if ((rawUnitId === null) === (rawItemId === null)) {
      throw new BadRequestException('Exactly one of unit_id or item_id must be provided for a label issue');
    }
    const unitId = rawUnitId ? this.requiredUuid(rawUnitId, 'unit_id') : null;
    const itemId = rawItemId ? this.requiredUuid(rawItemId, 'item_id') : null;
    const templateId = this.requiredUuid(dto.template_id, 'template_id');
    const copyCount = dto.copy_count ?? 1;
    if (!Number.isInteger(copyCount) || copyCount < 1 || copyCount > 100) {
      throw new BadRequestException('copy_count must be an integer between 1 and 100');
    }
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const requestHash = this.hash({
      unit_id: unitId,
      item_id: itemId,
      template_id: templateId,
      copy_count: copyCount,
    });
    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();

    try {
      const result = await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':traceability-label-issue:' + idempotencyKey],
          );
          const existing = await client.query<{
            id: string; request_hash: string;
          } & QueryResultRow>(`
            SELECT id::text AS id, request_hash
            FROM traceability_label_issues
            WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different label issue request');
            }
            const prior = await this.getLabelIssueRow(client, tenantId, factoryId, existing.rows[0].id);
            return { issue: prior, replayed: true };
          }

          let unitCode: string;
          let barcodeValue: string;
          let identityPayload: Record<string, unknown>;
          let supportedTemplateType: string;
          if (unitId) {
            const unitResult = await client.query<{
              id: string; unit_code: string; barcode_value: string; rfid_epc: string | null;
              unit_type: string; product_role: string; inventory_item_id: string | null;
              quantity: string; unit: string; expires_at: string | null; status: string;
              attributes: Record<string, unknown>;
            }>(`
              SELECT id::text AS id, unit_code, barcode_value, rfid_epc, unit_type, product_role,
                inventory_item_id::text AS inventory_item_id, quantity::text AS quantity, unit,
                expires_at::text AS expires_at, status, attributes
              FROM traceability_units
              WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
              FOR SHARE
            `, [unitId, tenantId, factoryId]);
            const unit = unitResult.rows[0];
            if (!unit) throw new NotFoundException('Traceability identity not found in this factory');
            unitCode = unit.unit_code;
            barcodeValue = unit.barcode_value;
            supportedTemplateType = unit.unit_type;
            identityPayload = {
              schema: 'factoryos.traceability-label/v1',
              identity_type: 'TRACEABILITY_UNIT',
              unit_id: unit.id,
              unit_code: unit.unit_code,
              barcode_value: unit.barcode_value,
              rfid_epc: unit.rfid_epc,
              unit_type: unit.unit_type,
              product_role: unit.product_role,
              inventory_item_id: unit.inventory_item_id,
              quantity: unit.quantity,
              unit: unit.unit,
              expires_at: unit.expires_at,
              status: unit.status,
            };
          } else {
            const itemResult = await client.query<{
              id: string; sku: string; name: string; unit: string;
              sector_code: string | null; status: string;
            }>(`
              SELECT id::text AS id, sku, name, unit, sector_code, status
              FROM inventory_items
              WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
              FOR SHARE
            `, [itemId, tenantId, factoryId]);
            const item = itemResult.rows[0];
            if (!item) throw new NotFoundException('Inventory material not found in this factory');
            if (item.status !== 'ACTIVE') throw new ConflictException('Disabled inventory materials cannot receive new labels');
            unitCode = item.sku;
            barcodeValue = item.sku;
            supportedTemplateType = 'MATERIAL';
            identityPayload = {
              schema: 'factoryos.item-label/v1',
              identity_type: 'MATERIAL',
              inventory_item_id: item.id,
              sku: item.sku,
              name: item.name,
              unit: item.unit,
              sector_code: item.sector_code,
              status: item.status,
            };
          }

          const templateResult = await client.query<{
            id: string; template_code: string; symbology: string; supported_unit_types: string[];
            label_layout: Record<string, unknown>; is_active: boolean;
          }>(`
            SELECT id::text AS id, template_code, symbology, supported_unit_types, label_layout, is_active
            FROM traceability_label_templates
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR SHARE
          `, [templateId, tenantId, factoryId]);
          const template = templateResult.rows[0];
          if (!template || !template.is_active) {
            throw new NotFoundException('Active label template not found in this factory');
          }
          if (!template.supported_unit_types.includes(supportedTemplateType)) {
            throw new BadRequestException('Selected label template does not support this identity type');
          }

          const inserted = await client.query<QueryResultRow & {
            id: string; tenant_id: string; factory_id: string; unit_id: string | null;
            inventory_item_id: string | null; template_id: string; template_code: string;
            unit_code: string; barcode_value: string; symbology: string;
            encoded_payload: Record<string, unknown>; label_layout: Record<string, unknown>;
            copy_count: number; created_by_user_id: string; correlation_id: string; created_at: string;
          }>(`
            INSERT INTO traceability_label_issues (
              tenant_id, factory_id, unit_id, inventory_item_id, template_id, template_code_snapshot,
              unit_code_snapshot, barcode_value_snapshot, symbology, encoded_payload,
              label_layout_snapshot, copy_count, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES (
              $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb,
              $11::jsonb, $12, $13, $14, $15, $16::uuid
            )
            RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
              unit_id::text AS unit_id, inventory_item_id::text AS inventory_item_id,
              template_id::text AS template_id, template_code_snapshot AS template_code,
              unit_code_snapshot AS unit_code, barcode_value_snapshot AS barcode_value,
              symbology, encoded_payload, label_layout_snapshot AS label_layout, copy_count,
              created_by_user_id::text AS created_by_user_id,
              correlation_id::text AS correlation_id, created_at::text AS created_at
          `, [
            tenantId, factoryId, unitId, itemId, templateId, template.template_code,
            unitCode, barcodeValue, template.symbology, JSON.stringify(identityPayload),
            JSON.stringify(template.label_layout), copyCount, idempotencyKey,
            requestHash, userId, correlationId,
          ]);
          const issue = inserted.rows[0];
          if (!issue) throw new Error('TRACEABILITY_LABEL_ISSUE_INSERT_FAILED');

          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1, $2, 'TRACEABILITY_LABEL_ISSUE', $3, 'TRACEABILITY.LABEL_ISSUED', $4::jsonb)
          `, [tenantId, factoryId, issue.id, JSON.stringify({
            label_issue_id: issue.id, unit_id: unitId, inventory_item_id: itemId,
            template_id: templateId, symbology: template.symbology, copy_count: copyCount,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'TRACEABILITY_LABEL_ISSUE', resourceId: issue.id,
            action: 'ISSUED', correlationId, requestId: requestUuid,
            payload: {
              unit_id: unitId, inventory_item_id: itemId,
              template_id: templateId, copy_count: copyCount, symbology: template.symbology,
            },
          });
          return { issue, replayed: false };
        },
      );
      return this.presentLabelIssue(result.issue as Record<string, unknown>, result.replayed);
    } catch (error) {
      throw this.mapDatabaseError(error, 'Label issue conflicts with an existing request or invalid identity/template');
    }
  }

  async resolveLabel(userId: string, tenantId: string, factoryId: string, rawCode: string) {
    this.validateScope(userId, tenantId, factoryId);
    const code = this.requiredText(rawCode, 'code', 255).toUpperCase();
    const [units, items] = await Promise.all([
      this.database.query(`
        SELECT ${UNIT_SELECT}
        WHERE u.tenant_id = $1 AND u.factory_id = $2
          AND (upper(u.barcode_value) = $3 OR upper(u.unit_code) = $3 OR upper(COALESCE(u.rfid_epc, '')) = $3)
        ORDER BY u.created_at DESC, u.id
        LIMIT 2
      `, [tenantId, factoryId, code], { tenantId, userId }),
      this.database.query(`
        SELECT id::text AS id, sku, name, unit, sector_code, status,
          tenant_id::text AS tenant_id, factory_id::text AS factory_id
        FROM inventory_items
        WHERE tenant_id = $1 AND factory_id = $2 AND upper(sku) = $3
        LIMIT 2
      `, [tenantId, factoryId, code], { tenantId, userId }),
    ]);
    if (units.rows.length + items.rows.length > 1) {
      throw new ConflictException('Label code is ambiguous in this factory; use a unique canonical code');
    }
    if (units.rows[0]) return { identity_type: 'TRACEABILITY_UNIT', identity: units.rows[0] };
    if (items.rows[0]) return { identity_type: 'MATERIAL', identity: items.rows[0] };
    throw new NotFoundException('Label, material or RFID identity not found in this factory');
  }

  async listLabelIssuesForUnit(userId: string, tenantId: string, factoryId: string, unitId: string) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(unitId, 'unitId');
    const result = await this.database.query(`
      SELECT id::text AS id, unit_id::text AS unit_id, inventory_item_id::text AS inventory_item_id,
        template_id::text AS template_id, template_code_snapshot AS template_code,
        unit_code_snapshot AS unit_code, barcode_value_snapshot AS barcode_value, symbology,
        encoded_payload, label_layout_snapshot AS label_layout, copy_count,
        created_by_user_id::text AS created_by_user_id,
        correlation_id::text AS correlation_id, created_at::text AS created_at
      FROM traceability_label_issues
      WHERE tenant_id = $1 AND factory_id = $2 AND unit_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `, [tenantId, factoryId, unitId], { tenantId, userId });
    return { issues: result.rows };
  }

  async listLabelIssuesForItem(userId: string, tenantId: string, factoryId: string, itemId: string) {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const result = await this.database.query(`
      SELECT id::text AS id, unit_id::text AS unit_id, inventory_item_id::text AS inventory_item_id,
        template_id::text AS template_id, template_code_snapshot AS template_code,
        unit_code_snapshot AS unit_code, barcode_value_snapshot AS barcode_value, symbology,
        encoded_payload, label_layout_snapshot AS label_layout, copy_count,
        created_by_user_id::text AS created_by_user_id,
        correlation_id::text AS correlation_id, created_at::text AS created_at
      FROM traceability_label_issues
      WHERE tenant_id = $1 AND factory_id = $2 AND inventory_item_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `, [tenantId, factoryId, itemId], { tenantId, userId });
    return { issues: result.rows };
  }

  private async getLabelIssueRow(client: PoolClient, tenantId: string, factoryId: string, issueId: string) {
    const result = await client.query<QueryResultRow & Record<string, unknown>>( `
      SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
        unit_id::text AS unit_id, inventory_item_id::text AS inventory_item_id,
        template_id::text AS template_id, template_code_snapshot AS template_code, unit_code_snapshot AS unit_code,
        barcode_value_snapshot AS barcode_value, symbology, encoded_payload,
        label_layout_snapshot AS label_layout, copy_count,
        created_by_user_id::text AS created_by_user_id,
        correlation_id::text AS correlation_id, created_at::text AS created_at
      FROM traceability_label_issues
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
      LIMIT 1
    `, [issueId, tenantId, factoryId]);
    if (!result.rows[0]) throw new Error('TRACEABILITY_LABEL_ISSUE_REPLAY_ROW_MISSING');
    return result.rows[0];
  }

  private presentLabelIssue(issue: Record<string, unknown>, replayed: boolean) {
    return {
      ...issue,
      replayed,
      print_contract: {
        symbology: issue.symbology,
        encoded_value: issue.barcode_value,
        copies: issue.copy_count,
        layout: issue.label_layout,
        identity_payload: issue.encoded_payload,
      },
    };
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
