import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import {
  AddWmsPackingContentDto, CreateWmsPackingContainerDto, DispatchWmsShipmentDto,
  RecordWmsShipmentDeliveryEventDto,
} from './dto/wms-packing-shipment.dto';

export interface WmsContainerRow {
  container_unit_id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  location_id: string;
  container_type: 'CARTON' | 'PALLET';
  unit: string;
  capacity_quantity: string;
  packed_quantity: string;
  status: 'OPEN' | 'SEALED' | 'DISPATCHED';
  unit_code: string;
  idempotency_key: string;
  request_hash: string;
  seal_idempotency_key: string | null;
  seal_request_hash?: string | null;
  sealed_at: string | null;
  dispatched_at: string | null;
}

interface TraceUnitRow {
  id: string;
  unit_type: string;
  product_role: string;
  unit_code: string;
  inventory_item_id: string | null;
  quantity: string;
  unit: string;
  status: string;
  expires_at: string | null;
  attributes: Record<string, unknown>;
}

interface WmsLeafRow extends TraceUnitRow {
  quantity_to_ship: string;
}

@Injectable()
export class WmsFulfillmentService {
  constructor(private readonly database: DatabaseService) {}

  async createContainer(
    userId: string, tenantId: string, factoryId: string,
    dto: CreateWmsPackingContainerDto, rawKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const key = this.requiredKey(rawKey);
    const containerType = dto.container_type;
    const containerCode = this.requiredText(dto.container_code, 'container_code', 160).toUpperCase();
    const itemId = this.uuid(dto.item_id, 'item_id');
    const locationId = this.uuid(dto.location_id, 'location_id');
    const capacity = this.quantity(dto.capacity_quantity, 'capacity_quantity');
    const requestHash = this.hash({
      container_type: containerType, container_code: containerCode, item_id: itemId,
      location_id: locationId, capacity_quantity: capacity,
    });
    const correlationId = this.correlation(requestId, traceId);

    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: this.uuidOrNull(requestId), traceId: this.uuidOrNull(traceId) },
        async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':wms-create-container:' + key],
          );
          const existing = await client.query<WmsContainerRow>(`
            SELECT c.container_unit_id::text AS container_unit_id, c.tenant_id::text AS tenant_id,
              c.factory_id::text AS factory_id, c.item_id::text AS item_id, c.location_id::text AS location_id,
              c.container_type, c.unit, c.capacity_quantity::text AS capacity_quantity,
              c.packed_quantity::text AS packed_quantity, c.status, u.unit_code, c.idempotency_key,
              c.request_hash, c.seal_idempotency_key, c.seal_request_hash, c.sealed_at::text AS sealed_at,
              c.dispatched_at::text AS dispatched_at
            FROM wms_packing_containers c JOIN traceability_units u
              ON u.id=c.container_unit_id AND u.tenant_id=c.tenant_id AND u.factory_id=c.factory_id
            WHERE c.tenant_id=$1 AND c.factory_id=$2 AND c.idempotency_key=$3
            FOR UPDATE OF c
          `, [tenantId, factoryId, key]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for another packing container request');
            }
            return { container: existing.rows[0], replayed: true };
          }

          const itemResult = await client.query<{ unit: string; status: string }>(`
            SELECT unit, status FROM inventory_items
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE
          `, [itemId, tenantId, factoryId]);
          const item = itemResult.rows[0];
          if (!item) throw new NotFoundException('Inventory item not found in this factory');
          if (item.status !== 'ACTIVE') throw new ConflictException('Disabled items cannot be packed for dispatch');

          const locationResult = await client.query<{ location_type: string; status: string; picking_enabled: boolean }>(`
            SELECT location_type, status, picking_enabled FROM inventory_locations
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE
          `, [locationId, tenantId, factoryId]);
          const location = locationResult.rows[0];
          if (!location || location.status !== 'ACTIVE') throw new NotFoundException('Active packing location not found in this factory');
          if (!['BIN', 'STAGING'].includes(location.location_type) || !location.picking_enabled) {
            throw new ConflictException('Packing must occur at an active pick-enabled BIN or STAGING location');
          }

          const unitKey = 'wms-container-' + this.hash(key);
          const identity = await client.query<{ id: string }>(`
            INSERT INTO traceability_units (
              tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
              quantity, unit, external_reference, attributes, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES (
              $1,$2,$3,'PACKAGING',$4,$4,$5::numeric,$6,'WMS_PACKING_CONTAINER',$7::jsonb,
              $8,$9,$10,$11
            ) RETURNING id::text AS id
          `, [
            tenantId, factoryId, containerType, containerCode, capacity, item.unit,
            JSON.stringify({ wms_container: true, item_id: itemId, location_id: locationId, capacity_quantity: capacity }),
            unitKey, requestHash, userId, correlationId,
          ]);
          const containerUnitId = identity.rows[0]?.id;
          if (!containerUnitId) throw new Error('WMS_CONTAINER_TRACEABILITY_IDENTITY_INSERT_FAILED');

          await this.insertAudit(client, tenantId, factoryId, userId, 'TRACEABILITY_UNIT', containerUnitId,
            'REGISTERED', correlationId, requestId, { unit_type: containerType, product_role: 'PACKAGING', unit_code: containerCode });
          await this.insertOutbox(client, tenantId, factoryId, 'TRACEABILITY_UNIT', containerUnitId,
            'TRACEABILITY.UNIT_REGISTERED', { unit_id: containerUnitId, unit_type: containerType, product_role: 'PACKAGING', unit_code: containerCode });

          await client.query(`
            INSERT INTO wms_packing_containers (
              container_unit_id, tenant_id, factory_id, item_id, location_id, container_type, unit,
              capacity_quantity, packed_quantity, status, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,0,'OPEN',$9,$10,$11,$12)
          `, [containerUnitId, tenantId, factoryId, itemId, locationId, containerType, item.unit,
            capacity, key, requestHash, userId, correlationId]);

          await this.insertAudit(client, tenantId, factoryId, userId, 'WMS_PACKING_CONTAINER', containerUnitId,
            'CREATED', correlationId, requestId, { container_type: containerType, item_id: itemId, location_id: locationId, capacity_quantity: capacity });
          await this.insertOutbox(client, tenantId, factoryId, 'WMS_PACKING_CONTAINER', containerUnitId,
            'WMS.PACKING_CONTAINER_CREATED', { container_unit_id: containerUnitId, container_type: containerType, item_id: itemId, location_id: locationId, capacity_quantity: capacity });

          return {
            container: {
              container_unit_id: containerUnitId, unit_code: containerCode, item_id: itemId,
              location_id: locationId, container_type: containerType, unit: item.unit,
              capacity_quantity: capacity, packed_quantity: '0.0000', status: 'OPEN',
            },
            replayed: false,
          };
        },
      );
    } catch (error) {
      throw this.mapError(error, 'Packing container conflicts with an existing identity or idempotency key');
    }
  }

  async addContent(
    userId: string, tenantId: string, factoryId: string, containerUnitId: string,
    dto: AddWmsPackingContentDto, rawKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const containerId = this.uuid(containerUnitId, 'containerUnitId');
    const sourceUnitId = this.uuid(dto.source_unit_id, 'source_unit_id');
    const key = this.requiredKey(rawKey);
    const quantity = this.quantity(dto.quantity, 'quantity');
    const requestHash = this.hash({ container_unit_id: containerId, source_unit_id: sourceUnitId, quantity });
    const correlationId = this.correlation(requestId, traceId);

    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: this.uuidOrNull(requestId), traceId: this.uuidOrNull(traceId) },
        async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':wms-pack-content:' + key]);
          const replay = await client.query<{ id: string; genealogy_event_id: string; quantity: string; container_unit_id: string; request_hash: string }>(`
            SELECT id::text AS id, genealogy_event_id::text AS genealogy_event_id,
              quantity::text AS quantity, container_unit_id::text AS container_unit_id, request_hash
            FROM wms_packing_contents
            WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE
          `, [tenantId, factoryId, key]);
          if (replay.rows[0]) {
            if (replay.rows[0].request_hash.trim() !== requestHash || replay.rows[0].container_unit_id !== containerId
              || replay.rows[0].quantity !== quantity || replay.rows[0].genealogy_event_id.length === 0) {
              throw new ConflictException('Idempotency-Key was already used for different packing content');
            }
            return { ...replay.rows[0], replayed: true };
          }

          const containerResult = await client.query<WmsContainerRow>(`
            SELECT c.container_unit_id::text AS container_unit_id, c.tenant_id::text AS tenant_id,
              c.factory_id::text AS factory_id, c.item_id::text AS item_id, c.location_id::text AS location_id,
              c.container_type, c.unit, c.capacity_quantity::text AS capacity_quantity,
              c.packed_quantity::text AS packed_quantity, c.status, u.unit_code, c.idempotency_key,
              c.request_hash, c.seal_idempotency_key, c.sealed_at::text AS sealed_at,
              c.dispatched_at::text AS dispatched_at
            FROM wms_packing_containers c JOIN traceability_units u
              ON u.id=c.container_unit_id AND u.tenant_id=c.tenant_id AND u.factory_id=c.factory_id
            WHERE c.container_unit_id=$1 AND c.tenant_id=$2 AND c.factory_id=$3 FOR UPDATE OF c
          `, [containerId, tenantId, factoryId]);
          const container = containerResult.rows[0];
          if (!container) throw new NotFoundException('Packing container not found in this factory');
          if (container.status !== 'OPEN') throw new ConflictException('Only open packing containers accept contents');
          if (Number(container.packed_quantity) + Number(quantity) > Number(container.capacity_quantity)) {
            throw new ConflictException('Packing would exceed the declared container capacity');
          }

          const sourceResult = await client.query<TraceUnitRow>(`
            SELECT id::text AS id, unit_type, product_role, unit_code, inventory_item_id::text AS inventory_item_id,
              quantity::text AS quantity, unit, status, expires_at::text AS expires_at, attributes
            FROM traceability_units
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE
          `, [sourceUnitId, tenantId, factoryId]);
          const source = sourceResult.rows[0];
          if (!source) throw new NotFoundException('Packing source identity not found in this factory');
          if (source.status !== 'ACTIVE' || source.unit !== container.unit) {
            throw new ConflictException('Packing source must be active and use the target item UOM');
          }
          let sourceContainerId: string | null = null;
          if (container.container_type === 'CARTON') {
            if (source.product_role !== 'FINISHED_GOOD' || source.unit_type !== 'LOT'
              || source.inventory_item_id !== container.item_id) {
              throw new ConflictException('Cartons can contain only finished-good lots for the same item');
            }
            if (source.expires_at && source.expires_at < new Date().toISOString().slice(0, 10)) {
              throw new ConflictException('Expired finished-good lots cannot be packed');
            }
            const attributes = source.attributes ?? {};
            const condition = String(attributes.condition ?? '').toUpperCase();
            if (attributes.damaged === true || attributes.held === true || attributes.quarantined === true
              || ['DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED'].includes(condition)) {
              throw new ConflictException('Damaged, held or quarantined finished-good lots cannot be packed');
            }
            const hold = await client.query<{ present: boolean }>(`
              SELECT EXISTS (SELECT 1 FROM quality_holds qh WHERE qh.tenant_id=$1 AND qh.factory_id=$2
                AND qh.status='ACTIVE' AND (qh.inventory_item_id=$3 OR qh.traceability_unit_id=$4)) AS present
            `, [tenantId, factoryId, container.item_id, sourceUnitId]);
            if (hold.rows[0]?.present) throw new ConflictException('Quality-held inventory cannot be packed');
            const balance = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(`
              SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved
              FROM inventory_traceability_location_balances
              WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4 AND location_id=$5
              FOR UPDATE
            `, [tenantId, factoryId, container.item_id, sourceUnitId, container.location_id]);
            const tracked = balance.rows[0];
            if (!tracked || Number(tracked.quantity_on_hand) - Number(tracked.quantity_reserved) < Number(quantity)) {
              throw new ConflictException('Packing quantity exceeds unreserved finished-good lot stock at this location');
            }
          } else {
            if (source.product_role !== 'PACKAGING' || source.unit_type !== 'CARTON') {
              throw new ConflictException('Pallets can contain only sealed cartons');
            }
            const childResult = await client.query<{
              item_id: string; location_id: string; container_type: string; status: string; packed_quantity: string;
            }>(`
              SELECT item_id::text AS item_id, location_id::text AS location_id, container_type, status,
                packed_quantity::text AS packed_quantity
              FROM wms_packing_containers
              WHERE container_unit_id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE
            `, [sourceUnitId, tenantId, factoryId]);
            const child = childResult.rows[0];
            if (!child || child.container_type !== 'CARTON' || child.status !== 'SEALED'
              || child.item_id !== container.item_id || child.location_id !== container.location_id
              || child.packed_quantity !== quantity) {
              throw new ConflictException('Pallets require whole sealed same-item cartons at the same location');
            }
            sourceContainerId = sourceUnitId;
          }

          const edgeKey = 'wms-packed-edge-' + this.hash(key);
          const edgeResult = await client.query<{ id: string }>(`
            INSERT INTO product_genealogy_events (
              tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
              quantity, unit, evidence, notes, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,'PACKED_INTO',$5::numeric,$6,$7::jsonb,$8,$9,$10,$11,$12)
            RETURNING id::text AS id
          `, [tenantId, factoryId, sourceUnitId, containerId, quantity, container.unit,
            JSON.stringify({ wms_container_unit_id: containerId, location_id: container.location_id, item_id: container.item_id }),
            'WMS carton/pallet packing', edgeKey, requestHash, userId, correlationId]);
          const genealogyId = edgeResult.rows[0]?.id;
          if (!genealogyId) throw new Error('WMS_PACKING_GENEALOGY_INSERT_FAILED');

          await this.insertAudit(client, tenantId, factoryId, userId, 'PRODUCT_GENEALOGY_EVENT', genealogyId,
            'RECORDED', correlationId, requestId, { source_unit_id: sourceUnitId, target_unit_id: containerId, relationship_type: 'PACKED_INTO', quantity });
          await this.insertOutbox(client, tenantId, factoryId, 'PRODUCT_GENEALOGY_EVENT', genealogyId,
            'TRACEABILITY.GENEALOGY_RECORDED', { genealogy_event_id: genealogyId, source_unit_id: sourceUnitId, target_unit_id: containerId, relationship_type: 'PACKED_INTO', quantity });

          const content = await client.query<{ id: string }>(`
            INSERT INTO wms_packing_contents (
              tenant_id, factory_id, item_id, container_unit_id, source_unit_id, source_container_unit_id,
              location_id, quantity, unit, genealogy_event_id, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13,$14)
            RETURNING id::text AS id
          `, [tenantId, factoryId, container.item_id, containerId, sourceUnitId, sourceContainerId,
            container.location_id, quantity, container.unit, genealogyId, key, requestHash, userId, correlationId]);
          await client.query(`
            UPDATE wms_packing_containers
            SET packed_quantity=packed_quantity + $1::numeric, updated_at=clock_timestamp()
            WHERE container_unit_id=$2 AND tenant_id=$3 AND factory_id=$4 AND status='OPEN'
          `, [quantity, containerId, tenantId, factoryId]);

          await this.insertAudit(client, tenantId, factoryId, userId, 'WMS_PACKING_CONTENT', content.rows[0].id,
            'PACKED', correlationId, requestId, { container_unit_id: containerId, source_unit_id: sourceUnitId, quantity });
          await this.insertOutbox(client, tenantId, factoryId, 'WMS_PACKING_CONTAINER', containerId,
            'WMS.PACKING_CONTENT_ADDED', { container_unit_id: containerId, content_id: content.rows[0].id, source_unit_id: sourceUnitId, quantity });
          return { id: content.rows[0].id, genealogy_event_id: genealogyId, container_unit_id: containerId, source_unit_id: sourceUnitId, quantity, replayed: false };
        },
      );
    } catch (error) {
      throw this.mapError(error, 'Packing content conflicts with an existing source/container relationship or idempotency key');
    }
  }

  async sealContainer(
    userId: string, tenantId: string, factoryId: string, containerUnitId: string,
    rawKey: string | null, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const containerId = this.uuid(containerUnitId, 'containerUnitId');
    const key = this.requiredKey(rawKey);
    const requestHash = this.hash({ container_unit_id: containerId, action: 'SEAL' });
    const correlationId = this.correlation(requestId, traceId);
    return this.database.transaction(
      { tenantId, userId, requestId: this.uuidOrNull(requestId), traceId: this.uuidOrNull(traceId) },
      async (client) => {
        const result = await client.query<WmsContainerRow>(`
          SELECT c.container_unit_id::text AS container_unit_id, c.tenant_id::text AS tenant_id,
            c.factory_id::text AS factory_id, c.item_id::text AS item_id, c.location_id::text AS location_id,
            c.container_type, c.unit, c.capacity_quantity::text AS capacity_quantity,
            c.packed_quantity::text AS packed_quantity, c.status, u.unit_code, c.idempotency_key,
            c.request_hash, c.seal_idempotency_key, c.seal_request_hash, c.sealed_at::text AS sealed_at,
            c.dispatched_at::text AS dispatched_at
          FROM wms_packing_containers c JOIN traceability_units u
            ON u.id=c.container_unit_id AND u.tenant_id=c.tenant_id AND u.factory_id=c.factory_id
          WHERE c.container_unit_id=$1 AND c.tenant_id=$2 AND c.factory_id=$3 FOR UPDATE OF c
        `, [containerId, tenantId, factoryId]);
        const container = result.rows[0];
        if (!container) throw new NotFoundException('Packing container not found in this factory');
        if (container.status === 'SEALED' && container.seal_idempotency_key === key) {
          if (container.seal_request_hash?.trim() !== requestHash) throw new ConflictException('Seal idempotency key is bound to a different request');
          return { container, replayed: true };
        }
        if (container.status !== 'OPEN') throw new ConflictException('Only an open container may be sealed');
        if (Number(container.packed_quantity) <= 0) throw new ConflictException('Empty containers cannot be sealed');
        await client.query(`
          UPDATE wms_packing_containers
          SET status='SEALED', seal_idempotency_key=$1, seal_request_hash=$2,
              sealed_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE container_unit_id=$3 AND tenant_id=$4 AND factory_id=$5 AND status='OPEN'
        `, [key, requestHash, containerId, tenantId, factoryId]);
        await this.insertAudit(client, tenantId, factoryId, userId, 'WMS_PACKING_CONTAINER', containerId,
          'SEALED', correlationId, requestId, { container_type: container.container_type, packed_quantity: container.packed_quantity });
        await this.insertOutbox(client, tenantId, factoryId, 'WMS_PACKING_CONTAINER', containerId,
          'WMS.PACKING_CONTAINER_SEALED', { container_unit_id: containerId, packed_quantity: container.packed_quantity });
        return { container: { ...container, status: 'SEALED', seal_idempotency_key: key }, replayed: false };
      },
    );
  }

  async dispatchContainer(
    userId: string, tenantId: string, factoryId: string, containerUnitId: string,
    dto: DispatchWmsShipmentDto, rawKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const containerId = this.uuid(containerUnitId, 'containerUnitId');
    const key = this.requiredKey(rawKey);
    const shipmentCode = this.requiredText(dto.shipment_code, 'shipment_code', 160).toUpperCase();
    const customerName = this.requiredText(dto.customer_name, 'customer_name', 255);
    const customerOrderReference = this.requiredText(dto.customer_order_reference, 'customer_order_reference', 160);
    const carrierName = dto.carrier_name?.trim() || null;
    const trackingReference = dto.tracking_reference?.trim() || null;
    if ((carrierName === null) !== (trackingReference === null)) {
      throw new BadRequestException('carrier_name and tracking_reference must be supplied together');
    }
    for (const [field, value] of [['carrier_name', carrierName], ['tracking_reference', trackingReference]] as const) {
      if (value !== null && (value.length > 255 || !/^[\x20-\x7e]+$/.test(value))) {
        throw new BadRequestException(field + ' must contain 1–255 visible ASCII characters');
      }
    }
    const orderId = dto.order_id ? this.uuid(dto.order_id, 'order_id') : null;
    const orderLineId = dto.order_line_id ? this.uuid(dto.order_line_id, 'order_line_id') : null;
    if ((orderId === null) !== (orderLineId === null)) {
      throw new BadRequestException('order_id and order_line_id must be supplied together');
    }
    const requestHash = this.hash({
      container_unit_id: containerId, shipment_code: shipmentCode, customer_name: customerName,
      customer_order_reference: customerOrderReference, carrier_name: carrierName, tracking_reference: trackingReference,
      order_id: orderId, order_line_id: orderLineId,
    });
    const correlationId = this.correlation(requestId, traceId);

    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: this.uuidOrNull(requestId), traceId: this.uuidOrNull(traceId) },
        async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':wms-dispatch:' + key]);
          const replay = await client.query<{
            shipment_unit_id: string; shipment_code: string; container_unit_id: string;
            quantity: string; unit: string; inventory_movement_id: string;
            order_id: string | null; order_line_id: string | null; request_hash: string;
          }>(`
            SELECT shipment_unit_id::text AS shipment_unit_id, shipment_code,
              container_unit_id::text AS container_unit_id, quantity::text AS quantity, unit,
              inventory_movement_id::text AS inventory_movement_id,
              order_id::text AS order_id, order_line_id::text AS order_line_id, request_hash
            FROM wms_shipments WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE
          `, [tenantId, factoryId, key]);
          if (replay.rows[0]) {
            if (replay.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Dispatch idempotency key was already used for a different shipment');
            }
            return { shipment: replay.rows[0], replayed: true };
          }

          const containerResult = await client.query<WmsContainerRow>(`
            SELECT c.container_unit_id::text AS container_unit_id, c.tenant_id::text AS tenant_id,
              c.factory_id::text AS factory_id, c.item_id::text AS item_id, c.location_id::text AS location_id,
              c.container_type, c.unit, c.capacity_quantity::text AS capacity_quantity,
              c.packed_quantity::text AS packed_quantity, c.status, u.unit_code, c.idempotency_key,
              c.request_hash, c.seal_idempotency_key, c.sealed_at::text AS sealed_at,
              c.dispatched_at::text AS dispatched_at
            FROM wms_packing_containers c JOIN traceability_units u
              ON u.id=c.container_unit_id AND u.tenant_id=c.tenant_id AND u.factory_id=c.factory_id
            WHERE c.container_unit_id=$1 AND c.tenant_id=$2 AND c.factory_id=$3 FOR UPDATE OF c
          `, [containerId, tenantId, factoryId]);
          const container = containerResult.rows[0];
          if (!container) throw new NotFoundException('Packing container not found in this factory');
          if (container.status !== 'SEALED') throw new ConflictException('Only sealed containers can be dispatched');
          if (Number(container.packed_quantity) <= 0) throw new ConflictException('Empty containers cannot be dispatched');
          if (container.container_type === 'CARTON') {
            const parent = await client.query<{ present: boolean }>(`
              SELECT EXISTS (
                SELECT 1 FROM wms_packing_contents pc
                WHERE pc.tenant_id=$1 AND pc.factory_id=$2 AND pc.source_container_unit_id=$3
              ) AS present
            `, [tenantId, factoryId, containerId]);
            if (parent.rows[0]?.present) {
              throw new ConflictException('This carton belongs to a pallet; dispatch the pallet instead');
            }
          }

          const leafResult = await client.query<WmsLeafRow>(`
            WITH RECURSIVE tree(unit_id, edge_quantity, path) AS (
              SELECT pc.source_unit_id, pc.quantity, ARRAY[pc.container_unit_id, pc.source_unit_id]::uuid[]
              FROM wms_packing_contents pc
              WHERE pc.tenant_id=$1 AND pc.factory_id=$2 AND pc.container_unit_id=$3
              UNION ALL
              SELECT pc.source_unit_id, pc.quantity, t.path || pc.source_unit_id
              FROM tree t
              JOIN wms_packing_contents pc ON pc.container_unit_id=t.unit_id
                AND pc.tenant_id=$1 AND pc.factory_id=$2
              WHERE NOT pc.source_unit_id = ANY(t.path)
            ), leaves AS (
              SELECT t.unit_id, sum(t.edge_quantity)::numeric(18,4) AS quantity_to_ship
              FROM tree t
              WHERE NOT EXISTS (
                SELECT 1 FROM wms_packing_containers nested
                WHERE nested.tenant_id=$1 AND nested.factory_id=$2 AND nested.container_unit_id=t.unit_id
              )
              GROUP BY t.unit_id
            )
            SELECT u.id::text AS id, u.unit_type, u.product_role, u.unit_code,
              u.inventory_item_id::text AS inventory_item_id, u.quantity::text AS quantity,
              u.unit, u.status, u.expires_at::text AS expires_at, u.attributes,
              l.quantity_to_ship::text AS quantity_to_ship
            FROM leaves l JOIN traceability_units u
              ON u.id=l.unit_id AND u.tenant_id=$1 AND u.factory_id=$2
            ORDER BY u.id
          `, [tenantId, factoryId, containerId]);
          const leaves = leafResult.rows;
          // Lock each leaf identity in stable UUID order so a concurrent hold/recall or
          // another shipment cannot pass validation against a stale status snapshot.
          for (const leaf of leaves) {
            const locked = await client.query<TraceUnitRow>(`
              SELECT id::text AS id, unit_type, product_role, unit_code,
                inventory_item_id::text AS inventory_item_id, quantity::text AS quantity,
                unit, status, expires_at::text AS expires_at, attributes
              FROM traceability_units
              WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
              FOR UPDATE
            `, [leaf.id, tenantId, factoryId]);
            if (!locked.rows[0]) throw new ConflictException('Finished-good lot identity disappeared before dispatch');
            Object.assign(leaf, locked.rows[0]);
          }
          if (!leaves.length || leaves.some(l => l.unit_type !== 'LOT' || l.product_role !== 'FINISHED_GOOD'
            || l.inventory_item_id !== container.item_id || l.unit !== container.unit || l.status !== 'ACTIVE')) {
            throw new ConflictException('Shipment contents must resolve only to active same-item finished-good lots');
          }
          const totalUnits = leaves.reduce((sum, l) => sum + this.units(l.quantity_to_ship), 0);
          if (totalUnits !== this.units(container.packed_quantity)) {
            throw new ConflictException('Packed content genealogy does not conserve the container shipment quantity');
          }
          for (const leaf of leaves) {
            if (leaf.expires_at && leaf.expires_at < new Date().toISOString().slice(0, 10)) {
              throw new ConflictException('Expired finished-good lots cannot be dispatched');
            }
            const attributes = leaf.attributes ?? {};
            const condition = String(attributes.condition ?? '').toUpperCase();
            if (attributes.damaged === true || attributes.held === true || attributes.quarantined === true
              || ['DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED'].includes(condition)) {
              throw new ConflictException('Damaged, held or quarantined finished-good lots cannot be dispatched');
            }
            const hold = await client.query<{ present: boolean }>(`
              SELECT EXISTS (SELECT 1 FROM quality_holds qh WHERE qh.tenant_id=$1 AND qh.factory_id=$2
                AND qh.status='ACTIVE' AND (qh.inventory_item_id=$3 OR qh.traceability_unit_id=$4)) AS present
            `, [tenantId, factoryId, container.item_id, leaf.id]);
            if (hold.rows[0]?.present) throw new ConflictException('Quality-held inventory cannot be dispatched');

            const lotBalance = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(`
              SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved
              FROM inventory_traceability_location_balances
              WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4 AND location_id=$5
              FOR UPDATE
            `, [tenantId, factoryId, container.item_id, leaf.id, container.location_id]);
            const stock = lotBalance.rows[0];
            if (!stock || this.units(stock.quantity_on_hand) - this.units(stock.quantity_reserved) < this.units(leaf.quantity_to_ship)) {
              throw new ConflictException('Shipment quantity exceeds unreserved lot stock at the container location');
            }
          }

          const itemResult = await client.query<{ unit: string; status: string; sku: string }>(`
            SELECT unit, status, sku FROM inventory_items
            WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE
          `, [container.item_id, tenantId, factoryId]);
          const item = itemResult.rows[0];
          if (!item || item.status !== 'ACTIVE' || item.unit !== container.unit) {
            throw new ConflictException('Shipment inventory item is inactive or its UOM does not match');
          }

          if (orderId && orderLineId) {
            const orderResult = await client.query<{
              order_number: string; customer_name: string | null; customer_reference: string | null; status: string;
            }>(`
              SELECT order_number, customer_name, customer_reference, status
              FROM orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE
            `, [orderId, tenantId, factoryId]);
            const order = orderResult.rows[0];
            if (!order) throw new NotFoundException('Customer order not found in this factory');
            if (!['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(order.status)) {
              throw new ConflictException('Only confirmed, in-progress or completed orders may be dispatched');
            }
            if (!order.customer_name?.trim()
              || order.customer_name.trim().toLowerCase() !== customerName.trim().toLowerCase()) {
              throw new ConflictException('Shipment customer must match the bound customer order');
            }
            const expectedReference = order.customer_reference?.trim() || order.order_number.trim();
            if (expectedReference.toLowerCase() !== customerOrderReference.trim().toLowerCase()) {
              throw new ConflictException('Shipment customer-order reference must match the bound order reference');
            }
            const lineResult = await client.query<{ product_code: string; unit: string; quantity: string; inventory_item_id: string | null }>(`
              SELECT product_code, unit, quantity::text AS quantity, inventory_item_id::text AS inventory_item_id
              FROM order_lines WHERE id=$1 AND order_id=$2 AND tenant_id=$3 AND factory_id=$4 FOR UPDATE
            `, [orderLineId, orderId, tenantId, factoryId]);
            const orderLine = lineResult.rows[0];
            if (!orderLine) throw new NotFoundException('Customer order line not found in the bound order');
            if (orderLine.product_code.trim().toUpperCase() !== item.sku.trim().toUpperCase()
              || orderLine.unit.trim().toUpperCase() !== item.unit.trim().toUpperCase()
              || (orderLine.inventory_item_id !== null && orderLine.inventory_item_id !== container.item_id)) {
              throw new ConflictException('Shipment item, SKU and UOM must match the bound order line');
            }
            const priorShipped = await client.query<{ quantity: string }>(`
              SELECT COALESCE(sum(quantity),0)::text AS quantity
              FROM wms_shipments
              WHERE tenant_id=$1 AND factory_id=$2 AND order_id=$3 AND order_line_id=$4
            `, [tenantId, factoryId, orderId, orderLineId]);
            if (this.units(priorShipped.rows[0]?.quantity ?? '0') + totalUnits > this.units(orderLine.quantity)) {
              throw new ConflictException('Shipment quantity exceeds the unshipped quantity on the bound order line');
            }
          }

          const aggregateResult = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(`
            SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved
            FROM inventory_stock_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 FOR UPDATE
          `, [tenantId, factoryId, container.item_id]);
          const aggregate = aggregateResult.rows[0];
          if (!aggregate || this.units(aggregate.quantity_on_hand) - this.units(aggregate.quantity_reserved) < totalUnits) {
            throw new ConflictException('Shipment quantity exceeds unreserved aggregate inventory');
          }
          const locationResult = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(`
            SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved
            FROM inventory_location_balances
            WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND location_id=$4 FOR UPDATE
          `, [tenantId, factoryId, container.item_id, container.location_id]);
          const location = locationResult.rows[0];
          if (!location || this.units(location.quantity_on_hand) - this.units(location.quantity_reserved) < totalUnits) {
            throw new ConflictException('Shipment quantity exceeds unreserved item stock at the container location');
          }

          const unitIdResult = await client.query<{ id: string }>(`
            INSERT INTO traceability_units (
              tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
              quantity, unit, external_reference, attributes, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES ($1,$2,'SHIPMENT','SHIPMENT',$3,$3,$4::numeric,$5,$6,$7::jsonb,$8,$9,$10,$11)
            RETURNING id::text AS id
          `, [tenantId, factoryId, shipmentCode, container.packed_quantity, container.unit,
            customerOrderReference, JSON.stringify({
              customer_name: customerName, customer_order_reference: customerOrderReference,
              carrier_name: carrierName, tracking_reference: trackingReference,
              container_unit_id: containerId, item_id: container.item_id,
              order_id: orderId, order_line_id: orderLineId,
            }), 'wms-shipment-' + this.hash(key), requestHash, userId, correlationId]);
          const shipmentUnitId = unitIdResult.rows[0]?.id;
          if (!shipmentUnitId) throw new Error('WMS_SHIPMENT_TRACEABILITY_IDENTITY_INSERT_FAILED');
          await this.insertAudit(client, tenantId, factoryId, userId, 'TRACEABILITY_UNIT', shipmentUnitId,
            'REGISTERED', correlationId, requestId, { unit_type: 'SHIPMENT', product_role: 'SHIPMENT', unit_code: shipmentCode });
          await this.insertOutbox(client, tenantId, factoryId, 'TRACEABILITY_UNIT', shipmentUnitId,
            'TRACEABILITY.UNIT_REGISTERED', { unit_id: shipmentUnitId, unit_type: 'SHIPMENT', product_role: 'SHIPMENT', unit_code: shipmentCode });

          const genealogyResult = await client.query<{ id: string }>(`
            INSERT INTO product_genealogy_events (
              tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
              quantity, unit, evidence, notes, idempotency_key, request_hash,
              created_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,'SHIPPED_AS',$5::numeric,$6,$7::jsonb,$8,$9,$10,$11,$12)
            RETURNING id::text AS id
          `, [tenantId, factoryId, containerId, shipmentUnitId, container.packed_quantity, container.unit,
            JSON.stringify({ customer_order_reference: customerOrderReference, container_unit_id: containerId }),
            'WMS customer dispatch', 'wms-shipped-edge-' + this.hash(key), requestHash, userId, correlationId]);
          const genealogyId = genealogyResult.rows[0]?.id;
          if (!genealogyId) throw new Error('WMS_SHIPMENT_GENEALOGY_INSERT_FAILED');
          await this.insertAudit(client, tenantId, factoryId, userId, 'PRODUCT_GENEALOGY_EVENT', genealogyId,
            'RECORDED', correlationId, requestId, { source_unit_id: containerId, target_unit_id: shipmentUnitId, relationship_type: 'SHIPPED_AS', quantity: container.packed_quantity });
          await this.insertOutbox(client, tenantId, factoryId, 'PRODUCT_GENEALOGY_EVENT', genealogyId,
            'TRACEABILITY.GENEALOGY_RECORDED', { genealogy_event_id: genealogyId, source_unit_id: containerId, target_unit_id: shipmentUnitId, relationship_type: 'SHIPPED_AS', quantity: container.packed_quantity });

          await client.query('SELECT set_config(\'app.inventory_location_id\', $1, TRUE)', [container.location_id]);
          const quantityDecimal = this.fromUnits(totalUnits);
          const balanceUpdate = await client.query<{ quantity_on_hand: string }>(`
            UPDATE inventory_stock_balances
            SET quantity_on_hand=quantity_on_hand - $1::numeric,
                version=version+1, updated_at=clock_timestamp()
            WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4
              AND quantity_on_hand - $1::numeric >= quantity_reserved
            RETURNING quantity_on_hand::text AS quantity_on_hand
          `, [quantityDecimal, tenantId, factoryId, container.item_id]);
          const afterBalance = balanceUpdate.rows[0];
          if (!afterBalance) throw new ConflictException('Insufficient available aggregate inventory for dispatch');

          for (const leaf of leaves) {
            const updated = await client.query(`
              UPDATE inventory_traceability_location_balances
              SET quantity_on_hand=quantity_on_hand - $1::numeric,
                  version=version+1, updated_at=clock_timestamp()
              WHERE tenant_id=$2 AND factory_id=$3 AND item_id=$4 AND traceability_unit_id=$5
                AND location_id=$6 AND quantity_on_hand - quantity_reserved >= $1::numeric
            `, [leaf.quantity_to_ship, tenantId, factoryId, container.item_id, leaf.id, container.location_id]);
            if (updated.rowCount !== 1) throw new ConflictException('Finished-good lot balance changed before dispatch');
          }

          const movementResult = await client.query<{ id: string }>(`
            INSERT INTO inventory_movements (
              tenant_id, factory_id, item_id, location_id, movement_type, quantity,
              quantity_delta, quantity_after, input_quantity, input_unit_code, conversion_rule_id,
              conversion_factor_numerator, conversion_factor_denominator, conversion_rounding_mode,
              idempotency_key, request_hash, reference_type, reference_id, notes,
              created_by_user_id, correlation_id
            ) VALUES (
              $1,$2,$3,$4,'ISSUE',$5::numeric,-$5::numeric,$6::numeric,$5::numeric,$7,
              NULL,NULL,NULL,NULL,$8,$9,'WMS_SHIPMENT',$10::uuid,$11,$12,$13::uuid
            ) RETURNING id::text AS id
          `, [tenantId, factoryId, container.item_id, container.location_id, quantityDecimal,
            afterBalance.quantity_on_hand, container.unit, 'wms-shipment-' + this.hash(key),
            requestHash, shipmentUnitId, 'WMS customer dispatch ' + shipmentCode, userId, correlationId]);
          const movementId = movementResult.rows[0]?.id;
          if (!movementId) throw new Error('WMS_SHIPMENT_INVENTORY_MOVEMENT_INSERT_FAILED');

          await client.query(`
            INSERT INTO wms_shipments (
              shipment_unit_id, tenant_id, factory_id, container_unit_id, item_id, source_location_id,
              inventory_movement_id, shipment_code, customer_name, customer_order_reference, order_id, order_line_id,
              carrier_name, tracking_reference, quantity, unit, status, idempotency_key, request_hash,
              dispatched_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::numeric,$16,'DISPATCHED',$17,$18,$19,$20)
          `, [shipmentUnitId, tenantId, factoryId, containerId, container.item_id, container.location_id,
            movementId, shipmentCode, customerName, customerOrderReference, orderId, orderLineId,
            carrierName, trackingReference, quantityDecimal, container.unit, key, requestHash, userId, correlationId]);

          await client.query(`
            UPDATE wms_packing_containers
            SET status='DISPATCHED', dispatched_at=clock_timestamp(), updated_at=clock_timestamp()
            WHERE container_unit_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='SEALED'
          `, [containerId, tenantId, factoryId]);

          // A pallet dispatch takes every packed carton with it. Record the inner
          // carton lifecycle in the same transaction; a shipped pallet must not
          // leave descendant carton identities apparently active.
          const nestedContainers = await client.query<{ container_unit_id: string }>(`
            SELECT nested.container_unit_id::text AS container_unit_id
            FROM wms_packing_contents pc
            JOIN wms_packing_containers nested
              ON nested.container_unit_id=pc.source_container_unit_id
             AND nested.tenant_id=pc.tenant_id AND nested.factory_id=pc.factory_id
            WHERE pc.tenant_id=$1 AND pc.factory_id=$2
              AND pc.container_unit_id=$3 AND pc.source_container_unit_id IS NOT NULL
              AND nested.status='SEALED'
            ORDER BY nested.container_unit_id
            FOR UPDATE OF nested
          `, [tenantId, factoryId, containerId]);
          for (const nested of nestedContainers.rows) {
            const changed = await client.query(`
              UPDATE wms_packing_containers
              SET status='DISPATCHED', dispatched_at=clock_timestamp(), updated_at=clock_timestamp()
              WHERE container_unit_id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='SEALED'
            `, [nested.container_unit_id, tenantId, factoryId]);
            if (changed.rowCount !== 1) throw new ConflictException('Nested carton lifecycle changed before pallet dispatch');
            await this.changeUnitStatus(client, tenantId, factoryId, userId, nested.container_unit_id,
              'SHIPPED', 'Carton dispatched inside shipment ' + shipmentCode, correlationId, requestId);
          }

          await this.changeUnitStatus(client, tenantId, factoryId, userId, containerId,
            'SHIPPED', 'Container dispatched in shipment ' + shipmentCode, correlationId, requestId);
          await this.changeUnitStatus(client, tenantId, factoryId, userId, shipmentUnitId,
            'SHIPPED', 'Shipment dispatched to ' + customerName + ' against ' + customerOrderReference, correlationId, requestId);

          for (const leaf of leaves) {
            const remaining = await client.query<{ quantity: string }>(`
              SELECT COALESCE(sum(quantity_on_hand),0)::text AS quantity
              FROM inventory_traceability_location_balances
              WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4
            `, [tenantId, factoryId, container.item_id, leaf.id]);
            if (this.units(remaining.rows[0]?.quantity ?? '0') === 0) {
              await this.changeUnitStatus(client, tenantId, factoryId, userId, leaf.id,
                'SHIPPED', 'All physically tracked quantity dispatched in shipment ' + shipmentCode, correlationId, requestId);
            }
          }

          await this.insertAudit(client, tenantId, factoryId, userId, 'WMS_SHIPMENT', shipmentUnitId,
            'DISPATCHED', correlationId, requestId, {
              shipment_code: shipmentCode, customer_name: customerName,
              customer_order_reference: customerOrderReference, container_unit_id: containerId,
              item_id: container.item_id, quantity: quantityDecimal, unit: container.unit, inventory_movement_id: movementId,
              order_id: orderId, order_line_id: orderLineId,
            });
          await this.insertOutbox(client, tenantId, factoryId, 'WMS_SHIPMENT', shipmentUnitId,
            'WMS.SHIPMENT_DISPATCHED', {
              shipment_unit_id: shipmentUnitId, shipment_code: shipmentCode,
              customer_order_reference: customerOrderReference, container_unit_id: containerId,
              item_id: container.item_id, quantity: quantityDecimal, unit: container.unit,
              inventory_movement_id: movementId, order_id: orderId, order_line_id: orderLineId,
            });
          return {
            shipment: {
              shipment_unit_id: shipmentUnitId, shipment_code: shipmentCode, container_unit_id: containerId,
              item_id: container.item_id, source_location_id: container.location_id,
              quantity: quantityDecimal, unit: container.unit, inventory_movement_id: movementId,
              customer_name: customerName, customer_order_reference: customerOrderReference,
              carrier_name: carrierName, tracking_reference: trackingReference,
              order_id: orderId, order_line_id: orderLineId, status: 'DISPATCHED',
            },
            replayed: false,
          };
        },
      );
    } catch (error) {
      throw this.mapError(error, 'Shipment conflicts with current stock, container state, identity or idempotency binding');
    }
  }

  async listShipments(
    userId: string, tenantId: string, factoryId: string,
    options: { search?: string; limit?: number } = {},
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const search = options.search?.trim() || null;
    if (search && search.length > 255) {
      throw new BadRequestException('search must contain at most 255 characters');
    }
    const result = await this.database.query(`
      SELECT s.shipment_unit_id::text AS shipment_unit_id,
        s.shipment_code, s.container_unit_id::text AS container_unit_id,
        container_unit.unit_code AS container_code,
        s.item_id::text AS item_id, s.source_location_id::text AS source_location_id,
        s.inventory_movement_id::text AS inventory_movement_id,
        s.customer_name, s.customer_order_reference, s.order_id::text AS order_id,
        s.order_line_id::text AS order_line_id, s.carrier_name, s.tracking_reference,
        s.quantity::text AS quantity, s.unit, s.status,
        s.dispatched_at::text AS dispatched_at,
        shipment_unit.status AS traceability_status,
        latest_delivery.event_type AS latest_delivery_event_type,
        latest_delivery.event_at::text AS latest_delivery_event_at
      FROM wms_shipments s
      LEFT JOIN LATERAL (
        SELECT e.event_type, e.event_at
        FROM wms_shipment_delivery_events e
        WHERE e.tenant_id=s.tenant_id AND e.factory_id=s.factory_id
          AND e.shipment_unit_id=s.shipment_unit_id
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1
      ) latest_delivery ON TRUE
      JOIN traceability_units shipment_unit
        ON shipment_unit.id=s.shipment_unit_id
       AND shipment_unit.tenant_id=s.tenant_id AND shipment_unit.factory_id=s.factory_id
      JOIN traceability_units container_unit
        ON container_unit.id=s.container_unit_id
       AND container_unit.tenant_id=s.tenant_id AND container_unit.factory_id=s.factory_id
      WHERE s.tenant_id=$1 AND s.factory_id=$2
        AND (
          $3::text IS NULL
          OR s.shipment_code ILIKE '%' || $3 || '%'
          OR s.customer_name ILIKE '%' || $3 || '%'
          OR s.customer_order_reference ILIKE '%' || $3 || '%'
          OR COALESCE(s.tracking_reference, '') ILIKE '%' || $3 || '%'
        )
      ORDER BY s.dispatched_at DESC, s.shipment_unit_id DESC
      LIMIT $4
    `, [tenantId, factoryId, search, limit], { tenantId, userId });
    return { shipments: result.rows, limit };
  }

  async recordDeliveryEvent(
    userId: string, tenantId: string, factoryId: string, shipmentUnitId: string,
    dto: RecordWmsShipmentDeliveryEventDto, rawKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const shipmentId = this.uuid(shipmentUnitId, 'shipmentUnitId');
    const key = this.requiredKey(rawKey);
    const eventType = this.requiredText(dto.event_type, 'event_type', 24).toUpperCase();
    if (!['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED'].includes(eventType)) {
      throw new BadRequestException('event_type is not supported');
    }
    // Fingerprint the caller's input, not a timestamp synthesized by this server.
    // If event_at is omitted, a retry must match the original request even though "now" changes.
    const suppliedEventAt = dto.event_at != null ? new Date(dto.event_at) : null;
    if (suppliedEventAt && !Number.isFinite(suppliedEventAt.getTime())) {
      throw new BadRequestException('event_at must be a valid timestamp');
    }
    const eventAt = suppliedEventAt ?? new Date();
    if (eventAt.getTime() > Date.now() + 10 * 60 * 1000) {
      throw new BadRequestException('event_at cannot be more than ten minutes in the future');
    }
    const recipientName = dto.recipient_name?.trim() || null;
    const proofType = dto.proof_type?.trim().toUpperCase() || null;
    const proofReference = dto.proof_reference?.trim() || null;
    const proofSha256 = dto.proof_sha256?.trim().toLowerCase() || null;
    const signedAt = dto.signed_at ? new Date(dto.signed_at) : null;
    const notes = dto.notes?.trim() || null;
    if (eventType === 'DELIVERED') {
      if (!recipientName || !proofType || !proofReference || !proofSha256 || !signedAt
        || !Number.isFinite(signedAt.getTime()) || signedAt.getTime() > eventAt.getTime()) {
        throw new BadRequestException('DELIVERED requires recipient, proof type, object key, SHA-256 digest and signed timestamp');
      }
      if (!['SIGNATURE', 'PHOTO', 'DOCUMENT', 'OTP', 'CUSTOMER_ACKNOWLEDGEMENT'].includes(proofType)) {
        throw new BadRequestException('proof_type is not supported');
      }
      if (!/^[a-f0-9]{64}$/.test(proofSha256)) throw new BadRequestException('proof_sha256 must be SHA-256 hex');
      if (proofReference.length > 500 || !/^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(proofReference)) {
        throw new BadRequestException('proof_reference must be a relative storage object key');
      }
    } else if (recipientName || proofType || proofReference || proofSha256 || signedAt) {
      throw new BadRequestException('POD fields may only be provided for DELIVERED events');
    }
    const requestHash = this.hash({
      shipment_unit_id: shipmentId, event_type: eventType,
      event_at: suppliedEventAt?.toISOString() ?? null,
      recipient_name: recipientName, proof_type: proofType, proof_reference: proofReference,
      proof_sha256: proofSha256, signed_at: signedAt?.toISOString() ?? null, notes,
    });
    const requestUuid = this.uuidOrNull(requestId);
    const correlationId = this.correlation(requestId, traceId);
    try {
      return await this.database.transaction(
        { tenantId, userId, requestId: requestUuid, traceId: this.uuidOrNull(traceId) },
        async (client) => {
          const shipmentResult = await client.query<{ shipment_unit_id: string; shipment_code: string; status: string }>(
            'SELECT shipment_unit_id::text AS shipment_unit_id, shipment_code, status FROM wms_shipments WHERE shipment_unit_id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
            [shipmentId, tenantId, factoryId],
          );
          const shipment = shipmentResult.rows[0];
          if (!shipment) throw new NotFoundException('Shipment not found in this factory');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [tenantId + ':' + factoryId + ':wms-delivery-event:' + key]);
          const replay = await client.query<{ id: string; request_hash: string }>(
            'SELECT id::text AS id, request_hash FROM wms_shipment_delivery_events WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
            [tenantId, factoryId, key],
          );
          if (replay.rows[0]) {
            if (replay.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Delivery event idempotency key was used for a different request');
            }
            const prior = await client.query(
              'SELECT id::text AS id, shipment_unit_id::text AS shipment_unit_id, event_type, source_system, event_at::text AS event_at, recipient_name, proof_type, proof_reference, proof_sha256, signed_at::text AS signed_at, notes, recorded_by_user_id::text AS recorded_by_user_id, created_at::text AS created_at FROM wms_shipment_delivery_events WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
              [replay.rows[0].id, tenantId, factoryId],
            );
            return { event: prior.rows[0], replayed: true };
          }
          const inserted = await client.query<{ id: string; [key: string]: unknown }>(
            'INSERT INTO wms_shipment_delivery_events (tenant_id,factory_id,shipment_unit_id,event_type,source_system,event_at,recipient_name,proof_type,proof_reference,proof_sha256,signed_at,notes,idempotency_key,request_hash,recorded_by_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11::timestamptz,$12,$13,$14,$15,$16::uuid) RETURNING id::text AS id, shipment_unit_id::text AS shipment_unit_id, event_type, source_system, event_at::text AS event_at, recipient_name, proof_type, proof_reference, proof_sha256, signed_at::text AS signed_at, notes, recorded_by_user_id::text AS recorded_by_user_id, created_at::text AS created_at',
            [tenantId, factoryId, shipmentId, eventType, 'MANUAL', eventAt.toISOString(), recipientName, proofType, proofReference, proofSha256, signedAt?.toISOString() ?? null, notes, key, requestHash, userId, correlationId],
          );
          const event = inserted.rows[0];
          if (!event) throw new Error('WMS_SHIPMENT_DELIVERY_EVENT_INSERT_FAILED');
          await this.insertAudit(client, tenantId, factoryId, userId, 'WMS_SHIPMENT_DELIVERY_EVENT', event.id, 'RECORDED', correlationId, requestId, {
            shipment_unit_id: shipmentId, shipment_code: shipment.shipment_code, event_type: eventType, event_at: eventAt.toISOString(),
            source_system: 'MANUAL', proof_type: proofType, proof_reference: proofReference, proof_sha256: proofSha256,
          });
          await this.insertOutbox(client, tenantId, factoryId, 'WMS_SHIPMENT_DELIVERY_EVENT', event.id, 'WMS.SHIPMENT_DELIVERY_EVENT_RECORDED', {
            delivery_event_id: event.id, shipment_unit_id: shipmentId, shipment_code: shipment.shipment_code, event_type: eventType,
            event_at: eventAt.toISOString(), source_system: 'MANUAL', proof_type: proofType, proof_reference: proofReference, proof_sha256: proofSha256,
          });
          return { event, replayed: false };
        },
      );
    } catch (error) {
      throw this.mapError(error, 'Shipment delivery event conflicts with lifecycle, proof requirements or idempotency binding');
    }
  }

  async listDeliveryEvents(userId: string, tenantId: string, factoryId: string, shipmentUnitId: string) {
    this.validateScope(userId, tenantId, factoryId);
    const shipmentId = this.uuid(shipmentUnitId, 'shipmentUnitId');
    const shipment = await this.database.query(
      'SELECT shipment_unit_id::text AS shipment_unit_id, shipment_code FROM wms_shipments WHERE shipment_unit_id=$1 AND tenant_id=$2 AND factory_id=$3 LIMIT 1',
      [shipmentId, tenantId, factoryId], { tenantId, userId },
    );
    if (!shipment.rows[0]) throw new NotFoundException('Shipment not found in this factory');
    const result = await this.database.query(
      'SELECT id::text AS id, shipment_unit_id::text AS shipment_unit_id, event_type, source_system, event_at::text AS event_at, recipient_name, proof_type, proof_reference, proof_sha256, signed_at::text AS signed_at, notes, recorded_by_user_id::text AS recorded_by_user_id, created_at::text AS created_at FROM wms_shipment_delivery_events WHERE tenant_id=$1 AND factory_id=$2 AND shipment_unit_id=$3 ORDER BY created_at, id',
      [tenantId, factoryId, shipmentId], { tenantId, userId },
    );
    return { shipment: shipment.rows[0], events: result.rows };
  }
  async getContainer(userId: string, tenantId: string, factoryId: string, containerUnitId: string) {
    this.validateScope(userId, tenantId, factoryId);
    const id = this.uuid(containerUnitId, 'containerUnitId');
    const result = await this.database.query(`
      SELECT c.container_unit_id::text AS container_unit_id, u.unit_code, c.item_id::text AS item_id,
        c.location_id::text AS location_id, c.container_type, c.unit,
        c.capacity_quantity::text AS capacity_quantity, c.packed_quantity::text AS packed_quantity,
        c.status, c.sealed_at::text AS sealed_at, c.dispatched_at::text AS dispatched_at,
        COALESCE(jsonb_agg(jsonb_build_object(
          'source_unit_id', p.source_unit_id, 'source_unit_code', source.unit_code,
          'quantity', p.quantity::text, 'unit', p.unit
        ) ORDER BY p.created_at) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS contents
      FROM wms_packing_containers c
      JOIN traceability_units u ON u.id=c.container_unit_id AND u.tenant_id=c.tenant_id AND u.factory_id=c.factory_id
      LEFT JOIN wms_packing_contents p ON p.container_unit_id=c.container_unit_id AND p.tenant_id=c.tenant_id AND p.factory_id=c.factory_id
      LEFT JOIN traceability_units source ON source.id=p.source_unit_id AND source.tenant_id=p.tenant_id AND source.factory_id=p.factory_id
      WHERE c.container_unit_id=$1 AND c.tenant_id=$2 AND c.factory_id=$3
      GROUP BY c.container_unit_id, c.tenant_id, c.factory_id, c.item_id, c.location_id, c.container_type, c.unit,
        c.capacity_quantity, c.packed_quantity, c.status, c.sealed_at, c.dispatched_at, u.unit_code
    `, [id, tenantId, factoryId], { tenantId, userId });
    if (!result.rows[0]) throw new NotFoundException('Packing container not found in this factory');
    return result.rows[0];
  }

  private async changeUnitStatus(
    client: PoolClient, tenantId: string, factoryId: string, userId: string, unitId: string,
    toStatus: 'SHIPPED', reason: string, correlationId: string, requestId: string | null,
  ) {
    const result = await client.query<{ version: string; status: string }>(`
      UPDATE traceability_units
      SET status=$1, version=version+1, updated_at=clock_timestamp()
      WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND status='ACTIVE'
      RETURNING version::text AS version, status
    `, [toStatus, unitId, tenantId, factoryId]);
    const unit = result.rows[0];
    if (!unit) throw new ConflictException('Only active traceability identities may transition to shipped status');
    await client.query(`
      INSERT INTO traceability_unit_status_events (
        tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
        idempotency_key, request_hash, changed_by_user_id, correlation_id
      ) VALUES ($1,$2,$3,$4::bigint,'ACTIVE',$5,$6,$7,$8,$9,$10)
    `, [tenantId, factoryId, unitId, unit.version, toStatus, reason,
      'wms-status-' + this.hash(unitId + ':' + toStatus + ':' + correlationId),
      this.hash({ unit_id: unitId, to_status: toStatus, reason }), userId, correlationId]);
    await this.insertAudit(client, tenantId, factoryId, userId, 'TRACEABILITY_UNIT', unitId,
      'STATUS_CHANGED', correlationId, requestId, { from_status: 'ACTIVE', to_status: toStatus, reason, version: unit.version });
    await this.insertOutbox(client, tenantId, factoryId, 'TRACEABILITY_UNIT', unitId,
      'TRACEABILITY.UNIT_STATUS_CHANGED', { unit_id: unitId, from_status: 'ACTIVE', to_status: toStatus, reason, version: unit.version });
  }

  private async insertAudit(
    client: PoolClient, tenantId: string, factoryId: string, userId: string,
    resourceType: string, resourceId: string, action: string, correlationId: string,
    requestId: string | null, payload: Record<string, unknown>,
  ) {
    await client.query(`
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type,
        resource_id, correlation_id, request_id, data_class, payload
      ) VALUES ($1,$2,$3,'WMS_FULFILLMENT',$4,$5,$6,$7,$8,'INTERNAL',$9::jsonb)
    `, [tenantId, factoryId, userId, action, resourceType, resourceId,
      correlationId, this.uuidOrNull(requestId), JSON.stringify(payload)]);
  }

  private async insertOutbox(
    client: PoolClient, tenantId: string, factoryId: string, aggregateType: string,
    aggregateId: string, eventType: string, payload: Record<string, unknown>,
  ) {
    await client.query(`
      INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `, [tenantId, factoryId, aggregateType, aggregateId, eventType, JSON.stringify(payload)]);
  }

  private correlation(requestId: string | null, traceId: string | null) {
    return this.uuidOrNull(traceId) ?? this.uuidOrNull(requestId) ?? createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8) + '-0000-4000-8000-000000000000';
  }
  private uuidOrNull(value: string | null | undefined) { return value && isUUID(value) ? value.toLowerCase() : null; }
  private uuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value.toLowerCase();
  }
  private validateScope(userId: string, tenantId: string, factoryId: string) {
    this.uuid(userId, 'userId'); this.uuid(tenantId, 'tenantId'); this.uuid(factoryId, 'factoryId');
  }
  private requiredKey(value: string | null) {
    const key = value?.trim() ?? '';
    if (!key || key.length > 255) throw new BadRequestException('Idempotency-Key is required and must contain at most 255 characters');
    return key;
  }
  private requiredText(value: string | undefined, field: string, max: number) {
    const result = value?.trim() ?? '';
    if (!result || result.length > max) throw new BadRequestException(field + ' is required and must contain at most ' + max + ' characters');
    return result;
  }
  private quantity(value: number, field: string) {
    if (!Number.isFinite(value) || value <= 0 || Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001) {
      throw new BadRequestException(field + ' must be positive with at most four decimal places');
    }
    return value.toFixed(4);
  }
  private units(value: string) { return Math.round(Number(value) * 10000); }
  private fromUnits(value: number) { return (value / 10000).toFixed(4); }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private mapError(error: unknown, conflictMessage: string) {
    if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException) return error;
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '') : '';
    if (code === '23505') return new ConflictException(conflictMessage);
    if (code === '23503' || code === '23514' || code === '55000') {
      const detail = error instanceof Error ? error.message : conflictMessage;
      return new ConflictException(detail);
    }
    return error;
  }
}
