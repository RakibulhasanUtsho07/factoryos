import { IsEnum, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export enum SaasEntitlementEnforcementMode {
  LEGACY_COMPATIBLE = 'LEGACY_COMPATIBLE',
  SUBSCRIPTION_REQUIRED = 'SUBSCRIPTION_REQUIRED',
}

/**
 * Compare-and-swap transition for tenant subscription enforcement.
 * expected_version is 0 when the tenant has no explicit mode record yet.
 */
export class SetSaasEntitlementEnforcementModeDto {
  @IsEnum(SaasEntitlementEnforcementMode)
  mode!: SaasEntitlementEnforcementMode;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  expected_version!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
