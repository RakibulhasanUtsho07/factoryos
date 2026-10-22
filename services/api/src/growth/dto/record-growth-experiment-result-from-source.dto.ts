import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { GrowthKpiDirection } from './growth-kpi-measurement.dto';

export class GrowthSourceKpiPairDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{0,99}$/)
  metric_key!: string;

  @IsUUID('4')
  baseline_observation_id!: string;

  @IsUUID('4')
  actual_observation_id!: string;

  @IsIn(['INCREASE', 'DECREASE', 'TARGET'])
  direction!: GrowthKpiDirection;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-1000000000000)
  @Max(1000000000000)
  target_value?: number;
}

export class RecordGrowthExperimentResultFromSourceDto {
  @IsIn(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'INCONCLUSIVE'])
  assessment!: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'INCONCLUSIVE';

  @IsBoolean()
  stop_condition_triggered!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  result_notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GrowthSourceKpiPairDto)
  kpi_measurements!: GrowthSourceKpiPairDto[];
}
