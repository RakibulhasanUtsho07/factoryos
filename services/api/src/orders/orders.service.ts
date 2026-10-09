import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  randomUUID,
} from 'node:crypto';

import {
  PoolClient,
} from 'pg';

import {
  isUUID,
} from 'class-validator';

import {
  AuditService,
} from '../audit/audit.service';

import {
  DatabaseService,
} from '../database/database.service';

import {
  CreateOrderDto,
} from './dto/create-order.dto';

import {
  ListOrdersDto,
} from './dto/list-orders.dto';

import {
  OrderIdempotencyService,
} from './order-idempotency.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,

    private readonly auditService: AuditService,

    private readonly orderIdempotencyService:
      OrderIdempotencyService,
  ) {}

  async createOrder(
    userId: string,
    tenantId: string,
    dto: CreateOrderDto,
    requestId: string | null,
    traceId: string | null,
    idempotencyKey: string | null,
  ) {
    this.validateCreateOrderRequest(
      userId,
      tenantId,
      dto,
    );

    if (
      idempotencyKey === null
    ) {
      const order =
        await this.database.transaction(
          {
            tenantId,
            userId,
          },
          async (
            client,
          ) => {
            return this.createOrderInTransaction(
              client,
              userId,
              tenantId,
              dto,
              requestId,
              traceId,
            );
          },
        );

      await this.recordOrderAudit(
        tenantId,
        userId,
        order,
        requestId,
        traceId,
      );

      return order;
    }

    const normalizedKey =
      idempotencyKey.trim();

    if (!normalizedKey) {
      throw new BadRequestException(
        'Idempotency-Key cannot be empty',
      );
    }

    if (
      normalizedKey.length >
      255
    ) {
      throw new BadRequestException(
        'Idempotency-Key must be at most 255 characters',
      );
    }

    const requestHash =
      this.orderIdempotencyService
        .createRequestHash(
          dto,
        );

    const execution =
      await this.orderIdempotencyService.execute(
        tenantId,
        normalizedKey,
        requestHash,
        async (
          client,
        ) => {
          return this.createOrderInTransaction(
            client,
            userId,
            tenantId,
            dto,
            requestId,
            traceId,
          );
        },
      );

    if (
      !execution.replayed
    ) {
      await this.recordOrderAudit(
        tenantId,
        userId,
        execution.result,
        requestId,
        traceId,
      );
    }

    return execution.result;
  }

  private validateCreateOrderRequest(
    userId: string,
    tenantId: string,
    dto: CreateOrderDto,
  ): void {
    if (!isUUID(userId)) {
      throw new BadRequestException(
        'userId must be a valid UUID',
      );
    }

    if (!isUUID(tenantId)) {
      throw new BadRequestException(
        'tenantId must be a valid UUID',
      );
    }

    if (!isUUID(dto.factory_id)) {
      throw new BadRequestException(
        'factory_id must be a valid UUID',
      );
    }

    if (
      !Array.isArray(dto.lines) ||
      dto.lines.length === 0
    ) {
      throw new BadRequestException(
        'At least one order line is required',
      );
    }

    const lineNumbers =
      dto.lines.map(
        (line) =>
          line.line_number,
      );

    if (
      new Set(
        lineNumbers,
      ).size !==
      lineNumbers.length
    ) {
      throw new BadRequestException(
        'Duplicate line_number is not allowed',
      );
    }

    const currency =
      (
        dto.currency ||
        'BDT'
      )
        .trim()
        .toUpperCase();

    if (
      !/^[A-Z]{3}$/.test(
        currency,
      )
    ) {
      throw new BadRequestException(
        'currency must be a 3-letter ISO-style currency code',
      );
    }

    const orderNumber =
      dto.order_number.trim();

    if (!orderNumber) {
      throw new BadRequestException(
        'order_number is required',
      );
    }
  }

  private async createOrderInTransaction(
    client: PoolClient,
    userId: string,
    tenantId: string,
    dto: CreateOrderDto,
    requestId: string | null,
    traceId: string | null,
  ) {
    const factoryResult =
      await client.query<{
        id: string;
        code: string;
        name: string;
      }>(
        `
        SELECT
          f.id::text AS id,
          f.code,
          f.name

        FROM factories f

        WHERE
          f.id = $1
          AND f.tenant_id = $2
          AND f.status = 'ACTIVE'

        LIMIT 1
        `,
        [
          dto.factory_id,
          tenantId,
        ],
      );

    const factory =
      factoryResult.rows[0];

    if (!factory) {
      throw new ForbiddenException(
        'Factory does not belong to tenant or is not active',
      );
    }

    const currency =
      (
        dto.currency ||
        'BDT'
      )
        .trim()
        .toUpperCase();

    const orderNumber =
      dto.order_number.trim();

    let orderRow: {
      id: string;
      tenant_id: string;
      factory_id: string;
      order_number: string;
      status: string;
      order_date: string;
      requested_delivery_date:
        | string
        | null;
      currency: string;
      created_at: string;
    };

    try {
      const result =
        await client.query<{
          id: string;
          tenant_id: string;
          factory_id: string;
          order_number: string;
          status: string;
          order_date: string;
          requested_delivery_date:
            | string
            | null;
          currency: string;
          created_at: string;
        }>(
          `
          INSERT INTO orders (
            tenant_id,
            factory_id,
            order_number,
            customer_name,
            customer_reference,
            status,
            order_date,
            requested_delivery_date,
            currency,
            notes,
            created_by_user_id
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'DRAFT',
            COALESCE(
              $6::date,
              CURRENT_DATE
            ),
            $7::date,
            $8,
            $9,
            $10
          )

          RETURNING
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id,
            order_number,
            status,
            order_date::text AS order_date,
            requested_delivery_date::text
              AS requested_delivery_date,
            currency,
            created_at::text AS created_at
          `,
          [
            tenantId,
            dto.factory_id,
            orderNumber,
            dto.customer_name?.trim() ||
              null,
            dto.customer_reference?.trim() ||
              null,
            dto.order_date ||
              null,
            dto.requested_delivery_date ||
              null,
            currency,
            dto.notes?.trim() ||
              null,
            userId,
          ],
        );

      const row =
        result.rows[0];

      if (!row) {
        throw new BadRequestException(
          'Failed to create order',
        );
      }

      orderRow =
        row;
    } catch (
      error
    ) {
      if (
        error &&
        typeof error ===
          'object' &&
        'code' in error &&
        (
          error as {
            code?: string;
          }
        ).code === '23505'
      ) {
        throw new ConflictException(
          'Order number already exists in this tenant',
        );
      }

      throw error;
    }

    const createdLines:
      Array<{
        id: string;
        line_number: number;
        product_code: string;
        product_name: string;
        quantity: string;
        unit: string;
        unit_price: string | null;
      }> = [];

    for (
      const line of dto.lines
    ) {
      const lineResult =
        await client.query<{
          id: string;
          line_number: number;
          product_code: string;
          product_name: string;
          quantity: string;
          unit: string;
          unit_price: string | null;
        }>(
          `
          INSERT INTO order_lines (
            tenant_id,
            order_id,
            line_number,
            product_code,
            product_name,
            quantity,
            unit,
            unit_price,
            requested_delivery_date,
            notes
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9::date,
            $10
          )

          RETURNING
            id::text AS id,
            line_number,
            product_code,
            product_name,
            quantity::text AS quantity,
            unit,
            unit_price::text AS unit_price
          `,
          [
            tenantId,
            orderRow.id,
            line.line_number,
            line.product_code.trim(),
            line.product_name.trim(),
            line.quantity,
            line.unit.trim(),
            line.unit_price ??
              null,
            line.requested_delivery_date ||
              null,
            line.notes?.trim() ||
              null,
          ],
        );

      const createdLine =
        lineResult.rows[0];

      if (!createdLine) {
        throw new BadRequestException(
          `Failed to create order line ${line.line_number}`,
        );
      }

      createdLines.push(
        createdLine,
      );
    }

    const eventPayload = {
      order: {
        id:
          orderRow.id,

        tenant_id:
          orderRow.tenant_id,

        factory_id:
          orderRow.factory_id,

        order_number:
          orderRow.order_number,

        status:
          orderRow.status,
      },

      lines:
        createdLines.map(
          (
            line,
          ) => ({
            id:
              line.id,

            line_number:
              line.line_number,

            product_code:
              line.product_code,

            quantity:
              line.quantity,

            unit:
              line.unit,
          }),
        ),

      actor: {
        user_id:
          userId,
      },
    };

    const correlationId =
      traceId ??
      requestId ??
      randomUUID();

    const actor = {
      type:
        'user' as const,

      id:
        userId,
    };

    const source = {
      system:
        'FactoryOS',

      connector:
        'orders-service',

      version:
        process.env.APP_VERSION ??
        process.env.npm_package_version ??
        '0.1.0',
    };

    await client.query(
      `
      INSERT INTO outbox_events (
        tenant_id,
        factory_id,
        aggregate_type,
        aggregate_id,
        event_type,
        event_version,
        occurred_at,
        correlation_id,
        causation_id,
        actor,
        source,
        payload
      )

      VALUES (
        $1,
        $2,
        'ORDER',
        $3,
        'ORDER.CREATED',
        1,
        clock_timestamp(),
        $4,
        NULL,
        $5::jsonb,
        $6::jsonb,
        $7::jsonb
      )
      `,
      [
        tenantId,

        dto.factory_id,

        orderRow.id,

        correlationId,

        JSON.stringify(
          actor,
        ),

        JSON.stringify(
          source,
        ),

        JSON.stringify(
          eventPayload,
        ),
      ],
    );

    return {
      id:
        orderRow.id,

      tenant_id:
        orderRow.tenant_id,

      factory_id:
        orderRow.factory_id,

      order_number:
        orderRow.order_number,

      status:
        orderRow.status,

      order_date:
        orderRow.order_date,

      requested_delivery_date:
        orderRow.requested_delivery_date,

      currency:
        orderRow.currency,

      created_at:
        orderRow.created_at,

      lines:
        createdLines,
    };
  }

  private async recordOrderAudit(
    tenantId: string,
    userId: string,
    order: {
      id: string;
      factory_id: string;
      order_number: string;
      status: string;
      lines: unknown[];
    },
    requestId: string | null,
    traceId: string | null,
  ): Promise<void> {
    try {
      await this.auditService.record({
        tenantId,

        factoryId:
          order.factory_id,

        actorUserId:
          userId,

        eventType:
          'ORDER',

        action:
          'CREATE',

        resourceType:
          'ORDER',

        resourceId:
          order.id,

        correlationId:
          traceId,

        requestId,

        dataClass:
          'INTERNAL',

        payload: {
          orderNumber:
            order.order_number,

          status:
            order.status,

          lineCount:
            order.lines.length,

          result:
            'CREATED',
        },
      });
    } catch {
      // Audit failure must not fail committed business work.
    }
  }

  async transitionOrderStatus(
    userId: string,
    tenantId: string,
    orderId: string,
    targetStatus:
      | 'DRAFT'
      | 'CONFIRMED'
      | 'IN_PROGRESS'
      | 'COMPLETED'
      | 'CANCELLED',
    requestId: string | null,
    traceId: string | null,
    expectedVersion?: number,
  ) {
    if (!isUUID(userId)) {
      throw new BadRequestException(
        'userId must be a valid UUID',
      );
    }

    if (!isUUID(tenantId)) {
      throw new BadRequestException(
        'tenantId must be a valid UUID',
      );
    }

    if (!isUUID(orderId)) {
      throw new BadRequestException(
        'orderId must be a valid UUID',
      );
    }

    if (
      expectedVersion !== undefined &&
      (
        !Number.isInteger(
          expectedVersion,
        ) ||
        expectedVersion < 1
      )
    ) {
      throw new BadRequestException(
        'expectedVersion must be a positive integer',
      );
    }

    const result =
      await this.database.transaction(
        {
          tenantId,
          userId,
        },
        async (
          client,
        ) => {
          const orderResult =
            await client.query<{
              id: string;
              tenant_id: string;
              factory_id: string;
              order_number: string;

              status:
                | 'DRAFT'
                | 'CONFIRMED'
                | 'IN_PROGRESS'
                | 'COMPLETED'
                | 'CANCELLED';

              version: string;
            }>(
              `
              SELECT
                id::text AS id,

                tenant_id::text AS tenant_id,

                factory_id::text AS factory_id,

                order_number,

                status,

                version::text AS version

              FROM orders

              WHERE
                id = $1
                AND tenant_id = $2

              FOR UPDATE
              `,
              [
                orderId,
                tenantId,
              ],
            );

          const order =
            orderResult.rows[0];

          if (!order) {
            throw new NotFoundException(
              'Order not found',
            );
          }

          const currentVersion =
            Number(
              order.version,
            );

          if (
            expectedVersion !==
              undefined &&
            expectedVersion !==
              currentVersion
          ) {
            throw new ConflictException(
              `Order version conflict. Expected version ${expectedVersion}, current version is ${currentVersion}`,
            );
          }

          if (
            order.status ===
            targetStatus
          ) {
            throw new ConflictException(
              `Order is already in ${targetStatus} status`,
            );
          }

          const allowedTransitions:
            Record<
              string,
              readonly string[]
            > = {
              DRAFT: [
                'CONFIRMED',
                'CANCELLED',
              ],

              CONFIRMED: [
                'IN_PROGRESS',
                'CANCELLED',
              ],

              IN_PROGRESS: [
                'COMPLETED',
                'CANCELLED',
              ],

              COMPLETED: [],

              CANCELLED: [],
            };

          const allowed =
            allowedTransitions[
              order.status
            ] ?? [];

          if (
            !allowed.includes(
              targetStatus,
            )
          ) {
            throw new ConflictException(
              `Invalid order status transition: ${order.status} -> ${targetStatus}`,
            );
          }

          const updatedResult =
            await client.query<{
              id: string;
              tenant_id: string;
              factory_id: string;
              order_number: string;
              status: string;
              order_date: string;
              requested_delivery_date:
                | string
                | null;
              currency: string;
              created_at: string;
              updated_at: string;
              version: string;
            }>(
              `
              UPDATE orders

              SET
                status = $1,

                updated_at =
                  clock_timestamp(),

                version =
                  version + 1

              WHERE
                id = $2

                AND tenant_id = $3

                AND version = $4

              RETURNING
                id::text AS id,

                tenant_id::text
                  AS tenant_id,

                factory_id::text
                  AS factory_id,

                order_number,

                status,

                order_date::text
                  AS order_date,

                requested_delivery_date::text
                  AS requested_delivery_date,

                currency,

                created_at::text
                  AS created_at,

                updated_at::text
                  AS updated_at,

                version::text
                  AS version
              `,
              [
                targetStatus,
                order.id,
                tenantId,
                currentVersion,
              ],
            );

          const updatedOrder =
            updatedResult.rows[0];

          if (!updatedOrder) {
            throw new ConflictException(
              'Order was modified before the status transition could be committed',
            );
          }

          const eventType =
            `ORDER.${targetStatus}`;

          const eventPayload = {
            order: {
              id:
                updatedOrder.id,

              tenant_id:
                updatedOrder.tenant_id,

              factory_id:
                updatedOrder.factory_id,

              order_number:
                updatedOrder.order_number,

              previous_status:
                order.status,

              status:
                updatedOrder.status,

              version:
                Number(
                  updatedOrder.version,
                ),

              updated_at:
                updatedOrder.updated_at,
            },

            actor: {
              user_id:
                userId,
            },
          };

          const correlationId =
            traceId ??
            requestId ??
            randomUUID();

          const actor = {
            type:
              'user' as const,

            id:
              userId,
          };

          const source = {
            system:
              'FactoryOS',

            connector:
              'orders-service',

            version:
              process.env.APP_VERSION ??
              process.env.npm_package_version ??
              '0.1.0',
          };

          await client.query(
            `
            INSERT INTO outbox_events (
              tenant_id,
              factory_id,
              aggregate_type,
              aggregate_id,
              event_type,
              event_version,
              occurred_at,
              correlation_id,
              causation_id,
              actor,
              source,
              payload
            )

            VALUES (
              $1,
              $2,
              'ORDER',
              $3,
              $4,
              1,
              clock_timestamp(),
              $5,
              NULL,
              $6::jsonb,
              $7::jsonb,
              $8::jsonb
            )
            `,
            [
              tenantId,

              updatedOrder.factory_id,

              updatedOrder.id,

              eventType,

              correlationId,

              JSON.stringify(
                actor,
              ),

              JSON.stringify(
                source,
              ),

              JSON.stringify(
                eventPayload,
              ),
            ],
          );

          return {
            id:
              updatedOrder.id,

            tenant_id:
              updatedOrder.tenant_id,

            factory_id:
              updatedOrder.factory_id,

            order_number:
              updatedOrder.order_number,

            previous_status:
              order.status,

            status:
              updatedOrder.status,

            order_date:
              updatedOrder.order_date,

            requested_delivery_date:
              updatedOrder.requested_delivery_date,

            currency:
              updatedOrder.currency,

            created_at:
              updatedOrder.created_at,

            updated_at:
              updatedOrder.updated_at,

            version:
              Number(
                updatedOrder.version,
              ),
          };
        },
      );

    try {
      await this.auditService.record({
        tenantId,

        factoryId:
          result.factory_id,

        actorUserId:
          userId,

        eventType:
          'ORDER',

        action:
          'STATUS_TRANSITION',

        resourceType:
          'ORDER',

        resourceId:
          result.id,

        correlationId:
          traceId,

        requestId,

        dataClass:
          'INTERNAL',

        payload: {
          orderNumber:
            result.order_number,

          from:
            result.previous_status,

          to:
            result.status,

          version:
            result.version,

          updatedAt:
            result.updated_at,

          result:
            'UPDATED',
        },
      });
    } catch {
      // Business transaction already committed.
    }

    return result;
  }

  async getOrderById(
    tenantId: string,
    factoryId: string,
    orderId: string,
  ) {
    if (!isUUID(tenantId)) {
      throw new BadRequestException(
        'tenantId must be a valid UUID',
      );
    }

    if (!isUUID(factoryId)) {
      throw new BadRequestException(
        'factoryId must be a valid UUID',
      );
    }

    if (!isUUID(orderId)) {
      throw new BadRequestException(
        'orderId must be a valid UUID',
      );
    }

    const orderResult =
      await this.database.query<{
        id: string;
        tenant_id: string;
        factory_id: string;
        order_number: string;

        customer_name:
          string | null;

        customer_reference:
          string | null;

        status: string;

        order_date: string;

        requested_delivery_date:
          | string
          | null;

        currency: string;

        notes:
          string | null;

        created_by_user_id:
          string;

        created_at: string;
        updated_at: string;
        version: string;
      }>(
        `
        SELECT
          o.id::text AS id,

          o.tenant_id::text AS tenant_id,

          o.factory_id::text AS factory_id,

          o.order_number,

          o.customer_name,

          o.customer_reference,

          o.status,

          o.order_date::text AS order_date,

          o.requested_delivery_date::text
            AS requested_delivery_date,

          o.currency,

          o.notes,

          o.created_by_user_id::text
            AS created_by_user_id,

          o.created_at::text AS created_at,

          o.updated_at::text AS updated_at,

          o.version::text AS version

        FROM orders o

        WHERE
          o.id = $1
          AND o.tenant_id = $2
          AND o.factory_id = $3

        LIMIT 1
        `,
        [
          orderId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    const order =
      orderResult.rows[0];

    if (!order) {
      throw new NotFoundException(
        'Order not found',
      );
    }

    const linesResult =
      await this.database.query<{
        id: string;
        line_number: number;
        product_code: string;
        product_name: string;
        quantity: string;
        unit: string;
        unit_price:
          | string
          | null;

        requested_delivery_date:
          | string
          | null;

        notes:
          | string
          | null;
      }>(
        `
        SELECT
          ol.id::text AS id,

          ol.line_number,

          ol.product_code,

          ol.product_name,

          ol.quantity::text
            AS quantity,

          ol.unit,

          ol.unit_price::text
            AS unit_price,

          ol.requested_delivery_date::text
            AS requested_delivery_date,

          ol.notes

        FROM order_lines ol

        WHERE
          ol.order_id = $1
          AND ol.tenant_id = $2

        ORDER BY
          ol.line_number ASC
        `,
        [
          orderId,
          tenantId,
        ],
        {
          tenantId,
        },
      );

    return {
      id:
        order.id,

      tenant_id:
        order.tenant_id,

      factory_id:
        order.factory_id,

      order_number:
        order.order_number,

      customer_name:
        order.customer_name,

      customer_reference:
        order.customer_reference,

      status:
        order.status,

      order_date:
        order.order_date,

      requested_delivery_date:
        order.requested_delivery_date,

      currency:
        order.currency,

      notes:
        order.notes,

      created_by_user_id:
        order.created_by_user_id,

      created_at:
        order.created_at,

      updated_at:
        order.updated_at,

      version:
        order.version,

      lines:
        linesResult.rows,
    };
  }

  async listOrders(
    tenantId: string,
    factoryId: string,
    dto: ListOrdersDto,
  ) {
    if (!isUUID(tenantId)) {
      throw new BadRequestException(
        'tenantId must be a valid UUID',
      );
    }

    if (!isUUID(factoryId)) {
      throw new BadRequestException(
        'factoryId must be a valid UUID',
      );
    }

    const page =
      dto.page ??
      1;

    const limit =
      dto.limit ??
      20;

    const offset =
      (page - 1) *
      limit;

    const status =
      dto.status ??
      null;

    const normalizedSearch =
      dto.search?.trim() ||
      null;

    const searchPattern =
      normalizedSearch
        ? `%${normalizedSearch}%`
        : null;

    const result =
      await this.database.query<{
        id: string;
        tenant_id: string;
        factory_id: string;
        order_number: string;

        customer_name:
          string | null;

        customer_reference:
          string | null;

        status: string;

        order_date: string;

        requested_delivery_date:
          | string
          | null;

        currency: string;

        created_at: string;

        total_count: string;
      }>(
        `
        SELECT
          o.id::text AS id,

          o.tenant_id::text
            AS tenant_id,

          o.factory_id::text
            AS factory_id,

          o.order_number,

          o.customer_name,

          o.customer_reference,

          o.status,

          o.order_date::text
            AS order_date,

          o.requested_delivery_date::text
            AS requested_delivery_date,

          o.currency,

          o.created_at::text
            AS created_at,

          COUNT(*) OVER()::text
            AS total_count

        FROM orders o

        WHERE
          o.tenant_id = $1

          AND o.factory_id = $2

          AND (
            $3::text IS NULL
            OR o.status = $3
          )

          AND (
            $4::text IS NULL

            OR o.order_number
              ILIKE $4

            OR COALESCE(
              o.customer_name,
              ''
            ) ILIKE $4

            OR COALESCE(
              o.customer_reference,
              ''
            ) ILIKE $4
          )

        ORDER BY
          o.created_at DESC,
          o.id DESC

        LIMIT $5
        OFFSET $6
        `,
        [
          tenantId,
          factoryId,
          status,
          searchPattern,
          limit,
          offset,
        ],
        {
          tenantId,
        },
      );

    const total =
      result.rows.length >
      0
        ? Number(
            result.rows[0]
              .total_count,
          )
        : 0;

    const totalPages =
      total === 0
        ? 0
        : Math.ceil(
            total / limit,
          );

    return {
      items:
        result.rows.map(
          (
            row,
          ) => ({
            id:
              row.id,

            tenant_id:
              row.tenant_id,

            factory_id:
              row.factory_id,

            order_number:
              row.order_number,

            customer_name:
              row.customer_name,

            customer_reference:
              row.customer_reference,

            status:
              row.status,

            order_date:
              row.order_date,

            requested_delivery_date:
              row.requested_delivery_date,

            currency:
              row.currency,

            created_at:
              row.created_at,
          }),
        ),

      pagination: {
        page,

        limit,

        total,

        total_pages:
          totalPages,
      },
    };
  }
}