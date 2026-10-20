import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  IsUUID,
} from 'class-validator';

export class RecordGrowthForecastEvaluationDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  model_version!: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{0,99}$/)
  metric_key!: string;

  @IsString()
  @MaxLength(40)
  @Matches(/\S/)
  unit!: string;

  @IsDateString()
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/i)
  forecast_origin_at!: string;

  @IsString()
  @MaxLength(2000)
  @Matches(/\S/)
  forecast_source_ref!: string;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  forecast_value!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  lower_bound?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  upper_bound?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99.99)
  nominal_coverage_pct?: number;

  @IsUUID()
  outcome_id!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  idempotency_key!: string;
}
