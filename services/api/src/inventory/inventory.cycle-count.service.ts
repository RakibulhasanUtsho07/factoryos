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
import {
  InventoryStockReconciliationService,
  type InventoryStockReconciliationResult,
} from './inventory.stock-reconciliation.service';

export type InventoryCycleCountStatus = 'PENDING_REVIEW' | 'REJECTED' | 'APPLIED';

interface CycleCountProposalRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  item_id: string;
  counted_quantity: string;
  status: InventoryCycleCountStatus;
  idempotency_key: string;
  request_hash: string;
  notes: string | null;
  created_by_user_id: string;
  created_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_decision: 'APPROVE' | 'REJECT' | null;
  review_idempotency_key: string | null;
  review_request_hash: string | null;
  review_note: string | null;
  reconciliation_id: string | null;
}

export type InventoryCycleCountProposal = Omit<
  CycleCountProposalRow,
  'idempotency_key' | 'request_hash' | 'review_idempotency_key' | 'review_request_hash'
>;

export type InventoryCycleCountSubmitResult = InventoryCycleCountProposal & {
  replayed: boolean;
};

export type InventoryCycleCountRejectResult = InventoryCycleCountProposal & {
  replayed: boolean;
};

const CYCLE_COUNT_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  factory_id::text AS factory_id,
  item_id::text AS item_id,
  counted_quantity::text AS counted_quantity,
  status,
  idempotency_key,
  request_hash,
  notes,
  created_by_user_id::text AS created_by_user_id,
  created_at::text AS created_at,
  reviewed_by_user_id::text AS reviewed_by_user_id,
  reviewed_at::text AS reviewed_at,
  review_decision,
  review_idempotency_key,
  review_request_hash,
  review_note,
  reconciliation_id::text AS reconciliation_id
