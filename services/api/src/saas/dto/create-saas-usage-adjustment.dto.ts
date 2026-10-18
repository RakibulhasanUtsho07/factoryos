import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { SaasMeterMetric } from './create-saas-meter-rate.dto';

export enum SaasAdjustmentReasonCode {
  METER_CORRECTION='METER_CORRECTION',
  PRICING_CORRECTION='PRICING_CORRECTION',
  CUSTOMER_CREDIT='CUSTOMER_CREDIT',
  CUSTOMER_DEBIT='CUSTOMER_DEBIT',
  TAX_CORRECTION='TAX_CORRECTION',
  OTHER='OTHER',
}
export class CreateSaasUsageAdjustmentDto {
  @IsDateString()
  period_start!: string;

  @IsDateString()
  period_end!: string;

  @IsOptional()
  @IsEnum(SaasMeterMetric)
  metric_code?: SaasMeterMetric;

  @IsNumber({allowNaN:false,allowInfinity:false})
  @Min(-1000000000000)
  @Max(1000000000000)
  quantity_delta!: number;

  @IsNumber({allowNaN:false,allowInfinity:false})
  @Min(-9000000000000000)
  @Max(9000000000000000)
  cost_delta_minor!: number;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsEnum(SaasAdjustmentReasonCode)
  reason_code!: SaasAdjustmentReasonCode;

  @IsString()
  @MaxLength(2000)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference_ref?: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
