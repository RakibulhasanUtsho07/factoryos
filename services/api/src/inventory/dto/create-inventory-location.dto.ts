import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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
}
