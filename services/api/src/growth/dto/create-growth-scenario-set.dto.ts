import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProjectedGrowthConstraintMetricsDto } from './projected-growth-constraint-metrics.dto';

export class GrowthScenarioSetBaselineDto {
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
}

export class GrowthScenarioSetProfileDto {
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
  @ValidateNested()
  @Type(() => ProjectedGrowthConstraintMetricsDto)
  projected_constraint_metrics?: ProjectedGrowthConstraintMetricsDto;
}

export class GrowthScenarioSetProfilesDto {
  @ValidateNested()
  @Type(() => GrowthScenarioSetProfileDto)
  base!: GrowthScenarioSetProfileDto;

  @ValidateNested()
  @Type(() => GrowthScenarioSetProfileDto)
  upside!: GrowthScenarioSetProfileDto;

  @ValidateNested()
  @Type(() => GrowthScenarioSetProfileDto)
  downside!: GrowthScenarioSetProfileDto;

  @ValidateNested()
  @Type(() => GrowthScenarioSetProfileDto)
  stress!: GrowthScenarioSetProfileDto;
}

export class GrowthScenarioSensitivityAxisDto {
  @IsIn([
    'price_change_pct',
    'volume_change_pct',
    'variable_cost_change_pct',
    'fixed_cost_change_pct',
    'investment',
    'uncertainty_pct',
  ])
  parameter!: 'price_change_pct' | 'volume_change_pct' | 'variable_cost_change_pct'
    | 'fixed_cost_change_pct' | 'investment' | 'uncertainty_pct';

  @IsNumber()
  @Min(-100)
  @Max(1000000000000)
  low_value!: number;

  @IsNumber()
  @Min(-100)
  @Max(1000000000000)
  high_value!: number;

  @IsInt()
  @Min(2)
  @Max(11)
  points!: number;
}

export class CreateGrowthScenarioSetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  set_name!: string;

  @IsDateString()
  data_vintage!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  baseline_source_ref!: string;

  @ValidateNested()
  @Type(() => GrowthScenarioSetBaselineDto)
  baseline!: GrowthScenarioSetBaselineDto;

  @ValidateNested()
  @Type(() => GrowthScenarioSetProfilesDto)
  profiles!: GrowthScenarioSetProfilesDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => GrowthScenarioSensitivityAxisDto)
  sensitivity!: GrowthScenarioSensitivityAxisDto[];
}
