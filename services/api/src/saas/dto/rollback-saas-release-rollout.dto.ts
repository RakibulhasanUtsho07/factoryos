import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class RollbackSaasReleaseRolloutDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expected_version!: number;

  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Z][A-Z0-9:_-]{0,79}$/)
  target_rollout_key!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  target_version!: number;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
