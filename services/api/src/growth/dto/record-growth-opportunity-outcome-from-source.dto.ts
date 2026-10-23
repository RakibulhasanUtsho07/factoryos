import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { GrowthKpiDirection } from './growth-kpi-measurement.dto';

export class GrowthSourceOutcomeKpiPairDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{0,99}$/)
  metric_key!: string;

  @IsUUID()
  baseline_observation_id!: string;

  @IsUUID()
  actual_observation_id!: string;

  @IsIn(['INCREASE', 'DECREASE', 'TARGET'])
  direction!: GrowthKpiDirection;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  target_value?: number;
}

export class RecordGrowthOpportunityOutcomeFromSourceDto {
  @IsOptional()
  @IsUUID()
  experiment_result_id?: string;

  @IsIn(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'INCONCLUSIVE'])
  assessment!: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'INCONCLUSIVE';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GrowthSourceOutcomeKpiPairDto)
  kpi_measurements!: GrowthSourceOutcomeKpiPairDto[];
}
