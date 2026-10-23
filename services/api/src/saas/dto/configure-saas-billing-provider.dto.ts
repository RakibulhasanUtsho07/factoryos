import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class ConfigureSaasBillingProviderDto {
  @IsString()
  @IsIn(['stripe'])
  provider_code!: 'stripe';

  @IsString()
  @MaxLength(120)
  @Matches(/^cus_[A-Za-z0-9]+$/)
  provider_customer_id!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @IsIn(['charge_automatically', 'send_invoice'])
  collection_method!: 'charge_automatically' | 'send_invoice';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  days_until_due?: number | null;

  @IsBoolean()
  automatic_tax_enabled!: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['exclusive', 'inclusive'])
  tax_behavior?: 'exclusive' | 'inclusive' | null;

  @IsInt()
  @Min(0)
  @Max(1000000)
  expected_version!: number;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
