import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';

import { NestFactory } from '@nestjs/core';

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { AppModule } from '../app.module';

import { HttpExceptionFilter } from '../common/filters/http-exception.filter';

import { ApiResponseInterceptor } from '../common/interceptors/api-response.interceptor';

interface JsonRecord {
  [key: string]: unknown;
}

interface HttpResult {
  status: number;
  body: unknown;
}

function isRecord(
  value: unknown,
): value is JsonRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function unwrapResponse(
  body: unknown,
): JsonRecord {
  if (!isRecord(body)) {
    return {};
  }

  const data =
    body.data;

  if (isRecord(data)) {
    return data;
  }

  return body;
}

function findStringByKeys(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | null {
  if (
    depth > 6 ||
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (isRecord(value)) {
    for (const key of keys) {
      const candidate =
        value[key];

      if (
        typeof candidate === 'string' &&
        candidate.trim()
      ) {
        return candidate;
      }
    }

    for (const nested of Object.values(value)) {
      const result =
        findStringByKeys(
          nested,
          keys,
          depth + 1,
        );

      if (result) {
        return result;
      }
    }
  }

  if (Array.isArray(value)) {
    for (const nested of value) {
      const result =
        findStringByKeys(
          nested,
          keys,
          depth + 1,
        );

      if (result) {
        return result;
      }
    }
  }

  return null;
}

async function parseHttpResponse(
  response: Response,
): Promise<HttpResult> {
  const text =
    await response.text();

  if (!text.trim()) {
    return {
      status:
        response.status,
      body:
        null,
    };
  }

  try {
    return {
      status:
        response.status,
      body:
        JSON.parse(text) as unknown,
    };
  } catch {
    return {
      status:
        response.status,
      body:
        text,
    };
  }
}

describe(
  'Orders HTTP lifecycle concurrency',
  () => {
    const TEST_USER_ID =
      '921382b8-e83f-43ab-a576-e3db6a06b70c';

    let app!:
      INestApplication;

    let pool!:
      Pool;

    let baseUrl!:
      string;

    let tenantId!:
      string;

    let factoryId!:
      string;

    let orderId!:
      string;

    let accessToken!:
      string;

    let originalNodeEnv:
      string | undefined;

    let originalDevAuthEnabled:
      string | undefined;

    let originalOutboxDispatcherEnabled:
      string | undefined;

    // ==========================================================
    // TEST APPLICATION SETUP
    // ==========================================================

    beforeAll(
      async () => {
        // ========================================================
        // PRESERVE PROCESS ENVIRONMENT
        // ========================================================

        originalNodeEnv =
          process.env.NODE_ENV;

        originalDevAuthEnabled =
          process.env.DEV_AUTH_ENABLED;

        originalOutboxDispatcherEnabled =
          process.env.OUTBOX_DISPATCHER_ENABLED;

        // ========================================================
        // TEST AUTH CONFIGURATION
        // ========================================================
        //
        // The development token endpoint is intentionally hidden
        // outside development mode.
        //
        // This test uses the real HTTP authentication boundary.
        //

        process.env.NODE_ENV =
          'development';

        process.env.DEV_AUTH_ENABLED =
          'true';

        // ========================================================
        // IMPORTANT TEST ISOLATION
        // ========================================================
        //
        // This test creates a real Nest application against the
        // integration-test database.
        //
        // It must NOT start the background Outbox dispatcher,
        // otherwise the dispatcher can race with the dedicated
        // concurrent/restart/lease/quarantine integration tests
        // that also use the same PostgreSQL database.
        //
        // Dedicated dispatcher tests instantiate the dispatcher
        // explicitly and call dispatchOnce().
        //

        process.env.OUTBOX_DISPATCHER_ENABLED =
          'false';

        // ========================================================
        // DATABASE
        // ========================================================

    const testAdminDatabaseUrl =
  process.env.TEST_ADMIN_DATABASE_URL;

if (!testAdminDatabaseUrl) {
  throw new Error(
    'TEST_ADMIN_DATABASE_URL is required.',
  );
}

pool =
  new Pool({
    connectionString:
      testAdminDatabaseUrl,
  });
        // ========================================================
        // REAL NEST APPLICATION
        // ========================================================

        app =
          await NestFactory.create(
            AppModule,
          );

        app.setGlobalPrefix(
          'api',
        );

        app.useGlobalPipes(
          new ValidationPipe({
            whitelist:
              true,

            transform:
              true,

            forbidNonWhitelisted:
              true,
          }),
        );

        app.useGlobalFilters(
          new HttpExceptionFilter(),
        );

        app.useGlobalInterceptors(
          new ApiResponseInterceptor(),
        );

        await app.listen(
          0,
          '127.0.0.1',
        );

        baseUrl =
          await app.getUrl();

        // ========================================================
        // ACTIVE TENANT + FACTORY
        // ========================================================

        const contextResult =
          await pool.query<{
            tenant_id: string;
            factory_id: string;
          }>(
            `
            SELECT
              t.id::text AS tenant_id,

              f.id::text AS factory_id

            FROM tenants t

            INNER JOIN factories f
              ON f.tenant_id = t.id

            WHERE
              t.status = 'ACTIVE'

              AND f.status = 'ACTIVE'

            ORDER BY
              t.created_at ASC,
              f.created_at ASC

            LIMIT 1
            `,
          );

        if (
          contextResult.rowCount !==
          1
        ) {
          throw new Error(
            'No active tenant/factory available for HTTP lifecycle test.',
          );
        }

        const context =
          contextResult.rows[0];

        if (!context) {
          throw new Error(
            'HTTP lifecycle test context is missing.',
          );
        }

        tenantId =
          context.tenant_id;

        factoryId =
          context.factory_id;

        // ========================================================
        // TEST ACTOR
        // ========================================================

        const userResult =
          await pool.query<{
            id: string;
          }>(
            `
            SELECT
              id::text AS id

            FROM users

            WHERE
              id = $1

            LIMIT 1
            `,
            [
              TEST_USER_ID,
            ],
          );

        if (
          userResult.rowCount !==
          1
        ) {
          throw new Error(
            `Test user does not exist: ${TEST_USER_ID}`,
          );
        }

        // ========================================================
        // VERIFY ACTIVE TENANT MEMBERSHIP
        // ========================================================
        //
        // users is tenant-neutral.
        // Tenant membership belongs to tenant_memberships.
        //

        const membershipResult =
          await pool.query<{
            membership_id: string;
          }>(
            `
            SELECT
              tm.id::text AS membership_id

            FROM users u

            INNER JOIN tenant_memberships tm
              ON tm.user_id = u.id

            WHERE
              u.id = $1

              AND tm.tenant_id = $2

              AND u.status = 'ACTIVE'

              AND tm.status = 'ACTIVE'

            LIMIT 1
            `,
            [
              TEST_USER_ID,
              tenantId,
            ],
          );

        if (
          membershipResult.rowCount !==
          1
        ) {
          throw new Error(
            `Test user ${TEST_USER_ID} does not have an active membership in tenant ${tenantId}.`,
          );
        }

        // ========================================================
        // CREATE ISOLATED AUTHORITATIVE ORDER
        // ========================================================

        const orderNumber =
          `HTTP-CONCURRENCY-TEST-${randomUUID()}`;

        const orderResult =
          await pool.query<{
            id: string;
            status: string;
            version: string;
            updated_at: string;
          }>(
            `
            INSERT INTO orders (
              tenant_id,
              factory_id,
              order_number,
              status,
              order_date,
              currency,
              created_by_user_id
            )

            VALUES (
              $1,
              $2,
              $3,
              'DRAFT',
              CURRENT_DATE,
              'BDT',
              $4
            )

            RETURNING
              id::text AS id,

              status,

              version::text AS version,

              updated_at::text AS updated_at
            `,
            [
              tenantId,
              factoryId,
              orderNumber,
              TEST_USER_ID,
            ],
          );

        if (
          orderResult.rowCount !==
          1
        ) {
          throw new Error(
            'HTTP concurrency test order could not be created.',
          );
        }

        const createdOrder =
          orderResult.rows[0];

        if (!createdOrder) {
          throw new Error(
            'HTTP concurrency test order row is missing.',
          );
        }

        orderId =
          createdOrder.id;

        expect(
          createdOrder.status,
        ).toBe(
          'DRAFT',
        );

        expect(
          Number(
            createdOrder.version,
          ),
        ).toBe(1);

        // ========================================================
        // REAL JWT THROUGH REAL DEV AUTH ENDPOINT
        // ========================================================

        const devAuthSecret =
          process.env.DEV_AUTH_SECRET;

        if (!devAuthSecret) {
          throw new Error(
            'DEV_AUTH_SECRET is required for the HTTP lifecycle integration test.',
          );
        }

        const tokenResponse =
          await fetch(
            `${baseUrl}/api/auth/dev-token`,
            {
              method:
                'POST',

              headers: {
                'content-type':
                  'application/json',

                'x-dev-auth-secret':
                  devAuthSecret,
              },

              body:
                JSON.stringify({
                  user_id:
                    TEST_USER_ID,

                  tenant_id:
                    tenantId,
                }),
            },
          );

        const tokenResult =
          await parseHttpResponse(
            tokenResponse,
          );

        if (
          tokenResult.status <
            200 ||
          tokenResult.status >=
            300
        ) {
          throw new Error(
            `Dev token request failed with HTTP ${tokenResult.status}: ${JSON.stringify(tokenResult.body)}`,
          );
        }

        accessToken =
          findStringByKeys(
            tokenResult.body,
            [
              'access_token',
              'accessToken',
              'token',
              'jwt',
            ],
          ) ?? '';

        if (!accessToken) {
          throw new Error(
            `Dev token response did not contain an access token: ${JSON.stringify(tokenResult.body)}`,
          );
        }
      },
      60_000,
    );

    // ============================================================
    // TEST APPLICATION CLEANUP
    // ============================================================

    afterAll(
      async () => {
        // ========================================================
        // CLEAN TEST DATA
        // ========================================================

        if (
          pool &&
          orderId
        ) {
          /*
           * Remove projections produced for events belonging
           * to this test order.
           */
          await pool.query(
            `
            DELETE FROM order_event_projections

            WHERE
              event_id IN (
                SELECT
                  id

                FROM outbox_events

                WHERE
                  aggregate_id = $1
              )
            `,
            [
              orderId,
            ],
          );

          /*
           * Remove inbox entries belonging to events of this order.
           */
          await pool.query(
            `
            DELETE FROM inbox_events

            WHERE
              event_id IN (
                SELECT
                  id

                FROM outbox_events

                WHERE
                  aggregate_id = $1
              )
            `,
            [
              orderId,
            ],
          );

          /*
           * Remove outbox entries generated by this test.
           */
          await pool.query(
            `
            DELETE FROM outbox_events

            WHERE
              aggregate_id = $1
            `,
            [
              orderId,
            ],
          );

          /*
           * Finally remove the authoritative order.
           */
          await pool.query(
            `
            DELETE FROM orders

            WHERE
              id = $1
            `,
            [
              orderId,
            ],
          );
        }

        // ========================================================
        // CLOSE NEST APP
        // ========================================================

        if (app) {
          await app.close();
        }

        // ========================================================
        // CLOSE DATABASE POOL
        // ========================================================

        if (pool) {
          await pool.end();
        }

        // ========================================================
        // RESTORE PROCESS ENVIRONMENT
        // ========================================================

        if (
          originalNodeEnv ===
          undefined
        ) {
          delete process.env
            .NODE_ENV;
        } else {
          process.env.NODE_ENV =
            originalNodeEnv;
        }

        if (
          originalDevAuthEnabled ===
          undefined
        ) {
          delete process.env
            .DEV_AUTH_ENABLED;
        } else {
          process.env.DEV_AUTH_ENABLED =
            originalDevAuthEnabled;
        }

        if (
          originalOutboxDispatcherEnabled ===
          undefined
        ) {
          delete process.env
            .OUTBOX_DISPATCHER_ENABLED;
        } else {
          process.env
            .OUTBOX_DISPATCHER_ENABLED =
            originalOutboxDispatcherEnabled;
        }
      },
      60_000,
    );

    // ============================================================
    // HTTP OPTIMISTIC-CONCURRENCY CONTRACT
    // ============================================================

    it(
      'should enforce expected_version through the real HTTP pipeline',
      async () => {
        const commonHeaders =
          {
            authorization:
              `Bearer ${accessToken}`,

            'x-user-id':
              TEST_USER_ID,

            'x-tenant-id':
              tenantId,

            'x-factory-id':
              factoryId,

            'x-request-id':
              randomUUID(),

            'x-trace-id':
              randomUUID(),
          };

        // ========================================================
        // FIRST CLIENT
        //
        // version 1 -> CONFIRMED / version 2
        // ========================================================

        const successfulTransition =
          await fetch(
            `${baseUrl}/api/orders/${orderId}/status`,
            {
              method:
                'POST',

              headers: {
                ...commonHeaders,

                'content-type':
                  'application/json',
              },

              body:
                JSON.stringify({
                  target_status:
                    'CONFIRMED',

                  expected_version:
                    1,
                }),
            },
          );

        const successfulResult =
          await parseHttpResponse(
            successfulTransition,
          );

        expect(
          successfulResult.status,
        ).toBe(201);

        const successfulBody =
          unwrapResponse(
            successfulResult.body,
          );

        expect(
          successfulBody.status,
        ).toBe(
          'CONFIRMED',
        );

        expect(
          Number(
            successfulBody.version,
          ),
        ).toBe(2);

        // ========================================================
        // STALE CLIENT
        //
        // version 1 must be rejected.
        // ========================================================

        const staleTransition =
          await fetch(
            `${baseUrl}/api/orders/${orderId}/status`,
            {
              method:
                'POST',

              headers: {
                ...commonHeaders,

                'x-request-id':
                  randomUUID(),

                'x-trace-id':
                  randomUUID(),

                'content-type':
                  'application/json',
              },

              body:
                JSON.stringify({
                  target_status:
                    'IN_PROGRESS',

                  expected_version:
                    1,
                }),
            },
          );

        const staleResult =
          await parseHttpResponse(
            staleTransition,
          );

        expect(
          staleResult.status,
        ).toBe(409);

        expect(
          JSON.stringify(
            staleResult.body,
          ).toLowerCase(),
        ).toContain(
          'version conflict',
        );

        // ========================================================
        // REAL GET ENDPOINT
        //
        // Version must remain 2.
        // ========================================================

        const getResponse =
          await fetch(
            `${baseUrl}/api/orders/${orderId}`,
            {
              method:
                'GET',

              headers:
                commonHeaders,
            },
          );

        const getResult =
          await parseHttpResponse(
            getResponse,
          );

        expect(
          getResult.status,
        ).toBe(200);

        const getBody =
          unwrapResponse(
            getResult.body,
          );

        expect(
          getBody.id,
        ).toBe(
          orderId,
        );

        expect(
          getBody.status,
        ).toBe(
          'CONFIRMED',
        );

        expect(
          Number(
            getBody.version,
          ),
        ).toBe(2);

        // ========================================================
        // AUTHORITATIVE POSTGRES STATE
        // ========================================================

        const dbResult =
          await pool.query<{
            status: string;
            version: string;
          }>(
            `
            SELECT
              status,

              version::text AS version

            FROM orders

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3
            `,
            [
              orderId,
              tenantId,
              factoryId,
            ],
          );

        expect(
          dbResult.rowCount,
        ).toBe(1);

        const dbOrder =
          dbResult.rows[0];

        if (!dbOrder) {
          throw new Error(
            'HTTP concurrency DB state is missing.',
          );
        }

        expect(
          dbOrder.status,
        ).toBe(
          'CONFIRMED',
        );

        expect(
          Number(
            dbOrder.version,
          ),
        ).toBe(2);
      },
    );
  },
);