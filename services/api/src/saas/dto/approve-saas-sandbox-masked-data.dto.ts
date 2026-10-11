import { IsDateString, IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class ApproveSaasSandboxMaskedDataDto {
  @IsInt()
  @Min(1)
  @Max(9223372036854775000)
  expected_version!: number;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsDateString()
  approval_expires_at!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
