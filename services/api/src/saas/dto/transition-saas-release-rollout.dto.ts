import { IsEnum, IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum SaasReleaseTransitionAction {
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  RETIRE = 'RETIRE',
}

export class TransitionSaasReleaseRolloutDto {
  @IsEnum(SaasReleaseTransitionAction)
  action!: SaasReleaseTransitionAction;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expected_version!: number;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
