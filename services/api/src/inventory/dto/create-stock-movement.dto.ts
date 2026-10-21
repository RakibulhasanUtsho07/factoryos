import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateStockMovementDto {
  @IsIn(['RECEIPT', 'ISSUE'])
  movement_type!: 'RECEIPT' | 'ISSUE';

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0.00000001)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  input_unit_code?: string;

  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsUUID()
  traceability_unit_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference_type?: string;

  @IsOptional()
  @IsUUID()
  reference_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
