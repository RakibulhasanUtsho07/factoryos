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

import {
  ORDER_STATUSES,
  type OrderStatus,
} from './transition-order.dto';

export class ListOrdersDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}