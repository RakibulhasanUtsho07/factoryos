import {
  IsDateString,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { Type } from 'class-transformer';

export class CreateEntitlementDto {
  @IsString()
  @MaxLength(100)
  package!: string;

  @IsString()
  @MaxLength(150)
  feature_key!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  limit_value?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  period?: string | null;

  @IsOptional()
  @IsIn([
    'ACTIVE',
    'DISABLED',
    'EXPIRED',
  ])
  status?:
    | 'ACTIVE'
    | 'DISABLED'
    | 'EXPIRED';

  @IsOptional()
  @IsDateString()
  effective_from?: string;

  @IsOptional()
  @IsDateString()
  effective_to?: string | null;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}