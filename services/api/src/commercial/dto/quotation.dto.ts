import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsNumber,
  IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QUOTATION_STATUSES } from '../quotation-lifecycle';
import type { QuotationStatus } from '../quotation-lifecycle';

export class QuotationLineDto {
  @Type(() => Number) @IsInt() @Min(1) line_number!: number;
  @IsString() @IsNotEmpty() @MaxLength(100) product_code!: string;
  @IsString() @IsNotEmpty() @MaxLength(255) product_name!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) quantity!: number;
  @IsString() @IsNotEmpty() @MaxLength(50) unit!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unit_price!: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) discount_percent?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) tax_percent?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
export class CreateQuotationDto {
  @IsUUID() factory_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) quote_number!: string;
  @IsString() @IsNotEmpty() @MaxLength(255) customer_name!: string;
  @IsOptional() @IsString() @MaxLength(255) customer_reference?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsString() @MaxLength(80) pricing_rule_code?: string;
  @IsOptional() @IsDateString() requested_delivery_date?: string;
  @IsOptional() @IsDateString() valid_until?: string;
  @IsOptional() @IsString() @MaxLength(80) incoterms?: string;
  @IsOptional() @IsString() @MaxLength(255) payment_terms?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => QuotationLineDto) lines!: QuotationLineDto[];
}
export class ReviseQuotationDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsString() @IsNotEmpty() @MaxLength(1000) reason!: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsString() @MaxLength(80) pricing_rule_code?: string;
  @IsOptional() @IsDateString() requested_delivery_date?: string;
  @IsOptional() @IsDateString() valid_until?: string;
  @IsOptional() @IsString() @MaxLength(80) incoterms?: string;
  @IsOptional() @IsString() @MaxLength(255) payment_terms?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => QuotationLineDto) lines!: QuotationLineDto[];
}
export class TransitionQuotationDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsString() @IsNotEmpty() @MaxLength(1000) reason!: string;
}
export class ConvertQuotationDto extends TransitionQuotationDto {
  @IsString() @IsNotEmpty() @MaxLength(100) order_number!: string;
}
export class ListQuotationsDto {
  @IsOptional() @IsIn(QUOTATION_STATUSES) status?: QuotationStatus;
  @IsOptional() @IsString() @MaxLength(255) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class CreatePricingRuleDto {
  @IsUUID() factory_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) rule_code!: string;
  @IsOptional() @IsString() @MaxLength(255) customer_reference?: string;
  @IsOptional() @IsString() @MaxLength(3) base_currency = 'BDT';
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) allowed_currencies!: string[];
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) default_tax_percent = 0;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) max_discount_percent = 0;
  @IsOptional() @IsBoolean() approval_required = true;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) approval_total_threshold?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) approval_discount_threshold_percent = 0;
  @IsOptional() @IsBoolean() incoterms_required = false;
  @IsOptional() @IsBoolean() payment_terms_required = false;
}
export class ListCommercialRulesDto {
  @IsOptional() @IsString() @MaxLength(255) customer_reference?: string;
}
export class CreateExchangeRateDto {
  @IsUUID() factory_id!: string;
  @IsString() @MaxLength(3) currency!: string;
  @IsString() @MaxLength(3) base_currency!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 10 }) @Min(0.0000000001) rate_to_base!: number;
  @IsDateString() effective_on!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) source!: string;
}
export class ListExchangeRatesDto {
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsString() @MaxLength(3) base_currency?: string;
}
