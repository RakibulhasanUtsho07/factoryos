import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum AiOperationalDomain {
  PLANNING = 'PLANNING',
  QUALITY = 'QUALITY',
  MAINTENANCE = 'MAINTENANCE',
  FINANCE = 'FINANCE',
  ENERGY = 'ENERGY',
}

/**
 * Records an observed evaluation label for a single operational AI decision.
 * confidence is the predicted probability (0..1) that the prediction is correct.
 */
export class CreateAiOperationalEvaluationDto {
  @IsUUID()
  decision_id!: string;

  /**
   * Caller-supplied stable key; retries must keep the same request payload.
   */
  @IsString()
  @MaxLength(255)
  evaluation_key!: string;

  @IsEnum(AiOperationalDomain)
  domain!: AiOperationalDomain;

  @IsString()
  @MaxLength(100)
  metric_key!: string;

  @IsString()
  @MaxLength(100)
  model_version!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;

  @IsBoolean()
  prediction_correct!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  observed_at?: string | null;
}
