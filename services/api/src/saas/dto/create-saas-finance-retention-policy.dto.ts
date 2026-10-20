import { IsInt, IsString, Length, Matches, Min, Max } from 'class-validator';

export class CreateSaasFinanceRetentionPolicyDto {
  @IsInt()
  @Min(1)
  @Max(36500)
  retention_days!: number;

  @IsString()
  @Length(3, 200)
  legal_basis!: string;

  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
  finance_adapter_key!: string;

  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