`;

@Injectable()
export class InventoryCycleCountService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
    private readonly reconciliationService: InventoryStockReconciliationService,
  ) {}

  async submitCycleCount(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    dto: { counted_quantity: number; notes?: string },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountSubmitResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const countedQuantity = this.normalizeQuantity(dto.counted_quantity);
    const notes = dto.notes?.trim() || null;
    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const normalizedItemId = itemId.toLowerCase();
    const requestHash = this.hash({
      itemId: normalizedItemId,
      countedQuantity,
      reasonCode: 'CYCLE_COUNT',
      notes,
    });

    let result: InventoryCycleCountSubmitResult;
    try {
      result = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          const existing = await this.findBySubmitKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (existing) return this.replaySubmitOrConflict(existing, requestHash);

          const item = await client.query<{ status: 'ACTIVE' | 'DISABLED' }>(
            `
            SELECT status
            FROM inventory_items
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
            `,
            [normalizedItemId, tenantId, factoryId],
          );
          if (!item.rows[0]) {
            throw new NotFoundException('Inventory item not found in this factory');
          }
          if (item.rows[0].status !== 'ACTIVE') {
            throw new ConflictException('Disabled inventory items cannot be cycle counted');
          }

          // The item-row lock provides the same serialization point used by
          // receipts/issues without changing stock during count submission.
          const duplicateAfterLock = await this.findBySubmitKey(
            client, tenantId, factoryId, idempotencyKey,
          );
          if (duplicateAfterLock) {
            return this.replaySubmitOrConflict(duplicateAfterLock, requestHash);
          }

          const inserted = await client.query<CycleCountProposalRow>(
            `
            INSERT INTO inventory_cycle_count_proposals (
              tenant_id, factory_id, item_id, counted_quantity, status,
              idempotency_key, request_hash, notes, created_by_user_id
            )
            VALUES ($1, $2, $3, $4::numeric, 'PENDING_REVIEW', $5, $6, $7, $8)
            RETURNING ${CYCLE_COUNT_COLUMNS}
            `,
            [
              tenantId,
              factoryId,
              normalizedItemId,
              countedQuantity,
              idempotencyKey,
              requestHash,
              notes,
              userId,
            ],
          );
          const proposal = inserted.rows[0];
          if (!proposal) throw new Error('INVENTORY_CYCLE_COUNT_SUBMISSION_FAILED');

          await this.insertOutboxEvent(client, {
            tenantId,
            factoryId,
            aggregateId: proposal.id,
            correlationId: this.correlationId(requestId, traceId),
            userId,
            eventType: 'INVENTORY.CYCLE_COUNT_SUBMITTED',
            payload: {
              cycle_count: {
                id: proposal.id,
                item_id: proposal.item_id,
                counted_quantity: proposal.counted_quantity,
                status: proposal.status,
              },
            },
          });
          return this.toSubmitResult(proposal, false);
        },
      );
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;
      const stored = await this.database.query<CycleCountProposalRow>(
        `
        SELECT ${CYCLE_COUNT_COLUMNS}
        FROM inventory_cycle_count_proposals
        WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
        LIMIT 1
        `,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) {
        throw new ConflictException('Cycle-count request conflicts with an existing record');
      }
      result = this.replaySubmitOrConflict(stored.rows[0], requestHash);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId,
        requestId, traceId, resourceId: result.id,
        action: 'CYCLE_COUNT_SUBMIT',
        payload: {
          item_id: result.item_id,
          counted_quantity: result.counted_quantity,
          status: result.status,
        },
      });
    }
    return result;
  }

  async listCycleCounts(
    tenantId: string,
    factoryId: string,
    itemId: string,
    options: { status?: string; limit?: number } = {},
  ): Promise<InventoryCycleCountProposal[]> {
    this.validateReadScope(tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const status = options.status?.trim().toUpperCase() || null;
    if (status && !['PENDING_REVIEW', 'REJECTED', 'APPLIED'].includes(status)) {
      throw new BadRequestException('status must be PENDING_REVIEW, REJECTED or APPLIED');
    }

    const result = await this.database.query<CycleCountProposalRow>(
      `
      SELECT ${CYCLE_COUNT_COLUMNS}
      FROM inventory_cycle_count_proposals
      WHERE tenant_id = $1
        AND factory_id = $2
        AND item_id = $3
        AND ($4::text IS NULL OR status = $4)
      ORDER BY created_at DESC, id DESC
      LIMIT $5
      `,
      [tenantId, factoryId, itemId, status, limit],
      { tenantId },
    );
    return result.rows.map((row) => this.toProposal(row));
  }

  async approveCycleCount(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    proposalId: string,
    dto: { review_note?: string },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryStockReconciliationResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    this.validateUuid(proposalId, 'proposalId');
    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const reviewNote = dto.review_note?.trim() || null;
    const reviewRequestHash = this.hash({
      proposalId: proposalId.toLowerCase(),
      decision: 'APPROVE',
      reviewNote,
    });

    const proposal = await this.getProposal(
      userId, tenantId, factoryId, itemId, proposalId,
    );
    if (proposal.created_by_user_id === userId) {
      throw new ConflictException('The user who submitted a cycle count cannot approve it');
    }
    if (proposal.status === 'REJECTED') {
      throw new ConflictException('A rejected cycle count cannot be approved');
    }
    if (proposal.status === 'APPLIED') {
      // Delegate to the reconciliation idempotency path, which only permits
      // a replay by the same reviewer with the same review fingerprint.
      return this.reconciliationService.recordReconciliation(
        userId, tenantId, factoryId, itemId,
        {
          counted_quantity: Number(proposal.counted_quantity),
          reason_code: 'CYCLE_COUNT',
          notes: proposal.notes ?? undefined,
        },
        this.reconciliationKey(proposal.id),
        requestId,
        traceId,
        {
          proposalId: proposal.id,
          decisionIdempotencyKey: idempotencyKey,
          reviewRequestHash,
          reviewNote,
        },
      );
    }

    const result = await this.reconciliationService.recordReconciliation(
      userId, tenantId, factoryId, itemId,
      {
        counted_quantity: Number(proposal.counted_quantity),
        reason_code: 'CYCLE_COUNT',
        notes: proposal.notes ?? undefined,
      },
      this.reconciliationKey(proposal.id),
      requestId,
      traceId,
      {
        proposalId: proposal.id,
        decisionIdempotencyKey: idempotencyKey,
        reviewRequestHash,
        reviewNote,
      },
    );
    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId,
        requestId, traceId, resourceId: proposal.id,
        action: 'CYCLE_COUNT_APPROVE',
        payload: {
          item_id: itemId,
          reconciliation_id: result.id,
          counted_quantity: result.counted_quantity,
          quantity_delta: result.quantity_delta,
          review_note: reviewNote,
        },
      });
    }
    return result;
  }

  async rejectCycleCount(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    proposalId: string,
    dto: { review_note?: string },
    rawIdempotencyKey: string | null,
    requestId: string | null,
    traceId: string | null,
  ): Promise<InventoryCycleCountRejectResult> {
    this.validateScope(userId, tenantId, factoryId);
    this.validateUuid(itemId, 'itemId');
    this.validateUuid(proposalId, 'proposalId');
    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    const reviewNote = dto.review_note?.trim() || null;
    if (!reviewNote) {
      throw new BadRequestException('review_note is required when rejecting a cycle count');
    }
    const reviewRequestHash = this.hash({
      proposalId: proposalId.toLowerCase(),
      decision: 'REJECT',
      reviewNote,
    });

    let result: InventoryCycleCountRejectResult;
    try {
      result = await this.database.transaction(
        { tenantId, userId },
        async (client) => {
          const proposalResult = await client.query<CycleCountProposalRow>(
            `
            SELECT ${CYCLE_COUNT_COLUMNS}
            FROM inventory_cycle_count_proposals
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND item_id = $4
            FOR UPDATE
            `,
            [proposalId, tenantId, factoryId, itemId],
          );
          const proposal = proposalResult.rows[0];
          if (!proposal) throw new NotFoundException('Cycle-count proposal not found in this factory');
          if (proposal.created_by_user_id === userId) {
            throw new ConflictException('The user who submitted a cycle count cannot reject it');
          }

          if (proposal.status === 'REJECTED') {
            if (
              proposal.reviewed_by_user_id === userId
              && proposal.review_idempotency_key === idempotencyKey
              && proposal.review_request_hash === reviewRequestHash
            ) {
              return this.toRejectResult(proposal, true);
            }
            throw new ConflictException('Cycle count already has a review decision');
          }
          if (proposal.status !== 'PENDING_REVIEW') {
            throw new ConflictException('An applied cycle count cannot be rejected');
          }

          const updated = await client.query<CycleCountProposalRow>(
            `
            UPDATE inventory_cycle_count_proposals
            SET status = 'REJECTED',
                reviewed_by_user_id = $1,
                reviewed_at = clock_timestamp(),
                review_decision = 'REJECT',
                review_idempotency_key = $2,
                review_request_hash = $3,
                review_note = $4
            WHERE id = $5 AND tenant_id = $6 AND factory_id = $7
              AND status = 'PENDING_REVIEW'
              AND created_by_user_id <> $1
            RETURNING ${CYCLE_COUNT_COLUMNS}
            `,
            [
              userId, idempotencyKey, reviewRequestHash, reviewNote,
              proposalId, tenantId, factoryId,
            ],
          );
          const reviewed = updated.rows[0];
          if (!reviewed) {
            throw new ConflictException('Cycle-count review could not be completed');
          }

          await this.insertOutboxEvent(client, {
            tenantId,
            factoryId,
            aggregateId: reviewed.id,
            correlationId: this.correlationId(requestId, traceId),
            userId,
            eventType: 'INVENTORY.CYCLE_COUNT_REJECTED',
            payload: {
              cycle_count: {
                id: reviewed.id,
                item_id: reviewed.item_id,
                status: reviewed.status,
                review_note: reviewNote,
              },
            },
          });
          return this.toRejectResult(reviewed, false);
        },
      );
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;
      const stored = await this.database.query<CycleCountProposalRow>(
        `
        SELECT ${CYCLE_COUNT_COLUMNS}
        FROM inventory_cycle_count_proposals
        WHERE tenant_id = $1 AND factory_id = $2 AND review_idempotency_key = $3
        LIMIT 1
        `,
        [tenantId, factoryId, idempotencyKey],
        { tenantId, userId },
      );
      if (!stored.rows[0]) {
        throw new ConflictException('Cycle-count review conflicts with another decision');
      }
      const proposal = stored.rows[0];
      if (
        proposal.review_request_hash !== reviewRequestHash
        || proposal.reviewed_by_user_id !== userId
      ) {
        throw new ConflictException('Idempotency-Key was reused for a different cycle-count decision');
      }
      result = this.toRejectResult(proposal, true);
    }

    if (!result.replayed) {
      await this.recordAuditSafely({
        tenantId, factoryId, userId,
        requestId, traceId, resourceId: result.id,
        action: 'CYCLE_COUNT_REJECT',
        payload: { item_id: itemId, review_note: reviewNote, status: result.status },
      });
    }
    return result;
  }

  private async getProposal(
    userId: string,
    tenantId: string,
    factoryId: string,
    itemId: string,
    proposalId: string,
  ): Promise<CycleCountProposalRow> {
    const result = await this.database.query<CycleCountProposalRow>(
      `
      SELECT ${CYCLE_COUNT_COLUMNS}
      FROM inventory_cycle_count_proposals
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 AND item_id = $4
      LIMIT 1
      `,
      [proposalId, tenantId, factoryId, itemId],
      { tenantId, userId },
    );
    const proposal = result.rows[0];
    if (!proposal) throw new NotFoundException('Cycle-count proposal not found in this factory');
    return proposal;
  }

  private async findBySubmitKey(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    key: string,
  ): Promise<CycleCountProposalRow | null> {
    const result = await client.query<CycleCountProposalRow>(
      `
      SELECT ${CYCLE_COUNT_COLUMNS}
      FROM inventory_cycle_count_proposals
      WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, key],
    );
    return result.rows[0] ?? null;
  }

  private replaySubmitOrConflict(
    row: CycleCountProposalRow,
    requestHash: string,
  ): InventoryCycleCountSubmitResult {
    if (row.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was reused for a different cycle-count submission');
    }
    return this.toSubmitResult(row, true);
  }

  private toSubmitResult(
    row: CycleCountProposalRow,
    replayed: boolean,
  ): InventoryCycleCountSubmitResult {
    return { ...this.toProposal(row), replayed };
  }

  private toRejectResult(
    row: CycleCountProposalRow,
    replayed: boolean,
  ): InventoryCycleCountRejectResult {
    return { ...this.toProposal(row), replayed };
  }

  private toProposal(row: CycleCountProposalRow): InventoryCycleCountProposal {
    const {
      idempotency_key,
      request_hash,
      review_idempotency_key,
      review_request_hash,
      ...proposal
    } = row;
    void idempotency_key;
    void request_hash;
    void review_idempotency_key;
    void review_request_hash;
    return proposal;
  }

  private async insertOutboxEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      factoryId: string;
      aggregateId: string;
      correlationId: string;
      userId: string;
      eventType: 'INVENTORY.CYCLE_COUNT_SUBMITTED' | 'INVENTORY.CYCLE_COUNT_REJECTED';
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id,
        event_type, event_version, occurred_at, correlation_id, causation_id,
        actor, source, payload
      )
      VALUES (
        $1, $2, 'INVENTORY_CYCLE_COUNT', $3, $4, 1,
        clock_timestamp(), $5::uuid, NULL, $6::jsonb, $7::jsonb, $8::jsonb
      )
      `,
      [
        input.tenantId,
        input.factoryId,
        input.aggregateId,
        input.eventType,
        input.correlationId,
        JSON.stringify({ type: 'user', id: input.userId }),
        JSON.stringify({
          system: 'FactoryOS',
          connector: 'inventory-cycle-count',
          version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
        }),
        JSON.stringify(input.payload),
      ],
    );
  }

  private async recordAuditSafely(input: {
    tenantId: string;
    factoryId: string;
    userId: string;
    requestId: string | null;
    traceId: string | null;
    resourceId: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.userId,
        eventType: 'INVENTORY',
        action: input.action,
        resourceType: 'INVENTORY_CYCLE_COUNT',
        resourceId: input.resourceId,
        requestId: input.requestId && isUUID(input.requestId) ? input.requestId : null,
        correlationId: input.traceId && isUUID(input.traceId) ? input.traceId : null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Transactional outbox carries durable workflow evidence.
    }
  }

  private normalizeQuantity(value: number): string {
    if (
      !Number.isFinite(value)
      || value < 0
      || value > 99999999999999
    ) {
      throw new BadRequestException('counted_quantity must be between 0 and 99999999999999');
    }
    if (Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001) {
      throw new BadRequestException('counted_quantity supports at most 4 decimal places');
    }
    return value.toFixed(4);
  }

  private requiredIdempotencyKey(rawKey: string | null): string {
    const key = rawKey?.trim() ?? '';
    if (!key) throw new BadRequestException('Idempotency-Key is required for cycle-count operations');
    if (key.length > 255) throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    return key;
  }

  private reconciliationKey(proposalId: string): string {
    return 'cycle-count-approval:' + proposalId;
  }

  private hash(value: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private correlationId(requestId: string | null, traceId: string | null): string {
    if (traceId && isUUID(traceId)) return traceId;
    if (requestId && isUUID(requestId)) return requestId;
    return randomUUID();
  }

  private validateScope(userId: string, tenantId: string, factoryId: string): void {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }

  private validateReadScope(tenantId: string, factoryId: string): void {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }

  private errorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
}
