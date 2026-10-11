import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SaasTransferDatasetDigest } from './attest-saas-tenant-export.dto';

export enum SaasTenantMigrationAction {
  START = 'START',
  COMPLETE = 'COMPLETE',
  FAIL = 'FAIL',
  CANCEL = 'CANCEL',
}

export class TransitionSaasTenantMigrationDto {
  @IsEnum(SaasTenantMigrationAction)
  action!: SaasTenantMigrationAction;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expected_version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
  target_bundle_reference?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  target_bundle_digest?: string;

  @IsOptional()
  @IsObject()
  target_manifest?: Record<string, SaasTransferDatasetDigest>;

  @IsOptional()
  @IsBoolean()
  preservation_verified?: boolean;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
