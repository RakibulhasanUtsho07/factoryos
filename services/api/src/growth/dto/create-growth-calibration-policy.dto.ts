import { IsIn, IsNumber, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const GROWTH_CALIBRATION_DOMAINS = ['FINANCE', 'PRODUCTION', 'QUALITY', 'DELIVERY', 'COMMERCIAL', 'OTHER'] as const;
export type GrowthCalibrationDomain = typeof GROWTH_CALIBRATION_DOMAINS[number];

export class CreateGrowthCalibrationPolicyDto {
  @IsIn(GROWTH_CALIBRATION_DOMAINS)
  domain!: GrowthCalibrationDomain;

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

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Max(1000000000000)
  max_mean_absolute_error!: number;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Max(1000000000000)
  max_root_mean_squared_error!: number;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Max(1000000000000)
  max_absolute_mean_error!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(200)
  max_mean_symmetric_percentage_error_pct!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  max_absolute_calibration_gap_pct_points!: number;

  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(10)
  @Max(1000000)
  minimum_sample_count!: number;
}
