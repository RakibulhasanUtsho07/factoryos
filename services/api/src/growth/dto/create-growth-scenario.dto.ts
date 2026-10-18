import { Type } from 'class-transformer';
import { ProjectedGrowthConstraintMetricsDto } from './projected-growth-constraint-metrics.dto';
import {
  IsDateString, IsIn, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString,
  Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class CreateGrowthScenarioDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  scenario_name!: string;

  @IsIn(['BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS', 'CUSTOM'])
  scenario_type!: 'BASE' | 'UPSIDE' | 'DOWNSIDE' | 'STRESS' | 'CUSTOM';

  @IsDateString()
  data_vintage!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  baseline_source_ref!: string;

  @IsNumber()
  @Min(0.0001)
  @Max(1000000000000)
  baseline_revenue!: number;

  @IsNumber()
  @Min(0)
  @Max(1000000000000)
  baseline_variable_cost!: number;

  @IsNumber()
  @Min(0)
  @Max(1000000000000)
  baseline_fixed_cost!: number;

  @IsNumber()
  @Min(-90)
  @Max(500)
  price_change_pct!: number;

  @IsNumber()
  @Min(-90)
  @Max(500)
  volume_change_pct!: number;

  @IsNumber()
  @Min(-100)
  @Max(500)
  variable_cost_change_pct!: number;

  @IsNumber()
  @Min(-100)
  @Max(500)
  fixed_cost_change_pct!: number;

  @IsNumber()
  @Min(0)
  @Max(1000000000000)
  investment!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  uncertainty_pct!: number;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ProjectedGrowthConstraintMetricsDto)
  projected_constraint_metrics?: ProjectedGrowthConstraintMetricsDto;
}
