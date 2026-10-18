import {
  ArrayMinSize, IsArray, IsDateString, IsInt, IsNumber, IsOptional,
  IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreatePurchaseOrderLineDto } from './create-purchase-order.dto';

export class UpdatePurchaseOrderDto {
  @IsInt() @Min(1)
  expected_version!: number;

  @IsOptional() @IsDateString()
  order_date?: string;

  @IsOptional() @IsDateString()
  expected_delivery_date?: string | null;

  @IsOptional() @IsString() @MaxLength(3) @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650)
  payment_terms_days?: number;

  @IsOptional() @IsString()
  notes?: string | null;

  @IsOptional() @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true }) @Type(() => CreatePurchaseOrderLineDto)
  lines?: CreatePurchaseOrderLineDto[];
}
