import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { GrowthExperimentKpiDto } from './growth-kpi-measurement.dto';

export class RecordGrowthExperimentResultDto {
  @IsObject()
  pre_measurements!: Record<string, unknown>;

  @IsObject()
  post_measurements!: Record<string, unknown>;

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
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  evidence_refs!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GrowthExperimentKpiDto)
  kpi_measurements!: GrowthExperimentKpiDto[];

  @IsDateString()
  observed_at!: string;
}
