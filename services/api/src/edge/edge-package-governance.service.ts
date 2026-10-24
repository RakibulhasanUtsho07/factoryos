import { createHash, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import type { EdgePackageTrustedSigningKey } from './packages/edge-package-manifest-verifier.js';
import { EdgePackageControlAction, EdgePackageControlTargetKind, SetEdgePackageControlDto } from './dto/set-edge-package-control.dto';
import { RegisterEdgePackageSigningKeyDto } from './dto/register-edge-package-signing-key.dto';
import { RevokeEdgePackageSigningKeyDto } from './dto/revoke-edge-package-signing-key.dto';

export interface EdgePackageAuditContext { requestId?: string | null; correlationId?: string | null; }

interface KeyRow extends QueryResultRow {
  id: string; key_id: string; public_key_pem: string; fingerprint_sha256: string;
  status: 'ACTIVE' | 'REVOKED'; replaces_key_id: string | null; replaces_key_name?: string | null;
  created_at: string; revoked_at: string | null; revoke_reason: string | null;
}
interface ControlRow extends QueryResultRow {
  id: string; package_id: string; package_version: string;
  target_kind: EdgePackageControlTargetKind; target_key: string;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED'; reason: string;
  created_at: string; updated_at: string; revoked_at: string | null;
}
interface DeviceRow extends QueryResultRow { id: string; device_group: string | null; status: string; }

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

@Injectable()
export class EdgePackageGovernanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async registerSigningKey(
    tenantId: string, factoryId: string, actorUserId: string,
    input: RegisterEdgePackageSigningKeyDto, auditContext: EdgePackageAuditContext = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.iamService.authorize(actorUserId, tenantId, 'edge.packages.keys.manage', factoryId);
    const keyId = this.keyId(input.key_id);
    const publicKeyPem = this.publicEd25519Key(input.public_key_pem);
    const fingerprint = createHash('sha256').update(
      createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }),
    ).digest('hex');
    const replacesKeyId = input.replaces_key_id ? this.keyId(input.replaces_key_id) : null;
    if (replacesKeyId === keyId) throw new BadRequestException('A signing key cannot replace itself');

    const result = await this.database.transaction(async (client: PoolClient) => {
      let replacesId: string | null = null;
      if (replacesKeyId) {
        const replaced = await client.query<KeyRow>(
          'SELECT id::text AS id, key_id, public_key_pem, fingerprint_sha256, status, replaces_key_id::text AS replaces_key_id, created_at::text AS created_at, revoked_at::text AS revoked_at, revoke_reason FROM edge_package_signing_keys WHERE tenant_id=$1 AND factory_id=$2 AND key_id=$3 FOR UPDATE',
          [tenantId, factoryId, replacesKeyId],
        );
        const old = replaced.rows[0];
        if (!old) throw new NotFoundException('The signing key being rotated was not found');
        if (old.status !== 'ACTIVE') throw new ConflictException('A revoked signing key cannot be a rotation source');
        if (old.fingerprint_sha256 === fingerprint) throw new BadRequestException('Rotation must register a different public key');
        replacesId = old.id;
      }
      const selected = await client.query<KeyRow>(
        'SELECT id::text AS id, key_id, public_key_pem, fingerprint_sha256, status, replaces_key_id::text AS replaces_key_id, created_at::text AS created_at, revoked_at::text AS revoked_at, revoke_reason FROM edge_package_signing_keys WHERE tenant_id=$1 AND factory_id=$2 AND key_id=$3 FOR UPDATE',
        [tenantId, factoryId, keyId],
      );
      const existing = selected.rows[0];
      if (existing) {
        if (existing.fingerprint_sha256 === fingerprint && existing.status === 'ACTIVE' && existing.replaces_key_id === replacesId) {
          return { idempotent: true as const, key: existing, replacesKeyId };
        }
        throw new ConflictException('The signing key ID already exists with different contents or has been revoked');
      }
      const inserted = await client.query<KeyRow>(
        'INSERT INTO edge_package_signing_keys (tenant_id,factory_id,key_id,public_key_pem,fingerprint_sha256,status,replaces_key_id,created_by) VALUES ($1,$2,$3,$4,$5,\'ACTIVE\',$6,$7) RETURNING id::text AS id,key_id,public_key_pem,fingerprint_sha256,status,replaces_key_id::text AS replaces_key_id,created_at::text AS created_at,revoked_at::text AS revoked_at,revoke_reason',
        [tenantId, factoryId, keyId, publicKeyPem, fingerprint, replacesId, actorUserId],
      );
      const key = inserted.rows[0];
      if (!key) throw new Error('EDGE_PACKAGE_SIGNING_KEY_INSERT_FAILED');
      await client.query(
        'INSERT INTO edge_package_signing_key_events (tenant_id,factory_id,signing_key_id,related_key_id,event_type,actor_user_id,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [tenantId, factoryId, key.id, replacesId, replacesId ? 'ROTATION_ADDED' : 'REGISTERED', actorUserId,
          JSON.stringify({ keyId, fingerprintSha256: fingerprint, replacesKeyId, oldKeyRemainsTrusted: Boolean(replacesId) })],
      );
      return { idempotent: false as const, key, replacesKeyId };
    }, { tenantId, userId: actorUserId });

    if (!result.idempotent) await this.auditSafely({
      tenantId, factoryId, actorUserId, ...auditContext, eventType: 'EDGE_PACKAGE_SIGNING_KEY',
      action: result.replacesKeyId ? 'ROTATE' : 'REGISTER', resourceType: 'EDGE_PACKAGE_SIGNING_KEY',
      resourceId: result.key.id, payload: { keyId, fingerprintSha256: fingerprint, replacesKeyId: result.replacesKeyId },
    });
    return { idempotent: result.idempotent, signingKey: { ...this.mapKey(result.key), replacesKeyId: result.replacesKeyId }, previousKeyRemainsTrusted: Boolean(result.replacesKeyId) };
  }

  async revokeSigningKey(
    tenantId: string, factoryId: string, actorUserId: string, keyIdInput: string,
    input: RevokeEdgePackageSigningKeyDto, auditContext: EdgePackageAuditContext = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    const keyId = this.keyId(keyIdInput);
    const reason = this.reason(input.reason);
    await this.iamService.authorize(actorUserId, tenantId, 'edge.packages.keys.manage', factoryId);
    const result = await this.database.transaction(async (client: PoolClient) => {
      const selected = await client.query<KeyRow>(
        'SELECT id::text AS id,key_id,public_key_pem,fingerprint_sha256,status,replaces_key_id::text AS replaces_key_id,created_at::text AS created_at,revoked_at::text AS revoked_at,revoke_reason FROM edge_package_signing_keys WHERE tenant_id=$1 AND factory_id=$2 AND key_id=$3 FOR UPDATE',
        [tenantId, factoryId, keyId],
      );
      const existing = selected.rows[0];
      if (!existing) throw new NotFoundException('Edge package signing key not found');
      if (existing.status === 'REVOKED') return { idempotent: true as const, key: existing };
      const updated = await client.query<KeyRow>(
        'UPDATE edge_package_signing_keys SET status=\'REVOKED\',revoked_by=$4,revoked_at=NOW(),revoke_reason=$5 WHERE tenant_id=$1 AND factory_id=$2 AND key_id=$3 RETURNING id::text AS id,key_id,public_key_pem,fingerprint_sha256,status,replaces_key_id::text AS replaces_key_id,created_at::text AS created_at,revoked_at::text AS revoked_at,revoke_reason',
        [tenantId, factoryId, keyId, actorUserId, reason],
      );
      const key = updated.rows[0];
      if (!key) throw new Error('EDGE_PACKAGE_SIGNING_KEY_REVOKE_FAILED');
      await client.query(
        'INSERT INTO edge_package_signing_key_events (tenant_id,factory_id,signing_key_id,event_type,actor_user_id,metadata) VALUES ($1,$2,$3,\'REVOKED\',$4,$5::jsonb)',
        [tenantId, factoryId, key.id, actorUserId, JSON.stringify({ keyId, fingerprintSha256: key.fingerprint_sha256, reason })],
      );
      return { idempotent: false as const, key };
    }, { tenantId, userId: actorUserId });
    if (!result.idempotent) await this.auditSafely({
      tenantId, factoryId, actorUserId, ...auditContext, eventType: 'EDGE_PACKAGE_SIGNING_KEY',
      action: 'REVOKE', resourceType: 'EDGE_PACKAGE_SIGNING_KEY', resourceId: result.key.id,
      payload: { keyId, fingerprintSha256: result.key.fingerprint_sha256, reason },
    });
    return { idempotent: result.idempotent, signingKey: this.mapKey(result.key) };
  }

  async listSigningKeys(tenantId: string, factoryId: string, actorUserId: string, limit = 50, offset = 0) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.pagination(limit, offset);
    await this.iamService.authorize(actorUserId, tenantId, 'edge.packages.keys.read', factoryId);
    const result = await this.database.query<KeyRow>(
      'SELECT k.id::text AS id,k.key_id,k.public_key_pem,k.fingerprint_sha256,k.status,k.replaces_key_id::text AS replaces_key_id,old.key_id AS replaces_key_name,k.created_at::text AS created_at,k.revoked_at::text AS revoked_at,k.revoke_reason FROM edge_package_signing_keys k LEFT JOIN edge_package_signing_keys old ON old.id=k.replaces_key_id AND old.tenant_id=k.tenant_id AND old.factory_id=k.factory_id WHERE k.tenant_id=$1 AND k.factory_id=$2 ORDER BY k.created_at DESC,k.id DESC LIMIT $3 OFFSET $4',
      [tenantId, factoryId, limit + 1, offset], { tenantId, userId: actorUserId },
    );
    const hasMore = result.rows.length > limit;
    return { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null, signingKeys: result.rows.slice(0, limit).map(row => this.mapKey(row)) };
  }

  /**
   * Device-facing complete public-key snapshot. All lifecycle states are sent,
   * including REVOKED keys, so a disconnected edge verifier can explicitly
   * distrust keys without any private material ever leaving the server.
   */
  async getTrustedSigningKeySnapshot(tenantId: string, factoryId: string) {
    this.validateScope(tenantId, factoryId);
    const result = await this.database.query<KeyRow>(
      'SELECT key_id,public_key_pem,fingerprint_sha256,status FROM edge_package_signing_keys WHERE tenant_id=$1 AND factory_id=$2 ORDER BY created_at ASC,id ASC LIMIT 513',
      [tenantId, factoryId], { tenantId },
    );
    if (result.rows.length > 512) {
      throw new ConflictException('The signing-key registry exceeds the edge snapshot safety limit');
    }
    return {
      schemaVersion: 1 as const,
      tenantId: tenantId.toLowerCase(),
      factoryId: factoryId.toLowerCase(),
      checkedAt: new Date().toISOString(),
      signingKeys: result.rows.map((row) => ({
        keyId: row.key_id,
        publicKeyPem: row.public_key_pem,
        fingerprintSha256: row.fingerprint_sha256,
        status: row.status,
      })),
    };
  }

  /** Internal bridge used by edge runtimes to construct trusted-key verifier policy. */
  async getTrustedSigningKeys(tenantId: string, factoryId: string): Promise<Record<string, EdgePackageTrustedSigningKey>> {
    const snapshot = await this.getTrustedSigningKeySnapshot(tenantId, factoryId);
    const keys: Record<string, EdgePackageTrustedSigningKey> = {};
    for (const row of snapshot.signingKeys) Object.defineProperty(keys, row.keyId, {
      value: { publicKeyPem: row.publicKeyPem, status: row.status },
      enumerable: true, configurable: true, writable: true,
    });
    return keys;
  }

  async setPackageControl(
    tenantId: string, factoryId: string, actorUserId: string,
    input: SetEdgePackageControlDto, auditContext: EdgePackageAuditContext = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    const packageId = this.packageId(input.package_id);
    const packageVersion = this.packageVersion(input.package_version ?? '*');
    const target = this.target(input.target_kind, input.target_key);
    const reason = this.reason(input.reason);
    if (!Object.values(EdgePackageControlAction).includes(input.action)) throw new BadRequestException('action must be PAUSE, RESUME, or REVOKE');
    await this.iamService.authorize(actorUserId, tenantId, 'edge.packages.controls.manage', factoryId);

    const result = await this.database.transaction(async (client: PoolClient) => {
      await this.assertTargetExists(client, tenantId, factoryId, target);
      const selected = await client.query<ControlRow>(
        'SELECT id::text AS id,package_id,package_version,target_kind,target_key,status,reason,created_at::text AS created_at,updated_at::text AS updated_at,revoked_at::text AS revoked_at FROM edge_package_controls WHERE tenant_id=$1 AND factory_id=$2 AND package_id=$3 AND package_version=$4 AND target_kind=$5 AND target_key=$6 FOR UPDATE',
        [tenantId, factoryId, packageId, packageVersion, target.kind, target.key],
      );
      const old = selected.rows[0] ?? null;
      const nextStatus = this.statusFor(input.action);
      if (!old && input.action === EdgePackageControlAction.RESUME) throw new NotFoundException('No package pause control exists to resume');
      if (old?.status === 'REVOKED') {
        if (input.action === EdgePackageControlAction.REVOKE) return { idempotent: true as const, control: old, previousStatus: 'REVOKED' };
        throw new ConflictException('A revoked package control is permanent and cannot be resumed');
      }
      if (old && old.status === nextStatus) return { idempotent: true as const, control: old, previousStatus: old.status };

      let control: ControlRow;
      if (!old) {
        const inserted = await client.query<ControlRow>(
          'INSERT INTO edge_package_controls (tenant_id,factory_id,package_id,package_version,target_kind,target_key,status,reason,created_by,updated_by,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,CASE WHEN $7=\'REVOKED\' THEN NOW() ELSE NULL END) RETURNING id::text AS id,package_id,package_version,target_kind,target_key,status,reason,created_at::text AS created_at,updated_at::text AS updated_at,revoked_at::text AS revoked_at',
          [tenantId, factoryId, packageId, packageVersion, target.kind, target.key, nextStatus, reason, actorUserId],
        );
        control = inserted.rows[0];
        if (!control) throw new Error('EDGE_PACKAGE_CONTROL_INSERT_FAILED');
        await this.event(client, tenantId, factoryId, control.id, input.action, null, nextStatus, actorUserId, reason);
      } else {
        const updated = await client.query<ControlRow>(
          'UPDATE edge_package_controls SET status=$4,reason=$5,updated_by=$6,updated_at=NOW(),revoked_at=CASE WHEN $4=\'REVOKED\' THEN NOW() ELSE NULL END WHERE tenant_id=$1 AND factory_id=$2 AND id=$3 RETURNING id::text AS id,package_id,package_version,target_kind,target_key,status,reason,created_at::text AS created_at,updated_at::text AS updated_at,revoked_at::text AS revoked_at',
          [tenantId, factoryId, old.id, nextStatus, reason, actorUserId],
        );
        control = updated.rows[0];
        if (!control) throw new Error('EDGE_PACKAGE_CONTROL_UPDATE_FAILED');
        await this.event(client, tenantId, factoryId, control.id, input.action, old.status, nextStatus, actorUserId, reason);
      }
      return { idempotent: false as const, control, previousStatus: old?.status ?? null };
    }, { tenantId, userId: actorUserId });

    if (!result.idempotent) await this.auditSafely({
      tenantId, factoryId, actorUserId, ...auditContext, eventType: 'EDGE_PACKAGE_CONTROL',
      action: input.action, resourceType: 'EDGE_PACKAGE_CONTROL', resourceId: result.control.id,
      payload: {
        packageId, packageVersion, targetKind: target.kind, targetKey: target.key,
        previousStatus: result.previousStatus, status: result.control.status, reason,
      },
    });
    return { idempotent: result.idempotent, control: this.mapControl(result.control) };
  }

  async listPackageControls(tenantId: string, factoryId: string, actorUserId: string, limit = 50, offset = 0, packageIdInput?: string) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.pagination(limit, offset);
    const packageId = packageIdInput === undefined ? null : this.packageId(packageIdInput);
    await this.iamService.authorize(actorUserId, tenantId, 'edge.packages.controls.read', factoryId);
    const result = await this.database.query<ControlRow>(
      'SELECT id::text AS id,package_id,package_version,target_kind,target_key,status,reason,created_at::text AS created_at,updated_at::text AS updated_at,revoked_at::text AS revoked_at FROM edge_package_controls WHERE tenant_id=$1 AND factory_id=$2 AND ($3::text IS NULL OR package_id=$3) ORDER BY updated_at DESC,id DESC LIMIT $4 OFFSET $5',
      [tenantId, factoryId, packageId, limit + 1, offset], { tenantId, userId: actorUserId },
    );
    const hasMore = result.rows.length > limit;
    return { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null, controls: result.rows.slice(0, limit).map(row => this.mapControl(row)) };
  }

  async getEffectivePackageControl(
    tenantId: string, factoryId: string, deviceId: string,
    packageIdInput: string, packageVersionInput: string, useCaseIdInput?: string,
  ) {
    this.validateScope(tenantId, factoryId);
    this.uuid(deviceId, 'deviceId');
    const packageId = this.packageId(packageIdInput);
    const packageVersion = this.packageVersion(packageVersionInput);
    const useCaseId = useCaseIdInput === undefined ? null : this.targetId(useCaseIdInput, 'useCaseId');
    const deviceResult = await this.database.query<DeviceRow>(
      'SELECT id::text AS id,device_group,status FROM edge_devices WHERE tenant_id=$1 AND factory_id=$2 AND id=$3 LIMIT 1',
      [tenantId, factoryId, deviceId], { tenantId },
    );
    const device = deviceResult.rows[0];
    if (!device) throw new NotFoundException('Edge device not found');
    if (device.status !== 'ACTIVE') throw new ForbiddenException('Inactive edge devices cannot read package controls');
    const result = await this.database.query<ControlRow>(
      'SELECT id::text AS id,package_id,package_version,target_kind,target_key,status,reason,created_at::text AS created_at,updated_at::text AS updated_at,revoked_at::text AS revoked_at FROM edge_package_controls WHERE tenant_id=$1 AND factory_id=$2 AND package_id=$5 AND package_version IN (\'*\',$6) AND ((target_kind=\'FACTORY\' AND target_key=\'*\') OR (target_kind=\'DEVICE\' AND target_key=$3) OR (target_kind=\'DEVICE_GROUP\' AND $4::text IS NOT NULL AND target_key=$4) OR (target_kind=\'USE_CASE\' AND $7::text IS NOT NULL AND target_key=$7)) ORDER BY CASE target_kind WHEN \'FACTORY\' THEN 1 WHEN \'DEVICE_GROUP\' THEN 2 WHEN \'USE_CASE\' THEN 3 WHEN \'DEVICE\' THEN 4 ELSE 5 END,updated_at DESC,id DESC',
      [tenantId, factoryId, deviceId, device.device_group, packageId, packageVersion, useCaseId], { tenantId },
    );
    const controls = result.rows;
    const revoked = controls.filter(row => row.status === 'REVOKED');
    const paused = controls.filter(row => row.status === 'PAUSED');
    const status = revoked.length ? 'REVOKED' : paused.length ? 'PAUSED' : 'ACTIVE';
    const blockers = revoked.length ? revoked : paused;
    return {
      packageId, packageVersion, status, checkedAt: new Date().toISOString(),
      reason: blockers[0]?.reason ?? null,
      matchedControls: controls.map(row => ({
        id: row.id, packageVersion: row.package_version, targetKind: row.target_kind,
        targetKey: row.target_key, status: row.status, reason: row.reason, updatedAt: row.updated_at,
      })),
    };
  }

  private async assertTargetExists(client: PoolClient, tenantId: string, factoryId: string, target: {kind: EdgePackageControlTargetKind; key: string}) {
    if (target.kind === EdgePackageControlTargetKind.DEVICE) {
      const r = await client.query('SELECT id FROM edge_devices WHERE tenant_id=$1 AND factory_id=$2 AND id=$3 FOR SHARE', [tenantId, factoryId, target.key]);
      if (!r.rows[0]) throw new NotFoundException('Edge device not found in this factory');
    } else if (target.kind === EdgePackageControlTargetKind.DEVICE_GROUP) {
      const r = await client.query('SELECT device_group FROM edge_devices WHERE tenant_id=$1 AND factory_id=$2 AND device_group=$3 LIMIT 1 FOR SHARE', [tenantId, factoryId, target.key]);
      if (!r.rows[0]) throw new NotFoundException('Edge device group not found in this factory');
    }
  }

  private async event(client: PoolClient, tenantId: string, factoryId: string, controlId: string, action: EdgePackageControlAction, previous: string | null, next: string, actor: string, reason: string) {
    const type = action === EdgePackageControlAction.PAUSE ? 'PAUSED' : action === EdgePackageControlAction.RESUME ? 'RESUMED' : 'REVOKED';
    await client.query(
      'INSERT INTO edge_package_control_events (tenant_id,factory_id,control_id,event_type,previous_status,next_status,actor_user_id,reason,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'{}\'::jsonb)',
      [tenantId, factoryId, controlId, type, previous, next, actor, reason],
    );
  }

  private target(kind: EdgePackageControlTargetKind, keyInput?: string) {
    if (!Object.values(EdgePackageControlTargetKind).includes(kind)) throw new BadRequestException('target_kind is invalid');
    if (kind === EdgePackageControlTargetKind.FACTORY) {
      if (keyInput !== undefined && (typeof keyInput !== 'string' || keyInput.trim() !== '*')) throw new BadRequestException('Factory target_key must be "*"');
      return { kind, key: '*' };
    }
    if (kind === EdgePackageControlTargetKind.DEVICE) return { kind, key: this.uuid(keyInput ?? '', 'target_key') };
    return { kind, key: this.targetId(keyInput ?? '', 'target_key') };
  }

  private publicEd25519Key(value: string): string {
    if (typeof value !== 'string' || value.length > 4096 || !value.trim().startsWith('-----BEGIN PUBLIC KEY-----') || value.includes('PRIVATE KEY-----')) {
      throw new BadRequestException('public_key_pem must contain public-key PEM only');
    }
    const pem = value.trim();
    let key: KeyObject;
    try { key = createPublicKey(pem); } catch { throw new BadRequestException('public_key_pem is not a valid public key'); }
    if (key.asymmetricKeyType !== 'ed25519') throw new BadRequestException('Only Ed25519 public signing keys are supported');
    return pem;
  }

  private keyId(value: string) { if (typeof value !== 'string' || !KEY_ID.test(value)) throw new BadRequestException('key ID is invalid'); return value; }
  private packageId(value: string) { if (typeof value !== 'string' || !PACKAGE_ID.test(value)) throw new BadRequestException('package_id is invalid'); return value; }
  private packageVersion(value: string) { if (value !== '*' && !SEMVER.test(value)) throw new BadRequestException('package_version must be "*" or a semantic version'); return value; }
  private targetId(value: string, field: string) { if (typeof value !== 'string' || !TARGET_ID.test(value)) throw new BadRequestException(field + ' is invalid'); return value; }
  private reason(value: string) { if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 300) throw new BadRequestException('reason must contain between 8 and 300 characters'); return value.trim(); }
  private uuid(value: string, field: string) { if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID'); return value.toLowerCase(); }
  private validateScope(tenant: string, factory: string, actor?: string) { this.uuid(tenant, 'tenantId'); this.uuid(factory, 'factoryId'); if (actor !== undefined) this.uuid(actor, 'actorUserId'); }
  private pagination(limit: number, offset: number) { if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequestException('limit must be an integer between 1 and 200'); if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new BadRequestException('offset must be an integer between 0 and 1000000'); }
  private statusFor(action: EdgePackageControlAction): 'ACTIVE' | 'PAUSED' | 'REVOKED' { return action === EdgePackageControlAction.PAUSE ? 'PAUSED' : action === EdgePackageControlAction.REVOKE ? 'REVOKED' : 'ACTIVE'; }
  private mapKey(row: KeyRow) { return { id: row.id, keyId: row.key_id, fingerprintSha256: row.fingerprint_sha256, status: row.status, replacesKeyId: row.replaces_key_name ?? row.replaces_key_id ?? null, createdAt: row.created_at, revokedAt: row.revoked_at ?? null, revokeReason: row.revoke_reason ?? null }; }
  private mapControl(row: ControlRow) { return { id: row.id, packageId: row.package_id, packageVersion: row.package_version, targetKind: row.target_kind, targetKey: row.target_key, status: row.status, reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at ?? null }; }

  private async auditSafely(input: AuditEventInput) {
    try { await this.auditService.record(input); } catch { /* Immutable domain event records remain the package governance audit source. */ }
  }
}
