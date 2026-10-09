import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';

import {
  isUUID,
} from 'class-validator';

import type {
  QueryResultRow,
} from 'pg';

import {
  DatabaseService,
} from '../database/database.service';

export type CbbState =
  | 'VERIFIED'
  | 'INFERRED'
  | 'PROPOSED'
  | 'CONFLICTING'
  | 'STALE';

export type BusinessBlueprintStatus =
  | 'ACTIVE'
  | 'DISABLED'
  | 'ARCHIVED';

export type BusinessBlueprintVersionStatus =
  | 'PROPOSED'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'REJECTED';

interface BlueprintModelRow
  extends QueryResultRow {
  blueprint_id: string;
  tenant_id: string;
  factory_id: string;
  blueprint_status:
    BusinessBlueprintStatus;
  current_version_id: string;
  version: string;
  graph_hash:
    | string
    | null;
  evidence_count: number;
  readiness_score:
    | string
    | null;
  version_status:
    BusinessBlueprintVersionStatus;
  change_reason:
    | string
    | null;
  version_created_at: string;
}

interface CbbCountsRow
  extends QueryResultRow {
  entities_count: number;
  relations_count: number;
  processes_count: number;
  process_steps_count: number;
  rules_count: number;
  terms_count: number;
  exceptions_count: number;
  evidence_count: number;
  pending_change_proposals_count: number;
  open_conflicts_count: number;
}

interface CbbVersionRow
  extends QueryResultRow {
  blueprint_id: string;
  blueprint_status:
    BusinessBlueprintStatus;
  version_id: string;
  version: string;
  graph_hash:
    | string
    | null;
  evidence_count: number;
  readiness_score:
    | string
    | null;
  version_status:
    BusinessBlueprintVersionStatus;
  change_reason:
    | string
    | null;
  created_at: string;
}

interface EntityRow
  extends QueryResultRow {
  id: string;
  entity_type: string;
  name: string;
  description:
    | string
    | null;
  state: CbbState;
  confidence:
    | number
    | string
    | null;
  metadata:
    Record<string, unknown>;
  created_at: string;
}

interface RelationRow
  extends QueryResultRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  state: CbbState;
  confidence:
    | number
    | string
    | null;
  metadata:
    Record<string, unknown>;
  created_at: string;
}

interface ProcessRow
  extends QueryResultRow {
  id: string;
  name: string;
  description:
    | string
    | null;
  owner_ref:
    | string
    | null;
  state: CbbState;
  confidence:
    | number
    | string
    | null;
  metadata:
    Record<string, unknown>;
  step_count: number;
  created_at: string;
}

interface ProcessDetailRow
  extends QueryResultRow {
  id: string;
  name: string;
  description:
    | string
    | null;
  owner_ref:
    | string
    | null;
  state: CbbState;
  confidence:
    | number
    | string
    | null;
  metadata:
    Record<string, unknown>;
  created_at: string;
}

interface ProcessStepRow
  extends QueryResultRow {
  id: string;
  process_id: string;
  sequence_no: number;
  name: string;
  description:
    | string
    | null;
  owner_ref:
    | string
    | null;
  inputs: unknown[];
  outputs: unknown[];
  state: CbbState;
  confidence:
    | number
    | string
    | null;
  metadata:
    Record<string, unknown>;
  created_at: string;
}

@Injectable()
export class CbbService {
  constructor(
    private readonly database:
      DatabaseService,
  ) {}

  // ============================================================
  // BUSINESS MODEL SUMMARY
  // ============================================================

