import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SaasDeploymentProfile } from './create-saas-subscription-plan.dto';

export enum SaasDeploymentProfileTransitionAction {
  START_PROVISIONING = 'START_PROVISIONING',
  ACTIVATE = 'ACTIVATE',
  START_MIGRATION = 'START_MIGRATION',
  COMPLETE_MIGRATION = 'COMPLETE_MIGRATION',
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  FAIL = 'FAIL',
  RETIRE = 'RETIRE',
}

const reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const region = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const edgeSite = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export class TransitionSaasDeploymentProfileDto {
  @IsEnum(SaasDeploymentProfileTransitionAction)
  action!: SaasDeploymentProfileTransitionAction;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expected_version!: number;

  @IsOptional()
  @IsEnum(SaasDeploymentProfile)
  target_profile_type?: SaasDeploymentProfile;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(reference)
  target_deployment_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(region)
  target_region_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(region)
  target_residency_domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(edgeSite)
  target_edge_site_code?: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
