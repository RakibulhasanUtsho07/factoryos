import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { DatabaseService } from '../database/database.service';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { CreateRfidReadBatchDto, OfflineStockTransactionDto, SyncOfflineBatchDto } from './dto/wms-mobile.dto';
import { InventoryService } from './inventory.service';

type OfflineReceiptRow = QueryResultRow & {
  id: string;
  device_id: string;
  client_transaction_id: string;
  operation: string;
  result_status: 'APPLIED' | 'CONFLICT' | 'REJECTED';
  request_hash: string;
  result: Record<string, unknown>;
  created_at: string;
};

type OfflineReceiptPersistenceResult = OfflineReceiptRow & { replayed: boolean; idempotencyConflict?: boolean };

type RfidBatchRow = QueryResultRow & {
  id: string;
  reader_id: string;
  session_id: string;
  item_id: string;
  location_id: string;
  expected_quantity: string;
  observed_quantity: string;
  variance_quantity: string;
  duplicate_reads_suppressed: number;
  matched_tag_count: number;
  excluded_tag_count: number;
  reconciliation_status: 'MATCHED' | 'VARIANCE';
  created_at: string;
};

type RfidObservation = {
  epc: string;
  traceability_unit_id: string | null;
  observed_quantity: string;
  duplicate_read_count: number;
  disposition: 'MATCHED' | 'UNKNOWN_TAG' | 'WRONG_ITEM' | 'NOT_PRESENT' | 'INELIGIBLE';
};

