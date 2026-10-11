import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

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

  @IsDateString()
  observed_at!: string;
}
