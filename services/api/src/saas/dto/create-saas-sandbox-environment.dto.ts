import { IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum SaasSandboxPurpose {
  DEMO = 'DEMO',
  TEST = 'TEST',
  EVALUATION = 'EVALUATION',
  TRAINING = 'TRAINING',
}

export enum SaasSandboxDataMode {
  SYNTHETIC = 'SYNTHETIC',
  MASKED = 'MASKED',
}

export class CreateSaasSandboxEnvironmentDto {
  @IsString()
  @MaxLength(48)
  @Matches(/^[A-Z][A-Z0-9_-]{0,47}$/)
  environment_code!: string;

  @IsString()
  @MaxLength(160)
  display_name!: string;

  @IsEnum(SaasSandboxPurpose)
  purpose!: SaasSandboxPurpose;

  @IsEnum(SaasSandboxDataMode)
  data_mode!: SaasSandboxDataMode;

  /**
   * Provenance/reference metadata only. Raw rows, document contents and
   * customer payloads are deliberately not part of this API contract.
   */
  @IsObject()
  dataset_manifest!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  privacy_assessment?: Record<string, unknown>;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
