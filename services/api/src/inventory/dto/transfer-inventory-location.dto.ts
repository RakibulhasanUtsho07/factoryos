import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class TransferInventoryLocationDto {
  @IsOptional()
  @IsIn(['TRANSFER', 'PUT_AWAY', 'PICK'])
  movement_purpose?: 'TRANSFER' | 'PUT_AWAY' | 'PICK';
  @IsUUID()
  source_location_id!: string;

  @IsUUID()
  destination_location_id!: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
