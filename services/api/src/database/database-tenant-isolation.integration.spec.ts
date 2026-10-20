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
      'enforces FORCE RLS and tenant-bound policies on every public table with tenant_id',
      async () => {
        const result =
          await database.query<{
            relname: string;
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
            has_permissive_policy: boolean;
            has_restrictive_policy: boolean;
          }>(
            `
            SELECT
              c.relname,
              c.relrowsecurity,
              c.relforcerowsecurity,
              EXISTS (
                SELECT 1
                FROM pg_policy p
                WHERE p.polrelid = c.oid
                  AND p.polpermissive
              ) AS has_permissive_policy,
              (
                EXISTS (
                  SELECT 1
                  FROM pg_policy p
                  WHERE p.polrelid = c.oid
                    AND p.polname = 'fo_privacy_scope_enforce'
                    AND NOT p.polpermissive
                    AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%factoryos_current_tenant_id%'
                    AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%factoryos_current_tenant_id%'
                    AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%tenant_id%'
                    AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%tenant_id%'
                )
                OR (
                  c.relname = 'ai_tool_registry'
                  AND EXISTS (
                    SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                      AND p.polname = 'ai_tool_registry_select_scope' AND p.polcmd = 'r'
                      AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%factoryos_current_tenant_id%'
                  )
                  AND EXISTS (
                    SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                      AND p.polname = 'ai_tool_registry_insert_tenant_scope' AND p.polcmd = 'a'
                      AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%factoryos_current_tenant_id%'
                  )
                )
              ) AS has_restrictive_policy
            FROM pg_class c
            INNER JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND EXISTS (
                SELECT 1
                FROM pg_attribute a
                WHERE a.attrelid = c.oid
                  AND a.attname = 'tenant_id'
                  AND a.attnum > 0
                  AND NOT a.attisdropped
              )
            ORDER BY c.relname
            `,
          );

        expect(result.rows.length).toBeGreaterThan(0);

        for (const row of result.rows) {
          expect(row.relrowsecurity).toBe(true);
          expect(row.relforcerowsecurity).toBe(true);
          expect(row.has_permissive_policy).toBe(true);
          expect(row.has_restrictive_policy).toBe(true);
        }
      },
    );
  },
);