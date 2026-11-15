import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

export const FACTORY_ONBOARDING_STEPS = [
  'factory_profile',
  'sites',
  'lines',
  'shifts',
  'holiday_calendar',
  'energy_sources',
  'role_set',
] as const;


export type FactoryOnboardingStep = typeof FACTORY_ONBOARDING_STEPS[number];

const STEP_FIELD_LIMITS: Record<FactoryOnboardingStep, Record<string, number>> = {
  factory_profile: { name: 200, code: 100, timezone: 80, defaultLocale: 20 },
  sites: { items: 30000 },
  lines: { items: 30000 },
  shifts: { items: 30000 },
  holiday_calendar: { dates: 30000, notes: 4000 },
  energy_sources: { items: 30000 },
  role_set: { roles: 30000 },
};

function validateStepPayload(stepKey: FactoryOnboardingStep, payload: Record<string, unknown>) {
  const allowedFields = STEP_FIELD_LIMITS[stepKey];
  for (const [field, value] of Object.entries(payload)) {
    const maxLength = allowedFields[field];
    if (maxLength === undefined) {
      throw new BadRequestException(`Unsupported field for onboarding step: ${field}`);
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`Onboarding field ${field} must be text`);
    }
    if (value.length > maxLength) {
      throw new BadRequestException(`Onboarding field ${field} exceeds ${maxLength} characters`);
    }
  }
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async listSteps(userId: string, tenantId: string, factoryId: string) {
    const result = await this.database.query<{
      step_key: FactoryOnboardingStep;
      payload: Record<string, unknown>;
      version: string;
      updated_at: string;
    }>(
      `
      SELECT step_key, payload, version::text, updated_at::text
        FROM factory_onboarding_step_drafts
       WHERE tenant_id = $1
         AND factory_id = $2
       ORDER BY updated_at ASC, step_key ASC
      `,
      [tenantId, factoryId],
      { tenantId, userId },
    );

    return {
      factory_id: factoryId,
      items: result.rows,
      saved_steps: result.rows.length,
      total_steps: FACTORY_ONBOARDING_STEPS.length,
    };
  }

  async saveStep(
    userId: string,
    tenantId: string,
    factoryId: string,
    stepKey: string,
    payload: Record<string, unknown>,
    requestId: string,
    traceId: string,
  ) {
    if (!FACTORY_ONBOARDING_STEPS.includes(stepKey as FactoryOnboardingStep)) {
      throw new BadRequestException('Unsupported factory onboarding step');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Onboarding payload must be a JSON object');
    }

    validateStepPayload(stepKey as FactoryOnboardingStep, payload);

    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > 65536) {
      throw new BadRequestException('Onboarding step payload must not exceed 64 KiB');
    }

    const result = await this.database.query<{
      id: string;
      step_key: FactoryOnboardingStep;
      payload: Record<string, unknown>;
      version: string;
      updated_at: string;
    }>(
      `
      INSERT INTO factory_onboarding_step_drafts (
        tenant_id, factory_id, step_key, payload, saved_by_user_id
      )
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (tenant_id, factory_id, step_key)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        saved_by_user_id = EXCLUDED.saved_by_user_id,
        version = factory_onboarding_step_drafts.version + 1
      RETURNING id::text, step_key, payload, version::text, updated_at::text
      `,
      [tenantId, factoryId, stepKey, serialized, userId],
      { tenantId, userId },
    );

    const saved = result.rows[0];
    if (!saved) {
      throw new NotFoundException('Factory onboarding draft could not be saved');
    }

    try {
      await this.auditService.record({
        tenantId,
        factoryId,
        actorUserId: userId,
        eventType: 'FACTORY_ONBOARDING',
        action: 'SAVE_STEP',
        resourceType: 'FACTORY_ONBOARDING_STEP_DRAFT',
        resourceId: saved.id,
        correlationId: traceId || null,
        requestId: requestId || null,
        dataClass: 'INTERNAL',
        payload: {
          stepKey: saved.step_key,
          version: saved.version,
          payloadBytes: Buffer.byteLength(serialized, 'utf8'),
        },
      });
    } catch {
      // Draft persistence must not be rolled back by a secondary audit outage.
    }

    return saved;
  }
}
