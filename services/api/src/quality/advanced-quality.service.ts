import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { QualityService } from './quality.service';
import {
  BindQualitySamplingProfilesDto, CreateFabricScoringProfileDto, CreateQualityAqlProfileDto,
  QualityAdvancedProfileTransitionDto, QualityDefectParetoQueryDto, QualityRepeatAlertsQueryDto,
  RecordFabricRollScoreDto, RecordQualityAqlSampleDto, RecordQualityDefectContextDto,
} from './advanced-quality.dto';

interface AdvancedQualityContext {
  userId: string;
  tenantId: string;
  factoryId: string;
  requestId?: string | null;
  traceId?: string | null;
}

type ProfileKind = 'AQL' | 'FABRIC';
type ProfileRow = Record<string, any>;

@Injectable()
export class AdvancedQualityService {
  constructor(private readonly database: DatabaseService, private readonly qualityService: QualityService) {}

  async createAqlProfile(c: AdvancedQualityContext, dto: CreateQualityAqlProfileDto, rawKey: string | null) {
    return this.createProfile(c, 'AQL', dto, rawKey);
  }

  async createFabricScoringProfile(c: AdvancedQualityContext, dto: CreateFabricScoringProfileDto, rawKey: string | null) {
    return this.createProfile(c, 'FABRIC', dto, rawKey);
  }

  async listProfiles(c: AdvancedQualityContext, kind: ProfileKind, rawStatus?: string) {
    this.validateScope(c);
    const status = rawStatus?.trim().toUpperCase() || null;
    if (status && !['DRAFT', 'ACTIVE', 'RETIRED'].includes(status)) {
      throw new BadRequestException('status must be DRAFT, ACTIVE or RETIRED');
    }
    const table = this.profileTable(kind);
    const columns = kind === 'AQL'
      ? 'aql_percent::text AS aql_percent, inspection_level, lot_size_min, lot_size_max, sample_size, accept_number, reject_number'
      : 'max_points_per_100_square_yards::text AS max_points_per_100_square_yards, minimum_roll_count';
    const r = await this.database.query(
      'SELECT id::text AS id, profile_code, revision, inspection_type, status, row_version::int AS row_version, notes, ' +
      'created_by_user_id::text AS created_by_user_id, updated_by_user_id::text AS updated_by_user_id, ' +
      'created_at::text AS created_at, updated_at::text AS updated_at, ' + columns +
      ' FROM ' + table + ' WHERE tenant_id=$1 AND factory_id=$2 AND ($3::text IS NULL OR status=$3)' +
      ' ORDER BY lower(profile_code), revision DESC LIMIT 100',
      [c.tenantId, c.factoryId, status], { tenantId: c.tenantId, userId: c.userId });
    return r.rows;
  }

  async transitionAqlProfile(c: AdvancedQualityContext, profileId: string, dto: QualityAdvancedProfileTransitionDto, rawKey: string | null) {
    return this.transitionProfile(c, 'AQL', profileId, dto, rawKey);
  }

  async transitionFabricScoringProfile(c: AdvancedQualityContext, profileId: string, dto: QualityAdvancedProfileTransitionDto, rawKey: string | null) {
    return this.transitionProfile(c, 'FABRIC', profileId, dto, rawKey);
  }

