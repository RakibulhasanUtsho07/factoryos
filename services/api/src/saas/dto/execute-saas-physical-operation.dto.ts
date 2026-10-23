import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum SaasPhysicalFailurePolicy {
  HALT = 'HALT',
  ROLLBACK = 'ROLLBACK',
}

export class ExecuteSaasPhysicalOperationDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expected_version!: number;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;

  @IsOptional()
  @IsEnum(SaasPhysicalFailurePolicy)
  failure_policy?: SaasPhysicalFailurePolicy;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  health_timeout_seconds?: number;
}
