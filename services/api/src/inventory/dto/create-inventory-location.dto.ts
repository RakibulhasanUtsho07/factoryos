import {
  IsBoolean,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateInventoryLocationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  location_code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsIn(['WAREHOUSE', 'BIN', 'STAGING'])
  location_type!: 'WAREHOUSE' | 'BIN' | 'STAGING';

  @IsOptional()
  @IsUUID()
  parent_location_id?: string;

  @IsOptional()
  @IsBoolean()
  putaway_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  picking_enabled?: boolean;

  /** Smaller numbers are preferred first by directed put-away. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  putaway_priority?: number;

  /** Smaller numbers are preferred first by directed picking. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  picking_priority?: number;
}
