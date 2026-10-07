import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAiDecisionDto {
  @IsString()
  @MaxLength(500)
  objective!: string;

  @IsString()
  @MaxLength(100)
  reasoning_mode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  context_version?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  risk_class?: string | null;

  @IsString()
  @MaxLength(50)
  output_state!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
