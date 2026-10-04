import {
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { createHash } from 'node:crypto';

import { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

export interface OrderIdempotencyExecutionResult<T> {
  replayed: boolean;
  result: T;
}

interface IdempotencyRow<T> {
  id: string;
  request_hash: string;
  status: string;
  response_payload: T | null;
  resource_id: string | null;
  expires_at: string;
}

@Injectable()
export class OrderIdempotencyService {
  constructor(
    private readonly database: DatabaseService,
  ) {}

  createRequestHash(
    body: unknown,
  ): string {
    const canonicalBody =
      this.canonicalize(body);

    const serialized =
      JSON.stringify({
        operation: 'ORDER.CREATE',
        payload: canonicalBody,
      });

    return createHash('sha256')
      .update(serialized)
      .digest('hex');
  }

  async execute<T>(
    tenantId: string,
    idempotencyKey: string,
    requestHash: string,
    handler: (
      client: PoolClient,
    ) => Promise<T>,
  ): Promise<
    OrderIdempotencyExecutionResult<T>
  > {
    return this.database.transaction(
      async (client) => {
        /*
         * Allow a key to be reused after its
         * retention window has expired.
         *
         * This happens inside the same transaction
         * as the claim, so concurrent requests remain
         * protected by the unique constraint.
         */
        await client.query(
          `
          DELETE FROM order_idempotency_keys

          WHERE tenant_id = $1
            AND idempotency_key = $2
            AND expires_at <= now()
          `,
          [
            tenantId,
            idempotencyKey,
          ],
        );

        /*
         * First request claims the key.
         *
         * If another transaction is currently
         * inserting the same tenant/key pair,
         * PostgreSQL uniqueness handling waits for
         * that transaction and then resolves the
         * conflict safely.
         */
        const inserted =
          await client.query<{
            id: string;
          }>(
            `
            INSERT INTO order_idempotency_keys (
              tenant_id,
              idempotency_key,
              request_hash,
              status
            )

            VALUES (
              $1,
              $2,
              $3,
              'PROCESSING'
            )

            ON CONFLICT (
              tenant_id,
              idempotency_key
            )

            DO NOTHING

            RETURNING
              id::text AS id
            `,
            [
              tenantId,
              idempotencyKey,
              requestHash,
            ],
          );

        /*
         * Existing key.
         */
        if (
          inserted.rowCount === 0
        ) {
          const existingResult =
            await client.query<
              IdempotencyRow<T>
            >(
              `
              SELECT
                id::text AS id,
                request_hash,
                status,
                response_payload,
                resource_id::text AS resource_id,
                expires_at::text AS expires_at

              FROM order_idempotency_keys

              WHERE tenant_id = $1
                AND idempotency_key = $2

              LIMIT 1

              FOR UPDATE
              `,
              [
                tenantId,
                idempotencyKey,
              ],
            );

          const existing =
            existingResult.rows[0];

          if (!existing) {
            throw new ConflictException(
              'Unable to resolve Idempotency-Key state',
            );
          }

          /*
           * Same key with a different request body
           * must never replay a different operation.
           */
          if (
            existing.request_hash !==
            requestHash
          ) {
            throw new ConflictException(
              'Idempotency-Key was already used with a different request',
            );
          }

          /*
           * Completed request:
           * replay the exact business result.
           */
          if (
            existing.status ===
              'COMPLETED' &&
            existing.response_payload !==
              null
          ) {
            return {
              replayed: true,
              result:
                existing.response_payload,
            };
          }

          /*
           * A committed PROCESSING row should not
           * normally exist with the atomic design.
           * Keep this guard for defensive handling
           * of legacy/manual states.
           */
          if (
            existing.status ===
            'PROCESSING'
          ) {
            throw new ConflictException(
              'A request with this Idempotency-Key is already being processed',
            );
          }

          throw new ConflictException(
            'Invalid Idempotency-Key state',
          );
        }

        /*
         * First request:
         *
         * The actual business operation executes
         * in this SAME database transaction.
         */
        const result =
          await handler(client);

        let serializedResult: string;

        try {
          serializedResult =
            JSON.stringify(result);
        } catch {
          throw new ConflictException(
            'Order response could not be serialized for idempotency replay',
          );
        }

        const resourceId =
          this.extractResourceId(
            result,
          );

        const completed =
          await client.query(
            `
            UPDATE order_idempotency_keys

            SET
              status = 'COMPLETED',
              response_payload = $1::jsonb,
              resource_type = 'ORDER',
              resource_id = $2,
              completed_at = now()

            WHERE tenant_id = $3
              AND idempotency_key = $4
              AND status = 'PROCESSING'
            `,
            [
              serializedResult,
              resourceId,
              tenantId,
              idempotencyKey,
            ],
          );

        if (
          completed.rowCount !== 1
        ) {
          throw new Error(
            'ORDER_IDEMPOTENCY_COMPLETION_UPDATE_FAILED',
          );
        }

        return {
          replayed: false,
          result,
        };
      },
    );
  }

  private extractResourceId(
    result: unknown,
  ): string | null {
    if (
      typeof result !== 'object' ||
      result === null ||
      !('id' in result)
    ) {
      return null;
    }

    const id =
      (
        result as {
          id?: unknown;
        }
      ).id;

    return typeof id === 'string'
      ? id
      : null;
  }

  private canonicalize(
    value: unknown,
  ): unknown {
    if (
      value === null ||
      typeof value !== 'object'
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(
        (item) =>
          this.canonicalize(item),
      );
    }

    const record =
      value as Record<
        string,
        unknown
      >;

    return Object.keys(record)
      .sort()
      .reduce(
        (
          result,
          key,
        ) => {
          result[key] =
            this.canonicalize(
              record[key],
            );

          return result;
        },
        {} as Record<
          string,
          unknown
        >,
      );
  }
}
