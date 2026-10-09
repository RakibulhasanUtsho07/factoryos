import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { Type } from 'class-transformer';

export class ListEntitlementsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  package?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  feature_key?: string;

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