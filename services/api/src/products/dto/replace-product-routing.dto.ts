import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
export class ProductRoutingStepInputDto {
  @IsInt() @Min(1) step_number!: number;
  @IsString() @IsNotEmpty() @Length(1, 100) operation_code!: string;
  @IsString() @IsNotEmpty() @Length(1, 255) operation_name!: string;
  @IsUUID() work_centre_id!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(99999999) setup_minutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(99999999) run_minutes_per_unit?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(99999999) queue_minutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(99999999) transfer_minutes?: number;
  @IsOptional() @IsString() @Length(1, 120) required_skill?: string | null;
  @IsOptional() @IsString() @Length(0, 4000) instructions?: string | null;
  @IsOptional() @IsBoolean() is_quality_gate?: boolean;
}
export class ReplaceProductRoutingDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ProductRoutingStepInputDto)
  steps!: ProductRoutingStepInputDto[];
}
