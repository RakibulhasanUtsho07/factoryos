import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateAiOutcomeDto {
  @IsUUID()
  decision_id!: string;

  @IsOptional()
  @IsUUID()
  action_intent_id?: string | null;

  @IsOptional()
  @IsUUID()
  execution_record_id?: string | null;

  @IsObject()
  expected_metric!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  actual_metric?: Record<string, unknown> | null;

  @IsObject()
  outcome_window!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  causal_notes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;
}
