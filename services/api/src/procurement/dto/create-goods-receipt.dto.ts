import {
  IsArray, IsDateString, IsNumber, IsOptional, IsString, IsUUID,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GoodsReceiptLineDto {
  @IsUUID()
  purchase_order_line_id!: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001)
  received_quantity!: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0)
  rejected_quantity?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  rejection_reason?: string;
}

export class CreateGoodsReceiptDto {
  @IsOptional() @IsUUID()
  location_id?: string;

  @IsOptional() @IsString() @MaxLength(150)
  supplier_delivery_reference?: string;

  @IsOptional() @IsDateString()
  received_at?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => GoodsReceiptLineDto)
  lines!: GoodsReceiptLineDto[];
}
