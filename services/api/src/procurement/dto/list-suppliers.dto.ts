import {
  IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListSuppliersDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 20;

  @IsOptional() @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @IsOptional() @IsString() @MaxLength(100)
  search?: string;
}
