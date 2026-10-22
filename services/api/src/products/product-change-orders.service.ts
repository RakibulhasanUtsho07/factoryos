import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateProductChangeOrderDto } from './dto/create-product-change-order.dto';
import { ProductChangeOrderActionDto } from './dto/product-change-order-action.dto';

export type ChangeOrderStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export type JsonObject = Record<string, unknown>;

export interface ChangeOrderRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  product_id: string;
  source_product_version_id: string | null;
  proposed_product_version_id: string;
  title: string;
  rationale: string;
  effective_date: string;
  status: ChangeOrderStatus;
  row_version: string;
  diff_snapshot: JsonObject;
  affected_order_count: number;
  idempotency_key: string;
  request_hash: string;
  submit_idempotency_key: string | null;
  submit_request_hash: string | null;
  approval_idempotency_key: string | null;
  approval_request_hash: string | null;
  resolution_idempotency_key: string | null;
  resolution_request_hash: string | null;
  created_by_user_id: string;
  submitted_by_user_id: string | null;
  reviewer_user_id: string | null;
  reviewed_at: string | null;
  submitted_at: string | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}

interface ProductVersionRow extends QueryResultRow {
  id: string;
  product_id: string;
  version_number: number;
  state: 'DRAFT' | 'APPROVED' | 'RETIRED';
  effective_from: string;
  effective_to: string | null;
  effective_to_override: string | null;
  expected_yield_percent: string;
  change_summary: string;
  row_version: string;
  created_by_user_id: string;
  approved_by_user_id: string | null;
}

export interface WorkOrderImpactRow extends QueryResultRow {
  id: string;
  work_order_number: string;
  product_version_id: string;
  status: string;
  planned_start_date: string;
  due_date: string;
  impact_type: string;
}

interface RevisionDiff {
  from_version_id: string | null;
  to_version_id: string;
  effective_date: string;
  specification: {
    before: { expected_yield_percent: string; change_summary: string } | null;
    after: { expected_yield_percent: string; change_summary: string };
    changed: boolean;
  };
  bom: { added: JsonObject[]; removed: JsonObject[]; changed: JsonObject[] };
  routing: { added: JsonObject[]; removed: JsonObject[]; changed: JsonObject[] };
  alternate_materials: { added: JsonObject[]; removed: JsonObject[]; changed: JsonObject[] };
  alternate_authorization: {
    complete: boolean;
    draft_count: number;
    contracts: JsonObject[];
  };
  summary: { bom_changes: number; routing_changes: number; alternate_changes: number };
}

const CHANGE_ORDER_COLS = `id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
  product_id::text AS product_id, source_product_version_id::text AS source_product_version_id,
  proposed_product_version_id::text AS proposed_product_version_id, title, rationale,
  effective_date::text AS effective_date, status, row_version::text AS row_version, diff_snapshot,
  affected_order_count, idempotency_key, request_hash, submit_idempotency_key, submit_request_hash,
  approval_idempotency_key, approval_request_hash, resolution_idempotency_key, resolution_request_hash,
  created_by_user_id::text AS created_by_user_id, submitted_by_user_id::text AS submitted_by_user_id,
  reviewer_user_id::text AS reviewer_user_id, reviewed_at::text AS reviewed_at,
  submitted_at::text AS submitted_at, review_comment,
  created_at::text AS created_at, updated_at::text AS updated_at`;

const VERSION_COLS = `id::text AS id, product_id::text AS product_id, version_number, state,
  effective_from::text AS effective_from, effective_to::text AS effective_to,
  effective_to_override::text AS effective_to_override,
  expected_yield_percent::text AS expected_yield_percent, change_summary,
  row_version::text AS row_version, created_by_user_id::text AS created_by_user_id,
  approved_by_user_id::text AS approved_by_user_id`;


export function diffProductRevisionRows(
  beforeRows: JsonObject[],
  afterRows: JsonObject[],
  key: string,
  groupKey?: (row: JsonObject) => string,
): { added: JsonObject[]; removed: JsonObject[]; changed: JsonObject[] } {
  const makeKey = (row: JsonObject) => (groupKey ? groupKey(row) + ':' : '') + String(row[key]);
  const before = new Map(beforeRows.map((row) => [makeKey(row), row]));
  const after = new Map(afterRows.map((row) => [makeKey(row), row]));
  const added: JsonObject[] = [];
  const removed: JsonObject[] = [];
  const changed: JsonObject[] = [];
  for (const [rowKey, afterRow] of after) {
    const beforeRow = before.get(rowKey);
    if (!beforeRow) {
      added.push({ key: rowKey, after: afterRow });
    } else if (JSON.stringify(beforeRow) !== JSON.stringify(afterRow)) {
      changed.push({ key: rowKey, before: beforeRow, after: afterRow });
    }
  }
  for (const [rowKey, beforeRow] of before) {
    if (!after.has(rowKey)) removed.push({ key: rowKey, before: beforeRow });
  }
  return { added, removed, changed };
}

