import { IsEnum, IsInt, IsString, Length, Matches, Min } from 'class-validator';

export enum SaasRetentionRunMode {
  DRY_RUN = 'DRY_RUN',
  EXECUTE = 'EXECUTE',
}

export class RunSaasRetentionPolicyDto {
  @IsEnum(SaasRetentionRunMode)
  mode!: SaasRetentionRunMode;

  @IsInt()
  @Min(1)
  expected_policy_version!: number;

  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
