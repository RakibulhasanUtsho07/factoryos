import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SaasDeploymentProfile } from './create-saas-subscription-plan.dto';

export enum SaasDeploymentProfileScopeType {
  TENANT = 'TENANT',
  FACTORY = 'FACTORY',
}

export class CreateSaasDeploymentProfileDto {
  @IsEnum(SaasDeploymentProfileScopeType)
  scope_type!: SaasDeploymentProfileScopeType;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  @Matches(/^[0-9a-f-]{36}$/i)
  factory_id?: string;

  @IsEnum(SaasDeploymentProfile)
  profile_type!: SaasDeploymentProfile;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
  deployment_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
  region_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
  residency_domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
  edge_site_code?: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
