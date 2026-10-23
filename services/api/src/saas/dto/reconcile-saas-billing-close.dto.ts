import { IsString, Matches, MaxLength } from 'class-validator';

export class ReconcileSaasBillingCloseDto {
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