@Injectable()
export class WmsMobileService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventoryService: InventoryService,
  ) {}

  async syncOfflineBatch(
    userId: string, tenantId: string, factoryId: string,
    dto: SyncOfflineBatchDto, requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const deviceId = this.requiredDeviceId(dto.device_id);
    if (!Array.isArray(dto.transactions) || dto.transactions.length < 1 || dto.transactions.length > 100) {
      throw new BadRequestException('transactions must contain between 1 and 100 queued operations');
    }

    const results = [];
    for (const transaction of dto.transactions) {
      results.push(await this.syncOneOfflineTransaction(
        userId, tenantId, factoryId, deviceId, transaction, requestId, traceId,
      ));
    }
    return {
      device_id: deviceId,
      received_count: results.length,
      applied_count: results.filter((x) => x.status === 'APPLIED').length,
      conflict_count: results.filter((x) => x.status === 'CONFLICT').length,
      rejected_count: results.filter((x) => x.status === 'REJECTED').length,
      results,
    };
  }

  async ingestRfidReadBatch(
    userId: string, tenantId: string, factoryId: string,
    dto: CreateRfidReadBatchDto, rawIdempotencyKey: string | null,
    requestId: string | null, traceId: string | null,
  ) {
    this.validateScope(userId, tenantId, factoryId);
    const readerId = this.requiredUuid(dto.reader_id, 'reader_id');
    const sessionId = this.requiredUuid(dto.session_id, 'session_id');
    const itemId = this.requiredUuid(dto.item_id, 'item_id');
    const locationId = this.requiredUuid(dto.location_id, 'location_id');
    const idempotencyKey = this.requiredIdempotencyKey(rawIdempotencyKey);
    if (!Array.isArray(dto.reads) || dto.reads.length < 1 || dto.reads.length > 1000) {
      throw new BadRequestException('reads must contain between 1 and 1000 RFID observations');
    }

    const readCounts = new Map<string, number>();
    for (const rawEpc of dto.reads) {
      const epc = String(rawEpc ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9._:-]{1,128}$/.test(epc)) {
        throw new BadRequestException('RFID EPCs must contain 1-128 letters, digits, dot, underscore, colon or hyphen');
      }
      readCounts.set(epc, (readCounts.get(epc) ?? 0) + 1);
    }
    const uniqueReads = [...readCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([epc, count]) => ({ epc, duplicate_read_count: count - 1 }));
    const duplicateReadsSuppressed = dto.reads.length - uniqueReads.length;
    const requestHash = this.hash({
      reader_id: readerId, session_id: sessionId, item_id: itemId,
      location_id: locationId, reads: uniqueReads,
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
            [tenantId + ':' + factoryId + ':rfid-read:' + idempotencyKey],
          );
          const existing = await client.query<RfidBatchRow & { request_hash: string }>(`
            SELECT id::text AS id, reader_id::text AS reader_id, session_id::text AS session_id,
              item_id::text AS item_id, location_id::text AS location_id,
              expected_quantity::text AS expected_quantity, observed_quantity::text AS observed_quantity,
              variance_quantity::text AS variance_quantity, duplicate_reads_suppressed,
              matched_tag_count, excluded_tag_count, reconciliation_status,
              request_hash, created_at::text AS created_at
            FROM rfid_read_batches
            WHERE tenant_id = $1 AND factory_id = $2 AND idempotency_key = $3
            FOR UPDATE
          `, [tenantId, factoryId, idempotencyKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash.trim() !== requestHash) {
              throw new ConflictException('Idempotency-Key was already used for a different RFID read batch');
            }
            return this.loadRfidBatch(client, tenantId, factoryId, existing.rows[0].id, true);
          }

          const item = await client.query<{ status: string }>(`
            SELECT status FROM inventory_items
            WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
            FOR UPDATE
          `, [itemId, tenantId, factoryId]);
          if (!item.rows[0] || item.rows[0].status !== 'ACTIVE') {
            throw new ConflictException('RFID reconciliation requires an active inventory item in this factory');
          }
          const location = await client.query<{ expected_quantity: string }>(`
            SELECT lb.quantity_on_hand::text AS expected_quantity
            FROM inventory_location_balances lb
            JOIN inventory_locations l
              ON l.id = lb.location_id AND l.tenant_id = lb.tenant_id AND l.factory_id = lb.factory_id
            WHERE lb.tenant_id = $1 AND lb.factory_id = $2 AND lb.item_id = $3
              AND lb.location_id = $4 AND l.status = 'ACTIVE'
            FOR UPDATE OF lb, l
          `, [tenantId, factoryId, itemId, locationId]);
          const balance = location.rows[0];
          if (!balance) throw new ConflictException('RFID reconciliation requires an active bin balance for this item');

          let observedUnits = 0n;
          let matchedTagCount = 0;
          let excludedTagCount = 0;
          const observations: RfidObservation[] = [];
          for (const read of uniqueReads) {
            const found = await client.query<{
              id: string; inventory_item_id: string | null; status: string; expired: boolean;
              attributes: Record<string, unknown>; quantity_on_hand: string;
            }>(`
              SELECT u.id::text AS id, u.inventory_item_id::text AS inventory_item_id,
                u.status, (u.expires_at IS NOT NULL AND u.expires_at < CURRENT_DATE) AS expired,
                u.attributes, COALESCE(tlb.quantity_on_hand, 0)::text AS quantity_on_hand
              FROM traceability_units u
              LEFT JOIN inventory_traceability_location_balances tlb
                ON tlb.traceability_unit_id = u.id AND tlb.tenant_id = u.tenant_id
               AND tlb.factory_id = u.factory_id AND tlb.item_id = u.inventory_item_id
               AND tlb.location_id = $4
              WHERE u.tenant_id = $1 AND u.factory_id = $2 AND upper(u.rfid_epc) = $3
              LIMIT 1
              FOR SHARE OF u
            `, [tenantId, factoryId, read.epc, locationId]);
            const unit = found.rows[0];
            let disposition: RfidObservation['disposition'] = 'MATCHED';
            let quantity = '0.0000';
            if (!unit) {
              disposition = 'UNKNOWN_TAG';
            } else if (unit.inventory_item_id?.toLowerCase() !== itemId) {
              disposition = 'WRONG_ITEM';
            } else {
              const attrs = unit.attributes ?? {};
              const condition = String(attrs.condition ?? '').trim().toUpperCase();
              const ineligible = unit.status !== 'ACTIVE' || unit.expired
                || attrs.damaged === true || attrs.held === true || attrs.quarantined === true
                || ['DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED', 'RECALLED'].includes(condition);
              const quantityUnits = this.decimalToUnits(unit.quantity_on_hand);
              if (ineligible) {
                disposition = 'INELIGIBLE';
              } else if (quantityUnits <= 0n) {
                disposition = 'NOT_PRESENT';
              } else {
                quantity = this.unitsToDecimal(quantityUnits);
                observedUnits += quantityUnits;
                matchedTagCount += 1;
              }
            }
            if (disposition !== 'MATCHED') excludedTagCount += 1;
            observations.push({
              epc: read.epc,
              traceability_unit_id: unit?.id ?? null,
              observed_quantity: quantity,
              duplicate_read_count: read.duplicate_read_count,
              disposition,
            });
          }

          const expectedUnits = this.decimalToUnits(balance.expected_quantity);
          const varianceUnits = observedUnits - expectedUnits;
          const observedQuantity = this.unitsToDecimal(observedUnits);
          const varianceQuantity = this.unitsToDecimal(varianceUnits);
          const reconciliationStatus = varianceUnits === 0n ? 'MATCHED' : 'VARIANCE';
          const inserted = await client.query<RfidBatchRow>(`
            INSERT INTO rfid_read_batches (
              tenant_id, factory_id, reader_id, session_id, item_id, location_id,
              expected_quantity, observed_quantity, variance_quantity,
              duplicate_reads_suppressed, matched_tag_count, excluded_tag_count,
              reconciliation_status, idempotency_key, request_hash, created_by_user_id, correlation_id
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10,$11,$12,$13,$14,$15,$16,$17::uuid
            )
            RETURNING id::text AS id, reader_id::text AS reader_id, session_id::text AS session_id,
              item_id::text AS item_id, location_id::text AS location_id,
              expected_quantity::text AS expected_quantity, observed_quantity::text AS observed_quantity,
              variance_quantity::text AS variance_quantity, duplicate_reads_suppressed,
              matched_tag_count, excluded_tag_count, reconciliation_status, created_at::text AS created_at
          `, [
            tenantId, factoryId, readerId, sessionId, itemId, locationId,
            balance.expected_quantity, observedQuantity, varianceQuantity,
            duplicateReadsSuppressed, matchedTagCount, excludedTagCount,
            reconciliationStatus, idempotencyKey, requestHash, userId, correlationId,
          ]);
          const batch = inserted.rows[0];
          if (!batch) throw new Error('RFID_READ_BATCH_INSERT_FAILED');

          for (const observation of observations) {
            await client.query(`
              INSERT INTO rfid_read_observations (
                tenant_id, factory_id, batch_id, epc, traceability_unit_id,
                observed_quantity, duplicate_read_count, disposition, created_by_user_id, correlation_id
              ) VALUES ($1,$2,$3,$4,$5::uuid,$6::numeric,$7,$8,$9,$10::uuid)
            `, [
              tenantId, factoryId, batch.id, observation.epc, observation.traceability_unit_id,
              observation.observed_quantity, observation.duplicate_read_count, observation.disposition,
              userId, correlationId,
            ]);
          }

          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1,$2,'RFID_READ_BATCH',$3,'INVENTORY.RFID_RECONCILED',$4::jsonb)
          `, [tenantId, factoryId, batch.id, JSON.stringify({
            batch_id: batch.id, reader_id: readerId, session_id: sessionId,
            item_id: itemId, location_id: locationId,
            expected_quantity: balance.expected_quantity, observed_quantity: observedQuantity,
            variance_quantity: varianceQuantity, reconciliation_status: reconciliationStatus,
            duplicate_reads_suppressed: duplicateReadsSuppressed,
            matched_tag_count: matchedTagCount, excluded_tag_count: excludedTagCount,
          })]);
          await this.insertAudit(client, {
            tenantId, factoryId, userId, resourceType: 'RFID_READ_BATCH', resourceId: batch.id,
            action: 'RFID_RECONCILED', correlationId, requestId: requestUuid,
            payload: {
              item_id: itemId, location_id: locationId,
              expected_quantity: balance.expected_quantity, observed_quantity: observedQuantity,
              variance_quantity: varianceQuantity, reconciliation_status: reconciliationStatus,
              duplicate_reads_suppressed: duplicateReadsSuppressed,
            },
          });
          return { ...batch, duplicate_reads_suppressed: duplicateReadsSuppressed, observations, replayed: false };
        },
      );
    } catch (error) {
      const code = this.errorCode(error);
      if (code === '23505') {
        throw new ConflictException('RFID read session or idempotency key has already been used');
      }
      throw error;
    }
  }

  private async syncOneOfflineTransaction(
    userId: string, tenantId: string, factoryId: string, deviceId: string,
    tx: OfflineStockTransactionDto, requestId: string | null, traceId: string | null,
  ) {
    // Serialize concurrent deliveries of one device transaction ID across the
    // stock mutation and durable terminal-receipt write. The session lock is
    // acquired before BEGIN by DatabaseService and released after this callback.
    // If the process crashes after the stock transaction but before the receipt,
    // inventory movement idempotency makes a retry safe; the retry then repairs
    // the missing terminal receipt without applying stock a second time.
    const transactionId = typeof tx?.client_transaction_id === 'string'
      ? tx.client_transaction_id.trim().toLowerCase() : '';
    const lockKey = [
      'wms-mobile-offline-sync',
      tenantId,
      factoryId,
      deviceId,
      transactionId,
    ].join(':');
    return this.database.transaction(
      { tenantId, userId, advisoryLockKey: lockKey },
      async () => this.syncOneOfflineTransactionUnlocked(
        userId, tenantId, factoryId, deviceId, tx, requestId, traceId,
      ),
    );
  }

  private async syncOneOfflineTransactionUnlocked(
    userId: string, tenantId: string, factoryId: string, deviceId: string,
    tx: OfflineStockTransactionDto, requestId: string | null, traceId: string | null,
  ) {
    const clientTransactionId = typeof tx?.client_transaction_id === 'string'
      ? tx.client_transaction_id.trim().toLowerCase() : '';
    const itemIdInput = typeof tx?.item_id === 'string' ? tx.item_id.trim().toLowerCase() : '';
    const idempotencyKey = 'offline:' + deviceId + ':' + clientTransactionId;
    const requestHash = this.hash({
      operation: tx?.operation ?? null,
      item_id: itemIdInput,
      movement_type: tx?.movement_type ?? null,
      // Keep invalid precision visible in the fingerprint. Rounding here would
      // make distinct rejected payloads (for example 1.00001 and 1.00002)
      // look like the same transaction ID and incorrectly replay a rejection.
      quantity: typeof tx?.quantity === 'number' ? String(tx.quantity) : String(tx?.quantity ?? ''),
      expected_balance_version: String(tx?.expected_balance_version ?? ''),
      location_id: typeof tx?.location_id === 'string' ? tx.location_id.trim().toLowerCase() : null,
      reference_type: typeof tx?.reference_type === 'string' ? tx.reference_type.trim().toUpperCase() : null,
      reference_id: typeof tx?.reference_id === 'string' ? tx.reference_id.trim().toLowerCase() : null,
      notes: typeof tx?.notes === 'string' ? tx.notes.trim() : null,
    });

    if (isUUID(clientTransactionId)) {
      const existing = await this.findOfflineReceipt(userId, tenantId, factoryId, deviceId, clientTransactionId);
      if (existing) {
        if (existing.request_hash.trim() === requestHash) {
          await this.recordOfflineAttempt(
            userId, tenantId, factoryId, deviceId, clientTransactionId, existing.id,
            'REPLAYED', requestHash, { status: existing.result_status, replayed: true }, requestId, traceId,
          );
          return {
            receipt_id: existing.id, client_transaction_id: clientTransactionId,
            operation: existing.operation, status: existing.result_status, replayed: true,
            result: existing.result,
          };
        }
        await this.recordOfflineAttempt(
          userId, tenantId, factoryId, deviceId, clientTransactionId, existing.id,
          'IDEMPOTENCY_CONFLICT', requestHash,
          { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Client transaction ID was reused with a different payload' },
          requestId, traceId,
        );
        return {
          receipt_id: existing.id, client_transaction_id: clientTransactionId,
          operation: String(tx?.operation ?? 'UNKNOWN'), status: 'CONFLICT', replayed: false,
          error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Client transaction ID was reused with a different payload' },
        };
      }
    }

    let status: 'APPLIED' | 'CONFLICT' | 'REJECTED';
    let response: Record<string, unknown>;
    let correlationId = this.correlationId(requestId, traceId);
    try {
      if (!isUUID(clientTransactionId)) throw new BadRequestException('client_transaction_id must be a UUID');
      if (!isUUID(itemIdInput)) throw new BadRequestException('item_id must be a UUID');
      if (tx.operation !== 'STOCK_MOVEMENT') throw new BadRequestException('Unsupported offline operation');
      if (!['RECEIPT', 'ISSUE'].includes(tx.movement_type)) throw new BadRequestException('movement_type must be RECEIPT or ISSUE');
      const quantityUnits = tx.quantity * 10000;
      const roundedQuantityUnits = Math.round(quantityUnits);
      if (
        !Number.isFinite(tx.quantity) || tx.quantity <= 0 ||
        !Number.isSafeInteger(roundedQuantityUnits) ||
        Math.abs(quantityUnits - roundedQuantityUnits) > 0.000001
      ) {
        throw new BadRequestException(
          'quantity must be positive, safely representable, and have at most four decimal places',
        );
      }
      const expectedVersion = String(tx.expected_balance_version ?? '').trim();
      if (!/^\d{1,19}$/.test(expectedVersion) || BigInt(expectedVersion) <= 0n) {
        throw new BadRequestException('expected_balance_version must be a positive integer string');
      }
      const locationId = tx.location_id?.trim().toLowerCase() || undefined;
      if (locationId && !isUUID(locationId)) throw new BadRequestException('location_id must be a UUID');
      const referenceId = tx.reference_id?.trim().toLowerCase() || undefined;
      if (referenceId && !isUUID(referenceId)) throw new BadRequestException('reference_id must be a UUID');

      const movement = await this.inventoryService.createStockMovement(
        userId, tenantId, factoryId, itemIdInput,
        {
          movement_type: tx.movement_type, quantity: tx.quantity,
          location_id: locationId, expected_balance_version: BigInt(expectedVersion).toString(),
          reference_type: tx.reference_type?.trim().toUpperCase() || 'MOBILE_OFFLINE',
          reference_id: referenceId,
          notes: tx.notes?.trim() || 'Mobile offline stock movement',
        } as CreateStockMovementDto,
        idempotencyKey, requestId, traceId,
      );
      status = 'APPLIED';
      response = { movement };
      correlationId = movement.correlation_id || correlationId;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const httpStatus = error.getStatus();
      if (httpStatus >= 500) throw error;
      status = httpStatus === 409 ? 'CONFLICT' : 'REJECTED';
      response = {
        code: status === 'CONFLICT' ? 'OFFLINE_STOCK_CONFLICT' : 'OFFLINE_STOCK_REJECTED',
        message: error.message,
        http_status: httpStatus,
      };
    }

    const storedItemId = await this.findExistingItemId(userId, tenantId, factoryId, itemIdInput);
    const receipt = await this.persistOfflineReceipt({
      userId, tenantId, factoryId, deviceId,
      clientTransactionId, operation: String(tx?.operation ?? 'UNKNOWN'),
      itemId: storedItemId, resultStatus: status, requestHash, idempotencyKey,
      response, requestId, correlationId,
    });
    if (receipt.idempotencyConflict) {
      return {
        receipt_id: receipt.id, client_transaction_id: clientTransactionId,
        operation: receipt.operation, status: 'CONFLICT', replayed: false,
        error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Client transaction ID was concurrently reused with a different payload' },
      };
    }
    return {
      receipt_id: receipt.id, client_transaction_id: clientTransactionId,
      operation: receipt.operation, status: receipt.result_status,
      replayed: receipt.replayed, result: receipt.result,
    };
  }

  private async findOfflineReceipt(
    userId: string, tenantId: string, factoryId: string, deviceId: string, clientTransactionId: string,
  ) {
    const result = await this.database.query<OfflineReceiptRow>(`
      SELECT id::text AS id, device_id, client_transaction_id::text AS client_transaction_id,
        operation, result_status, request_hash, result, created_at::text AS created_at
      FROM mobile_offline_sync_receipts
      WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3 AND client_transaction_id = $4::uuid
      LIMIT 1
    `, [tenantId, factoryId, deviceId, clientTransactionId], { tenantId, userId });
    return result.rows[0] ?? null;
  }

  private async findExistingItemId(userId: string, tenantId: string, factoryId: string, itemId: string) {
    if (!isUUID(itemId)) return null;
    const result = await this.database.query<{ id: string }>(`
      SELECT id::text AS id FROM inventory_items
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3 LIMIT 1
    `, [itemId, tenantId, factoryId], { tenantId, userId });
    return result.rows[0]?.id ?? null;
  }

  private async persistOfflineReceipt(input: {
    userId: string; tenantId: string; factoryId: string; deviceId: string;
    clientTransactionId: string; operation: string; itemId: string | null;
    resultStatus: 'APPLIED' | 'CONFLICT' | 'REJECTED'; requestHash: string;
    idempotencyKey: string; response: Record<string, unknown>;
    requestId: string | null; correlationId: string;
  }): Promise<OfflineReceiptPersistenceResult> {
    try {
      const stored = await this.database.transaction(
        { tenantId: input.tenantId, userId: input.userId },
        async (client) => {
          const result = await client.query<OfflineReceiptRow>(`
            INSERT INTO mobile_offline_sync_receipts (
              tenant_id, factory_id, device_id, client_transaction_id, operation, item_id,
              result_status, request_hash, idempotency_key, result, created_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4::uuid,$5,$6::uuid,$7,$8,$9,$10::jsonb,$11,$12::uuid)
            RETURNING id::text AS id, device_id, client_transaction_id::text AS client_transaction_id,
              operation, result_status, request_hash, result, created_at::text AS created_at
          `, [
            input.tenantId, input.factoryId, input.deviceId, input.clientTransactionId,
            input.operation, input.itemId, input.resultStatus, input.requestHash,
            input.idempotencyKey, JSON.stringify(input.response), input.userId, input.correlationId,
          ]);
          const receipt = result.rows[0];
          if (!receipt) throw new Error('MOBILE_OFFLINE_SYNC_RECEIPT_INSERT_FAILED');
          await client.query(`
            INSERT INTO mobile_offline_sync_attempts (
              tenant_id, factory_id, device_id, client_transaction_id, receipt_id,
              outcome, request_hash, response, created_by_user_id, correlation_id
            ) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::jsonb,$9,$10::uuid)
          `, [
            input.tenantId, input.factoryId, input.deviceId, input.clientTransactionId,
            receipt.id, input.resultStatus, input.requestHash,
            JSON.stringify({ status: input.resultStatus, result: input.response }),
            input.userId, input.correlationId,
          ]);
          await client.query(`
            INSERT INTO outbox_events (
              tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
            ) VALUES ($1,$2,'MOBILE_OFFLINE_SYNC_RECEIPT',$3,'WMS.MOBILE_OFFLINE_SYNC_RESULT_RECORDED',$4::jsonb)
          `, [input.tenantId, input.factoryId, receipt.id, JSON.stringify({
            receipt_id: receipt.id, device_id: input.deviceId,
            client_transaction_id: input.clientTransactionId, operation: input.operation,
            status: input.resultStatus, response: input.response,
          })]);
          await this.insertAudit(client, {
            tenantId: input.tenantId, factoryId: input.factoryId, userId: input.userId,
            resourceType: 'MOBILE_OFFLINE_SYNC_RECEIPT', resourceId: receipt.id,
            action: 'RECORDED', correlationId: input.correlationId, requestId: input.requestId,
            payload: {
              device_id: input.deviceId, client_transaction_id: input.clientTransactionId,
              operation: input.operation, status: input.resultStatus, request_hash: input.requestHash,
            },
          });
          return receipt;
        },
      );
      return { ...stored, replayed: false };
    } catch (error) {
      if (this.errorCode(error) !== '23505') throw error;
      const existing = await this.findOfflineReceipt(
        input.userId, input.tenantId, input.factoryId, input.deviceId, input.clientTransactionId,
      );
      if (!existing) throw new ConflictException('Offline sync idempotency key conflicts with an existing record');
      if (existing.request_hash.trim() !== input.requestHash) {
        await this.recordOfflineAttempt(
          input.userId, input.tenantId, input.factoryId, input.deviceId, input.clientTransactionId,
          existing.id, 'IDEMPOTENCY_CONFLICT', input.requestHash,
          { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Client transaction ID was concurrently reused with a different payload' },
          input.requestId, input.correlationId,
        );
        return { ...existing, replayed: false, idempotencyConflict: true };
      }
      await this.recordOfflineAttempt(
        input.userId, input.tenantId, input.factoryId, input.deviceId, input.clientTransactionId,
        existing.id, 'REPLAYED', input.requestHash, { status: existing.result_status, replayed: true },
        input.requestId, input.correlationId,
      );
      return { ...existing, replayed: true };
    }
  }

  private async recordOfflineAttempt(
    userId: string, tenantId: string, factoryId: string, deviceId: string,
    clientTransactionId: string, receiptId: string, outcome: 'REPLAYED' | 'IDEMPOTENCY_CONFLICT',
    requestHash: string, response: Record<string, unknown>,
    requestId: string | null, traceId: string | null,
  ) {
    const correlationId = this.correlationId(requestId, traceId);
    await this.database.transaction(
      { tenantId, userId },
      async (client) => {
        await client.query(`
          INSERT INTO mobile_offline_sync_attempts (
            tenant_id, factory_id, device_id, client_transaction_id, receipt_id,
            outcome, request_hash, response, created_by_user_id, correlation_id
          ) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::jsonb,$9,$10::uuid)
        `, [
          tenantId, factoryId, deviceId, clientTransactionId, receiptId,
          outcome, requestHash, JSON.stringify(response), userId, correlationId,
        ]);
        await this.insertAudit(client, {
          tenantId, factoryId, userId, resourceType: 'MOBILE_OFFLINE_SYNC_RECEIPT',
          resourceId: receiptId, action: outcome, correlationId,
          requestId: this.uuidOrNull(requestId),
          payload: { device_id: deviceId, client_transaction_id: clientTransactionId, request_hash: requestHash },
        });
      },
    );
  }

  private async loadRfidBatch(client: PoolClient, tenantId: string, factoryId: string, batchId: string, replayed: boolean) {
    const batchResult = await client.query<RfidBatchRow>(`
      SELECT id::text AS id, reader_id::text AS reader_id, session_id::text AS session_id,
        item_id::text AS item_id, location_id::text AS location_id,
        expected_quantity::text AS expected_quantity, observed_quantity::text AS observed_quantity,
        variance_quantity::text AS variance_quantity, duplicate_reads_suppressed,
        matched_tag_count, excluded_tag_count, reconciliation_status, created_at::text AS created_at
      FROM rfid_read_batches
      WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
      LIMIT 1
    `, [batchId, tenantId, factoryId]);
    const batch = batchResult.rows[0];
    if (!batch) throw new Error('RFID_READ_BATCH_REPLAY_ROW_MISSING');
    const observations = await client.query(`
      SELECT epc, traceability_unit_id::text AS traceability_unit_id,
        observed_quantity::text AS observed_quantity, duplicate_read_count, disposition
      FROM rfid_read_observations
      WHERE batch_id = $1 AND tenant_id = $2 AND factory_id = $3
      ORDER BY epc
    `, [batchId, tenantId, factoryId]);
    return { ...batch, observations: observations.rows, replayed };
  }

  private async insertAudit(client: PoolClient, input: {
    tenantId: string; factoryId: string; userId: string; resourceType: string; resourceId: string;
    action: string; correlationId: string; requestId: string | null; payload: Record<string, unknown>;
  }) {
    await client.query(`
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type,
        resource_id, correlation_id, request_id, data_class, payload
      ) VALUES ($1,$2,$3,'INVENTORY',$4,$5,$6,$7,$8,'INTERNAL',$9::jsonb)
    `, [
      input.tenantId, input.factoryId, input.userId, input.action, input.resourceType,
      input.resourceId, input.correlationId, input.requestId, JSON.stringify(input.payload),
    ]);
  }

  private validateScope(userId: string, tenantId: string, factoryId: string) {
    this.requiredUuid(userId, 'userId');
    this.requiredUuid(tenantId, 'tenantId');
    this.requiredUuid(factoryId, 'factoryId');
  }

  private requiredUuid(value: string, field: string) {
    if (!value || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value.toLowerCase();
  }

  private requiredDeviceId(value: string | undefined) {
    const deviceId = value?.trim() ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
      throw new BadRequestException('device_id must be a 1-128 character device identifier');
    }
    return deviceId;
  }

  private requiredIdempotencyKey(value: string | null) {
    const key = value?.trim() ?? '';
    if (!key || key.length > 255) throw new BadRequestException('Idempotency-Key is required and must be at most 255 characters');
    return key;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private decimalToUnits(value: string) {
    const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value).trim());
    if (!match) throw new ConflictException('Stock quantity is not a valid four-decimal value');
    return BigInt(match[1]!) * 10_000n + BigInt((match[2] ?? '').padEnd(4, '0'));
  }

  private unitsToDecimal(value: bigint) {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return sign + String(absolute / 10_000n) + '.' + String(absolute % 10_000n).padStart(4, '0');
  }

  private correlationId(requestId: string | null, traceId: string | null) {
    return (traceId && isUUID(traceId) ? traceId : null)
      ?? (requestId && isUUID(requestId) ? requestId : null)
      ?? randomUUID();
  }

  private uuidOrNull(value: string | null) {
    return value && isUUID(value) ? value.toLowerCase() : null;
  }

  private errorCode(error: unknown) {
    return error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  }
}
