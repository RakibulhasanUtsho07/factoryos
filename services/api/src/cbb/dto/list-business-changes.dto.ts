import {
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import {
  Type,
} from 'class-transformer';

import {
  BUSINESS_CHANGE_TARGET_TYPES,
} from './create-business-change.dto';

import type {
  BusinessChangeTargetType,
} from './create-business-change.dto';

export const BUSINESS_CHANGE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

export type BusinessChangeStatus =
  (typeof BUSINESS_CHANGE_STATUSES)[number];

export class ListBusinessChangesDto {
  @IsOptional()
  @IsIn(
    BUSINESS_CHANGE_STATUSES,
  )
  status?:
    BusinessChangeStatus;

  @IsOptional()
  @IsIn(
    BUSINESS_CHANGE_TARGET_TYPES,
  )
  target_type?:
    BusinessChangeTargetType;

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