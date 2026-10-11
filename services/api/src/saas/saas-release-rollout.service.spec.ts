import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { SaasReleaseChannel, SaasReleaseScopeType } from './dto/create-saas-release-rollout.dto';
import { SaasReleaseRolloutService } from './saas-release-rollout.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

function bucket(key: string, subject: string) {
  return Number.parseInt(createHash('sha256').update(`${key}:${subject}`).digest('hex').slice(0, 8), 16) % 100;
}

function releaseRow(overrides: Record<string, unknown>) {
  return {
    id: '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
    tenant_id: tenantId,
    rollout_key: 'ORG-BASE',
    version: '3',
    scope_type: 'ORGANIZATION',
    factory_id: null,
    module_key: null,
    agent_key: null,
    release_channel: 'STABLE',
    action: 'PROMOTE',
    stage: 'PRODUCTION',
    last_active_stage: 'PRODUCTION',
    artifact_version: '1.0.0',
    artifact_digest: 'a'.repeat(64),
    rollout_percentage: 100,
    previous_version: '2',
    rollback_target_key: null,
    rollback_target_version: null,
    evaluation_reference: null,
    reason: 'promote after successful evaluation',
    idempotency_key: 'org-prod',
    request_hash: 'b'.repeat(64),
    actor_user_id: actorUserId,
    created_at: '2026-10-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('SaasReleaseRolloutService', () => {
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<string>>() };
  let service: SaasReleaseRolloutService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.record.mockResolvedValue('audit-event-id');
    service = new SaasReleaseRolloutService(database as never, iam as never, audit as never);
  });

  it('rejects invalid scope combinations before opening a database transaction', async () => {
    await expect(service.createRollout(tenantId, actorUserId, {
      rollout_key: 'MODULE-BAD',
      scope_type: SaasReleaseScopeType.MODULE,
      release_channel: SaasReleaseChannel.STABLE,
      artifact_version: '1.0.0',
      artifact_digest: 'a'.repeat(64),
      reason: 'test bad scope',
      idempotency_key: 'invalid-scope',
    } as never)).rejects.toBeInstanceOf(BadRequestException);

    expect(iam.authorize).toHaveBeenCalledWith(actorUserId, tenantId, 'saas.releases.write');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects artifact digests that are not SHA-256 before storage access', async () => {
    await expect(service.createRollout(tenantId, actorUserId, {
      rollout_key: 'ORG-BAD-DIGEST',
      scope_type: SaasReleaseScopeType.ORGANIZATION,
      release_channel: SaasReleaseChannel.STABLE,
      artifact_version: '1.0.0',
      artifact_digest: 'not-a-digest',
      reason: 'test digest validation',
      idempotency_key: 'invalid-digest',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires exact rollout percentages for canary and production', async () => {
    await expect(service.promoteRollout(tenantId, actorUserId, 'ORG-BASE', {
      expected_version: 1,
      stage: 'PRODUCTION',
      rollout_percentage: 40,
      reason: 'invalid direct production weight',
      idempotency_key: 'bad-prod-weight',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('routes eligible subjects to the most specific canary release', async () => {
    let subjectKey = 'cohort-0';
    while (bucket('MODULE-CANARY', subjectKey) >= 25) subjectKey += '-next';
    database.query.mockResolvedValueOnce({ rows: [
      releaseRow({
        rollout_key: 'MODULE-CANARY', version: '2', scope_type: 'MODULE',
        module_key: 'maintenance', stage: 'CANARY', last_active_stage: 'CANARY',
        artifact_version: '2.0.0', artifact_digest: 'c'.repeat(64), rollout_percentage: 25,
        previous_version: '1', created_at: '2026-10-11T12:01:00.000Z',
      }),
      releaseRow({ created_at: '2026-10-11T12:00:00.000Z' }),
    ] });
    const resolved = await service.resolveEffectiveRelease(tenantId, actorUserId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey,
    });
    expect(resolved.release?.rolloutKey).toBe('MODULE-CANARY');
    expect(resolved.release?.stage).toBe('CANARY');
    expect(resolved.rolloutBucket).toBeLessThan(25);
    expect(resolved.matchedScope).toBe('MODULE');
  });

  it('falls back to same-scope production when a subject misses the canary cohort', async () => {
    let subjectKey = 'outside-0';
    while (bucket('MODULE-CANARY', subjectKey) < 25) subjectKey += '-next';
    database.query.mockResolvedValueOnce({ rows: [
      releaseRow({
        rollout_key: 'MODULE-CANARY', version: '2', scope_type: 'MODULE',
        module_key: 'maintenance', stage: 'CANARY', last_active_stage: 'CANARY',
        artifact_version: '2.0.0', artifact_digest: 'c'.repeat(64), rollout_percentage: 25,
        previous_version: '1', created_at: '2026-10-11T12:01:00.000Z',
      }),
      releaseRow({
        rollout_key: 'ORG-BASE', created_at: '2026-10-11T12:00:00.000Z',
      }),
    ] });
    const resolved = await service.resolveEffectiveRelease(tenantId, actorUserId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey,
    });
    expect(resolved.release?.rolloutKey).toBe('ORG-BASE');
    expect(resolved.release?.stage).toBe('PRODUCTION');
    expect(resolved.rolloutBucket).toBeNull();
  });

  it('returns a safe empty result when there is no active release for the requested channel', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.resolveEffectiveRelease(tenantId, actorUserId, {
      channel: SaasReleaseChannel.PREVIEW,
      subjectKey: 'job:124',
    })).resolves.toEqual({ release: null, rolloutBucket: null, matchedScope: null });
  });
});