  async getBusinessModel(
    tenantId: string,
    factoryId: string,
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    const blueprintResult =
      await this.database.query<BlueprintModelRow>(
        `
        SELECT
          b.id::text
            AS blueprint_id,

          b.tenant_id::text
            AS tenant_id,

          b.factory_id::text
            AS factory_id,

          b.status
            AS blueprint_status,

          b.current_version_id::text
            AS current_version_id,

          v.version::text
            AS version,

          v.graph_hash,

          v.evidence_count,

          v.readiness_score::text
            AS readiness_score,

          v.status
            AS version_status,

          v.change_reason,

          v.created_at::text
            AS version_created_at

        FROM business_blueprints b

        INNER JOIN business_blueprint_versions v
          ON v.id = b.current_version_id
         AND v.tenant_id = b.tenant_id
         AND v.factory_id = b.factory_id

        WHERE
          b.tenant_id = $1
          AND b.factory_id = $2

        LIMIT 1
        `,
        [
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    const blueprint =
      blueprintResult.rows[0];

    if (!blueprint) {
      return null;
    }

    const countsResult =
      await this.database.query<CbbCountsRow>(
        `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM business_entities e
            WHERE
              e.tenant_id = $1
              AND e.factory_id = $2
              AND e.blueprint_version_id = $3
          )
          AS entities_count,

          (
            SELECT COUNT(*)::int
            FROM business_relations r
            WHERE
              r.tenant_id = $1
              AND r.factory_id = $2
              AND r.blueprint_version_id = $3
          )
          AS relations_count,

          (
            SELECT COUNT(*)::int
            FROM business_processes p
            WHERE
              p.tenant_id = $1
              AND p.factory_id = $2
              AND p.blueprint_version_id = $3
          )
          AS processes_count,

          (
            SELECT COUNT(*)::int
            FROM business_process_steps ps
            WHERE
              ps.tenant_id = $1
              AND ps.factory_id = $2
              AND ps.blueprint_version_id = $3
          )
          AS process_steps_count,

          (
            SELECT COUNT(*)::int
            FROM business_rules r
            WHERE
              r.tenant_id = $1
              AND r.factory_id = $2
              AND r.blueprint_version_id = $3
          )
          AS rules_count,

          (
            SELECT COUNT(*)::int
            FROM business_terms t
            WHERE
              t.tenant_id = $1
              AND t.factory_id = $2
              AND t.blueprint_version_id = $3
          )
          AS terms_count,

          (
            SELECT COUNT(*)::int
            FROM business_exceptions e
            WHERE
              e.tenant_id = $1
              AND e.factory_id = $2
              AND e.blueprint_version_id = $3
          )
          AS exceptions_count,

          (
            SELECT COUNT(*)::int
            FROM business_evidence e
            WHERE
              e.tenant_id = $1
              AND e.factory_id = $2
          )
          AS evidence_count,

          (
            SELECT COUNT(*)::int
            FROM business_change_proposals cp
            WHERE
              cp.tenant_id = $1
              AND cp.factory_id = $2
              AND cp.status = 'PENDING'
          )
          AS pending_change_proposals_count,

          (
            SELECT COUNT(*)::int
            FROM business_conflicts c
            WHERE
              c.tenant_id = $1
              AND c.factory_id = $2
              AND c.status = 'OPEN'
          )
          AS open_conflicts_count
        `,
        [
          tenantId,
          factoryId,
          blueprint.current_version_id,
        ],
        {
          tenantId,
        },
      );

    const counts =
      countsResult.rows[0];

    if (!counts) {
      throw new Error(
        'CBB_COUNTS_QUERY_FAILED',
      );
    }

    return {
      tenantId:
        blueprint.tenant_id,

      factoryId:
        blueprint.factory_id,

      blueprint: {
        id:
          blueprint.blueprint_id,

        status:
          blueprint.blueprint_status,

        currentVersionId:
          blueprint.current_version_id,
      },

      currentVersion: {
        id:
          blueprint.current_version_id,

        version:
          blueprint.version,

        graphHash:
          blueprint.graph_hash,

        evidenceCount:
          blueprint.evidence_count,

        readinessScore:
          this.normalizeNullableNumber(
            blueprint.readiness_score,
          ),

        status:
          blueprint.version_status,

        changeReason:
          blueprint.change_reason,

        createdAt:
          blueprint.version_created_at,
      },

      counts: {
        entities:
          counts.entities_count,

        relations:
          counts.relations_count,

        processes:
          counts.processes_count,

        processSteps:
          counts.process_steps_count,

        rules:
          counts.rules_count,

        terms:
          counts.terms_count,

        exceptions:
          counts.exceptions_count,

        evidence:
          counts.evidence_count,

        pendingChangeProposals:
          counts.pending_change_proposals_count,

        openConflicts:
          counts.open_conflicts_count,
      },

      retrieval: {
        includedStates: [
          'VERIFIED',
          'INFERRED',
        ],

        excludedStates: [
          'PROPOSED',
          'CONFLICTING',
          'STALE',
        ],

        inferredItemsAreContextOnly:
          true,
      },
    };
  }

  // ============================================================
  // BUSINESS MAP
  // ============================================================

  async getBusinessMap(
    tenantId: string,
    factoryId: string,
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    const version =
      await this.getCurrentVersion(
        tenantId,
        factoryId,
      );

    if (!version) {
      return null;
    }

    const entitiesResult =
      await this.database.query<EntityRow>(
        `
        SELECT
          e.id::text AS id,
          e.entity_type,
          e.name,
          e.description,
          e.state,
          e.confidence,
          e.metadata,
          e.created_at::text AS created_at

        FROM business_entities e

        WHERE
          e.tenant_id = $1
          AND e.factory_id = $2
          AND e.blueprint_version_id = $3
          AND e.state IN (
            'VERIFIED',
            'INFERRED'
          )

        ORDER BY
          CASE
            WHEN e.state = 'VERIFIED'
              THEN 0
            WHEN e.state = 'INFERRED'
              THEN 1
            ELSE 2
          END,
          e.entity_type ASC,
          e.name ASC,
          e.created_at ASC
        `,
        [
          tenantId,
          factoryId,
          version.versionId,
        ],
        {
          tenantId,
        },
      );

    const relationsResult =
      await this.database.query<RelationRow>(
        `
        SELECT
          r.id::text AS id,

          r.from_entity_id::text
            AS from_entity_id,

          r.to_entity_id::text
            AS to_entity_id,

          r.relation_type,

          r.state,

          r.confidence,

          r.metadata,

          r.created_at::text
            AS created_at

        FROM business_relations r

        INNER JOIN business_entities from_entity
          ON from_entity.id = r.from_entity_id
         AND from_entity.tenant_id = r.tenant_id
         AND from_entity.factory_id = r.factory_id
         AND from_entity.blueprint_version_id =
           r.blueprint_version_id

        INNER JOIN business_entities to_entity
          ON to_entity.id = r.to_entity_id
         AND to_entity.tenant_id = r.tenant_id
         AND to_entity.factory_id = r.factory_id
         AND to_entity.blueprint_version_id =
           r.blueprint_version_id

        WHERE
          r.tenant_id = $1
          AND r.factory_id = $2
          AND r.blueprint_version_id = $3

          AND r.state IN (
            'VERIFIED',
            'INFERRED'
          )

          AND from_entity.state IN (
            'VERIFIED',
            'INFERRED'
          )

          AND to_entity.state IN (
            'VERIFIED',
            'INFERRED'
          )

        ORDER BY
          CASE
            WHEN r.state = 'VERIFIED'
              THEN 0
            WHEN r.state = 'INFERRED'
              THEN 1
            ELSE 2
          END,

          r.relation_type ASC,
          r.created_at ASC
        `,
        [
          tenantId,
          factoryId,
          version.versionId,
        ],
        {
          tenantId,
        },
      );

    return {
      tenantId,

      factoryId,

      version: {
        id:
          version.versionId,

        number:
          version.version,

        status:
          version.versionStatus,

        graphHash:
          version.graphHash,

        evidenceCount:
          version.evidenceCount,

        readinessScore:
          version.readinessScore,

        createdAt:
          version.createdAt,
      },

      nodes:
        entitiesResult.rows.map(
          (
            row,
          ) => ({
            id:
              row.id,

            type:
              row.entity_type,

            name:
              row.name,

            description:
              row.description,

            state:
              row.state,

            inferred:
              row.state ===
              'INFERRED',

            confidence:
              this.normalizeNullableNumber(
                row.confidence,
              ),

            metadata:
              row.metadata,

            createdAt:
              row.created_at,
          }),
        ),

      edges:
        relationsResult.rows.map(
          (
            row,
          ) => ({
            id:
              row.id,

            fromEntityId:
              row.from_entity_id,

            toEntityId:
              row.to_entity_id,

            relationType:
              row.relation_type,

            state:
              row.state,

            inferred:
              row.state ===
              'INFERRED',

            confidence:
              this.normalizeNullableNumber(
                row.confidence,
              ),

            metadata:
              row.metadata,

            createdAt:
              row.created_at,
          }),
        ),

      retrieval: {
        preferredState:
          'VERIFIED',

        includedStates: [
          'VERIFIED',
          'INFERRED',
        ],

        excludedStates: [
          'PROPOSED',
          'CONFLICTING',
          'STALE',
        ],
      },
    };
  }

  // ============================================================
  // PROCESS LIST
  // ============================================================

  async listProcesses(
    tenantId: string,
    factoryId: string,
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    const version =
      await this.getCurrentVersion(
        tenantId,
        factoryId,
      );

    if (!version) {
      return null;
    }

    const result =
      await this.database.query<ProcessRow>(
        `
        SELECT
          p.id::text AS id,

          p.name,

          p.description,

          p.owner_ref,

          p.state,

          p.confidence,

          p.metadata,

          COUNT(ps.id)::int
            AS step_count,

          p.created_at::text
            AS created_at

        FROM business_processes p

        LEFT JOIN business_process_steps ps
          ON ps.process_id = p.id
         AND ps.tenant_id = p.tenant_id
         AND ps.factory_id = p.factory_id
         AND ps.blueprint_version_id =
           p.blueprint_version_id

         AND ps.state IN (
           'VERIFIED',
           'INFERRED'
         )

        WHERE
          p.tenant_id = $1
          AND p.factory_id = $2
          AND p.blueprint_version_id = $3

          AND p.state IN (
            'VERIFIED',
            'INFERRED'
          )

        GROUP BY
          p.id,
          p.name,
          p.description,
          p.owner_ref,
          p.state,
          p.confidence,
          p.metadata,
          p.created_at

        ORDER BY
          CASE
            WHEN p.state = 'VERIFIED'
              THEN 0

            WHEN p.state = 'INFERRED'
              THEN 1

            ELSE 2
          END,

          p.name ASC,
          p.created_at ASC
        `,
        [
          tenantId,
          factoryId,
          version.versionId,
        ],
        {
          tenantId,
        },
      );

    return {
      tenantId,

      factoryId,

      version: {
        id:
          version.versionId,

        number:
          version.version,

        status:
          version.versionStatus,

        graphHash:
          version.graphHash,
      },

      items:
        result.rows.map(
          (
            row,
          ) => ({
            id:
              row.id,

            name:
              row.name,

            description:
              row.description,

            ownerRef:
              row.owner_ref,

            state:
              row.state,

            inferred:
              row.state ===
              'INFERRED',

            confidence:
              this.normalizeNullableNumber(
                row.confidence,
              ),

            metadata:
              row.metadata,

            stepCount:
              row.step_count,

            createdAt:
              row.created_at,
          }),
        ),

      count:
        result.rows.length,

      retrieval: {
        preferredState:
          'VERIFIED',

        includedStates: [
          'VERIFIED',
          'INFERRED',
        ],

        excludedStates: [
          'PROPOSED',
          'CONFLICTING',
          'STALE',
        ],
      },
    };
  }

  // ============================================================
  // PROCESS DETAIL
  // ============================================================

  async getProcess(
    tenantId: string,
    factoryId: string,
    processId: string,
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    this.validateUuid(
      processId,
      'processId',
    );

    const version =
      await this.getCurrentVersion(
        tenantId,
        factoryId,
      );

    if (!version) {
      return null;
    }

    const processResult =
      await this.database.query<ProcessDetailRow>(
        `
        SELECT
          p.id::text AS id,

          p.name,

          p.description,

          p.owner_ref,

          p.state,

          p.confidence,

          p.metadata,

          p.created_at::text
            AS created_at

        FROM business_processes p

        WHERE
          p.id = $1
          AND p.tenant_id = $2
          AND p.factory_id = $3
          AND p.blueprint_version_id = $4

          AND p.state IN (
            'VERIFIED',
            'INFERRED'
          )

        LIMIT 1
        `,
        [
          processId,
          tenantId,
          factoryId,
          version.versionId,
        ],
        {
          tenantId,
        },
      );

    const process =
      processResult.rows[0];

    if (!process) {
      return null;
    }

    const stepsResult =
      await this.database.query<ProcessStepRow>(
        `
        SELECT
          ps.id::text AS id,

          ps.process_id::text
            AS process_id,

          ps.sequence_no,

          ps.name,

          ps.description,

          ps.owner_ref,

          ps.inputs,

          ps.outputs,

          ps.state,

          ps.confidence,

          ps.metadata,

          ps.created_at::text
            AS created_at

        FROM business_process_steps ps

        WHERE
          ps.process_id = $1
          AND ps.tenant_id = $2
          AND ps.factory_id = $3
          AND ps.blueprint_version_id = $4

          AND ps.state IN (
            'VERIFIED',
            'INFERRED'
          )

        ORDER BY
          ps.sequence_no ASC
        `,
        [
          processId,
          tenantId,
          factoryId,
          version.versionId,
        ],
        {
          tenantId,
        },
      );

    return {
      tenantId,

      factoryId,

      version: {
        id:
          version.versionId,

        number:
          version.version,

        status:
          version.versionStatus,

        graphHash:
          version.graphHash,
      },

      process: {
        id:
          process.id,

        name:
          process.name,

        description:
          process.description,

        ownerRef:
          process.owner_ref,

        state:
          process.state,

        inferred:
          process.state ===
          'INFERRED',

        confidence:
          this.normalizeNullableNumber(
            process.confidence,
          ),

        metadata:
          process.metadata,

        createdAt:
          process.created_at,
      },

      steps:
        stepsResult.rows.map(
          (
            row,
          ) => ({
            id:
              row.id,

            processId:
              row.process_id,

            sequence:
              row.sequence_no,

            name:
              row.name,

            description:
              row.description,

            ownerRef:
              row.owner_ref,

            inputs:
              row.inputs,

            outputs:
              row.outputs,

            state:
              row.state,

            inferred:
              row.state ===
              'INFERRED',

            confidence:
              this.normalizeNullableNumber(
                row.confidence,
              ),

            metadata:
              row.metadata,

            createdAt:
              row.created_at,
          }),
        ),

      retrieval: {
        preferredState:
          'VERIFIED',

        includedStates: [
          'VERIFIED',
          'INFERRED',
        ],

        excludedStates: [
          'PROPOSED',
          'CONFLICTING',
          'STALE',
        ],
      },
    };
  }

  // ============================================================
  // PRIVATE: CURRENT VERSION
  // ============================================================

  private async getCurrentVersion(
    tenantId: string,
    factoryId: string,
  ) {
    const result =
      await this.database.query<CbbVersionRow>(
        `
        SELECT
          b.id::text
            AS blueprint_id,

          b.status
            AS blueprint_status,

          v.id::text
            AS version_id,

          v.version::text
            AS version,

          v.graph_hash,

          v.evidence_count,

          v.readiness_score::text
            AS readiness_score,

          v.status
            AS version_status,

          v.change_reason,

          v.created_at::text
            AS created_at

        FROM business_blueprints b

        INNER JOIN business_blueprint_versions v
          ON v.id = b.current_version_id
         AND v.tenant_id = b.tenant_id
         AND v.factory_id = b.factory_id

        WHERE
          b.tenant_id = $1
          AND b.factory_id = $2

        LIMIT 1
        `,
        [
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    const row =
      result.rows[0];

    if (!row) {
      return null;
    }

    return {
      blueprintId:
        row.blueprint_id,

      blueprintStatus:
        row.blueprint_status,

      versionId:
        row.version_id,

      version:
        row.version,

      graphHash:
        row.graph_hash,

      evidenceCount:
        row.evidence_count,

      readinessScore:
        this.normalizeNullableNumber(
          row.readiness_score,
        ),

      versionStatus:
        row.version_status,

      changeReason:
        row.change_reason,

      createdAt:
        row.created_at,
    };
  }

  // ============================================================
  // PRIVATE: VALIDATION
  // ============================================================

  private validateScope(
    tenantId: string,
    factoryId: string,
  ): void {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    this.validateUuid(
      factoryId,
      'factoryId',
    );
  }

  private validateUuid(
    value: string,
    field: string,
  ): void {
    if (!isUUID(value)) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  private normalizeNullableNumber(
    value:
      | number
      | string
      | null
      | undefined,
  ): number | null {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    const number =
      Number(value);

    return Number.isFinite(number)
      ? number
      : null;
  }
}