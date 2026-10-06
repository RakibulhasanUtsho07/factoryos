import {
  randomUUID,
} from 'node:crypto';

import {
  Pool,
} from 'pg';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

import {
  CbbService,
} from './cbb.service';

describe(
  'CbbService PostgreSQL integration',
  () => {
    const runId =
      randomUUID();

    let adminPool!:
      Pool;

    let appPool!:
      Pool;

    let service!:
      CbbService;

    let tenantAId!:
      string;

    let tenantBId!:
      string;

    let factoryAId!:
      string;

    let factoryBId!:
      string;

    let blueprintAId!:
      string;

    let blueprintBId!:
      string;

    let versionAId!:
      string;

    let versionBId!:
      string;

    // ==========================================================
    // SETUP
    // ==========================================================

    beforeAll(
      async () => {
        const databaseUrl =
          process.env
            .DATABASE_URL;

        const testAdminDatabaseUrl =
          process.env
            .TEST_ADMIN_DATABASE_URL;

        if (!databaseUrl) {
          throw new Error(
            'DATABASE_URL is required.',
          );
        }

        if (!testAdminDatabaseUrl) {
          throw new Error(
            'TEST_ADMIN_DATABASE_URL is required.',
          );
        }

        /*
         * The application runtime MUST use the restricted role.
         *
         * The privileged connection is used only for:
         *
         * - fixture creation
         * - authoritative assertions
         * - cleanup
         */
        const appDatabaseUrl =
          new URL(
            databaseUrl,
          );

        const adminDatabaseUrl =
          new URL(
            testAdminDatabaseUrl,
          );

        expect(
          decodeURIComponent(
            appDatabaseUrl.username,
          ),
        ).toBe(
          'factoryos_app',
        );

        expect(
          decodeURIComponent(
            adminDatabaseUrl.username,
          ),
        ).toBe(
          'factoryos',
        );

        adminPool =
          new Pool({
            connectionString:
              testAdminDatabaseUrl,
          });

        appPool =
          new Pool({
            connectionString:
              databaseUrl,
          });

        /*
         * The service itself receives the application database
         * adapter, never the privileged test/admin pool.
         */
        const database =
          createIntegrationDatabase(
            appPool,
          );

        service =
          new CbbService(
            database as never,
          );

        // ========================================================
        // TEMPORARY TENANTS
        // ========================================================

        tenantAId =
          randomUUID();

        tenantBId =
          randomUUID();

        await adminPool.query(
          `
          INSERT INTO tenants (
            id,
            slug,
            name,
            status,
            timezone,
            default_locale
          )

          VALUES
          (
            $1,
            $2,
            $3,
            'ACTIVE',
            'Asia/Dhaka',
            'en-BD'
          ),
          (
            $4,
            $5,
            $6,
            'ACTIVE',
            'Asia/Dhaka',
            'en-BD'
          )
          `,
          [
            tenantAId,

            `cbb-a-${runId}`,

            'CBB Integration Tenant A',

            tenantBId,

            `cbb-b-${runId}`,

            'CBB Integration Tenant B',
          ],
        );

        // ========================================================
        // TEMPORARY FACTORIES
        // ========================================================

        factoryAId =
          randomUUID();

        factoryBId =
          randomUUID();

        await adminPool.query(
          `
          INSERT INTO factories (
            id,
            tenant_id,
            legal_entity_id,
            code,
            name,
            status,
            timezone
          )

          VALUES
          (
            $1,
            $2,
            NULL,
            $3,
            $4,
            'ACTIVE',
            'Asia/Dhaka'
          ),
          (
            $5,
            $6,
            NULL,
            $7,
            $8,
            'ACTIVE',
            'Asia/Dhaka'
          )
          `,
          [
            factoryAId,

            tenantAId,

            `CBB-FAC-A-${runId}`,

            'CBB Integration Factory A',

            factoryBId,

            tenantBId,

            `CBB-FAC-B-${runId}`,

            'CBB Integration Factory B',
          ],
        );

        // ========================================================
        // PRIVATE BLUEPRINTS
        // ========================================================

        blueprintAId =
          randomUUID();

        blueprintBId =
          randomUUID();

        await adminPool.query(
          `
          INSERT INTO business_blueprints (
            id,
            tenant_id,
            factory_id,
            status
          )

          VALUES
          (
            $1,
            $2,
            $3,
            'ACTIVE'
          ),
          (
            $4,
            $5,
            $6,
            'ACTIVE'
          )
          `,
          [
            blueprintAId,

            tenantAId,

            factoryAId,

            blueprintBId,

            tenantBId,

            factoryBId,
          ],
        );

        // ========================================================
        // IMMUTABLE BLUEPRINT VERSIONS
        // ========================================================

        versionAId =
          randomUUID();

        versionBId =
          randomUUID();

        await adminPool.query(
          `
          INSERT INTO business_blueprint_versions (
            id,
            tenant_id,
            factory_id,
            blueprint_id,
            version,
            graph_hash,
            evidence_count,
            readiness_score,
            status,
            change_reason
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            1,
            'cbb-integration-a',
            1,
            0.75,
            'ACTIVE',
            'CBB integration fixture A'
          ),
          (
            $5,
            $6,
            $7,
            $8,
            1,
            'cbb-integration-b',
            1,
            0.50,
            'ACTIVE',
            'CBB integration fixture B'
          )
          `,
          [
            versionAId,

            tenantAId,

            factoryAId,

            blueprintAId,

            versionBId,

            tenantBId,

            factoryBId,

            blueprintBId,
          ],
        );

        await adminPool.query(
          `
          UPDATE business_blueprints
          SET
            current_version_id = CASE
              WHEN id = $1
                THEN $3
              WHEN id = $2
                THEN $4
              ELSE current_version_id
            END,

            updated_at = NOW()

          WHERE
            id IN (
              $1,
              $2
            )
          `,
          [
            blueprintAId,

            blueprintBId,

            versionAId,

            versionBId,
          ],
        );

        // ========================================================
        // FACTORY A GRAPH
        // ========================================================

        const verifiedEntityId =
          randomUUID();

        const inferredEntityId =
          randomUUID();

        const proposedEntityId =
          randomUUID();

        const secondVerifiedEntityId =
          randomUUID();

        await adminPool.query(
          `
          INSERT INTO business_entities (
            id,
            tenant_id,
            factory_id,
            blueprint_version_id,
            entity_type,
            name,
            description,
            state,
            confidence,
            metadata
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            'DEPARTMENT',
            'Production',
            'Verified production department',
            'VERIFIED',
            0.99,
            '{"source":"integration-test"}'::jsonb
          ),
          (
            $5,
            $2,
            $3,
            $4,
            'ROLE',
            'Planner',
            'Inferred planning role',
            'INFERRED',
            0.72,
            '{"source":"integration-test"}'::jsonb
          ),
          (
            $6,
            $2,
            $3,
            $4,
            'DEPARTMENT',
            'Hidden Proposed Node',
            'Must not appear in normal retrieval',
            'PROPOSED',
            0.50,
            '{}'::jsonb
          ),
          (
            $7,
            $2,
            $3,
            $4,
            'SYSTEM',
            'ERP',
            'Verified ERP system',
            'VERIFIED',
            1.00,
            '{}'::jsonb
          )
          `,
          [
            verifiedEntityId,

            tenantAId,

            factoryAId,

            versionAId,

            inferredEntityId,

            proposedEntityId,

            secondVerifiedEntityId,
          ],
        );

        // ========================================================
        // FACTORY A RELATION
        // ========================================================

        await adminPool.query(
          `
          INSERT INTO business_relations (
            tenant_id,
            factory_id,
            blueprint_version_id,
            from_entity_id,
            to_entity_id,
            relation_type,
            state,
            confidence,
            metadata
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'USES',
            'VERIFIED',
            0.98,
            '{}'::jsonb
          )
          `,
          [
            tenantAId,

            factoryAId,

            versionAId,

            verifiedEntityId,

            secondVerifiedEntityId,
          ],
        );

        // ========================================================
        // FACTORY A PROCESS
        // ========================================================

        const processAId =
          randomUUID();

        await adminPool.query(
          `
          INSERT INTO business_processes (
            id,
            tenant_id,
            factory_id,
            blueprint_version_id,
            name,
            description,
            owner_ref,
            state,
            confidence,
            metadata
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            'Order Fulfillment',
            'Factory A fulfillment process',
            'operations',
            'VERIFIED',
            0.97,
            '{"source":"integration-test"}'::jsonb
          )
          `,
          [
            processAId,

            tenantAId,

            factoryAId,

            versionAId,
          ],
        );

        await adminPool.query(
          `
          INSERT INTO business_process_steps (
            tenant_id,
            factory_id,
            blueprint_version_id,
            process_id,
            sequence_no,
            name,
            description,
            owner_ref,
            inputs,
            outputs,
            state,
            confidence,
            metadata
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            1,
            'Pick',
            'Verified pick step',
            'warehouse',
            '[]'::jsonb,
            '[]'::jsonb,
            'VERIFIED',
            0.98,
            '{}'::jsonb
          ),
          (
            $1,
            $2,
            $3,
            $4,
            2,
            'Hidden proposed step',
            'Must not appear in normal retrieval',
            'warehouse',
            '[]'::jsonb,
            '[]'::jsonb,
            'PROPOSED',
            0.50,
            '{}'::jsonb
          )
          `,
          [
            tenantAId,

            factoryAId,

            versionAId,

            processAId,
          ],
        );

        // ========================================================
        // FACTORY A EVIDENCE
        // ========================================================

        const evidenceAId =
          randomUUID();

        await adminPool.query(
          `
          INSERT INTO business_evidence (
            id,
            tenant_id,
            factory_id,
            source_type,
            source_ref,
            source_timestamp,
            evidence_grade,
            confidence,
            state,
            content_hash,
            visibility,
            metadata
          )

          VALUES (
            $1,
            $2,
            $3,
            'DOCUMENT',
            'integration/cbb-a',
            NOW(),
            'AUTHORITATIVE',
            1.00,
            'VERIFIED',
            'hash-cbb-a',
            'INTERNAL',
            '{"source":"integration-test"}'::jsonb
          )
          `,
          [
            evidenceAId,

            tenantAId,

            factoryAId,
          ],
        );

        // ========================================================
        // FACTORY A PROPOSAL
        // ========================================================

        await adminPool.query(
          `
          INSERT INTO business_change_proposals (
            tenant_id,
            factory_id,
            blueprint_id,
            target_type,
            target_id,
            proposal_type,
            proposed_state,
            proposed_payload,
            status,
            reason
          )

          VALUES (
            $1,
            $2,
            $3,
            'ENTITY',
            $4,
            'ADD_ENTITY',
            'PROPOSED',
            '{"name":"Candidate"}'::jsonb,
            'PENDING',
            'Integration proposal'
          )
          `,
          [
            tenantAId,

            factoryAId,

            blueprintAId,

            proposedEntityId,
          ],
        );

        // ========================================================
        // FACTORY A CONFLICT
        // ========================================================

        await adminPool.query(
          `
          INSERT INTO business_conflicts (
            tenant_id,
            factory_id,
            blueprint_id,
            subject_type,
            subject_id,
            status,
            description,
            evidence_refs
          )

          VALUES (
            $1,
            $2,
            $3,
            'ENTITY',
            $4,
            'OPEN',
            'Integration conflict',
            jsonb_build_array($5::text)
          )
          `,
          [
            tenantAId,

            factoryAId,

            blueprintAId,

            verifiedEntityId,

            evidenceAId,
          ],
        );

        // ========================================================
        // FACTORY B GRAPH
        // ========================================================

        await adminPool.query(
          `
          INSERT INTO business_entities (
            tenant_id,
            factory_id,
            blueprint_version_id,
            entity_type,
            name,
            state,
            confidence,
            metadata
          )

          VALUES (
            $1,
            $2,
            $3,
            'DEPARTMENT',
            'Factory B Production',
            'VERIFIED',
            0.95,
            '{"tenant":"B"}'::jsonb
          )
          `,
          [
            tenantBId,

            factoryBId,

            versionBId,
          ],
        );
      },
      60_000,
    );

    // ==========================================================
    // CLEANUP
    // ==========================================================

    afterAll(
      async () => {
        if (adminPool) {
          /*
           * CBB graph/version rows are immutable in production.
           *
           * Test cleanup therefore temporarily disables only the
           * CBB immutability triggers on this privileged fixture
           * connection.
           *
           * The application runtime never receives adminPool.
           */
          const immutableTables = [
            'business_blueprint_versions',
            'business_entities',
            'business_relations',
            'business_processes',
            'business_process_steps',
            'business_rules',
            'business_terms',
            'business_exceptions',
          ];

          try {
            for (
              const table
              of immutableTables
            ) {
              await adminPool.query(
                `
                ALTER TABLE ${table}
                DISABLE TRIGGER USER
                `,
              );
            }

            /*
             * Clear current-version pointers before removing the
             * immutable version rows because business_blueprints
             * references the current version.
             */
            if (
              tenantAId ||
              tenantBId
            ) {
              await adminPool.query(
                `
                UPDATE business_blueprints
                SET
                  current_version_id = NULL,
                  updated_at = NOW()
                WHERE
                  tenant_id IN (
                    $1,
                    $2
                  )
                `,
                [
                  tenantAId,
                  tenantBId,
                ],
              );
            }

            /*
             * Evidence has no blueprint FK, so explicitly remove
             * it before tenant cleanup.
             */
            await adminPool.query(
              `
              DELETE FROM business_evidence
              WHERE
                tenant_id IN (
                  $1,
                  $2
                )
              `,
              [
                tenantAId,
                tenantBId,
              ],
            );

            await adminPool.query(
              `
              DELETE FROM business_feedback
              WHERE
                tenant_id IN (
                  $1,
                  $2
                )
              `,
              [
                tenantAId,
                tenantBId,
              ],
            );

            /*
             * Blueprint deletion cascades into:
             *
             * - blueprint versions
             * - versioned graph objects
             * - proposals
             * - conflicts
             */
            await adminPool.query(
              `
              DELETE FROM business_blueprints
              WHERE
                tenant_id IN (
                  $1,
                  $2
                )
              `,
              [
                tenantAId,
                tenantBId,
              ],
            );

            /*
             * Factories cascade to business_acl and other
             * factory-scoped children.
             */
            await adminPool.query(
              `
              DELETE FROM factories
              WHERE
                id IN (
                  $1,
                  $2
                )
              `,
              [
                factoryAId,
                factoryBId,
              ],
            );

            await adminPool.query(
              `
              DELETE FROM tenants
              WHERE
                id IN (
                  $1,
                  $2
                )
              `,
              [
                tenantAId,
                tenantBId,
              ],
            );
          } finally {
            for (
              const table
              of immutableTables
            ) {
              await adminPool.query(
                `
                ALTER TABLE ${table}
                ENABLE TRIGGER USER
                `,
              );
            }
          }

          await adminPool.end();
        }

        if (appPool) {
          await appPool.end();
        }
      },
      60_000,
    );

    // ==========================================================
    // RLS WITHOUT CONTEXT
    // ==========================================================

    it(
      'returns zero CBB rows without tenant context',
      async () => {
        const result =
          await appPool.query<{
            count: string;
          }>(
            `
            SELECT
              COUNT(*)::text AS count

            FROM business_blueprints
            `,
          );

        expect(
          Number(
            result.rows[0]?.count,
          ),
        ).toBe(0);
      },
    );

    // ==========================================================
    // TENANT A / FACTORY A
    // ==========================================================

    it(
      'returns only Tenant A Factory A CBB data',
      async () => {
        const result =
          await service.getBusinessModel(
            tenantAId,
            factoryAId,
          );

        expect(
          result,
        ).not.toBeNull();

        expect(
          result?.tenantId,
        ).toBe(
          tenantAId,
        );

        expect(
          result?.factoryId,
        ).toBe(
          factoryAId,
        );

        expect(
          result?.currentVersion.version,
        ).toBe(
          '1',
        );

        expect(
          result?.counts.entities,
        ).toBe(
          4,
        );

        expect(
          result?.counts.relations,
        ).toBe(
          1,
        );

        expect(
          result?.counts.processes,
        ).toBe(
          1,
        );

        expect(
          result?.counts.processSteps,
        ).toBe(
          2,
        );

        expect(
          result?.counts.evidence,
        ).toBe(
          1,
        );

        expect(
          result?.counts.pendingChangeProposals,
        ).toBe(
          1,
        );

        expect(
          result?.counts.openConflicts,
        ).toBe(
          1,
        );
      },
    );

    // ==========================================================
    // NORMAL BUSINESS MAP RETRIEVAL
    // ==========================================================
it(
  'returns VERIFIED and INFERRED graph items only',
  async () => {
    const result =
      await service.getBusinessMap(
        tenantAId,
        factoryAId,
      );

    expect(
      result,
    ).not.toBeNull();

    const nodes =
      result?.nodes ?? [];

    expect(
      nodes,
    ).toHaveLength(
      3,
    );

    /*
     * Retrieval correctness is more important than the SQL
     * presentation order.
     *
     * The service intentionally orders by:
     *
     *   VERIFIED first,
     *   then entity_type,
     *   then name.
     *
     * Therefore the API is allowed to return:
     *
     *   Production
     *   ERP
     *   Planner
     *
     * instead of a fixed alphabetical order.
     */
    expect(
      nodes.map(
        (node) =>
          node.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        'ERP',
        'Production',
        'Planner',
      ]),
    );

    /*
     * PROPOSED items must never appear in normal retrieval.
     */
    expect(
      nodes.some(
        (node) =>
          node.name ===
          'Hidden Proposed Node',
      ),
    ).toBe(
      false,
    );

    /*
     * INFERRED remains visible but explicitly labelled.
     */
    const planner =
      nodes.find(
        (node) =>
          node.name ===
          'Planner',
      );

    expect(
      planner,
    ).toBeDefined();

    expect(
      planner?.state,
    ).toBe(
      'INFERRED',
    );

    expect(
      planner?.inferred,
    ).toBe(
      true,
    );

    /*
     * Only the visible verified relation should be returned.
     */
    expect(
      result?.edges,
    ).toHaveLength(
      1,
    );

    /*
     * The retrieval contract must continue to exclude:
     *
     *   PROPOSED
     *   CONFLICTING
     *   STALE
     */
    expect(
      result?.retrieval.excludedStates,
    ).toEqual([
      'PROPOSED',
      'CONFLICTING',
      'STALE',
    ]);
  },
);
    // ==========================================================
    // PROCESS RETRIEVAL
    // ==========================================================

    it(
      'returns the current process and excludes proposed steps',
      async () => {
        const list =
          await service.listProcesses(
            tenantAId,
            factoryAId,
          );

        expect(
          list,
        ).not.toBeNull();

        expect(
          list?.items,
        ).toHaveLength(
          1,
        );

        const process =
          list?.items[0];

        if (!process) {
          throw new Error(
            'Expected CBB process is missing.',
          );
        }

        const detail =
          await service.getProcess(
            tenantAId,
            factoryAId,
            process.id,
          );

        expect(
          detail,
        ).not.toBeNull();

        expect(
          detail?.steps,
        ).toHaveLength(
          1,
        );

        expect(
          detail?.steps[0]?.name,
        ).toBe(
          'Pick',
        );

        expect(
          detail?.steps[0]?.state,
        ).toBe(
          'VERIFIED',
        );
      },
    );

    // ==========================================================
    // FACTORY SCOPE
    // ==========================================================

    it(
      'does not return Tenant A data through Factory B scope',
      async () => {
        const result =
          await service.getBusinessModel(
            tenantAId,
            factoryBId,
          );

        expect(
          result,
        ).toBeNull();
      },
    );

    // ==========================================================
    // TENANT ISOLATION
    // ==========================================================

    it(
      'does not return Tenant B data through Tenant A context',
      async () => {
        const result =
          await service.getBusinessModel(
            tenantAId,
            factoryBId,
          );

        expect(
          result,
        ).toBeNull();
      },
    );

    it(
      'returns Tenant B data only in Tenant B context',
      async () => {
        const result =
          await service.getBusinessMap(
            tenantBId,
            factoryBId,
          );

        expect(
          result,
        ).not.toBeNull();

        expect(
          result?.tenantId,
        ).toBe(
          tenantBId,
        );

        expect(
          result?.factoryId,
        ).toBe(
          factoryBId,
        );

        expect(
          result?.nodes,
        ).toHaveLength(
          1,
        );

        expect(
          result?.nodes[0]?.name,
        ).toBe(
          'Factory B Production',
        );
      },
    );

    // ==========================================================
    // INVALID SCOPE
    // ==========================================================

    it(
      'rejects an invalid tenant UUID',
      async () => {
        await expect(
          service.getBusinessModel(
            'not-a-uuid',
            factoryAId,
          ),
        ).rejects.toThrow(
          'tenantId must be a valid UUID',
        );
      },
    );
  },
);