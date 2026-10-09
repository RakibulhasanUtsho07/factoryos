import {
  Transform,
  Type,
} from 'class-transformer';

import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Convert query-string boolean values into actual booleans.
 *
 * Example:
 *
 *   ?enabled=true
 *
 * becomes:
 *
 *   enabled === true
 *
 * while:
 *
 *   ?enabled=false
 *
 * becomes:
 *
 *   enabled === false
 *
 * Any other value is returned unchanged so the validation pipe
 * can reject it instead of silently accepting invalid input.
 */
function transformOptionalBoolean({
  value,
}: {
  value: unknown;
}): unknown {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return undefined;
  }

  if (
    value === 'true' ||
    value === true
  ) {
    return true;
  }

  if (
    value === 'false' ||
    value === false
  ) {
    return false;
  }

  return value;
}

export class ListFeatureFlagsDto {
  // ==========================================================
  // FEATURE FLAG KEY
  // ==========================================================

  @IsOptional()
  @IsString()
  @MaxLength(200)
  key?: string;

  // ==========================================================
  // ENABLED FILTER
  // ==========================================================

  @IsOptional()
  @Transform(
    transformOptionalBoolean,
  )
  @IsBoolean()
  enabled?: boolean;

  // ==========================================================
  // OWNER FILTER
  // ==========================================================

  @IsOptional()
  @IsString()
  @MaxLength(150)
  owner?: string;

  // ==========================================================
  // SECURITY-CRITICAL FILTER
  // ==========================================================

  @IsOptional()
  @Transform(
    transformOptionalBoolean,
  )
  @IsBoolean()
  security_critical?: boolean;

  // ==========================================================
  // PAGINATION
  // ==========================================================

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}