  async bindSamplingProfiles(c: AdvancedQualityContext, inspectionId: string, dto: BindQualitySamplingProfilesDto, rawKey: string | null) {
    this.validateScope(c);
    this.uuid(inspectionId, 'inspectionId');
    const key = this.key(rawKey);
    const aqlCode = this.optionalCode(dto.aql_profile_code, 'aql_profile_code');
    const fabricCode = this.optionalCode(dto.fabric_scoring_profile_code, 'fabric_scoring_profile_code');
    if (!aqlCode && !fabricCode) throw new BadRequestException('at least one sampling profile code is required');
    const request = { inspection_id: inspectionId, expected_version: dto.expected_version, aql_profile_code: aqlCode, fabric_scoring_profile_code: fabricCode };
    const hash = this.hash(request), correlation = this.correlation(c);

    const result = await this.database.transaction(c, async client => {
      await this.lockKey(client, c, 'sampling-profile-binding', key);
      const old = await client.query(
        'SELECT inspection_id::text AS inspection_id, request_hash FROM quality_sampling_profile_bindings WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId, c.factoryId, key]);
      if (old.rows[0]) {
        if (String(old.rows[0].request_hash).trim() !== hash) throw new ConflictException('Idempotency-Key was already used for another profile binding');
        return { id: String(old.rows[0].inspection_id), replayed: true };
      }

      const inspectionResult = await client.query(
        'SELECT id::text AS id, inspection_type, status, row_version::int AS row_version, aql_profile_id::text AS aql_profile_id, fabric_scoring_profile_id::text AS fabric_scoring_profile_id FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [inspectionId, c.tenantId, c.factoryId]);
      const inspection = inspectionResult.rows[0];
      if (!inspection) throw new NotFoundException('Quality inspection was not found in this factory');
      if (Number(inspection.row_version) !== dto.expected_version) throw new ConflictException('Quality inspection version is stale');
      if (inspection.status !== 'OPEN' || inspection.aql_profile_id || inspection.fabric_scoring_profile_id) {
        throw new ConflictException('Sampling profiles can only be bound once while the inspection is OPEN');
      }

      const aql = aqlCode ? await this.findActiveProfile(client, c, 'AQL', aqlCode, String(inspection.inspection_type)) : null;
      const fabric = fabricCode ? await this.findActiveProfile(client, c, 'FABRIC', fabricCode, String(inspection.inspection_type)) : null;
      await client.query(
        'UPDATE quality_inspections SET aql_profile_id=$1::uuid, fabric_scoring_profile_id=$2::uuid, updated_by_user_id=$3, updated_at=clock_timestamp() WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND row_version=$7',
        [aql?.id ?? null, fabric?.id ?? null, c.userId, inspectionId, c.tenantId, c.factoryId, dto.expected_version]);
      await client.query(
        'INSERT INTO quality_sampling_profile_bindings (tenant_id,factory_id,inspection_id,aql_profile_id,fabric_scoring_profile_id,idempotency_key,request_hash,created_by_user_id,correlation_id) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9::uuid)',
        [c.tenantId, c.factoryId, inspectionId, aql?.id ?? null, fabric?.id ?? null, key, hash, c.userId, correlation]);
      await this.auditOutbox(client, c, {
        inspectionId, action: 'SAMPLING_PROFILES_BOUND', correlation,
        payload: { aql_profile_code: aqlCode, aql_profile_revision: aql?.revision ?? null,
          fabric_scoring_profile_code: fabricCode, fabric_profile_revision: fabric?.revision ?? null,
          idempotency_key: key, request_hash: hash, expected_version: dto.expected_version },
        aggregateType: 'QUALITY_INSPECTION', aggregateId: inspectionId, outboxEvent: 'QUALITY.SAMPLING_PROFILES_BOUND',
      });
      return { id: inspectionId, replayed: false };
    });

    const bound = await this.database.query(
      'SELECT id::text AS inspection_id, inspection_type, status, row_version::int AS row_version, aql_profile_id::text AS aql_profile_id, fabric_scoring_profile_id::text AS fabric_scoring_profile_id FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [result.id, c.tenantId, c.factoryId], { tenantId: c.tenantId, userId: c.userId });
    return { ...bound.rows[0], replayed: result.replayed };
  }

  async recordAqlSample(c: AdvancedQualityContext, inspectionId: string, dto: RecordQualityAqlSampleDto, rawKey: string | null) {
    this.validateScope(c);
    this.uuid(inspectionId, 'inspectionId');
    const key = this.key(rawKey);
    if (!Number.isInteger(dto.lot_size) || dto.lot_size < 1 || !Number.isInteger(dto.observed_nonconforming) || dto.observed_nonconforming < 0) {
      throw new BadRequestException('lot_size must be positive and observed_nonconforming must be a non-negative integer');
    }
    const evidence = this.jsonObject(dto.evidence);
    const hash = this.hash({ inspection_id: inspectionId, lot_size: dto.lot_size, observed_nonconforming: dto.observed_nonconforming, evidence });
    const correlation = this.correlation(c);

    const result = await this.database.transaction(c, async client => {
      await this.lockKey(client, c, 'aql-sample', key);
      const replay = await client.query(
        'SELECT id::text AS id, request_hash FROM quality_aql_sample_runs WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId, c.factoryId, key]);
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_hash).trim() !== hash) throw new ConflictException('Idempotency-Key was already used for a different AQL sample');
        return { id: String(replay.rows[0].id), replayed: true };
      }
      const inspection = await client.query(
        'SELECT status, aql_profile_id::text AS aql_profile_id FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [inspectionId, c.tenantId, c.factoryId]);
      if (!inspection.rows[0]) throw new NotFoundException('Quality inspection was not found in this factory');
      if (!inspection.rows[0].aql_profile_id) throw new ConflictException('Bind an ACTIVE AQL profile before recording the sample');
      if (!['OPEN', 'IN_PROGRESS'].includes(String(inspection.rows[0].status))) throw new ConflictException('AQL sample can only be recorded for an open or in-progress inspection');
      const prior = await client.query('SELECT id FROM quality_aql_sample_runs WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3',
        [inspectionId, c.tenantId, c.factoryId]);
      if (prior.rows[0]) throw new ConflictException('This inspection already has an AQL sample run; create a new inspection for re-sampling');
      const inserted = await client.query(
        'INSERT INTO quality_aql_sample_runs (tenant_id,factory_id,inspection_id,profile_id,profile_revision,aql_percent_snapshot,inspection_level_snapshot,' +
        'lot_size,sample_size,accept_number,reject_number,observed_nonconforming,decision,evidence,idempotency_key,request_hash,created_by_user_id,correlation_id) ' +
        'SELECT $1,$2,qi.id,p.id,p.revision,p.aql_percent,p.inspection_level,$4,p.sample_size,p.accept_number,p.reject_number,$5,' +
        "'HOLD'::text,$6::jsonb,$7,$8,$9,$10::uuid FROM quality_inspections qi " +
        'JOIN quality_aql_profiles p ON p.id=qi.aql_profile_id AND p.tenant_id=qi.tenant_id AND p.factory_id=qi.factory_id ' +
        'WHERE qi.id=$3 AND qi.tenant_id=$1 AND qi.factory_id=$2 RETURNING id::text AS id, decision',
        [c.tenantId, c.factoryId, inspectionId, dto.lot_size, dto.observed_nonconforming, JSON.stringify(evidence), key, hash, c.userId, correlation]);
      const row = inserted.rows[0];
      if (!row) throw new ConflictException('The bound AQL profile could not be resolved');
      await this.auditOutbox(client, c, {
        inspectionId, action: 'AQL_SAMPLE_RECORDED', correlation,
        payload: { aql_sample_run_id: row.id, decision: row.decision, lot_size: dto.lot_size, observed_nonconforming: dto.observed_nonconforming, idempotency_key: key },
        aggregateType: 'QUALITY_INSPECTION', aggregateId: inspectionId, outboxEvent: 'QUALITY.AQL_SAMPLE_RECORDED',
      });
      return { id: String(row.id), replayed: false };
    });

    const q = await this.database.query(
      'SELECT id::text AS id, inspection_id::text AS inspection_id, profile_id::text AS profile_id, profile_revision, ' +
      'aql_percent_snapshot::text AS aql_percent, inspection_level_snapshot, lot_size, sample_size, accept_number, reject_number, ' +
      'observed_nonconforming, decision, evidence, created_at::text AS created_at FROM quality_aql_sample_runs WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [result.id, c.tenantId, c.factoryId], { tenantId: c.tenantId, userId: c.userId });
    if (q.rows[0] && q.rows[0].decision !== 'ACCEPT') {
      await this.ensureInspectionHeld(c, inspectionId, key, 'AQL sample decision ' + q.rows[0].decision + ' requires quality review');
    }
    return { ...q.rows[0], replayed: result.replayed };
  }

  async recordFabricRollScore(c: AdvancedQualityContext, inspectionId: string, dto: RecordFabricRollScoreDto, rawKey: string | null) {
    this.validateScope(c);
    this.uuid(inspectionId, 'inspectionId');
    const key = this.key(rawKey);
    const rollCode = this.text(dto.roll_code, 'roll_code', 120).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,119}$/.test(rollCode)) throw new BadRequestException('roll_code must be a valid code');
    this.positiveDecimal(dto.roll_length_yards, 'roll_length_yards', 4);
    this.positiveDecimal(dto.roll_width_inches, 'roll_width_inches', 4);
    this.nonNegativeDecimal(dto.total_defect_points, 'total_defect_points', 4);
    if (!Array.isArray(dto.defects) || dto.defects.length > 1000) throw new BadRequestException('defects must be an array of at most 1000 point records');
    for (const item of dto.defects) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.points !== 'number' ||
        !Number.isFinite(item.points) || item.points < 0 || Math.abs(item.points * 10000 - Math.round(item.points * 10000)) > 0.000001) {
        throw new BadRequestException('each fabric defect record must include non-negative points with at most four decimals');
      }
    }
    const sum = dto.defects.reduce((total, item) => total + Number(item.points), 0);
    if (Math.abs(sum - dto.total_defect_points) > 0.000001) {
      throw new BadRequestException('total_defect_points must equal the sum of points in defects');
    }
    const evidence = this.jsonObject(dto.evidence);
    const defects = dto.defects;
    const request = { inspection_id: inspectionId, roll_code: rollCode, roll_length_yards: dto.roll_length_yards,
      roll_width_inches: dto.roll_width_inches, total_defect_points: dto.total_defect_points, defects, evidence };
    const hash = this.hash(request), correlation = this.correlation(c);

