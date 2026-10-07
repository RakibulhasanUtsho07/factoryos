import {
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAiLearningSignalDto {
  @IsUUID()
  source_decision_id!: string;

  @IsOptional()
  @IsUUID()
  source_outcome_id?: string | null;

  @IsOptional()
  @IsUUID()
  source_execution_id?: string | null;

  @IsString()
  @MaxLength(100)
  signal_type!: string;

  @IsString()
  @MaxLength(200)
  label!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  tenant_scope?: string;

  @IsObject()
  payload!: Record<string, unknown>;
}
