import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OfflineStockTransactionDto {
  @IsUUID()
  client_transaction_id!: string;

  @IsIn(['STOCK_MOVEMENT'])
  operation!: 'STOCK_MOVEMENT';

  @IsUUID()
  item_id!: string;

  @IsIn(['RECEIPT', 'ISSUE'])
  movement_type!: 'RECEIPT' | 'ISSUE';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0.00000001)
  quantity!: number;

  @IsString()
  @Matches(/^\\d{1,19}$/)
  @MaxLength(19)
  expected_balance_version!: string;

  @IsOptional()
  @IsUUID()
  location_id?: string;

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

export class SyncOfflineBatchDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  device_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OfflineStockTransactionDto)
  transactions!: OfflineStockTransactionDto[];
}

export class CreateRfidReadBatchDto {
  @IsUUID()
  reader_id!: string;

  @IsUUID()
  session_id!: string;

  @IsUUID()
  item_id!: string;

  @IsUUID()
  location_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9._:-]{1,128}$/, { each: true })
  reads!: string[];
}
