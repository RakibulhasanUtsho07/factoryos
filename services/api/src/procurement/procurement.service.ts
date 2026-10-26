import {
  BadRequestException, ConflictException, ForbiddenException,
  Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { DatabaseService } from '../database/database.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { ListSuppliersDto } from './dto/list-suppliers.dto';
import { TransitionSupplierStatusDto } from './dto/transition-supplier-status.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { canTransitionPurchaseOrder, PurchaseOrderStatus, SupplierStatus } from './purchase-order-lifecycle';

export interface SupplierRow extends QueryResultRow {
  id: string; tenant_id: string; code: string; name: string; status: SupplierStatus;
  country_code: string; email: string | null; phone: string | null; tax_reference: string | null;
  payment_terms_days: number; currency: string; address: string | null; notes: string | null;
  created_by_user_id: string; created_at: string; updated_at: string; version: string;
}
export interface PurchaseOrderHeader extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; supplier_id: string; supplier_code: string;
  supplier_name: string; po_number: string; status: PurchaseOrderStatus; order_date: string;
  expected_delivery_date: string | null; currency: string; payment_terms_days: number;
  notes: string | null; created_by_user_id: string; submitted_by_user_id: string | null;
  submitted_at: string | null; approved_by_user_id: string | null; approved_at: string | null;
  rejected_by_user_id: string | null; rejected_at: string | null; rejection_reason: string | null;
  cancelled_by_user_id: string | null; cancelled_at: string | null; cancellation_reason: string | null;
  created_at: string; updated_at: string; version: string; total_amount: string; line_count: string;
}
export interface PurchaseOrderLine extends QueryResultRow {
  id: string; line_number: number; inventory_item_id: string | null; description: string;
  quantity: string; unit: string; unit_price: string; line_amount: string; notes: string | null;
}
export interface PurchaseOrderHistory extends QueryResultRow {
  id: string; from_status: PurchaseOrderStatus | null; to_status: PurchaseOrderStatus;
  version: string; actor_user_id: string; reason: string | null; request_id: string | null;
  trace_id: string | null; created_at: string;
}

@Injectable()
export class ProcurementService {
  constructor(private readonly database: DatabaseService) {}

  async createSupplier(userId: string, tenantId: string, dto: CreateSupplierDto, requestId: string | null, traceId: string | null) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    const code = dto.code.trim().toUpperCase();
    const name = dto.name.trim();
    const countryCode = (dto.country_code ?? 'BD').trim().toUpperCase();
    const currency = (dto.currency ?? 'BDT').trim().toUpperCase();
    if (!code || !name) throw new BadRequestException('Supplier code and name are required');
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new BadRequestException('country_code must contain two letters');
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('currency must be a 3-letter code');