@Injectable()
export class ProductChangeOrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(
    userId: string,
    tenantId: string,
    factoryId: string,
    productId: string,
    rawLimit = 50,
  ) {
    this.scope(userId, tenantId, factoryId, productId);
    const limit = this.limit(rawLimit);
    const result = await this.database.query<ChangeOrderRow>(
      'SELECT ' + CHANGE_ORDER_COLS + ' FROM product_change_orders ' +
        'WHERE product_id = $1 AND tenant_id = $2 AND factory_id = $3 ' +
        'ORDER BY created_at DESC, id DESC LIMIT $4',
      [productId.toLowerCase(), tenantId, factoryId, limit],
      { tenantId, userId },
    );
    return result.rows;
  }

  async detail(
    userId: string,
    tenantId: string,
    factoryId: string,
    productId: string,
    changeOrderId: string,
  ) {
    this.scope(userId, tenantId, factoryId, productId, changeOrderId);
    const co = await this.database.query<ChangeOrderRow>(
      'SELECT ' + CHANGE_ORDER_COLS + ' FROM product_change_orders ' +
        'WHERE id = $1 AND product_id = $2 AND tenant_id = $3 AND factory_id = $4',
      [changeOrderId.toLowerCase(), productId.toLowerCase(), tenantId, factoryId],
      { tenantId, userId },
    );
    if (!co.rows[0]) throw new NotFoundException('Engineering change order was not found in this factory');

    const [affected, events] = await Promise.all([
      this.database.query<WorkOrderImpactRow>(
        `SELECT a.work_order_id::text AS id, wo.work_order_number,
          a.pinned_product_version_id::text AS product_version_id, a.status_at_snapshot AS status,
          a.planned_start_date::text AS planned_start_date, a.due_date::text AS due_date,
          a.impact_type
        FROM product_change_order_affected_orders a
        JOIN work_orders wo ON wo.id = a.work_order_id
          AND wo.tenant_id = a.tenant_id AND wo.factory_id = a.factory_id
        WHERE a.change_order_id = $1 AND a.tenant_id = $2 AND a.factory_id = $3
        ORDER BY a.planned_start_date, wo.work_order_number, a.work_order_id`,
        [changeOrderId.toLowerCase(), tenantId, factoryId],
        { tenantId, userId },
      ),
      this.database.query<QueryResultRow>(
        `SELECT id::text AS id, event_type, from_status, to_status,
          actor_user_id::text AS actor_user_id, payload, created_at::text AS created_at
        FROM product_change_order_events
        WHERE change_order_id = $1 AND tenant_id = $2 AND factory_id = $3
        ORDER BY created_at, id`,
        [changeOrderId.toLowerCase(), tenantId, factoryId],
        { tenantId, userId },
      ),
    ]);
    return { ...co.rows[0], affected_orders: affected.rows, events: events.rows };
  }

  async create(
    userId: string,
    tenantId: string,
    factoryId: string,
    productId: string,
    dto: CreateProductChangeOrderDto,
    keyRaw: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.scope(userId, tenantId, factoryId, productId);
    const key = this.requiredKey(keyRaw);
    const product = productId.toLowerCase();
    const proposedVersionId = dto.proposed_version_id.toLowerCase();
    const effectiveDate = this.calendarDate(dto.effective_date, 'effective_date');
    const title = dto.title.trim();
    const rationale = dto.rationale.trim();
    if (title.length < 3 || title.length > 160) throw new BadRequestException('title must contain 3 to 160 characters');
    if (rationale.length < 10 || rationale.length > 4000) throw new BadRequestException('rationale must contain 10 to 4000 characters');

    const requestHash = this.hash({
      product_id: product,
      proposed_version_id: proposedVersionId,
      title,
      rationale,
      effective_date: effectiveDate,
    });
    const correlationId = this.correlationId(traceId, requestId);

    const result = await this.database.transaction({
      tenantId, userId, advisoryLockKey: `product-change-order:${tenantId}:${factoryId}:${key}`,
    }, async (client) => {
      const replay = await client.query<ChangeOrderRow>(
        'SELECT ' + CHANGE_ORDER_COLS + ' FROM product_change_orders ' +
          'WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3 FOR UPDATE',
        [tenantId, factoryId, key],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was already used for a different engineering change request');
        }
        return { id: replay.rows[0].id, replayed: true };
      }

      const productResult = await client.query<{ id: string; status: string }>(
        'SELECT id::text AS id, status FROM product_definitions ' +
          'WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
        [product, tenantId, factoryId],
      );
      if (!productResult.rows[0] || productResult.rows[0].status !== 'ACTIVE') {
        throw new NotFoundException('Active product definition was not found in this factory');
      }

      const proposedResult = await client.query<ProductVersionRow>(
        'SELECT ' + VERSION_COLS + ' FROM product_versions ' +
          'WHERE id = $1 AND product_id = $2 AND tenant_id = $3 AND factory_id = $4 FOR UPDATE',
        [proposedVersionId, product, tenantId, factoryId],
      );
      const proposed = proposedResult.rows[0];
      if (!proposed) throw new NotFoundException('Proposed product revision was not found in this factory');
      if (proposed.state !== 'DRAFT') throw new ConflictException('An ECO must reference a draft product revision');
      if (proposed.effective_from !== effectiveDate) {
        throw new ConflictException('ECO effective_date must exactly match the proposed revision effective_from date');
      }
      const dateCheck = await client.query<{ valid_date: boolean }>(
        'SELECT $1::date >= CURRENT_DATE AS valid_date',
        [effectiveDate],
      );
      if (!dateCheck.rows[0]?.valid_date) throw new BadRequestException('ECO effective_date cannot be backdated');

      const existingECO = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM product_change_orders
        WHERE proposed_product_version_id = $1 AND tenant_id = $2 AND factory_id = $3
          AND status IN ('DRAFT', 'SUBMITTED', 'APPROVED')
        LIMIT 1 FOR UPDATE`,
        [proposedVersionId, tenantId, factoryId],
      );
      if (existingECO.rows.length) {
        throw new ConflictException('An active ECO already exists for this proposed product revision');
      }

      const sourceResult = await client.query<{ id: string }>(
        `SELECT id::text AS id
        FROM product_versions
        WHERE product_id = $1 AND tenant_id = $2 AND factory_id = $3
          AND state IN ('APPROVED', 'RETIRED')
          AND effective_from <= ($4::date - 1)
          AND COALESCE(effective_to_override, effective_to, 'infinity'::date) >= ($4::date - 1)
        ORDER BY effective_from DESC, version_number DESC
        LIMIT 1 FOR UPDATE`,
        [product, tenantId, factoryId, effectiveDate],
      );
      const sourceId = sourceResult.rows[0]?.id ?? null;

      const insert = await client.query<{ id: string }>(
        `INSERT INTO product_change_orders (
          tenant_id, factory_id, product_id, source_product_version_id, proposed_product_version_id,
          title, rationale, effective_date, status, row_version, diff_snapshot, affected_order_count,
          idempotency_key, request_hash, created_by_user_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,'DRAFT',1,'{}'::jsonb,0,$9,$10,$11)
        RETURNING id::text AS id`,
        [tenantId, factoryId, product, sourceId, proposedVersionId, title, rationale, effectiveDate, key, requestHash, userId],
      );
      const id = insert.rows[0]?.id;
      if (!id) throw new Error('PRODUCT_CHANGE_ORDER_INSERT_FAILED');

      await this.appendEvent(client, {
        tenantId, factoryId, changeOrderId: id, type: 'CREATED', fromStatus: null, toStatus: 'DRAFT',
        userId, key: 'ECO:' + id + ':CREATED', requestHash,
        payload: { product_id: product, source_product_version_id: sourceId, proposed_product_version_id: proposedVersionId, effective_date: effectiveDate },
        correlationId, requestId, traceId,
      });
      return { id, replayed: false };
    });

    if (!result.replayed) {
      await this.auditSafe({
        tenantId, factoryId, userId, action: 'PRODUCT_ECO_CREATED', id: result.id, requestId, traceId,
        payload: { productId: product, proposedVersionId, effectiveDate },
      });
    }
    return this.detail(userId, tenantId, factoryId, product, result.id);
  }

  async submit(
    userId: string,
    tenantId: string,
    factoryId: string,
    productId: string,
    changeOrderId: string,
    dto: ProductChangeOrderActionDto,
    keyRaw: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateAction(userId, tenantId, factoryId, productId, changeOrderId, dto);
    const key = this.requiredKey(keyRaw);
    const p = productId.toLowerCase();
    const id = changeOrderId.toLowerCase();
    const requestHash = this.hash({ change_order_id: id, expected_version: dto.expected_version });
    const correlationId = this.correlationId(traceId, requestId);

    const result = await this.database.transaction({ tenantId, userId }, async (client) => {
      const product = await this.lockProduct(client, p, tenantId, factoryId);
      if (!product) throw new NotFoundException('Active product definition was not found in this factory');
      const row = await this.lockChangeOrder(client, id, p, tenantId, factoryId);
      if (!row) throw new NotFoundException('Engineering change order was not found in this factory');
      if (row.status === 'SUBMITTED' && row.submit_idempotency_key === key && row.submit_request_hash === requestHash) {
        return { id, replayed: true };
      }
      if (row.status !== 'DRAFT') throw new ConflictException('Only a draft ECO can be submitted');
      this.expectVersion(row.row_version, dto.expected_version);
      const proposedResult = await client.query<ProductVersionRow>(
        'SELECT ' + VERSION_COLS + ' FROM product_versions WHERE id = $1 AND product_id = $2 ' +
          'AND tenant_id = $3 AND factory_id = $4 FOR UPDATE',
        [row.proposed_product_version_id, p, tenantId, factoryId],
      );
      const proposed = proposedResult.rows[0];
      if (!proposed || proposed.state !== 'DRAFT') throw new ConflictException('The ECO proposed revision is no longer a draft');
      if (proposed.effective_from !== row.effective_date) throw new ConflictException('Proposed revision effective date changed; create a new ECO');
      const dateCheck = await client.query<{ valid_date: boolean }>(
        'SELECT $1::date >= CURRENT_DATE AS valid_date',
        [row.effective_date],
      );
      if (!dateCheck.rows[0]?.valid_date) throw new BadRequestException('ECO effective_date cannot be backdated');

      const draftAlternates = await client.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM product_bom_alternates
        WHERE product_version_id = $1 AND tenant_id = $2 AND factory_id = $3 AND status = 'DRAFT'
        ORDER BY id`,
        [row.proposed_product_version_id, tenantId, factoryId],
      );
      if (draftAlternates.rows.length) {
        throw new ConflictException('Authorize or retire every draft alternate-material contract before submitting the ECO');
      }

      const diff = await this.revisionDiff(client, tenantId, factoryId, p, row.source_product_version_id, row.proposed_product_version_id, row.effective_date);
      const impact = await this.replaceAffectedOrderSnapshot(client, row, tenantId, factoryId);
      const updated = await client.query<ChangeOrderRow>(
        'UPDATE product_change_orders SET status = \'SUBMITTED\', row_version = row_version + 1, ' +
          'diff_snapshot = $1::jsonb, affected_order_count = $2, submitted_by_user_id = $3, submitted_at = clock_timestamp(), ' +
          'submit_idempotency_key = $4, submit_request_hash = $5, updated_at = clock_timestamp() ' +
          'WHERE id = $6 AND tenant_id = $7 AND factory_id = $8 AND status = \'DRAFT\' AND row_version = $9 ' +
          'RETURNING ' + CHANGE_ORDER_COLS,
        [JSON.stringify(diff), impact.length, userId, key, requestHash, id, tenantId, factoryId, dto.expected_version],
      );
      const submitted = updated.rows[0];
      if (!submitted) throw new ConflictException('ECO changed concurrently; reload before submitting');
      await this.appendEvent(client, {
        tenantId, factoryId, changeOrderId: id, type: 'SUBMITTED', fromStatus: 'DRAFT', toStatus: 'SUBMITTED',
        userId, key: 'ECO:' + id + ':SUBMITTED:' + key, requestHash,
        payload: { proposed_product_version_id: row.proposed_product_version_id, effective_date: row.effective_date, affected_order_count: impact.length, diff_summary: diff.summary },
        correlationId, requestId, traceId,
      });
      return { id, replayed: false };
    });

    if (!result.replayed) {
      await this.auditSafe({ tenantId, factoryId, userId, action: 'PRODUCT_ECO_SUBMITTED', id, requestId, traceId, payload: { productId: p } });
    }
    return this.detail(userId, tenantId, factoryId, p, id);
  }

  async approve(
    userId: string,
    tenantId: string,
    factoryId: string,
    productId: string,
    changeOrderId: string,
    dto: ProductChangeOrderActionDto,
    keyRaw: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateAction(userId, tenantId, factoryId, productId, changeOrderId, dto);
    const key = this.requiredKey(keyRaw);
    const p = productId.toLowerCase();
    const id = changeOrderId.toLowerCase();
    const correlationId = this.correlationId(traceId, requestId);
    const ecoApprovalHash = this.hash({ change_order_id: id, expected_version: dto.expected_version, comment: dto.comment?.trim() ?? '' });

    const outcome = await this.database.transaction({ tenantId, userId }, async (client) => {
      const product = await this.lockProduct(client, p, tenantId, factoryId);
      if (!product) throw new NotFoundException('Active product definition was not found in this factory');
      const row = await this.lockChangeOrder(client, id, p, tenantId, factoryId);
      if (!row) throw new NotFoundException('Engineering change order was not found in this factory');
      if (row.status === 'APPROVED' && row.approval_idempotency_key === key && row.approval_request_hash === ecoApprovalHash) {
        return { id, replayed: true, versionId: row.proposed_product_version_id, supersededVersionId: row.source_product_version_id };
      }
      if (row.status !== 'SUBMITTED') throw new ConflictException('Only a submitted ECO can be approved');
      this.expectVersion(row.row_version, dto.expected_version);
      if (row.created_by_user_id === userId || row.submitted_by_user_id === userId) {
        throw new ConflictException('ECO approval requires a checker different from its creator and submitter');
      }

      const proposedResult = await client.query<ProductVersionRow>(
        'SELECT ' + VERSION_COLS + ' FROM product_versions WHERE id = $1 AND product_id = $2 ' +
          'AND tenant_id = $3 AND factory_id = $4 FOR UPDATE',
        [row.proposed_product_version_id, p, tenantId, factoryId],
      );
      const proposed = proposedResult.rows[0];
      if (!proposed || proposed.state !== 'DRAFT') throw new ConflictException('Proposed revision is no longer an approvable draft');
      if (proposed.created_by_user_id === userId) {
        throw new ConflictException('Product revision approval requires a checker different from its creator');
      }
      if (proposed.effective_from !== row.effective_date) throw new ConflictException('Proposed revision effective date no longer matches the ECO');

      const currentSource = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM product_versions
        WHERE product_id = $1 AND tenant_id = $2 AND factory_id = $3
          AND state IN ('APPROVED', 'RETIRED')
          AND effective_from <= ($4::date - 1)
          AND COALESCE(effective_to_override, effective_to, 'infinity'::date) >= ($4::date - 1)
        ORDER BY effective_from DESC, version_number DESC LIMIT 1 FOR UPDATE`,
        [p, tenantId, factoryId, row.effective_date],
      );
      const actualSourceId = currentSource.rows[0]?.id ?? null;
      if (actualSourceId !== row.source_product_version_id) {
        throw new ConflictException('The source revision changed after ECO submission; create a fresh ECO for the current baseline');
      }

      const draftAlternates = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM product_bom_alternates
        WHERE product_version_id = $1 AND tenant_id = $2 AND factory_id = $3 AND status = 'DRAFT'
        LIMIT 1`,
        [row.proposed_product_version_id, tenantId, factoryId],
      );
      if (draftAlternates.rows.length) throw new ConflictException('ECO cannot release a revision with unauthorized alternate-material contracts');

      const diff = await this.revisionDiff(client, tenantId, factoryId, p, row.source_product_version_id, row.proposed_product_version_id, row.effective_date);
      const submittedImpact = await this.readAffectedOrderSnapshot(client, row, tenantId, factoryId);
      const currentImpact = await this.listCurrentAffectedOrders(
        client, row, tenantId, factoryId,
      );
      if (!this.sameAffectedOrderSnapshot(submittedImpact, currentImpact)) {
        throw new ConflictException(
          'Open work-order impact changed after ECO submission; reject this ECO and submit a new one to refresh the immutable impact snapshot',
        );
      }
      const impact = submittedImpact;

      const futureOverlap = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM product_versions
        WHERE product_id = $1 AND tenant_id = $2 AND factory_id = $3 AND state = 'APPROVED' AND id <> $4
          AND effective_from >= $5::date
          AND effective_from <= COALESCE($6::date, 'infinity'::date)
          AND COALESCE(effective_to_override, effective_to, 'infinity'::date) >= $5::date
        ORDER BY effective_from LIMIT 1 FOR UPDATE`,
        [p, tenantId, factoryId, proposed.id, proposed.effective_from, proposed.effective_to],
      );
      if (futureOverlap.rows.length) {
        throw new ConflictException('A later-starting approved revision overlaps this ECO; reconcile that future revision first');
      }

      const priorResult = await client.query<ProductVersionRow>(
        'SELECT ' + VERSION_COLS + ' FROM product_versions ' +
          'WHERE product_id = $1 AND tenant_id = $2 AND factory_id = $3 AND state = \'APPROVED\' AND id <> $4 ' +
          'AND effective_from < $5::date AND effective_from <= COALESCE($6::date, \'infinity\'::date) ' +
          'AND COALESCE(effective_to_override, effective_to, \'infinity\'::date) >= $5::date ' +
          'ORDER BY effective_from FOR UPDATE',
        [p, tenantId, factoryId, proposed.id, proposed.effective_from, proposed.effective_to],
      );
      if (priorResult.rows.length > 1) throw new ConflictException('Multiple approved revisions overlap the ECO effective window');
      const prior = priorResult.rows[0];
      if (prior && prior.id !== row.source_product_version_id) {
        throw new ConflictException('The overlapping approved revision differs from the ECO source baseline');
      }

      const versionApprovalKey = 'eco:' + id + ':' + key;
      const versionApprovalHash = this.hash({
        product_id: p,
        product_version_id: proposed.id,
        expected_version: Number(proposed.row_version),
        change_order_id: id,
        change_order_expected_version: dto.expected_version,
      });
      if (prior) {
        const cutoff = this.previousDay(proposed.effective_from);
        const retirementKey = 'system:superseded:' + proposed.id;
        const retirementHash = this.hash({
          product_id: p,
          retired_version_id: prior.id,
          superseded_by_version_id: proposed.id,
          effective_to_override: cutoff,
        });
        const retired = await client.query<{ id: string; row_version: string }>(
          `UPDATE product_versions SET state = 'RETIRED', row_version = row_version + 1,
            updated_by_user_id = $1, updated_at = clock_timestamp(), retirement_idempotency_key = $2,
            retirement_request_hash = $3, effective_to_override = $4::date, superseded_by_version_id = $5
          WHERE id = $6 AND product_id = $7 AND tenant_id = $8 AND factory_id = $9
            AND state = 'APPROVED' AND row_version = $10
          RETURNING id::text AS id, row_version::text AS row_version`,
          [userId, retirementKey, retirementHash, cutoff, proposed.id, prior.id, p, tenantId, factoryId, prior.row_version],
        );
        if (!retired.rows[0]) throw new ConflictException('The previous revision changed concurrently; reload before approving the ECO');
        await this.outbox(client, {
          tenantId, factoryId, aggregateId: prior.id, eventType: 'PRODUCT.VERSION_SUPERSEDED', correlationId, requestId, userId,
          payload: { product_id: p, product_version_id: prior.id, superseded_by_version_id: proposed.id, effective_to_override: cutoff, row_version: retired.rows[0].row_version },
        });
      }

      await client.query('SELECT set_config(\'app.product_change_order_id\', $1, TRUE)', [id]);
      const approved = await client.query<{ id: string; version_number: number; row_version: string }>(
        `UPDATE product_versions SET state = 'APPROVED', row_version = row_version + 1,
          updated_by_user_id = $1, updated_at = clock_timestamp(), approved_by_user_id = $1,
          approved_at = clock_timestamp(), approval_idempotency_key = $2, approval_request_hash = $3
        WHERE id = $4 AND product_id = $5 AND tenant_id = $6 AND factory_id = $7
          AND state = 'DRAFT' AND row_version = $8
        RETURNING id::text AS id, version_number, row_version::text AS row_version`,
        [userId, versionApprovalKey, versionApprovalHash, proposed.id, p, tenantId, factoryId, proposed.row_version],
      );
      if (!approved.rows[0]) throw new ConflictException('Proposed product revision changed concurrently; reload before approving the ECO');

      const updated = await client.query<ChangeOrderRow>(
        `UPDATE product_change_orders SET status = 'APPROVED', row_version = row_version + 1,
          diff_snapshot = $1::jsonb, affected_order_count = $2, reviewer_user_id = $3,
          reviewed_at = clock_timestamp(), review_comment = NULLIF($4, ''),
          approval_idempotency_key = $5, approval_request_hash = $6, updated_at = clock_timestamp()
        WHERE id = $7 AND tenant_id = $8 AND factory_id = $9 AND status = 'SUBMITTED' AND row_version = $10
        RETURNING ` + CHANGE_ORDER_COLS,
        [JSON.stringify(diff), impact.length, userId, dto.comment?.trim() ?? '', key, ecoApprovalHash, id, tenantId, factoryId, dto.expected_version],
      );
      if (!updated.rows[0]) throw new ConflictException('ECO changed concurrently; the revision release was rolled back');
      await this.appendEvent(client, {
        tenantId, factoryId, changeOrderId: id, type: 'APPROVED', fromStatus: 'SUBMITTED', toStatus: 'APPROVED',
        userId, key: 'ECO:' + id + ':APPROVED:' + key, requestHash: ecoApprovalHash,
        payload: { product_id: p, source_product_version_id: row.source_product_version_id, proposed_product_version_id: proposed.id, effective_date: row.effective_date, affected_order_count: impact.length, diff_summary: diff.summary, approved_revision_row_version: approved.rows[0].row_version },
        correlationId, requestId, traceId,
      });
      await this.outbox(client, {
        tenantId, factoryId, aggregateId: proposed.id, eventType: 'PRODUCT.VERSION_APPROVED', correlationId, requestId, userId,
        payload: { product_id: p, product_version_id: proposed.id, version_number: approved.rows[0].version_number, effective_from: proposed.effective_from, effective_to: proposed.effective_to, row_version: approved.rows[0].row_version, approved_via_change_order_id: id, superseded_version_id: prior?.id ?? null },
      });
      return { id, replayed: false, versionId: proposed.id, supersededVersionId: prior?.id ?? null };
    });

    if (!outcome.replayed) {
      await this.auditSafe({
        tenantId, factoryId, userId, action: 'PRODUCT_ECO_APPROVED', id, requestId, traceId,
        payload: { productId: p, proposedVersionId: outcome.versionId, supersededVersionId: outcome.supersededVersionId },
      });
    }
    return this.detail(userId, tenantId, factoryId, p, id);
  }

  async reject(
    userId: string,
    tenantId: string,
    factoryId: string,
    productId: string,
    changeOrderId: string,
    dto: ProductChangeOrderActionDto,
    keyRaw: string | null,
    requestId: string | null,
    traceId: string | null,
  ) {
    this.validateAction(userId, tenantId, factoryId, productId, changeOrderId, dto);
    const key = this.requiredKey(keyRaw);
    const p = productId.toLowerCase();
    const id = changeOrderId.toLowerCase();
    const comment = dto.comment?.trim() ?? '';
    if (!comment) throw new BadRequestException('A rejection comment is required');
    const requestHash = this.hash({ change_order_id: id, expected_version: dto.expected_version, comment });
    const correlationId = this.correlationId(traceId, requestId);

    const outcome = await this.database.transaction({ tenantId, userId }, async (client) => {
      const product = await this.lockProduct(client, p, tenantId, factoryId);
      if (!product) throw new NotFoundException('Active product definition was not found in this factory');
      const row = await this.lockChangeOrder(client, id, p, tenantId, factoryId);
      if (!row) throw new NotFoundException('Engineering change order was not found in this factory');
      if (row.status === 'REJECTED' && row.resolution_idempotency_key === key && row.resolution_request_hash === requestHash) {
        return { id, replayed: true };
      }
      if (row.status !== 'SUBMITTED') throw new ConflictException('Only a submitted ECO can be rejected');
      this.expectVersion(row.row_version, dto.expected_version);
      if (row.created_by_user_id === userId || row.submitted_by_user_id === userId) {
        throw new ConflictException('ECO rejection requires a checker different from its creator and submitter');
      }
      const updated = await client.query<ChangeOrderRow>(
        `UPDATE product_change_orders SET status = 'REJECTED', row_version = row_version + 1,
          reviewer_user_id = $1, reviewed_at = clock_timestamp(), review_comment = $2,
          resolution_idempotency_key = $3, resolution_request_hash = $4, updated_at = clock_timestamp()
        WHERE id = $5 AND tenant_id = $6 AND factory_id = $7 AND status = 'SUBMITTED' AND row_version = $8
        RETURNING ` + CHANGE_ORDER_COLS,
        [userId, comment, key, requestHash, id, tenantId, factoryId, dto.expected_version],
      );
      if (!updated.rows[0]) throw new ConflictException('ECO changed concurrently; reload before rejecting');
      await this.appendEvent(client, {
        tenantId, factoryId, changeOrderId: id, type: 'REJECTED', fromStatus: 'SUBMITTED', toStatus: 'REJECTED',
        userId, key: 'ECO:' + id + ':REJECTED:' + key, requestHash,
        payload: { product_id: p, proposed_product_version_id: row.proposed_product_version_id, effective_date: row.effective_date, reason: comment },
        correlationId, requestId, traceId,
      });
      return { id, replayed: false };
    });

    if (!outcome.replayed) {
      await this.auditSafe({ tenantId, factoryId, userId, action: 'PRODUCT_ECO_REJECTED', id, requestId, traceId, payload: { productId: p, reason: comment } });
    }
    return this.detail(userId, tenantId, factoryId, p, id);
  }

  private async lockProduct(client: PoolClient, productId: string, tenantId: string, factoryId: string) {
    const result = await client.query<{ id: string; status: string }>(
      'SELECT id::text AS id, status FROM product_definitions WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 FOR UPDATE',
      [productId, tenantId, factoryId],
    );
    return result.rows[0]?.status === 'ACTIVE' ? result.rows[0] : null;
  }

  private async lockChangeOrder(client: PoolClient, changeOrderId: string, productId: string, tenantId: string, factoryId: string) {
    const result = await client.query<ChangeOrderRow>(
      'SELECT ' + CHANGE_ORDER_COLS + ' FROM product_change_orders ' +
        'WHERE id = $1 AND product_id = $2 AND tenant_id = $3 AND factory_id = $4 FOR UPDATE',
      [changeOrderId, productId, tenantId, factoryId],
    );
    return result.rows[0] ?? null;
  }

  private async revisionDiff(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    productId: string,
    sourceVersionId: string | null,
    proposedVersionId: string,
    effectiveDate: string,
  ): Promise<RevisionDiff> {
    const readBom = async (versionId: string | null): Promise<JsonObject[]> => {
      if (!versionId) return [];
      const result = await client.query<{ rows: JsonObject[] }>(
        `SELECT COALESCE(jsonb_agg(
          to_jsonb(b) - ARRAY['id','tenant_id','factory_id','product_id','product_version_id','created_by_user_id','created_at']
          ORDER BY b.line_number), '[]'::jsonb) AS rows
        FROM product_bom_lines b
        WHERE b.product_version_id = $1 AND b.product_id = $2 AND b.tenant_id = $3 AND b.factory_id = $4`,
        [versionId, productId, tenantId, factoryId],
      );
      return result.rows[0]?.rows ?? [];
    };
    const readRouting = async (versionId: string | null): Promise<JsonObject[]> => {
      if (!versionId) return [];
      const result = await client.query<{ rows: JsonObject[] }>(
        `SELECT COALESCE(jsonb_agg(
          to_jsonb(r) - ARRAY['id','tenant_id','factory_id','product_id','product_version_id','created_by_user_id','created_at']
          ORDER BY r.step_number), '[]'::jsonb) AS rows
        FROM product_routing_steps r
        WHERE r.product_version_id = $1 AND r.product_id = $2 AND r.tenant_id = $3 AND r.factory_id = $4`,
        [versionId, productId, tenantId, factoryId],
      );
      return result.rows[0]?.rows ?? [];
    };
    const readAlternates = async (versionId: string | null): Promise<JsonObject[]> => {
      if (!versionId) return [];
      const result = await client.query<{ rows: JsonObject[] }>(
        `SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'line_number', b.line_number,
            'alternate_item_id', a.alternate_item_id::text,
            'conversion_factor', a.conversion_factor::text,
            'unit', a.unit,
            'rationale', a.rationale,
            'status', a.status,
            'approved_by_user_id', a.approved_by_user_id::text,
            'approved_at', a.approved_at::text,
            'inventory_base_unit', a.inventory_base_unit,
            'inventory_quantity_per_component', a.inventory_quantity_per_component::text,
            'uom_conversion_rule_id', a.uom_conversion_rule_id::text,
            'uom_conversion_rule_version', a.uom_conversion_rule_version,
            'uom_factor_numerator', a.uom_factor_numerator::text,
            'uom_factor_denominator', a.uom_factor_denominator::text,
            'uom_rounding_mode', a.uom_rounding_mode
          ) ORDER BY b.line_number, a.alternate_item_id), '[]'::jsonb) AS rows
        FROM product_bom_alternates a
        JOIN product_bom_lines b ON b.id = a.bom_line_id
          AND b.product_version_id = a.product_version_id AND b.tenant_id = a.tenant_id AND b.factory_id = a.factory_id
        WHERE a.product_version_id = $1 AND a.product_id = $2 AND a.tenant_id = $3 AND a.factory_id = $4`,
        [versionId, productId, tenantId, factoryId],
      );
      return result.rows[0]?.rows ?? [];
    };

    const [sourceMetaResult, proposedMetaResult, sourceBom, proposedBom, sourceRouting, proposedRouting, sourceAlternates, proposedAlternates, authorization] = await Promise.all([
      sourceVersionId
        ? client.query<{ expected_yield_percent: string; change_summary: string }>(
            'SELECT expected_yield_percent::text AS expected_yield_percent, change_summary FROM product_versions WHERE id = $1 AND tenant_id = $2 AND factory_id = $3',
            [sourceVersionId, tenantId, factoryId],
          )
        : Promise.resolve({ rows: [] as { expected_yield_percent: string; change_summary: string }[] }),
      client.query<{ expected_yield_percent: string; change_summary: string }>(
        'SELECT expected_yield_percent::text AS expected_yield_percent, change_summary FROM product_versions WHERE id = $1 AND tenant_id = $2 AND factory_id = $3',
        [proposedVersionId, tenantId, factoryId],
      ),
      readBom(sourceVersionId), readBom(proposedVersionId),
      readRouting(sourceVersionId), readRouting(proposedVersionId),
      readAlternates(sourceVersionId), readAlternates(proposedVersionId),
      client.query<{ draft_count: number; contracts: JsonObject[] }>(
        `SELECT count(*) FILTER (WHERE status = 'DRAFT')::int AS draft_count,
          COALESCE(jsonb_agg(jsonb_build_object(
            'bom_line_id', bom_line_id::text, 'alternate_item_id', alternate_item_id::text,
            'status', status, 'approved_by_user_id', approved_by_user_id::text, 'approved_at', approved_at::text
          ) ORDER BY bom_line_id, alternate_item_id), '[]'::jsonb) AS contracts
        FROM product_bom_alternates
        WHERE product_version_id = $1 AND product_id = $2 AND tenant_id = $3 AND factory_id = $4`,
        [proposedVersionId, productId, tenantId, factoryId],
      ),
    ]);

    const beforeSpec = sourceMetaResult.rows[0] ?? null;
    const afterSpec = proposedMetaResult.rows[0];
    if (!afterSpec) throw new NotFoundException('Proposed revision specification was not found');
    const bom = this.diffRows(sourceBom, proposedBom, 'line_number');
    const routing = this.diffRows(sourceRouting, proposedRouting, 'step_number');
    const alternateMaterials = this.diffRows(sourceAlternates, proposedAlternates, 'alternate_item_id', (row) => String(row.line_number));
    const auth = authorization.rows[0] ?? { draft_count: 0, contracts: [] };
    return {
      from_version_id: sourceVersionId,
      to_version_id: proposedVersionId,
      effective_date: effectiveDate,
      specification: {
        before: beforeSpec,
        after: afterSpec,
        changed: !beforeSpec || beforeSpec.expected_yield_percent !== afterSpec.expected_yield_percent || beforeSpec.change_summary !== afterSpec.change_summary,
      },
      bom,
      routing,
      alternate_materials: alternateMaterials,
      alternate_authorization: {
        complete: Number(auth.draft_count) === 0,
        draft_count: Number(auth.draft_count),
        contracts: auth.contracts ?? [],
      },
      summary: {
        bom_changes: bom.added.length + bom.removed.length + bom.changed.length,
        routing_changes: routing.added.length + routing.removed.length + routing.changed.length,
        alternate_changes: alternateMaterials.added.length + alternateMaterials.removed.length + alternateMaterials.changed.length,
      },
    };
  }

  private diffRows(
    beforeRows: JsonObject[],
    afterRows: JsonObject[],
    key: string,
    groupKey?: (row: JsonObject) => string,
  ): { added: JsonObject[]; removed: JsonObject[]; changed: JsonObject[] } {
    return diffProductRevisionRows(beforeRows, afterRows, key, groupKey);
  }

  private async readAffectedOrderSnapshot(
    client: PoolClient,
    row: ChangeOrderRow,
    tenantId: string,
    factoryId: string,
  ): Promise<WorkOrderImpactRow[]> {
    const result = await client.query<WorkOrderImpactRow>(
      `SELECT a.work_order_id::text AS id, wo.work_order_number,
        a.pinned_product_version_id::text AS product_version_id, a.status_at_snapshot AS status,
        a.planned_start_date::text AS planned_start_date, a.due_date::text AS due_date,
        a.impact_type
      FROM product_change_order_affected_orders a
      JOIN work_orders wo ON wo.id = a.work_order_id
        AND wo.tenant_id = a.tenant_id AND wo.factory_id = a.factory_id
      WHERE a.change_order_id = $1 AND a.tenant_id = $2 AND a.factory_id = $3
      ORDER BY a.planned_start_date, wo.work_order_number, a.work_order_id`,
      [row.id, tenantId, factoryId],
    );
    return result.rows;
  }

  private async listCurrentAffectedOrders(
    client: PoolClient,
    row: ChangeOrderRow,
    tenantId: string,
    factoryId: string,
  ): Promise<WorkOrderImpactRow[]> {
    const result = await client.query<WorkOrderImpactRow>(
      `SELECT wo.id::text AS id, wo.work_order_number,
        wo.product_version_id::text AS product_version_id, wo.status,
        wo.planned_start_date::text AS planned_start_date, wo.due_date::text AS due_date,
        CASE WHEN wo.planned_start_date >= $4::date
          THEN 'REVISION_REVIEW_BEFORE_START' ELSE 'SNAPSHOT_CROSSES_EFFECTIVE_DATE' END AS impact_type
      FROM work_orders wo
      WHERE wo.product_id = $1 AND wo.tenant_id = $2 AND wo.factory_id = $3
        AND wo.status IN ('DRAFT','RELEASED','IN_PROGRESS','ON_HOLD')
        AND wo.product_version_id IS DISTINCT FROM $5
        AND (wo.planned_start_date >= $4::date OR wo.due_date >= $4::date)
      ORDER BY wo.planned_start_date, wo.work_order_number, wo.id
      FOR UPDATE OF wo`,
      [row.product_id, tenantId, factoryId, row.effective_date, row.proposed_product_version_id],
    );
    return result.rows;
  }

  private sameAffectedOrderSnapshot(
    submitted: WorkOrderImpactRow[],
    current: WorkOrderImpactRow[],
  ): boolean {
    const canonical = (rows: WorkOrderImpactRow[]) => rows.map((row) => ({
      id: row.id,
      product_version_id: row.product_version_id,
      status: row.status,
      planned_start_date: row.planned_start_date,
      due_date: row.due_date,
      impact_type: row.impact_type,
    }));
    return JSON.stringify(canonical(submitted)) === JSON.stringify(canonical(current));
  }

  private async replaceAffectedOrderSnapshot(
    client: PoolClient,
    row: ChangeOrderRow,
    tenantId: string,
    factoryId: string,
  ): Promise<WorkOrderImpactRow[]> {
    await client.query(
      'DELETE FROM product_change_order_affected_orders WHERE change_order_id = $1 AND tenant_id = $2 AND factory_id = $3',
      [row.id, tenantId, factoryId],
    );
    const inserted = await client.query<WorkOrderImpactRow>(
      `INSERT INTO product_change_order_affected_orders (
        tenant_id, factory_id, change_order_id, work_order_id, product_id, pinned_product_version_id,
        status_at_snapshot, planned_start_date, due_date, impact_type
      )
      SELECT wo.tenant_id, wo.factory_id, $1, wo.id, wo.product_id, wo.product_version_id,
        wo.status, wo.planned_start_date, wo.due_date,
        CASE WHEN wo.planned_start_date >= $4::date
          THEN 'REVISION_REVIEW_BEFORE_START' ELSE 'SNAPSHOT_CROSSES_EFFECTIVE_DATE' END
      FROM work_orders wo
      WHERE wo.product_id = $2 AND wo.tenant_id = $3 AND wo.factory_id = $5
        AND wo.status IN ('DRAFT','RELEASED','IN_PROGRESS','ON_HOLD')
        AND wo.product_version_id IS DISTINCT FROM $6
        AND (wo.planned_start_date >= $4::date OR wo.due_date >= $4::date)
      ORDER BY wo.planned_start_date, wo.work_order_number, wo.id
      FOR UPDATE OF wo
      RETURNING work_order_id::text AS id, status_at_snapshot AS status,
        pinned_product_version_id::text AS product_version_id,
        planned_start_date::text AS planned_start_date, due_date::text AS due_date, impact_type`,
      [row.id, row.product_id, tenantId, row.effective_date, factoryId, row.proposed_product_version_id],
    );
    return inserted.rows;
  }

  private async appendEvent(
    client: PoolClient,
    input: {
      tenantId: string; factoryId: string; changeOrderId: string; type: string;
      fromStatus: string | null; toStatus: string; userId: string; key: string;
      requestHash: string; payload: JsonObject; correlationId: string;
      requestId: string | null; traceId: string | null;
    },
  ) {
    await client.query(
      `INSERT INTO product_change_order_events (
        tenant_id, factory_id, change_order_id, event_type, from_status, to_status,
        actor_user_id, idempotency_key, request_hash, payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [input.tenantId, input.factoryId, input.changeOrderId, input.type, input.fromStatus, input.toStatus,
        input.userId, input.key, input.requestHash, JSON.stringify(input.payload)],
    );
    await this.outbox(client, {
      tenantId: input.tenantId, factoryId: input.factoryId, aggregateId: input.changeOrderId,
      eventType: 'PLM.ECO_' + input.type, correlationId: input.correlationId,
      requestId: input.requestId, userId: input.userId,
      payload: { change_order_id: input.changeOrderId, event_type: input.type, from_status: input.fromStatus, to_status: input.toStatus, ...input.payload },
    });
  }

  private async outbox(
    client: PoolClient,
    input: {
      tenantId: string; factoryId: string; aggregateId: string; eventType: string;
      correlationId: string; requestId: string | null; userId: string; payload: JsonObject;
    },
  ) {
    await client.query(
      `INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version,
        occurred_at, correlation_id, causation_id, actor, source, payload
      ) VALUES (
        $1, $2, 'PRODUCT_CHANGE_ORDER', $3, $4, 1, clock_timestamp(), $5::uuid, $6::uuid,
        $7::jsonb, $8::jsonb, $9::jsonb
      )`,
      [
        input.tenantId, input.factoryId, input.aggregateId, input.eventType,
        input.correlationId, this.validUuid(input.requestId),
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'product-change-orders-service', version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0' }),
        JSON.stringify(input.payload),
      ],
    );
  }

  private async auditSafe(input: {
    tenantId: string; factoryId: string; userId: string; action: string;
    id: string; requestId: string | null; traceId: string | null; payload: JsonObject;
  }) {
    try {
      await this.audit.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.userId,
        eventType: 'PLM', action: input.action, resourceType: 'PRODUCT_CHANGE_ORDER',
        resourceId: input.id, requestId: this.validUuid(input.requestId),
        correlationId: this.validUuid(input.traceId) ?? this.validUuid(input.requestId),
        dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // The immutable ECO event and transactional outbox retain the lifecycle evidence.
    }
  }

  private validateAction(userId: string, tenantId: string, factoryId: string, productId: string, changeOrderId: string, dto: ProductChangeOrderActionDto) {
    this.scope(userId, tenantId, factoryId, productId, changeOrderId);
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }
  }

  private scope(userId: string, tenantId: string, factoryId: string, productId?: string, changeOrderId?: string) {
    for (const [name, value] of [['userId', userId], ['tenantId', tenantId], ['factoryId', factoryId], ['productId', productId], ['changeOrderId', changeOrderId]] as const) {
      if (value !== undefined && !isUUID(value)) throw new BadRequestException(name + ' must be a valid UUID');
    }
  }

  private expectVersion(actual: string | number, expected: number) {
    if (Number(actual) !== expected) throw new ConflictException('Stale ECO row version; reload before changing its lifecycle');
  }

  private requiredKey(value: string | null) {
    const key = value?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key header is required');
    if (key.length > 150) throw new BadRequestException('Idempotency-Key must not exceed 150 characters for ECO commands');
    return key;
  }

  private calendarDate(value: string, field: string) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) throw new BadRequestException(field + ' must use YYYY-MM-DD format');
    const parsed = new Date(value + 'T00:00:00.000Z');
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(field + ' must be a valid calendar date');
    }
    return value;
  }

  private previousDay(value: string) {
    const date = new Date(value + 'T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  private correlationId(traceId: string | null, requestId: string | null) {
    return this.validUuid(traceId) ?? this.validUuid(requestId) ?? randomUUID();
  }

  private validUuid(value: string | null): string | null {
    return value && isUUID(value) ? value : null;
  }

  private hash(value: JsonObject) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private limit(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new BadRequestException('limit must be an integer between 1 and 100');
    return value;
  }
}
