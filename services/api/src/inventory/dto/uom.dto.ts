import {
  IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';

export class CreateUomUnitDto {
  @IsString()
  @MaxLength(50)
  unit_code!: string;
  @IsString()
  @MaxLength(160)
  name!: string;
  @IsString()
  @MaxLength(50)
  dimension_code!: string;
  @IsInt()
  @Min(0)
  @Max(8)
  decimal_precision!: number;
}

export class CreateUomConversionDto {
  @IsString()
  @MaxLength(50)
  from_unit_code!: string;
  @IsString()
  @MaxLength(50)
  to_unit_code!: string;
  @IsString()
  @Matches(/^[1-9][0-9]{0,23}$/)
  factor_numerator!: string;
  @IsString()
  @Matches(/^[1-9][0-9]{0,23}$/)
  factor_denominator!: string;
  @IsOptional()
  @IsIn(['REJECT', 'HALF_UP'])
  rounding_mode?: 'REJECT' | 'HALF_UP';
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class ReviewUomConversionDto {
  @IsIn(['APPROVE', 'REJECT', 'RETIRE'])
  action!: 'APPROVE' | 'REJECT' | 'RETIRE';
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class ConvertUomQuantityDto {
  @IsString()
  @MaxLength(48)
  @Matches(/^[0-9]+(?:\.[0-9]{1,8})?$/)
  quantity!: string;
  @IsString()
  @MaxLength(50)
  from_unit_code!: string;
  @IsString()
  @MaxLength(50)
  to_unit_code!: string;
}
