import {
  IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateSupplierDto {
  @IsInt() @Min(1)
  expected_version!: number;

  @IsOptional() @IsString() @MaxLength(255)
  name?: string;

  @IsOptional() @IsString() @MaxLength(2) @Matches(/^[A-Za-z]{2}$/)
  country_code?: string;

  @IsOptional() @IsEmail() @MaxLength(320)
  email?: string | null;

  @IsOptional() @IsString() @MaxLength(80)
  phone?: string | null;

  @IsOptional() @IsString() @MaxLength(120)
  tax_reference?: string | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650)
  payment_terms_days?: number;

  @IsOptional() @IsString() @MaxLength(3) @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional() @IsString()
  address?: string | null;

  @IsOptional() @IsString()
  notes?: string | null;
}
