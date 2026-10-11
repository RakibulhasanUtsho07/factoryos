import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum SaasSubscriptionTransitionAction {
  ACTIVATE = 'ACTIVATE',
  SUSPEND = 'SUSPEND',
  RESUME = 'RESUME',
  UPGRADE = 'UPGRADE',
  DOWNGRADE = 'DOWNGRADE',
  RENEW = 'RENEW',
  TERMINATE = 'TERMINATE',
  EXPIRE = 'EXPIRE',
}

export class TransitionSaasSubscriptionDto {
  @IsEnum(SaasSubscriptionTransitionAction)
  action!: SaasSubscriptionTransitionAction;

  @IsInt()
  @Min(1)
  @Max(9223372036854775000)
  expected_version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Z][A-Z0-9_:-]{0,79}$/)
  target_plan_code?: string;

  @IsOptional()
  @IsDateString()
  period_start?: string;

  @IsOptional()
  @IsDateString()
  period_end?: string;

  @IsOptional()
  @IsDateString()
  effective_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
