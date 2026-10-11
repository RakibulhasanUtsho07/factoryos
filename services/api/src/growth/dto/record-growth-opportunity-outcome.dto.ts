import { ArrayMinSize, IsArray, IsDateString, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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

  @IsDateString()
  observed_at!: string;
}