    let row: SupplierRow;
    try {
      row = await this.database.transaction({
        tenantId, userId, requestId: this.uuidOrNull(requestId), traceId: this.uuidOrNull(traceId),
      }, async client => {
        const result = await client.query<SupplierRow>(`
          INSERT INTO suppliers (
            tenant_id, code, name, country_code, email, phone, tax_reference,
            payment_terms_days, currency, address, notes, created_by_user_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id::text AS id, tenant_id::text AS tenant_id, code, name, status,
            country_code, email, phone, tax_reference, payment_terms_days, currency,
            address, notes, created_by_user_id::text AS created_by_user_id,
            created_at::text AS created_at, updated_at::text AS updated_at, version::text AS version
        `, [tenantId, code, name, countryCode, dto.email?.trim().toLowerCase() ?? null,
          dto.phone?.trim() ?? null, dto.tax_reference?.trim() ?? null,
          dto.payment_terms_days ?? 0, currency, dto.address?.trim() ?? null, dto.notes?.trim() ?? null, userId]);
        const created = result.rows[0];
        if (!created) throw new Error('SUPPLIER_INSERT_FAILED');
        await this.insertOutbox(client, tenantId, null, 'SUPPLIER', created.id,
          'PROCUREMENT.SUPPLIER_CREATED', {
            supplier_id: created.id, code: created.code, status: created.status, version: created.version,
          });
        return created;
      });
    } catch (error) {
      if (this.errorCode(error) === '23505') throw new ConflictException('Supplier code already exists in this tenant');
      throw error;
    }
    return this.mapSupplier(row);
  }

  async updateSupplier(
    userId: string, tenantId: string, supplierId: string, dto: UpdateSupplierDto,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(supplierId, 'supplierId');
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }

    const editableFields = [
      'name', 'country_code', 'email', 'phone', 'tax_reference',
      'payment_terms_days', 'currency', 'address', 'notes',
    ] as const;
    const changedFields = editableFields.filter(field => dto[field] !== undefined);
    if (changedFields.length === 0) {
      throw new BadRequestException('At least one supplier profile field must be supplied');
    }
    if (dto.name !== undefined && typeof dto.name !== 'string') {
      throw new BadRequestException('name must be a string');
    }
    if (dto.country_code !== undefined && typeof dto.country_code !== 'string') {
      throw new BadRequestException('country_code must be a string');
    }
    if (dto.currency !== undefined && typeof dto.currency !== 'string') {
      throw new BadRequestException('currency must be a string');
    }

    const updated = await this.database.transaction({
      tenantId, userId, requestId: this.uuidOrNull(requestId), traceId: this.uuidOrNull(traceId),
    }, async client => {
      const currentResult = await client.query<SupplierRow>(`
        SELECT id::text AS id, tenant_id::text AS tenant_id, code, name, status,
          country_code, email, phone, tax_reference, payment_terms_days, currency,
          address, notes, created_by_user_id::text AS created_by_user_id,
          created_at::text AS created_at, updated_at::text AS updated_at, version::text AS version
        FROM suppliers
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [supplierId, tenantId]);
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Supplier not found');
      if (Number(current.version) !== dto.expected_version) {
        throw new ConflictException('Supplier version conflict. Expected version ' + dto.expected_version + ', current version is ' + current.version);
      }

      const name = dto.name === undefined ? current.name : dto.name.trim();
      const countryCode = dto.country_code === undefined
        ? current.country_code : dto.country_code.trim().toUpperCase();
      const currency = dto.currency === undefined
        ? current.currency : dto.currency.trim().toUpperCase();
      const email = dto.email === undefined
        ? current.email : (dto.email?.trim().toLowerCase() || null);
      const phone = dto.phone === undefined ? current.phone : (dto.phone?.trim() || null);
      const taxReference = dto.tax_reference === undefined
        ? current.tax_reference : (dto.tax_reference?.trim() || null);
      const address = dto.address === undefined ? current.address : (dto.address?.trim() || null);
      const notes = dto.notes === undefined ? current.notes : (dto.notes?.trim() || null);
      const paymentTermsDays = dto.payment_terms_days ?? current.payment_terms_days;

      if (!name) throw new BadRequestException('Supplier name cannot be empty');
      if (!/^[A-Z]{2}$/.test(countryCode)) throw new BadRequestException('country_code must contain two letters');
      if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('currency must be a 3-letter code');

      const result = await client.query<SupplierRow>(`
        UPDATE suppliers
        SET name = $1, country_code = $2, email = $3, phone = $4, tax_reference = $5,
            payment_terms_days = $6, currency = $7, address = $8, notes = $9,
            updated_at = clock_timestamp(), version = version + 1
        WHERE id = $10 AND tenant_id = $11 AND version = $12
        RETURNING id::text AS id, tenant_id::text AS tenant_id, code, name, status,
          country_code, email, phone, tax_reference, payment_terms_days, currency,
          address, notes, created_by_user_id::text AS created_by_user_id,
          created_at::text AS created_at, updated_at::text AS updated_at, version::text AS version
      `, [name, countryCode, email, phone, taxReference, paymentTermsDays, currency, address, notes,
        supplierId, tenantId, current.version]);
      const row = result.rows[0];
      if (!row) throw new ConflictException('Supplier was changed concurrently');

      await this.insertOutbox(client, tenantId, null, 'SUPPLIER', supplierId,
        'PROCUREMENT.SUPPLIER_UPDATED', {
          supplier_id: supplierId, code: row.code, status: row.status,
          version: row.version, changed_fields: changedFields,
        });
      return row;
    });

    return this.mapSupplier(updated);
  }

  async listSuppliers(tenantId: string, dto: ListSuppliersDto) {
    this.validateUuid(tenantId, 'tenantId');
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const search = dto.search?.trim() || null;
    const result = await this.database.query<SupplierRow & { total_count: string }>(`
      SELECT s.id::text AS id, s.tenant_id::text AS tenant_id, s.code, s.name, s.status,
        s.country_code, s.email, s.phone, s.tax_reference, s.payment_terms_days, s.currency,
        s.address, s.notes, s.created_by_user_id::text AS created_by_user_id,
        s.created_at::text AS created_at, s.updated_at::text AS updated_at,
        s.version::text AS version, count(*) OVER()::text AS total_count
      FROM suppliers s
      WHERE s.tenant_id = $1
        AND ($2::text IS NULL OR s.status = $2)
        AND ($3::text IS NULL OR s.code ILIKE $3 OR s.name ILIKE $3 OR COALESCE(s.tax_reference,'') ILIKE $3)
      ORDER BY lower(s.name), s.id
      LIMIT $4 OFFSET $5
    `, [tenantId, dto.status ?? null, search ? '%' + search + '%' : null, limit, (page - 1) * limit], { tenantId });
    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return { items: result.rows.map(row => this.mapSupplier(row)), pagination: {
      page, limit, total, total_pages: total === 0 ? 0 : Math.ceil(total / limit),
    }};
  }

  async transitionSupplierStatus(
    userId: string, tenantId: string, supplierId: string,
    dto: TransitionSupplierStatusDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId'); this.validateUuid(tenantId, 'tenantId'); this.validateUuid(supplierId, 'supplierId');
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }
    const updated = await this.database.transaction({ tenantId, userId, requestId: this.uuidOrNull(requestId), traceId: this.uuidOrNull(traceId) }, async client => {
      const current = await client.query<{ id: string; code: string; status: SupplierStatus; version: string }>(`
        SELECT id::text AS id, code, status, version::text AS version
        FROM suppliers WHERE id = $1 AND tenant_id = $2 FOR UPDATE
      `, [supplierId, tenantId]);
      const supplier = current.rows[0];
      if (!supplier) throw new NotFoundException('Supplier not found');
      if (Number(supplier.version) !== dto.expected_version) {
        throw new ConflictException(`Supplier version conflict. Expected version ${dto.expected_version}, current version is ${supplier.version}`);
      }
      if (supplier.status === dto.target_status) throw new ConflictException(`Supplier is already ${dto.target_status}`);
      if (dto.target_status === 'DISABLED') {
        const activeOrders = await client.query<{ count: string }>(`
          SELECT count(*)::text AS count FROM purchase_orders
          WHERE tenant_id = $1 AND supplier_id = $2 AND status IN ('DRAFT','SUBMITTED','APPROVED')
        `, [tenantId, supplierId]);
        if (Number(activeOrders.rows[0]?.count ?? 0) > 0) {
          throw new ConflictException('Supplier cannot be disabled while it has open purchase orders');
        }
      }
      const result = await client.query<{ id: string; version: string }>(`
        UPDATE suppliers SET status = $1, updated_at = clock_timestamp(), version = version + 1
        WHERE id = $2 AND tenant_id = $3 AND version = $4
        RETURNING id::text AS id, version::text AS version
      `, [dto.target_status, supplierId, tenantId, supplier.version]);
      if (!result.rows[0]) throw new ConflictException('Supplier was changed concurrently');
      await this.insertOutbox(client, tenantId, null, 'SUPPLIER', supplierId, 'PROCUREMENT.SUPPLIER_STATUS_CHANGED', {
        supplier_id: supplierId, code: supplier.code, previous_status: supplier.status,
        status: dto.target_status, version: result.rows[0].version,
      });
      return { ...supplier, status: dto.target_status, version: result.rows[0].version };
    });
    return updated;
  }

  async createPurchaseOrder(
    userId: string, tenantId: string, factoryId: string, dto: CreatePurchaseOrderDto,
    rawIdempotencyKey: string | null, requestId: string | null, traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId'); this.validateUuid(tenantId, 'tenantId'); this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(dto.supplier_id, 'supplier_id');
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) throw new BadRequestException('At least one purchase-order line is required');
    const lineNumbers = dto.lines.map(line => line.line_number);
    if (new Set(lineNumbers).size !== lineNumbers.length) throw new BadRequestException('Duplicate line_number is not allowed');
    const poNumber = dto.po_number.trim().toUpperCase();
    if (!poNumber) throw new BadRequestException('po_number is required');
    const currency = (dto.currency ?? 'BDT').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('currency must be a 3-letter code');
    const orderDate = dto.order_date ? new Date(dto.order_date).toISOString().slice(0, 10) : null;
    const expectedDate = dto.expected_delivery_date ? new Date(dto.expected_delivery_date).toISOString().slice(0, 10) : null;
    if (expectedDate && orderDate && expectedDate < orderDate) throw new BadRequestException('expected_delivery_date cannot be before order_date');
    const lines = [...dto.lines].sort((a, b) => a.line_number - b.line_number).map(line => ({
      line_number: line.line_number,
      inventory_item_id: line.inventory_item_id ?? null,
      description: line.description.trim(),
      quantity: String(line.quantity),
      unit: line.unit.trim().toUpperCase(),
      unit_price: String(line.unit_price),
      notes: line.notes?.trim() ?? null,
    }));
    if (lines.some(line => !line.description || !line.unit)) throw new BadRequestException('Purchase-order line description and unit are required');
    const idempotencyKey = rawIdempotencyKey?.trim() || null;
    if (rawIdempotencyKey !== null && (!idempotencyKey || idempotencyKey.length > 255)) {
      throw new BadRequestException('Idempotency-Key must contain 1 to 255 characters');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      operation: 'PURCHASE_ORDER.CREATE', tenantId, factoryId, supplierId: dto.supplier_id,
      poNumber, orderDate, expectedDate, currency, paymentTermsDays: dto.payment_terms_days ?? 0,
      notes: dto.notes?.trim() ?? null, lines,
    })).digest('hex');

    let result: { id: string; replayed: boolean };
    try {
      result = await this.database.transaction({ tenantId, userId }, async client => {
        if (idempotencyKey) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${tenantId}:purchase-order:${idempotencyKey}`]);
          const prior = await client.query<{ id: string; request_hash: string }>(`
            SELECT id::text AS id, request_hash FROM purchase_orders
            WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE
          `, [tenantId, idempotencyKey]);
          if (prior.rows[0]) {
            if (prior.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was already used with a different purchase-order request');
            return { id: prior.rows[0].id, replayed: true };
          }
        }

        const factoryResult = await client.query<{ id: string }>(`
          SELECT id::text AS id FROM factories WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE' LIMIT 1
        `, [factoryId, tenantId]);
        if (!factoryResult.rows[0]) throw new ForbiddenException('Factory does not belong to tenant or is not active');
        const supplierResult = await client.query<{ id: string }>(`
          SELECT id::text AS id FROM suppliers WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE' FOR SHARE
        `, [dto.supplier_id, tenantId]);
        if (!supplierResult.rows[0]) throw new NotFoundException('Active supplier not found');

        const inserted = await client.query<{ id: string; version: string }>(`
          INSERT INTO purchase_orders (
            tenant_id, factory_id, supplier_id, po_number, order_date, expected_delivery_date,
            currency, payment_terms_days, notes, created_by_user_id, idempotency_key, request_hash
          ) VALUES ($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,$7,$8,$9,$10,$11,$12)
          RETURNING id::text AS id, version::text AS version
        `, [tenantId, factoryId, dto.supplier_id, poNumber, orderDate, expectedDate, currency,
          dto.payment_terms_days ?? 0, dto.notes?.trim() ?? null, userId, idempotencyKey, idempotencyKey ? requestHash : null]);
        const po = inserted.rows[0];
        if (!po) throw new Error('PURCHASE_ORDER_INSERT_FAILED');

        for (const line of lines) {
          await client.query(`
            INSERT INTO purchase_order_lines (
              tenant_id, factory_id, purchase_order_id, line_number, inventory_item_id,
              description, quantity, unit, unit_price, notes
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `, [tenantId, factoryId, po.id, line.line_number, line.inventory_item_id, line.description,
            line.quantity, line.unit, line.unit_price, line.notes]);
        }

        await client.query(`
          INSERT INTO purchase_order_status_history (
            tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason, request_id, trace_id
          ) VALUES ($1,$2,$3,NULL,'DRAFT',1,$4,'Purchase order created',$5,$6)
        `, [tenantId, factoryId, po.id, userId, this.uuidOrNull(requestId), this.uuidOrNull(traceId)]);
        await this.insertOutbox(client, tenantId, factoryId, 'PURCHASE_ORDER', po.id, 'PROCUREMENT.PURCHASE_ORDER_CREATED', {
          purchase_order_id: po.id, po_number: poNumber, supplier_id: dto.supplier_id,
          status: 'DRAFT', version: '1', line_count: lines.length, currency,
        });
        return { id: po.id, replayed: false };
      });
    } catch (error) {
      if (this.errorCode(error) === '23505') throw new ConflictException('Purchase-order number already exists in this factory, or the idempotency claim conflicted');
      if (this.errorCode(error) === '23503') throw new BadRequestException('Purchase order references a supplier, factory, or inventory item outside the authorized scope');
      throw error;
    }
    const po = await this.getPurchaseOrder(tenantId, factoryId, result.id);
    return { ...po, replayed: result.replayed };
  }

  async updateDraftPurchaseOrder(
    userId: string, tenantId: string, factoryId: string, purchaseOrderId: string,
    dto: UpdatePurchaseOrderDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(purchaseOrderId, 'purchaseOrderId');
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }

    const editableFields = [
      'order_date', 'expected_delivery_date', 'currency',
      'payment_terms_days', 'notes', 'lines',
    ] as const;
    const changedFields = editableFields.filter(field => dto[field] !== undefined);
    if (changedFields.length === 0) {
      throw new BadRequestException('At least one draft purchase-order field must be supplied');
    }

    let lines: Array<{
      line_number: number; inventory_item_id: string | null; description: string;
      quantity: string; unit: string; unit_price: string; notes: string | null;
    }> | null = null;
    if (dto.lines !== undefined) {
      if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
        throw new BadRequestException('A draft purchase order must contain at least one line');
      }
      const lineNumbers = dto.lines.map(line => line.line_number);
      if (new Set(lineNumbers).size !== lineNumbers.length) {
        throw new BadRequestException('Duplicate line_number is not allowed');
      }
      lines = [...dto.lines].sort((a, b) => a.line_number - b.line_number).map(line => ({
        line_number: line.line_number,
        inventory_item_id: line.inventory_item_id ?? null,
        description: line.description.trim(),
        quantity: String(line.quantity),
        unit: line.unit.trim().toUpperCase(),
        unit_price: String(line.unit_price),
        notes: line.notes?.trim() ?? null,
      }));
      if (lines.some(line => !line.description || !line.unit)) {
        throw new BadRequestException('Purchase-order line description and unit are required');
      }
      for (const line of lines) {
        if (line.inventory_item_id !== null) this.validateUuid(line.inventory_item_id, 'inventory_item_id');
      }
    }

    let nextCurrency: string | undefined;
    if (dto.currency !== undefined) {
      nextCurrency = dto.currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(nextCurrency)) throw new BadRequestException('currency must be a 3-letter code');
    }

    const updated = await this.database.transaction({ tenantId, userId }, async client => {
      const currentResult = await client.query<{
        id: string; po_number: string; status: PurchaseOrderStatus; version: string;
        order_date: string; expected_delivery_date: string | null;
        currency: string; payment_terms_days: number; notes: string | null;
      }>(`
        SELECT id::text AS id, po_number, status, version::text AS version,
          order_date::text AS order_date, expected_delivery_date::text AS expected_delivery_date,
          currency, payment_terms_days, notes
        FROM purchase_orders
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        FOR UPDATE
      `, [purchaseOrderId, tenantId, factoryId]);
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Purchase order not found');
      if (Number(current.version) !== dto.expected_version) {
        throw new ConflictException(`Purchase-order version conflict. Expected version ${dto.expected_version}, current version is ${current.version}`);
      }
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Only draft purchase orders can be edited');
      }

      const orderDate = dto.order_date === undefined
        ? current.order_date
        : new Date(dto.order_date).toISOString().slice(0, 10);
      const expectedDate = dto.expected_delivery_date === undefined
        ? current.expected_delivery_date
        : dto.expected_delivery_date === null
          ? null
          : new Date(dto.expected_delivery_date).toISOString().slice(0, 10);
      if (expectedDate && expectedDate < orderDate) {
        throw new BadRequestException('expected_delivery_date cannot be before order_date');
      }
      const currency = nextCurrency ?? current.currency;
      const paymentTermsDays = dto.payment_terms_days ?? current.payment_terms_days;
      const notes = dto.notes === undefined ? current.notes : (dto.notes?.trim() || null);

      const headerUpdate = await client.query<{ version: string }>(`
        UPDATE purchase_orders
        SET order_date = $1, expected_delivery_date = $2, currency = $3,
            payment_terms_days = $4, notes = $5,
            updated_at = clock_timestamp(), version = version + 1
        WHERE id = $6 AND tenant_id = $7 AND factory_id = $8
          AND status = 'DRAFT' AND version = $9
        RETURNING version::text AS version
      `, [orderDate, expectedDate, currency, paymentTermsDays, notes,
        purchaseOrderId, tenantId, factoryId, current.version]);
      const next = headerUpdate.rows[0];
      if (!next) throw new ConflictException('Purchase order changed while it was being edited');

      if (lines !== null) {
        await client.query(`
          DELETE FROM purchase_order_lines
          WHERE purchase_order_id = $1 AND tenant_id = $2 AND factory_id = $3
        `, [purchaseOrderId, tenantId, factoryId]);
        for (const line of lines) {
          await client.query(`
            INSERT INTO purchase_order_lines (
              tenant_id, factory_id, purchase_order_id, line_number, inventory_item_id,
              description, quantity, unit, unit_price, notes
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `, [tenantId, factoryId, purchaseOrderId, line.line_number, line.inventory_item_id,
            line.description, line.quantity, line.unit, line.unit_price, line.notes]);
        }
      }

      await client.query(`
        INSERT INTO purchase_order_status_history (
          tenant_id, factory_id, purchase_order_id, from_status, to_status, version,
          actor_user_id, reason, request_id, trace_id
        ) VALUES ($1,$2,$3,'DRAFT','DRAFT',$4,$5,$6,$7,$8)
      `, [tenantId, factoryId, purchaseOrderId, next.version, userId,
        `Draft purchase order updated: ${changedFields.join(', ')}`,
        this.uuidOrNull(requestId), this.uuidOrNull(traceId)]);
      await this.insertOutbox(client, tenantId, factoryId, 'PURCHASE_ORDER', purchaseOrderId,
        'PROCUREMENT.PURCHASE_ORDER_DRAFT_UPDATED', {
          purchase_order_id: purchaseOrderId, po_number: current.po_number,
          status: 'DRAFT', version: next.version, changed_fields: changedFields,
        });
      return { version: next.version, changed_fields: changedFields };
    }).catch(error => {
      if (this.errorCode(error) === '23505') throw new ConflictException('Purchase-order line numbers must be unique');
      if (this.errorCode(error) === '23503') throw new BadRequestException('Purchase order references an inventory item outside the authorized tenant/factory scope');
      throw error;
    });

    return { ...(await this.getPurchaseOrder(tenantId, factoryId, purchaseOrderId)), update: updated };
  }

  async listPurchaseOrders(tenantId: string, factoryId: string, dto: ListPurchaseOrdersDto) {
    this.validateUuid(tenantId, 'tenantId'); this.validateUuid(factoryId, 'factoryId');
    const page = dto.page ?? 1; const limit = dto.limit ?? 20; const search = dto.search?.trim() || null;
    const result = await this.database.query<PurchaseOrderHeader & { total_count: string }>(`
      SELECT po.id::text AS id, po.tenant_id::text AS tenant_id, po.factory_id::text AS factory_id,
        po.supplier_id::text AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
        po.po_number, po.status, po.order_date::text AS order_date,
        po.expected_delivery_date::text AS expected_delivery_date, po.currency, po.payment_terms_days,
        po.notes, po.created_by_user_id::text AS created_by_user_id,
        po.submitted_by_user_id::text AS submitted_by_user_id, po.submitted_at::text AS submitted_at,
        po.approved_by_user_id::text AS approved_by_user_id, po.approved_at::text AS approved_at,
        po.rejected_by_user_id::text AS rejected_by_user_id, po.rejected_at::text AS rejected_at,
        po.rejection_reason, po.cancelled_by_user_id::text AS cancelled_by_user_id,
        po.cancelled_at::text AS cancelled_at, po.cancellation_reason,
        po.created_at::text AS created_at, po.updated_at::text AS updated_at,
        po.version::text AS version, COALESCE(lines.total_amount, 0)::text AS total_amount,
        COALESCE(lines.line_count, 0)::text AS line_count, count(*) OVER()::text AS total_count
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
      LEFT JOIN LATERAL (
        SELECT sum(pol.line_amount) AS total_amount, count(*) AS line_count
        FROM purchase_order_lines pol
        WHERE pol.purchase_order_id = po.id AND pol.tenant_id = po.tenant_id AND pol.factory_id = po.factory_id
      ) lines ON true
      WHERE po.tenant_id = $1 AND po.factory_id = $2
        AND ($3::text IS NULL OR po.status = $3)
        AND ($4::text IS NULL OR po.po_number ILIKE $4 OR s.code ILIKE $4 OR s.name ILIKE $4)
      ORDER BY po.created_at DESC, po.id DESC LIMIT $5 OFFSET $6
    `, [tenantId, factoryId, dto.status ?? null, search ? '%' + search + '%' : null, limit, (page - 1) * limit], { tenantId });
    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return { items: result.rows.map(row => this.mapPurchaseOrderSummary(row)), pagination: {
      page, limit, total, total_pages: total === 0 ? 0 : Math.ceil(total / limit),
    }};
  }

  async getPurchaseOrder(tenantId: string, factoryId: string, purchaseOrderId: string) {
    this.validateUuid(tenantId, 'tenantId'); this.validateUuid(factoryId, 'factoryId'); this.validateUuid(purchaseOrderId, 'purchaseOrderId');
    const header = await this.database.query<PurchaseOrderHeader>(`
      SELECT po.id::text AS id, po.tenant_id::text AS tenant_id, po.factory_id::text AS factory_id,
        po.supplier_id::text AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
        po.po_number, po.status, po.order_date::text AS order_date,
        po.expected_delivery_date::text AS expected_delivery_date, po.currency, po.payment_terms_days,
        po.notes, po.created_by_user_id::text AS created_by_user_id,
        po.submitted_by_user_id::text AS submitted_by_user_id, po.submitted_at::text AS submitted_at,
        po.approved_by_user_id::text AS approved_by_user_id, po.approved_at::text AS approved_at,
        po.rejected_by_user_id::text AS rejected_by_user_id, po.rejected_at::text AS rejected_at,
        po.rejection_reason, po.cancelled_by_user_id::text AS cancelled_by_user_id,
        po.cancelled_at::text AS cancelled_at, po.cancellation_reason,
        po.created_at::text AS created_at, po.updated_at::text AS updated_at,
        po.version::text AS version, COALESCE(lines.total_amount, 0)::text AS total_amount,
        COALESCE(lines.line_count, 0)::text AS line_count
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
      LEFT JOIN LATERAL (
        SELECT sum(pol.line_amount) AS total_amount, count(*) AS line_count
        FROM purchase_order_lines pol
        WHERE pol.purchase_order_id = po.id AND pol.tenant_id = po.tenant_id AND pol.factory_id = po.factory_id
      ) lines ON true
      WHERE po.id = $1 AND po.tenant_id = $2 AND po.factory_id = $3 LIMIT 1
    `, [purchaseOrderId, tenantId, factoryId], { tenantId });
    const po = header.rows[0];
    if (!po) throw new NotFoundException('Purchase order not found');
    const [lineResult, historyResult] = await Promise.all([
      this.database.query<PurchaseOrderLine>(`
        SELECT id::text AS id, line_number, inventory_item_id::text AS inventory_item_id, description,
          quantity::text AS quantity, unit, unit_price::text AS unit_price, line_amount::text AS line_amount, notes
        FROM purchase_order_lines WHERE purchase_order_id = $1 AND tenant_id = $2 AND factory_id = $3
        ORDER BY line_number
      `, [purchaseOrderId, tenantId, factoryId], { tenantId }),
      this.database.query<PurchaseOrderHistory>(`
        SELECT id::text AS id, from_status, to_status, version::text AS version,
          actor_user_id::text AS actor_user_id, reason, request_id::text AS request_id,
          trace_id::text AS trace_id, created_at::text AS created_at
        FROM purchase_order_status_history
        WHERE purchase_order_id = $1 AND tenant_id = $2 AND factory_id = $3
        ORDER BY version, id
      `, [purchaseOrderId, tenantId, factoryId], { tenantId }),
    ]);
    return { ...this.mapPurchaseOrderSummary(po), submitted_by_user_id: po.submitted_by_user_id,
      submitted_at: po.submitted_at, approved_by_user_id: po.approved_by_user_id, approved_at: po.approved_at,
      rejected_by_user_id: po.rejected_by_user_id, rejected_at: po.rejected_at, rejection_reason: po.rejection_reason,
      cancelled_by_user_id: po.cancelled_by_user_id, cancelled_at: po.cancelled_at,
      cancellation_reason: po.cancellation_reason, lines: lineResult.rows, status_history: historyResult.rows };
  }

  async transitionPurchaseOrder(
    userId: string, tenantId: string, factoryId: string, purchaseOrderId: string,
    targetStatus: PurchaseOrderStatus, expectedVersion: number, reason: string | undefined,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateUuid(userId, 'userId'); this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId'); this.validateUuid(purchaseOrderId, 'purchaseOrderId');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }
    const normalizedReason = reason?.trim() || null;
    if ((targetStatus === 'REJECTED' || targetStatus === 'CANCELLED') && !normalizedReason) {
      throw new BadRequestException('A reason is required to reject or cancel a purchase order');
    }
    const updated = await this.database.transaction({ tenantId, userId }, async client => {
      const currentResult = await client.query<{
        id: string; factory_id: string; supplier_id: string; po_number: string;
        status: PurchaseOrderStatus; created_by_user_id: string; version: string;
      }>(`
        SELECT id::text AS id, factory_id::text AS factory_id, supplier_id::text AS supplier_id,
          po_number, status, created_by_user_id::text AS created_by_user_id, version::text AS version
        FROM purchase_orders WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE
      `, [purchaseOrderId, tenantId, factoryId]);
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Purchase order not found');
      if (expectedVersion !== Number(current.version)) {
        throw new ConflictException(`Purchase-order version conflict. Expected version ${expectedVersion}, current version is ${current.version}`);
      }
      if (current.status === targetStatus) throw new ConflictException(`Purchase order is already ${targetStatus}`);
      if (!canTransitionPurchaseOrder(current.status, targetStatus)) {
        throw new ConflictException(`Invalid purchase-order transition: ${current.status} -> ${targetStatus}`);
      }
      if (targetStatus === 'APPROVED' && current.created_by_user_id === userId) {
        throw new ForbiddenException('Purchase-order creator cannot approve their own purchase order');
      }
      const update = await client.query<{ version: string }>(`
        UPDATE purchase_orders SET status = $1, updated_at = clock_timestamp(), version = version + 1,
          submitted_by_user_id = CASE WHEN $1::text = 'SUBMITTED' THEN $2::uuid ELSE submitted_by_user_id END,
          submitted_at = CASE WHEN $1::text = 'SUBMITTED' THEN clock_timestamp() ELSE submitted_at END,
          approved_by_user_id = CASE WHEN $1::text = 'APPROVED' THEN $2::uuid ELSE approved_by_user_id END,
          approved_at = CASE WHEN $1::text = 'APPROVED' THEN clock_timestamp() ELSE approved_at END,
          rejected_by_user_id = CASE WHEN $1::text = 'REJECTED' THEN $2::uuid ELSE rejected_by_user_id END,
          rejected_at = CASE WHEN $1::text = 'REJECTED' THEN clock_timestamp() ELSE rejected_at END,
          rejection_reason = CASE WHEN $1::text = 'REJECTED' THEN $3::text ELSE rejection_reason END,
          cancelled_by_user_id = CASE WHEN $1::text = 'CANCELLED' THEN $2::uuid ELSE cancelled_by_user_id END,
          cancelled_at = CASE WHEN $1::text = 'CANCELLED' THEN clock_timestamp() ELSE cancelled_at END,
          cancellation_reason = CASE WHEN $1::text = 'CANCELLED' THEN $3::text ELSE cancellation_reason END
        WHERE id = $4 AND tenant_id = $5 AND factory_id = $6 AND version = $7
        RETURNING version::text AS version
      `, [targetStatus, userId, normalizedReason, purchaseOrderId, tenantId, factoryId, current.version]);
      if (!update.rows[0]) throw new ConflictException('Purchase order was changed concurrently');
      await client.query(`
        INSERT INTO purchase_order_status_history (
          tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason, request_id, trace_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [tenantId, factoryId, purchaseOrderId, current.status, targetStatus, update.rows[0].version,
        userId, normalizedReason, this.uuidOrNull(requestId), this.uuidOrNull(traceId)]);
      await this.insertOutbox(client, tenantId, factoryId, 'PURCHASE_ORDER', purchaseOrderId,
        'PROCUREMENT.PURCHASE_ORDER_STATUS_CHANGED', {
          purchase_order_id: purchaseOrderId, po_number: current.po_number, supplier_id: current.supplier_id,
          from_status: current.status, to_status: targetStatus, reason: normalizedReason, version: update.rows[0].version,
        });
      return { previousStatus: current.status, status: targetStatus, version: update.rows[0].version };
    });
    return { ...(await this.getPurchaseOrder(tenantId, factoryId, purchaseOrderId)), transition: updated };
  }

  private mapSupplier(row: SupplierRow) {
    return { id: row.id, tenant_id: row.tenant_id, code: row.code, name: row.name, status: row.status,
      country_code: row.country_code, email: row.email, phone: row.phone, tax_reference: row.tax_reference,
      payment_terms_days: row.payment_terms_days, currency: row.currency, address: row.address, notes: row.notes,
      created_by_user_id: row.created_by_user_id, created_at: row.created_at, updated_at: row.updated_at, version: row.version };
  }

  private mapPurchaseOrderSummary(row: PurchaseOrderHeader) {
    return { id: row.id, tenant_id: row.tenant_id, factory_id: row.factory_id, supplier_id: row.supplier_id,
      supplier_code: row.supplier_code, supplier_name: row.supplier_name, po_number: row.po_number, status: row.status,
      order_date: row.order_date, expected_delivery_date: row.expected_delivery_date, currency: row.currency,
      payment_terms_days: row.payment_terms_days, notes: row.notes, created_by_user_id: row.created_by_user_id,
      created_at: row.created_at, updated_at: row.updated_at, version: row.version,
      total_amount: row.total_amount, line_count: Number(row.line_count) };
  }

  private async insertOutbox(
    client: PoolClient, tenantId: string, factoryId: string | null, aggregateType: string, aggregateId: string,
    eventType: string, payload: Record<string, unknown>,
  ) {
    await client.query(`
      INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `, [tenantId, factoryId, aggregateType, aggregateId, eventType, JSON.stringify(payload)]);
  }

  private validateUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(`${field} must be a valid UUID`);
  }
  private uuidOrNull(value: string | null): string | null { return value && isUUID(value) ? value : null; }
  private errorCode(error: unknown): string | null {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
    return null;
  }
}
