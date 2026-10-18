import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export enum SaasReleaseScopeType {
  ORGANIZATION = 'ORGANIZATION',
  FACTORY = 'FACTORY',
  MODULE = 'MODULE',
  AGENT = 'AGENT',
}

export enum SaasReleaseChannel {
  STABLE = 'STABLE',
  PREVIEW = 'PREVIEW',
  EXPERIMENTAL = 'EXPERIMENTAL',
}

export class CreateSaasReleaseRolloutDto {
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Z][A-Z0-9:_-]{0,79}$/)
  rollout_key!: string;

  @IsEnum(SaasReleaseScopeType)
  scope_type!: SaasReleaseScopeType;

  @IsOptional()
  @IsUUID()
  factory_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
  module_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  agent_key?: string;

  @IsEnum(SaasReleaseChannel)
  release_channel!: SaasReleaseChannel;

  @IsString()
  @MaxLength(120)
  artifact_version!: string;

  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  artifact_digest!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
  evaluation_reference?: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
