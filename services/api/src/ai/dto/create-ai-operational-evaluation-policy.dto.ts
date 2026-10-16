import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
} from 'class-validator';

import { AiOperationalDomain } from './create-ai-operational-evaluation.dto';

/**
 * Appends a new immutable version of a tenant/factory operational evaluation
 * policy. Percent errors are ratios (for example, 0.15 means 15%).
 */
export class CreateAiOperationalEvaluationPolicyDto {
  @IsString()
  @MaxLength(150)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  policy_key!: string;

  @IsString()
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/)
  policy_version!: string;

  @IsEnum(AiOperationalDomain)
  domain!: AiOperationalDomain;

  @IsString()
  @MaxLength(100)
  metric_key!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  minimum_samples!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1000000000000000)
  max_mean_absolute_error?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1000000000)
  max_mean_absolute_percentage_error?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  min_within_tolerance_rate?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  max_expected_calibration_error?: number | null;
}
