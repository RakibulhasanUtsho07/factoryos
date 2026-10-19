import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const GROWTH_KPI_DIRECTIONS = ['INCREASE', 'DECREASE', 'TARGET'] as const;
export type GrowthKpiDirection = typeof GROWTH_KPI_DIRECTIONS[number];

export class GrowthExperimentKpiDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{0,99}$/)
  metric_key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  unit!: string;

  @IsIn(GROWTH_KPI_DIRECTIONS)
  direction!: GrowthKpiDirection;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  target_value?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  evidence_ref!: string;
}

export class GrowthOutcomeKpiDto extends GrowthExperimentKpiDto {
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  baseline_value!: number;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  actual_value!: number;
}
