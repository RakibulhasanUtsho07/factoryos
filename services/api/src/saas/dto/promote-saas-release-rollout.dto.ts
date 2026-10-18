import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class PromoteSaasReleaseRolloutDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expected_version!: number;

  @IsIn(['CANARY', 'PRODUCTION'])
  stage!: 'CANARY' | 'PRODUCTION';

  @IsInt()
  @Min(1)
  @Max(100)
  rollout_percentage!: number;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
