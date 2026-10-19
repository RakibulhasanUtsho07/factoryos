import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { GrowthOutcomeKpiDto } from './growth-kpi-measurement.dto';

export class RecordGrowthOpportunityOutcomeDto {
  @IsOptional()
  @IsUUID()
  experiment_result_id?: string;

  @IsIn(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'INCONCLUSIVE'])
  assessment!: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'INCONCLUSIVE';

  @IsObject()
  realized_metrics!: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  evidence_refs!: string[];

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
  @Type(() => GrowthOutcomeKpiDto)
  kpi_measurements!: GrowthOutcomeKpiDto[];

  @IsDateString()
  observed_at!: string;
}
