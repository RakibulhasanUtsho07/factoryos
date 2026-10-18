import { IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum SaasDeploymentProfile {
  SHARED_SAAS = 'SHARED_SAAS',
  SINGLE_TENANT = 'SINGLE_TENANT',
  DEDICATED_VPC = 'DEDICATED_VPC',
  HYBRID_EDGE_CLOUD = 'HYBRID_EDGE_CLOUD',
}

export enum SaasSubscriptionPlanStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

export class CreateSaasSubscriptionPlanDto {
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Z][A-Z0-9_:-]{0,79}$/)
  plan_code!: string;

  @IsString()
  @MaxLength(160)
  display_name!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  tier_rank!: number;

  @IsOptional()
  @IsEnum(SaasDeploymentProfile)
  deployment_profile?: SaasDeploymentProfile;

  @IsOptional()
  @IsEnum(SaasSubscriptionPlanStatus)
  status?: SaasSubscriptionPlanStatus;

  @IsOptional()
  @IsObject()
  capabilities?: Record<string, unknown>;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
