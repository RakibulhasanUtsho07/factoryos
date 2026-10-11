import { IsDateString, IsString, Matches, MaxLength } from 'class-validator';

export class StartSaasTrialDto {
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Z][A-Z0-9_:-]{0,79}$/)
  plan_code!: string;

  @IsDateString()
  trial_ends_at!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
