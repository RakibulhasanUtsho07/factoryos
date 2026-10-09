import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  createHash,
  randomUUID,
} from 'node:crypto';

import {
  isUUID,
} from 'class-validator';

import type {
  PoolClient,
  QueryResultRow,
} from 'pg';

import {
  BusinessChangeState,
  BusinessChangeTargetType,
} from './dto/create-business-change.dto';

import {
  BusinessChangeStatus,
} from './dto/list-business-changes.dto';

import {
  AuditService,
} from '../audit/audit.service';

import {
  DatabaseService,
} from '../database/database.service';

// ============================================================
// SHARED TYPES
// ============================================================

type JsonObject =
  Record<string, unknown>;

type PromotionOperation =
  | 'ADD'
  | 'UPDATE'
  | 'SET_STATE'
  | 'RETIRE';

// ============================================================
// CHANGE PROPOSAL
// ============================================================

interface PromotionProposalRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_id: string;

  source_version_id:
    | string
    | null;

  promoted_version_id:
    | string
    | null;

  promoted_at:
    | string
    | null;

  target_type:
    BusinessChangeTargetType;

  target_id:
    | string
    | null;

  proposal_type: string;

  proposed_state:
    | BusinessChangeState
    | null;

  proposed_payload:
    JsonObject;

  status:
    BusinessChangeStatus;

  reason:
    | string
    | null;

  requested_by:
    | string
    | null;

  decided_by:
    | string
    | null;

  requested_at: string;

  decided_at:
    | string
    | null;

  decision_reason:
    | string
    | null;
}

// ============================================================
// BLUEPRINT
// ============================================================

interface PromotionBlueprintRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  current_version_id:
    string;

  status:
    | 'ACTIVE'
    | 'DISABLED'
    | 'ARCHIVED';
}

// ============================================================
// SOURCE VERSION
// ============================================================

interface PromotionVersionRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_id: string;

  version:
    string;

  graph_hash:
    | string
    | null;

  evidence_count: number;

  readiness_score:
    | number
    | string
    | null;

  status:
    | 'PROPOSED'
    | 'ACTIVE'
    | 'SUPERSEDED'
    | 'REJECTED';

  change_reason:
    | string
    | null;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// ENTITY
// ============================================================

interface EntityGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_version_id:
    string;

  entity_type: string;

  name: string;

  description:
    | string
    | null;

  state:
    BusinessChangeState;

  confidence:
    | number
    | string
    | null;

  metadata:
    JsonObject;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// RELATION
// ============================================================

interface RelationGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_version_id:
    string;

  from_entity_id:
    string;

  to_entity_id:
    string;

  relation_type: string;

  state:
    BusinessChangeState;

  confidence:
    | number
    | string
    | null;

  metadata:
    JsonObject;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// PROCESS
// ============================================================

interface ProcessGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_version_id:
    string;

  name: string;

  description:
    | string
    | null;

  owner_ref:
    | string
    | null;

  state:
    BusinessChangeState;

  confidence:
    | number
    | string
    | null;

  metadata:
    JsonObject;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// PROCESS STEP
// ============================================================

interface ProcessStepGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_version_id:
    string;

  process_id:
    string;

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

  state:
    BusinessChangeState;

  confidence:
    | number
    | string
    | null;

  metadata:
    JsonObject;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// RULE
// ============================================================

interface RuleGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_version_id:
    string;

  name: string;

  rule_type: string;

  description:
    | string
    | null;

  expression_ref:
    | string
    | null;

  state:
    BusinessChangeState;

  confidence:
    | number
    | string
    | null;

  metadata:
    JsonObject;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// TERM
// ============================================================

interface TermGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_version_id:
    string;

  term: string;

  canonical_term: string;

  language_code:
    | string
    | null;

  source_system:
    | string
    | null;

  state:
    BusinessChangeState;

  confidence:
    | number
    | string
    | null;

  metadata:
    JsonObject;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// EXCEPTION
// ============================================================

interface ExceptionGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_version_id:
    string;

  name: string;

  description:
    | string
    | null;

  trigger_ref:
    | string
    | null;

  handling_ref:
    | string
    | null;

  state:
    BusinessChangeState;

  confidence:
    | number
    | string
    | null;

  metadata:
    JsonObject;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// EVIDENCE LINK
// ============================================================

interface EvidenceLinkGraphRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  evidence_id:
    string;

  target_type: string;

  target_id:
    string;

  link_type: string;

  created_by:
    | string
    | null;

  created_at: string;
}

// ============================================================
// MUTABLE CLONED GRAPH TYPES
// ============================================================

interface ClonedEntity
  extends EntityGraphRow {
  id: string;
}

interface ClonedRelation
  extends RelationGraphRow {
  id: string;
}

interface ClonedProcess
  extends ProcessGraphRow {
  id: string;
}

interface ClonedProcessStep
  extends ProcessStepGraphRow {
  id: string;
}

interface ClonedRule
  extends RuleGraphRow {
  id: string;
}

interface ClonedTerm
  extends TermGraphRow {
  id: string;
}

interface ClonedException
  extends ExceptionGraphRow {
  id: string;
}

interface ClonedEvidenceLink
  extends EvidenceLinkGraphRow {
  id: string;
}

// ============================================================
// ID MAPS
// ============================================================

interface GraphIdMaps {
  entities:
    Map<string, string>;

  relations:
    Map<string, string>;

  processes:
    Map<string, string>;

  processSteps:
    Map<string, string>;

  rules:
    Map<string, string>;

  terms:
    Map<string, string>;

  exceptions:
    Map<string, string>;
}

// ============================================================
// CLONED GRAPH
// ============================================================

interface ClonedGraph {
  entities:
    ClonedEntity[];

  relations:
    ClonedRelation[];

  processes:
    ClonedProcess[];

  processSteps:
    ClonedProcessStep[];

  rules:
    ClonedRule[];

  terms:
    ClonedTerm[];

  exceptions:
    ClonedException[];

  evidenceLinks:
    ClonedEvidenceLink[];

  idMaps:
    GraphIdMaps;
}

// ============================================================
// PROMOTION RESULT
// ============================================================

export interface CbbPromotionResult {
  tenantId: string;

  factoryId: string;

  proposalId: string;

  blueprintId: string;

  idempotent: boolean;

  sourceVersion: {
    id: string;

    version: number;
  };

  promotedVersion: {
    id: string;

    version: number;

    graphHash: string;

    evidenceCount: number;

    readinessScore:
      number
      | null;

    status: string;

    changeReason:
      string
      | null;

    createdAt: string;
  };

  proposal: {
    status: string;

    promotedVersionId: string;

    promotedAt: string;
  };
}

// ============================================================
// SERVICE
// ============================================================

@Injectable()
export class CbbPromotionService {
  constructor(
    private readonly database:
      DatabaseService,

    private readonly auditService:
      AuditService,
  ) {}

  // ============================================================
  // PROMOTE APPROVED CHANGE
  // ============================================================

