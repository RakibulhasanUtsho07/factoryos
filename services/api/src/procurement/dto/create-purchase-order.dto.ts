import {
  IsArray, IsDateString, IsInt, IsNotEmpty, IsNumber, IsOptional,
  IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePurchaseOrderLineDto {
  @Type(() => Number) @IsInt() @Min(1)
  line_number!: number;

  @IsOptional() @IsUUID()
  inventory_item_id?: string;

  @IsString() @IsNotEmpty() @MaxLength(500)
  description!: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001)
  quantity!: number;

  @IsString() @IsNotEmpty() @MaxLength(50)
  unit!: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0)
  unit_price!: number;

  @IsOptional() @IsString()
  notes?: string;
}

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplier_id!: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  po_number!: string;

  @IsOptional() @IsDateString()
  order_date?: string;

  @IsOptional() @IsDateString()
  expected_delivery_date?: string;

  @IsOptional() @IsString() @MaxLength(3) @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650)
  payment_terms_days?: number;

  @IsOptional() @IsString()
  notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => CreatePurchaseOrderLineDto)
  lines!: CreatePurchaseOrderLineDto[];
}
