import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import {
  DatabaseService,
} from './database.service';

describe(
  'Database tenant isolation',
  () => {
    let database: DatabaseService;

    const tenantA =
      randomUUID();

    const tenantB =
      randomUUID();

    beforeAll(
      async () => {
        const config =
          {
            get: (
              key: string,
            ) => {
              if (
                key ===
                'DATABASE_URL'
              ) {
                return process.env
                  .DATABASE_URL;
              }

              return undefined;
            },
          } as ConfigService;

        database =
          new DatabaseService(
            config,
          );

        await database.onModuleInit();

        await database.query(
          `
          INSERT INTO tenants (
            id,
            slug,
            name
          )
          VALUES
            ($1, $3, 'RLS Tenant A'),
            ($2, $4, 'RLS Tenant B')
          `,
          [
            tenantA,
            tenantB,
            `rls-a-${tenantA.slice(0, 8)}`,
            `rls-b-${tenantB.slice(0, 8)}`,
          ],
        );

        await database.transaction(
          {
            tenantId:
              tenantA,
          },
          async (client) => {
            await client.query(
              `
              INSERT INTO legal_entities (
                tenant_id,
                code,
                name
              )
              VALUES (
                $1,
                'RLS-A',
                'RLS Legal Entity A'
              )
              `,
              [tenantA],
            );
          },
        );

        await database.transaction(
          {
            tenantId:
              tenantB,
          },
          async (client) => {
            await client.query(
              `
              INSERT INTO legal_entities (
                tenant_id,
                code,
                name
              )
              VALUES (
                $1,
                'RLS-B',
                'RLS Legal Entity B'
              )
              `,
              [tenantB],
            );
          },
        );
      },
      60_000,
    );

    afterAll(
      async () => {
        for (
          const tenantId of [
            tenantA,
            tenantB,
          ]
        ) {
          await database.transaction(
            {
              tenantId,
            },
            async (client) => {
              await client.query(
                `
                DELETE FROM legal_entities
                WHERE tenant_id = $1
                `,
                [tenantId],
              );
            },
          );
        }

        await database.query(
          `
          DELETE FROM tenants
          WHERE id IN ($1, $2)
          `,
          [
            tenantA,
            tenantB,
          ],
        );

        await database.onModuleDestroy();
      },
      60_000,
    );

    it(
      'returns only the current tenant rows',
      async () => {
        const result =
          await database.query<{
            tenant_id: string;
            code: string;
          }>(
            `
            SELECT
              tenant_id::text AS tenant_id,
              code

            FROM legal_entities

            ORDER BY code
            `,
            [],
            {
              tenantId:
                tenantA,
            },
          );

        expect(
          result.rows,
        ).toEqual([
          {
            tenant_id:
              tenantA,
            code:
              'RLS-A',
          },
        ]);
      },
    );

    it(
      'does not return tenant rows without context',
      async () => {
        const result =
          await database.query(
            `
            SELECT
              id,
              tenant_id

            FROM legal_entities

            WHERE tenant_id IN (
              $1,
              $2
            )
            `,
            [
              tenantA,
              tenantB,
            ],
          );

        expect(
          result.rows,
        ).toHaveLength(0);
      },
    );

    it(
      'rejects cross-tenant writes',
      async () => {
        await expect(
          database.transaction(
            {
              tenantId:
                tenantA,
            },
            async (client) => {
              await client.query(
                `
                INSERT INTO legal_entities (
                  tenant_id,
                  code,
                  name
                )
                VALUES (
                  $1,
                  'RLS-CROSS',
                  'Should Fail'
                )
                `,
                [tenantB],
              );
            },
          ),
        ).rejects.toMatchObject({
          code:
            '42501',
        });
      },
    );

    it(
      'has FORCE RLS enabled on tenant tables',
      async () => {
        const tables = [
          'legal_entities',
          'factories',
          'tenant_memberships',
          'roles',
          'role_permissions',
          'user_roles',
          'audit_events',
          'orders',
          'order_lines',
          'outbox_events',
          'inbox_events',
          'order_event_projections',
          'order_idempotency_keys',
        ];

        const result =
          await database.query<{
            relname: string;
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
          }>(
            `
            SELECT
              c.relname,
              c.relrowsecurity,
              c.relforcerowsecurity

            FROM pg_class c

            INNER JOIN pg_namespace n
              ON n.oid = c.relnamespace

            WHERE n.nspname = 'public'
              AND c.relname = ANY($1::text[])

            ORDER BY c.relname
            `,
            [tables],
          );

        expect(
          result.rows,
        ).toHaveLength(
          tables.length,
        );

        for (
          const row of result.rows
        ) {
          expect(
            row.relrowsecurity,
          ).toBe(true);

          expect(
            row.relforcerowsecurity,
          ).toBe(true);
        }
      },
    );
  },
);