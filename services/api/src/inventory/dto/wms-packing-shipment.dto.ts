import { Type } from 'class-transformer';
import {
  IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, Matches,
} from 'class-validator';

export class CreateWmsPackingContainerDto {
  @IsIn(['CARTON', 'PALLET'])
  container_type!: 'CARTON' | 'PALLET';

  @IsString()
  @MaxLength(160)
  @Matches(/^[A-Z0-9._:-]+$/i)
  container_code!: string;

  @IsUUID()
  item_id!: string;

  @IsUUID()
  location_id!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(99999999999999)
  capacity_quantity!: number;
}

export class AddWmsPackingContentDto {
  @IsUUID()
  source_unit_id!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(99999999999999)
  quantity!: number;
}

export class DispatchWmsShipmentDto {
  @IsString()
  @MaxLength(160)
  @Matches(/^[A-Z0-9._:-]+$/i)
  shipment_code!: string;

  @IsString()
  @MaxLength(255)
  customer_name!: string;

  @IsString()
  @MaxLength(160)
  customer_order_reference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  carrier_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  tracking_reference?: string;
}
