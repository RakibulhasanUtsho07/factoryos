import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsString, Length, Matches, ValidateNested,
} from 'class-validator';

export const SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS = [
  'POLICY_DENY_READBACK',
  'COPY_OBJECT_DURING_FENCE',
  'MULTIPART_COMPLETION_DURING_FENCE',
  'REPLICATION_DELETE_MARKER',
  'POLICY_DRIFT_DETECTED',
  'CRASH_RECOVERY_DENY_PRESERVED',
  'DELAYED_WRITER_REJECTED',
  'TOMBSTONE_REPLAY_BEFORE_RELEASE',
  'INDEPENDENT_RESIDUAL_LISTING',
  'RESTORE_AFTER_TOMBSTONE_REPLAY',
] as const;

export class SaasBackupProviderAcceptanceScenarioDto {
  @IsIn(SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS)
  scenario_code!: typeof SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS[number];

  @IsIn(['PASS', 'FAIL', 'NOT_RUN'])
  outcome!: 'PASS' | 'FAIL' | 'NOT_RUN';

  @IsString()
  @Length(1, 200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  evidence_reference!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  evidence_sha256!: string;

  @IsDateString()
  executed_at!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  runner_reference!: string;
}

export class CreateSaasBackupProviderAcceptanceDto {
  @IsIn(['BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS', 'EFFECTIVE_DATED_MASTER_DATA',
    'AI_CONTEXT', 'LEARNING_EVALUATION', 'INTEGRATION_METADATA', 'FILE_REFERENCES', 'IAM_ACCESS'])
  category_code!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  staging_evidence_reference!: string;

  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
  idempotency_key!: string;

  @IsArray()
  @ArrayMinSize(10)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SaasBackupProviderAcceptanceScenarioDto)
  scenarios!: SaasBackupProviderAcceptanceScenarioDto[];
}