    const result = await this.database.transaction(c, async client => {
      await this.lockKey(client, c, 'fabric-roll-score', key);
      const replay = await client.query(
        'SELECT id::text AS id, request_hash FROM quality_fabric_roll_scores WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId, c.factoryId, key]);
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_hash).trim() !== hash) throw new ConflictException('Idempotency-Key was already used for a different fabric roll score');
        return { id: String(replay.rows[0].id), replayed: true };
      }
      const inspection = await client.query(
        'SELECT status, fabric_scoring_profile_id::text AS fabric_scoring_profile_id FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [inspectionId, c.tenantId, c.factoryId]);
      if (!inspection.rows[0]) throw new NotFoundException('Quality inspection was not found in this factory');
      if (!inspection.rows[0].fabric_scoring_profile_id) throw new ConflictException('Bind an ACTIVE fabric-scoring profile before scoring rolls');
      if (!['OPEN', 'IN_PROGRESS'].includes(String(inspection.rows[0].status))) throw new ConflictException('Roll scores can only be recorded for an open or in-progress inspection');
      const inserted = await client.query(
        'INSERT INTO quality_fabric_roll_scores (tenant_id,factory_id,inspection_id,profile_id,profile_revision,roll_code,roll_length_yards,roll_width_inches,' +
        'total_defect_points,points_per_100_square_yards,max_points_snapshot,decision,defects,evidence,idempotency_key,request_hash,created_by_user_id,correlation_id) ' +
        "SELECT $1,$2,qi.id,p.id,p.revision,$4,$5::numeric,$6::numeric,$7::numeric,0,p.max_points_per_100_square_yards,'HOLD',$8::jsonb,$9::jsonb,$10,$11,$12,$13::uuid " +
        'FROM quality_inspections qi JOIN quality_fabric_scoring_profiles p ON p.id=qi.fabric_scoring_profile_id AND p.tenant_id=qi.tenant_id AND p.factory_id=qi.factory_id ' +
        'WHERE qi.id=$3 AND qi.tenant_id=$1 AND qi.factory_id=$2 RETURNING id::text AS id, decision, points_per_100_square_yards::text AS score',
        [c.tenantId, c.factoryId, inspectionId, rollCode, dto.roll_length_yards.toFixed(4), dto.roll_width_inches.toFixed(4),
          dto.total_defect_points.toFixed(4), JSON.stringify(defects), JSON.stringify(evidence), key, hash, c.userId, correlation]);
      const row = inserted.rows[0];
      if (!row) throw new ConflictException('The bound fabric scoring profile could not be resolved');
      await this.auditOutbox(client, c, {
        inspectionId, action: 'FABRIC_ROLL_SCORED', correlation,
        payload: { roll_score_id: row.id, roll_code: rollCode, score_per_100_square_yards: row.score, decision: row.decision, idempotency_key: key },
        aggregateType: 'QUALITY_INSPECTION', aggregateId: inspectionId, outboxEvent: 'QUALITY.FABRIC_ROLL_SCORED',
      });
      return { id: String(row.id), replayed: false };
    });

    const q = await this.database.query(
      'SELECT id::text AS id, inspection_id::text AS inspection_id, profile_id::text AS profile_id, profile_revision, ' +
      'roll_code, roll_length_yards::text AS roll_length_yards, roll_width_inches::text AS roll_width_inches, ' +
      'total_defect_points::text AS total_defect_points, points_per_100_square_yards::text AS points_per_100_square_yards, ' +
      'max_points_snapshot::text AS max_points_per_100_square_yards, decision, defects, evidence, created_at::text AS created_at ' +
      'FROM quality_fabric_roll_scores WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [result.id, c.tenantId, c.factoryId], { tenantId: c.tenantId, userId: c.userId });
    if (q.rows[0] && q.rows[0].decision !== 'PASS') {
      await this.ensureInspectionHeld(c, inspectionId, key, 'Fabric roll ' + q.rows[0].roll_code + ' exceeded the approved point limit');
    }
    return { ...q.rows[0], replayed: result.replayed };
  }

  async recordDefectContext(c: AdvancedQualityContext, defectId: string, dto: RecordQualityDefectContextDto, rawKey: string | null) {
    this.validateScope(c);
    this.uuid(defectId, 'defectId');
    const key = this.key(rawKey);
    const line = this.optionalText(dto.line_code, 'line_code', 100);
    const operation = this.optionalText(dto.operation_code, 'operation_code', 100);
    const style = this.optionalText(dto.style_code, 'style_code', 120);
    const shift = this.optionalText(dto.shift_code, 'shift_code', 80);
    if (!line && !operation && !style && !shift) throw new BadRequestException('at least one line, operation, style or shift dimension is required');
    const evidence = this.jsonObject(dto.evidence);
    const request = { defect_id: defectId, line_code: line, operation_code: operation, style_code: style, shift_code: shift, evidence };
    const hash = this.hash(request), correlation = this.correlation(c);

    const result = await this.database.transaction(c, async client => {
      await this.lockKey(client, c, 'defect-context', key);
      const replay = await client.query(
        'SELECT id::text AS id, defect_id::text AS defect_id, request_hash FROM quality_defect_context_snapshots WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId, c.factoryId, key]);
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_hash).trim() !== hash) throw new ConflictException('Idempotency-Key was already used for another defect context');
        return { id: String(replay.rows[0].id), replayed: true };
      }
      const defect = await client.query(
        'SELECT id::text AS id, inspection_id::text AS inspection_id FROM quality_defects WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [defectId, c.tenantId, c.factoryId]);
      if (!defect.rows[0]) throw new NotFoundException('Quality defect was not found in this factory');
      const previous = await client.query('SELECT id FROM quality_defect_context_snapshots WHERE defect_id=$1 AND tenant_id=$2 AND factory_id=$3',
        [defectId, c.tenantId, c.factoryId]);
      if (previous.rows[0]) throw new ConflictException('Defect context is already recorded and immutable');
      const inserted = await client.query(
        'INSERT INTO quality_defect_context_snapshots (tenant_id,factory_id,defect_id,line_code,operation_code,style_code,shift_code,evidence,idempotency_key,request_hash,created_by_user_id) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING id::text AS id',
        [c.tenantId, c.factoryId, defectId, line, operation, style, shift, JSON.stringify(evidence), key, hash, c.userId]);
      const id = String(inserted.rows[0]?.id ?? '');
      if (!id) throw new Error('QUALITY_DEFECT_CONTEXT_INSERT_FAILED');
      await this.auditOutbox(client, c, {
        inspectionId: String(defect.rows[0].inspection_id), defectId, action: 'DEFECT_CONTEXT_RECORDED', correlation,
        payload: { context_id: id, line_code: line, operation_code: operation, style_code: style, shift_code: shift,
          idempotency_key: key, request_hash: hash },
        aggregateType: 'QUALITY_DEFECT', aggregateId: defectId, outboxEvent: 'QUALITY.DEFECT_CONTEXT_RECORDED',
      });
      return { id, replayed: false };
    });
    const row = await this.database.query(
      'SELECT id::text AS id, defect_id::text AS defect_id, line_code, operation_code, style_code, shift_code, evidence, created_at::text AS created_at ' +
      'FROM quality_defect_context_snapshots WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [result.id, c.tenantId, c.factoryId], { tenantId: c.tenantId, userId: c.userId });
    return { ...row.rows[0], replayed: result.replayed };
  }

  async getInspectionAdvancedEvidence(c: AdvancedQualityContext, inspectionId: string) {
    this.validateScope(c);
    this.uuid(inspectionId, 'inspectionId');
    const inspection = await this.database.query(
      'SELECT id::text AS id, inspection_type, status, plan_code, plan_id::text AS plan_id, plan_revision, ' +
      'aql_profile_id::text AS aql_profile_id, fabric_scoring_profile_id::text AS fabric_scoring_profile_id ' +
      'FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [inspectionId, c.tenantId, c.factoryId], { tenantId: c.tenantId, userId: c.userId });
    if (!inspection.rows[0]) throw new NotFoundException('Quality inspection was not found in this factory');
    const [bindings, aqlSamples, rollScores] = await Promise.all([
      this.database.query('SELECT id::text AS id,aql_profile_id::text AS aql_profile_id,fabric_scoring_profile_id::text AS fabric_scoring_profile_id,idempotency_key,created_by_user_id::text AS created_by_user_id,created_at::text AS created_at FROM quality_sampling_profile_bindings WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3',
        [inspectionId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query('SELECT id::text AS id,profile_id::text AS profile_id,profile_revision,aql_percent_snapshot::text AS aql_percent,inspection_level_snapshot,lot_size,sample_size,accept_number,reject_number,observed_nonconforming,decision,evidence,created_by_user_id::text AS created_by_user_id,created_at::text AS created_at FROM quality_aql_sample_runs WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY created_at,id',
        [inspectionId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
      this.database.query('SELECT id::text AS id,profile_id::text AS profile_id,profile_revision,roll_code,roll_length_yards::text AS roll_length_yards,roll_width_inches::text AS roll_width_inches,total_defect_points::text AS total_defect_points,points_per_100_square_yards::text AS points_per_100_square_yards,max_points_snapshot::text AS max_points_per_100_square_yards,decision,defects,evidence,created_by_user_id::text AS created_by_user_id,created_at::text AS created_at FROM quality_fabric_roll_scores WHERE inspection_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY roll_code,id',
        [inspectionId,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId}),
    ]);
    return {inspection:inspection.rows[0],profile_bindings:bindings.rows,aql_sample_runs:aqlSamples.rows,fabric_roll_scores:rollScores.rows};
  }

  async defectPareto(c: AdvancedQualityContext, query: QualityDefectParetoQueryDto) {
    this.validateScope(c);
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    if (query.from && query.to && new Date(query.from).getTime() > new Date(query.to).getTime()) {
      throw new BadRequestException('from must not be later than to');
    }
    const sql = 'WITH grouped AS (' +
      ' SELECT CASE $3::text WHEN \'DEFECT\' THEN d.defect_code WHEN \'LINE\' THEN c.line_code WHEN \'OPERATION\' THEN c.operation_code WHEN \'STYLE\' THEN c.style_code WHEN \'SHIFT\' THEN c.shift_code END AS dimension_value,' +
      ' count(*)::int AS defect_count,sum(d.affected_quantity)::numeric(18,4) AS affected_quantity,' +
      ' count(*) FILTER (WHERE d.severity=\'CRITICAL\')::int AS critical_count,' +
      ' count(*) FILTER (WHERE d.status IN (\'OPEN\',\'REWORK\'))::int AS unresolved_count' +
      ' FROM quality_defects d LEFT JOIN quality_defect_context_snapshots c ON c.defect_id=d.id AND c.tenant_id=d.tenant_id AND c.factory_id=d.factory_id' +
      ' WHERE d.tenant_id=$1 AND d.factory_id=$2 AND ($4::timestamptz IS NULL OR d.created_at >= $4::timestamptz)' +
      ' AND ($5::timestamptz IS NULL OR d.created_at <= $5::timestamptz)' +
      ' GROUP BY 1 HAVING NULLIF(btrim(CASE $3::text WHEN \'DEFECT\' THEN d.defect_code WHEN \'LINE\' THEN c.line_code WHEN \'OPERATION\' THEN c.operation_code WHEN \'STYLE\' THEN c.style_code WHEN \'SHIFT\' THEN c.shift_code END),\'\') IS NOT NULL' +
      '), ranked AS (SELECT grouped.*,sum(defect_count) OVER ()::numeric AS total_defects,' +
      ' sum(defect_count) OVER (ORDER BY defect_count DESC,dimension_value ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_defects FROM grouped)' +
      ' SELECT dimension_value,defect_count,affected_quantity,critical_count,unresolved_count,total_defects::int AS total_defects,' +
      ' round(100*cumulative_defects/NULLIF(total_defects,0),2) AS cumulative_defect_percent FROM ranked ORDER BY defect_count DESC,dimension_value LIMIT $6';
    const result = await this.database.query(sql, [c.tenantId,c.factoryId,query.dimension,query.from??null,query.to??null,limit],
      {tenantId:c.tenantId,userId:c.userId});
    return {dimension:query.dimension,from:query.from??null,to:query.to??null,items:result.rows};
  }

  async supplierQuality(c: AdvancedQualityContext, rawLimit?: number) {
    this.validateScope(c);
    const limit = rawLimit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    const r = await this.database.query(
      'SELECT s.id::text AS supplier_id,s.code AS supplier_code,s.name AS supplier_name,' +
      ' count(DISTINCT e.defect_id)::int AS defect_count,count(DISTINCT e.goods_receipt_line_id)::int AS affected_receipt_lines,' +
      ' count(DISTINCT e.goods_receipt_id)::int AS affected_receipts,sum(e.affected_quantity)::numeric(18,4)::text AS reported_affected_quantity,' +
      ' count(*) FILTER (WHERE e.severity=\'CRITICAL\')::int AS critical_event_count,' +
      ' count(*) FILTER (WHERE e.severity=\'MAJOR\')::int AS major_event_count,count(*) FILTER (WHERE e.severity=\'MINOR\')::int AS minor_event_count,' +
      ' count(DISTINCT r.id)::int AS linked_rework_task_count,max(e.created_at)::text AS latest_quality_event_at' +
      ' FROM quality_supplier_quality_events e JOIN suppliers s ON s.id=e.supplier_id AND s.tenant_id=e.tenant_id' +
      ' LEFT JOIN quality_rework_orders r ON r.defect_id=e.defect_id AND r.tenant_id=e.tenant_id AND r.factory_id=e.factory_id' +
      ' WHERE e.tenant_id=$1 AND e.factory_id=$2 GROUP BY s.id,s.code,s.name' +
      ' ORDER BY critical_event_count DESC,defect_count DESC,s.code LIMIT $3',
      [c.tenantId,c.factoryId,limit],{tenantId:c.tenantId,userId:c.userId});
    return r.rows;
  }

  async reworkRepeatAlerts(c: AdvancedQualityContext, query: QualityRepeatAlertsQueryDto) {
    this.validateScope(c);
    const days = query.lookback_days ?? 30, minimum = query.minimum_occurrences ?? 3, limit = query.limit ?? 50;
    if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(minimum) || minimum < 2 || minimum > 10000 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('lookback_days, minimum_occurrences or limit is outside its allowed range');
    }
    const r = await this.database.query(
      'WITH defect_source AS (' +
      ' SELECT d.id,d.defect_code,d.severity,d.affected_quantity,d.status,d.created_at,c.style_code' +
      ' FROM quality_defects d LEFT JOIN quality_defect_context_snapshots c ON c.defect_id=d.id AND c.tenant_id=d.tenant_id AND c.factory_id=d.factory_id' +
      ' WHERE d.tenant_id=$1 AND d.factory_id=$2 AND d.created_at>=clock_timestamp()-($3::int*interval \'1 day\')' +
      '), supplier_by_defect AS (' +
      ' SELECT DISTINCT ON (e.defect_id) e.defect_id,e.supplier_id,s.code AS supplier_code FROM quality_supplier_quality_events e' +
      ' JOIN suppliers s ON s.id=e.supplier_id AND s.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND e.factory_id=$2 ORDER BY e.defect_id,e.created_at' +
      '), rework_by_defect AS (' +
      ' SELECT defect_id,count(*)::int AS task_count FROM quality_rework_orders WHERE tenant_id=$1 AND factory_id=$2 AND status<>\'CANCELLED\' GROUP BY defect_id' +
      ')' +
      ' SELECT ds.defect_code,COALESCE(ds.style_code,\'(not captured)\') AS style_code,sbd.supplier_id::text AS supplier_id,' +
      ' COALESCE(sbd.supplier_code,\'(not supplier-linked)\') AS supplier_code,count(DISTINCT ds.id)::int AS occurrence_count,' +
      ' count(DISTINCT ds.id) FILTER (WHERE ds.severity=\'CRITICAL\')::int AS critical_count,' +
      ' sum(ds.affected_quantity)::numeric(18,4)::text AS affected_quantity,' +
      ' count(DISTINCT ds.id) FILTER (WHERE ds.status IN (\'OPEN\',\'REWORK\'))::int AS unresolved_count,' +
      ' sum(COALESCE(rbd.task_count,0))::int AS rework_task_count,max(ds.created_at)::text AS latest_occurrence_at,' +
      ' CASE WHEN count(DISTINCT ds.id) FILTER (WHERE ds.severity=\'CRITICAL\')>0 THEN \'HIGH\'' +
      ' WHEN count(DISTINCT ds.id)>=$4::int*2 THEN \'MEDIUM\' ELSE \'WATCH\' END AS alert_level' +
      ' FROM defect_source ds LEFT JOIN supplier_by_defect sbd ON sbd.defect_id=ds.id' +
      ' LEFT JOIN rework_by_defect rbd ON rbd.defect_id=ds.id' +
      ' GROUP BY ds.defect_code,ds.style_code,sbd.supplier_id,sbd.supplier_code' +
      ' HAVING count(DISTINCT ds.id)>=$4 ORDER BY critical_count DESC,occurrence_count DESC,latest_occurrence_at DESC LIMIT $5',
      [c.tenantId,c.factoryId,days,minimum,limit],{tenantId:c.tenantId,userId:c.userId});
    return {lookback_days:days,minimum_occurrences:minimum,items:r.rows};
  }

  private async ensureInspectionHeld(c: AdvancedQualityContext, inspectionId: string, sourceKey: string, reason: string) {
    const state = await this.database.query(
      'SELECT status,row_version::int AS row_version FROM quality_inspections WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [inspectionId,c.tenantId,c.factoryId], { tenantId:c.tenantId,userId:c.userId });
    const row = state.rows[0];
    if (!row) throw new NotFoundException('Quality inspection was not found in this factory');
    if (row.status === 'ON_HOLD') return;
    if (!['OPEN','IN_PROGRESS'].includes(String(row.status))) {
      throw new ConflictException('Non-accepted advanced quality evidence requires a hold, but the inspection is already ' + row.status);
    }
    await this.qualityService.decideInspection(c, inspectionId, {
      action:'HOLD', expected_version:Number(row.row_version), reason,
    }, 'advanced-quality-hold:' + this.hash({inspectionId,sourceKey}).slice(0,48));
  }

  private async createProfile(c: AdvancedQualityContext, kind: ProfileKind, dto: CreateQualityAqlProfileDto | CreateFabricScoringProfileDto, rawKey: string | null) {
    this.validateScope(c);
    const key = this.key(rawKey), table = this.profileTable(kind), profileCode = this.requiredCode(dto.profile_code);
    const notes = dto.notes?.trim() || null, correlation = this.correlation(c);
    let payload: Record<string, unknown>;
    if (kind === 'AQL') {
      const x = dto as CreateQualityAqlProfileDto;
      this.positiveDecimal(x.aql_percent, 'aql_percent', 3);
      if (x.lot_size_max < x.lot_size_min || x.sample_size > x.lot_size_min || x.reject_number <= x.accept_number || x.reject_number > x.sample_size) {
        throw new BadRequestException('lot-size range, sample size and accept/reject numbers are inconsistent');
      }
      payload = { kind, profile_code: profileCode, inspection_type: x.inspection_type, aql_percent: Number(x.aql_percent.toFixed(3)),
        inspection_level: x.inspection_level, lot_size_min: x.lot_size_min, lot_size_max: x.lot_size_max,
        sample_size: x.sample_size, accept_number: x.accept_number, reject_number: x.reject_number, notes };
    } else {
      const x = dto as CreateFabricScoringProfileDto;
      this.positiveDecimal(x.max_points_per_100_square_yards, 'max_points_per_100_square_yards', 4);
      payload = { kind, profile_code: profileCode, inspection_type: x.inspection_type,
        max_points_per_100_square_yards: Number(x.max_points_per_100_square_yards.toFixed(4)), minimum_roll_count: x.minimum_roll_count, notes };
    }
    const hash = this.hash(payload);
    const result = await this.database.transaction(c, async client => {
      await this.lockKey(client,c,kind.toLowerCase()+'-profile',key);
      const existing = await client.query('SELECT id::text AS id,request_hash FROM ' + table + ' WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [c.tenantId,c.factoryId,key]);
      if (existing.rows[0]) {
        if (String(existing.rows[0].request_hash).trim() !== hash) throw new ConflictException('Idempotency-Key was already used for a different profile');
        return {id:String(existing.rows[0].id),replayed:true};
      }
      const rev = await client.query('SELECT COALESCE(MAX(revision),0)::int+1 AS revision FROM ' + table +
        ' WHERE tenant_id=$1 AND factory_id=$2 AND lower(profile_code)=lower($3)',[c.tenantId,c.factoryId,profileCode]);
      const revision = Number(rev.rows[0]?.revision ?? 1);
      let inserted;
      if (kind === 'AQL') {
        const x = dto as CreateQualityAqlProfileDto;
        inserted = await client.query(
          'INSERT INTO quality_aql_profiles (tenant_id,factory_id,profile_code,revision,inspection_type,aql_percent,inspection_level,lot_size_min,lot_size_max,' +
          'sample_size,accept_number,reject_number,status,row_version,notes,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id) ' +
          "VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10,$11,$12,'DRAFT',1,$13,$14,$15,$16,$16,$17::uuid) RETURNING id::text AS id",
          [c.tenantId,c.factoryId,profileCode,revision,x.inspection_type,x.aql_percent.toFixed(3),x.inspection_level,
            x.lot_size_min,x.lot_size_max,x.sample_size,x.accept_number,x.reject_number,notes,key,hash,c.userId,correlation]);
      } else {
        const x = dto as CreateFabricScoringProfileDto;
        inserted = await client.query(
          'INSERT INTO quality_fabric_scoring_profiles (tenant_id,factory_id,profile_code,revision,inspection_type,max_points_per_100_square_yards,minimum_roll_count,' +
          'status,row_version,notes,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id) ' +
          "VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,'DRAFT',1,$8,$9,$10,$11,$11,$12::uuid) RETURNING id::text AS id",
          [c.tenantId,c.factoryId,profileCode,revision,x.inspection_type,x.max_points_per_100_square_yards.toFixed(4),
            x.minimum_roll_count,notes,key,hash,c.userId,correlation]);
      }
      const id = String(inserted.rows[0]?.id ?? '');
      if (!id) throw new Error('QUALITY_ADVANCED_PROFILE_INSERT_FAILED');
      await this.auditOutbox(client,c,{action:kind+'_PROFILE_CREATED',correlation,payload:{profile_id:id,profile_code:profileCode,revision,kind},
        aggregateType:kind==='AQL'?'QUALITY_AQL_PROFILE':'QUALITY_FABRIC_PROFILE',aggregateId:id,
        outboxEvent:kind==='AQL'?'QUALITY.AQL_PROFILE_CHANGED':'QUALITY.FABRIC_PROFILE_CHANGED'});
      return {id,replayed:false};
    });
    const columns = kind==='AQL'
      ? 'aql_percent::text AS aql_percent,inspection_level,lot_size_min,lot_size_max,sample_size,accept_number,reject_number'
      : 'max_points_per_100_square_yards::text AS max_points_per_100_square_yards,minimum_roll_count';
    const q = await this.database.query(
      'SELECT id::text AS id,profile_code,revision,inspection_type,status,row_version::int AS row_version,' + columns +
      ',notes,created_at::text AS created_at,updated_at::text AS updated_at FROM ' + table + ' WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {...q.rows[0],replayed:result.replayed};
  }

  private async transitionProfile(c: AdvancedQualityContext, kind: ProfileKind, profileId: string, dto: QualityAdvancedProfileTransitionDto, rawKey: string | null) {
    this.validateScope(c);
    this.uuid(profileId,'profileId');
    const key=this.key(rawKey), reason=this.text(dto.reason,'reason',2000), table=this.profileTable(kind);
    const target=dto.action==='ACTIVATE'?'ACTIVE':'RETIRED';
    const hash=this.hash({kind,profile_id:profileId,action:dto.action,expected_version:dto.expected_version,reason});
    const correlation=this.correlation(c);
    const result=await this.database.transaction(c,async client=>{
      await this.lockKey(client,c,kind.toLowerCase()+'-profile-transition',key);
      const actionType=kind+'_PROFILE_'+(dto.action==='ACTIVATE'?'ACTIVATED':'RETIRED');
      const replay=await client.query(
        'SELECT payload FROM quality_audit_events WHERE tenant_id=$1 AND factory_id=$2 AND action_type=$3 AND payload->>\'idempotency_key\'=$4 LIMIT 1 FOR SHARE',
        [c.tenantId,c.factoryId,actionType,key]);
      if(replay.rows[0]){
        if(String(replay.rows[0].payload?.request_hash??'')!==hash) throw new ConflictException('Idempotency-Key was already used for another profile transition');
        return {id:profileId,replayed:true};
      }
      const found=await client.query('SELECT id::text AS id,status,row_version::int AS row_version FROM ' + table +
        ' WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',[profileId,c.tenantId,c.factoryId]);
      const old=found.rows[0];if(!old)throw new NotFoundException('Quality profile was not found in this factory');
      if(Number(old.row_version)!==dto.expected_version)throw new ConflictException('Quality profile version is stale');
      const upd=await client.query('UPDATE ' + table + ' SET status=$1,row_version=row_version+1,updated_by_user_id=$2,updated_at=clock_timestamp() ' +
        'WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND row_version=$6 RETURNING row_version::int AS row_version',
        [target,c.userId,profileId,c.tenantId,c.factoryId,dto.expected_version]);
      if(!upd.rows[0])throw new ConflictException('Quality profile changed during transition');
      await this.auditOutbox(client,c,{action:actionType,correlation,payload:{profile_id:profileId,from_status:old.status,to_status:target,reason,
        expected_version:dto.expected_version,idempotency_key:key,request_hash:hash},
        aggregateType:kind==='AQL'?'QUALITY_AQL_PROFILE':'QUALITY_FABRIC_PROFILE',aggregateId:profileId,
        outboxEvent:kind==='AQL'?'QUALITY.AQL_PROFILE_CHANGED':'QUALITY.FABRIC_PROFILE_CHANGED'});
      return {id:profileId,replayed:false};
    });
    const q=await this.database.query('SELECT id::text AS id,profile_code,revision,inspection_type,status,row_version::int AS row_version FROM ' + table +
      ' WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [result.id,c.tenantId,c.factoryId],{tenantId:c.tenantId,userId:c.userId});
    return {...q.rows[0],replayed:result.replayed};
  }

  private async findActiveProfile(client: PoolClient, c: AdvancedQualityContext, kind: ProfileKind, code: string, type: string): Promise<ProfileRow> {
    const table=this.profileTable(kind);
    const q=await client.query('SELECT id::text AS id,profile_code,revision FROM ' + table +
      ' WHERE tenant_id=$1 AND factory_id=$2 AND lower(profile_code)=lower($3) AND inspection_type=$4 AND status=\'ACTIVE\' ORDER BY revision DESC LIMIT 1 FOR SHARE',
      [c.tenantId,c.factoryId,code,type]);
    if(!q.rows[0])throw new ConflictException('No ACTIVE profile matches the profile code and inspection type in this factory');
    return q.rows[0];
  }

  private async auditOutbox(client: PoolClient, c: AdvancedQualityContext, event: {
    inspectionId?: string; defectId?: string; action: string; correlation: string; payload: Record<string,unknown>;
    aggregateType: string; aggregateId: string; outboxEvent: string;
  }) {
    await client.query(
      'INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id) ' +
      'VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8::uuid)',
      [c.tenantId,c.factoryId,event.inspectionId??null,event.defectId??null,event.action,JSON.stringify(event.payload),c.userId,event.correlation]);
    await client.query(
      'INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [c.tenantId,c.factoryId,event.aggregateType,event.aggregateId,event.outboxEvent,
        JSON.stringify({...event.payload,action:event.action,correlation_id:event.correlation})]);
  }

  private profileTable(kind: ProfileKind) { return kind==='AQL'?'quality_aql_profiles':'quality_fabric_scoring_profiles'; }
  private key(raw: string|null) { const k=raw?.trim()??'';if(!k||k.length>200)throw new BadRequestException('Idempotency-Key is required and must be at most 200 characters');return k; }
  private requiredCode(value: string) { const v=this.text(value,'profile_code',100).toUpperCase();if(!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(v))throw new BadRequestException('profile_code must be a valid code');return v; }
  private optionalCode(value: string|undefined,_field: string) { if(value===undefined||!value.trim())return null;return this.requiredCode(value); }
  private text(value: string|undefined,field: string,max: number) { const v=value?.trim()??'';if(!v||v.length>max)throw new BadRequestException(field+' is required and must contain at most '+max+' characters');return v; }
  private optionalText(value: string|undefined,field: string,max: number) { if(value===undefined||!value.trim())return null;const v=value.trim();if(v.length>max)throw new BadRequestException(field+' must contain at most '+max+' characters');return v; }
  private positiveDecimal(value: number,field: string,places: number) { if(!Number.isFinite(value)||value<=0||Math.abs(value*10**places-Math.round(value*10**places))>0.000001)throw new BadRequestException(field+' must be positive with at most '+places+' decimal places'); }
  private nonNegativeDecimal(value: number,field: string,places: number) { if(!Number.isFinite(value)||value<0||Math.abs(value*10**places-Math.round(value*10**places))>0.000001)throw new BadRequestException(field+' must be non-negative with at most '+places+' decimal places'); }
  private jsonObject(value?: Record<string,unknown>) { if(value==null)return{};if(typeof value!=='object'||Array.isArray(value))throw new BadRequestException('evidence must be a JSON object');return value; }
  private uuid(value: string,field: string) { if(!isUUID(value))throw new BadRequestException(field+' must be a UUID'); }
  private validateScope(c: AdvancedQualityContext) { this.uuid(c.userId,'userId');this.uuid(c.tenantId,'tenantId');this.uuid(c.factoryId,'factoryId'); }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private correlation(c: AdvancedQualityContext) { if(c.traceId&&isUUID(c.traceId))return c.traceId;if(c.requestId&&isUUID(c.requestId))return c.requestId;return randomUUID(); }
  private async lockKey(client: PoolClient,c: AdvancedQualityContext,namespace: string,key: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['quality-advanced:'+c.tenantId+':'+c.factoryId+':'+namespace+':'+key]);
  }
}
