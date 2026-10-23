import { IsDateString, IsString, Matches, MaxLength } from 'class-validator';

export class CreateSaasBillingCloseDto {
  @IsDateString()
  period_start!: string;

  @IsDateString()
  period_end!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
