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
  DispatchTraceabilityShipmentDto,
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
    if (dto.unit_type === 'SHIPMENT') {
      for (const field of ['customer_reference', 'customer_order_reference', 'shipment_reference'] as const) {
        const value = attributes[field];
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
          throw new BadRequestException(
            'SHIPMENT attributes must include non-empty customer_reference, customer_order_reference and shipment_reference values of at most 255 characters',
          );
        }
        attributes[field] = value.trim();
      }
    }
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


  async dispatchShipment(
    userId: string, tenantId: string, factoryId: string, shipmentUnitId: string,
    dto: DispatchTraceabilityShipmentDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const shipmentId = this.requiredUuid(shipmentUnitId, 'shipmentUnitId');
    const sourceLocationId = this.requiredUuid(dto.source_location_id, 'source_location_id');
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const notes = dto.notes?.trim() || null;
    if (notes && notes.length > 1000) throw new BadRequestException('notes must contain at most 1000 characters');

    const requestUuid = this.uuidOrNull(requestId);
    const traceUuid = this.uuidOrNull(traceId);
    const correlationId = traceUuid ?? requestUuid ?? randomUUID();
    const requestHash = this.hash({
      shipment_unit_id: shipmentId,
      source_location_id: sourceLocationId,
      notes,
    });

    const parseUnits = (value: string): bigint => {
      const [wholeText, fractionText = ''] = String(value).split('.');
      const whole = BigInt(wholeText);
      const fraction = BigInt((fractionText + '0000').slice(0, 4));
      return whole * 10000n + (whole < 0n ? -fraction : fraction);
    };
    const formatUnits = (value: bigint): string => {
      const negative = value < 0n;
      const absolute = negative ? -value : value;
      return (negative ? '-' : '') + (absolute / 10000n).toString()
        + '.' + (absolute % 10000n).toString().padStart(4, '0');
    };

    let dispatchId: string;
    let replayed: boolean;
    try {
      const result = await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: traceUuid },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':shipment-dispatch-idempotency:' + idempotencyKey],
          );
          const existingByKey = await client.query<{ id: string; request_hash: string }>(`
            SELECT id::text AS id, request_hash
            FROM traceability_shipment_dispatches
            WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existingByKey.rows[0]) {
            if (existingByKey.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different shipment dispatch');
            }
            return { id: existingByKey.rows[0].id, replayed: true };
          }

          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':shipment-dispatch-unit:' + shipmentId],
          );
          const priorDispatch = await client.query<{ id: string }>(`
            SELECT id::text AS id
            FROM traceability_shipment_dispatches
            WHERE tenant_id=$1 AND factory_id=$2 AND shipment_unit_id=$3
            FOR UPDATE
          `, [tenantId, factoryId, shipmentId]);
          if (priorDispatch.rows[0]) {
            throw new ConflictException('Shipment has already been dispatched');
          }

          const shipmentResult = await client.query<{
            id: string; unit_type: string; product_role: string; status: string;
            version: string; attributes: Record<string, unknown>;
          }>(`
            SELECT id::text AS id, unit_type, product_role, status, version::text AS version, attributes
            FROM traceability_units
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
            FOR UPDATE
          `, [shipmentId, tenantId, factoryId]);
          const shipment = shipmentResult.rows[0];
          if (!shipment) throw new NotFoundException('Shipment identity not found in this factory');
          if (shipment.unit_type !== 'SHIPMENT' || shipment.product_role !== 'SHIPMENT' || shipment.status !== 'ACTIVE') {
            throw new ConflictException('Only an active SHIPMENT identity can be dispatched');
          }
          for (const field of ['customer_reference', 'customer_order_reference', 'shipment_reference'] as const) {
            const value = shipment.attributes?.[field];
            if (typeof value !== 'string' || !value.trim()) {
              throw new ConflictException('Shipment identity is missing required customer/order references');
            }
          }

          const locationResult = await client.query<{
            id: string; location_type: string; status: string; picking_enabled: boolean;
          }>(`
            SELECT id::text AS id, location_type, status, picking_enabled
            FROM inventory_locations
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
            FOR UPDATE
          `, [sourceLocationId, tenantId, factoryId]);
          const sourceLocation = locationResult.rows[0];
          if (!sourceLocation || sourceLocation.location_type !== 'STAGING'
            || sourceLocation.status !== 'ACTIVE' || sourceLocation.picking_enabled !== true) {
            throw new BadRequestException('Shipment dispatch must issue from an active pick-enabled STAGING location');
          }

          const contentsResult = await client.query<{
            traceability_unit_id: string; item_id: string; item_unit: string; traceability_unit: string;
            quantity: string; unit_status: string; expires_at: string | null; expired: boolean;
            attributes: Record<string, unknown>; item_status: string;
          }>(`
            WITH RECURSIVE package_nodes(unit_id) AS (
              SELECT p.id
              FROM product_genealogy_events shipped
              JOIN traceability_units p
                ON p.id=shipped.source_unit_id AND p.tenant_id=shipped.tenant_id AND p.factory_id=shipped.factory_id
              WHERE shipped.tenant_id=$1 AND shipped.factory_id=$2
                AND shipped.target_unit_id=$3 AND shipped.relationship_type='SHIPPED_AS'
                AND p.product_role='PACKAGING' AND p.unit_type IN ('CARTON','PALLET')
              UNION
              SELECT child.id
              FROM product_genealogy_events packed
              JOIN package_nodes parent ON parent.unit_id=packed.target_unit_id
              JOIN traceability_units child
                ON child.id=packed.source_unit_id AND child.tenant_id=packed.tenant_id AND child.factory_id=packed.factory_id
              WHERE packed.tenant_id=$1 AND packed.factory_id=$2
                AND packed.relationship_type='PACKED_INTO'
                AND child.product_role='PACKAGING' AND child.unit_type IN ('CARTON','PALLET')
            )
            SELECT
              u.id::text AS traceability_unit_id,
              u.inventory_item_id::text AS item_id,
              i.unit AS item_unit,
              u.unit AS traceability_unit,
              SUM(e.quantity)::text AS quantity,
              u.status AS unit_status,
              u.expires_at::text AS expires_at,
              (u.expires_at IS NOT NULL AND u.expires_at < CURRENT_DATE) AS expired,
              u.attributes,
              i.status AS item_status
            FROM product_genealogy_events e
            JOIN package_nodes p ON p.unit_id=e.target_unit_id
            JOIN traceability_units u
              ON u.id=e.source_unit_id AND u.tenant_id=e.tenant_id AND u.factory_id=e.factory_id
            JOIN inventory_items i
              ON i.id=u.inventory_item_id AND i.tenant_id=u.tenant_id AND i.factory_id=u.factory_id
            WHERE e.tenant_id=$1 AND e.factory_id=$2
              AND e.relationship_type='PACKED_INTO'
              AND u.product_role='FINISHED_GOOD'
              AND u.unit_type IN ('LOT','SERIAL','FINISHED_GOOD')
            GROUP BY u.id, u.inventory_item_id, i.unit, u.unit, u.status, u.expires_at, u.attributes, i.status
            ORDER BY u.inventory_item_id, u.id
          `, [tenantId, factoryId, shipmentId]);
          const contents = contentsResult.rows;
          if (contents.length === 0) {
            throw new ConflictException('Shipment has no finished-good lot/serial quantity in its package genealogy');
          }

          const itemTotals = new Map<string, { unit: string; units: bigint }>();
          for (const row of contents) {
            if (row.item_status !== 'ACTIVE') throw new ConflictException('Disabled inventory items cannot be dispatched');
            if (row.unit_status !== 'ACTIVE' || row.expired) {
              throw new ConflictException('Shipment contains a non-active or expired finished-good identity');
            }
            const attributes = row.attributes ?? {};
            const condition = String(attributes.condition ?? '').toUpperCase();
            if (attributes.damaged === true || attributes.held === true || attributes.quarantined === true
              || ['DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED'].includes(condition)) {
              throw new ConflictException('Shipment contains damaged, held or quarantined finished-good stock');
            }
            if (row.item_unit !== row.traceability_unit) {
              throw new ConflictException('Finished-good traceability unit must use its inventory item base unit before dispatch');
            }
            const total = itemTotals.get(row.item_id);
            const units = parseUnits(row.quantity);
            itemTotals.set(row.item_id, {
              unit: row.item_unit,
              units: (total?.units ?? 0n) + units,
            });
          }

          const itemIds = [...itemTotals.keys()].sort();
          const aggregateResult = await client.query<{
            item_id: string; quantity_on_hand: string; quantity_reserved: string;
          }>(`
            SELECT item_id::text AS item_id, quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
            FROM inventory_stock_balances
            WHERE tenant_id=$1 AND factory_id=$2 AND item_id=ANY($3::uuid[])
            ORDER BY item_id FOR UPDATE
          `, [tenantId, factoryId, itemIds]);
          const aggregateByItem = new Map(aggregateResult.rows.map(row => [row.item_id, row]));
          if (aggregateByItem.size !== itemIds.length) {
            throw new ConflictException('Inventory aggregate balance is unavailable for one or more shipment items');
          }
          const locationBalanceResult = await client.query<{
            item_id: string; quantity_on_hand: string; quantity_reserved: string;
          }>(`
            SELECT item_id::text AS item_id, quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
            FROM inventory_location_balances
            WHERE tenant_id=$1 AND factory_id=$2 AND location_id=$3 AND item_id=ANY($4::uuid[])
            ORDER BY item_id FOR UPDATE
          `, [tenantId, factoryId, sourceLocationId, itemIds]);
          const locationByItem = new Map(locationBalanceResult.rows.map(row => [row.item_id, row]));
          if (locationByItem.size !== itemIds.length) {
            throw new ConflictException('Outbound staging does not have item/location stock balances for all shipment contents');
          }

          for (const row of contents) {
            const traceBalanceResult = await client.query<{
              quantity_on_hand: string; quantity_reserved: string;
            }>(`
              SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved
              FROM inventory_traceability_location_balances
              WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
                AND traceability_unit_id=$4 AND location_id=$5
              FOR UPDATE
            `, [tenantId, factoryId, row.item_id, row.traceability_unit_id, sourceLocationId]);
            const tracked = traceBalanceResult.rows[0];
            if (!tracked) throw new ConflictException('Packed finished-good lot/serial is not present in outbound STAGING');
            if (parseUnits(tracked.quantity_on_hand) - parseUnits(tracked.quantity_reserved) < parseUnits(row.quantity)) {
              throw new ConflictException('Outbound STAGING has insufficient unreserved stock for a packed finished-good lot/serial');
            }

            const holdResult = await client.query<{ present: boolean }>(`
              SELECT EXISTS (
                SELECT 1 FROM quality_holds qh
                WHERE qh.tenant_id=$1 AND qh.factory_id=$2 AND qh.status='ACTIVE'
                  AND (qh.inventory_item_id=$3 OR qh.traceability_unit_id=$4)
              ) AS present
            `, [tenantId, factoryId, row.item_id, row.traceability_unit_id]);
            if (holdResult.rows[0]?.present) {
              throw new ConflictException('Quality-held finished-good stock cannot be dispatched');
            }
          }

          for (const itemId of itemIds) {
            const aggregate = aggregateByItem.get(itemId)!;
            const local = locationByItem.get(itemId)!;
            const total = itemTotals.get(itemId)!;
            const quantity = formatUnits(total.units);
            if (parseUnits(aggregate.quantity_on_hand) - parseUnits(aggregate.quantity_reserved) < total.units) {
              throw new ConflictException('Shipment quantity exceeds unreserved aggregate stock');
            }
            if (parseUnits(local.quantity_on_hand) - parseUnits(local.quantity_reserved) < total.units) {
              throw new ConflictException('Shipment quantity exceeds unreserved stock in outbound STAGING');
            }
          }

          const dispatchInsert = await client.query<{ id: string }>(`
            INSERT INTO traceability_shipment_dispatches (
              tenant_id, factory_id, shipment_unit_id, source_location_id,
              status, idempotency_key, request_hash, notes, created_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,'DISPATCHED',$5,$6,$7,$8,$9::uuid)
            RETURNING id::text AS id
          `, [
            tenantId, factoryId, shipmentId, sourceLocationId,
            idempotencyKey, requestHash, notes, userId, correlationId,
          ]);
          dispatchId = dispatchInsert.rows[0]?.id ?? '';
          if (!dispatchId) throw new Error('TRACEABILITY_SHIPMENT_DISPATCH_INSERT_FAILED');

          await client.query('SELECT set_config(\'app.inventory_location_id\', $1, TRUE)', [sourceLocationId]);
          const movementByItem = new Map<string, { id: string; quantity: string; quantity_after: string }>();
          for (const itemId of itemIds) {
            const total = itemTotals.get(itemId)!;
            const quantity = formatUnits(total.units);
            const balanceUpdated = await client.query<{ quantity_after: string }>(`
              UPDATE inventory_stock_balances
              SET quantity_on_hand = quantity_on_hand - $1::numeric,
                  version = version + 1, updated_at = clock_timestamp()
              WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4
                AND quantity_on_hand - quantity_reserved >= $1::numeric
              RETURNING quantity_on_hand::text AS quantity_after
            `, [quantity, tenantId, factoryId, itemId]);
            const balance = balanceUpdated.rows[0];
            if (!balance) throw new ConflictException('Insufficient available inventory; shipment dispatch was rolled back');

            const movementHash = this.hash({
              dispatch_id: dispatchId, item_id: itemId, quantity, unit: total.unit,
              source_location_id: sourceLocationId,
            });
            const movementInsert = await client.query<{ id: string }>(`
              INSERT INTO inventory_movements (
                tenant_id, factory_id, item_id, location_id, movement_type, quantity,
                quantity_delta, quantity_after, input_quantity, input_unit_code,
                conversion_rule_id, conversion_factor_numerator, conversion_factor_denominator,
                conversion_rounding_mode, idempotency_key, request_hash,
                reference_type, reference_id, notes, created_by_user_id, correlation_id
              ) VALUES (
                $1,$2,$3,$4,'ISSUE',$5::numeric,(-$5::numeric),$6::numeric,$5::numeric,$7,
                NULL,NULL,NULL,NULL,$8,$9,'SHIPMENT_DISPATCH',$10::uuid,$11,$12,$13::uuid
              )
              RETURNING id::text AS id
            `, [
              tenantId, factoryId, itemId, sourceLocationId, quantity, balance.quantity_after,
              total.unit, 'shipment-dispatch:' + dispatchId + ':' + itemId, movementHash,
              dispatchId, notes ?? ('Customer shipment dispatch ' + shipment.attributes.shipment_reference),
              userId, correlationId,
            ]);
            const movementId = movementInsert.rows[0]?.id;
            if (!movementId) throw new Error('SHIPMENT_INVENTORY_MOVEMENT_INSERT_FAILED');
            movementByItem.set(itemId, { id: movementId, quantity, quantity_after: balance.quantity_after });

            await client.query(`
              INSERT INTO outbox_events (
                tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
              ) VALUES ($1,$2,'INVENTORY_ITEM',$3,'INVENTORY.STOCK_ISSUED',$4::jsonb)
            `, [tenantId, factoryId, itemId, JSON.stringify({
              movement_id: movementId, item_id: itemId, location_id: sourceLocationId,
              movement_type: 'ISSUE', quantity, quantity_delta: '-' + quantity,
              quantity_after: balance.quantity_after, reference_type: 'SHIPMENT_DISPATCH', reference_id: dispatchId,
            })]);
          }

          for (const row of contents) {
            const movement = movementByItem.get(row.item_id);
            if (!movement) throw new Error('SHIPMENT_DISPATCH_ITEM_MOVEMENT_MISSING');
            const traceUpdate = await client.query<{ id: string }>(`
              UPDATE inventory_traceability_location_balances
              SET quantity_on_hand = quantity_on_hand - $1::numeric,
                  version = version + 1, updated_at = clock_timestamp()
              WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4
                AND traceability_unit_id=$5 AND location_id=$6
                AND quantity_on_hand - quantity_reserved >= $1::numeric
              RETURNING id::text AS id
            `, [row.quantity, tenantId, factoryId, row.item_id, row.traceability_unit_id, sourceLocationId]);
            if (!traceUpdate.rows[0]) {
              throw new ConflictException('Packed finished-good quantity changed during dispatch; all stock issues were rolled back');
            }
            await client.query(`
              INSERT INTO traceability_shipment_dispatch_lines (
                tenant_id, factory_id, dispatch_id, item_id, traceability_unit_id,
                source_location_id, quantity, unit, inventory_movement_id
              ) VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9)
            `, [
              tenantId, factoryId, dispatchId, row.item_id, row.traceability_unit_id,
              sourceLocationId, row.quantity, row.item_unit, movement.id,
            ]);
          }

          const nextVersion = Number(shipment.version) + 1;
          const updatedShipment = await client.query<{ id: string }>(`
            UPDATE traceability_units
            SET status='SHIPPED', version=version+1, updated_at=clock_timestamp()
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE'
            RETURNING id::text AS id
          `, [shipmentId, tenantId, factoryId]);
          if (!updatedShipment.rows[0]) throw new ConflictException('Shipment status changed concurrently; dispatch was rolled back');

          const statusReason = 'Shipment dispatched under inventory dispatch ' + dispatchId;
          const statusKey = 'shipment-dispatch-status:' + dispatchId;
          const statusHash = this.hash({
            shipment_unit_id: shipmentId, from_status: 'ACTIVE', to_status: 'SHIPPED',
            dispatch_id: dispatchId, version: nextVersion,
          });
          await client.query(`
            INSERT INTO traceability_unit_status_events (
              tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
              idempotency_key, request_hash, changed_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,'ACTIVE','SHIPPED',$5,$6,$7,$8,$9::uuid)
          `, [tenantId, factoryId, shipmentId, nextVersion, statusReason, statusKey, statusHash, userId, correlationId]);

          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1,$2,'TRACEABILITY_UNIT',$3,'TRACEABILITY.UNIT_STATUS_CHANGED',$4::jsonb)
          `, [tenantId, factoryId, shipmentId, JSON.stringify({
            unit_id: shipmentId, from_status: 'ACTIVE', to_status: 'SHIPPED',
            reason: statusReason, version: nextVersion, dispatch_id: dispatchId,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'TRACEABILITY_UNIT', resourceId: shipmentId,
            action: 'STATUS_CHANGED', correlationId, requestId: requestUuid,
            payload: { fromStatus: 'ACTIVE', toStatus: 'SHIPPED', reason: statusReason, version: nextVersion, dispatchId },
          });
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1,$2,'TRACEABILITY_SHIPMENT_DISPATCH',$3,'TRACEABILITY.SHIPMENT_DISPATCHED',$4::jsonb)
          `, [tenantId, factoryId, dispatchId, JSON.stringify({
            dispatch_id: dispatchId, shipment_unit_id: shipmentId,
            source_location_id: sourceLocationId,
            customer_reference: shipment.attributes.customer_reference,
            customer_order_reference: shipment.attributes.customer_order_reference,
            shipment_reference: shipment.attributes.shipment_reference,
            lines: contents.map(row => ({
              traceability_unit_id: row.traceability_unit_id, item_id: row.item_id, quantity: row.quantity, unit: row.item_unit,
            })),
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'TRACEABILITY_SHIPMENT_DISPATCH', resourceId: dispatchId,
            action: 'DISPATCHED', correlationId, requestId: requestUuid,
            payload: {
              shipmentUnitId: shipmentId, sourceLocationId,
              customerReference: shipment.attributes.customer_reference,
              customerOrderReference: shipment.attributes.customer_order_reference,
              shipmentReference: shipment.attributes.shipment_reference,
              itemCount: itemIds.length, lineCount: contents.length,
            },
          });
          return { id: dispatchId, replayed: false };
        },
      );
      dispatchId = result.id;
      replayed = result.replayed;
    } catch (error) {
      throw this.mapDatabaseError(error, 'Shipment dispatch conflicts with existing dispatch, stock, genealogy or idempotency evidence');
    }

    const dispatched = await this.database.query(`
      SELECT d.id::text AS id, d.shipment_unit_id::text AS shipment_unit_id,
        s.unit_code AS shipment_unit_code, d.source_location_id::text AS source_location_id,
        d.status, d.idempotency_key, d.request_hash, d.notes,
        d.created_by_user_id::text AS created_by_user_id,
        d.correlation_id::text AS correlation_id,
        d.dispatched_at::text AS dispatched_at, d.created_at::text AS created_at,
        COALESCE(
          jsonb_agg(jsonb_build_object(
            'id', l.id::text, 'item_id', l.item_id::text, 'sku', i.sku,
            'traceability_unit_id', l.traceability_unit_id::text, 'unit_code', u.unit_code,
            'source_location_id', l.source_location_id::text,
            'quantity', l.quantity::text, 'unit', l.unit, 'inventory_movement_id', l.inventory_movement_id::text
          ) ORDER BY l.item_id, l.traceability_unit_id) FILTER (WHERE l.id IS NOT NULL),
          '[]'::jsonb
        ) AS lines
      FROM traceability_shipment_dispatches d
      JOIN traceability_units s ON s.id=d.shipment_unit_id AND s.tenant_id=d.tenant_id AND s.factory_id=d.factory_id
      LEFT JOIN traceability_shipment_dispatch_lines l
        ON l.dispatch_id=d.id AND l.tenant_id=d.tenant_id AND l.factory_id=d.factory_id
      LEFT JOIN inventory_items i
        ON i.id=l.item_id AND i.tenant_id=l.tenant_id AND i.factory_id=l.factory_id
      LEFT JOIN traceability_units u
        ON u.id=l.traceability_unit_id AND u.tenant_id=l.tenant_id AND u.factory_id=l.factory_id
      WHERE d.id=$1 AND d.tenant_id=$2 AND d.factory_id=$3
      GROUP BY d.id, s.unit_code
    `, [dispatchId, tenantId, factoryId], { tenantId, userId });
    const dispatch = dispatched.rows[0];
    if (!dispatch) throw new NotFoundException('Shipment dispatch record not found');
    return { ...dispatch, replayed };
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
