import {
  IsEnum,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { AiOperationalDomain } from './create-ai-operational-evaluation.dto';

/**
 * Scores a numeric forecast against an observed metric from an existing AI
 * outcome. Prediction and actual values are read from the outcome record;
 * they are never accepted from the caller.
 */
export class ReconcileAiOperationalForecastDto {
  @IsUUID()
  source_outcome_id!: string;

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

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  confidence!: number;

  /**
   * Absolute error tolerated for this metric, in the metric's own unit.
   */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1000000000000000)
  tolerance!: number;
}