  async promoteApprovedChange(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    proposalId: string,
  ): Promise<CbbPromotionResult> {
    this.validateScope(
      tenantId,
      factoryId,
    );

    this.validateUuid(
      actorUserId,
      'actorUserId',
    );

    this.validateUuid(
      proposalId,
      'proposalId',
    );

    const result =
      await this.database.transaction(
        async (
          client: PoolClient,
        ) => {
          // ----------------------------------------------------
          // LOCK PROPOSAL
          // ----------------------------------------------------

          const proposalResult =
            await client.query<PromotionProposalRow>(
              `
              SELECT
                cp.id::text AS id,

                cp.tenant_id::text
                  AS tenant_id,

                cp.factory_id::text
                  AS factory_id,

                cp.blueprint_id::text
                  AS blueprint_id,

                cp.source_version_id::text
                  AS source_version_id,

                cp.promoted_version_id::text
                  AS promoted_version_id,

                cp.promoted_at::text
                  AS promoted_at,

                cp.target_type,

                cp.target_id::text
                  AS target_id,

                cp.proposal_type,

                cp.proposed_state,

                cp.proposed_payload,

                cp.status,

                cp.reason,

                cp.requested_by::text
                  AS requested_by,

                cp.decided_by::text
                  AS decided_by,

                cp.requested_at::text
                  AS requested_at,

                cp.decided_at::text
                  AS decided_at,

                cp.decision_reason

              FROM business_change_proposals cp

              WHERE
                cp.id = $1

                AND cp.tenant_id = $2

                AND cp.factory_id = $3

              FOR UPDATE
              `,
              [
                proposalId,
                tenantId,
                factoryId,
              ],
            );

          const proposal =
            proposalResult.rows[0];

          if (!proposal) {
            throw new NotFoundException(
              'Business change proposal not found for this factory',
            );
          }

          if (
            proposal.status !==
            'APPROVED'
          ) {
            throw new ConflictException(
              `Business change proposal must be APPROVED before promotion; current status is ${proposal.status.toLowerCase()}`,
            );
          }

          // ----------------------------------------------------
          // IDEMPOTENT REPLAY
          // ----------------------------------------------------

          if (
            proposal.promoted_version_id
          ) {
            const promotedVersion =
              await this.getVersionById(
                client,
                tenantId,
                factoryId,
                proposal.promoted_version_id,
              );

            if (!promotedVersion) {
              throw new ConflictException(
                'Promotion record references a missing blueprint version',
              );
            }

            if (
              !proposal.source_version_id
            ) {
              throw new ConflictException(
                'Approved legacy proposal cannot be replayed because source_version_id is missing',
              );
            }

            return {
              tenantId,
              factoryId,
              proposalId:
                proposal.id,
              blueprintId:
                proposal.blueprint_id,
              idempotent:
                true,
              sourceVersion: {
                id:
                  proposal.source_version_id,
                version:
                  await this.getVersionNumberById(
                    client,
                    tenantId,
                    factoryId,
                    proposal.source_version_id,
                  ),
              },
              promotedVersion:
                this.mapPromotedVersion(
                  promotedVersion,
                ),
              proposal: {
                status:
                  proposal.status,
                promotedVersionId:
                  proposal.promoted_version_id,
                promotedAt:
                  proposal.promoted_at ??
                  promotedVersion.created_at,
              },
            } satisfies CbbPromotionResult;
          }

          // ----------------------------------------------------
          // SOURCE VERSION IS REQUIRED
          // ----------------------------------------------------

          if (
            !proposal.source_version_id
          ) {
            throw new ConflictException(
              'Approved legacy proposal cannot be promoted because source_version_id is missing',
            );
          }

          // ----------------------------------------------------
          // LOCK BLUEPRINT
          // ----------------------------------------------------

          const blueprintResult =
            await client.query<PromotionBlueprintRow>(
              `
              SELECT
                b.id::text AS id,

                b.tenant_id::text
                  AS tenant_id,

                b.factory_id::text
                  AS factory_id,

                b.current_version_id::text
                  AS current_version_id,

                b.status

              FROM business_blueprints b

              WHERE
                b.id = $1

                AND b.tenant_id = $2

                AND b.factory_id = $3

              FOR UPDATE
              `,
              [
                proposal.blueprint_id,
                tenantId,
                factoryId,
              ],
            );

          const blueprint =
            blueprintResult.rows[0];

          if (!blueprint) {
            throw new NotFoundException(
              'Business blueprint not found for this factory',
            );
          }

          // ----------------------------------------------------
          // SOURCE MUST STILL BE CURRENT
          // ----------------------------------------------------

          if (
            blueprint.current_version_id !==
            proposal.source_version_id
          ) {
            throw new ConflictException(
              'Business change proposal is stale because the factory business model has already advanced',
            );
          }

          // ----------------------------------------------------
          // LOAD SOURCE VERSION
          // ----------------------------------------------------

          const sourceVersionResult =
            await client.query<PromotionVersionRow>(
              `
              SELECT
                v.id::text AS id,

                v.tenant_id::text
                  AS tenant_id,

                v.factory_id::text
                  AS factory_id,

                v.blueprint_id::text
                  AS blueprint_id,

                v.version::text
                  AS version,

                v.graph_hash,

                v.evidence_count,

                v.readiness_score,

                v.status,

                v.change_reason,

                v.created_by::text
                  AS created_by,

                v.created_at::text
                  AS created_at

              FROM business_blueprint_versions v

              WHERE
                v.id = $1

                AND v.tenant_id = $2

                AND v.factory_id = $3

                AND v.blueprint_id = $4

              FOR SHARE
              `,
              [
                proposal.source_version_id,
                tenantId,
                factoryId,
                proposal.blueprint_id,
              ],
            );

          const sourceVersion =
            sourceVersionResult.rows[0];

          if (!sourceVersion) {
            throw new NotFoundException(
              'Proposal source blueprint version was not found',
            );
          }

          // ----------------------------------------------------
          // LOAD CURRENT GRAPH
          // ----------------------------------------------------

          const graph =
            await this.loadAndCloneGraph(
              client,
              tenantId,
              factoryId,
              sourceVersion.id,
              blueprint.id,
            );

          // ----------------------------------------------------
          // APPLY APPROVED PROPOSAL
          // ----------------------------------------------------

          const blueprintStatus =
            this.applyProposal(
              graph,
              proposal,
              blueprint,
            );

          // ----------------------------------------------------
          // NEXT VERSION NUMBER
          // ----------------------------------------------------

          const nextVersionResult =
            await client.query<{
              next_version: string;
            }>(
              `
              SELECT
                (
                  COALESCE(
                    MAX(v.version),
                    0
                  ) + 1
                )::text
                  AS next_version

              FROM business_blueprint_versions v

              WHERE
                v.blueprint_id = $1

                AND v.tenant_id = $2

                AND v.factory_id = $3
              `,
              [
                blueprint.id,
                tenantId,
                factoryId,
              ],
            );

          const nextVersionRow =
            nextVersionResult.rows[0];

          if (!nextVersionRow) {
            throw new Error(
              'CBB_NEXT_VERSION_QUERY_FAILED',
            );
          }

          const nextVersion =
            Number(
              nextVersionRow.next_version,
            );

          if (
            !Number.isSafeInteger(
              nextVersion,
            ) ||
            nextVersion < 1
          ) {
            throw new ConflictException(
              'Unable to determine the next CBB blueprint version',
            );
          }

          // ----------------------------------------------------
          // GRAPH HASH
          // ----------------------------------------------------

          const graphHash =
            this.computeGraphHash(
              graph,
              blueprint.id,
              nextVersion,
              blueprintStatus,
            );

          // ----------------------------------------------------
          // CREATE IMMUTABLE VERSION
          // ----------------------------------------------------

          const versionId =
            randomUUID();

          const changeReason =
            this.buildChangeReason(
              proposal,
              sourceVersion,
            );

          const newVersionResult =
            await client.query<PromotionVersionRow>(
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
                change_reason,
                created_by
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
                'ACTIVE',
                $9,
                $10
              )

              RETURNING
                id::text AS id,

                tenant_id::text
                  AS tenant_id,

                factory_id::text
                  AS factory_id,

                blueprint_id::text
                  AS blueprint_id,

                version::text
                  AS version,

                graph_hash,

                evidence_count,

                readiness_score,

                status,

                change_reason,

                created_by::text
                  AS created_by,

                created_at::text
                  AS created_at
              `,
              [
                versionId,
                tenantId,
                factoryId,
                blueprint.id,
                nextVersion,
                graphHash,
                sourceVersion.evidence_count,
                sourceVersion.readiness_score,
                changeReason,
                actorUserId,
              ],
            );

          const newVersion =
            newVersionResult.rows[0];

          if (!newVersion) {
            throw new Error(
              'CBB_VERSION_INSERT_FAILED',
            );
          }

          // ----------------------------------------------------
          // UPDATE VERSION IDS ON CLONED GRAPH
          // ----------------------------------------------------

          this.setGraphVersionScope(
            graph,
            tenantId,
            factoryId,
            versionId,
          );

          // ----------------------------------------------------
          // INSERT CLONED GRAPH
          // ----------------------------------------------------

          await this.insertGraph(
            client,
            graph,
          );

          // ----------------------------------------------------
          // PROMOTE CURRENT POINTER
          // ----------------------------------------------------
          //
          // IMPORTANT:
          //
          // We NEVER update/delete:
          //
          //   business_blueprint_versions
          //   business_entities
          //   business_relations
          //   business_processes
          //   business_process_steps
          //   business_rules
          //   business_terms
          //   business_exceptions
          //
          // Only the stable blueprint current_version_id is
          // advanced.
          // ----------------------------------------------------

          const blueprintPromotionResult =
            await client.query<{
              id: string;
              current_version_id:
                string;
              status:
                | 'ACTIVE'
                | 'DISABLED'
                | 'ARCHIVED';
            }>(
              `
              UPDATE business_blueprints

              SET
                current_version_id = $1,

                status = $2,

                updated_at = NOW()

              WHERE
                id = $3

                AND tenant_id = $4

                AND factory_id = $5

                AND current_version_id = $6

              RETURNING
                id::text AS id,

                current_version_id::text
                  AS current_version_id,

                status
              `,
              [
                versionId,
                blueprintStatus,
                blueprint.id,
                tenantId,
                factoryId,
                sourceVersion.id,
              ],
            );

          const promotedBlueprint =
            blueprintPromotionResult.rows[0];

          if (!promotedBlueprint) {
            throw new ConflictException(
              'Business blueprint changed while promotion was in progress',
            );
          }

          // ----------------------------------------------------
          // MARK PROPOSAL PROMOTED
          // ----------------------------------------------------

          const proposalPromotionResult =
            await client.query<{
              id: string;

              status: BusinessChangeStatus;

              promoted_version_id:
                string;

              promoted_at:
                string;
            }>(
              `
              UPDATE business_change_proposals

              SET
                promoted_version_id = $1,

                promoted_at = NOW()

              WHERE
                id = $2

                AND tenant_id = $3

                AND factory_id = $4

                AND status = 'APPROVED'

                AND promoted_version_id IS NULL

              RETURNING
                id::text AS id,

                status,

                promoted_version_id::text
                  AS promoted_version_id,

                promoted_at::text
                  AS promoted_at
              `,
              [
                versionId,
                proposal.id,
                tenantId,
                factoryId,
              ],
            );

          const promotedProposal =
            proposalPromotionResult.rows[0];

          if (!promotedProposal) {
            throw new ConflictException(
              'Approved proposal could not be marked as promoted',
            );
          }

          return {
            tenantId,
            factoryId,
            proposalId:
              proposal.id,
            blueprintId:
              blueprint.id,
            idempotent:
              false,
            sourceVersion: {
              id:
                sourceVersion.id,
              version:
                Number(
                  sourceVersion.version,
                ),
            },
            promotedVersion:
              this.mapPromotedVersion(
                newVersion,
              ),
            proposal: {
              status:
                promotedProposal.status,
              promotedVersionId:
                promotedProposal.promoted_version_id,
              promotedAt:
                promotedProposal.promoted_at,
            },
          } satisfies CbbPromotionResult;
        },
        {
          tenantId,
          userId:
            actorUserId,
        },
      );

    // ========================================================
    // AUDIT
    // ========================================================

    await this.recordAuditSafely({
      tenantId,
      actorUserId,
      eventType:
        'BUSINESS_MODEL_CHANGE',
      action:
        'PROMOTE_PROPOSAL',
      resourceType:
        'BUSINESS_CHANGE_PROPOSAL',
      resourceId:
        result.proposalId,
      payload: {
        factoryId:
          result.factoryId,

        blueprintId:
          result.blueprintId,

        sourceVersionId:
          result.sourceVersion.id,

        sourceVersion:
          result.sourceVersion.version,

        promotedVersionId:
          result.promotedVersion.id,

        promotedVersion:
          result.promotedVersion.version,

        graphHash:
          result.promotedVersion.graphHash,

        proposalStatus:
          result.proposal.status,

        promotedAt:
          result.proposal.promotedAt,

        idempotent:
          result.idempotent,

        result:
          'PROMOTED',
      },
    });

    return result;
  }

  // ============================================================
  // LOAD + CLONE GRAPH
  // ============================================================

  private async loadAndCloneGraph(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    versionId: string,
    _blueprintId: string,
  ): Promise<ClonedGraph> {
    const entitiesResult =
      await client.query<EntityGraphRow>(
        `
        SELECT
          e.id::text AS id,

          e.tenant_id::text
            AS tenant_id,

          e.factory_id::text
            AS factory_id,

          e.blueprint_version_id::text
            AS blueprint_version_id,

          e.entity_type,

          e.name,

          e.description,

          e.state,

          e.confidence,

          e.metadata,

          e.created_by::text
            AS created_by,

          e.created_at::text
            AS created_at

        FROM business_entities e

        WHERE
          e.tenant_id = $1

          AND e.factory_id = $2

          AND e.blueprint_version_id = $3

        ORDER BY
          e.id ASC
        `,
        [
          tenantId,
          factoryId,
          versionId,
        ],
      );

    const relationsResult =
      await client.query<RelationGraphRow>(
        `
        SELECT
          r.id::text AS id,

          r.tenant_id::text
            AS tenant_id,

          r.factory_id::text
            AS factory_id,

          r.blueprint_version_id::text
            AS blueprint_version_id,

          r.from_entity_id::text
            AS from_entity_id,

          r.to_entity_id::text
            AS to_entity_id,

          r.relation_type,

          r.state,

          r.confidence,

          r.metadata,

          r.created_by::text
            AS created_by,

          r.created_at::text
            AS created_at

        FROM business_relations r

        WHERE
          r.tenant_id = $1

          AND r.factory_id = $2

          AND r.blueprint_version_id = $3

        ORDER BY
          r.id ASC
        `,
        [
          tenantId,
          factoryId,
          versionId,
        ],
      );

    const processesResult =
      await client.query<ProcessGraphRow>(
        `
        SELECT
          p.id::text AS id,

          p.tenant_id::text
            AS tenant_id,

          p.factory_id::text
            AS factory_id,

          p.blueprint_version_id::text
            AS blueprint_version_id,

          p.name,

          p.description,

          p.owner_ref,

          p.state,

          p.confidence,

          p.metadata,

          p.created_by::text
            AS created_by,

          p.created_at::text
            AS created_at

        FROM business_processes p

        WHERE
          p.tenant_id = $1

          AND p.factory_id = $2

          AND p.blueprint_version_id = $3

        ORDER BY
          p.id ASC
        `,
        [
          tenantId,
          factoryId,
          versionId,
        ],
      );

    const processStepsResult =
      await client.query<ProcessStepGraphRow>(
        `
        SELECT
          ps.id::text AS id,

          ps.tenant_id::text
            AS tenant_id,

          ps.factory_id::text
            AS factory_id,

          ps.blueprint_version_id::text
            AS blueprint_version_id,

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

          ps.created_by::text
            AS created_by,

          ps.created_at::text
            AS created_at

        FROM business_process_steps ps

        WHERE
          ps.tenant_id = $1

          AND ps.factory_id = $2

          AND ps.blueprint_version_id = $3

        ORDER BY
          ps.id ASC
        `,
        [
          tenantId,
          factoryId,
          versionId,
        ],
      );

    const rulesResult =
      await client.query<RuleGraphRow>(
        `
        SELECT
          r.id::text AS id,

          r.tenant_id::text
            AS tenant_id,

          r.factory_id::text
            AS factory_id,

          r.blueprint_version_id::text
            AS blueprint_version_id,

          r.name,

          r.rule_type,

          r.description,

          r.expression_ref,

          r.state,

          r.confidence,

          r.metadata,

          r.created_by::text
            AS created_by,

          r.created_at::text
            AS created_at

        FROM business_rules r

        WHERE
          r.tenant_id = $1

          AND r.factory_id = $2

          AND r.blueprint_version_id = $3

        ORDER BY
          r.id ASC
        `,
        [
          tenantId,
          factoryId,
          versionId,
        ],
      );

    const termsResult =
      await client.query<TermGraphRow>(
        `
        SELECT
          t.id::text AS id,

          t.tenant_id::text
            AS tenant_id,

          t.factory_id::text
            AS factory_id,

          t.blueprint_version_id::text
            AS blueprint_version_id,

          t.term,

          t.canonical_term,

          t.language_code,

          t.source_system,

          t.state,

          t.confidence,

          t.metadata,

          t.created_by::text
            AS created_by,

          t.created_at::text
            AS created_at

        FROM business_terms t

        WHERE
          t.tenant_id = $1

          AND t.factory_id = $2

          AND t.blueprint_version_id = $3

        ORDER BY
          t.id ASC
        `,
        [
          tenantId,
          factoryId,
          versionId,
        ],
      );

    const exceptionsResult =
      await client.query<ExceptionGraphRow>(
        `
        SELECT
          e.id::text AS id,

          e.tenant_id::text
            AS tenant_id,

          e.factory_id::text
            AS factory_id,

          e.blueprint_version_id::text
            AS blueprint_version_id,

          e.name,

          e.description,

          e.trigger_ref,

          e.handling_ref,

          e.state,

          e.confidence,

          e.metadata,

          e.created_by::text
            AS created_by,

          e.created_at::text
            AS created_at

        FROM business_exceptions e

        WHERE
          e.tenant_id = $1

          AND e.factory_id = $2

          AND e.blueprint_version_id = $3

        ORDER BY
          e.id ASC
        `,
        [
          tenantId,
          factoryId,
          versionId,
        ],
      );

    const allTargetIds = [
      ...entitiesResult.rows.map(
        (
          row,
        ) => row.id,
      ),

      ...relationsResult.rows.map(
        (
          row,
        ) => row.id,
      ),

      ...processesResult.rows.map(
        (
          row,
        ) => row.id,
      ),

      ...processStepsResult.rows.map(
        (
          row,
        ) => row.id,
      ),

      ...rulesResult.rows.map(
        (
          row,
        ) => row.id,
      ),

      ...termsResult.rows.map(
        (
          row,
        ) => row.id,
      ),

      ...exceptionsResult.rows.map(
        (
          row,
        ) => row.id,
      ),
    ];

    const evidenceLinksResult =
      await client.query<EvidenceLinkGraphRow>(
        `
        SELECT
          l.id::text AS id,

          l.tenant_id::text
            AS tenant_id,

          l.factory_id::text
            AS factory_id,

          l.evidence_id::text
            AS evidence_id,

          l.target_type,

          l.target_id::text
            AS target_id,

          l.link_type,

          l.created_by::text
            AS created_by,

          l.created_at::text
            AS created_at

        FROM business_evidence_links l

        WHERE
          l.tenant_id = $1

          AND l.factory_id = $2

          AND l.target_id = ANY(
            $3::uuid[]
          )

        ORDER BY
          l.id ASC
        `,
        [
          tenantId,
          factoryId,
          allTargetIds,
        ],
      );

    const idMaps: GraphIdMaps = {
      entities:
        new Map<string, string>(),

      relations:
        new Map<string, string>(),

      processes:
        new Map<string, string>(),

      processSteps:
        new Map<string, string>(),

      rules:
        new Map<string, string>(),

      terms:
        new Map<string, string>(),

      exceptions:
        new Map<string, string>(),
    };

    for (
      const row
      of entitiesResult.rows
    ) {
      idMaps.entities.set(
        row.id,
        randomUUID(),
      );
    }

    for (
      const row
      of relationsResult.rows
    ) {
      idMaps.relations.set(
        row.id,
        randomUUID(),
      );
    }

    for (
      const row
      of processesResult.rows
    ) {
      idMaps.processes.set(
        row.id,
        randomUUID(),
      );
    }

    for (
      const row
      of processStepsResult.rows
    ) {
      idMaps.processSteps.set(
        row.id,
        randomUUID(),
      );
    }

    for (
      const row
      of rulesResult.rows
    ) {
      idMaps.rules.set(
        row.id,
        randomUUID(),
      );
    }

    for (
      const row
      of termsResult.rows
    ) {
      idMaps.terms.set(
        row.id,
        randomUUID(),
      );
    }

    for (
      const row
      of exceptionsResult.rows
    ) {
      idMaps.exceptions.set(
        row.id,
        randomUUID(),
      );
    }

    const entities =
      entitiesResult.rows.map(
        (
          row,
        ) => ({
          ...row,

          id:
            this.requireMappedId(
              idMaps.entities,
              row.id,
              'entity',
            ),
        }),
      );

    const processes =
      processesResult.rows.map(
        (
          row,
        ) => ({
          ...row,

          id:
            this.requireMappedId(
              idMaps.processes,
              row.id,
              'process',
            ),
        }),
      );

    const processSteps =
      processStepsResult.rows.map(
        (
          row,
        ) => ({
          ...row,

          id:
            this.requireMappedId(
              idMaps.processSteps,
              row.id,
              'processStep',
            ),

          process_id:
            this.requireMappedId(
              idMaps.processes,
              row.process_id,
              'process',
            ),
        }),
      );

    const relations =
      relationsResult.rows.map(
        (
          row,
        ) => ({
          ...row,

          id:
            this.requireMappedId(
              idMaps.relations,
              row.id,
              'relation',
            ),

          from_entity_id:
            this.requireMappedId(
              idMaps.entities,
              row.from_entity_id,
              'from_entity',
            ),

          to_entity_id:
            this.requireMappedId(
              idMaps.entities,
              row.to_entity_id,
              'to_entity',
            ),
        }),
      );

    const rules =
      rulesResult.rows.map(
        (
          row,
        ) => ({
          ...row,

          id:
            this.requireMappedId(
              idMaps.rules,
              row.id,
              'rule',
            ),
        }),
      );

    const terms =
      termsResult.rows.map(
        (
          row,
        ) => ({
          ...row,

          id:
            this.requireMappedId(
              idMaps.terms,
              row.id,
              'term',
            ),
        }),
      );

    const exceptions =
      exceptionsResult.rows.map(
        (
          row,
        ) => ({
          ...row,

          id:
            this.requireMappedId(
              idMaps.exceptions,
              row.id,
              'exception',
            ),
        }),
      );

    const evidenceLinks: ClonedEvidenceLink[] = [];

    for (
      const row
      of evidenceLinksResult.rows
    ) {
      if (
        row.target_type
          .trim()
          .toUpperCase() ===
        'BLUEPRINT'
      ) {
        continue;
      }

      const targetMap =
        this.getIdMapForTargetType(
          idMaps,
          row.target_type,
        );

      if (!targetMap) {
        continue;
      }

      const targetId =
        targetMap.get(
          row.target_id,
        );

      if (!targetId) {
        throw new ConflictException(
          `Evidence link target ${row.target_id} could not be remapped during CBB promotion`,
        );
      }

      evidenceLinks.push({
        ...row,

        id:
          randomUUID() as string,

        tenant_id:
          row.tenant_id,

        factory_id:
          row.factory_id,

        target_type:
          row.target_type
            .trim()
            .toUpperCase(),

        target_id:
          targetId,
      });
    }

    return {
      entities,

      relations,

      processes,

      processSteps,

      rules,

      terms,

      exceptions,

      evidenceLinks,

      idMaps,
    };
  }

  // ============================================================
  // APPLY PROPOSAL
  // ============================================================

  private applyProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    blueprint: PromotionBlueprintRow,
  ):
    | 'ACTIVE'
    | 'DISABLED'
    | 'ARCHIVED' {
    const operation =
      this.normalizeOperation(
        proposal.proposal_type,
      );

    if (
      proposal.target_type ===
      'BLUEPRINT'
    ) {
      return this.applyBlueprintProposal(
        proposal,
        blueprint,
        operation,
      );
    }

    switch (
      proposal.target_type
    ) {
      case 'ENTITY':
        this.applyEntityProposal(
          graph,
          proposal,
          operation,
        );
        break;

      case 'RELATION':
        this.applyRelationProposal(
          graph,
          proposal,
          operation,
        );
        break;

      case 'PROCESS':
        this.applyProcessProposal(
          graph,
          proposal,
          operation,
        );
        break;

      case 'PROCESS_STEP':
        this.applyProcessStepProposal(
          graph,
          proposal,
          operation,
        );
        break;

      case 'RULE':
        this.applyRuleProposal(
          graph,
          proposal,
          operation,
        );
        break;

      case 'TERM':
        this.applyTermProposal(
          graph,
          proposal,
          operation,
        );
        break;

      case 'EXCEPTION':
        this.applyExceptionProposal(
          graph,
          proposal,
          operation,
        );
        break;

      default:
        throw new ConflictException(
          `Unsupported CBB promotion target type: ${proposal.target_type}`,
        );
    }

    return blueprint.status;
  }

  // ============================================================
  // BLUEPRINT PROPOSAL
  // ============================================================

  private applyBlueprintProposal(
    proposal: PromotionProposalRow,
    blueprint: PromotionBlueprintRow,
    operation: PromotionOperation,
  ):
    | 'ACTIVE'
    | 'DISABLED'
    | 'ARCHIVED' {
    if (
      operation === 'ADD'
    ) {
      throw new ConflictException(
        'A BLUEPRINT target cannot be added during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      return 'ARCHIVED';
    }

    const status =
      this.readPayloadString(
        proposal.proposed_payload,
        'status',
        'status',
      );

    if (!status) {
      if (
        operation ===
          'SET_STATE' &&
        proposal.proposed_state
      ) {
        throw new BadRequestException(
          'Blueprint status changes must use payload.status',
        );
      }

      throw new BadRequestException(
        'Blueprint promotion requires payload.status',
      );
    }

    const normalized =
      status
        .trim()
        .toUpperCase();

    if (
      ![
        'ACTIVE',
        'DISABLED',
        'ARCHIVED',
      ].includes(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `Unsupported blueprint status: ${status}`,
      );
    }

    return normalized as
      | 'ACTIVE'
      | 'DISABLED'
      | 'ARCHIVED';
  }

  // ============================================================
  // ENTITY
  // ============================================================

  private applyEntityProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    operation: PromotionOperation,
  ): void {
    const target =
      proposal.target_id
        ? this.findByOriginalId(
            graph.entities,
            graph.idMaps.entities,
            proposal.target_id,
          )
        : null;

    if (
      operation === 'ADD' &&
      !proposal.target_id
    ) {
      const row =
        this.createEntity(
          graph,
          proposal,
        );

      graph.entities.push(
        row,
      );

      return;
    }

    if (!target) {
      throw new NotFoundException(
        'ENTITY target was not found in the source CBB version during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      target.state =
        'STALE';

      return;
    }

    let changed =
      false;

    changed =
      this.applyEntityPatch(
        target,
        proposal.proposed_payload,
      ) ||
      changed;

    if (
      proposal.proposed_state
    ) {
      target.state =
        proposal.proposed_state;

      changed =
        true;
    }

    if (!changed) {
      throw new BadRequestException(
        'Entity promotion contains no applicable change fields',
      );
    }
  }

  private createEntity(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
  ): ClonedEntity {
    const payload =
      proposal.proposed_payload;

    const entityType =
      this.readRequiredPayloadString(
        payload,
        'entity_type',
        'entityType',
      );

    const name =
      this.readRequiredPayloadString(
        payload,
        'name',
        'name',
      );

    const id =
      randomUUID();

    const state =
      proposal.proposed_state ??
      this.readPayloadState(
        payload,
        'state',
      ) ??
      'PROPOSED';

    const row: ClonedEntity = {
      id,

      tenant_id:
        proposal.tenant_id,

      factory_id:
        proposal.factory_id,

      blueprint_version_id:
        '',

      entity_type:
        entityType,

      name,

      description:
        this.readPayloadNullableString(
          payload,
          'description',
        ) ??
        null,

      state,

      confidence:
        this.readPayloadNumber(
          payload,
          'confidence',
        ),

      metadata:
        this.readPayloadObject(
          payload,
          'metadata',
        ) ??
        {},

      created_by:
        proposal.decided_by,

      created_at:
        new Date().toISOString(),
    };

    graph.idMaps.entities.set(
      proposal.target_id ??
        id,
      id,
    );

    return row;
  }

  private applyEntityPatch(
    row: ClonedEntity,
    payload: JsonObject,
  ): boolean {
    let changed =
      false;

    const entityType =
      this.readPayloadOptionalString(
        payload,
        'entity_type',
        'entityType',
      );

    if (
      entityType !==
      undefined
    ) {
      row.entity_type =
        entityType;

      changed =
        true;
    }

    const name =
      this.readPayloadOptionalString(
        payload,
        'name',
      );

    if (
      name !==
      undefined
    ) {
      row.name =
        name;

      changed =
        true;
    }

    const description =
      this.readPayloadNullableString(
        payload,
        'description',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        payload,
        'description',
      )
    ) {
      row.description =
        description ??
        null;

      changed =
        true;
    }

    const confidence =
      this.readPayloadOptionalNumber(
        payload,
        'confidence',
      );

    if (
      confidence !==
      undefined
    ) {
      row.confidence =
        confidence;

      changed =
        true;
    }

    const metadata =
      this.readPayloadObject(
        payload,
        'metadata',
      );

    if (
      metadata !==
      undefined
    ) {
      row.metadata =
        metadata;

      changed =
        true;
    }

    const state =
      this.readPayloadState(
        payload,
        'state',
      );

    if (
      state !==
      undefined
    ) {
      row.state =
        state;

      changed =
        true;
    }

    this.validateEntity(
      row,
    );

    return changed;
  }

  // ============================================================
  // RELATION
  // ============================================================

  private applyRelationProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    operation: PromotionOperation,
  ): void {
    const target =
      proposal.target_id
        ? this.findByOriginalId(
            graph.relations,
            graph.idMaps.relations,
            proposal.target_id,
          )
        : null;

    if (
      operation === 'ADD' &&
      !proposal.target_id
    ) {
      const row =
        this.createRelation(
          graph,
          proposal,
        );

      graph.relations.push(
        row,
      );

      return;
    }

    if (!target) {
      throw new NotFoundException(
        'RELATION target was not found in the source CBB version during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      target.state =
        'STALE';

      return;
    }

    let changed =
      false;

    const fromEntityId =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'from_entity_id',
        'fromEntityId',
      );

    if (
      fromEntityId !==
      undefined
    ) {
      target.from_entity_id =
        this.requireMappedId(
          graph.idMaps.entities,
          fromEntityId,
          'from_entity',
        );

      changed =
        true;
    }

    const toEntityId =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'to_entity_id',
        'toEntityId',
      );

    if (
      toEntityId !==
      undefined
    ) {
      target.to_entity_id =
        this.requireMappedId(
          graph.idMaps.entities,
          toEntityId,
          'to_entity',
        );

      changed =
        true;
    }

    const relationType =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'relation_type',
        'relationType',
      );

    if (
      relationType !==
      undefined
    ) {
      target.relation_type =
        relationType;

      changed =
        true;
    }

    changed =
      this.applyCommonStatePatch(
        target,
        proposal.proposed_payload,
        proposal.proposed_state,
      ) ||
      changed;

    this.validateRelation(
      target,
    );

    if (!changed) {
      throw new BadRequestException(
        'Relation promotion contains no applicable change fields',
      );
    }
  }

  private createRelation(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
  ): ClonedRelation {
    const payload =
      proposal.proposed_payload;

    const fromEntityId =
      this.readRequiredPayloadString(
        payload,
        'from_entity_id',
        'fromEntityId',
      );

    const toEntityId =
      this.readRequiredPayloadString(
        payload,
        'to_entity_id',
        'toEntityId',
      );

    const relationType =
      this.readRequiredPayloadString(
        payload,
        'relation_type',
        'relationType',
      );

    const row: ClonedRelation = {
      id:
        randomUUID(),

      tenant_id:
        proposal.tenant_id,

      factory_id:
        proposal.factory_id,

      blueprint_version_id:
        '',

      from_entity_id:
        this.requireMappedId(
          graph.idMaps.entities,
          fromEntityId,
          'from_entity',
        ),

      to_entity_id:
        this.requireMappedId(
          graph.idMaps.entities,
          toEntityId,
          'to_entity',
        ),

      relation_type:
        relationType,

      state:
        proposal.proposed_state ??
        this.readPayloadState(
          payload,
          'state',
        ) ??
        'PROPOSED',

      confidence:
        this.readPayloadNumber(
          payload,
          'confidence',
        ),

      metadata:
        this.readPayloadObject(
          payload,
          'metadata',
        ) ??
        {},

      created_by:
        proposal.decided_by,

      created_at:
        new Date().toISOString(),
    };

    this.validateRelation(
      row,
    );

    return row;
  }

  // ============================================================
  // PROCESS
  // ============================================================

  private applyProcessProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    operation: PromotionOperation,
  ): void {
    const target =
      proposal.target_id
        ? this.findByOriginalId(
            graph.processes,
            graph.idMaps.processes,
            proposal.target_id,
          )
        : null;

    if (
      operation === 'ADD' &&
      !proposal.target_id
    ) {
      const row =
        this.createProcess(
          proposal,
        );

      graph.processes.push(
        row,
      );

      return;
    }

    if (!target) {
      throw new NotFoundException(
        'PROCESS target was not found in the source CBB version during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      target.state =
        'STALE';

      return;
    }

    let changed =
      false;

    const name =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'name',
      );

    if (
      name !==
      undefined
    ) {
      target.name =
        name;

      changed =
        true;
    }

    const description =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'description',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'description',
      )
    ) {
      target.description =
        description ??
        null;

      changed =
        true;
    }

    const ownerRef =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'owner_ref',
        'ownerRef',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'owner_ref',
      ) ||
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'ownerRef',
      )
    ) {
      target.owner_ref =
        ownerRef ??
        null;

      changed =
        true;
    }

    changed =
      this.applyCommonStatePatch(
        target,
        proposal.proposed_payload,
        proposal.proposed_state,
      ) ||
      changed;

    this.validateProcess(
      target,
    );

    if (!changed) {
      throw new BadRequestException(
        'Process promotion contains no applicable change fields',
      );
    }
  }

  private createProcess(
    proposal: PromotionProposalRow,
  ): ClonedProcess {
    const payload =
      proposal.proposed_payload;

    const name =
      this.readRequiredPayloadString(
        payload,
        'name',
      );

    const row: ClonedProcess = {
      id:
        randomUUID(),

      tenant_id:
        proposal.tenant_id,

      factory_id:
        proposal.factory_id,

      blueprint_version_id:
        '',

      name,

      description:
        this.readPayloadNullableString(
          payload,
          'description',
        ) ??
        null,

      owner_ref:
        this.readPayloadNullableString(
          payload,
          'owner_ref',
          'ownerRef',
        ) ??
        null,

      state:
        proposal.proposed_state ??
        this.readPayloadState(
          payload,
          'state',
        ) ??
        'PROPOSED',

      confidence:
        this.readPayloadNumber(
          payload,
          'confidence',
        ),

      metadata:
        this.readPayloadObject(
          payload,
          'metadata',
        ) ??
        {},

      created_by:
        proposal.decided_by,

      created_at:
        new Date().toISOString(),
    };

    this.validateProcess(
      row,
    );

    return row;
  }

  // ============================================================
  // PROCESS STEP
  // ============================================================

  private applyProcessStepProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    operation: PromotionOperation,
  ): void {
    const target =
      proposal.target_id
        ? this.findByOriginalId(
            graph.processSteps,
            graph.idMaps.processSteps,
            proposal.target_id,
          )
        : null;

    if (
      operation === 'ADD' &&
      !proposal.target_id
    ) {
      const row =
        this.createProcessStep(
          graph,
          proposal,
        );

      graph.processSteps.push(
        row,
      );

      return;
    }

    if (!target) {
      throw new NotFoundException(
        'PROCESS_STEP target was not found in the source CBB version during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      target.state =
        'STALE';

      return;
    }

    let changed =
      false;

    const processId =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'process_id',
        'processId',
      );

    if (
      processId !==
      undefined
    ) {
      target.process_id =
        this.requireMappedId(
          graph.idMaps.processes,
          processId,
          'process',
        );

      changed =
        true;
    }

    const sequenceNo =
      this.readPayloadOptionalInteger(
        proposal.proposed_payload,
        'sequence_no',
        'sequenceNo',
      );

    if (
      sequenceNo !==
      undefined
    ) {
      target.sequence_no =
        sequenceNo;

      changed =
        true;
    }

    const name =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'name',
      );

    if (
      name !==
      undefined
    ) {
      target.name =
        name;

      changed =
        true;
    }

    const description =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'description',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'description',
      )
    ) {
      target.description =
        description ??
        null;

      changed =
        true;
    }

    const ownerRef =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'owner_ref',
        'ownerRef',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'owner_ref',
      ) ||
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'ownerRef',
      )
    ) {
      target.owner_ref =
        ownerRef ??
        null;

      changed =
        true;
    }

    const inputs =
      this.readPayloadArray(
        proposal.proposed_payload,
        'inputs',
      );

    if (
      inputs !==
      undefined
    ) {
      target.inputs =
        inputs;

      changed =
        true;
    }

    const outputs =
      this.readPayloadArray(
        proposal.proposed_payload,
        'outputs',
      );

    if (
      outputs !==
      undefined
    ) {
      target.outputs =
        outputs;

      changed =
        true;
    }

    changed =
      this.applyCommonStatePatch(
        target,
        proposal.proposed_payload,
        proposal.proposed_state,
      ) ||
      changed;

    this.validateProcessStep(
      target,
    );

    this.ensureUniqueProcessStepSequence(
      graph,
      target,
    );

    if (!changed) {
      throw new BadRequestException(
        'Process-step promotion contains no applicable change fields',
      );
    }
  }

  private createProcessStep(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
  ): ClonedProcessStep {
    const payload =
      proposal.proposed_payload;

    const processId =
      this.readRequiredPayloadString(
        payload,
        'process_id',
        'processId',
      );

    const sequenceNo =
      this.readRequiredPayloadInteger(
        payload,
        'sequence_no',
        'sequenceNo',
      );

    const name =
      this.readRequiredPayloadString(
        payload,
        'name',
      );

    const row: ClonedProcessStep = {
      id:
        randomUUID(),

      tenant_id:
        proposal.tenant_id,

      factory_id:
        proposal.factory_id,

      blueprint_version_id:
        '',

      process_id:
        this.requireMappedId(
          graph.idMaps.processes,
          processId,
          'process',
        ),

      sequence_no:
        sequenceNo,

      name,

      description:
        this.readPayloadNullableString(
          payload,
          'description',
        ) ??
        null,

      owner_ref:
        this.readPayloadNullableString(
          payload,
          'owner_ref',
          'ownerRef',
        ) ??
        null,

      inputs:
        this.readPayloadArray(
          payload,
          'inputs',
        ) ??
        [],

      outputs:
        this.readPayloadArray(
          payload,
          'outputs',
        ) ??
        [],

      state:
        proposal.proposed_state ??
        this.readPayloadState(
          payload,
          'state',
        ) ??
        'PROPOSED',

      confidence:
        this.readPayloadNumber(
          payload,
          'confidence',
        ),

      metadata:
        this.readPayloadObject(
          payload,
          'metadata',
        ) ??
        {},

      created_by:
        proposal.decided_by,

      created_at:
        new Date().toISOString(),
    };

    this.validateProcessStep(
      row,
    );

    this.ensureUniqueProcessStepSequence(
      graph,
      row,
    );

    return row;
  }

  // ============================================================
  // RULE
  // ============================================================

  private applyRuleProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    operation: PromotionOperation,
  ): void {
    const target =
      proposal.target_id
        ? this.findByOriginalId(
            graph.rules,
            graph.idMaps.rules,
            proposal.target_id,
          )
        : null;

    if (
      operation === 'ADD' &&
      !proposal.target_id
    ) {
      const row =
        this.createRule(
          proposal,
        );

      graph.rules.push(
        row,
      );

      return;
    }

    if (!target) {
      throw new NotFoundException(
        'RULE target was not found in the source CBB version during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      target.state =
        'STALE';

      return;
    }

    let changed =
      false;

    const name =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'name',
      );

    if (
      name !==
      undefined
    ) {
      target.name =
        name;

      changed =
        true;
    }

    const ruleType =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'rule_type',
        'ruleType',
      );

    if (
      ruleType !==
      undefined
    ) {
      target.rule_type =
        ruleType;

      changed =
        true;
    }

    const description =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'description',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'description',
      )
    ) {
      target.description =
        description ??
        null;

      changed =
        true;
    }

    const expressionRef =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'expression_ref',
        'expressionRef',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'expression_ref',
      ) ||
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'expressionRef',
      )
    ) {
      target.expression_ref =
        expressionRef ??
        null;

      changed =
        true;
    }

    changed =
      this.applyCommonStatePatch(
        target,
        proposal.proposed_payload,
        proposal.proposed_state,
      ) ||
      changed;

    this.validateRule(
      target,
    );

    if (!changed) {
      throw new BadRequestException(
        'Rule promotion contains no applicable change fields',
      );
    }
  }

  private createRule(
    proposal: PromotionProposalRow,
  ): ClonedRule {
    const payload =
      proposal.proposed_payload;

    const name =
      this.readRequiredPayloadString(
        payload,
        'name',
      );

    const ruleType =
      this.readRequiredPayloadString(
        payload,
        'rule_type',
        'ruleType',
      );

    const row: ClonedRule = {
      id:
        randomUUID(),

      tenant_id:
        proposal.tenant_id,

      factory_id:
        proposal.factory_id,

      blueprint_version_id:
        '',

      name,

      rule_type:
        ruleType,

      description:
        this.readPayloadNullableString(
          payload,
          'description',
        ) ??
        null,

      expression_ref:
        this.readPayloadNullableString(
          payload,
          'expression_ref',
          'expressionRef',
        ) ??
        null,

      state:
        proposal.proposed_state ??
        this.readPayloadState(
          payload,
          'state',
        ) ??
        'PROPOSED',

      confidence:
        this.readPayloadNumber(
          payload,
          'confidence',
        ),

      metadata:
        this.readPayloadObject(
          payload,
          'metadata',
        ) ??
        {},

      created_by:
        proposal.decided_by,

      created_at:
        new Date().toISOString(),
    };

    this.validateRule(
      row,
    );

    return row;
  }

  // ============================================================
  // TERM
  // ============================================================

  private applyTermProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    operation: PromotionOperation,
  ): void {
    const target =
      proposal.target_id
        ? this.findByOriginalId(
            graph.terms,
            graph.idMaps.terms,
            proposal.target_id,
          )
        : null;

    if (
      operation === 'ADD' &&
      !proposal.target_id
    ) {
      const row =
        this.createTerm(
          proposal,
        );

      graph.terms.push(
        row,
      );

      return;
    }

    if (!target) {
      throw new NotFoundException(
        'TERM target was not found in the source CBB version during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      target.state =
        'STALE';

      return;
    }

    let changed =
      false;

    const term =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'term',
      );

    if (
      term !==
      undefined
    ) {
      target.term =
        term;

      changed =
        true;
    }

    const canonicalTerm =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'canonical_term',
        'canonicalTerm',
      );

    if (
      canonicalTerm !==
      undefined
    ) {
      target.canonical_term =
        canonicalTerm;

      changed =
        true;
    }

    const languageCode =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'language_code',
        'languageCode',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'language_code',
      ) ||
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'languageCode',
      )
    ) {
      target.language_code =
        languageCode ??
        null;

      changed =
        true;
    }

    const sourceSystem =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'source_system',
        'sourceSystem',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'source_system',
      ) ||
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'sourceSystem',
      )
    ) {
      target.source_system =
        sourceSystem ??
        null;

      changed =
        true;
    }

    changed =
      this.applyCommonStatePatch(
        target,
        proposal.proposed_payload,
        proposal.proposed_state,
      ) ||
      changed;

    this.validateTerm(
      target,
    );

    if (!changed) {
      throw new BadRequestException(
        'Term promotion contains no applicable change fields',
      );
    }
  }

  private createTerm(
    proposal: PromotionProposalRow,
  ): ClonedTerm {
    const payload =
      proposal.proposed_payload;

    const term =
      this.readRequiredPayloadString(
        payload,
        'term',
      );

    const canonicalTerm =
      this.readRequiredPayloadString(
        payload,
        'canonical_term',
        'canonicalTerm',
      );

    const row: ClonedTerm = {
      id:
        randomUUID(),

      tenant_id:
        proposal.tenant_id,

      factory_id:
        proposal.factory_id,

      blueprint_version_id:
        '',

      term,

      canonical_term:
        canonicalTerm,

      language_code:
        this.readPayloadNullableString(
          payload,
          'language_code',
          'languageCode',
        ) ??
        null,

      source_system:
        this.readPayloadNullableString(
          payload,
          'source_system',
          'sourceSystem',
        ) ??
        null,

      state:
        proposal.proposed_state ??
        this.readPayloadState(
          payload,
          'state',
        ) ??
        'PROPOSED',

      confidence:
        this.readPayloadNumber(
          payload,
          'confidence',
        ),

      metadata:
        this.readPayloadObject(
          payload,
          'metadata',
        ) ??
        {},

      created_by:
        proposal.decided_by,

      created_at:
        new Date().toISOString(),
    };

    this.validateTerm(
      row,
    );

    return row;
  }

  // ============================================================
  // EXCEPTION
  // ============================================================

  private applyExceptionProposal(
    graph: ClonedGraph,
    proposal: PromotionProposalRow,
    operation: PromotionOperation,
  ): void {
    const target =
      proposal.target_id
        ? this.findByOriginalId(
            graph.exceptions,
            graph.idMaps.exceptions,
            proposal.target_id,
          )
        : null;

    if (
      operation === 'ADD' &&
      !proposal.target_id
    ) {
      const row =
        this.createException(
          proposal,
        );

      graph.exceptions.push(
        row,
      );

      return;
    }

    if (!target) {
      throw new NotFoundException(
        'EXCEPTION target was not found in the source CBB version during promotion',
      );
    }

    if (
      operation === 'RETIRE'
    ) {
      target.state =
        'STALE';

      return;
    }

    let changed =
      false;

    const name =
      this.readPayloadOptionalString(
        proposal.proposed_payload,
        'name',
      );

    if (
      name !==
      undefined
    ) {
      target.name =
        name;

      changed =
        true;
    }

    const description =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'description',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'description',
      )
    ) {
      target.description =
        description ??
        null;

      changed =
        true;
    }

    const triggerRef =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'trigger_ref',
        'triggerRef',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'trigger_ref',
      ) ||
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'triggerRef',
      )
    ) {
      target.trigger_ref =
        triggerRef ??
        null;

      changed =
        true;
    }

    const handlingRef =
      this.readPayloadNullableString(
        proposal.proposed_payload,
        'handling_ref',
        'handlingRef',
      );

    if (
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'handling_ref',
      ) ||
      Object.prototype.hasOwnProperty.call(
        proposal.proposed_payload,
        'handlingRef',
      )
    ) {
      target.handling_ref =
        handlingRef ??
        null;

      changed =
        true;
    }

    changed =
      this.applyCommonStatePatch(
        target,
        proposal.proposed_payload,
        proposal.proposed_state,
      ) ||
      changed;

    this.validateException(
      target,
    );

    if (!changed) {
      throw new BadRequestException(
        'Exception promotion contains no applicable change fields',
      );
    }
  }

  private createException(
    proposal: PromotionProposalRow,
  ): ClonedException {
    const payload =
      proposal.proposed_payload;

    const name =
      this.readRequiredPayloadString(
        payload,
        'name',
      );

    const row: ClonedException = {
      id:
        randomUUID(),

      tenant_id:
        proposal.tenant_id,

      factory_id:
        proposal.factory_id,

      blueprint_version_id:
        '',

      name,

      description:
        this.readPayloadNullableString(
          payload,
          'description',
        ) ??
        null,

      trigger_ref:
        this.readPayloadNullableString(
          payload,
          'trigger_ref',
          'triggerRef',
        ) ??
        null,

      handling_ref:
        this.readPayloadNullableString(
          payload,
          'handling_ref',
          'handlingRef',
        ) ??
        null,

      state:
        proposal.proposed_state ??
        this.readPayloadState(
          payload,
          'state',
        ) ??
        'PROPOSED',

      confidence:
        this.readPayloadNumber(
          payload,
          'confidence',
        ),

      metadata:
        this.readPayloadObject(
          payload,
          'metadata',
        ) ??
        {},

      created_by:
        proposal.decided_by,

      created_at:
        new Date().toISOString(),
    };

    this.validateException(
      row,
    );

    return row;
  }

  // ============================================================
  // COMMON PATCH
  // ============================================================

  private applyCommonStatePatch(
    row: {
      state:
        BusinessChangeState;

      confidence:
        | number
        | string
        | null;

      metadata:
        JsonObject;
    },
    payload: JsonObject,
    proposedState:
      | BusinessChangeState
      | null,
  ): boolean {
    let changed =
      false;

    const state =
      this.readPayloadState(
        payload,
        'state',
      );

    if (
      state !==
      undefined
    ) {
      row.state =
        state;

      changed =
        true;
    }

    const confidence =
      this.readPayloadOptionalNumber(
        payload,
        'confidence',
      );

    if (
      confidence !==
      undefined
    ) {
      row.confidence =
        confidence;

      changed =
        true;
    }

    const metadata =
      this.readPayloadObject(
        payload,
        'metadata',
      );

    if (
      metadata !==
      undefined
    ) {
      row.metadata =
        metadata;

      changed =
        true;
    }

    if (
      proposedState
    ) {
      row.state =
        proposedState;

      changed =
        true;
    }

    return changed;
  }

  // ============================================================
  // GRAPH VERSION SCOPE
  // ============================================================

  private setGraphVersionScope(
    graph: ClonedGraph,
    tenantId: string,
    factoryId: string,
    versionId: string,
  ): void {
    for (
      const row
      of graph.entities
    ) {
      row.tenant_id =
        tenantId;

      row.factory_id =
        factoryId;

      row.blueprint_version_id =
        versionId;
    }

    for (
      const row
      of graph.relations
    ) {
      row.tenant_id =
        tenantId;

      row.factory_id =
        factoryId;

      row.blueprint_version_id =
        versionId;
    }

    for (
      const row
      of graph.processes
    ) {
      row.tenant_id =
        tenantId;

      row.factory_id =
        factoryId;

      row.blueprint_version_id =
        versionId;
    }

    for (
      const row
      of graph.processSteps
    ) {
      row.tenant_id =
        tenantId;

      row.factory_id =
        factoryId;

      row.blueprint_version_id =
        versionId;
    }

    for (
      const row
      of graph.rules
    ) {
      row.tenant_id =
        tenantId;

      row.factory_id =
        factoryId;

      row.blueprint_version_id =
        versionId;
    }

    for (
      const row
      of graph.terms
    ) {
      row.tenant_id =
        tenantId;

      row.factory_id =
        factoryId;

      row.blueprint_version_id =
        versionId;
    }

    for (
      const row
      of graph.exceptions
    ) {
      row.tenant_id =
        tenantId;

      row.factory_id =
        factoryId;

      row.blueprint_version_id =
        versionId;
    }
  }

  // ============================================================
  // INSERT GRAPH
  // ============================================================

  private async insertGraph(
    client: PoolClient,
    graph: ClonedGraph,
  ): Promise<void> {
    for (
      const row
      of graph.entities
    ) {
      await client.query(
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
          metadata,
          created_by,
          created_at
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
          $9,
          $10::jsonb,
          $11,
          $12
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.blueprint_version_id,
          row.entity_type,
          row.name,
          row.description,
          row.state,
          row.confidence,
          JSON.stringify(
            row.metadata,
          ),
          row.created_by,
          row.created_at,
        ],
      );
    }

    for (
      const row
      of graph.processes
    ) {
      await client.query(
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
          metadata,
          created_by,
          created_at
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
          $9,
          $10::jsonb,
          $11,
          $12
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.blueprint_version_id,
          row.name,
          row.description,
          row.owner_ref,
          row.state,
          row.confidence,
          JSON.stringify(
            row.metadata,
          ),
          row.created_by,
          row.created_at,
        ],
      );
    }

    for (
      const row
      of graph.processSteps
    ) {
      await client.query(
        `
        INSERT INTO business_process_steps (
          id,
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
          metadata,
          created_by,
          created_at
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
          $9,
          $10::jsonb,
          $11::jsonb,
          $12,
          $13,
          $14::jsonb,
          $15,
          $16
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.blueprint_version_id,
          row.process_id,
          row.sequence_no,
          row.name,
          row.description,
          row.owner_ref,
          JSON.stringify(
            row.inputs,
          ),
          JSON.stringify(
            row.outputs,
          ),
          row.state,
          row.confidence,
          JSON.stringify(
            row.metadata,
          ),
          row.created_by,
          row.created_at,
        ],
      );
    }

    for (
      const row
      of graph.relations
    ) {
      await client.query(
        `
        INSERT INTO business_relations (
          id,
          tenant_id,
          factory_id,
          blueprint_version_id,
          from_entity_id,
          to_entity_id,
          relation_type,
          state,
          confidence,
          metadata,
          created_by,
          created_at
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
          $9,
          $10::jsonb,
          $11,
          $12
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.blueprint_version_id,
          row.from_entity_id,
          row.to_entity_id,
          row.relation_type,
          row.state,
          row.confidence,
          JSON.stringify(
            row.metadata,
          ),
          row.created_by,
          row.created_at,
        ],
      );
    }

    for (
      const row
      of graph.rules
    ) {
      await client.query(
        `
        INSERT INTO business_rules (
          id,
          tenant_id,
          factory_id,
          blueprint_version_id,
          name,
          rule_type,
          description,
          expression_ref,
          state,
          confidence,
          metadata,
          created_by,
          created_at
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
          $9,
          $10,
          $11::jsonb,
          $12,
          $13
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.blueprint_version_id,
          row.name,
          row.rule_type,
          row.description,
          row.expression_ref,
          row.state,
          row.confidence,
          JSON.stringify(
            row.metadata,
          ),
          row.created_by,
          row.created_at,
        ],
      );
    }

    for (
      const row
      of graph.terms
    ) {
      await client.query(
        `
        INSERT INTO business_terms (
          id,
          tenant_id,
          factory_id,
          blueprint_version_id,
          term,
          canonical_term,
          language_code,
          source_system,
          state,
          confidence,
          metadata,
          created_by,
          created_at
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
          $9,
          $10,
          $11::jsonb,
          $12,
          $13
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.blueprint_version_id,
          row.term,
          row.canonical_term,
          row.language_code,
          row.source_system,
          row.state,
          row.confidence,
          JSON.stringify(
            row.metadata,
          ),
          row.created_by,
          row.created_at,
        ],
      );
    }

    for (
      const row
      of graph.exceptions
    ) {
      await client.query(
        `
        INSERT INTO business_exceptions (
          id,
          tenant_id,
          factory_id,
          blueprint_version_id,
          name,
          description,
          trigger_ref,
          handling_ref,
          state,
          confidence,
          metadata,
          created_by,
          created_at
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
          $9,
          $10,
          $11::jsonb,
          $12,
          $13
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.blueprint_version_id,
          row.name,
          row.description,
          row.trigger_ref,
          row.handling_ref,
          row.state,
          row.confidence,
          JSON.stringify(
            row.metadata,
          ),
          row.created_by,
          row.created_at,
        ],
      );
    }

    for (
      const row
      of graph.evidenceLinks
    ) {
      await client.query(
        `
        INSERT INTO business_evidence_links (
          id,
          tenant_id,
          factory_id,
          evidence_id,
          target_type,
          target_id,
          link_type,
          created_by,
          created_at
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
          $9
        )
        `,
        [
          row.id,
          row.tenant_id,
          row.factory_id,
          row.evidence_id,
          row.target_type,
          row.target_id,
          row.link_type,
          row.created_by,
          row.created_at,
        ],
      );
    }
  }

