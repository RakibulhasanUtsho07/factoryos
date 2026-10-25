import { Type } from 'class-transformer';
import {
  IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, Matches,
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

  // When supplied, both IDs bind the dispatch to an internal order line.
  // External-only order references remain accepted for backward compatibility.
  @IsOptional()
  @IsUUID()
  order_id?: string;

  @IsOptional()
  @IsUUID()
  order_line_id?: string;
}

export class RecordWmsShipmentDeliveryEventDto {
  @IsIn(['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED'])
  event_type!: 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERY_FAILED' | 'DELIVERED' | 'RETURNED';

  @IsOptional()
  @IsDateString()
  event_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  recipient_name?: string;

  @IsOptional()
  @IsIn(['SIGNATURE', 'PHOTO', 'DOCUMENT', 'OTP', 'CUSTOMER_ACKNOWLEDGEMENT'])
  proof_type?: 'SIGNATURE' | 'PHOTO' | 'DOCUMENT' | 'OTP' | 'CUSTOMER_ACKNOWLEDGEMENT';

  // Opaque object-storage key only; this API never fetches caller-supplied URLs.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/)
  proof_reference?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  proof_sha256?: string;

  @IsOptional()
  @IsDateString()
  signed_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
