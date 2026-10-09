import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOrderLineDto {
  @IsInt()
  @Min(1)
  line_number!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  product_code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  product_name!: string;

  @IsNumber()
  @Min(0.0001)
  quantity!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  unit!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unit_price?: number;

  @IsOptional()
  @IsDateString()
  requested_delivery_date?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateOrderDto {
  @IsUUID()
  factory_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  order_number!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customer_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customer_reference?: string;

  @IsOptional()
  @IsDateString()
  order_date?: string;

  @IsOptional()
  @IsDateString()
  requested_delivery_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @ValidateNested({ each: true })
  @Type(() => CreateOrderLineDto)
  lines!: CreateOrderLineDto[];
}