  // ============================================================
  // GRAPH HASH
  // ============================================================

  private computeGraphHash(
    graph: ClonedGraph,
    blueprintId: string,
    version: number,
    blueprintStatus:
      | 'ACTIVE'
      | 'DISABLED'
      | 'ARCHIVED',
  ): string {
    const canonical =
      this.canonicalize(
        {
          blueprintId,

          version,

          blueprintStatus,

          entities:
            graph.entities
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
                (
                  row,
                ) => ({
                  id:
                    row.id,
                  entityType:
                    row.entity_type,
                  name:
                    row.name,
                  description:
                    row.description,
                  state:
                    row.state,
                  confidence:
                    row.confidence,
                  metadata:
                    row.metadata,
                }),
              ),

          relations:
            graph.relations
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
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
                  confidence:
                    row.confidence,
                  metadata:
                    row.metadata,
                }),
              ),

          processes:
            graph.processes
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
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
                  confidence:
                    row.confidence,
                  metadata:
                    row.metadata,
                }),
              ),

          processSteps:
            graph.processSteps
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
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
                  confidence:
                    row.confidence,
                  metadata:
                    row.metadata,
                }),
              ),

          rules:
            graph.rules
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
                (
                  row,
                ) => ({
                  id:
                    row.id,
                  name:
                    row.name,
                  ruleType:
                    row.rule_type,
                  description:
                    row.description,
                  expressionRef:
                    row.expression_ref,
                  state:
                    row.state,
                  confidence:
                    row.confidence,
                  metadata:
                    row.metadata,
                }),
              ),

          terms:
            graph.terms
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
                (
                  row,
                ) => ({
                  id:
                    row.id,
                  term:
                    row.term,
                  canonicalTerm:
                    row.canonical_term,
                  languageCode:
                    row.language_code,
                  sourceSystem:
                    row.source_system,
                  state:
                    row.state,
                  confidence:
                    row.confidence,
                  metadata:
                    row.metadata,
                }),
              ),

          exceptions:
            graph.exceptions
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
                (
                  row,
                ) => ({
                  id:
                    row.id,
                  name:
                    row.name,
                  description:
                    row.description,
                  triggerRef:
                    row.trigger_ref,
                  handlingRef:
                    row.handling_ref,
                  state:
                    row.state,
                  confidence:
                    row.confidence,
                  metadata:
                    row.metadata,
                }),
              ),

          evidenceLinks:
            graph.evidenceLinks
              .slice()
              .sort(
                (
                  left,
                  right,
                ) =>
                  left.id.localeCompare(
                    right.id,
                  ),
              )
              .map(
                (
                  row,
                ) => ({
                  id:
                    row.id,
                  evidenceId:
                    row.evidence_id,
                  targetType:
                    row.target_type,
                  targetId:
                    row.target_id,
                  linkType:
                    row.link_type,
                }),
              ),
        },
      );

    return createHash(
      'sha256',
    )
      .update(
        JSON.stringify(
          canonical,
        ),
        'utf8',
      )
      .digest(
        'hex',
      );
  }

  // ============================================================
  // CHANGE REASON
  // ============================================================

  private buildChangeReason(
    proposal: PromotionProposalRow,
    sourceVersion: PromotionVersionRow,
  ): string {
    const reason =
      proposal.reason?.trim() ||
      'Approved CBB business-model change';

    return [
      `Promoted ${proposal.proposal_type}`,

      `from version ${Number(
        sourceVersion.version,
      )}`,

      reason,
    ].join(
      ': ',
    );
  }

  // ============================================================
  // VERSION LOOKUP
  // ============================================================

  private async getVersionById(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    versionId: string,
  ): Promise<
    PromotionVersionRow
    | null
  > {
    const result =
      await client.query<PromotionVersionRow>(
        `
        SELECT
          v.id::text AS id,

          v.tenant_id::text
            AS tenant_id,

          v.factory_id::text
            AS factory_id,

          v.blueprint_id::text
            AS blueprint_id,

          v.version::text
            AS version,

          v.graph_hash,

          v.evidence_count,

          v.readiness_score,

          v.status,

          v.change_reason,

          v.created_by::text
            AS created_by,

          v.created_at::text
            AS created_at

        FROM business_blueprint_versions v

        WHERE
          v.id = $1

          AND v.tenant_id = $2

          AND v.factory_id = $3

        LIMIT 1
        `,
        [
          versionId,
          tenantId,
          factoryId,
        ],
      );

    return (
      result.rows[0] ??
      null
    );
  }

  private async getVersionNumberById(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    versionId: string,
  ): Promise<number> {
    const result =
      await client.query<{
        version: string;
      }>(
        `
        SELECT
          v.version::text
            AS version

        FROM business_blueprint_versions v

        WHERE
          v.id = $1

          AND v.tenant_id = $2

          AND v.factory_id = $3

        LIMIT 1
        `,
        [
          versionId,
          tenantId,
          factoryId,
        ],
      );

    const row =
      result.rows[0];

    if (!row) {
      throw new ConflictException(
        'Source blueprint version could not be resolved',
      );
    }

    const version =
      Number(
        row.version,
      );

    if (
      !Number.isSafeInteger(
        version,
      )
    ) {
      throw new ConflictException(
        'Source blueprint version number is invalid',
      );
    }

    return version;
  }

  // ============================================================
  // RESULT MAPPER
  // ============================================================

  private mapPromotedVersion(
    row: PromotionVersionRow,
  ) {
    return {
      id:
        row.id,

      version:
        Number(
          row.version,
        ),

      graphHash:
        row.graph_hash ??
        '',

      evidenceCount:
        row.evidence_count,

      readinessScore:
        this.normalizeNullableNumber(
          row.readiness_score,
        ),

      status:
        row.status,

      changeReason:
        row.change_reason,

      createdAt:
        row.created_at,
    };
  }

  // ============================================================
  // ORIGINAL ID LOOKUP
  // ============================================================

  private findByOriginalId<
    T extends {
      id: string;
    },
  >(
    rows: T[],
    idMap: Map<string, string>,
    originalId: string,
  ): T | null {
    const clonedId =
      idMap.get(
        originalId,
      );

    if (!clonedId) {
      return null;
    }

    return (
      rows.find(
        (
          row,
        ) =>
          row.id ===
          clonedId,
      ) ??
      null
    );
  }

  // ============================================================
  // TARGET MAP
  // ============================================================

  private getIdMapForTargetType(
    maps: GraphIdMaps,
    targetType: string,
  ):
    | Map<string, string>
    | null {
    switch (
      targetType.trim().toUpperCase()
    ) {
      case 'ENTITY':
        return maps.entities;

      case 'RELATION':
        return maps.relations;

      case 'PROCESS':
        return maps.processes;

      case 'PROCESS_STEP':
        return maps.processSteps;

      case 'RULE':
        return maps.rules;

      case 'TERM':
        return maps.terms;

      case 'EXCEPTION':
        return maps.exceptions;

      default:
        return null;
    }
  }

  // ============================================================
  // OPERATION
  // ============================================================

  private normalizeOperation(
    proposalType: string,
  ): PromotionOperation {
    const normalized =
      proposalType
        .trim()
        .toUpperCase();

    if (
      normalized ===
        'ADD' ||
      normalized ===
        'CREATE' ||
      normalized.startsWith(
        'ADD_',
      ) ||
      normalized.startsWith(
        'CREATE_',
      )
    ) {
      return 'ADD';
    }

    if (
      normalized.includes(
        'RETIRE',
      ) ||
      normalized.includes(
        'DELETE',
      ) ||
      normalized.includes(
        'REMOVE',
      )
    ) {
      return 'RETIRE';
    }

    if (
      normalized.includes(
        'SET_STATE',
      ) ||
      normalized ===
        'VERIFY' ||
      normalized.startsWith(
        'VERIFY_',
      )
    ) {
      return 'SET_STATE';
    }

    return 'UPDATE';
  }

  // ============================================================
  // PAYLOAD STRING HELPERS
  // ============================================================

  private readRequiredPayloadString(
    payload: JsonObject,
    ...keys: string[]
  ): string {
    const value =
      this.readPayloadOptionalString(
        payload,
        ...keys,
      );

    if (
      value ===
      undefined ||
      !value
    ) {
      throw new BadRequestException(
        `Promotion payload requires ${keys[0]}`,
      );
    }

    return value;
  }

  private readPayloadOptionalString(
    payload: JsonObject,
    ...keys: string[]
  ):
    | string
    | undefined {
    const value =
      this.readPayloadValue(
        payload,
        ...keys,
      );

    if (
      value ===
      undefined
    ) {
      return undefined;
    }

    if (
      typeof value !==
      'string'
    ) {
      throw new BadRequestException(
        `Promotion payload field ${keys[0]} must be a string`,
      );
    }

    const normalized =
      value.trim();

    if (!normalized) {
      throw new BadRequestException(
        `Promotion payload field ${keys[0]} must not be empty`,
      );
    }

    return normalized;
  }

  private readPayloadNullableString(
    payload: JsonObject,
    ...keys: string[]
  ):
    | string
    | null
    | undefined {
    const hasField =
      keys.some(
        (
          key,
        ) =>
          Object.prototype.hasOwnProperty.call(
            payload,
            key,
          ),
      );

    if (!hasField) {
      return undefined;
    }

    const value =
      this.readPayloadValue(
        payload,
        ...keys,
      );

    if (
      value ===
      null
    ) {
      return null;
    }

    if (
      typeof value !==
      'string'
    ) {
      throw new BadRequestException(
        `Promotion payload field ${keys[0]} must be a string or null`,
      );
    }

    const normalized =
      value.trim();

    return normalized ||
      null;
  }

  private readPayloadString(
    payload: JsonObject,
    ...keys: string[]
  ):
    | string
    | undefined {
    return this.readPayloadOptionalString(
      payload,
      ...keys,
    );
  }

  private readPayloadValue(
    payload: JsonObject,
    ...keys: string[]
  ): unknown {
    for (
      const key
      of keys
    ) {
      if (
        Object.prototype.hasOwnProperty.call(
          payload,
          key,
        )
      ) {
        return payload[key];
      }
    }

    return undefined;
  }

  // ============================================================
  // PAYLOAD NUMBER HELPERS
  // ============================================================

  private readPayloadNumber(
    payload: JsonObject,
    key: string,
  ):
    | number
    | null {
    const value =
      this.readPayloadValue(
        payload,
        key,
      );

    if (
      value ===
      undefined ||
      value ===
      null
    ) {
      return null;
    }

    return this.normalizeConfidence(
      value,
      key,
    );
  }

  private readPayloadOptionalNumber(
    payload: JsonObject,
    key: string,
  ):
    | number
    | undefined {
    if (
      !Object.prototype.hasOwnProperty.call(
        payload,
        key,
      )
    ) {
      return undefined;
    }

    const value =
      this.readPayloadValue(
        payload,
        key,
      );

    if (
      value ===
      null
    ) {
      return undefined;
    }

    return this.normalizeConfidence(
      value,
      key,
    );
  }

  private normalizeConfidence(
    value: unknown,
    field: string,
  ): number {
    const number =
      typeof value ===
      'number'
        ? value
        : Number(
            value,
          );

    if (
      !Number.isFinite(
        number,
      ) ||
      number < 0 ||
      number > 1
    ) {
      throw new BadRequestException(
        `Promotion payload field ${field} must be between 0 and 1`,
      );
    }

    return number;
  }

  // ============================================================
  // INTEGER HELPERS
  // ============================================================

  private readRequiredPayloadInteger(
    payload: JsonObject,
    ...keys: string[]
  ): number {
    const value =
      this.readPayloadOptionalInteger(
        payload,
        ...keys,
      );

    if (
      value ===
      undefined
    ) {
      throw new BadRequestException(
        `Promotion payload requires ${keys[0]}`,
      );
    }

    return value;
  }

  private readPayloadOptionalInteger(
    payload: JsonObject,
    ...keys: string[]
  ):
    | number
    | undefined {
    const value =
      this.readPayloadValue(
        payload,
        ...keys,
      );

    if (
      value ===
      undefined
    ) {
      return undefined;
    }

    const number =
      typeof value ===
      'number'
        ? value
        : Number(
            value,
          );

    if (
      !Number.isSafeInteger(
        number,
      ) ||
      number < 1
    ) {
      throw new BadRequestException(
        `Promotion payload field ${keys[0]} must be a positive integer`,
      );
    }

    return number;
  }

  // ============================================================
  // ARRAY / OBJECT HELPERS
  // ============================================================

  private readPayloadArray(
    payload: JsonObject,
    key: string,
  ):
    | unknown[]
    | undefined {
    if (
      !Object.prototype.hasOwnProperty.call(
        payload,
        key,
      )
    ) {
      return undefined;
    }

    const value =
      payload[key];

    if (
      !Array.isArray(
        value,
      )
    ) {
      throw new BadRequestException(
        `Promotion payload field ${key} must be an array`,
      );
    }

    return value;
  }

  private readPayloadObject(
    payload: JsonObject,
    key: string,
  ):
    | JsonObject
    | undefined {
    if (
      !Object.prototype.hasOwnProperty.call(
        payload,
        key,
      )
    ) {
      return undefined;
    }

    const value =
      payload[key];

    if (
      value ===
        null ||
      typeof value !==
        'object' ||
      Array.isArray(
        value,
      )
    ) {
      throw new BadRequestException(
        `Promotion payload field ${key} must be an object`,
      );
    }

    return value as JsonObject;
  }

  private readPayloadState(
    payload: JsonObject,
    key: string,
  ):
    | BusinessChangeState
    | undefined {
    const value =
      this.readPayloadOptionalString(
        payload,
        key,
      );

    if (
      value ===
      undefined
    ) {
      return undefined;
    }

    return this.normalizeState(
      value,
    );
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  private normalizeState(
    value: string,
  ): BusinessChangeState {
    const normalized =
      value
        .trim()
        .toUpperCase();

    const allowed: BusinessChangeState[] = [
      'VERIFIED',
      'INFERRED',
      'PROPOSED',
      'CONFLICTING',
      'STALE',
    ];

    if (
      !allowed.includes(
        normalized as BusinessChangeState,
      )
    ) {
      throw new BadRequestException(
        `Unsupported business change state: ${value}`,
      );
    }

    return normalized as BusinessChangeState;
  }

  private validateEntity(
    row: ClonedEntity,
  ): void {
    if (
      !row.entity_type.trim()
    ) {
      throw new BadRequestException(
        'Entity type cannot be empty during promotion',
      );
    }

    if (
      !row.name.trim()
    ) {
      throw new BadRequestException(
        'Entity name cannot be empty during promotion',
      );
    }

    this.validateConfidenceValue(
      row.confidence,
    );
  }

  private validateRelation(
    row: ClonedRelation,
  ): void {
    if (
      !row.relation_type.trim()
    ) {
      throw new BadRequestException(
        'Relation type cannot be empty during promotion',
      );
    }

    if (
      row.from_entity_id ===
      row.to_entity_id
    ) {
      throw new BadRequestException(
        'Relation cannot point from an entity to itself during promotion',
      );
    }

    this.validateConfidenceValue(
      row.confidence,
    );
  }

  private validateProcess(
    row: ClonedProcess,
  ): void {
    if (
      !row.name.trim()
    ) {
      throw new BadRequestException(
        'Process name cannot be empty during promotion',
      );
    }

    this.validateConfidenceValue(
      row.confidence,
    );
  }

  private validateProcessStep(
    row: ClonedProcessStep,
  ): void {
    if (
      row.sequence_no < 1
    ) {
      throw new BadRequestException(
        'Process-step sequence must be at least 1 during promotion',
      );
    }

    if (
      !row.name.trim()
    ) {
      throw new BadRequestException(
        'Process-step name cannot be empty during promotion',
      );
    }

    if (
      !Array.isArray(
        row.inputs,
      ) ||
      !Array.isArray(
        row.outputs,
      )
    ) {
      throw new BadRequestException(
        'Process-step inputs and outputs must be arrays during promotion',
      );
    }

    this.validateConfidenceValue(
      row.confidence,
    );
  }

  private validateRule(
    row: ClonedRule,
  ): void {
    if (
      !row.name.trim()
    ) {
      throw new BadRequestException(
        'Rule name cannot be empty during promotion',
      );
    }

    if (
      !row.rule_type.trim()
    ) {
      throw new BadRequestException(
        'Rule type cannot be empty during promotion',
      );
    }

    this.validateConfidenceValue(
      row.confidence,
    );
  }

  private validateTerm(
    row: ClonedTerm,
  ): void {
    if (
      !row.term.trim()
    ) {
      throw new BadRequestException(
        'Term cannot be empty during promotion',
      );
    }

    if (
      !row.canonical_term.trim()
    ) {
      throw new BadRequestException(
        'Canonical term cannot be empty during promotion',
      );
    }

    this.validateConfidenceValue(
      row.confidence,
    );
  }

  private validateException(
    row: ClonedException,
  ): void {
    if (
      !row.name.trim()
    ) {
      throw new BadRequestException(
        'Exception name cannot be empty during promotion',
      );
    }

    this.validateConfidenceValue(
      row.confidence,
    );
  }

  private validateConfidenceValue(
    value:
      | number
      | string
      | null,
  ): void {
    if (
      value ===
      null
    ) {
      return;
    }

    const number =
      Number(
        value,
      );

    if (
      !Number.isFinite(
        number,
      ) ||
      number < 0 ||
      number > 1
    ) {
      throw new BadRequestException(
        'Confidence must be between 0 and 1 during promotion',
      );
    }
  }

  private ensureUniqueProcessStepSequence(
    graph: ClonedGraph,
    target: ClonedProcessStep,
  ): void {
    const count =
      graph.processSteps.filter(
        (
          row,
        ) =>
          row.process_id ===
            target.process_id &&
          row.sequence_no ===
            target.sequence_no,
      ).length;

    if (
      count > 1
    ) {
      throw new ConflictException(
        `Process step sequence ${target.sequence_no} already exists for the selected process`,
      );
    }
  }

  // ============================================================
  // UUID
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
    if (
      !isUUID(value)
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  // ============================================================
  // MAPPED ID
  // ============================================================

  private requireMappedId(
    map: Map<string, string>,
    originalId: string,
    label: string,
  ): string {
    const mapped =
      map.get(
        originalId,
      );

    if (!mapped) {
      throw new ConflictException(
        `Referenced ${label} ${originalId} does not belong to the source CBB version`,
      );
    }

    return mapped;
  }

  // ============================================================
  // JSON CANONICALIZATION
  // ============================================================

  private canonicalize(
    value: unknown,
  ): unknown {
    if (
      Array.isArray(
        value,
      )
    ) {
      return value.map(
        (
          item,
        ) =>
          this.canonicalize(
            item,
          ),
      );
    }

    if (
      value !== null &&
      typeof value ===
        'object'
    ) {
      const object =
        value as Record<
          string,
          unknown
        >;

      return Object.fromEntries(
        Object.keys(
          object,
        )
          .sort()
          .map(
            (
              key,
            ) => [
              key,
              this.canonicalize(
                object[key],
              ),
            ],
          ),
      );
    }

    return value;
  }

  // ============================================================
  // NUMBER NORMALIZATION
  // ============================================================

  private normalizeNullableNumber(
    value:
      | number
      | string
      | null
      | undefined,
  ):
    | number
    | null {
    if (
      value ===
        null ||
      value ===
        undefined
    ) {
      return null;
    }

    const number =
      Number(
        value,
      );

    return Number.isFinite(
      number,
    )
      ? number
      : null;
  }

  // ============================================================
  // AUDIT
  // ============================================================

  private async recordAuditSafely(
    input: {
      tenantId: string;

      actorUserId:
        | string
        | null;

      eventType: string;

      action: string;

      resourceType: string;

      resourceId: string;

      payload:
        JsonObject;
    },
  ): Promise<void> {
    try {
      await this.auditService.record({
        tenantId:
          input.tenantId,

        actorUserId:
          input.actorUserId,

        eventType:
          input.eventType,

        action:
          input.action,

        resourceType:
          input.resourceType,

        resourceId:
          input.resourceId,

        dataClass:
          'INTERNAL',

        payload:
          input.payload,
      });
    } catch {
      /*
       * Promotion already committed successfully.
       *
       * Audit failure must not replace the successful promotion
       * result with an unrelated audit/database exception.
       */
    }
  }
}
